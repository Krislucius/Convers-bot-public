-- Durable server-owned Council runs. Browser presence is reconnect-only.

create table if not exists council_runs (
  id text primary key,
  user_id text not null,
  task_id text not null,
  generation integer not null default 1,
  lease_epoch integer not null default 0,
  status text not null,
  stage text not null,
  cancel_requested boolean not null default false,
  lease_owner text,
  lease_expires_at text,
  tick_token text not null,
  cursor jsonb not null default '{}'::jsonb,
  snapshot jsonb not null default '{}'::jsonb,
  frozen_input jsonb not null default '{}'::jsonb,
  context_hash text,
  provider text not null,
  nanogpt_billing_mode text,
  members jsonb not null default '[]'::jsonb,
  synthesizer_model text not null default '',
  catalog jsonb,
  started_at text not null,
  last_progress_at text not null,
  completed_at text,
  error text,
  created_at text not null
);

create index if not exists council_runs_user_task_idx on council_runs (user_id, task_id);
create index if not exists council_runs_user_active_idx
  on council_runs (user_id)
  where status not in ('COMPLETE', 'FAILED', 'CANCELLED');

create unique index if not exists council_runs_one_active_per_task
  on council_runs (user_id, task_id)
  where status not in ('COMPLETE', 'FAILED', 'CANCELLED');
