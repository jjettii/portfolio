# Client upload inbox

This is a separate, dependency-free Node 24 service on the homeserver. The static website serves `/upload/`; **all upload authentication, invitation metadata, ZIP bytes and downloads live on the homeserver**. It does not use the portfolio Worker, D1 or R2 and does not change `/transfer/`.

## Behavior

- Client signs in with an invitation ID and password. Admin may set a custom password when creating an invitation, or leave the field blank to generate a 24-character password. Custom client passwords accept 1–256 characters, including spaces. Authentication uses salted scrypt hashes. To support copying full invitations later, a separate AES-256-GCM encrypted password is stored, using a purpose-derived key from the server signing secret and authenticated invitation ID. No plaintext password is stored in SQLite. The link itself contains only the ID. Passwords are returned only on creation and the explicitly authenticated admin invitation-copy endpoint, never in client responses, inbox listings or general detail responses.
- Each invitation accepts **one ZIP filename**, with one immutable size and content fingerprint. After completion the server rejects further uploads, across browsers and restarts. ZIP files are stored without extraction or execution. Filename extension is checked; this is not antivirus scanning or ZIP integrity verification.
- Admin creates invitations, lists pending/completed/expired invitations, downloads completed ZIPs (with HTTP Range support), and deletes invitations plus partial/completed data. Separate homeserver admin authentication; you can choose the same password as transfer during installation, but it is configured independently.
- Each inbox item has **Copy invite link** above Edit/Delete. It copies the full invitation text: link, password, expiry and ZIP size reminder, without a separate Upload ID line. Older hash-only invitations ask the admin for their current password once; the server verifies it and saves an encrypted copy without changing the password or revoking client sessions. Subsequent copies work across page reloads and server restarts. Clipboard failures expose the same share text for manual copying.
- **Edit invitation** hides the new-invitation form while editing; Save or Cancel restores it. Rename the client/project, change its password, set expiry within the next 30 days, change the ZIP limit up to 500 GB, and copy its existing share link. Its ID and link stay the same. Blank edit passwords preserve the current password and client sessions; setting a new password revokes existing client sessions and replaces the encrypted copy. Clients sign in again to resume their original ZIP without losing committed chunks. The limit cannot be reduced below the client's selected ZIP size. Completed invitations remain completed after all edits. Expired invitations that never started can be renewed; expired partial uploads require a new invitation because cleanup may already have removed their bytes.
- Default limit: 20 GB per invitation, seven-day expiry. Admin may select 1–500 GB (decimal GB, 1 GB = 1,000,000,000 bytes) and 1–30 days. Existing invitations retain their original byte limits. Default total reservation quota: 500 GiB, configurable. A 500 GB invitation fits within the default 500 GiB quota if other active reservations and retained files leave sufficient capacity. Ensure sufficient real free disk capacity. Completed files retain their actual size against quota until deleted; expired invitations release reservations and partial data is cleaned hourly. Completed files are retained until admin deletion. Each chunk checks free disk space with a 256 MiB safety reserve; this service shares disk with other applications, so monitor available space.
- Password attempts are rate-limited per IP (30/15 minutes), and expensive password derivations have bounded concurrency. Clients can access only their own invitation; admin tokens expire after eight hours, client sessions after seven days. Tokens are held in page memory. CORS allows only the configured website origin. Credentials and signed URLs must not enter access logs.
- The backend streams sequential 8 MiB chunks to an opaque staging filename with bounded memory, validates exact chunk sizes, flushes each chunk before saving its offset in SQLite, then publishes the archive without overwriting existing files and seals the invitation. Final filenames use sanitized project/original names and are saved in SQLite. A single service process owns all writes; **do not run multiple instances against the same data directory**.
- Partial chunks never advance the saved offset. A retry asks the server for its durable offset, so a lost response does not duplicate bytes. Pause/reopen/reselect the original ZIP to resume. A bounded-memory SHA-256 digest chain checks all ZIP bytes before upload/resume, preventing a different file of the same name/size from being spliced into a partial upload. This initial local read can take time for very large ZIPs; it does not send file bytes over the network.

## Speed and timeouts

Chunking and retries prevent a whole-file timeout and avoid starting over after interruptions. The browser displays progress and an approximate remaining time, retries temporary failures eight times with backoff, and requests a screen wake lock where supported. A network stall retries its current chunk. The server has a two-minute inactivity timeout with no whole-file deadline; Caddy must stream without buffering or a shorter total deadline. A slow upload that continues sending data can run for hours.

Throughput remains limited by the client's upstream bandwidth, the homeserver's downstream bandwidth and disk, and the route between them. Direct DNS-only HTTPS avoids Cloudflare proxy upload limits. Uploads are sequential to keep disk and network pressure predictable. Mobile browsers may suspend pages despite wake locks; keep the tab open, use power and a stable connection, or resume later. The service doesn't bypass an invitation's expiry during a long upload; choose enough days for the job. This retains the existing public hostname/HTTPS setup and does not require new inbound ports.

## Local verification

```powershell
node --test --test-isolation=none homeserver-upload/server.test.mjs upload/admin.test.cjs
node --check upload/upload.js
```

Node 24's built-in SQLite may print an experimental-feature warning. There are no npm dependencies. Integration tests cover authentication and CORS, token scoping, one-time completion, exact/ranged downloads, deletion/revocation, interrupted chunks, restart/resume, crash debris, quota reservation, validation and rate limits.

The editing upgrade adds `auth_version` to the existing SQLite table automatically at startup. It preserves rows, files and offsets and requires no manual SQL. Existing client sessions remain valid until their invitation's password changes. Both the static page and the owner-installed `server.mjs` need updating to enable custom passwords and editing. No Caddy or secret changes are needed.

The full-invitation-copy upgrade adds a nullable `password_box` column automatically and advertises API version 3. Existing hash-only passwords cannot be reconstructed; re-enter the current password once when copying, or set a new one through Edit invitation. Preserve the server signing key during ordinary upgrades so stored passwords remain decryptable. After a signing-key rotation, re-enter each invitation's current password once to re-encrypt it with the new key; authentication hashes remain usable. Keep configuration/signing-key backups private alongside consistent SQLite backups.

Admin sign-in checks the authenticated `/incoming/admin/capabilities` endpoint before opening the dashboard. If the homeserver still has an older backend, the page explains that `server.mjs` needs installing and the service needs restarting, rather than submitting newer invitation settings to an incompatible service. The current per-invitation ceiling is 500 decimal GB.

## Install on the homeserver (owner-run)

Server access is intentionally managed by the owner. On 2026-11-13 the owner installed Node v24.22.3 at `/opt/portfolio-node24`, configured the 500 GiB quota, enabled `portfolio-uploads`, and added the Caddy handler. Owner-provided output confirms the service is active and both loopback and public HTTPS `/incoming/admin` reject unauthenticated requests with 401. Caddy validation passed. Client upload, resume and download acceptance remain pending. The commands below are retained for installation/reference; preserve the existing secrets on upgrades.

The service uses `/mnt/storage1/homeserver-uploads`. Leave `/mnt/storage1/homeserver-transfers`, `/mnt/storage1/documents/transfer`, the existing transfer service, and other Caddy sites intact.

### 1. Copy the source from Windows

After replacing `<your-server-login>` with your normal account, run from the repository root in PowerShell:

```powershell
scp -r homeserver-upload "<your-server-login>@192.168.0.51:~/homeserver-upload-source"
```

### 2. Inspect prerequisites on Ubuntu

```bash
node --version
command -v node
findmnt /mnt/storage1
df -h /mnt/storage1
sudo systemctl status caddy portfolio-transfers --no-pager
sudo cat /etc/caddy/Caddyfile
```

Requires Node **24 or newer**, with `node:sqlite`, and `/opt/portfolio-node24/bin/node` for the supplied unit. If Node lives elsewhere, update `ExecStart` to that absolute binary path; do not use a home-directory nvm binary with `ProtectHome=true`. If Node 24 is not installed, use the isolated installation below. The existing server may use a different runtime; don't replace it blindly.

### 2a. Install an isolated Node 24 runtime when Node is missing

The owner confirmed Node is absent and `/mnt/storage1` is mounted with 851 GiB available on 2026-11-13. The configured upload quota is 500 GiB to leave space for other services. This installs an official Node 24 binary into its own directory; it does not replace a system Node installation or change shell PATH.

```bash
sudo apt-get update
sudo apt-get install -y curl ca-certificates xz-utils
(
set -eu
case "$(uname -m)" in
  x86_64) node_arch=x64 ;;
  aarch64|arm64) node_arch=arm64 ;;
  *) echo "Unsupported architecture; stop here."; exit 1 ;;
esac
node_download=$(mktemp -d)
cd "$node_download"
node_base=https://nodejs.org/dist/latest-v24.x
curl -fsSLO "$node_base/SHASUMS256.txt"
node_archive=$(awk -v arch="$node_arch" '$2 ~ ("-linux-" arch "[.]tar[.]xz$") { print $2; exit }' SHASUMS256.txt)
test -n "$node_archive"
curl -fsSLO "$node_base/$node_archive"
awk -v file="$node_archive" '$2 == file' SHASUMS256.txt | sha256sum --check -
sudo install -d -m 755 /opt/portfolio-node24
sudo tar -xJf "$node_archive" -C /opt/portfolio-node24 --strip-components=1 --no-same-owner
/opt/portfolio-node24/bin/node --version
/opt/portfolio-node24/bin/node -e "require('node:sqlite'); console.log('SQLite ready')"
)
```

The last lines should show a `v24.x.x` version and `SQLite ready`; an experimental-feature warning is okay. The supplied systemd unit uses this dedicated absolute path, so `node --version` in a regular shell may still say not found. Official binaries and verification references are available on the [Node download page](https://nodejs.org/en/download).

### 3. Install files, service account and secrets

Run this only after confirming the mount and Node prerequisites:

```bash
sudo useradd --system --user-group --no-create-home --shell /usr/sbin/nologin portfolio-uploads
sudo install -d -m 755 /mnt/storage1/homeserver-uploads/app
sudo install -d -o portfolio-uploads -g portfolio-uploads -m 700 /mnt/storage1/homeserver-uploads/data
sudo install -m 644 ~/homeserver-upload-source/server.mjs ~/homeserver-upload-source/storage.mjs ~/homeserver-upload-source/migrate-storage.mjs /mnt/storage1/homeserver-uploads/app/
sudo install -m 644 ~/homeserver-upload-source/portfolio-uploads.service /etc/systemd/system/portfolio-uploads.service
```

If the account already exists on a repeat install, skip `useradd`. Set an admin password of at least 12 characters interactively; spaces are allowed for memorable passphrases. No password is printed or placed in shell history, and a separate random signing key is generated on the server:

```bash
sudo python3 ~/homeserver-upload-source/configure.py
sudo systemctl daemon-reload
sudo systemctl enable --now portfolio-uploads
sudo systemctl status portfolio-uploads --no-pager
curl -i http://127.0.0.1:8789/incoming/admin
```

The unauthenticated curl must return **401**. A 500, connection failure or service restart loop needs fixing before proxy exposure. Use `sudo journalctl -u portfolio-uploads -n 30 --no-pager` for non-secret diagnostics. Keep the environment file private. Set the quota lower before starting if the shared disk has less free capacity.

### 4. Add the Caddy route

Back up the current config, edit it, and add the `handle /incoming/*` block from `Caddyfile.snippet` **inside the existing `files.jordanettinger.com` site block**. If that block already has mutually exclusive `handle` routes, place this handler alongside them. Preserve the existing catch-all proxy to port 8788. Do not replace the complete site block with the snippet.

```bash
sudo cp -a /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.before-uploads.$(date +%Y%m%d-%H%M%S)"
sudoedit /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
curl -i https://files.jordanettinger.com/incoming/admin
```

The public check must return the same **401** JSON from this service. Keep `files.jordanettinger.com` DNS-only. Disable access logging for `/incoming/*` or configure query-string redaction in the existing logger before using download links; they are bearer capabilities. The application itself does not log requests, credentials or download URLs. Review any existing proxy body limits or total request timeouts. If route integration is unclear, share just the relevant Caddy site block, with secrets removed, before changing it.

### 5. Publish and accept

Publish `upload/` along with the website through the existing GitHub Pages workflow. No Worker deployment, Cloudflare database migration, new DNS record, or change to transfer is needed. Open `https://www.jordanettinger.com/upload/?admin=1` to sign in with the new admin password. Make a short-lived test invitation and verify:

1. Wrong passwords fail; correct credentials open the upload page.
2. Upload one ZIP, disconnect/reconnect mid-upload, and confirm it resumes. Also pause and reopen/reselect the same ZIP.
3. Download from the inbox and compare SHA-256 with the original ZIP.
4. Reopen the client link: it shows completion and offers no second upload. Attempting reuse through the API also fails.
5. Delete the test invitation and verify its old download URL no longer works.
6. Test a representative large ZIP over public HTTPS from a client connection. The previous transfer service's 5 GB test does not validate this new service.
7. Confirm existing `/transfer/` upload/download routes still work after the Caddy edit.

Local tests pass independently of live deployment. Production installation, frontend publication, browser acceptance and a real slow/large-file test remain required before calling the service live.

Proxy routing and buffering behavior are described in Caddy's official [handle documentation](https://caddyserver.com/docs/caddyfile/directives/handle) and [reverse proxy documentation](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy). This service uses Node's built-in [SQLite API](https://nodejs.org/api/sqlite.html).

## Operations and rollback

### Readable archive names and migration

Completed archives use the client/project title plus the original ZIP filename, for example `Me test - Lou's Bday.zip`. A duplicate gets a short random suffix, for example `Me test - Lou's Bday - a1b2c3d4.zip`. Collisions are checked case-insensitively and across Unicode normalization forms, including existing files and reserved database names. Publication uses a hard link that refuses to overwrite an existing destination, followed by removal of the source; it requires hard-link support on the data filesystem. Unsupported filesystems fail without deleting the original data.

Storage names replace Windows/Linux path separators, reserved characters and control characters; normalize Unicode; handle Windows device names and trailing spaces/dots; and bound UTF-8 filename lengths. Spaces and apostrophes are retained. UUIDs still identify invitations, tokens, links and `<UUID>.part` staging files. Original upload filenames remain unchanged in SQLite and in the encoded download header.

The additive schema upgrade creates nullable `storage_name` (a basename relative to the configured data root) and `storage_source` (a recovery journal). The final basename is saved before publication and never reconstructed from an editable title. Editing a title after completion does not rename its file. No storage paths are accepted from API callers. Existing UUID `.file` and `.zip` archives remain downloadable until explicitly migrated; new and resumed uploads complete with readable names.

`migrate-storage.mjs` previews existing completed uploads by default. Applying it renames archives without copying their bytes, updates each row's storage reference, and preserves IDs, passwords, original filenames, offsets, sizes and completion timestamps. A durable per-file journal and synced directory operations permit replay after interruption at any file-move step. There is no single transaction spanning SQLite and the filesystem: an interrupted run can leave some files migrated and others pending, and rerunning apply finishes safely. The updated service also replays pending operations before serving requests. Preview lists desired names; collision suffixes are assigned during apply. Migration is idempotent. Do not manually rename files or edit these columns.

Deploy **all three modules**, with no frontend, Caddy, unit or secret changes. From the repository root on Windows:

```powershell
scp homeserver-upload/server.mjs homeserver-upload/storage.mjs homeserver-upload/migrate-storage.mjs "<your-server-login>@192.168.0.51:~/homeserver-upload-source/"
```

On the homeserver, pause active uploads, stop the service, and back up the entire app, data directory (including SQLite and WAL files) and private environment file together. Ensure enough disk space for the backup. Run the block as a script so a failed step stops deployment. Run migration as the service account to preserve ownership. Never run migration and the service concurrently; `--service-stopped` acknowledges that requirement and does not itself stop systemd.

```bash
set -eu
sudo systemctl stop portfolio-uploads
upload_backup="/mnt/storage1/homeserver-uploads-backup-$(date +%Y%m%d-%H%M%S)"
sudo install -d -m 700 "$upload_backup"
sudo cp -a /mnt/storage1/homeserver-uploads/data "$upload_backup/data"
sudo cp -a /mnt/storage1/homeserver-uploads/app "$upload_backup/app"
sudo cp -a /etc/portfolio-uploads.env "$upload_backup/portfolio-uploads.env"
for upload_module in server.mjs storage.mjs migrate-storage.mjs; do
  /opt/portfolio-node24/bin/node --check "$HOME/homeserver-upload-source/$upload_module"
  sudo install -m 644 "$HOME/homeserver-upload-source/$upload_module" /mnt/storage1/homeserver-uploads/app/
done
sudo -u portfolio-uploads /opt/portfolio-node24/bin/node /mnt/storage1/homeserver-uploads/app/migrate-storage.mjs /mnt/storage1/homeserver-uploads/data
```

Review the preview, then apply while the service remains stopped:

```bash
sudo -u portfolio-uploads /opt/portfolio-node24/bin/node /mnt/storage1/homeserver-uploads/app/migrate-storage.mjs /mnt/storage1/homeserver-uploads/data --apply --service-stopped
sudo systemctl start portfolio-uploads
sudo systemctl status portfolio-uploads --no-pager
curl -i http://127.0.0.1:8789/incoming/admin
```

**A service restart is required**; stop/start above performs it. No `daemon-reload` is needed. The unauthenticated HTTP check should return 401. If migration fails, keep the service stopped, resolve the issue and rerun apply; do not delete its journal columns or overwrite the data directory. A missing archive or wrong size fails preflight before new moves begin. Review any pending recovery listed in preview.

Acceptance: download migrated archives and compare hashes with the originals; complete two invitations titled `Me test` uploading `Lou's Bday.zip`; confirm one exact readable name and one suffixed name; rename a project in the admin page and confirm download still works; delete the test invitations and confirm both archives disappear. Partial uploads resume using the same UUID and offset.

Older backends cannot read the new stored names. Prefer a forward fix preserving the journal. Restoring an older app alone is insufficient; a full stopped-service restore of the matching app/data/config backup discards subsequent uploads and edits, so preserve the current data before considering that rollback.

Back up `/etc/portfolio-uploads.env` and the entire data directory together while the service is stopped; SQLite metadata and object files must be consistent. Don't commit secrets, SQLite files or client files. Rotate the signing key to revoke all outstanding tokens; rotate the admin secret to change admin login (existing admin tokens also need a signing-key rotation to revoke immediately). Retain the signing key during ordinary upgrades so in-progress client sessions continue working. Expired partials are removed hourly and at startup; completed files require explicit admin deletion.

To update, stop `portfolio-uploads`, replace all three app modules, then start it; never run two service instances. Existing partial uploads resume after a normal restart. To roll back, remove only the `/incoming/*` Caddy handler, validate/reload Caddy and stop/disable `portfolio-uploads`. Keep the data directory and secrets for recovery. The existing transfer service stays on port 8788 and is independent.
