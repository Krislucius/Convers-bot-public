-- Persist the latest sanitized provider Test Connection log on the account.

alter table account_settings add column if not exists last_test_log text not null default '';
alter table account_settings add column if not exists last_test_at timestamptz;
alter table account_settings add column if not exists last_test_ok boolean;
