# Portfolio Worker

The deployed Worker preserves the recovered review/portfolio routes and adds homeserver transfer routing in storage.js. Cloudflare remains the default provider.

## Verified deployment status — 2026-10-19

The homeserver backend and updated Cloudflare Worker are deployed. D1 migration 0001 was applied directly with d1 execute; it was not registered through the migration-history command. Do not replay it. The three pre-existing transfers remained assigned to Cloudflare.

Validation completed: 31 backend tests; 10 Worker/frontend tests including redirect regression coverage; a 5,000,000,001-byte HTTPS ingress check; and live API checks on both providers for single/folder uploads, add-files, zero-byte files, password rejection, downloaded contents, provider immutability, and deletion. The four temporary API-test transfers were removed from listings; pre-existing transfer IDs remained listed.

Frontend publication and browser acceptance checks are still pending at the time of this record. Physical cleanup of the two live API test transfers was requested separately; retain the server check output as evidence. The large upload was verified from the server through its public hostname, not through the website's browser flow. Live outage/retry and concurrent-deletion scenarios through the Worker have not yet been demonstrated. Server-side Codex CLI/authentication removal remains pending.

## Configuration

- DB: review-comments, ID 05a73447-fa19-465b-b838-49c3c95e62da.
- BUCKET and R2_BUCKET_NAME: review-uploads.
- HOMESERVER_URL: https://files.jordanettinger.com (origin only).
- HOMESERVER_API_TOKEN: separate server API secret; never commit its value.
- Preserve ADMIN_SECRET, PASSWORD_SALT, CF_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and STREAM_API_TOKEN.
- Server storage root: /mnt/storage1/homeserver-transfers. The existing /mnt/storage1/documents/transfer directory is unrelated and protected.

The fetch adapter must use redirect: 'manual', then reject non-2xx responses. Cloudflare Workers rejects redirect: 'error' before making the request. The regression test covers this requirement and redirect rejection.

## Validate and deploy

Comment status changes require `migrations/0002_comment_status.sql` to be applied to D1 before deploying the Worker and review frontend. This adds persistent admin read/completion flags; existing comments start as unread and incomplete. Apply only this new migration, without replaying migration 0001. Status and counts are returned only to authenticated admins.

## Comment replies

Apply only `migrations/0004_comment_replies.sql` before deploying the updated Worker and review frontend. It adds a nullable parent reference and index without changing existing comments. Replies share a single indentation level beneath their original comment, including replies to replies. The existing non-null database time column inherits the thread time for internal ordering; the API returns null for reply timestamps and the interface never displays or seeks them. Both clients and admins can post replies through the existing comment route. Read/completion flags remain admin-only. Deleting a parent also deletes its replies, with confirmation in the interface. Replies contribute to existing comment/new/completed counts.

Validate with `npm test` in `portfolio-worker`. Back up D1 and inspect the deployed schema before applying the new migration; do not replay earlier migrations. Publish the frontend after the migration and Worker deployment. The disabled email digest setting remains unchanged; future digest previews label replies without a timecode.

## Comment email digests

**Deferred by owner on 2026-11-03. Keep sending disabled.** The Cloudflare dashboard reports that Email Sending requires Workers Paid, and the owner declined an upgrade. A free provider such as Resend can be considered later; recheck pricing and configure its server-side credentials and sending subdomain before switching the sender implementation. Proton remains the mailbox provider. No sending-domain DNS changes or test digest delivery have been completed. See the handoff TODO at the top of `digests.js`.

The database trigger continues to accumulate pending comments while delivery is disabled. Before future activation, explicitly choose whether to deliver or discard that backlog; do not enable blindly and send months-old feedback. Retain existing comment data and read/completion statuses.

`migrations/0003_comment_digests.sql` queues future comments atomically through an insert trigger. Existing comments are not backfilled. Each project has its own 30-minute quiet period, reset by comments on any of its videos. A once-per-minute scheduled handler sends pending comments grouped by video to the fixed admin recipient, regardless of read/completion status. Email delivery does not change those statuses. Deleted comments are omitted; deleted projects are cleaned from the queue.

Configure `COMMENT_DIGEST_TO`, `COMMENT_DIGEST_FROM`, `REVIEW_SITE_URL`, and the `COMMENT_EMAIL` send binding. Verify the recipient in Cloudflare and onboard the sending subdomain `notify.jordanettinger.com` in Email Sending. Preserve the main domain's Proton MX records and email authentication. Set `COMMENT_DIGEST_ENABLED` to `true` only after sending is configured and tested; it defaults to `false` during setup. The binding restricts recipients to `mail@jordanettinger.com`.

Apply migration 0003 after backing up D1 and checking the schema. Apply only unapplied files, since migration 0001 is not registered in migration history. The sender processes at most 10 projects per invocation; additional projects wait for the next minute. Email previews include up to 100 comments with each body capped at 4,000 characters and link to the full project. Failed batches stay queued for retry after five minutes, and a 15-minute lease prevents overlapping sends. Delivery is at least once: a crash after the email provider accepts a message but before D1 records completion can result in a duplicate digest.

Run `npm test` in `portfolio-worker` to verify quiet periods, project independence, batching, retry, overlapping invocations, deleted content, and admin status privacy.

Setup status (2026-11-03): D1 was backed up to the local temporary directory, migrations 0002 and 0003 were applied, and Worker version `d2ebd52b-ae36-4b34-a04c-24dc7df5eacd` was deployed with the minute schedule and sending disabled. The recipient `mail@jordanettinger.com` is verified. Email Sending list/settings/enable operations returned Cloudflare error 2036 (Unauthorized), so sender onboarding and a real delivery test remain pending. Main-domain Email Routing remains disabled/unconfigured; no Proton DNS records were changed. All 11 backend tests passed. The review frontend changes have not been published by this deployment.

From the repository root with Node 24:

```sh
node --test portfolio-worker/storage.test.js portfolio-worker/redirect.test.js transfer/storage.test.cjs
wrangler deploy --dry-run --config portfolio-worker/wrangler.jsonc --outdir tmp/worker-build
```

Before future deployments, inspect the currently deployed version/bindings and back up D1. Migration 0001 is already applied; check the live schema instead of replaying it. Deploy deliberately with wrangler deploy --config portfolio-worker/wrangler.jsonc. GitHub frontend publication is a separate step.

If homeserver readiness fails, the capabilities endpoint lists only Cloudflare. Preserve routing for existing homeserver transfers during rollback: the old Worker cannot manage them. Do not remove the D1 columns or storage data. Keep credentials and SQL backups outside this repository.

The full API contract is in ../documents/homeserver-transfer-handoff.md.
