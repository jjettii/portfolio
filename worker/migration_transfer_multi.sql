-- Migration: multi-file transfer support
-- Run once against your D1 database:
--   wrangler d1 execute review-comments --remote --file=worker/migration_transfer_multi.sql

ALTER TABLE transfers ADD COLUMN total_size INTEGER;

CREATE TABLE IF NOT EXISTS transfer_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transfer_id TEXT NOT NULL REFERENCES transfers(id),
  filename TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  filesize INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0
);
