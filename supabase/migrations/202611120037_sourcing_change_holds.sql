begin;
create or replace function public.flag_sourcing_term_change(p_mission uuid,p_accepted uuid,p_quote uuid)returns jsonb language plpgsql security definer set search_path=''as $$
declare accepted_id uuid;a jsonb;b jsonb;changed text[]:='{}';field text;result uuid;begin
 perform private.require_role(array['specialist_role']);perform private.lock_mission(p_mission);
 select id,changed_fields into result,changed from public.sourcing_term_changes where mission_id=p_mission and accepted_version_id=p_accepted and ingestion_id=p_quote;
 if result is not null then
  if cardinality(changed)>0 then perform private.invalidate(p_mission,p_accepted,(select source_evidence_id from public.sourcing_quote_ingestions where mission_id=p_mission and id=p_quote));end if;
  return jsonb_build_object('id',result,'needsDecision',cardinality(changed)>0,'changedFields',changed,'acceptedVersionId',p_accepted,'quoteId',p_quote);
 end if;
 if not private.readiness_current_approved(p_mission,p_accepted)then raise exception 'needs_approval: current accepted terms artifact required';end if;
 select(v.content#>>'{acceptedQuote,quoteId}')::uuid into accepted_id from public.artifact_versions v join public.artifacts a on a.mission_id=v.mission_id and a.id=v.artifact_id where v.mission_id=p_mission and v.id=p_accepted and a.outcome='supply'and a.type in('quotation','accepted_terms','proforma_invoice','accepted_quote');
 if accepted_id is null then raise exception 'validation: accepted quotation reference required';end if;
 a:=public.sourcing_quote_result(accepted_id);b:=public.sourcing_quote_result(p_quote);
 if a->>'status'<>'confirmed_reading'or b->>'status'<>'confirmed_reading'or a->>'supplierId'<>b->>'supplierId'or not exists(select from public.sourcing_quote_ingestions q where q.mission_id=p_mission and q.id=p_quote)then raise exception 'validation: two current same-supplier quotations required';end if;
 if not exists(select from public.dependencies d where d.mission_id=p_mission and d.upstream_id=(a->>'sourceEvidenceId')::uuid and d.dependent_id=p_accepted)then raise exception 'validation: accepted terms lack frozen source evidence dependency';end if;
 for field in select jsonb_object_keys(a->'quote')loop if a->'quote'->field is distinct from b->'quote'->field then changed:=array_append(changed,field);end if;end loop;
 select id into result from public.sourcing_term_changes where mission_id=p_mission and accepted_version_id=p_accepted and ingestion_id=p_quote;
 if result is null then
  insert into public.sourcing_term_changes(mission_id,accepted_version_id,ingestion_id,changed_fields)values(p_mission,p_accepted,p_quote,changed)returning id into result;
  if cardinality(changed)>0 then
   perform private.invalidate(p_mission,p_accepted,(b->>'sourceEvidenceId')::uuid);
   insert into public.activity(mission_id,label,summary,refs,actor_id)values(p_mission,'blocked','Accepted supplier terms changed. A specific founder decision is required before commitment.',array[p_accepted,(b->>'sourceEvidenceId')::uuid],private.actor_id());
   insert into public.outbox(mission_id,type,payload)values(p_mission,'sourcing.accepted_terms_changed',jsonb_build_object('changeId',result,'acceptedVersionId',p_accepted,'quoteId',p_quote,'changedFields',changed));
  end if;
 end if;
 return jsonb_build_object('id',result,'needsDecision',cardinality(changed)>0,'changedFields',changed,'acceptedVersionId',p_accepted,'quoteId',p_quote);
end$$;
create or replace function public.accept_supplier_quote(p_mission uuid,p_decision uuid,p_version uuid)returns uuid language plpgsql security definer set search_path=''as $$
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
 insert into public.dependencies(mission_id,upstream_id,dependent_id,reason)values(p_mission,(q->>'sourceEvidenceId')::uuid,p_version,'frozen accepted quote source'),(p_mission,spec,p_version,'frozen accepted specification')on conflict do nothing;
 select id into fact from public.evidence where mission_id=p_mission and kind='accepted_quote'and source_reference='accepted-quote:'||p_version::text;
 if fact is not null then return fact;end if;
 fact:=public.append_evidence(p_mission,'supply','accepted_quote','founder_confirmed',jsonb_build_object('accepted',true,'quoteId',q->'id','supplierId',q->'supplierId','specVersionId',spec,'terms',q->'quote','artifactVersionId',p_version,'decisionId',p_decision),'document','accepted-quote:'||p_version::text);
 insert into public.dependencies(mission_id,upstream_id,dependent_id,reason)values(p_mission,(q->>'sourceEvidenceId')::uuid,fact,'accepted supplier quote source'),(p_mission,spec,fact,'accepted specification'),(p_mission,p_version,fact,'approved acceptance'),(p_mission,p_decision,fact,'explicit founder acceptance');
 return fact;
end$$;
create or replace function private.check_version(p_mission uuid,p_version uuid)returns void language plpgsql stable set search_path='' as $$declare shipping jsonb;begin
  if p_version is null then return;end if;
  if exists(with recursive ancestors(id)as(select p_version union select d.upstream_id from public.dependencies d join ancestors a on a.id=d.dependent_id where d.mission_id=p_mission)
   select from ancestors a join public.artifact_versions v on v.id=a.id and v.mission_id=p_mission
   left join public.sourcing_quote_ingestions q on q.id::text=v.content#>>'{acceptedQuote,quoteId}'and q.mission_id=p_mission
   where v.content?'acceptedQuote'and(q.id is null or q.status<>'confirmed_reading'or coalesce(private.readiness_date(q.quote->>'validUntil')>clock_timestamp(),false)<>true or exists(select from public.stale_marks where node_id=q.source_evidence_id)or exists(select from public.evidence n where n.supersedes_id=q.source_evidence_id)))then raise exception 'needs_approval: accepted supplier quotation expired or changed';end if;
  -- Typed proformas reference the approved spec even when a model omitted derivedFrom.
  -- UNION deduplicates cycles; every referenced node still must be current and approved.
  if exists(with recursive refs(id)as(select p_version union select(v.content#>>'{proformaInvoice,specVersionId}')::uuid from public.artifact_versions v join refs r on r.id=v.id where v.mission_id=p_mission and v.content#>>'{proformaInvoice,specVersionId}'is not null)
    select from refs r left join public.artifact_versions v on v.id=r.id and v.mission_id=p_mission left join public.artifacts a on a.id=v.artifact_id and a.mission_id=p_mission
    left join lateral(select s.*from public.artifact_statuses s where s.mission_id=p_mission and s.artifact_version_id=v.id order by s.created_at desc,s.id desc limit 1)s on true
    where v.id is null or(r.id<>p_version and a.outcome<>'product')or exists(select from public.artifact_versions n where n.artifact_id=v.artifact_id and n.version_no>v.version_no)or exists(select from public.stale_marks d where d.mission_id=p_mission and d.node_id=v.id)
    or s.status is distinct from 'approved'or not exists(select from public.decision_resolutions d where d.mission_id=p_mission and d.decision_id=s.decision_id and d.response in('approve','choose'))or exists(select from public.decision_supersessions d where d.mission_id=p_mission and d.previous_id=s.decision_id)or exists(select from public.stale_marks d where d.mission_id=p_mission and d.node_id=s.decision_id))then raise exception 'needs_approval: artifact version stale or not approved (including referenced specification)';end if;
  select coalesce(content->'payload',content)into shipping from public.artifact_versions where mission_id=p_mission and id=p_version;
  if shipping->>'kind'='shipping'and not exists(select from public.evidence e where e.mission_id=p_mission and e.id::text=shipping->>'quoteEvidenceId'and e.kind='shipping_rate_confirmed'and e.trust in('verified','founder_confirmed')and e.payload->'rate'->>'currency'=shipping->>'currency'and e.payload->'rate'->>'countryCode'=shipping->>'countryCode'and jsonb_typeof(e.payload->'rate'->'amountMinor')='number'and(e.payload->'rate'->>'amountMinor')::numeric>0 and not exists(select from public.stale_marks st where st.mission_id=p_mission and st.node_id=e.id)and not exists(select from public.evidence newer where newer.mission_id=p_mission and newer.supersedes_id=e.id))then raise exception 'needs_approval: current confirmed carrier quote currency and country required';end if;
end$$;

create function private.hold_changed_supplier_terms()returns trigger language plpgsql security definer set search_path=''as $$declare v record;begin
 if new.status<>'confirmed_reading'then return new;end if;
 for v in select version.id,prior_quote.source_evidence_id from public.artifact_versions version join public.sourcing_quote_ingestions prior_quote on prior_quote.id::text=version.content#>>'{acceptedQuote,quoteId}'and prior_quote.mission_id=version.mission_id where version.mission_id=new.mission_id and prior_quote.supplier_id=new.supplier_id and prior_quote.id<>new.id and prior_quote.message_id<>new.message_id and private.readiness_current_approved(new.mission_id,version.id)loop
  insert into public.dependencies(mission_id,upstream_id,dependent_id,reason)values(new.mission_id,v.source_evidence_id,v.id,'frozen accepted source')on conflict do nothing;
  perform public.flag_sourcing_term_change(new.mission_id,v.id,new.id);
 end loop;return new;
end$$;
create trigger hold_changed_supplier_terms after insert on public.sourcing_quote_ingestions for each row execute function private.hold_changed_supplier_terms();
revoke all on function private.hold_changed_supplier_terms()from public;


-- Tighten already accepted history without editing its immutable source rows.
insert into public.dependencies(mission_id,upstream_id,dependent_id,reason)
 select v.mission_id,q.source_evidence_id,v.id,'frozen accepted quote source'from public.artifact_versions v join public.sourcing_quote_ingestions q on q.id::text=v.content#>>'{acceptedQuote,quoteId}'and q.mission_id=v.mission_id where exists(select from public.artifact_statuses st where st.artifact_version_id=v.id and st.status='approved')on conflict do nothing;
insert into public.dependencies(mission_id,upstream_id,dependent_id,reason)
 select v.mission_id,spec.id,v.id,'frozen accepted specification'from public.artifact_versions v join public.artifact_versions spec on spec.id::text=v.content#>>'{acceptedQuote,specVersionId}'and spec.mission_id=v.mission_id where exists(select from public.artifact_statuses st where st.artifact_version_id=v.id and st.status='approved')on conflict do nothing;
do $$declare r record;begin
 for r in select v.mission_id,v.id,q.source_evidence_id from public.artifact_versions v join public.sourcing_quote_ingestions q on q.id::text=v.content#>>'{acceptedQuote,quoteId}'and q.mission_id=v.mission_id where exists(select from public.stale_marks where node_id=q.source_evidence_id)or exists(select from public.evidence n where n.supersedes_id=q.source_evidence_id)loop perform private.invalidate(r.mission_id,r.id,r.source_evidence_id);end loop;
 for r in select c.mission_id,c.accepted_version_id,q.source_evidence_id from public.sourcing_term_changes c join public.sourcing_quote_ingestions q on q.id=c.ingestion_id where cardinality(c.changed_fields)>0 loop perform private.invalidate(r.mission_id,r.accepted_version_id,r.source_evidence_id);end loop;
end$$;
commit;
