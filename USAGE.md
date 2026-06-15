# Usage Guide

## File Transfer

A self-hosted WeTransfer replacement. Files are stored in R2 and downloaded via time-limited presigned URLs.

### Sending a file (Admin)

1. Go to `jordanettinger.com/transfer/`
2. Click **Admin** and enter your `ADMIN_SECRET` password
3. Click **New Transfer**
4. Drop or select a file
5. Fill in an optional description and a download password (you choose this — share it with the recipient separately)
6. Click **Upload** — the file goes directly from your browser to R2 (no file size limit from the Worker)
7. Copy the shareable link that appears (format: `jordanettinger.com/transfer/?id=abc-123`)

### Downloading a file (Client)

1. Open the link you were sent
2. Enter the password
3. Click **Download** — the file downloads directly from R2

### Managing transfers (Admin)

From the Admin panel you can see all transfers and delete them (this removes both the file from R2 and the database record).

---

## Video Review

A self-hosted Frame.io replacement. Videos are hosted on Cloudflare Stream with resumable upload and HLS playback.

### Uploading a video (Admin)

1. Go to `jordanettinger.com/review/`
2. Click **Admin** and enter your `ADMIN_SECRET` password
3. Click **Upload Video**
4. Enter a title (and optional description), then select the video file
5. The upload uses TUS (resumable) — if it drops it will resume from where it left off
6. Processing takes 1–5 minutes after upload completes before the video is playable
7. Once done, copy the share link (format: `jordanettinger.com/review/?v=<stream-uid>`)

### Watching and commenting (Client)

1. Open the link you were sent — no login required
2. Watch the video
3. To leave a comment, pause at the relevant moment and click **Comment at this time**
4. Enter your name (defaults to Anonymous) and your note, then submit
5. Comments appear in the sidebar sorted by timestamp — clicking one seeks the video to that moment

### Managing videos (Admin)

From the Admin panel you can see all uploaded videos and delete them. Deleting a video removes it from Cloudflare Stream and deletes all associated comments from the database.

---

## Notes

- Both tools are unlisted (`noindex`) — they won't appear in search results but anyone with the link can access them
- Download links expire after 1 hour; upload windows expire after 2 hours
- Admin password is the `ADMIN_SECRET` you set during setup — the same one for both tools
- Stream storage: first 1,000 minutes free, then $5/1,000 minutes
- R2 storage: first 10 GB free, then $0.015/GB/month
