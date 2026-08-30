-- v0.1.3 task modes, context manifests, and CREATE artifacts.

alter table tasks add column if not exists mode text not null default 'REVIEW';
alter table tasks add column if not exists requires_historical_context boolean not null default false;
alter table tasks add column if not exists candidate_artifact_id text;
alter table tasks add column if not exists decision_question text;
alter table tasks add column if not exists context_manifest_id text;
alter table tasks add column if not exists context_hash text;

alter table agent_responses add column if not exists context_manifest_id text;
alter table agent_responses add column if not exists context_hash text;

alter table council_results add column if not exists decision text;
alter table council_results add column if not exists rationale text;
alter table council_results add column if not exists dissent jsonb not null default '[]';

create table if not exists context_manifests (
  id text primary key,
  user_id text not null,
  task_id text not null,
  hash text not null,
  payload jsonb not null,
  created_at text not null
);
create index if not exists context_manifests_user_task_idx on context_manifests (user_id, task_id);

create table if not exists artifacts (
  id text primary key,
  user_id text not null,
  task_id text not null,
  project_id text not null,
  type text not null,
  title text not null,
  version text not null,
  content text not null,
  status text not null,
  context_hash text not null,
  evidence_labels jsonb not null default '[]',
  created_at text not null
);
create index if not exists artifacts_user_project_idx on artifacts (user_id, project_id);
create index if not exists artifacts_user_task_idx on artifacts (user_id, task_id);
