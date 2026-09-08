-- Independent waker heartbeat for durable Council runs.
-- last_wake_at is owned by the sweeper, not by tick CAS writes.

alter table council_runs add column if not exists last_wake_at text;
