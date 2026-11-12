begin;
create table public.approved_effect_attempts(
 id uuid primary key default gen_random_uuid(),mission_id uuid not null references public.missions(id),command_id uuid not null,
 artifact_version_id uuid not null,status text not null check(status in('succeeded','blocked','retryable')),error_code text,
 created_at timestamptz not null default clock_timestamp(),retry_after timestamptz,
 foreign key(mission_id,command_id)references public.command_requests(mission_id,id),
 foreign key(mission_id,artifact_version_id)references public.artifact_versions(mission_id,id)
);
alter table public.approved_effect_attempts enable row level security;
alter table public.approved_effect_attempts force row level security;
create policy mission_scope on public.approved_effect_attempts using(private.owns_mission(mission_id))with check(private.owns_mission(mission_id));
create trigger immutable before update or delete on public.approved_effect_attempts for each row execute function private.immutable_row();
grant select on public.approved_effect_attempts to founder_role,lead_role,specialist_role,policy_role;
grant insert on public.approved_effect_attempts to policy_role;
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
  select currency into v_currency from public.missions where id=p_mission;
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

-- Every newly introduced ledger surface produces the same private ID-only invalidation.
-- Rows with no mission/id pair (including the revision ledger) are excluded.
do $$declare t record;begin
 for t in select tablename from pg_tables where schemaname='public' loop
  if exists(select from information_schema.columns where table_schema='public' and table_name=t.tablename and column_name='mission_id') and exists(select from information_schema.columns where table_schema='public' and table_name=t.tablename and column_name='id')then
   if not exists(select from pg_trigger where tgrelid=('public.'||t.tablename)::regclass and tgname='broadcast_ledger')then execute format('create trigger broadcast_ledger after insert on public.%I for each row execute function private.broadcast_ledger()',t.tablename);end if;
   if not exists(select from pg_trigger where tgrelid=('public.'||t.tablename)::regclass and tgname='ledger_revision')then execute format('create trigger ledger_revision after insert on public.%I for each row execute function private.record_ledger_revision()',t.tablename);end if;
  end if;
 end loop;
end$$;
create function private.selected_approved_versions(p_mission uuid,p_decision uuid)returns setof uuid language sql stable security definer set search_path=''as $$
 select distinct refs.value::uuid from public.decisions d
 join public.decision_resolutions r on r.decision_id=d.id and r.mission_id=d.mission_id and r.response in('approve','choose')
 cross join lateral jsonb_array_elements(d.packet->'options') o
 cross join lateral jsonb_array_elements_text(coalesce(o->'artifactVersionIds',case when jsonb_array_length(d.packet->'options')=1 then to_jsonb(d.approved_version_refs)else '[]'::jsonb end)) refs
 where d.mission_id=p_mission and d.id=p_decision and o->>'id'=r.option_id
 and private.owns_mission(p_mission) and not exists(select from public.decision_supersessions where previous_id=d.id)
 and not exists(select from public.stale_marks where mission_id=p_mission and node_id=d.id)
$$;
revoke all on function private.selected_approved_versions(uuid,uuid)from public;
create or replace function public.publish_demand_page(p_mission uuid,p_intent jsonb,p_token_hash text,p_version uuid,p_threshold uuid,p_slug text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_authorization jsonb;receipt jsonb;page uuid;content jsonb;begin
  perform private.require_role(array['policy_role']);perform private.lock_mission(p_mission);
  if p_intent->>'action'<>'marketing_publish' or p_intent->>'effectClass'<>'publish' or p_intent->>'artifactVersionId'<>p_version::text or p_slug!~'^[a-z0-9][a-z0-9-]{2,62}$' then raise exception 'validation: invalid publication intent';end if;
  if not exists(select from public.active_decisions d where d.mission_id=p_mission and d.id=p_threshold and d.outcome='demand' and d.gate='validation_threshold') then raise exception 'needs_approval: approve a go/no-go threshold before starting validation';end if;
  if (select count(*) from public.decisions d join public.artifact_versions v on v.id in(select private.selected_approved_versions(d.mission_id,d.id)) and v.mission_id=d.mission_id where d.id=p_threshold and v.content->'threshold'->>'metric'='distinct_consented_signups' and (v.content->'threshold'->>'target')::integer>0 and (v.content->'threshold'->>'endsAt')::timestamptz>clock_timestamp())<>1 then raise exception 'validation: threshold needs one frozen numeric target and future deadline';end if;
  select v.content into strict content from public.artifact_versions v where v.mission_id=p_mission and v.id=p_version and not exists(select from public.artifact_versions n where n.artifact_id=v.artifact_id and n.version_no>v.version_no);
  if (select status from public.artifact_statuses where mission_id=p_mission and artifact_version_id=p_version order by created_at desc,id desc limit 1)<>'approved' then raise exception 'needs_approval: page version must be approved';end if;
  if not(content?&array['title','description','consentText']) then raise exception 'validation: page needs title, description and consent text';end if;
  v_authorization:=public.reserve_effect(p_mission,p_intent,p_token_hash);
  if (v_authorization->>'replay')::boolean then
    select id into page from public.demand_pages where mission_id=p_mission and publication_receipt_id=(v_authorization->>'receiptId')::uuid;
    if page is null then raise exception 'invariant_violation: unresolved publication';end if;
    return jsonb_build_object('pageId',page,'replay',true);
  end if;
  perform public.begin_effect(p_mission,(v_authorization->>'authorizationId')::uuid);
  page:=gen_random_uuid();
  -- This is an internal publication: the receipt and visible page commit in the
  -- same transaction. A rollback leaves neither a receipt nor a public surface.
  receipt:=public.complete_effect(p_mission,(v_authorization->>'authorizationId')::uuid,jsonb_build_object('provider','launch-operator-demand','providerReference',page::text,'operation','marketing_publish','sandboxMode',(p_intent->>'sandboxMode')::boolean,'data',jsonb_build_object('slug',p_slug,'pageId',page,'artifactVersionId',p_version,'verifiedKind','first_customer_channel','verifiedOutcome','demand')));
  insert into public.demand_pages(id,mission_id,slug,artifact_version_id,threshold_decision_id,publication_receipt_id,content,sandbox_mode) values(page,p_mission,p_slug,p_version,p_threshold,(receipt->>'receiptId')::uuid,content,(p_intent->>'sandboxMode')::boolean);
  return jsonb_build_object('pageId',page,'slug',p_slug,'receiptId',receipt->>'receiptId','replay',false);
end$$;
create or replace function public.measure_demand(p_mission uuid,p_page uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare page public.demand_pages;threshold jsonb;target integer;deadline timestamptz;signups integer;measurement text;fact uuid;v_kind text;begin
  perform private.require_role(array['policy_role']);perform private.lock_mission(p_mission);
  select * into strict page from public.demand_pages where mission_id=p_mission and id=p_page;
  select v.content->'threshold' into strict threshold from public.decisions d join public.decision_resolutions r on r.decision_id=d.id join public.artifact_versions v on v.id in(select private.selected_approved_versions(d.mission_id,d.id)) and v.mission_id=d.mission_id where d.id=page.threshold_decision_id and d.mission_id=p_mission and v.content?'threshold' and r.response in('approve','choose');
  if threshold->>'metric'<>'distinct_consented_signups' then raise exception 'validation: unsupported validation metric';end if;
  target:=(threshold->>'target')::integer;deadline:=(threshold->>'endsAt')::timestamptz;
  if target<1 or deadline is null then raise exception 'validation: positive threshold and deadline required';end if;
  if exists(select from public.stale_marks where mission_id=p_mission and node_id in(page.threshold_decision_id,page.artifact_version_id)) then raise exception 'invariant_violation: validation setup is stale';end if;
  select count(*)::integer into signups from public.demand_signups where mission_id=p_mission and page_id=p_page and consent_at<=deadline;
  measurement:='internal:demand:'||p_page::text||':'||signups::text;
  if signups>=target then
    foreach v_kind in array array['external_verification','validation_result'] loop
      if not exists(select from public.evidence e where e.mission_id=p_mission and e.kind=v_kind and source_reference=measurement) then
        -- This function verifies a first-party database measurement. It does not
        -- accept model-supplied counts, fabricate a provider receipt, or assert
        -- ownership of the submitted emails or purchase intent.
        insert into public.evidence(mission_id,outcome,kind,trust,payload,source_type,source_reference,sandbox_mode,actor_id)
        values(p_mission,'demand',v_kind,'verified',jsonb_build_object('pageId',p_page,'metric','distinct_consented_signups','count',signups,'threshold',target,'thresholdDecisionId',page.threshold_decision_id,'emailOwnershipVerified',false,'method','first-party immutable signup count'),'poll',measurement,page.sandbox_mode,private.actor_id()) returning id into fact;
        insert into public.dependencies(mission_id,upstream_id,dependent_id,reason) values(p_mission,page.threshold_decision_id,fact,'validation threshold'),(p_mission,page.artifact_version_id,fact,'published validation page');
      end if;
    end loop;
  end if;
  if not exists(select from public.evidence where mission_id=p_mission and kind='first_customer_channel' and provider_receipt_id=page.publication_receipt_id) then
    perform public.append_evidence(p_mission,'demand','first_customer_channel','verified',jsonb_build_object('pageId',p_page,'slug',page.slug),'receipt',page.publication_receipt_id::text,page.publication_receipt_id);
  end if;
  return jsonb_build_object('pageId',p_page,'count',signups,'target',target,'met',signups>=target,'deadline',deadline,'sandboxMode',page.sandbox_mode,'emailOwnershipVerified',false);
end$$;
create function public.confirm_founder_artifact(p_mission uuid,p_decision uuid,p_version uuid)returns uuid language plpgsql security definer set search_path=''as $$
declare c jsonb;d public.decisions;fact uuid;existing uuid;k text;begin
 perform private.require_role(array['founder_role','authenticated']);perform private.lock_mission(p_mission);
 select * into strict d from public.decisions where mission_id=p_mission and id=p_decision;
 select content->'founderConfirmation' into strict c from public.artifact_versions where mission_id=p_mission and id=p_version and id in(select private.selected_approved_versions(p_mission,p_decision));
 if d.kind<>'engagement' or c is null or d.gate is distinct from c->>'kind' or d.outcome is distinct from c->>'outcome' or length(coalesce(c->>'statement',''))<1 then raise exception 'needs_approval: explicit founder confirmation required';end if;
 if not ((c->>'outcome'='brand'and c->>'kind' in('name_approved','identity_approved','guidelines_approved'))or(c->>'outcome'='product'and c->>'kind' in('physical_sample_approved','manufacturing_brief_sample_match'))or(c->>'outcome'='compliance'and c->>'kind' in('requirements_complete','requirements_resolved'))or(c->>'outcome'='demand'and c->>'kind' in('validation_result','launch_week_plan','launch_content_approved'))or(c->>'outcome'='supply'and c->>'kind' in('proforma_invoice','inspection_plan','sourcing_risk_accepted')))then raise exception 'validation: unsupported founder confirmation';end if;
 if c->>'kind' in('validation_result','sourcing_risk_accepted') and coalesce((c->'payload'->>'riskAccepted')::boolean,false)<>true then raise exception 'validation: unmeasured validation or sourcing exception needs explicit risk acceptance';end if;
 if (select status from public.artifact_statuses where artifact_version_id=p_version order by created_at desc,id desc limit 1)is distinct from 'approved' or exists(select from public.stale_marks where mission_id=p_mission and node_id=p_version)then raise exception 'needs_approval: confirmation version is not current and approved';end if;
 select id into existing from public.evidence where mission_id=p_mission and source_reference='founder-confirmation:'||p_decision::text||':'||p_version::text and kind=c->>'kind';if existing is not null then return existing;end if;
 foreach k in array case when c->>'kind' in('physical_sample_approved','requirements_resolved','validation_result')then array[c->>'kind','external_verification']else array[c->>'kind']end loop
  fact:=public.append_evidence(p_mission,c->>'outcome',k,'founder_confirmed',coalesce(c->'payload','{}')||jsonb_build_object('statement',c->>'statement','decisionId',p_decision,'artifactVersionId',p_version,'confirmedAt',clock_timestamp()),'document','founder-confirmation:'||p_decision::text||':'||p_version::text);
  insert into public.dependencies(mission_id,upstream_id,dependent_id,reason)values(p_mission,p_decision,fact,'explicit founder confirmation'),(p_mission,p_version,fact,'confirmed immutable source');
 end loop;
 return fact;
end$$;
revoke all on function public.confirm_founder_artifact(uuid,uuid,uuid)from public;
grant execute on function public.confirm_founder_artifact(uuid,uuid,uuid)to founder_role;
create or replace function public.transition_mission(p_mission uuid,p_status text,p_terminal uuid default null,p_closing uuid default null)returns uuid language plpgsql security definer set search_path='' as $$declare v_id uuid;v_terminal text;begin perform private.require_role(array['founder_role','authenticated']);perform private.lock_mission(p_mission);
  if p_status='ended' and(not exists(select from public.decisions d join public.decision_resolutions r on r.decision_id=d.id where d.id=p_terminal and d.mission_id=p_mission and d.kind='terminal' and r.response in('approve','choose'))or not exists(select from public.artifact_versions where id=p_closing and mission_id=p_mission))then raise exception 'needs_approval: end requires terminal decision and closing record';end if;
  if p_status='ended' then
    select r.option_id into strict v_terminal from public.decision_resolutions r where r.mission_id=p_mission and r.decision_id=p_terminal and r.response in('approve','choose');
    if v_terminal not in('launch','stop','infeasible')or not exists(select from public.artifact_versions v where v.mission_id=p_mission and v.id=p_closing and v.id in(select private.selected_approved_versions(p_mission,p_terminal))and v.content->'closingRecord'->>'terminal'=v_terminal and length(v.content->'closingRecord'->>'summary')>0 and (select status from public.artifact_statuses where artifact_version_id=v.id order by created_at desc,id desc limit 1)='approved')then raise exception 'needs_approval: terminal closing record mismatch';end if;
    if v_terminal='launch' and (select count(*)from public.readiness(p_mission)where level=5)<>6 then raise exception 'needs_approval: launch requires all six outcomes at R5';end if;
  end if;
  if exists(select from public.mission_transitions where mission_id=p_mission and status='ended')then raise exception 'invariant_violation: ended mission cannot resume';end if;
  insert into public.mission_transitions(mission_id,status,terminal_decision_id,closing_record_version_id,actor_id)values(p_mission,p_status,p_terminal,p_closing,private.actor_id())returning id into v_id;
  insert into public.outbox(mission_id,type,payload)values(p_mission,'mission.'||p_status,jsonb_build_object('transitionId',v_id));return v_id;end$$;
commit;
