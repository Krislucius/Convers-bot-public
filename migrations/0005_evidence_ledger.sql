-- Evidence Ledger: chunks, extracted claims, and resumable extraction cache.
-- Additive. Does not alter existing chat/file rows. Ownership is always user_id + project_id.

create table if not exists evidence_chunks (
  id text primary key,
  user_id text not null,
  project_id text not null,
  source_kind text not null,
  source_id text not null,
  message_seq integer,
  file_span_start integer,
  file_span_end integer,
  ordinal integer not null,
  text text not null,
  content_hash text not null,
  chunker_version text not null,
  created_at text not null
);
create index if not exists evidence_chunks_user_project_idx on evidence_chunks (user_id, project_id);
create index if not exists evidence_chunks_user_source_idx on evidence_chunks (user_id, source_kind, source_id);

create table if not exists evidence_items (
  id text primary key,
  user_id text not null,
  project_id text not null,
  chunk_id text not null,
  source_kind text not null,
  source_id text not null,
  claim text not null,
  status text not null,
  citation text not null,
  extractor_fingerprint text not null,
  created_at text not null
);
create index if not exists evidence_items_user_project_idx on evidence_items (user_id, project_id);
create index if not exists evidence_items_user_chunk_idx on evidence_items (user_id, chunk_id);

create table if not exists extractor_cache (
  fingerprint text primary key,
  user_id text not null,
  project_id text not null,
  source_kind text not null,
  source_id text not null,
  source_hash text not null,
  chunker_version text not null,
  extractor_fingerprint text not null,
  payload jsonb not null,
  created_at text not null,
  updated_at text not null
);
create index if not exists extractor_cache_user_project_idx on extractor_cache (user_id, project_id);
