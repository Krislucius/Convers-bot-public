-- Council member identity: member_id is identity; role may repeat.

alter table agent_responses add column if not exists member_id text;
alter table agent_responses add column if not exists role text;
alter table agent_responses add column if not exists stage text;
alter table agent_responses add column if not exists attempt integer;
alter table agent_responses add column if not exists dispatched_model_id text;

update agent_responses
set member_id = coalesce(nullif(member_id, ''), agent)
where member_id is null or member_id = '';

update agent_responses
set role = coalesce(nullif(role, ''), agent)
where role is null or role = '';

update agent_responses
set stage = case
  when stage is not null and stage <> '' then stage
  when round = 3 then 'SYNTHESIS'
  when round = 2 then 'ROUND_2'
  else 'ROUND_1'
end
where stage is null or stage = '';

update agent_responses
set dispatched_model_id = coalesce(nullif(dispatched_model_id, ''), model)
where dispatched_model_id is null or dispatched_model_id = '';
