begin;
do $$begin if not exists(select from pg_roles where rolname='demand_public_role') then create role demand_public_role nologin noinherit nobypassrls;end if;end$$;
grant usage on schema public to demand_public_role;
create function public.publish_demand_page(p_mission uuid,p_intent jsonb,p_token_hash text,p_version uuid,p_threshold uuid,p_slug text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_authorization jsonb;receipt jsonb;page uuid;content jsonb;begin
  perform private.require_role(array['policy_role']);perform private.lock_mission(p_mission);
  if p_intent->>'action'<>'marketing_publish' or p_intent->>'effectClass'<>'publish' or p_intent->>'artifactVersionId'<>p_version::text or p_slug!~'^[a-z0-9][a-z0-9-]{2,62}$' then raise exception 'validation: invalid publication intent';end if;
  if not exists(select from public.active_decisions d where d.mission_id=p_mission and d.id=p_threshold and d.outcome='demand' and d.gate='validation_threshold') then raise exception 'needs_approval: approve a go/no-go threshold before starting validation';end if;
  if (select count(*) from public.decisions d join public.artifact_versions v on v.id=any(d.approved_version_refs) and v.mission_id=d.mission_id where d.id=p_threshold and v.content->'threshold'->>'metric'='distinct_consented_signups' and (v.content->'threshold'->>'target')::integer>0 and (v.content->'threshold'->>'endsAt')::timestamptz>clock_timestamp())<>1 then raise exception 'validation: threshold needs one frozen numeric target and future deadline';end if;
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
revoke all on function public.publish_demand_page(uuid,jsonb,text,uuid,uuid,text) from public;
grant execute on function public.publish_demand_page(uuid,jsonb,text,uuid,uuid,text) to policy_role;
create function public.read_validation_page(p_slug text) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare page public.demand_pages;begin
  perform private.require_role(array['demand_public_role']);
  select * into strict page from public.demand_pages where slug=p_slug;
  if exists(select from public.mission_deletion_requests where mission_id=page.mission_id) or (select status from public.mission_transitions where mission_id=page.mission_id order by created_at desc,id desc limit 1)='ended' then return null;end if;
  return jsonb_build_object('slug',page.slug,'title',page.content->>'title','description',page.content->>'description','consentText',page.content->>'consentText','imageUrl',page.content->>'imageUrl','sandbox',page.sandbox_mode);
end$$;
create function public.record_waitlist_signup(p_slug text,p_email_hash text,p_ciphertext text,p_consent boolean) returns boolean language plpgsql security definer set search_path='' as $$
declare page public.demand_pages;begin
  perform private.require_role(array['demand_public_role']);
  if not p_consent or p_email_hash!~'^[a-f0-9]{64}$' or length(p_ciphertext)>3000 then raise exception 'validation: explicit consent and valid protected email required';end if;
  select * into strict page from public.demand_pages where slug=p_slug;
  if exists(select from public.mission_deletion_requests where mission_id=page.mission_id) or coalesce((select status from public.mission_transitions where mission_id=page.mission_id order by created_at desc,id desc limit 1),'active')<>'active' then raise exception 'validation: signup collection is closed';end if;
  insert into public.demand_signups(mission_id,page_id,email_hash,email_ciphertext,consent_at) values(page.mission_id,page.id,p_email_hash,p_ciphertext,clock_timestamp()) on conflict(page_id,email_hash) do nothing;
  return true;
end$$;
revoke all on function public.read_validation_page(text),public.record_waitlist_signup(text,text,text,boolean) from public;
grant execute on function public.read_validation_page(text),public.record_waitlist_signup(text,text,text,boolean) to demand_public_role;
commit;


