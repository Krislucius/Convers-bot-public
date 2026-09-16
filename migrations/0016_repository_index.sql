-- Authoritative source-tree index for selected repository archives.
-- Design/chat evidence stays DESIGN_EVIDENCE. Indexed source is IMPLEMENTATION_EVIDENCE.

alter table project_files
  add column if not exists source_tree jsonb;
