# Client upload inbox

This is a separate, dependency-free Node 24 service on the homeserver. The static website serves `/upload/`; **all upload authentication, invitation metadata, ZIP bytes and downloads live on the homeserver**. It does not use the portfolio Worker, D1 or R2 and does not change `/transfer/`.

## Behavior

- Client signs in with an invitation ID and password. Admin may set a custom password when creating an invitation, or leave the field blank to generate a 24-character password. Custom client passwords accept 1–256 characters, including spaces. Admin gets the password once, with a shareable link. Passwords are salted and scrypt-hashed at rest; the link contains only the ID.
- Each invitation accepts **one ZIP filename**, with one immutable size and content fingerprint. After completion the server rejects further uploads, across browsers and restarts. ZIP files are stored without extraction or execution. Filename extension is checked; this is not antivirus scanning or ZIP integrity verification.
- Admin creates invitations, lists pending/completed/expired invitations, downloads completed ZIPs (with HTTP Range support), and deletes invitations plus partial/completed data. Separate homeserver admin authentication; you can choose the same password as transfer during installation, but it is configured independently.
- Each inbox item has **Edit invitation**: rename the client/project, change its password, set expiry within the next 30 days, change the ZIP limit up to 1000 GB, and copy its existing share link. Its ID and link stay the same. Blank edit passwords preserve the current password and client sessions; setting a new password revokes existing client sessions. Clients sign in again to resume their original ZIP without losing committed chunks. Current passwords cannot be retrieved. The limit cannot be reduced below the client's selected ZIP size. Completed invitations remain completed after all edits. Expired invitations that never started can be renewed; expired partial uploads require a new invitation because cleanup may already have removed their bytes.
- Default limit: 20 GB per invitation, seven-day expiry. Admin may select 1–1000 GB (decimal GB, 1 GB = 1,000,000,000 bytes) and 1–30 days. Existing invitations retain their original byte limits. Default total reservation quota: 500 GiB, configurable. To create a 1000 GB invitation, raise `UPLOAD_QUOTA_BYTES` to at least `1000000000000` and ensure sufficient real free disk capacity. Completed files retain their actual size against quota until deleted; expired invitations release reservations and partial data is cleaned hourly. Completed files are retained until admin deletion. Each chunk checks free disk space with a 256 MiB safety reserve; this service shares disk with other applications, so monitor available space.
- Password attempts are rate-limited per IP (30/15 minutes), and expensive password derivations have bounded concurrency. Clients can access only their own invitation; admin tokens expire after eight hours, client sessions after seven days. Tokens are held in page memory. CORS allows only the configured website origin. Credentials and signed URLs must not enter access logs.
- The backend streams sequential 8 MiB chunks to an opaque staging filename with bounded memory, validates exact chunk sizes, flushes each chunk before saving its offset in SQLite, then atomically renames and seals the invitation. No filesystem paths come from client filenames. A single service process owns all writes; **do not run multiple instances against the same data directory**.
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
sudo install -m 644 ~/homeserver-upload-source/server.mjs /mnt/storage1/homeserver-uploads/app/server.mjs
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

Back up `/etc/portfolio-uploads.env` and the entire data directory together while the service is stopped; SQLite metadata and object files must be consistent. Don't commit secrets, SQLite files or client files. Rotate the signing key to revoke all outstanding tokens; rotate the admin secret to change admin login (existing admin tokens also need a signing-key rotation to revoke immediately). Retain the signing key during ordinary upgrades so in-progress client sessions continue working. Expired partials are removed hourly and at startup; completed files require explicit admin deletion.

To update, stop `portfolio-uploads`, replace the app file, then start it; never run two service instances. Existing partial uploads resume after a normal restart. To roll back, remove only the `/incoming/*` Caddy handler, validate/reload Caddy and stop/disable `portfolio-uploads`. Keep the data directory and secrets for recovery. The existing transfer service stays on port 8788 and is independent.
