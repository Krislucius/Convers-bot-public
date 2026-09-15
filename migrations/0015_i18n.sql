-- Per-account UI language and task/result localization.
-- Canonical Council artifacts stay English. UI language never overwrites them.

alter table account_settings
  add column if not exists ui_language text not null default 'en';

alter table tasks
  add column if not exists original_task text;

alter table tasks
  add column if not exists canonical_task_en text;

alter table tasks
  add column if not exists source_language text not null default 'en';

alter table tasks
  add column if not exists original_title text;

update tasks
  set original_task = coalesce(nullif(original_task, ''), prompt),
      canonical_task_en = coalesce(nullif(canonical_task_en, ''), prompt),
      original_title = coalesce(nullif(original_title, ''), title)
  where original_task is null
     or canonical_task_en is null
     or original_title is null;

alter table council_results
  add column if not exists localized_ru jsonb;
