begin;
create table public.mission_brief_revisions(
 id uuid primary key default gen_random_uuid(),mission_id uuid not null references public.missions(id),decision_id uuid not null,artifact_version_id uuid not null,
 type text not null check(type in('discover','launch')),goal_brief text not null,currency text not null check(currency~'^[A-Z]{3}$'),metadata jsonb not null,
 created_at timestamptz not null default clock_timestamp(),unique(decision_id),
 foreign key(mission_id,decision_id)references public.decisions(mission_id,id),foreign key(mission_id,artifact_version_id)references public.artifact_versions(mission_id,id)
);
alter table public.mission_brief_revisions enable row level security;alter table public.mission_brief_revisions force row level security;
create policy mission_scope on public.mission_brief_revisions using(private.owns_mission(mission_id))with check(private.owns_mission(mission_id));
create trigger immutable_row before update or delete on public.mission_brief_revisions for each row execute function private.immutable_row();
create trigger ledger_revision after insert on public.mission_brief_revisions for each row execute function private.record_ledger_revision();
create trigger broadcast_ledger after insert on public.mission_brief_revisions for each row execute function private.broadcast_ledger();
grant select on public.mission_brief_revisions to founder_role,lead_role,specialist_role,policy_role,ingress_role,voice_role;
create view public.effective_missions with(security_invoker=true)as select m.id,m.founder_id,coalesce(r.type,m.type)type,coalesce(r.goal_brief,m.goal_brief)goal_brief,coalesce(r.currency,m.currency)currency,m.sandbox_mode,m.involvement,m.created_at,m.metadata||coalesce(r.metadata,'{}')metadata
 from public.missions m left join lateral(select *from public.mission_brief_revisions where mission_id=m.id order by created_at desc,id desc limit 1)r on true;
grant select on public.effective_missions to founder_role,lead_role,specialist_role,policy_role,ingress_role,voice_role;
create function public.apply_mission_brief(p_mission uuid,p_decision uuid,p_version uuid)returns uuid language plpgsql security definer set search_path=''as $$
declare b jsonb;d public.decisions;m record;previous public.mission_brief_revisions;revision uuid;begin
 perform private.require_role(array['founder_role','authenticated']);perform private.lock_mission(p_mission);
 select *into strict d from public.decisions where mission_id=p_mission and id=p_decision;
 select *into strict m from public.effective_missions where id=p_mission;
 select *into previous from public.mission_brief_revisions where mission_id=p_mission order by created_at desc,id desc limit 1;
 select content->'missionBrief' into strict b from public.artifact_versions where mission_id=p_mission and id=p_version and id in(select private.selected_approved_versions(p_mission,p_decision));
 if d.kind not in('goal','change')or d.gate<>'mission_brief' or b is null or not(b?&array['type','goalBrief','currency','metadata'])or b->>'type' not in('discover','launch')or length(coalesce(b->>'goalBrief',''))<1 or b->>'currency'!~'^[A-Z]{3}$' or jsonb_typeof(b->'metadata')<>'object' then raise exception 'needs_approval: complete explicit mission brief required';end if;
 if (m.type='launch' or previous.id is not null)and d.kind<>'change' then raise exception 'needs_approval: changing an established goal needs a reviewed Change';end if;
 if previous.id is not null and d.supersedes_id is distinct from previous.decision_id then raise exception 'needs_approval: change must supersede the active goal';end if;
 if b->>'currency'<>m.currency and(exists(select from public.money_ledger where mission_id=p_mission)or exists(select from public.payments where mission_id=p_mission)or exists(select from public.mandates where mission_id=p_mission)or exists(select from public.effect_authorizations where mission_id=p_mission and intent->>'effectClass'='spend'))then raise exception 'validation: mission currency cannot reinterpret existing financial authority or ledgers';end if;
 if (select status from public.artifact_statuses where artifact_version_id=p_version order by created_at desc,id desc limit 1)is distinct from 'approved' then raise exception 'needs_approval: mission brief version must be approved';end if;
 perform private.assert_safe_content(b);
 insert into public.mission_brief_revisions(mission_id,decision_id,artifact_version_id,type,goal_brief,currency,metadata)values(p_mission,p_decision,p_version,b->>'type',b->>'goalBrief',b->>'currency',b->'metadata')returning id into revision;
 insert into public.outbox(mission_id,type,payload)values(p_mission,'mission.brief_changed',jsonb_build_object('revisionId',revision,'decisionId',p_decision));return revision;
end$$;
revoke all on function public.apply_mission_brief(uuid,uuid,uuid)from public;
grant execute on function public.apply_mission_brief(uuid,uuid,uuid)to founder_role;
create or replace function public.mission_snapshot(p_mission uuid)returns jsonb language plpgsql stable security definer set search_path='' as $$declare v_result jsonb;v_table text;v_rows jsonb;begin
  perform private.require_role(array['founder_role','authenticated','lead_role','specialist_role','policy_role','ingress_role','voice_role']);perform private.assert_mission(p_mission);
  select jsonb_build_object('mission',to_jsonb(m),'status',coalesce((select status from public.mission_transitions where mission_id=p_mission order by created_at desc,id desc limit 1),'active'))into v_result from public.effective_missions m where m.id=p_mission;
  foreach v_table in array array['mission_brief_revisions','decisions','decision_resolutions','decision_supersessions','artifacts','artifact_versions','artifact_statuses','evidence','commitments','commitment_states','money_ledger','payments','payment_states','activity','threads','messages','runs','tasks','events','dependencies','stale_marks','mandates','mandate_revocations','focus_events','blockers']loop
    execute format('select coalesce(jsonb_agg(t),''[]''::jsonb)from public.%I t where mission_id=$1',v_table)into v_rows using p_mission;v_result:=v_result||jsonb_build_object(v_table,v_rows);
  end loop;
  select coalesce(jsonb_agg(r),'[]'::jsonb)into v_rows from public.readiness(p_mission)r;v_result:=v_result||jsonb_build_object('readiness',v_rows);
  return v_result;
end$$;
create or replace function public.reserve_effect(p_mission uuid,p_intent jsonb,p_token_hash text default null)returns jsonb language plpgsql security definer set search_path='' as $$
declare v_existing public.effect_authorizations;v_m public.missions;v_mandate public.mandates;v_approval public.approvals;v_hash text;v_binding jsonb;v_id uuid;v_amount bigint;v_used bigint;v_contacts bigint;v_always boolean;begin
  perform private.require_role(array['policy_role']);perform private.lock_mission(p_mission);perform private.active_mission(p_mission);perform private.assert_safe_content(p_intent);
  if not(p_intent?&array['missionId','taskId','action','effectClass','counterpartyId','idempotencyKey','mode','sandboxMode'])or p_intent->>'missionId'<>p_mission::text or length(p_intent->>'idempotencyKey')not between 16 and 256 or p_intent->>'effectClass'not in('communicate','spend','publish','bind')then raise exception 'validation: incomplete effect intent'using errcode='22023';end if;
  v_hash:=encode(public.digest(p_intent::text,'sha256'),'hex');
  select * into v_existing from public.effect_authorizations where mission_id=p_mission and idempotency_key=p_intent->>'idempotencyKey';
  if found then if v_existing.intent_hash<>v_hash then raise exception 'invariant_violation: idempotency intent mismatch';end if;return private.authorization_json(v_existing.id,true);end if;
  select * into strict v_m from public.effective_missions where id=p_mission;
  if (p_intent->>'sandboxMode')::boolean<>v_m.sandbox_mode then raise exception 'invariant_violation: environment mismatch';end if;
  if not exists(select from public.counterparties where id=(p_intent->>'counterpartyId')::uuid and founder_id=v_m.founder_id and not opt_out)then raise exception 'invariant_violation: counterparty denied';end if;
  if p_token_hash is null and p_intent->>'effectClass'='communicate'and(p_intent->>'mode'<>'do'or v_m.involvement<>'do')then raise exception 'needs_approval: guide or help mode requires founder approval';end if;
  v_amount:=coalesce((p_intent->>'amountMinor')::bigint,0);
  if v_amount<0 then raise exception 'validation: negative amount'using errcode='22023';end if;
  if p_intent->>'effectClass'='spend' then
    if not(p_intent?&array['amountMinor','currency','artifactVersionId','instrumentId'])or(v_amount=0 and not(v_m.sandbox_mode and p_intent->>'action'='store_test_order'))or p_intent->>'currency'<>v_m.currency then raise exception 'validation: spend requires positive amount mission currency artifact and instrument (sandbox store_test_order may be zero)'using errcode='22023';end if;
    if not exists(select from public.founder_accounts a where a.id=(p_intent->>'instrumentId')::uuid and a.founder_id=v_m.founder_id and a.status='connected' and not exists(select from public.account_revocations where account_id=a.id))then raise exception 'invariant_violation: instrument revoked or not founder owned';end if;
  end if;
  perform private.check_version(p_mission,(p_intent->>'artifactVersionId')::uuid);
  v_always:=p_intent->>'effectClass'in('publish','bind')or p_intent->>'action'=any(array['production_order','agreement','publish','legal_filing','mission_end','final_selection','material_terms','refund','payment_refund','store_publish','place_production_order','sign_agreement','submit_legal_filing','end_mission','place_order','accept_agreement','marketing_publish','registration','mission_pivot']);
  if p_token_hash is not null then
    select * into v_approval from public.approvals where mission_id=p_mission and token_hash=p_token_hash for update;
    v_binding:=jsonb_build_object('action',p_intent->>'action','counterpartyId',p_intent->>'counterpartyId','amountMinor',p_intent->'amountMinor','currency',p_intent->'currency','artifactVersionId',p_intent->'artifactVersionId');
    if v_approval.id is null or v_approval.expires_at<=clock_timestamp()or v_approval.binding<>v_binding or exists(select from public.approval_consumptions where approval_id=v_approval.id)or exists(select from public.approval_invalidations where approval_id=v_approval.id)or exists(select from public.decision_supersessions where previous_id=v_approval.decision_id)or exists(select from public.stale_marks where mission_id=p_mission and node_id=v_approval.decision_id)then raise exception 'needs_approval: invalid expired stale or consumed approval';end if;
  elsif v_always then raise exception 'needs_approval: action always requires approval';
  else
    select * into v_mandate from public.mandates where mission_id=p_mission and id=(p_intent->>'mandateId')::uuid for update;
    if v_mandate.id is null or v_mandate.expires_at<=clock_timestamp()or exists(select from public.mandate_revocations where mandate_id=v_mandate.id)or exists(select from public.decision_supersessions where previous_id=v_mandate.decision_id)or exists(select from public.stale_marks where mission_id=p_mission and node_id=v_mandate.decision_id)then raise exception 'needs_approval: no live mandate';end if;
    if not(v_mandate.scope->'actions'?(p_intent->>'action'))or not(v_mandate.scope->'effectClasses'?(p_intent->>'effectClass'))or not(v_mandate.scope->'counterpartyIds'?(p_intent->>'counterpartyId'))or(p_intent?'channel'and not(v_mandate.scope->'channels'?(p_intent->>'channel')))or(p_intent?'purpose'and not(v_mandate.scope->'purposes'?(p_intent->>'purpose')))or(p_intent?'instrumentId'and not(v_mandate.scope->'instrumentIds'?(p_intent->>'instrumentId')))then raise exception 'needs_approval: outside mandate scope';end if;
    if p_intent->>'effectClass'='spend'and(v_amount>v_mandate.ceiling_per or v_mandate.currency<>p_intent->>'currency')then raise exception 'needs_approval: per action ceiling exceeded';end if;
    select coalesce(sum(amount_minor),0),count(*)filter(where(intent->>'newContact')::boolean)into v_used,v_contacts from public.effect_authorizations where mandate_id=v_mandate.id;
    if v_used+v_amount>v_mandate.ceiling_total then raise exception 'needs_approval: total ceiling exceeded';end if;
    if coalesce((p_intent->>'newContact')::boolean,false)and v_contacts>=coalesce((v_mandate.scope->>'maxNewContacts')::integer,0)then raise exception 'needs_approval: contact ceiling exceeded';end if;
  end if;
  -- Approved budget envelopes are independent of payment authorization.
  if p_intent->>'effectClass'='spend'and exists(select from public.money_ledger where mission_id=p_mission and kind='envelope')and v_amount+(select coalesce(sum(amount_minor),0)from public.effect_authorizations where mission_id=p_mission)>(select sum(amount_minor)from public.money_ledger where mission_id=p_mission and kind='envelope')then raise exception 'needs_approval: budget envelope exceeded';end if;
  insert into public.effect_authorizations(mission_id,intent,intent_hash,idempotency_key,mandate_id,approval_id,amount_minor,sandbox_mode)values(p_mission,p_intent,v_hash,p_intent->>'idempotencyKey',v_mandate.id,v_approval.id,v_amount,v_m.sandbox_mode)returning id into v_id;
  if v_approval.id is not null then insert into public.approval_consumptions(mission_id,approval_id,authorization_id)values(p_mission,v_approval.id,v_id);end if;
  insert into public.effect_states(mission_id,authorization_id,status)values(p_mission,v_id,'reserved');
  perform private.audit(p_mission,'planned','Effect authorized and reserved',array[v_id]);return private.authorization_json(v_id,false);
end$$;
create or replace function public.grant_mandate(p_mission uuid,p_decision uuid,p_type text,p_scope jsonb,p_per bigint,p_total bigint,p_expires timestamptz)returns uuid language plpgsql security definer set search_path='' as $$declare v_id uuid;v_currency text;v_approved jsonb;v_count integer;v_key text;begin
  perform private.require_role(array['founder_role','authenticated']);perform private.lock_mission(p_mission);
  if not exists(select from public.decisions where mission_id=p_mission and id=p_decision and kind='mandate')then raise exception 'needs_approval: explicit mandate decision required';end if;
  if not exists(select from public.decision_resolutions where mission_id=p_mission and decision_id=p_decision and response in('approve','choose'))or exists(select from public.decision_supersessions where previous_id=p_decision)then raise exception 'needs_approval: mandate requires active approved decision';end if;
  if p_scope is null or jsonb_typeof(p_scope)<>'object' or not(p_scope?&array['actions','effectClasses','counterpartyIds','channels','purposes','instrumentIds','maxNewContacts'])or p_expires<=now()or p_per>p_total then raise exception 'validation: mandate scope incomplete'using errcode='22023';end if;
  select count(*),min((v.content->'mandate')::text)::jsonb into v_count,v_approved from public.artifact_versions v
    where v.mission_id=p_mission and v.id in(select private.selected_approved_versions(p_mission,p_decision))and v.content?'mandate'
    and (select s.status from public.artifact_statuses s where s.artifact_version_id=v.id order by s.created_at desc,s.id desc limit 1)='approved'
    and not exists(select from public.stale_marks where mission_id=p_mission and node_id=v.id);
  if v_count<>1 or coalesce(jsonb_typeof(v_approved),'')<>'object' or not(v_approved?&array['type','scope','currency','ceilingPer','ceilingTotal','expiresAt'])then raise exception 'needs_approval: mandate needs one selected approved scope version';end if;
  select currency into v_currency from public.effective_missions where id=p_mission;
  if v_approved->>'type'<>p_type or v_approved->>'currency'<>v_currency or p_per<0 or p_total<0
    or p_per>(v_approved->>'ceilingPer')::bigint or p_total>(v_approved->>'ceilingTotal')::bigint
    or p_expires>(v_approved->>'expiresAt')::timestamptz
    or (p_scope->>'maxNewContacts')::integer<0 or (p_scope->>'maxNewContacts')::integer>(v_approved->'scope'->>'maxNewContacts')::integer
    then raise exception 'needs_approval: mandate exceeds selected scope';end if;
  foreach v_key in array array['actions','effectClasses','counterpartyIds','channels','purposes','instrumentIds']loop
    if coalesce(jsonb_typeof(p_scope->v_key),'')<>'array' or coalesce(jsonb_typeof(v_approved->'scope'->v_key),'')<>'array' or not((p_scope->v_key) <@ ((v_approved->'scope')->v_key))then raise exception 'needs_approval: mandate scope widened';end if;
  end loop;
  insert into public.mandates(mission_id,decision_id,type,scope,ceiling_per,ceiling_total,currency,expires_at)values(p_mission,p_decision,p_type,p_scope,p_per,p_total,v_currency,p_expires)returning id into v_id;return v_id;
end$$;
commit;
