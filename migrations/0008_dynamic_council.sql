-- Dynamic Council membership: selected models, synthesizer override, cached discovery.

alter table account_settings add column if not exists selected_model_ids jsonb not null default '[]';
alter table account_settings add column if not exists synthesizer_model text not null default '';
alter table account_settings add column if not exists model_catalog jsonb;

update account_settings
set selected_model_ids = jsonb_build_array(gpt_model, grok_model, claude_model)
where (selected_model_ids is null or selected_model_ids = '[]'::jsonb)
  and coalesce(gpt_model, '') <> ''
  and coalesce(claude_model, '') <> '';

alter table tasks add column if not exists selected_models jsonb;
