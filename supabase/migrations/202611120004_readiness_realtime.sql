begin;
alter table public.missions add column metadata jsonb not null default '{}';
drop policy tenant_scope on public.missions;
create policy tenant_scope on public.missions using(private.owns_founder(founder_id)and(private.caller_role()in('founder_role','authenticated')or id::text=nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'mission_id'))with check(private.owns_founder(founder_id)and(private.caller_role()in('founder_role','authenticated')or id::text=nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'mission_id'));
alter table public.readiness_rules add column performed_kinds text[] not null default '{}';
insert into public.readiness_rules(id,version,outcome,level,evidence_kinds,decision_gates,high_trust,review_status,performed_kinds)
select outcome||':'||level,1,outcome,level,
case level when 1 then array['research'] when 2 then array['research']when 3 then array['specification']when 4 then array['external_verification']else case outcome
when 'brand' then array['name_availability','founder_owned_domain','identity_assets_delivered']
when 'product'then array['physical_sample_approved','manufacturing_brief_sample_match']
when 'supply'then array['supplier_verified','accepted_terms','production_or_fulfilment','delivery_shipping','qa_agreed']
when 'commerce'then array['domain_live','store_published','checkout_test_refunded','shipping_configured','returns_support']
when 'compliance'then array['requirements_complete','requirements_resolved']
else array['validation_result','first_customer_channel']end end,
case level when 1 then '{}'::text[] when 2 then array['direction']else array['specification']end,level>=4,'reviewed',
case when level=5 then array['founder_owned_domain','identity_assets_delivered','production_or_fulfilment','domain_live','store_published','shipping_configured']else '{}'::text[]end
from unnest(array['brand','product','supply','commerce','compliance','demand'])outcome cross join generate_series(1,5)level;
create view public.active_decisions with(security_invoker=true)as select d.* from public.decisions d where exists(select from public.decision_resolutions r where r.decision_id=d.id and r.response in('approve','choose'))and not exists(select from public.decision_supersessions s where s.previous_id=d.id)and not exists(select from public.stale_marks s where s.mission_id=d.mission_id and s.node_id=d.id);
create view public.current_artifact_versions with(security_invoker=true)as select v.* from public.artifact_versions v where not exists(select from public.artifact_versions n where n.artifact_id=v.artifact_id and n.version_no>v.version_no);
create function public.readiness(p_mission uuid)returns table(outcome text,level integer,missing text[],evidence_ids uuid[],decision_ids uuid[],stale boolean)language plpgsql stable security definer set search_path='' as $$
declare v_outcome text;v_rule public.readiness_rules;v_missing text[];v_evidence uuid[];v_decisions uuid[];begin
  perform private.assert_mission(p_mission);
  foreach v_outcome in array array['brand','product','supply','commerce','compliance','demand']loop
    outcome:=v_outcome;level:=0;missing:='{}';evidence_ids:='{}';decision_ids:='{}';
    stale:=exists(select from public.state_nodes n join public.stale_marks s on s.node_id=n.id where n.mission_id=p_mission and(n.id in(select e.id from public.evidence e where e.outcome=v_outcome)or n.id in(select d.id from public.decisions d where d.outcome=v_outcome)));
    for v_rule in select * from public.readiness_rules r where r.outcome=v_outcome and r.version=1 order by r.level loop
      select coalesce(array_agg(required),'{}')into v_missing from unnest(v_rule.evidence_kinds)required where not exists(
        select from public.evidence e where e.mission_id=p_mission and e.outcome=v_outcome and e.kind=required and(not v_rule.high_trust or e.trust in('verified','founder_confirmed')or(e.trust='performed'and e.kind=any(v_rule.performed_kinds)))and not exists(select from public.evidence newer where newer.supersedes_id=e.id)and not exists(select from public.stale_marks s where s.node_id=e.id));
      select v_missing||coalesce(array_agg('decision:'||required),'{}')into v_missing from unnest(v_rule.decision_gates)required where not exists(select from public.active_decisions d where d.mission_id=p_mission and d.outcome=v_outcome and d.gate=required);
      if cardinality(v_missing)>0 then missing:=v_missing;exit;end if;
      level:=v_rule.level;
      select coalesce(array_agg(e.id),'{}')into v_evidence from public.evidence e where e.mission_id=p_mission and e.outcome=v_outcome and e.kind=any(v_rule.evidence_kinds)and(not v_rule.high_trust or e.trust in('verified','founder_confirmed')or(e.trust='performed'and e.kind=any(v_rule.performed_kinds)))and not exists(select from public.stale_marks s where s.node_id=e.id)and not exists(select from public.evidence newer where newer.supersedes_id=e.id);
      select coalesce(array_agg(d.id),'{}')into v_decisions from public.active_decisions d where d.mission_id=p_mission and d.outcome=v_outcome and d.gate=any(v_rule.decision_gates);
      evidence_ids:=evidence_ids||v_evidence;decision_ids:=decision_ids||v_decisions;
    end loop;return next;
  end loop;
end$$;
create function public.active_blockers(p_mission uuid)returns setof public.blockers language plpgsql stable security definer set search_path='' as $$begin perform private.assert_mission(p_mission);return query select b.*from public.blockers b join public.readiness(p_mission)r on r.outcome=b.blocking_outcome where b.mission_id=p_mission and r.level<b.required_level;end$$;
create view public.money_totals with(security_invoker=true)as select mission_id,currency,sandbox_mode,coalesce(sum(amount_minor)filter(where kind='spent'),0)as spent_minor,coalesce(sum(amount_minor)filter(where kind='refund'),0)as refund_minor,coalesce(sum(amount_minor)filter(where kind='forecast'),0)as forecast_minor,coalesce(sum(amount_minor)filter(where kind='committed'and not exists(select from public.money_ledger paid where paid.mission_id=money_ledger.mission_id and paid.ref_id=money_ledger.ref_id and paid.kind='spent')),0)as committed_minor from public.money_ledger group by mission_id,currency,sandbox_mode;
create function public.mission_snapshot(p_mission uuid)returns jsonb language plpgsql stable security definer set search_path='' as $$declare v_result jsonb;v_table text;v_rows jsonb;begin
  perform private.require_role(array['founder_role','authenticated','lead_role','specialist_role','policy_role','ingress_role','voice_role']);perform private.assert_mission(p_mission);
  select jsonb_build_object('mission',to_jsonb(m),'status',coalesce((select status from public.mission_transitions where mission_id=p_mission order by created_at desc,id desc limit 1),'active'))into v_result from public.missions m where m.id=p_mission;
  foreach v_table in array array['decisions','decision_resolutions','decision_supersessions','artifacts','artifact_versions','artifact_statuses','evidence','commitments','commitment_states','money_ledger','payments','payment_states','activity','threads','messages','runs','tasks','events','dependencies','stale_marks','mandates','mandate_revocations','focus_events','blockers']loop
    execute format('select coalesce(jsonb_agg(t),''[]''::jsonb)from public.%I t where mission_id=$1',v_table)into v_rows using p_mission;v_result:=v_result||jsonb_build_object(v_table,v_rows);
  end loop;
  select coalesce(jsonb_agg(r),'[]'::jsonb)into v_rows from public.readiness(p_mission)r;v_result:=v_result||jsonb_build_object('readiness',v_rows);
  return v_result;
end$$;
create function public.create_mission(p_founder uuid,p_type text,p_goal text,p_currency text,p_sandbox boolean,p_metadata jsonb default '{}')returns uuid language plpgsql security definer set search_path='' as $$declare v_id uuid;begin perform private.require_role(array['founder_role','authenticated']);if not private.owns_founder(p_founder)then raise exception 'invariant_violation: mission founder denied';end if;perform private.assert_safe_content(p_metadata);insert into public.missions(founder_id,type,goal_brief,currency,sandbox_mode,metadata)values(p_founder,p_type,p_goal,p_currency,p_sandbox,p_metadata)returning id into v_id;return v_id;end$$;
create function public.append_founder_message(p_mission uuid,p_thread uuid,p_text text)returns uuid language plpgsql security definer set search_path='' as $$declare v_id uuid;begin perform private.require_role(array['founder_role','authenticated']);perform private.lock_mission(p_mission);perform private.assert_safe_content(jsonb_build_object('body',p_text));insert into public.messages(mission_id,thread_id,channel,direction,original)values(p_mission,p_thread,'app','founder',p_text)returning id into v_id;insert into public.outbox(mission_id,type,payload)values(p_mission,'founder.message',jsonb_build_object('messageId',v_id));return v_id;end$$;
create function public.append_lead_message(p_mission uuid,p_thread uuid,p_text text)returns uuid language plpgsql security definer set search_path='' as $$declare v_id uuid;begin perform private.require_role(array['lead_role']);perform private.lock_mission(p_mission);insert into public.messages(mission_id,thread_id,channel,direction,original)values(p_mission,p_thread,'app','lead',p_text)returning id into v_id;return v_id;end$$;
-- Validate founder-owned foreign references absent from composite mission keys.
create function private.tenant_reference_guard()returns trigger language plpgsql security definer set search_path='' as $$declare v_party uuid;v_founder uuid;begin
  v_party:=(to_jsonb(new)->>case tg_table_name when 'threads'then 'counterparty_id' else 'party_id' end)::uuid;
  select founder_id into strict v_founder from public.missions where id=new.mission_id;
  if v_party is not null and not exists(select from public.counterparties where id=v_party and founder_id=v_founder)then raise exception 'invariant_violation: cross tenant party reference';end if;return new;
end$$;
create trigger tenant_reference_guard before insert on public.threads for each row execute function private.tenant_reference_guard();
create trigger tenant_reference_guard before insert on public.commitments for each row execute function private.tenant_reference_guard();
create function public.can_join_mission(p_topic text)returns boolean language plpgsql stable security definer set search_path='' as $$declare v_id uuid;begin if p_topic!~'^mission:[0-9a-f-]{36}$'then return false;end if;v_id:=substring(p_topic from 9)::uuid;return private.owns_mission(v_id);exception when invalid_text_representation then return false;end$$;
create function private.broadcast_ledger()returns trigger language plpgsql security definer set search_path='' as $$begin
  -- Durable outbox is authoritative; payload contains only ids, never row content.
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)')is not null then
    perform realtime.send(jsonb_build_object('table',tg_table_name,'id',new.id,'missionId',new.mission_id),'ledger.changed','mission:'||new.mission_id::text,true);
  end if;return new;
end$$;
do $$declare t text;begin foreach t in array array['decisions','decision_resolutions','decision_supersessions','artifact_versions','artifact_statuses','evidence','commitment_states','money_ledger','payment_states','activity','messages','stale_marks','mission_transitions']loop execute format('create trigger broadcast_ledger after insert on public.%I for each row execute function private.broadcast_ledger()',t);end loop;end$$;
-- Supabase-owned schemas exist on Supabase. Native database tests install explicit
-- test-only shims before applying this migration and exercise these exact policies.
do $$begin
  if to_regclass('realtime.messages')is not null then
    execute 'create policy lo_private_mission on realtime.messages for select to founder_role using(public.can_join_mission(topic) and extension=''broadcast'')';
  end if;
  if to_regclass('storage.buckets')is not null then
    insert into storage.buckets(id,name,public)values('mission-files','mission-files',false)on conflict(id)do nothing;
    execute 'create policy lo_mission_files_read on storage.objects for select to founder_role using(bucket_id=''mission-files'' and public.can_join_mission(''mission:''||split_part(name,''/'',1)))';
    execute 'create policy lo_mission_files_write on storage.objects for insert to founder_role,specialist_role,policy_role with check(bucket_id=''mission-files'' and public.can_join_mission(''mission:''||split_part(name,''/'',1)))';
  end if;
end$$;
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema private from public;
grant execute on function public.readiness(uuid),public.active_blockers(uuid),public.mission_snapshot(uuid),public.can_join_mission(text)to founder_role,lead_role,specialist_role,policy_role,ingress_role,voice_role;
grant select on public.active_decisions,public.current_artifact_versions,public.money_totals to founder_role,lead_role,specialist_role,policy_role,voice_role;
grant execute on function public.create_mission(uuid,text,text,text,boolean,jsonb),public.append_founder_message(uuid,uuid,text)to founder_role;
grant execute on function public.append_lead_message(uuid,uuid,text)to lead_role;
-- Supabase authenticated requests resolve as founder only; scoped runtime roles are
-- granted to the trusted authenticator, never to authenticated or anon.
do $$begin if exists(select from pg_roles where rolname='authenticated')then
  grant founder_role to authenticated;
  grant usage on schema private to authenticated;
end if;
if exists(select from pg_roles where rolname='authenticator')then grant founder_role,lead_role,specialist_role,policy_role,ingress_role,voice_role to authenticator;end if;end$$;
-- Statement timestamps are unsuitable for several states in one transaction.
do $$declare t record;begin for t in select table_name,column_name from information_schema.columns where table_schema='public'and column_name in('created_at','received_at')loop execute format('alter table public.%I alter column %I set default clock_timestamp()',t.table_name,t.column_name);end loop;end$$;
commit;
