begin;
create table public.command_requests(
  id uuid primary key default gen_random_uuid(),mission_id uuid not null references public.missions(id),
  idempotency_key text not null,kind text not null,payload jsonb not null,actor_id uuid not null,
  created_at timestamptz not null default now(),unique(mission_id,idempotency_key),unique(mission_id,id)
);
create table public.command_results(
  id uuid primary key default gen_random_uuid(),mission_id uuid not null,command_id uuid not null,
  status text not null check(status in('completed','failed','blocked')),result jsonb not null,
  created_at timestamptz not null default now(),foreign key(mission_id,command_id) references public.command_requests(mission_id,id),unique(command_id)
);
create table public.run_checkpoints(
  id uuid primary key default gen_random_uuid(),mission_id uuid not null references public.missions(id),
  run_id uuid not null,step_key text not null,result jsonb not null,created_at timestamptz not null default now(),
  foreign key(mission_id,run_id) references public.runs(mission_id,id),unique(run_id,step_key)
);
create table public.run_telemetry(
  id uuid primary key default gen_random_uuid(),mission_id uuid not null references public.missions(id),run_id uuid not null,
  role text not null,tier text not null,model text not null,context_hash text not null,tokens integer not null check(tokens>=0),
  tool_calls integer not null check(tool_calls>=0),elapsed_ms integer not null check(elapsed_ms>=0),cost_minor bigint,
  created_at timestamptz not null default now(),foreign key(mission_id,run_id) references public.runs(mission_id,id)
);
create table public.notification_events(
  id uuid primary key default gen_random_uuid(),mission_id uuid not null references public.missions(id),kind text not null,
  title text not null,why text not null,target jsonb not null,delivery text not null check(delivery in('immediate','digest','after_quiet_hours')),
  locale text not null,created_at timestamptz not null default now()
);
create table public.founder_preferences(
  id uuid primary key default gen_random_uuid(),mission_id uuid not null references public.missions(id),kind text not null,
  value jsonb not null,actor_id uuid not null,created_at timestamptz not null default now()
);
create table public.operator_reviews(
  id uuid primary key default gen_random_uuid(),mission_id uuid not null references public.missions(id),
  artifact_version_id uuid not null,decision text not null check(decision in('approved','rejected','corrected')),
  correction text,reviewer_id uuid not null,created_at timestamptz not null default now(),
  foreign key(mission_id,artifact_version_id) references public.artifact_versions(mission_id,id)
);
create table public.demand_pages(
  id uuid primary key default gen_random_uuid(),mission_id uuid not null references public.missions(id),slug text not null unique,
  artifact_version_id uuid not null,threshold_decision_id uuid not null,publication_receipt_id uuid not null,
  content jsonb not null,sandbox_mode boolean not null,created_at timestamptz not null default now(),unique(mission_id,id),
  foreign key(mission_id,artifact_version_id) references public.artifact_versions(mission_id,id),
  foreign key(mission_id,threshold_decision_id) references public.decisions(mission_id,id),
  foreign key(mission_id,publication_receipt_id) references public.provider_receipts(mission_id,id)
);
create table public.demand_signups(
  id uuid primary key default gen_random_uuid(),mission_id uuid not null,page_id uuid not null,email_hash text not null,
  email_ciphertext text not null,consent_at timestamptz not null,created_at timestamptz not null default now(),
  foreign key(mission_id,page_id) references public.demand_pages(mission_id,id),unique(page_id,email_hash)
);
create table public.runtime_ticks(
  id uuid primary key default gen_random_uuid(),mission_id uuid not null references public.missions(id),
  event_key text not null,plan jsonb not null,created_at timestamptz not null default now(),unique(mission_id,event_key)
);
create table public.run_results(
  id uuid primary key default gen_random_uuid(),mission_id uuid not null,run_id uuid not null unique,
  result jsonb not null,accepted boolean not null default false,created_at timestamptz not null default now(),
  foreign key(mission_id,run_id) references public.runs(mission_id,id)
);
create table public.ledger_events(
  revision bigint generated always as identity primary key,mission_id uuid not null references public.missions(id),
  source_table text not null,row_id text not null,created_at timestamptz not null default now()
);
do $$declare t text;begin
  foreach t in array array['command_requests','command_results','run_checkpoints','run_telemetry','notification_events','founder_preferences','operator_reviews','demand_pages','demand_signups','runtime_ticks','run_results','ledger_events'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('alter table public.%I force row level security',t);
    execute format('create policy tenant_scope on public.%I using(private.owns_mission(mission_id)) with check(private.owns_mission(mission_id))',t);
    execute format('create trigger immutable_row before update or delete on public.%I for each row execute function private.immutable_row()',t);
    execute format('grant select on public.%I to founder_role,lead_role,specialist_role,policy_role',t);
  end loop;
end$$;
grant insert on public.founder_preferences to founder_role;
grant insert on public.command_results,public.notification_events,public.run_checkpoints,public.run_telemetry to lead_role;
grant insert on public.run_checkpoints,public.run_telemetry to specialist_role;
grant insert on public.runtime_ticks to lead_role;
grant insert on public.run_results to specialist_role,lead_role;
-- Publication and sign-up ingestion use checked functions, never a browser grant.
create function public.submit_command(p_mission uuid,p_key text,p_kind text,p_payload jsonb) returns uuid
language plpgsql security definer set search_path='' as $$declare command uuid;existing public.command_requests;begin
  perform private.require_role(array['founder_role']);perform private.lock_mission(p_mission);
  perform private.assert_safe_content(p_payload);
  if length(p_key)<16 or length(p_key)>256 or jsonb_typeof(p_payload)<>'object' then raise exception 'validation: command input' using errcode='22023';end if;
  perform pg_advisory_xact_lock(hashtextextended(p_mission::text,0));
  select * into existing from public.command_requests where mission_id=p_mission and idempotency_key=p_key;
  if found then
    if existing.kind<>p_kind or existing.payload<>p_payload then raise exception 'invariant_violation: idempotency key reused with changed command';end if;
    return existing.id;
  end if;
  insert into public.command_requests(mission_id,idempotency_key,kind,payload,actor_id) values(p_mission,p_key,p_kind,p_payload,private.actor_id()) returning id into command;
  insert into public.outbox(mission_id,type,payload) values(p_mission,'founder.command',jsonb_build_object('commandId',command,'authUserId',private.actor_id()));
  return command;
end$$;
revoke all on function public.submit_command(uuid,text,text,jsonb) from public;
grant execute on function public.submit_command(uuid,text,text,jsonb) to founder_role;
create function public.complete_founder_command(p_mission uuid,p_command uuid,p_result jsonb) returns void
language plpgsql security definer set search_path='' as $$begin
  perform private.require_role(array['founder_role']);perform private.assert_mission(p_mission);perform private.assert_safe_content(p_result);
  if not exists(select from public.command_requests where id=p_command and mission_id=p_mission and actor_id=private.actor_id()) then raise exception 'invariant_violation: command owner mismatch';end if;
  insert into public.command_results(mission_id,command_id,status,result) values(p_mission,p_command,'completed',p_result);
end$$;
revoke all on function public.complete_founder_command(uuid,uuid,jsonb) from public;
grant execute on function public.complete_founder_command(uuid,uuid,jsonb) to founder_role;
create function public.claim_runtime_tick(p_mission uuid,p_key text,p_plan jsonb) returns text
language plpgsql security definer set search_path='' as $$declare inserted uuid;begin
  perform private.require_role(array['lead_role']);perform private.lock_mission(p_mission);perform private.assert_safe_content(p_plan);
  if (select status from public.mission_transitions where mission_id=p_mission order by created_at desc,id desc limit 1) in('paused','ended') then return 'paused';end if;
  insert into public.runtime_ticks(mission_id,event_key,plan) values(p_mission,p_key,p_plan) on conflict(mission_id,event_key) do nothing returning id into inserted;
  return case when inserted is null then 'replayed' else 'new' end;
end$$;
revoke all on function public.claim_runtime_tick(uuid,text,jsonb) from public;
grant execute on function public.claim_runtime_tick(uuid,text,jsonb) to lead_role;
create function private.record_ledger_revision() returns trigger language plpgsql security definer set search_path='' as $$begin
  insert into public.ledger_events(mission_id,source_table,row_id) values(new.mission_id,tg_table_name,new.id::text);
  return new;
end$$;
revoke all on function private.record_ledger_revision() from public;
do $$declare t record;begin
  for t in select c.table_name from information_schema.columns c join pg_tables p on p.schemaname=c.table_schema and p.tablename=c.table_name where c.table_schema='public' and c.column_name='mission_id' and c.table_name<>'ledger_events' loop
    execute format('create trigger ledger_revision after insert on public.%I for each row execute function private.record_ledger_revision()',t.table_name);
  end loop;
end$$;
-- Initial entries make pre-existing seed/application data visible to clients.
insert into public.ledger_events(mission_id,source_table,row_id) select id,'missions',id::text from public.missions;
commit;
