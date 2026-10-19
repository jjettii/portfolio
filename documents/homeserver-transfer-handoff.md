# Homeserver transfers: deployment and API contract

Cloudflare remains the default. Each transfer has one immutable storage provider. Recipient links and passwords retain the existing flow; hosting labels appear only to authenticated admins.

## Verified deployment status — 2026-10-19

The homeserver backend and updated Cloudflare Worker are deployed. D1 migration 0001 was applied directly with d1 execute; it was not registered through the migration-history command. Do not replay it. The three pre-existing transfers remained assigned to Cloudflare.

Validation completed: 31 backend tests; 10 Worker/frontend tests including redirect regression coverage; a 5,000,000,001-byte HTTPS ingress check; and live API checks on both providers for single/folder uploads, add-files, zero-byte files, password rejection, downloaded contents, provider immutability, and deletion. The four temporary API-test transfers were removed from listings; pre-existing transfer IDs remained listed.

Frontend publication and browser acceptance checks are still pending at the time of this record. Physical cleanup of the two live API test transfers was requested separately; retain the server check output as evidence. The large upload was verified from the server through its public hostname, not through the website's browser flow. Live outage/retry and concurrent-deletion scenarios through the Worker have not yet been demonstrated. Server-side Codex CLI/authentication removal remains pending.

## Homeserver layout

The deployed application root is `/mnt/storage1/homeserver-transfers` on persistent storage:

```text
/mnt/storage1/homeserver-transfers/
  app/         # root-owned, read-only to the service
  config/      # credentials, SQLite metadata and readiness receipt
  data/        # committed objects
  staging/     # incomplete uploads
```

The unrelated existing `/mnt/storage1/documents/transfer` directory must remain untouched. Earlier instructions naming it as the deployment destination are superseded.

Host: Ubuntu 22.04.5 at 192.168.0.51, administered by jetti. Service: portfolio-transfers, enabled at boot, listening only on 127.0.0.1:8788. Caddy serves https://files.jordanettinger.com and preserves the other sites. DNS is DNS-only; the router resolver was restored after its stale response cleared.

The service requires the /mnt/storage1 mount. Its shared root is exposed through one ReadWritePaths entry, with app overridden by ReadOnlyPaths and normal directory permissions restricting writes. Do not expose data and staging as separate writable mounts: that caused EXDEV during the atomic rename even though both directories were on the same disk. Existing documents are inaccessible to the service.

Credentials remain in config/secrets.json. Only the separate API token is provisioned to the Worker; the signing key stays on the server. Back up configuration/SQLite and object data consistently while the service is stopped. Preserve deletion tombstones.

## Worker/frontend contract

Existing API origin: `https://portfolio-worker.jordanettinger.workers.dev`.
Admin API requests use the existing `Authorization: Bearer <admin password>` authentication. Keep that password inside the existing trust boundary; never send it to a browser upload URL. The Worker authenticates requests to the homeserver with a separate server-side secret.

Persist `storage_provider`, restricted to `cloudflare` or `homeserver`, on each transfer. Missing legacy values mean `cloudflare`. Creation defaults to Cloudflare when the field is omitted. Never fall back to Cloudflare for an explicitly requested homeserver transfer. Do not allow changing provider through PATCH. Existing transfers stay where they are.

| Route | Required change |
| --- | --- |
| `GET /api/transfer/capabilities` | Admin only; return `{ "storage_providers": ["cloudflare", "homeserver"] }` only when the homeserver is configured and healthy. Otherwise list Cloudflare only. No cache. Register before dynamic ID routes. |
| `POST /api/transfer/create` | Existing fields: `filename`, `filesize`, `description`, `password`. Accept `storage_provider`. Return `{ "id": "...", "storage_provider": "homeserver", "uploadUrl": "https://..." }` for homeserver. Preserve Cloudflare response compatibility. |
| `POST /api/transfer/create-multi` | Existing fields: `name`, `password`. Accept `storage_provider`. Return `{ "id": "...", "storage_provider": "homeserver" }`. |
| `POST /api/transfer/:id/add-file` | Existing fields: `filename`, `filesize`, optional `sort_order`. Read provider from the stored transfer, never from caller overrides. Return `storage_provider` and `uploadUrl`. |
| `GET /api/transfers` | Preserve array response; add `storage_provider` to each admin item, including legacy single-file transfers. |
| `GET /api/transfer/:id` | Add `storage_provider` to authenticated admin detail. Preserve recipient fields and omit hosting metadata from recipient responses. |
| `GET /api/transfer/:id/download` | After the existing password check, return the existing `{ "downloadUrl": "...", "filename": "..." }` shape with a short-lived homeserver URL when applicable. |
| `GET /api/transfer/:id/files` | Preserve `{ "files": [{ "filename": "...", "filesize": 123, "url": "..." }] }`. Resolve URLs using the persisted provider after auth. |
| `DELETE /api/transfer/:id/file` | Existing JSON `{ "filename": "..." }`. Delete the actual object from its provider before removing file metadata. |
| `DELETE /api/transfer/:id` | Delete all homeserver data and incomplete uploads for this transfer before reporting success/removing metadata. Preserve existing Cloudflare deletion. |
| `/api/transfer/multipart/*` | Existing Cloudflare behavior only. Verify ownership and stored provider server-side; reject homeserver keys here. |

The browser checks capabilities before creating a homeserver transfer and requires an explicit matching provider in all homeserver upload responses. It sends raw file bytes with `PUT` to `uploadUrl`, with a Content-Type header, without the admin credential. For Cloudflare, the existing multipart path remains for files above 5,000,000,000 bytes. Homeserver uploads use a streaming PUT regardless of size. Any homeserver upload returning 2xx must mean the file is fully committed and ready to download.

## Homeserver service requirements

Implement this exact control API, which the updated Worker already calls. Every route requires `Authorization: Bearer <HOMESERVER_API_TOKEN>`. The Worker sets a 30-second timeout and refuses redirects. `HOMESERVER_URL` must be an HTTPS origin with no path, query, username, or password. Public signed upload/download URLs must use that same origin.

| Method and route | Request and response |
| --- | --- |
| `GET /v1/health` | Return `{ "ready": true }` only once persistent storage, authentication, and public ingress are working. |
| `POST /v1/transfers/:id` | JSON `{}`. Idempotently initialize a transfer; return JSON `{ "ok": true }`. Never resurrect a deleted transfer ID. |
| `POST /v1/transfers/:id/authorize` | JSON `{ "object_id": "uuid", "method": "PUT", "filename": "folder/clip.mov", "filesize": 123, "expires_in": 7200 }`. Return `{ "url": "https://configured-origin/signed-capability" }`. For GET, `filesize` is omitted and `expires_in` is 3600. GET must require a fully committed object and use the object's original display filename for Content-Disposition, since a transfer can be renamed. |
| `GET /v1/transfers/:id/files` | Return `{ "object_ids": ["uuid"] }` containing only fully committed files. Return an empty array for initialized transfers with no committed files. |
| `DELETE /v1/transfers/:id/files/:object_id` | Revoke capabilities, stop in-flight uploads, delete committed and staged object data, persist an object tombstone, and return 204. Already-absent objects also return 204 and get a tombstone. |
| `DELETE /v1/transfers/:id` | Revoke all capabilities, stop in-flight uploads, remove all committed/staged data, and persist a transfer tombstone. Return 204 only after deletion completes. Already-absent transfers also return 204 and get a tombstone. |

The `object_id` is an opaque UUID generated by the Worker, never a disk path. Unknown/deleted transfer IDs must not be implicitly recreated by authorize/PUT. A control API failure should return non-2xx (409 for a lifecycle conflict, 503 for temporary failure). DELETE 404 is treated as failure by the Worker; idempotent deletion must explicitly return 204. The Worker leaves failed-creation metadata visible to the admin so it can be deleted, and leaves failed-deletion metadata available for retry. Admin file lists include pending uploads so they can be removed; recipient file lists include only committed files. For a failed individual upload, remove its pending admin entry before uploading the same filename again.

- Use short-lived signed capabilities scoped to HTTP method, opaque transfer/object ID, expiration, and expected upload size. Keep signing keys server-side. Never accept arbitrary filesystem paths in capabilities. Upload URLs must not grant read, list, or delete access.
- Stream request bodies to staging files with bounded memory; validate exact size, available disk, and limits. Atomically rename into data only on success. Clean disconnected/expired staging uploads. Mark files pending until upload completion; hide pending files from recipients. Notify the Worker of completion or have it verify object existence before listing/issuing downloads. Support zero-byte files.
- Handle folder paths as display metadata with validated relative segments; use opaque object IDs for disk paths. Reject traversal, absolute paths, encoded separators, null bytes, and symlink escapes. Define duplicate-name behavior explicitly; avoid overwriting committed files accidentally.
- Downloads need Content-Length, safe Content-Disposition, streaming, and Range support for large files. Validate capability signatures and expiration. The visible recipient page should not name either provider; a direct download hostname remains discoverable in browser/network tools.
- Configure HTTPS and PUT/OPTIONS CORS for `https://www.jordanettinger.com` and any verified alternate site origin. Permit Content-Type. Avoid credentialed wildcard CORS. Ensure the proxy accepts and streams large request bodies, with suitable timeouts. Test files above 5 GB through the actual public ingress before enabling capabilities.
- Reject unauthenticated internal operations; redact credentials, passwords, and signed URLs from logs. Apply rate limits to public endpoints and preserve Worker password protections.
- Make deletion idempotent, including when an object is already absent. Block new uploads when a transfer is being deleted, revoke outstanding capabilities, and prevent in-flight PUTs from recreating deleted data. If the homeserver is unavailable or deletion fails, return non-2xx and retain metadata for retry. Never report successful deletion while files remain. Include pending/staging files in deletion.

## Deployment and verification

Worker: portfolio-worker. D1 binding DB points to review-comments (05a73447-fa19-465b-b838-49c3c95e62da). R2 binding BUCKET remains review-uploads. Both homeserver secrets are configured alongside the six original secrets. The adapter uses redirect: 'manual' and rejects non-success responses; Workers does not support redirect: 'error'.

See ../portfolio-worker/README.md for validation and deployment commands. Backups remain outside the website repository. Never commit exported databases, credentials, signed URLs, or Wrangler runtime state.

Before declaring the entire project complete, finish browser acceptance and the outstanding integration checks listed above, then remove server-side Codex CLI authentication/installations without removing the deployed service or its data.
