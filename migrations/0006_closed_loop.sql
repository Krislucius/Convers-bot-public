-- Closed loop: REVIEW verdicts, DECIDE structure, implementation packets.
-- Additive. Ownership is always user_id + project_id.

alter table council_results add column if not exists review_verdict text;
alter table council_results add column if not exists structured jsonb not null default '{}';

create table if not exists implementation_packets (
  id text primary key,
  user_id text not null,
  project_id text not null,
  task_id text not null,
  artifact_id text not null,
  parent_packet_id text,
  iteration integer not null default 1,
  status text not null,
  scope text not null,
  requirements jsonb not null default '[]',
  invariants jsonb not null default '[]',
  evidence_refs jsonb not null default '[]',
  acceptance_tests jsonb not null default '[]',
  blockers jsonb not null default '[]',
  packet_hash text not null,
  handoff_at text,
  implementation_status text,
  implementation_notes text,
  implementation_recorded_at text,
  review_task_id text,
  created_at text not null
);
create index if not exists implementation_packets_user_project_idx on implementation_packets (user_id, project_id);
create index if not exists implementation_packets_user_task_idx on implementation_packets (user_id, task_id);
