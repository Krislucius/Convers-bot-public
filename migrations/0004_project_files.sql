-- Project Files: zip/pdf/md as untrusted evidence. Selected file IDs persist on the task.

create table if not exists project_files (
  id text primary key,
  user_id text not null,
  project_id text not null,
  filename text not null,
  kind text not null,
  extracted_text text not null default '',
  members jsonb not null default '[]',
  notes text not null default '',
  size_bytes integer not null default 0,
  character_count integer not null default 0,
  estimated_tokens integer not null default 0,
  include_in_memory boolean not null default true,
  created_at text not null
);
create index if not exists project_files_user_project_idx on project_files (user_id, project_id);

alter table tasks add column if not exists selected_file_ids jsonb not null default '[]';
