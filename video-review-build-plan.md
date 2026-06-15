# Build Plan: Self-Hosted Video Review Tool (Frame.io Replacement)

## Context
- Static site hosted on GitHub Pages (or similar)
- Existing Cloudflare Stream account (38 videos, 58/1000 minutes used)
- Cloudflare R2 for file/video storage and transfer (10GB free, $0.015/GB after)
- Goal: presigned upload/download via R2, video preview via Stream, timestamped comments

## Architecture
1. **Cloudflare Worker** — single API backend
   - Generates presigned R2 upload/download URLs
   - Proxies/manages Cloudflare Stream uploads
   - CRUD API for comments (stored in D1)
2. **Cloudflare R2** — raw file storage (originals, large transfers)
3. **Cloudflare Stream** — adaptive playback for review copies
4. **Cloudflare D1** — SQLite database for comments
5. **Frontend** — static page(s) added to existing GitHub-hosted site, calling the Worker API

## Required Cloudflare Setup (do manually before coding)
- Create R2 bucket (e.g. `review-uploads`)
- Create D1 database (e.g. `review-comments`)
- Confirm Stream API token with `stream:write` permission
- Note account ID, R2 access keys, Stream API token — store in Worker secrets, never commit

## Phase 1: R2 Presigned Transfer (build first)
- Worker endpoint: `POST /upload-url` → returns presigned PUT URL for R2 (expiring, e.g. 1hr)
- Worker endpoint: `GET /download-url/:key` → returns presigned GET URL
- Frontend: simple upload form, drag-drop, progress bar
- Test: upload a file directly from browser to R2, confirm it appears in bucket

## Phase 2: Stream Integration
- Worker endpoint: `POST /stream-upload` → calls Cloudflare Stream API to get a one-time upload URL, returns it to frontend
- Frontend: video player embed using Stream's player (iframe or HLS.js)
- Decide: only push "review" copies to Stream, keep originals in R2 (avoids double Stream minutes usage)
- Test: upload a video, confirm it plays back with adaptive streaming

## Phase 3: Timestamped Comments
- D1 schema:
  ```sql
  CREATE TABLE comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL,
    timestamp_seconds REAL NOT NULL,
    author TEXT,
    body TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  ```
- Worker endpoints:
  - `POST /comments` — create comment (video_id, timestamp, body, author)
  - `GET /comments/:video_id` — list comments for a video
  - `DELETE /comments/:id` — remove comment
- Frontend:
  - Overlay markers on video timeline at comment timestamps
  - Click marker → seek to timestamp
  - "Add comment at current time" button
  - List view of all comments, click to jump to timestamp

## Phase 4 (optional, later)
- Basic auth (Cloudflare Access or simple shared token) to restrict who can comment/upload
- Email/webhook notification on new comment
- Approval status field per video (pending/approved/rejected)

## Notes for Claude Code
- Use Wrangler CLI for local dev and deployment of the Worker
- Keep frontend framework-free or minimal (vanilla JS or lightweight framework) to match existing static site setup
- All secrets (R2 keys, Stream token, D1 binding) go in `wrangler.toml` / Worker secrets, not in frontend code
- Build and test Phase 1 fully before starting Phase 2; each phase should work independently
