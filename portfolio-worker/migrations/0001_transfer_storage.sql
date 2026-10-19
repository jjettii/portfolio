-- Apply once before deploying the new Worker. Existing objects remain in R2.
ALTER TABLE transfers ADD COLUMN storage_provider TEXT NOT NULL DEFAULT 'cloudflare'
  CHECK (storage_provider IN ('cloudflare', 'homeserver'));
ALTER TABLE transfers ADD COLUMN storage_deleting INTEGER NOT NULL DEFAULT 0;
