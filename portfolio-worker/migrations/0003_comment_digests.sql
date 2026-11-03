-- Queue only future comments. Creating the trigger does not notify for old comments.
CREATE TABLE comment_digest_projects (
  project_id TEXT PRIMARY KEY,
  latest_seq INTEGER NOT NULL,
  last_comment_at INTEGER NOT NULL,
  lease_until INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT
);
CREATE TABLE comment_digest_outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  comment_id INTEGER NOT NULL
);
CREATE INDEX comment_digest_outbox_project ON comment_digest_outbox(project_id, seq);
CREATE TRIGGER queue_comment_digest AFTER INSERT ON comments
WHEN EXISTS (SELECT 1 FROM videos v JOIN reviews r ON r.id = v.review_id WHERE v.stream_uid = NEW.video_id)
BEGIN
  INSERT INTO comment_digest_outbox(project_id, comment_id)
    SELECT review_id, NEW.id FROM videos WHERE stream_uid = NEW.video_id;
  INSERT INTO comment_digest_projects(project_id, latest_seq, last_comment_at)
    SELECT review_id, last_insert_rowid(), unixepoch() FROM videos WHERE stream_uid = NEW.video_id
    ON CONFLICT(project_id) DO UPDATE SET latest_seq = excluded.latest_seq, last_comment_at = excluded.last_comment_at;
END;
