-- Per-provider public credential metadata (fingerprint / last4 / last validation).
-- Secrets stay in nanogpt_key / openrouter_key / openrusrouter_key and are encrypted at rest.

alter table account_settings
  add column if not exists provider_credentials jsonb not null default '{}'::jsonb;
