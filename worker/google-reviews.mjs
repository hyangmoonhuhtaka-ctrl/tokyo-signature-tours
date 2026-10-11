import { allowedOrigin, authorized, createRedis, readSnapshot, syncReviews } from '../lib/google-reviews.mjs';

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

export function createWorker({ fetchImpl = fetch, redis, now = Date.now, makeId } = {}) {
  async function sync(method, authorization, env) {
    if (method !== 'GET' && method !== 'POST') return json(405, { error: 'Method not allowed' }, { Allow: 'GET, POST' });
    if (env.GOOGLE_REVIEWS_SYNC_ENABLED !== 'true') return json(200, { ok: true, status: 'disabled' });
    if (!authorized(authorization, env.CRON_SECRET)) return json(401, { error: 'Unauthorized' });
    try {
      const result = await syncReviews({ env, fetchImpl, redis, now, makeId });
      return json(200, { ok: true, ...result });
    } catch {
      return json(502, { error: 'Review sync failed' });
    }
  }

  return {
    async fetch(request, bindings) {
      const env = productionEnv(bindings);
      const path = new URL(request.url).pathname;
      if (path === '/api/google-reviews-sync') {
        // Manual setup/repair endpoint. No browser CORS grant or public trigger.
        return sync(request.method, request.headers.get('Authorization'), env);
      }
      if (path !== '/api/google-reviews') return json(404, { error: 'Not found' });
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
