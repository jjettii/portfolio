# Setup Guide — Video Review & File Transfer

This is a one-time setup. Takes about 20 minutes.

---

## 1. Install Wrangler

```bash
npm install -g wrangler
wrangler login   # opens browser to authenticate with Cloudflare
```

---

## 2. Create Cloudflare Resources

### R2 Bucket
```bash
wrangler r2 bucket create review-uploads
```

Set CORS so browsers can upload/download directly:
```bash
wrangler r2 bucket cors put review-uploads --rules '[{"AllowedOrigins":["*"],"AllowedMethods":["PUT","GET","HEAD"],"AllowedHeaders":["*"],"MaxAgeSeconds":3000}]'
```

### D1 Database
```bash
wrangler d1 create review-comments
```

Copy the `database_id` from the output and paste it into `worker/wrangler.toml`:
```toml
[[d1_databases]]
binding = "DB"
database_name = "review-comments"
database_id = "PASTE_YOUR_ID_HERE"   # ← replace this line
```

### Create the tables
```bash
cd worker
wrangler d1 execute review-comments --file=schema.sql
```

---

## 3. Get Your R2 API Keys

These are separate from your main CF API token and are used to generate presigned upload/download URLs.

1. Go to **Cloudflare Dashboard → R2 → Manage R2 API Tokens**
2. Click **Create API Token**
3. Permissions: **Object Read & Write**
4. Scope: **Specific bucket → review-uploads**
5. Save the **Access Key ID** and **Secret Access Key**

---

## 4. Get Your Cloudflare Account ID

Dashboard → right sidebar on any page → copy **Account ID**.

---

## 5. Get Your Stream API Token

1. Dashboard → **My Profile → API Tokens → Create Token**
2. Template: **Edit Cloudflare Stream** (or custom with `stream:write` permission)
3. Save the token

---

## 6. Set Worker Secrets

```bash
cd worker

wrangler secret put ADMIN_SECRET
# → Enter a strong password. This is what you use to log into the admin panels.

wrangler secret put PASSWORD_SALT
# → Enter any random string (e.g. output of: openssl rand -hex 16)

wrangler secret put CF_ACCOUNT_ID
# → Paste your Cloudflare Account ID

wrangler secret put R2_ACCESS_KEY_ID
# → Paste the R2 Access Key ID from step 3

wrangler secret put R2_SECRET_ACCESS_KEY
# → Paste the R2 Secret Access Key from step 3

wrangler secret put R2_BUCKET_NAME
# → Type: review-uploads

wrangler secret put STREAM_API_TOKEN
# → Paste your Stream API token from step 5
```

---

## 7. Deploy the Worker

```bash
cd worker
npm install
wrangler deploy
```

The output will show your Worker URL:
```
https://portfolio-worker.YOUR-SUBDOMAIN.workers.dev
```

---

## 8. Update the Frontend Pages

Open both frontend files and replace the placeholder URL with your real Worker URL:

**transfer/index.html** — line near the top of the `<script>` block:
```js
const WORKER_URL = 'https://portfolio-worker.YOUR-SUBDOMAIN.workers.dev';
```

**review/index.html** — same line:
```js
const WORKER_URL = 'https://portfolio-worker.YOUR-SUBDOMAIN.workers.dev';
```

---

## 9. Push to GitHub

```bash
git add worker/ transfer/ review/
git commit -m "Add video review and file transfer tools"
git push
```

---

## How It Works

### File Transfer (WeTransfer replacement)
- **Admin**: Go to `/transfer/` → click Admin → sign in → New Transfer → choose file, set description and download password → upload
- The file uploads directly from your browser to R2 via a presigned URL (no file size limit from the Worker)
- You get a shareable link like: `https://yoursite.com/transfer/?id=abc-123`
- **Client**: Opens the link, enters the password you gave them, downloads

### Video Review (Frame.io replacement)
- **Admin**: Go to `/review/` → click Admin → sign in → Upload Video → choose file, enter title
- Video uploads to Cloudflare Stream via TUS (resumable). Processing takes 1–5 minutes.
- Share the direct link: `https://yoursite.com/review/?v=STREAM_UID`
- **Client**: Opens the link, watches the video, clicks "Comment at this time" to leave timestamped notes
- Clicking a comment in the sidebar seeks the video to that timestamp

---

## Secrets Reference

| Secret | Where to get it |
|--------|----------------|
| `ADMIN_SECRET` | Make it up — this is your admin password |
| `PASSWORD_SALT` | Make it up — any random string |
| `CF_ACCOUNT_ID` | Cloudflare Dashboard sidebar |
| `R2_ACCESS_KEY_ID` | R2 → Manage API Tokens |
| `R2_SECRET_ACCESS_KEY` | R2 → Manage API Tokens |
| `R2_BUCKET_NAME` | `review-uploads` (unless you renamed it) |
| `STREAM_API_TOKEN` | My Profile → API Tokens |

---

## Local Development

```bash
cd worker
wrangler dev
```

Change `WORKER_URL` in the HTML files to `http://localhost:8787` for local testing.
The R2 and D1 bindings are available locally via Wrangler's local simulator.

---

## Costs

All Cloudflare free tiers unless otherwise noted:

| Service | Free tier | Overage |
|---------|-----------|---------|
| Workers | 100k req/day | $5/month flat |
| R2 storage | 10 GB | $0.015/GB/month |
| R2 operations | 1M Class A, 10M Class B | $0.036 / $0.004 per million |
| D1 | 5 GB, 25M rows/day | Paid plan: $0.75/GB |
| Stream storage | 1,000 minutes free | $5/1,000 minutes |
| Stream delivery | 10,000 minutes free/month | $1/1,000 minutes |
