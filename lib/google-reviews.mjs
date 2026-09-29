import { randomUUID, timingSafeEqual } from 'node:crypto';

// Server-only. Google review content and OAuth credentials must never be written
// to this repository or logs. Both Vercel projects use the same Redis database.
export const PLACE_ID = 'ChIJg_xaZIlt5yoR4SWajdB3iJY';
export const SOURCE_URL = `https://www.google.com/maps/search/?api=1&query=Tokyo%20Signature%20Tours&query_place_id=${PLACE_ID}`;
export const CACHE_KEY = 'tst:google-reviews:v1';
export const LOCK_KEY = `${CACHE_KEY}:sync-lock`;
export const CACHE_TTL_SECONDS = 72 * 60 * 60;
export const STALE_AFTER_MS = 36 * 60 * 60 * 1000;
const MAX_PAGES = 100;
export const MAX_REVIEWS = MAX_PAGES * 50;
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const LOCK_TTL_SECONDS = 300;
const HTTP_TIMEOUT_MS = 12000;
const SYNC_TIMEOUT_MS = 240000;
const STAR_RATINGS = Object.freeze({ ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 });
const ALLOWED_ORIGINS = new Set([
  'https://tokyosignaturetours.com',
  'https://www.tokyosignaturetours.com',
  'https://tokyo-signature-tours.vercel.app',
  'https://tokyo-signature-tours-dp19.vercel.app',
]);

export class ReviewsError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ReviewsError';
    this.code = code;
  }
}

function requireValue(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || !value.trim()) throw new ReviewsError('configuration');
  return value.trim();
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
}

function safePhotoUrl(value) {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string' || value.length > 2048) return '';
  try {
    const url = new URL(value);
    // Only Google-hosted reviewer images. No executable URLs or credentials.
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port &&
        (url.hostname === 'googleusercontent.com' || url.hostname.endsWith('.googleusercontent.com') ||
         url.hostname === 'ggpht.com' || url.hostname.endsWith('.ggpht.com'))) return value;
  } catch { /* Omit an invalid optional image. */ }
  return '';
}

function plainString(value, maxLength, allowEmpty = true) {
  if (typeof value !== 'string' || value.length > maxLength || (!allowEmpty && !value.trim())) {
    throw new ReviewsError('invalid_payload');
  }
  return value;
}

// Values remain plain text, including markup-like review comments. The browser
// must use textContent, never innerHTML. Owner replies/resource names are omitted.
export function normalizeReview(raw, now = Date.now()) {
  if (!isObject(raw) || !isObject(raw.reviewer)) throw new ReviewsError('invalid_payload');
  const rating = Object.hasOwn(STAR_RATINGS, raw.starRating) ? STAR_RATINGS[raw.starRating] : null;
  if (!rating || !validDate(raw.createTime) || !validDate(raw.updateTime) ||
      Date.parse(raw.createTime) > Date.parse(raw.updateTime) || Date.parse(raw.updateTime) > now + 300000) throw new ReviewsError('invalid_payload');
  const id = plainString(raw.reviewId, 1024, false);
  if (id.includes('/')) throw new ReviewsError('invalid_payload');
  const author = raw.reviewer.isAnonymous === true ? 'Google reviewer' :
    plainString(raw.reviewer.displayName ?? 'Google reviewer', 1000, false);
  return {
    id,
    author,
    avatarUrl: raw.reviewer.isAnonymous === true ? '' : safePhotoUrl(raw.reviewer.profilePhotoUrl),
    rating,
    comment: plainString(raw.comment ?? '', 100000),
    createdAt: raw.createTime,
    updatedAt: raw.updateTime,
  };
}

async function jsonRequest(fetchImpl, url, options = {}, signal) {
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(HTTP_TIMEOUT_MS)]) : AbortSignal.timeout(HTTP_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(url, { ...options, signal: requestSignal, redirect: 'error' });
  } catch {
    throw new ReviewsError('upstream_unavailable');
  }
  if (!response.ok) throw new ReviewsError('upstream_unavailable');
  try {
    const body = await response.json();
    if (!isObject(body)) throw new Error();
    return body;
  } catch {
    throw new ReviewsError('invalid_payload');
  }
}

export function createRedis(env = process.env, fetchImpl = fetch) {
  const endpoint = requireValue(env, 'UPSTASH_REDIS_REST_URL');
  const token = requireValue(env, 'UPSTASH_REDIS_REST_TOKEN');
  let parsed;
  try { parsed = new URL(endpoint); } catch { throw new ReviewsError('configuration'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash ||
      parsed.pathname !== '/' || parsed.port) throw new ReviewsError('configuration');
  return {
    async command(parts) {
      const body = await jsonRequest(fetchImpl, parsed.origin, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(parts),
      });
      if (Object.hasOwn(body, 'error') || !Object.hasOwn(body, 'result')) throw new ReviewsError('cache_unavailable');
      return body.result;
    },
  };
}

function validatePublicReview(raw, now) {
  if (!isObject(raw) || !Number.isInteger(raw.rating) || raw.rating < 1 || raw.rating > 5 ||
      !validDate(raw.createdAt) || !validDate(raw.updatedAt) ||
      Date.parse(raw.createdAt) > Date.parse(raw.updatedAt) || Date.parse(raw.updatedAt) > now + 300000) throw new ReviewsError('invalid_cache');
  const id = plainString(raw.id, 1024, false);
  if (id.includes('/')) throw new ReviewsError('invalid_cache');
  return {
    id,
    author: plainString(raw.author, 1000, false),
    avatarUrl: safePhotoUrl(raw.avatarUrl),
    rating: raw.rating,
    comment: plainString(raw.comment, 100000),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

// Reconstruct the public contract even when Redis contains extra fields. An
// expired snapshot is never returned, independently of Redis TTL enforcement.
export function validateSnapshot(raw, now = Date.now()) {
  if (!isObject(raw) || raw.version !== 1 || !validDate(raw.fetchedAt) || !validDate(raw.expiresAt) ||
      raw.sourceUrl !== SOURCE_URL || !Number.isInteger(raw.count) || raw.count < 0 || raw.count > MAX_REVIEWS ||
      !Array.isArray(raw.reviews) || raw.reviews.length !== raw.count) {
    throw new ReviewsError('invalid_cache');
  }
  if ((raw.count === 0 && raw.rating !== null) ||
      (raw.count > 0 && (typeof raw.rating !== 'number' || !Number.isFinite(raw.rating) || raw.rating < 1 || raw.rating > 5))) {
    throw new ReviewsError('invalid_cache');
  }
  const fetched = Date.parse(raw.fetchedAt);
  const expires = Date.parse(raw.expiresAt);
  if (fetched > now + 60000 || expires <= now || expires <= fetched || expires - fetched > CACHE_TTL_SECONDS * 1000) {
    throw new ReviewsError('expired_cache');
  }
  const reviews = raw.reviews.map(review => validatePublicReview(review, now));
  if (new Set(reviews.map(review => review.id)).size !== reviews.length) throw new ReviewsError('invalid_cache');
  return {
    version: 1,
    fetchedAt: raw.fetchedAt,
    expiresAt: raw.expiresAt,
    rating: raw.rating,
    count: raw.count,
    reviews,
    sourceUrl: SOURCE_URL,
    status: now - fetched > STALE_AFTER_MS ? 'stale' : 'fresh',
  };
}

export async function readSnapshot(redis, now = Date.now()) {
  const cached = await redis.command(['GET', CACHE_KEY]);
  if (cached === null) return null;
  try {
    return validateSnapshot(typeof cached === 'string' ? JSON.parse(cached) : cached, now);
  } catch {
    return null;
  }
}

export async function fetchGoogleSnapshot(env = process.env, fetchImpl = fetch, now = Date.now) {
  const clientId = requireValue(env, 'GOOGLE_CLIENT_ID');
  const clientSecret = requireValue(env, 'GOOGLE_CLIENT_SECRET');
  const refreshToken = requireValue(env, 'GOOGLE_REFRESH_TOKEN');
  const location = requireValue(env, 'GOOGLE_BUSINESS_LOCATION');
  if (!/^accounts\/\d+\/locations\/\d+$/.test(location)) throw new ReviewsError('configuration');
  const signal = AbortSignal.timeout(SYNC_TIMEOUT_MS);
  const token = await jsonRequest(fetchImpl, 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }).toString(),
  }, signal);
  if (typeof token.access_token !== 'string' || !token.access_token || /[\r\n]/.test(token.access_token)) throw new ReviewsError('invalid_payload');
  const headers = { Authorization: `Bearer ${token.access_token}` };
  const locationId = location.split('/')[3];
  const business = await jsonRequest(fetchImpl,
    `https://mybusinessbusinessinformation.googleapis.com/v1/locations/${locationId}?readMask=metadata`, { headers }, signal);
  if (business.metadata?.placeId !== PLACE_ID) throw new ReviewsError('location_mismatch');

  // Official v4 API: max pageSize 50, updateTime desc. Never derive the aggregate
  // rating/count from the reviews retained for public display.
  const reviews = [];
  const ids = new Set();
  const tokens = new Set();
  let nextToken = '';
  let count;
  let rating;
  let complete = false;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL(`https://mybusiness.googleapis.com/v4/${location}/reviews`);
    url.searchParams.set('pageSize', '50');
    url.searchParams.set('orderBy', 'updateTime desc');
    if (nextToken) url.searchParams.set('pageToken', nextToken);
    const body = await jsonRequest(fetchImpl, url.toString(), { headers }, signal);
    if (!Number.isInteger(body.totalReviewCount) || body.totalReviewCount < 0 || body.totalReviewCount > MAX_REVIEWS ||
        (body.reviews !== undefined && !Array.isArray(body.reviews)) ||
        (body.nextPageToken !== undefined && typeof body.nextPageToken !== 'string')) throw new ReviewsError('invalid_payload');
    const pageRating = body.totalReviewCount === 0 ? null : body.averageRating;
    if ((body.totalReviewCount > 0 && (typeof pageRating !== 'number' || !Number.isFinite(pageRating) || pageRating < 1 || pageRating > 5)) ||
        (body.totalReviewCount === 0 && body.averageRating !== undefined && body.averageRating !== 0)) throw new ReviewsError('invalid_payload');
    if (page === 0) {
      count = body.totalReviewCount;
      rating = pageRating;
    } else if (count !== body.totalReviewCount || rating !== pageRating) {
      // Concurrent changes can move reviews between pages. Preserve the previous
      // complete snapshot; the next daily run will try again.
      throw new ReviewsError('inconsistent_pages');
    }
    const items = body.reviews ?? [];
    if (items.length > 50 || (!items.length && (count > 0 || body.nextPageToken))) throw new ReviewsError('incomplete_pages');
    for (const raw of items) {
      const review = normalizeReview(raw, now());
      if (ids.has(review.id)) throw new ReviewsError('inconsistent_pages');
      ids.add(review.id);
      reviews.push(review);
    }
    nextToken = body.nextPageToken || '';
    if (!nextToken) { complete = true; break; }
    if (nextToken.length > 10000 || tokens.has(nextToken)) throw new ReviewsError('inconsistent_pages');
    tokens.add(nextToken);
  }
  if (!complete || reviews.length !== count) throw new ReviewsError('incomplete_pages');
  reviews.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const fetchedAt = now();
  const snapshot = {
    version: 1,
    fetchedAt: new Date(fetchedAt).toISOString(),
    expiresAt: new Date(fetchedAt + CACHE_TTL_SECONDS * 1000).toISOString(),
    rating,
    count,
    reviews,
    sourceUrl: SOURCE_URL,
  };
  // Keep the entire listing or reject it, rather than silently dropping reviews.
  // Leave room below Vercel's function-response size limit.
  if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > MAX_SNAPSHOT_BYTES) throw new ReviewsError('snapshot_too_large');
  validateSnapshot(snapshot, fetchedAt);
  return snapshot;
}

function fetchedToday(snapshot, now) {
  // Vercel Hobby may invoke a daily cron at any point within its scheduled hour.
  // UTC-day dedup keeps a slightly earlier next-day invocation from being skipped.
  return snapshot && new Date(snapshot.fetchedAt).toISOString().slice(0, 10) === new Date(now).toISOString().slice(0, 10);
}

export async function syncReviews({ env = process.env, fetchImpl = fetch, redis, now = Date.now, makeId = randomUUID } = {}) {
  const store = redis ?? createRedis(env, fetchImpl);
  const current = await readSnapshot(store, now());
  if (fetchedToday(current, now())) return { status: 'fresh' };
  const owner = makeId();
  const locked = await store.command(['SET', LOCK_KEY, owner, 'NX', 'EX', LOCK_TTL_SECONDS]);
  if (locked !== 'OK') return { status: 'already_running' };
  try {
    // A second deployment may have completed between the first read and lock.
    const latest = await readSnapshot(store, now());
    if (fetchedToday(latest, now())) return { status: 'fresh' };
    const snapshot = await fetchGoogleSnapshot(env, fetchImpl, now);
    // Check ownership and write atomically. A timed-out worker cannot overwrite
    // a newer snapshot or release a lock acquired by another worker.
    const saved = await store.command(['EVAL',
      'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("SET", KEYS[2], ARGV[2], "EX", ARGV[3]) else return false end',
      2, LOCK_KEY, CACHE_KEY, owner, JSON.stringify(snapshot), CACHE_TTL_SECONDS]);
    if (saved !== 'OK') throw new ReviewsError('lock_expired');
    return { status: 'updated', fetchedAt: snapshot.fetchedAt, count: snapshot.count };
  } finally {
    try {
      await store.command(['EVAL', 'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end', 1, LOCK_KEY, owner]);
    } catch { /* Expiry releases the lock; never log private upstream details. */ }
  }
}

export function authorized(authorization, secret) {
  if (typeof secret !== 'string' || secret.length < 16 || typeof authorization !== 'string') return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(authorization);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function allowedOrigin(origin, env = process.env) {
  return typeof origin === 'string' && (ALLOWED_ORIGINS.has(origin) ||
    (env.NODE_ENV !== 'production' && env.VERCEL_ENV !== 'production' && origin === 'http://127.0.0.1:8765'));
}

export function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(body));
}
