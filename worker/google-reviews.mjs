import { allowedOrigin, authorized, createRedis, readSnapshot, syncReviews } from '../lib/google-reviews.mjs';
import { createReviewPageModel, rewriteReviewPage } from '../lib/review-html.mjs';

// Google credentials and the Redis token are
// Cloudflare secrets; all environment values are passed explicitly per event.
function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}

function productionEnv(bindings) {
  return { ...bindings, NODE_ENV: 'production', VERCEL_ENV: 'production' };
}

const ERROR_CODES = new Set([
  'configuration', 'upstream_unavailable', 'invalid_payload', 'cache_unavailable',
  'invalid_cache', 'expired_cache', 'location_mismatch', 'inconsistent_pages',
  'incomplete_pages', 'snapshot_too_large', 'lock_expired',
]);
const ERROR_TYPES = new Set(['Error', 'TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'ReviewsError', 'AbortError', 'TimeoutError']);

function syncFailure(error, phase, transport) {
  // Only this authenticated response gets operational diagnostics. Never return
  // error messages, stacks, URLs, upstream payloads, or arbitrary error fields.
  return {
    error: 'Review sync failed',
    code: ERROR_CODES.has(error?.code) ? error.code : 'runtime_error',
    type: ERROR_TYPES.has(error?.name) ? error.name : 'Error',
    phase,
    ...transport,
  };
}

function transportFailure(error) {
  const type = ERROR_TYPES.has(error?.name) ? error.name : 'Error';
  const message = typeof error?.message === 'string' ? error.message : '';
  let reason = 'other';
  if (/illegal invocation|incorrect.*this.*reference|invalid receiver/i.test(message)) reason = 'invalid_receiver';
  else if (type === 'AbortError' || type === 'TimeoutError' || /timed?\s*out|timeout/i.test(message)) reason = 'timeout';
  else if (/\bdns\b|enotfound|eai_again|name resolution/i.test(message)) reason = 'dns';
  else if (/\btls\b|\bssl\b|certificate/i.test(message)) reason = 'tls';
  else if (/network|connection|fetch failed/i.test(message)) reason = 'network';
  return { transportErrorType: type, transportReason: reason };
}

function requestPhase(url) {
  try {
    const host = new URL(url).hostname;
    if (host === 'oauth2.googleapis.com') return 'google_token';
    if (host === 'mybusinessbusinessinformation.googleapis.com') return 'google_location';
    if (host === 'mybusiness.googleapis.com') return 'google_reviews';
  } catch { /* Only fixed classifications leave the server. */ }
  return 'cache';
}

const SITE_PREVIEW_HOST = 'tst-google-reviews.wild-glade-c11e.workers.dev';
const SITE_PREVIEW_ORIGIN = 'https://tokyo-signature-tours.vercel.app';
const SITE_PUBLIC_HOSTS = new Set(['tokyosignaturetours.com', 'www.tokyosignaturetours.com']);
const SITE_HTML_PATHS = new Set(['/', '/index.html', '/reviews.html', '/tours.html', '/about.html', '/contact.html', '/faq.html', '/private-tokyo-tour-guide.html']);

function allowedSiteAsset(path) {
  if (['/robots.txt', '/sitemap.xml', '/favicon.ico', '/favicon.png'].includes(path)) return true;
  return /^\/(?:assets|images)\/[a-zA-Z0-9_./-]+\.(?:css|js|json|png|jpe?g|webp|gif|avif|svg|ico|woff2?|ttf)$/i.test(path) ||
    /^\/[a-zA-Z0-9_.-]+\.(?:png|jpe?g|webp|gif|avif|svg|ico)$/i.test(path);
}

export function createWorker({ fetchImpl = (...args) => globalThis.fetch(...args), redis, now = Date.now, makeId, rewritePage = rewriteReviewPage } = {}) {
  async function sync(method, authorization, env) {
    if (method !== 'GET' && method !== 'POST') return json(405, { error: 'Method not allowed' }, { Allow: 'GET, POST' });
    if (env.GOOGLE_REVIEWS_SYNC_ENABLED !== 'true') return json(200, { ok: true, status: 'disabled' });
    if (!authorized(authorization, env.CRON_SECRET)) return json(401, { error: 'Unauthorized' });
    let phase = 'before_first_request';
    let transport = {};
    const trackedFetch = async (url, init) => {
      // Cleanup must not obscure the primary operation that failed. This checks
      // a fixed script fragment without parsing or retaining review payloads.
      const unlock = typeof init?.body === 'string' && init.body.startsWith('["EVAL",') &&
        init.body.includes('return redis.call(\\"DEL\\"');
      if (!unlock) { phase = requestPhase(url); transport = {}; }
      try {
        const response = await fetchImpl(url, init);
        if (!unlock && Number.isInteger(response.status) && response.status >= 100 && response.status <= 599) {
          transport = { upstreamStatus: response.status };
        }
        return response;
      } catch (error) {
        if (!unlock) transport = transportFailure(error);
        throw error;
      }
    };
    try {
      const result = await syncReviews({ env, fetchImpl: trackedFetch, redis, now, makeId });
      return json(200, { ok: true, ...result });
    } catch (error) {
      return json(502, syncFailure(error, phase, transport));
    }
  }

  async function site(request, env) {
    const url = new URL(request.url);
    const customDomain = SITE_PUBLIC_HOSTS.has(url.hostname);
    const preview = url.hostname === SITE_PREVIEW_HOST;
    const html = SITE_HTML_PATHS.has(url.pathname);
    if ((!customDomain && !preview) || (preview && (!html && !allowedSiteAsset(url.pathname)))) return json(404, { error: 'Not found' });
    if (request.method !== 'GET' && request.method !== 'HEAD') return json(405, { error: 'Method not allowed' }, { Allow: 'GET, HEAD' });
    const enabled = env.GOOGLE_REVIEWS_SITE_ENABLED === 'true';
    if (preview && !enabled) return json(404, { error: 'Not found' });
    // A custom-domain Route fetches the same URL through Cloudflare to the
    // DNS-defined GitHub Pages origin. workers.dev uses one fixed static mirror.
    // Never forward caller Authorization, Cookie, Host, or conditional headers.
    const upstream = new URL(url.pathname + url.search, customDomain ? url.origin : SITE_PREVIEW_ORIGIN);
    if (html) upstream.search = '';
    let origin;
    try {
      origin = await fetchImpl(new Request(upstream, {
        method: html && enabled ? 'GET' : request.method,
        headers: { Accept: html ? 'text/html' : '*/*' },
        redirect: 'manual', signal: AbortSignal.timeout(12000),
      }));
    } catch { return json(502, { error: 'Site temporarily unavailable' }); }
    if (!html || !enabled || origin.status !== 200 || !origin.headers.get('Content-Type')?.includes('text/html')) {
      const headers = new Headers(origin.headers);
      headers.delete('Set-Cookie');
      if (preview) headers.set('X-Robots-Tag', 'noindex');
      return new Response(request.method === 'HEAD' ? null : origin.body, { status: origin.status, headers });
    }
    let snapshot = null;
    try { snapshot = await readSnapshot(redis ?? createRedis(env, fetchImpl), now()); } catch { /* Preserve the page with an unavailable review slot. */ }
    const model = createReviewPageModel(snapshot, request.url, now());
    try {
      const response = rewritePage(origin, model, { preview });
      return request.method === 'HEAD' ? new Response(null, { status: response.status, headers: response.headers }) : response;
    } catch { return json(503, { error: 'Site temporarily unavailable' }); }
  }

  return {
    async fetch(request, bindings) {
      const env = productionEnv(bindings);
      const path = new URL(request.url).pathname;
      if (path === '/api/google-reviews-sync') {
        // Manual setup/repair endpoint. No browser CORS grant or public trigger.
        return sync(request.method, request.headers.get('Authorization'), env);
      }
      if (path !== '/api/google-reviews') return site(request, env);
      const origin = request.headers.get('Origin');
      const headers = { Vary: 'Origin' };
      if (origin && !allowedOrigin(origin, env)) return json(403, { error: 'Origin not allowed' }, headers);
      if (origin) headers['Access-Control-Allow-Origin'] = origin;
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: { ...headers, 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Max-Age': '300', 'Cache-Control': 'no-store' },
        });
      }
      if (request.method !== 'GET') return json(405, { error: 'Method not allowed' }, { ...headers, Allow: 'GET, OPTIONS' });
      try {
        const snapshot = await readSnapshot(redis ?? createRedis(env, fetchImpl), now());
        if (!snapshot) return json(503, { error: 'Reviews temporarily unavailable' }, headers);
        return json(200, snapshot, headers);
      } catch {
        return json(503, { error: 'Reviews temporarily unavailable' }, headers);
      }
    },

    async scheduled(_controller, bindings) {
      const env = productionEnv(bindings);
      // Use the same authenticated internal path as manual sync; the configured
      // secret never appears in a URL, public response, or log.
      const result = await sync('GET', typeof env.CRON_SECRET === 'string' ? `Bearer ${env.CRON_SECRET}` : '', env);
      if (!result.ok) throw new Error('Scheduled review sync failed');
      // Awaiting the work lets Cloudflare record failure/success for the event.
    },
  };
}

export default createWorker();
