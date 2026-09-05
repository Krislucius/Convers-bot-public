-- Dual API providers (NanoGPT + OpenRouter) and per-task provider freeze.
-- NanoGPT secrets that lived in openrouter_key during BUILD 025 move to nanogpt_key.

alter table account_settings add column if not exists nanogpt_key text not null default '';

update account_settings
set
  nanogpt_key = openrouter_key,
  openrouter_key = '',
  provider = 'nanogpt'
where openrouter_key ilike 'sk-nano-%'
  and coalesce(nanogpt_key, '') = '';

update account_settings
set provider = 'nanogpt'
where provider = 'openrouter'
  and nanogpt_key ilike 'sk-nano-%'
  and coalesce(openrouter_key, '') = '';

alter table tasks add column if not exists provider text;

update tasks t
set provider = coalesce(
  (
    select case
      when s.provider in ('nanogpt', 'openrouter', 'openrusrouter') then s.provider
      else 'nanogpt'
    end
    from account_settings s
    where s.user_id = t.user_id
  ),
  'nanogpt'
)
where t.provider is null or t.provider = '';
