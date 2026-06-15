-- Migration: add review sessions
-- Run once against your D1 database:
--   wrangler d1 execute review-comments --remote --file=worker/migration_reviews.sql

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- SQLite does not support IF NOT EXISTS for ADD COLUMN.
-- This will error harmlessly if already applied.
ALTER TABLE videos ADD COLUMN review_id TEXT REFERENCES reviews(id);
