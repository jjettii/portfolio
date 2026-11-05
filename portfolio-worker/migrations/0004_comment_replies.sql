ALTER TABLE comments ADD COLUMN parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE;
CREATE INDEX comments_parent_id ON comments(parent_id);
