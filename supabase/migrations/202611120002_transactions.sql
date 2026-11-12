-- Atomic ledger operations. SECURITY DEFINER is guarded by both role and tenant.
begin;
create function private.lock_mission(p_mission uuid) returns void language plpgsql set search_path='' as $$begin perform private.assert_mission(p_mission);perform 1 from public.missions where id=p_mission for update;end$$;
create function private.audit(p_mission uuid,p_label text,p_summary text,p_refs uuid[] default '{}',p_receipt uuid default null) returns void language sql set search_path='' as $$insert into public.activity(mission_id,label,summary,refs,receipt_id,actor_id)values(p_mission,p_label,p_summary,p_refs,p_receipt,private.actor_id())$$;
create function private.node_before_insert() returns trigger language plpgsql security definer set search_path='' as $$begin
  perform private.assert_mission(new.mission_id);
  insert into public.state_nodes(id,mission_id,kind)values(new.id,new.mission_id,case tg_table_name when 'decisions' then 'decision' when 'artifacts' then 'artifact' when 'artifact_versions' then 'version' when 'evidence' then 'evidence' else 'commitment' end);
  return new;
end$$;
do $$declare t text;begin foreach t in array array['decisions','artifacts','artifact_versions','evidence','commitments']loop execute format('create trigger create_state_node before insert on public.%I for each row execute function private.node_before_insert()',t);end loop;end$$;
create function private.assert_safe_content(p_value jsonb) returns void language plpgsql immutable set search_path='' as $$begin
  if p_value::text ~* '("(secret|secret_ref|access_token|refresh_token|client_secret|password|authorization|approvalToken)"\s*:|sk-proj-|Bearer [A-Za-z0-9])' then raise exception 'validation: secret content prohibited' using errcode='22023';end if;
end$$;
create function private.content_guard() returns trigger language plpgsql security definer set search_path='' as $$begin perform private.assert_safe_content(to_jsonb(new));return new;end$$;
do $$declare t text;begin foreach t in array array['decisions','artifact_versions','evidence','activity','messages','runs','tasks','outbox','category_profiles','playbooks','templates']loop execute format('create trigger content_guard before insert on public.%I for each row execute function private.content_guard()',t);end loop;end$$;
create function private.invalidate(p_mission uuid,p_root uuid,p_cause uuid) returns void language plpgsql set search_path='' as $$begin
  with recursive affected(id)as(select p_root union select d.dependent_id from public.dependencies d join affected a on a.id=d.upstream_id where d.mission_id=p_mission)
  insert into public.stale_marks(mission_id,node_id,cause_id)select p_mission,id,p_cause from affected on conflict do nothing;
  insert into public.approval_invalidations(mission_id,approval_id,reason)
  select p_mission,a.id,'upstream changed' from public.approvals a where a.mission_id=p_mission and(exists(select from public.stale_marks s where s.mission_id=p_mission and(s.node_id=a.decision_id or s.node_id=(a.binding->>'artifactVersionId')::uuid))) on conflict do nothing;
end$$;
create function private.validate_packet(p_packet jsonb,p_kind text) returns void language plpgsql immutable set search_path='' as $$begin
  perform private.assert_safe_content(p_packet);
  if jsonb_typeof(p_packet->'options')<>'array' or jsonb_array_length(p_packet->'options') not between 1 and 4 or not(p_packet ?& array['question','options','recommendation','staleImpact','defaultIfNoAnswer']) or length(p_packet->>'question')=0 then raise exception 'validation: incomplete decision packet' using errcode='22023';end if;
  if not exists(select from jsonb_array_elements(p_packet->'options')o where o->>'id'=p_packet->'recommendation'->>'optionId') or not exists(select from jsonb_array_elements(p_packet->'options')o where o->>'id'=p_packet->'defaultIfNoAnswer'->>'optionId') then raise exception 'validation: decision option missing' using errcode='22023';end if;
  if p_kind='change' and not(p_packet?'impact') then raise exception 'validation: change requires impact analysis' using errcode='22023';end if;
  if exists(select from jsonb_array_elements(p_packet->'options')o cross join lateral jsonb_array_elements_text(coalesce(o->'artifactVersionIds','[]'))ref where not(coalesce(p_packet->'approvedVersionIds','[]')?ref))then raise exception 'validation: option version outside frozen packet references'using errcode='22023';end if;
  if (p_packet->'defaultIfNoAnswer'->>'binding')::boolean and p_packet->'defaultIfNoAnswer'->>'at' is not null then raise exception 'validation: binding action cannot default' using errcode='22023';end if;
end$$;
create function public.propose_decision(p_mission uuid,p_kind text,p_packet jsonb,p_outcome text default null,p_gate text default null,p_supersedes uuid default null) returns uuid language plpgsql security definer set search_path='' as $$declare v_id uuid;v_evidence uuid[];v_versions uuid[];v_ref uuid;begin
  perform private.require_role(array['lead_role']);perform private.lock_mission(p_mission);perform private.validate_packet(p_packet,p_kind);
  select coalesce(array_agg(distinct reference::uuid),'{}')into v_evidence from jsonb_array_elements(p_packet->'options')o cross join lateral jsonb_array_elements_text(coalesce(o->'evidenceIds','[]'))reference;
  select coalesce(array_agg(reference::uuid),'{}')into v_versions from jsonb_array_elements_text(coalesce(p_packet->'approvedVersionIds','[]'))reference;
  foreach v_ref in array v_evidence loop if not exists(select from public.evidence e where e.mission_id=p_mission and e.id=v_ref and not exists(select from public.evidence newer where newer.supersedes_id=e.id)and not exists(select from public.stale_marks where mission_id=p_mission and node_id=e.id))then raise exception 'validation: cited evidence missing or cross tenant or stale'using errcode='22023';end if;end loop;
  foreach v_ref in array v_versions loop if not exists(select from public.artifact_versions v where v.mission_id=p_mission and v.id=v_ref and not exists(select from public.artifact_versions newer where newer.artifact_id=v.artifact_id and newer.version_no>v.version_no)and not exists(select from public.stale_marks where mission_id=p_mission and node_id=v.id))then raise exception 'validation: cited artifact version missing or cross tenant or stale'using errcode='22023';end if;end loop;
  insert into public.decisions(mission_id,kind,packet,outcome,gate,supersedes_id,actor_id,evidence_refs,approved_version_refs)values(p_mission,p_kind,p_packet,p_outcome,p_gate,p_supersedes,private.actor_id(),v_evidence,v_versions)returning id into v_id;
  foreach v_ref in array v_evidence loop insert into public.dependencies(mission_id,upstream_id,dependent_id,reason)values(p_mission,v_ref,v_id,'decision cited evidence');end loop;
  foreach v_ref in array v_versions loop insert into public.dependencies(mission_id,upstream_id,dependent_id,reason)values(p_mission,v_ref,v_id,'decision approved version');end loop;
  perform private.audit(p_mission,'proposed','Decision proposed',array[v_id]);return v_id;
end$$;
create function public.resolve_decision(p_mission uuid,p_decision uuid,p_response text,p_option text default null) returns uuid language plpgsql security definer set search_path='' as $$declare v_id uuid;v_d public.decisions;begin
  perform private.require_role(array['founder_role','authenticated']);perform private.lock_mission(p_mission);
  select * into strict v_d from public.decisions where mission_id=p_mission and id=p_decision;
  if exists(select from public.decision_supersessions where previous_id=p_decision) or exists(select from public.stale_marks where mission_id=p_mission and node_id=p_decision) then raise exception 'invariant_violation: decision stale';end if;
  if p_response in('approve','choose') then
    if p_option is null then p_option:=v_d.packet->'recommendation'->>'optionId';end if;
    if not exists(select from jsonb_array_elements(v_d.packet->'options')o where o->>'id'=p_option)then raise exception 'validation: unknown option' using errcode='22023';end if;
    if v_d.supersedes_id is not null then
      if not exists(select from public.decision_resolutions where decision_id=v_d.supersedes_id and response in('approve','choose'))or exists(select from public.decision_supersessions where previous_id=v_d.supersedes_id)then raise exception 'invariant_violation: supersession conflict';end if;
      insert into public.decision_supersessions(mission_id,previous_id,replacement_id)values(p_mission,v_d.supersedes_id,p_decision);
      perform private.invalidate(p_mission,v_d.supersedes_id,p_decision);
    end if;
  end if;
  insert into public.decision_resolutions(mission_id,decision_id,response,option_id,actor_id)values(p_mission,p_decision,p_response,p_option,private.actor_id())returning id into v_id;
  insert into public.outbox(mission_id,type,payload)values(p_mission,'decision.resolved',jsonb_build_object('decisionId',p_decision,'response',p_response));
  perform private.audit(p_mission,case when p_response in('approve','choose')then 'approved' else 'proposed'end,'Decision resolved',array[p_decision,v_id]);return v_id;
end$$;
create function public.add_dependency(p_mission uuid,p_upstream uuid,p_dependent uuid,p_reason text)returns uuid language plpgsql security definer set search_path='' as $$declare v_id uuid;begin
  perform private.require_role(array['lead_role','specialist_role']);perform private.lock_mission(p_mission);
  if exists(with recursive ancestors(id)as(select p_dependent union select d.dependent_id from public.dependencies d join ancestors a on a.id=d.upstream_id where d.mission_id=p_mission)select from ancestors where id=p_upstream)then raise exception 'validation: dependency cycle' using errcode='22023';end if;
  insert into public.dependencies(mission_id,upstream_id,dependent_id,reason)values(p_mission,p_upstream,p_dependent,p_reason)returning id into v_id;
  if exists(select from public.stale_marks where mission_id=p_mission and node_id=p_upstream)then perform private.invalidate(p_mission,p_dependent,p_upstream);end if;return v_id;
end$$;
create function public.create_artifact(p_mission uuid,p_type text,p_outcome text,p_title text)returns uuid language plpgsql security definer set search_path='' as $$declare v_id uuid;begin perform private.require_role(array['lead_role','specialist_role']);perform private.lock_mission(p_mission);insert into public.artifacts(mission_id,type,outcome,title,actor_id)values(p_mission,p_type,p_outcome,p_title,private.actor_id())returning id into v_id;return v_id;end$$;
create function public.append_artifact_version(p_mission uuid,p_artifact uuid,p_content jsonb,p_derived uuid[] default '{}',p_decisions uuid[] default '{}',p_evidence uuid[] default '{}',p_files text[] default '{}',p_variation text default null,p_run uuid default null)returns uuid language plpgsql security definer set search_path='' as $$declare v_id uuid;v_old uuid;v_ref uuid;v_no integer;begin
  perform private.require_role(array['lead_role','specialist_role']);perform private.lock_mission(p_mission);perform private.assert_safe_content(p_content);
  perform 1 from public.artifacts where mission_id=p_mission and id=p_artifact;if not found then raise exception 'validation: artifact not found' using errcode='22023';end if;
  select id,version_no into v_old,v_no from public.artifact_versions where mission_id=p_mission and artifact_id=p_artifact order by version_no desc limit 1;
  insert into public.artifact_versions(mission_id,artifact_id,version_no,content,file_refs,variation_request,created_by_run_id)values(p_mission,p_artifact,coalesce(v_no,0)+1,p_content,p_files,p_variation,p_run)returning id into v_id;
  insert into public.artifact_statuses(mission_id,artifact_version_id,status,actor_id)values(p_mission,v_id,'draft',private.actor_id());
  foreach v_ref in array p_derived loop perform 1 from public.artifact_versions where mission_id=p_mission and id=v_ref;if not found then raise exception 'validation: lineage version missing' using errcode='22023';end if;insert into public.dependencies(mission_id,upstream_id,dependent_id,reason)values(p_mission,v_ref,v_id,'derived from');end loop;
  foreach v_ref in array p_decisions loop perform 1 from public.decisions where mission_id=p_mission and id=v_ref;if not found then raise exception 'validation: decision missing' using errcode='22023';end if;insert into public.dependencies(mission_id,upstream_id,dependent_id,reason)values(p_mission,v_ref,v_id,'approved decision');end loop;
  foreach v_ref in array p_evidence loop perform 1 from public.evidence where mission_id=p_mission and id=v_ref;if not found then raise exception 'validation: evidence missing' using errcode='22023';end if;insert into public.dependencies(mission_id,upstream_id,dependent_id,reason)values(p_mission,v_ref,v_id,'source evidence');end loop;
  if v_old is not null then
    perform private.invalidate(p_mission,v_old,v_id);
    insert into public.approval_invalidations(mission_id,approval_id,reason)select p_mission,id,'artifact version changed' from public.approvals where mission_id=p_mission and binding->>'artifactVersionId'=v_old::text on conflict do nothing;
  end if;
  return v_id;
end$$;
create function public.set_artifact_status(p_mission uuid,p_version uuid,p_status text,p_decision uuid default null)returns uuid language plpgsql security definer set search_path='' as $$declare v_id uuid;v_current text;begin
  perform private.require_role(array['founder_role','authenticated','lead_role','specialist_role']);perform private.lock_mission(p_mission);
  select status into v_current from public.artifact_statuses where mission_id=p_mission and artifact_version_id=p_version order by created_at desc,id desc limit 1;
  if not((v_current='draft' and p_status='proposed')or(v_current='proposed' and p_status in('approved','rejected'))or(v_current in('approved','rejected') and p_status in('superseded','stale')))then raise exception 'invariant_violation: invalid artifact transition';end if;
  if p_status='approved' then perform private.require_role(array['founder_role','authenticated']);if not exists(select from public.decision_resolutions where mission_id=p_mission and decision_id=p_decision and response in('approve','choose'))then raise exception 'needs_approval: artifact decision required';end if;end if;
  insert into public.artifact_statuses(mission_id,artifact_version_id,status,decision_id,actor_id)values(p_mission,p_version,p_status,p_decision,private.actor_id())returning id into v_id;
  if p_status in('stale','superseded')then perform private.invalidate(p_mission,p_version,p_version);end if;return v_id;
end$$;
create function public.append_evidence(p_mission uuid,p_outcome text,p_kind text,p_trust text,p_payload jsonb,p_source_type text,p_source_reference text,p_receipt uuid default null,p_supersedes uuid default null)returns uuid language plpgsql security definer set search_path='' as $$declare v_id uuid;v_sandbox boolean;begin
  perform private.require_role(array['founder_role','authenticated','lead_role','specialist_role','policy_role','voice_role']);perform private.lock_mission(p_mission);perform private.assert_safe_content(p_payload);
  if p_trust='founder_confirmed' then perform private.require_role(array['founder_role','authenticated']);end if;
  if private.caller_role()='voice_role' and p_trust<>'claimed' then raise exception 'invariant_violation: voice evidence must be claimed';end if;
  if p_trust in('performed','verified') then
    if p_trust='performed' and p_receipt is null then raise exception 'invariant_violation: performed requires receipt';end if;
    if p_trust='verified'and not(
      (p_receipt is not null and exists(select from public.provider_receipts r where r.id=p_receipt and r.mission_id=p_mission and r.data->>'verifiedKind'=p_kind and r.data->>'verifiedOutcome'=p_outcome))
      or(p_source_type='event'and exists(select from public.events e where e.id::text=p_source_reference and e.mission_id=p_mission and e.signature_verified and e.type='evidence.verified'and e.payload->>'kind'=p_kind and e.payload->>'outcome'=p_outcome))
    )then raise exception 'invariant_violation: verified evidence requires matching provider proof';end if;
  end if;
  select sandbox_mode into strict v_sandbox from public.missions where id=p_mission;
  if p_receipt is not null and not exists(select from public.provider_receipts where mission_id=p_mission and id=p_receipt and sandbox_mode=v_sandbox)then raise exception 'invariant_violation: receipt environment mismatch';end if;
  insert into public.evidence(mission_id,outcome,kind,trust,payload,source_type,source_reference,provider_receipt_id,supersedes_id,sandbox_mode,actor_id)values(p_mission,p_outcome,p_kind,p_trust,p_payload,p_source_type,p_source_reference,p_receipt,p_supersedes,v_sandbox,private.actor_id())returning id into v_id;
  if p_supersedes is not null then perform private.invalidate(p_mission,p_supersedes,v_id);end if;return v_id;
end$$;
create function public.open_commitment(p_mission uuid,p_party uuid,p_direction text,p_description text,p_due timestamptz)returns uuid language plpgsql security definer set search_path='' as $$declare v_id uuid;begin perform private.require_role(array['lead_role','specialist_role','policy_role','voice_role']);perform private.lock_mission(p_mission);if p_party is not null and not exists(select from public.counterparties c join public.missions m on m.founder_id=c.founder_id where m.id=p_mission and c.id=p_party)then raise exception 'validation: party not in tenant'using errcode='22023';end if;insert into public.commitments(mission_id,party_id,direction,description,due_at,actor_id)values(p_mission,p_party,p_direction,p_description,p_due,private.actor_id())returning id into v_id;insert into public.commitment_states(mission_id,commitment_id,status)values(p_mission,v_id,'open');return v_id;end$$;
create function public.close_commitment(p_mission uuid,p_commitment uuid,p_evidence uuid)returns uuid language plpgsql security definer set search_path='' as $$declare v_id uuid;begin perform private.require_role(array['lead_role','policy_role']);perform private.lock_mission(p_mission);if not exists(select from public.evidence where mission_id=p_mission and id=p_evidence and trust in('performed','verified','founder_confirmed'))then raise exception 'invariant_violation: close requires evidence';end if;insert into public.commitment_states(mission_id,commitment_id,status,closed_by_evidence_id)values(p_mission,p_commitment,'closed',p_evidence)returning id into v_id;return v_id;end$$;
create function public.issue_approval(p_mission uuid,p_decision uuid,p_binding jsonb,p_hash text,p_expires timestamptz)returns uuid language plpgsql security definer set search_path='' as $$declare v_id uuid;v_version uuid;begin
  perform private.require_role(array['founder_role','authenticated']);perform private.lock_mission(p_mission);
  if not exists(select from public.decision_resolutions where mission_id=p_mission and decision_id=p_decision and response in('approve','choose'))or exists(select from public.decision_supersessions where previous_id=p_decision)or exists(select from public.stale_marks where mission_id=p_mission and node_id=p_decision)then raise exception 'needs_approval: active decision required';end if;
  if not(p_binding?&array['action','counterpartyId','amountMinor','currency','artifactVersionId'])or p_expires<=now()or p_expires>now()+interval '7 days' then raise exception 'validation: invalid approval binding or expiry'using errcode='22023';end if;
  v_version:=(p_binding->>'artifactVersionId')::uuid;
  if v_version is not null and not exists(select from public.artifact_versions v where v.id=v_version and v.mission_id=p_mission and not exists(select from public.artifact_versions newer where newer.artifact_id=v.artifact_id and newer.version_no>v.version_no))then raise exception 'invariant_violation: approval version not current';end if;
  if not exists(select from public.counterparties c join public.missions m on m.founder_id=c.founder_id where m.id=p_mission and c.id=(p_binding->>'counterpartyId')::uuid)then raise exception 'validation: approval party not in tenant'using errcode='22023';end if;
  insert into public.approvals(mission_id,decision_id,binding,token_hash,expires_at)values(p_mission,p_decision,p_binding,p_hash,p_expires)returning id into v_id;return v_id;
end$$;
create function public.grant_mandate(p_mission uuid,p_decision uuid,p_type text,p_scope jsonb,p_per bigint,p_total bigint,p_expires timestamptz)returns uuid language plpgsql security definer set search_path='' as $$declare v_id uuid;v_currency text;begin
  perform private.require_role(array['founder_role','authenticated']);perform private.lock_mission(p_mission);
  if not exists(select from public.decision_resolutions where mission_id=p_mission and decision_id=p_decision and response in('approve','choose'))or exists(select from public.decision_supersessions where previous_id=p_decision)then raise exception 'needs_approval: mandate requires active approved decision';end if;
  if not(p_scope?&array['actions','effectClasses','counterpartyIds','channels','purposes','instrumentIds','maxNewContacts'])or p_expires<=now()or p_per>p_total then raise exception 'validation: mandate scope incomplete'using errcode='22023';end if;
  select currency into v_currency from public.missions where id=p_mission;
  insert into public.mandates(mission_id,decision_id,type,scope,ceiling_per,ceiling_total,currency,expires_at)values(p_mission,p_decision,p_type,p_scope,p_per,p_total,v_currency,p_expires)returning id into v_id;return v_id;
end$$;
create function public.revoke_mandate(p_mission uuid,p_mandate uuid)returns uuid language plpgsql security definer set search_path='' as $$declare v_id uuid;begin perform private.require_role(array['founder_role','authenticated']);perform private.lock_mission(p_mission);insert into public.mandate_revocations(mission_id,mandate_id)values(p_mission,p_mandate)on conflict(mandate_id)do nothing returning id into v_id;if v_id is null then select id into v_id from public.mandate_revocations where mission_id=p_mission and mandate_id=p_mandate;end if;insert into public.outbox(mission_id,type,payload)values(p_mission,'mandate.revoked',jsonb_build_object('mandateId',p_mandate));return v_id;end$$;
create function public.transition_mission(p_mission uuid,p_status text,p_terminal uuid default null,p_closing uuid default null)returns uuid language plpgsql security definer set search_path='' as $$declare v_id uuid;begin perform private.require_role(array['founder_role','authenticated']);perform private.lock_mission(p_mission);
  if p_status='ended' and(not exists(select from public.decisions d join public.decision_resolutions r on r.decision_id=d.id where d.id=p_terminal and d.mission_id=p_mission and d.kind='terminal' and r.response in('approve','choose'))or not exists(select from public.artifact_versions where id=p_closing and mission_id=p_mission))then raise exception 'needs_approval: end requires terminal decision and closing record';end if;
  if exists(select from public.mission_transitions where mission_id=p_mission and status='ended')then raise exception 'invariant_violation: ended mission cannot resume';end if;
  insert into public.mission_transitions(mission_id,status,terminal_decision_id,closing_record_version_id,actor_id)values(p_mission,p_status,p_terminal,p_closing,private.actor_id())returning id into v_id;
  insert into public.outbox(mission_id,type,payload)values(p_mission,'mission.'||p_status,jsonb_build_object('transitionId',v_id));return v_id;end$$;

-- Every callable RPC is explicitly granted. Helpers are never callable by app roles.
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema private from public;
grant execute on function public.propose_decision(uuid,text,jsonb,text,text,uuid)to lead_role;
grant execute on function public.resolve_decision(uuid,uuid,text,text),public.issue_approval(uuid,uuid,jsonb,text,timestamptz),public.grant_mandate(uuid,uuid,text,jsonb,bigint,bigint,timestamptz),public.revoke_mandate(uuid,uuid),public.transition_mission(uuid,text,uuid,uuid)to founder_role;
grant execute on function public.create_artifact(uuid,text,text,text),public.append_artifact_version(uuid,uuid,jsonb,uuid[],uuid[],uuid[],text[],text,uuid),public.add_dependency(uuid,uuid,uuid,text)to lead_role,specialist_role;
grant execute on function public.set_artifact_status(uuid,uuid,text,uuid)to founder_role,lead_role,specialist_role;
grant execute on function public.append_evidence(uuid,text,text,text,jsonb,text,text,uuid,uuid)to founder_role,lead_role,specialist_role,policy_role,voice_role;
grant execute on function public.open_commitment(uuid,uuid,text,text,timestamptz)to lead_role,specialist_role,policy_role,voice_role;
grant execute on function public.close_commitment(uuid,uuid,uuid)to lead_role,policy_role;
commit;
