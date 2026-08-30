-- Per-user Conversation Bot data. user_id is TEXT (Better Auth id / preview ids).

create table if not exists account_settings (
  user_id text primary key,
  provider text not null default 'openrouter',
  openrouter_key text not null default '',
  openrusrouter_key text not null default '',
  gpt_model text not null,
  grok_model text not null,
  claude_model text not null,
  max_cost_usd numeric not null default 1,
  updated_at text not null
);

create table if not exists projects (
  id text primary key,
  user_id text not null,
  name text not null,
  description text not null default '',
  created_at text not null
);
create index if not exists projects_user_id_idx on projects (user_id);

create table if not exists context_items (
  id text primary key,
  user_id text not null,
  project_id text not null,
  source text not null,
  kind text not null,
  content text not null,
  status text not null,
  created_at text not null
);
create index if not exists context_items_user_project_idx on context_items (user_id, project_id);

create table if not exists tasks (
  id text primary key,
  user_id text not null,
  project_id text not null,
  title text not null,
  prompt text not null,
  status text not null,
  error text,
  created_at text not null,
  completed_at text,
  total_input_tokens integer,
  total_output_tokens integer,
  total_cost_usd numeric,
  total_latency_ms integer,
  diagnostics jsonb,
  selected_chat_source_ids jsonb not null default '[]'
);
create index if not exists tasks_user_project_idx on tasks (user_id, project_id);

create table if not exists agent_responses (
  id text primary key,
  user_id text not null,
  task_id text not null,
  agent text not null,
  round integer not null,
  model text not null,
  provider text,
  prompt_snapshot text not null default '',
  response_text text not null default '',
  structured jsonb,
  input_tokens integer,
  cached_input_tokens integer,
  output_tokens integer,
  reasoning_tokens integer,
  cost numeric,
  request_id text,
  latency_ms integer,
  error text
);
create index if not exists agent_responses_user_task_idx on agent_responses (user_id, task_id);

create table if not exists council_results (
  task_id text primary key,
  user_id text not null,
  status text not null,
  consensus jsonb not null default '[]',
  disagreements jsonb not null default '[]',
  blockers jsonb not null default '[]',
  recommendation text not null default '',
  agent_positions jsonb not null,
  synthesis_raw text,
  synthesizer_proposed_status text,
  final_enforced_status text,
  verdict_override boolean not null default false,
  override_reason text
);
create index if not exists council_results_user_idx on council_results (user_id);

create table if not exists chat_sources (
  id text primary key,
  user_id text not null,
  project_id text not null,
  provider text not null,
  title text not null,
  source_url text,
  import_method text not null,
  access_status text not null,
  import_status text not null,
  raw_content text not null,
  message_count integer,
  character_count integer not null default 0,
  estimated_token_count integer,
  content_hash text not null,
  created_at text not null,
  imported_at text,
  last_access_check_at text,
  last_error text,
  include_in_memory boolean not null default false
);
create index if not exists chat_sources_user_project_idx on chat_sources (user_id, project_id);

create table if not exists history_messages (
  id text primary key,
  user_id text not null,
  chat_source_id text not null,
  sequence integer not null,
  speaker text not null,
  role text not null,
  content text not null,
  timestamp text
);
create index if not exists history_messages_user_source_idx on history_messages (user_id, chat_source_id, sequence);
