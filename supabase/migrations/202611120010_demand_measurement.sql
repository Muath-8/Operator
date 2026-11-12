begin;
create function public.measure_demand(p_mission uuid,p_page uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare page public.demand_pages;threshold jsonb;target integer;deadline timestamptz;signups integer;measurement text;fact uuid;v_kind text;begin
  perform private.require_role(array['policy_role']);perform private.lock_mission(p_mission);
  select * into strict page from public.demand_pages where mission_id=p_mission and id=p_page;
  select v.content->'threshold' into strict threshold from public.decisions d join public.decision_resolutions r on r.decision_id=d.id join public.artifact_versions v on v.id=any(d.approved_version_refs) and v.mission_id=d.mission_id where d.id=page.threshold_decision_id and d.mission_id=p_mission and v.content?'threshold' and r.response in('approve','choose');
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
revoke all on function public.measure_demand(uuid,uuid) from public;
grant execute on function public.measure_demand(uuid,uuid) to policy_role;
create function private.wake_demand_measurement() returns trigger language plpgsql security definer set search_path='' as $$begin
  insert into public.outbox(mission_id,type,payload) values(new.mission_id,'demand.signup',jsonb_build_object('pageId',new.page_id));return new;
end$$;
revoke all on function private.wake_demand_measurement() from public;
create trigger demand_signup_measurement after insert on public.demand_signups for each row execute function private.wake_demand_measurement();
commit;

