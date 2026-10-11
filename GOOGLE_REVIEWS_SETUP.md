# Google reviews integration

This integration reads the Tokyo Signature Tours Google Business Profile once per
UTC calendar day. The public pages read a temporary server cache; they never
receive Google OAuth credentials or call the Business Profile API directly.

## Current setup

- Google Cloud project: `tokyo-signature-tours-reviews`
- Project number: `317556041702`
- Expected Maps Place ID: `ChIJg_xaZIlt5yoR4SWajdB3iJY`
- Business Profile API access was approved on 8 October 2026 with a default quota
  of 300 queries per minute. The required APIs are enabled.
- The owner approved Cloudflare Workers Free with Upstash Redis Free on
  11 October 2026. The Worker and Redis database have been created.
- The OAuth app uses the **Internal** audience. Owner authorization and offline
  token exchange succeeded, and the authorized business account/location was
  matched to the expected TST Place ID. The exact resource is stored privately
  as `GOOGLE_BUSINESS_LOCATION`.
- The shared public endpoint is
  `https://tst-google-reviews.wild-glade-c11e.workers.dev/api/google-reviews`.
- `assets/google-reviews-config.json` is prepared with `enabled: true` and that
  endpoint. Publish this configuration only after the activation checks below
  succeed; the local configuration alone does not prove the live sync is working.
- Synchronization requires `GOOGLE_REVIEWS_SYNC_ENABLED=true` on the Worker.
- The native daily Cron Trigger is `17 0 * * *` (09:17 JST).

When the frontend is disabled, the existing dated HTML remains visible. When it
is enabled but no valid snapshot is available, the pages direct visitors to Google
instead of displaying an old rating as current.

## Google configuration

1. Use the approved project above and an owner/manager of the verified TST profile.
   If moving to another project, complete the
   [Business Profile API access application](https://support.google.com/business/workflow/16726127)
   for that project before activation.
2. Enable Google My Business API (v4 reviews), My Business Account Management API,
   and My Business Business Information API in that project.
3. Retain the Internal OAuth audience and the approved web client for a secure
   authorization-code flow. Request only the
   `https://www.googleapis.com/auth/business.manage` scope. Google does not offer
   a narrower read-only reviews scope. The code only reads data, but the owner
   must explicitly approve the broader Google permission at authorization time.
4. Offline access has been obtained with that client and the TST owner/manager
   account. For future reauthorization, use state validation and PKCE, exchange
   the authorization code privately, and replace the encrypted Worker Secret.
   Do not change the audience to External/Testing for unattended operation; such
   testing apps generally receive refresh tokens that expire after seven days.
5. Authorized account/location discovery has identified the exact
   `accounts/{accountId}/locations/{locationId}` resource for TST. This is not the
   Maps Place ID. Every sync checks the location metadata against the expected
   Place ID before fetching reviews.

## Hosting and cache

The reviews backend runs separately on Cloudflare Workers Free. All TST pages,
including the existing GitHub Pages and Vercel copies, read the same Worker HTTPS
endpoint. There are no Vercel API functions or Vercel cron jobs in this integration.
The existing website hosting is separate from the selected review backend.

The entry point is `worker/google-reviews.mjs`; `wrangler.jsonc` configures its
Node compatibility, enable switch and daily native Cron Trigger. Deploy
from the repository root when using Wrangler. For a Cloudflare dashboard upload,
use the prepared single-file ESM bundle, and apply the same configuration in the
dashboard: compatibility date `2026-10-11`, flag `nodejs_compat`, Workers Logs off,
and Cron Trigger `17 0 * * *`. A dashboard code upload alone does not apply
`wrangler.jsonc` settings.

Provision one Upstash Redis Free database with TLS and without review archives or
backups. Redis stores only the replaceable 72-hour snapshot and short-lived lock;
neither the repository nor static deployments contain fetched review content.
Use the approved free tiers; any paid subscription or upgrade requires a separate
owner decision. The real Worker CPU usage must be checked during activation:
the Free plan has a 10 ms CPU limit per invocation, including scheduled runs.
Network wait time is excluded from that CPU measurement. Its 50 external
subrequests per invocation also limit larger listings. The library's 5,000-review
validation ceiling is not a promise of that capacity on the Free plan.

Configure the following values only on the Cloudflare Worker. Store credentials
as encrypted Secrets, not plaintext variables. Keep the enable switch a variable:

| Variable | Purpose |
| --- | --- |
| `GOOGLE_CLIENT_ID` | Approved OAuth client |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret |
| `GOOGLE_REFRESH_TOKEN` | Owner-authorized offline token |
| `GOOGLE_BUSINESS_LOCATION` | Exact account/location resource |
| `UPSTASH_REDIS_REST_URL` | Redis REST endpoint |
| `UPSTASH_REDIS_REST_TOKEN` | Redis REST token |
| `CRON_SECRET` | Random secret of at least 32 bytes |
| `GOOGLE_REVIEWS_SYNC_ENABLED` | Set to `true` only when ready |

Never place secret values in this document, browser JavaScript, chat, repository,
or logs. No Google or Redis credentials are needed by the static sites or their
Vercel projects. Cloudflare is the only scheduled sync host.

The one-time local setup keeps credentials in Git-ignored private files protected
by owner-only Windows ACLs. These local JSON files are access-restricted, not
encrypted at rest. Transfers between the setup browser and the local vault use
single-use, purpose-bound RSA-OAEP-SHA256/AES-256-GCM envelopes with a ten-minute
expiry. The deployed credentials belong in Cloudflare's encrypted Secrets.
Never upload local setup files or transfer envelopes with the static website.

The native Cloudflare scheduled handler runs at `17 0 * * *` (09:17 Japan time).
It uses the same authenticated internal sync path as a manual request. Scheduler
execution timing is not an exact-time guarantee. For a secure initial sync or
repair, `GET` or `POST /api/google-reviews-sync` requires
`Authorization: Bearer CRON_SECRET` when enabled. Never put that secret in a URL.
A Redis lock prevents overlaps; same-UTC-date checks avoid duplicate daily reads
while accommodating scheduler timing variation. A disabled sync does no work.

The full snapshot is replaced only after all pages pass validation. It uses
Google's official average/count and includes every rating, including reviews
without comments. A failed sync keeps the previous snapshot without extending
its 72-hour expiry. Content is not logged or committed. After expiry, the public
endpoint returns an unavailable response and the pages link to Google.

## Activation and verification

1. Deploy the normal production Worker bundle from `worker/google-reviews.mjs`.
   The temporary OAuth callback bundle used for the owner's authorization must
   be replaced, so `/oauth2callback` returns 404 in production. It is not a
   permanent OAuth service. Confirm the Cloudflare settings match
   `wrangler.jsonc`, including the native `17 0 * * *` Cron Trigger and disabled
   Workers Logs. Before the first valid snapshot, the public review route should
   return a safe 503; deploying code is not evidence that synchronization works.
2. Set the Cloudflare Secrets and enable `GOOGLE_REVIEWS_SYNC_ENABLED=true` only
   after the correct TST location and OAuth token are available. Apply the new
   Worker version, then invoke one authenticated sync securely. Confirm its
   Cloudflare CPU usage fits the Free plan; do not activate the frontend if the
   run fails or exceeds the quota. Do not enable a paid plan automatically.
3. Check the Worker `/api/google-reviews`: TST source link, current `fetchedAt`,
   72-hour `expiresAt`, official rating/count and complete reviews array, with no
   secrets. Check exact CORS access from all four configured TST origins.
4. Confirm `assets/google-reviews-config.json` has `enabled: true` and exactly
   `https://tst-google-reviews.wild-glade-c11e.workers.dev/api/google-reviews`.
   This is already prepared locally. Commit and publish it only after the live
   sync and public endpoint checks pass. The old Vercel placeholder does not
   host this backend.
5. Deploy to all connected sites. Verify all seven pages: homepage, tours, about,
   reviews, contact, FAQ, and private Tokyo tour guide. Confirm the homepage shows
   six latest updates and the reviews page can load the complete set. Old image
   review cards and manually selected excerpts must be hidden when enabled.
6. Verify the next UTC day's scheduled run changes `fetchedAt`; another run on
   the same UTC date should skip Google retrieval. Inspect safe failure status
   without logging tokens or review text. Check deleted/edited reviews on later
   runs and review the Cloudflare/Upstash free quota metrics.

The browser rechecks the cached endpoint hourly and on returning to an old tab.
This does not increase the once-daily Google fetch cadence. A delayed update is
labelled after 36 hours, and cached content is removed at 72 hours.

To stop the integration, disable synchronization and frontend configuration,
remove the Redis snapshot, and revoke the OAuth grant if it is no longer needed.
Disabling frontend configuration restores the explicitly dated manual fallback;
review that fallback before using it for an extended period.

## Official references

- [API prerequisites and approval](https://developers.google.com/my-business/content/prereqs)
- [Reviews list](https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews/list)
- [Business Profile content policies](https://developers.google.com/my-business/content/policies)
- [OAuth offline access](https://developers.google.com/identity/protocols/oauth2/web-server#offline)
- [OAuth token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)
- [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Cloudflare Node compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Upstash Redis pricing](https://upstash.com/pricing/redis)
