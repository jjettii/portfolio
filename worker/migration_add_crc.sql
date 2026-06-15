-- Migration: add crc32 column to transfer_files for client-side checksum storage
-- Run once:
--   wrangler d1 execute review-comments --remote --file=migration_add_crc.sql

ALTER TABLE transfer_files ADD COLUMN crc32 INTEGER;
