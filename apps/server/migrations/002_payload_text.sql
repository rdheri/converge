-- The CRDT is granular to UTF-16 code units, so a character outside the
-- BMP (an emoji, say) is stored as two nodes each holding one surrogate.
-- A lone surrogate is valid in a JS string and in escaped JSON text, but
-- Postgres jsonb enforces well-formed Unicode and rejects it
-- ("Unicode low surrogate must follow a high surrogate"), which would
-- fail the op INSERT. The op log is always read back wholesale and
-- re-validated in the app, so it does not need jsonb's structure — plain
-- text round-trips any string the CRDT can produce.
ALTER TABLE operations ALTER COLUMN payload TYPE text USING payload::text;
ALTER TABLE snapshots ALTER COLUMN state TYPE text USING state::text;
