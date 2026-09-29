import { allowedOrigin, createRedis, readSnapshot, sendJson } from '../lib/google-reviews.mjs';

// Public GET /api/google-reviews: read-only; never calls Google or starts a sync.
// Browser callers receive only the version-1 public snapshot from Redis.
export function createHandler({ env = process.env, fetchImpl = fetch, redis, now = Date.now } = {}) {
  return async function handler(req, res) {
    res.setHeader('Vary', 'Origin');
    const origin = req.headers?.origin;
    if (origin && !allowedOrigin(origin, env)) return sendJson(res, 403, { error: 'Origin not allowed' });
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '300');
      res.statusCode = 204;
      return res.end();
    }
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET, OPTIONS');
      return sendJson(res, 405, { error: 'Method not allowed' });
    }
    try {
      const snapshot = await readSnapshot(redis ?? createRedis(env, fetchImpl), now());
      if (!snapshot) throw new Error('unavailable');
      return sendJson(res, 200, snapshot);
    } catch {
      return sendJson(res, 503, { error: 'Reviews temporarily unavailable' });
    }
  };
}

export default createHandler();
