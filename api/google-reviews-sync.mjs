import { authorized, sendJson, syncReviews } from '../lib/google-reviews.mjs';

// Vercel Cron GET /api/google-reviews-sync with Authorization: Bearer CRON_SECRET.
// Configure the Google/Redis secrets, then explicitly enable the integration.
export function createHandler({ env = process.env, fetchImpl = fetch, redis, now = Date.now, makeId } = {}) {
  return async function handler(req, res) {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return sendJson(res, 405, { error: 'Method not allowed' });
    }
    if (env.GOOGLE_REVIEWS_SYNC_ENABLED !== 'true') return sendJson(res, 200, { ok: true, status: 'disabled' });
    if (!authorized(req.headers?.authorization, env.CRON_SECRET)) return sendJson(res, 401, { error: 'Unauthorized' });
    try {
      const result = await syncReviews({ env, fetchImpl, redis, now, makeId });
      return sendJson(res, 200, { ok: true, ...result });
    } catch {
      return sendJson(res, 502, { error: 'Review sync failed' });
    }
  };
}

export default createHandler();
