-- NanoGPT subscription vs pay-as-you-go is an explicit account setting, frozen per Council run.

alter table account_settings add column if not exists nanogpt_billing_mode text not null default 'subscription';
alter table tasks add column if not exists nanogpt_billing_mode text;

update account_settings
set nanogpt_billing_mode = 'subscription'
where nanogpt_billing_mode is null or btrim(nanogpt_billing_mode) = '';
