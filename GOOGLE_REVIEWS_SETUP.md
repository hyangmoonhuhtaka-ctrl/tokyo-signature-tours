# Google reviews integration

This integration reads the Tokyo Signature Tours Google Business Profile once per
UTC calendar day. The public pages read a temporary server cache; they never
receive Google OAuth credentials or call the Business Profile API directly.

## Current setup

- Google Cloud project: `tokyo-signature-tours-reviews`
- Project number: `317556041702`
- Expected Maps Place ID: `ChIJg_xaZIlt5yoR4SWajdB3iJY`
- Business Profile API access was requested on 29 September 2026; approval is pending.
- Google indicated 7–10 business days for review. Approval is required before activation.
- `assets/google-reviews-config.json` starts with `enabled: false`.
- Synchronization also starts disabled unless `GOOGLE_REVIEWS_SYNC_ENABLED=true`.

The existing dated HTML remains visible while the integration is disabled.

## Google configuration

1. Complete the [Business Profile API access application](https://support.google.com/business/workflow/16726127)
   with an owner/manager of the verified TST profile. The profile must have been
   verified for at least 60 days. Wait for Google approval for the project above.
2. Enable Google My Business API (v4 reviews), My Business Account Management API,
   and My Business Business Information API in that project.
3. Configure the OAuth consent screen for TST and a client suitable for a secure
   authorization-code flow. Request only the
   `https://www.googleapis.com/auth/business.manage` scope. Google does not offer
   a narrower read-only reviews scope. The code only reads data, but the owner
   must explicitly approve the broader Google permission at authorization time.
4. Obtain offline access using that client and the TST owner/manager account.
   Keep client secrets and refresh tokens in server environment variables only.
   An external OAuth app in Testing generally has refresh tokens that expire
   after seven days; finish the appropriate production/verification setup before
   relying on unattended updates.
5. List authorized accounts and locations to find the exact
   `accounts/{accountId}/locations/{locationId}` resource for TST. This is not the
   Maps Place ID. Every sync checks the location metadata against the expected
   Place ID before fetching reviews.

## Hosting and cache

Use the existing Vercel project `tokyo-signature-tours` as the primary API host.
Provision an Upstash Redis database with TLS and no persistent review archives or
backups. Confirm the hosting/storage plan and any charges with the owner before
changing subscriptions. Do not use immutable static deployments or Git history
as the review cache.

Configure these production environment variables through the hosting provider:

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
or logs. Other connected Vercel projects should leave synchronization disabled.
If multiple API hosts are enabled intentionally, use the same cache to share its
lock and daily deduplication.

`vercel.json` schedules `/api/google-reviews-sync` at `17 0 * * *` (09:17 Japan
time). Vercel Hobby scheduling can run within the scheduled hour; it is not an
exact-time guarantee. The endpoint requires `Authorization: Bearer CRON_SECRET`
when enabled. A lock prevents overlapping workers. Same-UTC-date checks avoid
duplicate daily reads while accommodating scheduler timing variation.

The full snapshot is replaced only after all pages pass validation. It uses
Google's official average/count and includes every rating, including reviews
without comments. A failed sync keeps the previous snapshot without extending
its 72-hour expiry. Content is not logged or committed. After expiry, the public
endpoint returns an unavailable response and the pages link to Google.

## Activation and verification

1. Deploy the disabled integration and verify the existing site and 8-hour prices.
2. Set production credentials and enable only the primary sync. Redeploy to apply
   environment changes, then invoke one authenticated sync securely.
3. Check `/api/google-reviews`: TST source link, current `fetchedAt`, 72-hour
   `expiresAt`, official rating/count, complete reviews array, no secrets.
4. Set `enabled` to `true` in `assets/google-reviews-config.json` only after the
   real endpoint succeeds. Its endpoint must be the verified primary HTTPS API.
5. Deploy to all connected sites. Verify all seven pages: homepage, tours, about,
   reviews, contact, FAQ, and private Tokyo tour guide. Confirm the homepage shows
   six latest updates and the reviews page can load the complete set. Old image
   review cards and manually selected excerpts must be hidden when enabled.
6. Verify the next scheduled run changes `fetchedAt`; inspect failures without
   logging tokens or review text. Check deleted/edited reviews on later runs.

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
- [Vercel cron jobs](https://vercel.com/docs/cron-jobs)
