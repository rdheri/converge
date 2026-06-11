CREATE TABLE documents (
  id         text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Append-only op log. seq is the server-assigned per-document delivery
-- cursor (what clients catch up by); lamport/site_id are denormalized
-- from the payload for observability and ad-hoc queries.
CREATE TABLE operations (
  doc_id     text        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  seq        bigint      NOT NULL,
  lamport    bigint      NOT NULL,
  site_id    text        NOT NULL,
  payload    jsonb       NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (doc_id, seq)
);

-- Periodic full-state snapshots for fast cold loads (snapshot + tail
-- instead of full log replay). Written by the Phase 5 snapshotter.
CREATE TABLE snapshots (
  doc_id     text        PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  state      jsonb       NOT NULL,
  up_to_seq  bigint      NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
