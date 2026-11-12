begin;
create table public.optional_step_choices(
 id uuid primary key default gen_random_uuid(),mission_id uuid not null references public.missions(id),
 playbook_id text not null,playbook_version integer not null,step_id text not null,choice text not null check(choice in('do','skip')),
 decision_id uuid not null,artifact_version_id uuid not null,evidence_ids uuid[]not null,created_at timestamptz not null default clock_timestamp(),
 foreign key(playbook_id,playbook_version)references public.playbooks(id,version),
 foreign key(mission_id,decision_id)references public.decisions(mission_id,id),
 foreign key(mission_id,artifact_version_id)references public.artifact_versions(mission_id,id),unique(decision_id));
alter table public.optional_step_choices enable row level security;alter table public.optional_step_choices force row level security;
create policy mission_scope on public.optional_step_choices using(private.owns_mission(mission_id))with check(private.owns_mission(mission_id));
create trigger immutable_row before update or delete on public.optional_step_choices for each row execute function private.immutable_row();
create trigger ledger_revision after insert on public.optional_step_choices for each row execute function private.record_ledger_revision();
create trigger broadcast_ledger after insert on public.optional_step_choices for each row execute function private.broadcast_ledger();
grant select on public.optional_step_choices to founder_role,lead_role,specialist_role,policy_role;
create function private.optional_step(p_playbook text,p_version integer,p_step text)returns boolean language sql stable security definer set search_path=''as $$
 select exists(select from public.playbooks b cross join lateral jsonb_array_elements(b.content->'steps')s where b.id=p_playbook and b.version=p_version and s->>'id'=p_step and s->'optional'='true'::jsonb)
$$;
create function private.check_optional_step_offer(p_mission uuid,p_value jsonb)returns void language plpgsql stable security definer set search_path=''as $$
declare prior public.optional_step_choices;refs uuid[];begin
 if jsonb_typeof(p_value)is distinct from'object'or not(p_value?&array['playbookId','playbookVersion','stepId','choice','cost','risk','evidenceIds'])
 or p_value->>'choice'not in('do','skip')or length(coalesce(p_value->>'risk',''))=0
 or jsonb_typeof(p_value->'cost'->'amountMinor')is distinct from'number'
 or(p_value->'cost'->>'amountMinor')!~'^[0-9]{1,15}$'
 or p_value->'cost'->>'currency'is distinct from(select currency from public.missions where id=p_mission)
 or jsonb_typeof(p_value->'evidenceIds')is distinct from'array'
 or not private.optional_step(p_value->>'playbookId',(p_value->>'playbookVersion')::integer,p_value->>'stepId')then raise exception 'validation: current optional playbook step, explicit cost and risk required';end if;
 select coalesce(array_agg(distinct value::uuid order by value::uuid),'{}')into refs from jsonb_array_elements_text(p_value->'evidenceIds');
 if exists(select from unnest(refs)r where not exists(select from public.evidence e where e.mission_id=p_mission and e.id=r and not exists(select from public.stale_marks where node_id=e.id)and not exists(select from public.evidence n where n.supersedes_id=e.id)))then raise exception 'validation: optional step source missing stale or cross-tenant';end if;
 select *into prior from public.optional_step_choices where mission_id=p_mission and playbook_id=p_value->>'playbookId'and step_id=p_value->>'stepId'order by created_at desc,id desc limit 1;
 if prior.choice='skip'and refs<@prior.evidence_ids and not exists(select from public.founder_preferences p where p.mission_id=p_mission and p.kind='change_request'and p.value->>'decisionId'=prior.decision_id::text and p.created_at>prior.created_at)and not exists(select from unnest(prior.evidence_ids)r where exists(select from public.stale_marks where node_id=r)or exists(select from public.evidence where supersedes_id=r))then raise exception 'rejected: optional step was skipped; new evidence is required before proposing it again';end if;
end$$;
create function private.optional_artifact_guard()returns trigger language plpgsql security definer set search_path=''as $$begin
 if new.content?'optionalStep'then perform private.check_optional_step_offer(new.mission_id,new.content->'optionalStep');end if;return new;
end$$;
create trigger optional_step_guard before insert on public.artifact_versions for each row execute function private.optional_artifact_guard();
create function private.optional_decision_guard()returns trigger language plpgsql security definer set search_path=''as $$declare v public.artifact_versions;ref text;has_optional boolean:=false;do_value jsonb;skip_value jsonb;do_cost jsonb;skip_cost jsonb;begin
 for ref in select distinct value from(
 select jsonb_array_elements_text(coalesce(new.packet->'approvedVersionIds','[]'))value
 union all select jsonb_array_elements_text(coalesce(o->'artifactVersionIds','[]'))from jsonb_array_elements(new.packet->'options')o)refs loop
 select *into v from public.artifact_versions where mission_id=new.mission_id and id=ref::uuid;
 if v.content?'optionalStep'then
 has_optional:=true;
 if new.kind not in('selection','change')or new.gate is distinct from'optional_step'then raise exception 'validation: optional step requires an explicit choice packet';end if;
 perform private.check_optional_step_offer(new.mission_id,v.content->'optionalStep');end if;end loop;
 if has_optional then
 if jsonb_array_length(new.packet->'options')<>2 then raise exception 'validation: optional step requires both Do and Skip';end if;
 select av.content->'optionalStep',o->'cost'into do_value,do_cost from jsonb_array_elements(new.packet->'options')o
 join public.artifact_versions av on av.mission_id=new.mission_id and av.id::text=o->'artifactVersionIds'->>0
 where jsonb_array_length(o->'artifactVersionIds')=1 and av.content#>>'{optionalStep,choice}'='do';
 select av.content->'optionalStep',o->'cost'into skip_value,skip_cost from jsonb_array_elements(new.packet->'options')o
 join public.artifact_versions av on av.mission_id=new.mission_id and av.id::text=o->'artifactVersionIds'->>0
 where jsonb_array_length(o->'artifactVersionIds')=1 and av.content#>>'{optionalStep,choice}'='skip';
 if do_value is null or skip_value is null or(do_value-'choice')is distinct from(skip_value-'choice')or do_cost is distinct from do_value->'cost'or(skip_cost is not null and skip_cost<>'null'::jsonb)then raise exception 'validation: matched Do/Skip options with exact cost required';end if;
 end if;return new;
end$$;
create trigger optional_step_guard before insert on public.decisions for each row execute function private.optional_decision_guard();
create function public.apply_optional_step_choice(p_mission uuid,p_decision uuid,p_version uuid)returns uuid language plpgsql security definer set search_path=''as $$
declare step_config jsonb;refs uuid[];chosen uuid;d public.decisions;begin
 perform private.require_role(array['founder_role']);perform private.lock_mission(p_mission);
 select id into chosen from public.optional_step_choices where mission_id=p_mission and decision_id=p_decision;if chosen is not null then return chosen;end if;
 select *into strict d from public.active_decisions where mission_id=p_mission and id=p_decision and gate='optional_step';
 if not exists(select from public.decision_resolutions r cross join lateral jsonb_array_elements(d.packet->'options')o where r.mission_id=p_mission and r.decision_id=d.id and r.resolution_source='founder'and r.response in('approve','choose')and o->>'id'=r.option_id and coalesce(o->'artifactVersionIds',case when jsonb_array_length(d.packet->'options')=1 then d.packet->'approvedVersionIds'else'[]'::jsonb end)?p_version::text)then raise exception 'needs_approval: selected explicit optional choice required';end if;
 select content->'optionalStep'into strict step_config from public.artifact_versions where mission_id=p_mission and id=p_version;
 perform private.check_optional_step_offer(p_mission,step_config);perform private.check_version(p_mission,p_version);
 select coalesce(array_agg(distinct value::uuid order by value::uuid),'{}')into refs from jsonb_array_elements_text(step_config->'evidenceIds');
 insert into public.optional_step_choices(mission_id,playbook_id,playbook_version,step_id,choice,decision_id,artifact_version_id,evidence_ids)
 values(p_mission,step_config->>'playbookId',(step_config->>'playbookVersion')::integer,step_config->>'stepId',step_config->>'choice',p_decision,p_version,refs)returning id into chosen;
 return chosen;
end$$;
create function private.optional_run_guard()returns trigger language plpgsql security definer set search_path=''as $$
declare selection public.optional_step_choices;begin
 if private.optional_step(new.brief#>>'{playbook,id}',(new.brief#>>'{playbook,version}')::integer,new.brief#>>'{playbook,step}')then
 select *into selection from public.optional_step_choices where mission_id=new.mission_id and playbook_id=new.brief#>>'{playbook,id}'and step_id=new.brief#>>'{playbook,step}'order by created_at desc,id desc limit 1;
 if selection.choice is distinct from'do'or selection.playbook_version<>(new.brief#>>'{playbook,version}')::integer or not private.readiness_current_approved(new.mission_id,selection.artifact_version_id)then raise exception 'needs_approval: optional work requires a current explicit Do choice';end if;end if;return new;
end$$;
create trigger optional_step_guard before insert on public.runs for each row execute function private.optional_run_guard();
revoke all on function private.optional_step(text,integer,text),private.check_optional_step_offer(uuid,jsonb),private.optional_artifact_guard(),private.optional_decision_guard(),private.optional_run_guard(),public.apply_optional_step_choice(uuid,uuid,uuid)from public;
grant execute on function public.apply_optional_step_choice(uuid,uuid,uuid)to founder_role;
-- Optional data is explicit and never weakens an outcome readiness requirement.
insert into public.playbooks(id,version,content,review_status,sources)values('demand-validation',1,'{"steps":[{"id":"landing_page","instruction":"Offer a measured landing-page experiment with explicit cost, risk and Skip. Skipping this experiment does not certify demand or waive launch evidence.","source":"https://www.shopify.com/blog/validate-product-ideas","optional":true}],"reviewRequired":true,"reviewNote":"Implementation of FR-EASE-11; domain review remains pending."}','unverified',array['https://www.shopify.com/blog/validate-product-ideas','docs/01-BRD-and-Functional-Requirements.md#18-functional-requirements'])on conflict do nothing;
create function private.check_optional_task(p_mission uuid,p_task text)returns void language plpgsql stable security definer set search_path=''as $$
declare brief jsonb;selection public.optional_step_choices;begin
 select r.brief into brief from public.runs r where r.mission_id=p_mission and r.id::text=p_task;
 if private.optional_step(brief#>>'{playbook,id}',(brief#>>'{playbook,version}')::integer,brief#>>'{playbook,step}')then
 select *into selection from public.optional_step_choices where mission_id=p_mission and playbook_id=brief#>>'{playbook,id}'and step_id=brief#>>'{playbook,step}'order by created_at desc,id desc limit 1;
 if selection.choice is distinct from'do'or selection.playbook_version<>(brief#>>'{playbook,version}')::integer or not private.readiness_current_approved(p_mission,selection.artifact_version_id)then raise exception 'needs_approval: optional work requires a current explicit Do choice at dispatch';end if;
 end if;
end$$;
revoke all on function private.check_optional_task(uuid,text)from public;

create or replace function public.lock_model_dispatch(p_mission uuid,p_run uuid,p_key text)returns void language plpgsql security definer set search_path=''as $$begin
 perform private.require_role(array['policy_role']);perform private.lock_mission(p_mission);perform private.active_mission(p_mission);perform private.check_optional_task(p_mission,p_run::text);
 if not exists(select from public.model_usage_reservations r where r.mission_id=p_mission and r.run_id=p_run and r.call_key=p_key and not exists(select from public.model_usage u where u.call_key=r.call_key))then raise exception 'invariant_violation: current scoped model reservation required';end if;
end$$;
create or replace function private.check_provider_dispatch(p_mission uuid,p_provider text,p_ref uuid,p_version uuid,p_kind text,p_task text,p_model text)returns void language plpgsql set search_path=''as $$begin
 perform private.lock_mission(p_mission);perform private.active_mission(p_mission);perform private.check_optional_task(p_mission,p_task);
 perform 1 from private.provider_credentials c join public.missions m on m.id=c.mission_id join public.founder_accounts a on a.id=c.account_id and a.founder_id=m.founder_id where c.mission_id=p_mission and c.ref=p_ref and c.provider=p_provider and c.sandbox_mode=m.sandbox_mode and a.status='connected'for share of a;
 if not found or exists(select from public.account_revocations r join private.provider_credentials c on c.account_id=r.account_id where c.ref=p_ref)then raise exception 'invariant_violation: provider account revoked or out of scope';end if;
 perform private.check_version(p_mission,p_version);
 if p_kind='voice_realtime'and not exists(select from public.voice_sessions v where v.mission_id=p_mission and v.task_id::text=p_task and v.openai_ref=p_ref and exists(select from public.voice_model_budgets b where b.session_id=v.id and b.model=p_model and b.maximum_tokens=100000)and public.voice_output_allowed(p_mission,v.id))then raise exception 'invariant_violation: voice session authority unavailable';end if;
end$$;
create or replace function public.begin_effect(p_mission uuid,p_authorization uuid)returns jsonb language plpgsql security definer set search_path='' as $$declare v_a public.effect_authorizations;v_status text;v_ceiling bigint;v_voice public.voice_sessions;begin
  perform private.require_role(array['policy_role']);perform private.lock_mission(p_mission);perform private.active_mission(p_mission);
  select * into strict v_a from public.effect_authorizations where mission_id=p_mission and id=p_authorization for update;
  perform private.check_optional_task(p_mission,v_a.intent->>'taskId');perform private.check_chase_dispatch(p_mission,v_a.intent);
  perform private.check_sourcing_campaign_dispatch(p_mission,v_a.intent);
  select status into v_status from public.effect_states where authorization_id=p_authorization order by created_at desc,id desc limit 1;
  if v_a.mandate_id is not null and(exists(select from public.mandate_revocations where mandate_id=v_a.mandate_id)or exists(select from public.mandates m where m.id=v_a.mandate_id and(m.expires_at<=clock_timestamp()or exists(select from public.decision_supersessions where previous_id=m.decision_id)or exists(select from public.stale_marks where mission_id=p_mission and node_id=m.decision_id))))then raise exception 'invariant_violation: mandate revoked or expired';end if;
  if v_a.approval_id is not null and(exists(select from public.approval_invalidations where approval_id=v_a.approval_id)or exists(select from public.approvals where id=v_a.approval_id and expires_at<=clock_timestamp()))then raise exception 'needs_approval: approval invalidated or expired';end if;
  perform private.check_version(p_mission,(v_a.intent->>'artifactVersionId')::uuid);
  perform private.check_campaign_exposure(p_mission,v_a.intent,v_a.id);
  if v_a.intent->>'effectClass'='communicate'and private.effect_mode(p_mission,v_a.intent)<>'do'and(v_a.approval_id is null or not(v_a.intent?'artifactVersionId'))then raise exception 'needs_approval: current Guide or Help requires reviewed draft approval';end if;
  if v_a.intent->>'action'in('payment_refund','payment_authorization_capture','payment_authorization_void')then perform private.payment_source(p_mission,v_a.intent,v_a.id);elsif v_a.intent->>'effectClass'='spend'then perform private.fx_for_intent(p_mission,v_a.intent);end if;
  if v_a.intent->>'effectClass'='spend'and v_a.intent->>'action'<>'payment_refund'then v_ceiling:=private.current_budget_ceiling(p_mission);if v_ceiling is not null and private.mission_exposure(p_mission)>v_ceiling then raise exception 'needs_approval: current approved budget exceeded before dispatch';end if;end if;
  if v_a.intent->>'channel'='voice'then
   select vs.*into strict v_voice from public.voice_sessions vs join private.provider_credentials tc on tc.ref=vs.twilio_ref where vs.mission_id=p_mission and vs.task_id::text=v_a.intent->>'taskId'and vs.counterparty_id::text=v_a.intent->>'counterpartyId'and tc.account_id::text=v_a.intent->>'instrumentId'and exists(select from public.voice_model_budgets b where b.session_id=vs.id)and not exists(select from public.voice_session_events ended where ended.session_id=vs.id and ended.kind='ended');
   perform 1 from public.founder_accounts account join private.provider_credentials credential on credential.account_id=account.id where credential.ref in(v_voice.twilio_ref,v_voice.openai_ref)for share of account;
   if exists(select from public.account_revocations revoked join private.provider_credentials credential on credential.account_id=revoked.account_id where credential.ref in(v_voice.twilio_ref,v_voice.openai_ref))or(v_voice.mandate_id is not null and not exists(select from public.mandates m where m.mission_id=p_mission and m.id=v_voice.mandate_id and m.expires_at>clock_timestamp()and not exists(select from public.mandate_revocations mr where mr.mandate_id=m.id)and exists(select from public.active_decisions d where d.id=m.decision_id and d.mission_id=p_mission)))then raise exception 'needs_approval: current voice accounts and negotiation authority required';end if;
  end if;
  perform 1 from public.founder_accounts where id=(v_a.intent->>'instrumentId')::uuid for share;
  if exists(select from public.account_revocations where account_id=(v_a.intent->>'instrumentId')::uuid)then raise exception 'invariant_violation: instrument revoked';end if;
  if v_status<>'reserved' then return private.authorization_json(p_authorization,true);end if;
  insert into public.effect_states(mission_id,authorization_id,status)values(p_mission,p_authorization,'started');return private.authorization_json(p_authorization,false);
end$$;
create function private.check_optional_artifact(p_mission uuid,p_version uuid)returns void language plpgsql stable security definer set search_path=''as $$declare run uuid;begin
 select created_by_run_id into run from public.artifact_versions where mission_id=p_mission and id=p_version;
 if run is not null then perform private.check_optional_task(p_mission,run::text);end if;
end$$;
alter function private.check_version(uuid,uuid)rename to check_version_before_optional;
create function private.check_version(p_mission uuid,p_version uuid)returns void language plpgsql stable security definer set search_path=''as $$begin
 perform private.check_version_before_optional(p_mission,p_version);perform private.check_optional_artifact(p_mission,p_version);
end$$;
create function private.optional_output_dependency()returns trigger language plpgsql security definer set search_path=''as $$declare brief jsonb;choice public.optional_step_choices;begin
 if new.created_by_run_id is null then return new;end if;
 select r.brief into brief from public.runs r where r.mission_id=new.mission_id and r.id=new.created_by_run_id;
 if private.optional_step(brief#>>'{playbook,id}',(brief#>>'{playbook,version}')::integer,brief#>>'{playbook,step}')then
 perform private.check_optional_task(new.mission_id,new.created_by_run_id::text);
 select *into strict choice from public.optional_step_choices where mission_id=new.mission_id and playbook_id=brief#>>'{playbook,id}'and step_id=brief#>>'{playbook,step}'order by created_at desc,id desc limit 1;
 insert into public.dependencies(mission_id,upstream_id,dependent_id,reason)values(new.mission_id,choice.artifact_version_id,new.id,'exact optional work authorization')on conflict do nothing;
 end if;return new;
end$$;
create trigger optional_output_dependency after insert on public.artifact_versions for each row execute function private.optional_output_dependency();
revoke all on function private.check_optional_artifact(uuid,uuid),private.check_version(uuid,uuid),private.check_version_before_optional(uuid,uuid),private.optional_output_dependency()from public;

commit;
