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

From the repository root with Node 24:

```sh
node --test portfolio-worker/storage.test.js portfolio-worker/redirect.test.js transfer/storage.test.cjs
wrangler deploy --dry-run --config portfolio-worker/wrangler.jsonc --outdir tmp/worker-build
```

Before future deployments, inspect the currently deployed version/bindings and back up D1. Migration 0001 is already applied; check the live schema instead of replaying it. Deploy deliberately with wrangler deploy --config portfolio-worker/wrangler.jsonc. GitHub frontend publication is a separate step.

If homeserver readiness fails, the capabilities endpoint lists only Cloudflare. Preserve routing for existing homeserver transfers during rollback: the old Worker cannot manage them. Do not remove the D1 columns or storage data. Keep credentials and SQL backups outside this repository.

The full API contract is in ../documents/homeserver-transfer-handoff.md.
