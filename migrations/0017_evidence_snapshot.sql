-- Persisted file extraction state. Evidence snapshot id lives on the context manifest payload.
alter table project_files add column if not exists source_status text;
alter table project_files add column if not exists source_language text;
alter table project_files add column if not exists page_count integer;
alter table project_files add column if not exists chunk_count integer;
alter table project_files add column if not exists extraction_method text;
alter table project_files add column if not exists source_hash text;
