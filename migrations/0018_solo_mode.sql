-- Solo is a separate conversation mode. It does not share Council run ceilings.
alter table projects add column if not exists work_mode text not null default 'COUNCIL';

create table if not exists solo_threads (
  id text primary key,
  user_id text not null,
  project_id text not null,
  provider text not null,
  model_id text not null,
  model_label text not null default '',
  title text not null default '',
  context_enabled boolean not null default false,
  selected_chat_ids jsonb not null default '[]',
  selected_file_ids jsonb not null default '[]',
  selected_artifact_ids jsonb not null default '[]',
  transitions jsonb not null default '[]',
  cancel_requested boolean not null default false,
  created_at text not null,
  updated_at text not null
);
create index if not exists solo_threads_user_project_idx on solo_threads (user_id, project_id, updated_at desc);

create table if not exists solo_messages (
  id text primary key,
  user_id text not null,
  thread_id text not null,
  role text not null,
  content text not null default '',
  provider text,
  model_id text,
  created_at text not null,
  input_tokens integer,
  output_tokens integer,
  cost numeric,
  latency_ms integer,
  error text,
  citations jsonb not null default '[]',
  stopped boolean not null default false
);
create index if not exists solo_messages_thread_idx on solo_messages (user_id, thread_id, created_at);

create table if not exists solo_usage (
  id text primary key,
  user_id text not null,
  kind text not null,
  provider text not null,
  model_id text not null default '',
  thread_id text,
  created_at text not null,
  cost numeric,
  input_tokens integer,
  output_tokens integer
);
create index if not exists solo_usage_user_kind_idx on solo_usage (user_id, kind);
