ALTER TABLE comments ADD COLUMN admin_seen INTEGER NOT NULL DEFAULT 0 CHECK (admin_seen IN (0, 1));
ALTER TABLE comments ADD COLUMN completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1));
CREATE INDEX IF NOT EXISTS comments_video_status ON comments (video_id, admin_seen, completed);
