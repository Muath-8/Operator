begin;
create or replace function public.confirm_founder_artifact(p_mission uuid,p_decision uuid,p_version uuid)returns uuid language plpgsql security definer set search_path=''as $$
declare c jsonb;d public.decisions;fact uuid;existing uuid;k text;ref text;target uuid;begin
 perform private.require_role(array['founder_role','authenticated']);perform private.lock_mission(p_mission);
 select * into strict d from public.decisions where mission_id=p_mission and id=p_decision;
 select content->'founderConfirmation' into strict c from public.artifact_versions where mission_id=p_mission and id=p_version and id in(select private.selected_approved_versions(p_mission,p_decision));
 if d.kind<>'engagement' or c is null or d.gate is distinct from c->>'kind' or d.outcome is distinct from c->>'outcome' or length(coalesce(c->>'statement',''))<1 then raise exception 'needs_approval: explicit founder confirmation required';end if;
 if not ((c->>'outcome'='brand'and c->>'kind' in('name_approved','identity_approved','guidelines_approved'))or(c->>'outcome'='product'and c->>'kind' in('physical_sample_approved','manufacturing_brief_sample_match'))or(c->>'outcome'='compliance'and c->>'kind' in('requirements_complete','requirements_resolved'))or(c->>'outcome'='demand'and c->>'kind' in('validation_result','launch_week_plan','launch_content_approved'))or(c->>'outcome'='commerce'and c->>'kind'='shipping_rate_confirmed')or(c->>'kind'='kit_verified'and c->>'outcome' in('brand','product','supply','compliance','commerce','demand'))or(c->>'outcome'='supply'and c->>'kind' in('proforma_invoice','inspection_plan','sourcing_risk_accepted')))then raise exception 'validation: unsupported founder confirmation';end if;
 if c->>'kind' in('validation_result','sourcing_risk_accepted') and coalesce((c->'payload'->>'riskAccepted')::boolean,false)<>true then raise exception 'validation: unmeasured validation or sourcing exception needs explicit risk acceptance';end if;
 if (select status from public.artifact_statuses where artifact_version_id=p_version order by created_at desc,id desc limit 1)is distinct from 'approved' or exists(select from public.stale_marks where mission_id=p_mission and node_id=p_version)then raise exception 'needs_approval: confirmation version is not current and approved';end if;
 if c->>'kind' in('shipping_rate_confirmed','kit_verified')then
  if jsonb_typeof(c->'payload'->'sourceEvidenceIds')is distinct from 'array'or jsonb_array_length(c->'payload'->'sourceEvidenceIds')=0 then raise exception 'validation: current returned source evidence required';end if;
  for ref in select jsonb_array_elements_text(c->'payload'->'sourceEvidenceIds')loop
   if not exists(select from public.evidence e where e.mission_id=p_mission and e.id::text=ref and e.trust in('claimed','verified','founder_confirmed')and not exists(select from public.stale_marks s where s.node_id=e.id)and not exists(select from public.evidence n where n.supersedes_id=e.id))then raise exception 'validation: returned evidence missing or stale';end if;
  end loop;
 end if;
 if c->>'kind'='shipping_rate_confirmed'then
  if coalesce(c->'payload'->'rate'->>'amountMinor','')!~'^[1-9][0-9]{0,14}$'or coalesce(c->'payload'->'rate'->>'currency','')!~'^[A-Z]{3}$'or coalesce(c->'payload'->'rate'->>'countryCode','')!~'^[A-Z]{2}$'or coalesce(length(trim(c->'payload'->'rate'->>'rateName')),0)not between 1 and 200 then raise exception 'validation: exact shipping rate, currency and country required';end if;
 end if;
 if c->>'kind'='kit_verified'then
  target:=(c->'payload'->>'kitVersionId')::uuid;
  if target is null or not private.readiness_current_approved(p_mission,target)or not exists(select from public.artifact_versions v join public.artifacts a on a.id=v.artifact_id where v.mission_id=p_mission and v.id=target and a.type='founder_kit'and a.outcome=c->>'outcome')then raise exception 'needs_approval: current approved kit required';end if;
 end if;
 select id into existing from public.evidence where mission_id=p_mission and source_reference='founder-confirmation:'||p_decision::text||':'||p_version::text and kind=c->>'kind';if existing is not null then return existing;end if;
 foreach k in array case when c->>'kind' in('physical_sample_approved','requirements_resolved','validation_result')then array[c->>'kind','external_verification']else array[c->>'kind']end loop
  fact:=public.append_evidence(p_mission,c->>'outcome',k,'founder_confirmed',coalesce(c->'payload','{}')||jsonb_build_object('statement',c->>'statement','decisionId',p_decision,'artifactVersionId',p_version,'confirmedAt',clock_timestamp()),'document','founder-confirmation:'||p_decision::text||':'||p_version::text);
  insert into public.dependencies(mission_id,upstream_id,dependent_id,reason)values(p_mission,p_decision,fact,'explicit founder confirmation'),(p_mission,p_version,fact,'confirmed immutable source');
  if c->>'kind' in('shipping_rate_confirmed','kit_verified')then
   for ref in select jsonb_array_elements_text(c->'payload'->'sourceEvidenceIds')loop insert into public.dependencies(mission_id,upstream_id,dependent_id,reason)values(p_mission,ref::uuid,fact,'returned founder source')on conflict do nothing;end loop;
   if target is not null then insert into public.dependencies(mission_id,upstream_id,dependent_id,reason)values(p_mission,target,fact,'verified kit')on conflict do nothing;end if;
  end if;
 end loop;
 return fact;
end$$;
revoke all on function public.confirm_founder_artifact(uuid,uuid,uuid)from public;
grant execute on function public.confirm_founder_artifact(uuid,uuid,uuid)to founder_role;

create function public.accept_supplier_quote(p_mission uuid,p_decision uuid,p_version uuid)returns uuid language plpgsql security definer set search_path=''as $$
declare accepted jsonb;q jsonb;spec uuid;fact uuid;begin
 perform private.require_role(array['founder_role']);perform private.lock_mission(p_mission);
 if not exists(select from public.active_decisions where mission_id=p_mission and id=p_decision and outcome='supply'and kind in('selection','engagement')and gate in('supplier_terms','quote_acceptance','proforma_invoice'))or p_version not in(select private.selected_approved_versions(p_mission,p_decision))or not private.readiness_current_approved(p_mission,p_version)then raise exception 'needs_approval: exact approved supplier terms required';end if;
 select content->'acceptedQuote'into accepted from public.artifact_versions where id=p_version and mission_id=p_mission;
 if jsonb_typeof(accepted)is distinct from'object'or not(accepted?&array['quoteId','specVersionId'])or accepted-array['quoteId','specVersionId']<>'{}'::jsonb then raise exception 'validation: accepted quote must reference stored source and approved specification';end if;
 spec:=(accepted->>'specVersionId')::uuid;
 if not private.readiness_current_approved(p_mission,spec)or not exists(select from public.artifact_versions v join public.artifacts a on a.id=v.artifact_id where v.id=spec and v.mission_id=p_mission and a.type='product_spec'and a.outcome='product')then raise exception 'needs_approval: current product specification required';end if;
 if not exists(select from public.sourcing_quote_ingestions where mission_id=p_mission and id=(accepted->>'quoteId')::uuid)then raise exception 'validation: scoped supplier quotation required';end if;
 q:=public.sourcing_quote_result((accepted->>'quoteId')::uuid);
 if q->>'status'<>'confirmed_reading'or coalesce(private.readiness_date(q->'quote'->>'validUntil')>clock_timestamp(),false)<>true then raise exception 'needs_approval: unambiguous unexpired quotation required';end if;
 select id into fact from public.evidence where mission_id=p_mission and kind='accepted_quote'and source_reference='accepted-quote:'||p_version::text;
 if fact is not null then return fact;end if;
 fact:=public.append_evidence(p_mission,'supply','accepted_quote','founder_confirmed',jsonb_build_object('accepted',true,'quoteId',q->'id','supplierId',q->'supplierId','specVersionId',spec,'terms',q->'quote','artifactVersionId',p_version,'decisionId',p_decision),'document','accepted-quote:'||p_version::text);
 insert into public.dependencies(mission_id,upstream_id,dependent_id,reason)values(p_mission,(q->>'sourceEvidenceId')::uuid,fact,'accepted supplier quote source'),(p_mission,spec,fact,'accepted specification'),(p_mission,p_version,fact,'approved acceptance'),(p_mission,p_decision,fact,'explicit founder acceptance');
 return fact;
end$$;
revoke all on function public.accept_supplier_quote(uuid,uuid,uuid)from public;
grant execute on function public.accept_supplier_quote(uuid,uuid,uuid)to founder_role;

commit;
