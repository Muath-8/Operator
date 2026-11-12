begin;
create table public.sourcing_quote_ingestions(
 id uuid primary key default gen_random_uuid(),mission_id uuid not null references public.missions(id),message_id uuid not null references public.messages(id),supplier_id uuid not null references public.counterparties(id),attempt_key text not null,
 source_evidence_id uuid not null,status text not null check(status in('confirmed_reading','needs_clarification','extraction_failed')),quote jsonb,unconfirmed_fields text[] not null,missing_fields text[] not null,clarification text,
 created_at timestamptz not null default clock_timestamp(),unique(mission_id,id),unique(mission_id,message_id,attempt_key),foreign key(mission_id,source_evidence_id)references public.evidence(mission_id,id),check((status='confirmed_reading')=(quote is not null))
);
create table public.sourcing_quote_readings(
 id uuid primary key default gen_random_uuid(),mission_id uuid not null,ingestion_id uuid not null,ordinal integer not null check(ordinal in(1,2)),extractor_id text not null,reading jsonb,failure text check(failure in('provider_down','schema_invalid')),
 created_at timestamptz not null default clock_timestamp(),unique(ingestion_id,ordinal),foreign key(mission_id,ingestion_id)references public.sourcing_quote_ingestions(mission_id,id),check((reading is null)=(failure is not null))
);
create table public.sourcing_assessments(
 id uuid primary key default gen_random_uuid(),mission_id uuid not null,ingestion_id uuid not null,spec_version_id uuid not null,negotiation_mandate_id uuid,assessment jsonb not null,
 created_at timestamptz not null default clock_timestamp(),foreign key(mission_id,ingestion_id)references public.sourcing_quote_ingestions(mission_id,id),foreign key(mission_id,spec_version_id)references public.artifact_versions(mission_id,id),foreign key(mission_id,negotiation_mandate_id)references public.mandates(mission_id,id)
);
create table public.sourcing_term_changes(
 id uuid primary key default gen_random_uuid(),mission_id uuid not null,accepted_version_id uuid not null,ingestion_id uuid not null,changed_fields text[] not null,
 created_at timestamptz not null default clock_timestamp(),unique(mission_id,accepted_version_id,ingestion_id),foreign key(mission_id,accepted_version_id)references public.artifact_versions(mission_id,id),foreign key(mission_id,ingestion_id)references public.sourcing_quote_ingestions(mission_id,id)
);
do $$declare t text;begin foreach t in array array['sourcing_quote_ingestions','sourcing_quote_readings','sourcing_assessments','sourcing_term_changes']loop
 execute format('alter table public.%I enable row level security',t);execute format('alter table public.%I force row level security',t);
 execute format('create policy mission_scope on public.%I using(private.owns_mission(mission_id))with check(private.owns_mission(mission_id))',t);
 execute format('create trigger immutable_row before update or delete on public.%I for each row execute function private.immutable_row()',t);
 execute format('create trigger ledger_revision after insert on public.%I for each row execute function private.record_ledger_revision()',t);
 execute format('create trigger broadcast_ledger after insert on public.%I for each row execute function private.broadcast_ledger()',t);
end loop;end$$;
grant select on public.sourcing_quote_ingestions,public.sourcing_quote_readings,public.sourcing_assessments,public.sourcing_term_changes to founder_role,lead_role,specialist_role;

create function public.sourcing_message_source(p_mission uuid,p_message uuid)returns jsonb language plpgsql stable security definer set search_path=''as $$
declare result jsonb;begin
 perform private.require_role(array['lead_role','specialist_role']);perform private.assert_mission(p_mission);
 select jsonb_build_object('messageId',m.id,'supplierId',c.id,'text',m.original,'sourceLanguage',c.locale)into result from public.messages m join public.threads t on t.id=m.thread_id and t.mission_id=m.mission_id join public.counterparties c on c.id=t.counterparty_id join public.missions mission on mission.id=m.mission_id and mission.founder_id=c.founder_id
 where m.mission_id=p_mission and m.id=p_message and m.direction='inbound'and m.channel in('email','whatsapp','marketplace')and c.kind='supplier'and length(m.provider_id)>0 and length(m.original)between 1 and 60000;
 if result is null then raise exception 'validation: recorded supplier source message required';end if;return result;
end$$;

create function private.validate_sourcing_reading(p jsonb)returns void language plpgsql immutable set search_path=''as $$
declare r jsonb;k text;v numeric;t jsonb;begin
 if jsonb_typeof(p)is distinct from'object'or not(p?&array['extractorId','reading','failure'])or p-array['extractorId','reading','failure']<>'{}'::jsonb or jsonb_typeof(p->'extractorId')is distinct from'string'or length(p->>'extractorId')not between 1 and 200 then raise exception 'validation: extraction outcome malformed';end if;
 if p->'reading'='null'::jsonb then if p->>'failure'not in('provider_down','schema_invalid')or p->>'failure'is null then raise exception 'validation: extraction failure required';end if;return;end if;
 if p->'failure'<>'null'::jsonb then raise exception 'validation: reading cannot have failure';end if;r:=p->'reading';
 if jsonb_typeof(r)is distinct from'object'or not(r?&array['currency','unitPriceMinor','moq','leadDays','validUntil','incoterm','depositPercent','tiers','terms','language','unit','dimensionsMm'])or r-array['currency','unitPriceMinor','moq','leadDays','validUntil','incoterm','depositPercent','tiers','terms','language','unit','dimensionsMm']<>'{}'::jsonb then raise exception 'validation: quote fields malformed';end if;
 foreach k in array array['unitPriceMinor','moq','leadDays']loop
  if r->k<>'null'::jsonb then if jsonb_typeof(r->k)is distinct from'number'then raise exception 'validation: quote number required';end if;v:=(r->>k)::numeric;if v<>trunc(v)or v<(case when k='moq'then 1 else 0 end)or v>9007199254740991 then raise exception 'validation: invalid quote number';end if;end if;
 end loop;
 if r->'currency'<>'null'::jsonb and coalesce(r->>'currency','')!~'^[A-Z]{3}$'then raise exception 'validation: quote currency malformed';end if;
 if r->'validUntil'<>'null'::jsonb and private.readiness_date(r->>'validUntil')is null then raise exception 'validation: quote validity malformed';end if;
 if r->'incoterm'<>'null'::jsonb and r->>'incoterm'not in('EXW','FOB','CIF','DAP','DDP')then raise exception 'validation: Incoterm malformed';end if;
 if r->'unit'<>'null'::jsonb and r->>'unit'not in('unit','set','kg','litre')then raise exception 'validation: unit malformed';end if;
 if r->'depositPercent'<>'null'::jsonb then if jsonb_typeof(r->'depositPercent')is distinct from'number'or(r->>'depositPercent')::numeric not between 0 and 100 then raise exception 'validation: deposit malformed';end if;end if;
 if jsonb_typeof(r->'terms')is distinct from'string'or length(r->>'terms')>12000 or jsonb_typeof(r->'language')is distinct from'string'or length(r->>'language')not between 2 and 20 or jsonb_typeof(r->'tiers')is distinct from'array'then raise exception 'validation: quote text/tiers malformed';end if;
 for t in select value from jsonb_array_elements(r->'tiers')loop
  if jsonb_typeof(t)is distinct from'object'or not(t?&array['quantity','unitPriceMinor'])or t-array['quantity','unitPriceMinor']<>'{}'::jsonb or jsonb_typeof(t->'quantity')is distinct from'number'or jsonb_typeof(t->'unitPriceMinor')is distinct from'number'then raise exception 'validation: quote tier malformed';end if;
  foreach k in array array['quantity','unitPriceMinor']loop v:=(t->>k)::numeric;if v<>trunc(v)or v<(case when k='quantity'then 1 else 0 end)or v>9007199254740991 then raise exception 'validation: quote tier malformed';end if;end loop;
 end loop;
 if r->'dimensionsMm'<>'null'::jsonb then
  if jsonb_typeof(r->'dimensionsMm')is distinct from'object'then raise exception 'validation: dimensions malformed';end if;
  for t in select value from jsonb_each(r->'dimensionsMm')loop if jsonb_typeof(t)is distinct from'number'or t::numeric<=0 then raise exception 'validation: dimension malformed';end if;end loop;
 end if;
end$$;

create function public.sourcing_quote_result(p_id uuid)returns jsonb language plpgsql stable security definer set search_path=''as $$
declare q public.sourcing_quote_ingestions;begin
 perform private.require_role(array['founder_role','lead_role','specialist_role']);select *into strict q from public.sourcing_quote_ingestions where id=p_id;perform private.assert_mission(q.mission_id);
 if exists(select from public.stale_marks s where s.mission_id=q.mission_id and s.node_id=q.source_evidence_id)or exists(select from public.evidence e where e.mission_id=q.mission_id and e.supersedes_id=q.source_evidence_id)then raise exception 'validation: quote source corrected or stale';end if;
 return jsonb_build_object('id',q.id,'messageId',q.message_id,'supplierId',q.supplier_id,'sourceEvidenceId',q.source_evidence_id,'status',q.status,'quote',q.quote,'unconfirmedFields',q.unconfirmed_fields,'missingFields',q.missing_fields,'clarification',q.clarification);
end$$;

create function public.record_sourcing_readings(p_mission uuid,p_message uuid,p_attempt text,p_first jsonb,p_second jsonb)returns jsonb language plpgsql security definer set search_path=''as $$
declare source jsonb;q public.sourcing_quote_ingestions;a jsonb;b jsonb;different text[]:='{}';missing text[]:='{}';k text;state text;body jsonb;clarify text;ev uuid;prior uuid;qid uuid;begin
 perform private.require_role(array['specialist_role']);perform private.lock_mission(p_mission);source:=public.sourcing_message_source(p_mission,p_message);
 if length(p_attempt)not between 1 and 256 or p_attempt is null then raise exception 'validation: quote attempt key required';end if;
 perform private.validate_sourcing_reading(p_first);perform private.validate_sourcing_reading(p_second);perform private.assert_safe_content(p_first);perform private.assert_safe_content(p_second);
 if p_first->>'extractorId'=p_second->>'extractorId'then raise exception 'validation: independent extractor IDs required';end if;
 select *into q from public.sourcing_quote_ingestions where mission_id=p_mission and message_id=p_message and attempt_key=p_attempt;
 if found then
  if not exists(select from public.sourcing_quote_readings r where ingestion_id=q.id and ordinal=1 and r.extractor_id=p_first->>'extractorId'and r.reading is not distinct from nullif(p_first->'reading','null'::jsonb)and r.failure is not distinct from p_first->>'failure')or not exists(select from public.sourcing_quote_readings r where ingestion_id=q.id and ordinal=2 and r.extractor_id=p_second->>'extractorId'and r.reading is not distinct from nullif(p_second->'reading','null'::jsonb)and r.failure is not distinct from p_second->>'failure')then raise exception 'invariant_violation: quote attempt replay changed';end if;
  return public.sourcing_quote_result(q.id);
 end if;
 a:=nullif(p_first->'reading','null'::jsonb);b:=nullif(p_second->'reading','null'::jsonb);
 if a is null or b is null then state:='extraction_failed';
 else
  for k in select jsonb_object_keys(a)loop if a->k is distinct from b->k then different:=array_append(different,k);end if;end loop;
  foreach k in array array['currency','unitPriceMinor','moq','leadDays','validUntil','incoterm','depositPercent','unit']loop if a->k='null'::jsonb or b->k='null'::jsonb then missing:=array_append(missing,k);end if;end loop;
  if length(trim(a->>'terms'))=0 or length(trim(b->>'terms'))=0 then missing:=array_append(missing,'terms');end if;
  if cardinality(different)+cardinality(missing)>0 then state:='needs_clarification';clarify:='Please confirm the quotation terms in writing: '||array_to_string(array(select distinct f from unnest(different||missing)f order by f),', ')||'. No missing or contradictory term has been assumed.';else state:='confirmed_reading';body:=a;end if;
 end if;
 select source_evidence_id into prior from public.sourcing_quote_ingestions where mission_id=p_mission and message_id=p_message order by created_at desc,id desc limit 1;
 ev:=public.append_evidence(p_mission,'supply',case when state='confirmed_reading'then 'supplier_quote'else 'supplier_quote_unconfirmed'end,'claimed',jsonb_build_object('messageId',p_message,'supplierId',source->>'supplierId','status',state,'terms',body,'unconfirmedFields',different,'missingFields',missing),'document','message:'||p_message::text,null,prior);
 insert into public.sourcing_quote_ingestions(mission_id,message_id,supplier_id,attempt_key,source_evidence_id,status,quote,unconfirmed_fields,missing_fields,clarification)values(p_mission,p_message,(source->>'supplierId')::uuid,p_attempt,ev,state,body,different,missing,clarify)returning id into qid;
 insert into public.sourcing_quote_readings(mission_id,ingestion_id,ordinal,extractor_id,reading,failure)values(p_mission,qid,1,p_first->>'extractorId',a,p_first->>'failure'),(p_mission,qid,2,p_second->>'extractorId',b,p_second->>'failure');
 insert into public.activity(mission_id,label,summary,refs,actor_id)values(p_mission,case when state='confirmed_reading'then 'claimed'when state='extraction_failed'then 'failed'else 'blocked'end,case when state='confirmed_reading'then 'Two independent quotation readings agree; supplier terms remain claimed.'when state='extraction_failed'then 'Quotation extraction failed; no terms inferred. Retry extraction before contacting the supplier.'else 'Quotation needs written clarification; contradictory or missing terms were not assumed.'end,array[ev],private.actor_id());
 insert into public.outbox(mission_id,type,payload)values(p_mission,'sourcing.quote_read',jsonb_build_object('quoteId',qid,'messageId',p_message,'status',state));
 return public.sourcing_quote_result(qid);
end$$;

create function public.sourcing_route_context(p_mission uuid,p_quote uuid,p_spec uuid,p_mandate uuid default null)returns jsonb language plpgsql stable security definer set search_path=''as $$
declare q jsonb;spec jsonb;bounds jsonb;signals jsonb;begin
 perform private.require_role(array['lead_role','specialist_role']);perform private.assert_mission(p_mission);q:=public.sourcing_quote_result(p_quote);
 if not exists(select from public.sourcing_quote_ingestions where id=p_quote and mission_id=p_mission)then raise exception 'invariant_violation: cross mission quote';end if;
 if not private.readiness_current_approved(p_mission,p_spec)then raise exception 'needs_approval: current approved specification required';end if;
 select v.content into spec from public.artifact_versions v join public.artifacts a on a.mission_id=v.mission_id and a.id=v.artifact_id where v.mission_id=p_mission and v.id=p_spec and a.outcome='product'and a.type='product_spec';if spec is null then raise exception 'validation: product specification required';end if;
 if p_mandate is not null then
  select m.scope->'bounds'into bounds from public.mandates m where m.mission_id=p_mission and m.id=p_mandate and m.type='negotiation'and m.expires_at>clock_timestamp()and m.scope->'counterpartyIds'?(q->>'supplierId')and not exists(select from public.mandate_revocations r where r.mandate_id=m.id)and exists(select from public.active_decisions d where d.mission_id=m.mission_id and d.id=m.decision_id);
  if bounds is null then raise exception 'needs_approval: current supplier negotiation bounds required';end if;
 end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'trust',e.trust,'kind',e.kind,'payload',e.payload)),'[]'::jsonb)into signals from public.evidence e where e.mission_id=p_mission and e.payload->>'supplierId'=q->>'supplierId'and not exists(select from public.stale_marks s where s.mission_id=p_mission and s.node_id=e.id)and not exists(select from public.evidence n where n.mission_id=p_mission and n.supersedes_id=e.id);
 return jsonb_build_object('quote',q,'spec',spec,'bounds',bounds,'evidence',signals);
end$$;
create function public.record_sourcing_assessment(p_mission uuid,p_quote uuid,p_spec uuid,p_mandate uuid,p_assessment jsonb)returns uuid language plpgsql security definer set search_path=''as $$
declare result uuid;ctx jsonb;cell jsonb;observation jsonb;ref text;fact jsonb;q jsonb;bounds jsonb;compat jsonb;rule jsonb;left_value numeric;right_value numeric;dimensions jsonb;fx public.fx_quotes;price numeric;begin
 perform private.require_role(array['specialist_role']);perform private.lock_mission(p_mission);ctx:=public.sourcing_route_context(p_mission,p_quote,p_spec,p_mandate);perform private.assert_safe_content(p_assessment);
 if jsonb_typeof(p_assessment)is distinct from'object'then raise exception 'validation: sourcing assessment object required';end if;
 if p_assessment->>'kind'='scorecard'then
  if jsonb_typeof(p_assessment->'cells')is distinct from'array'or jsonb_array_length(p_assessment->'cells')<>8 or(select count(distinct value->>'criterion')from jsonb_array_elements(p_assessment->'cells'))<>8 then raise exception 'validation: eight unique scorecard criteria required';end if;
  for cell in select value from jsonb_array_elements(p_assessment->'cells')loop
   if cell->>'criterion'not in('response_speed','language_quality','sample_quality','price','moq_flexibility','on_time_delivery','defect_rate','communication')then raise exception 'validation: unknown scorecard criterion';end if;
   observation:=nullif(cell->'observation','null'::jsonb);
   if observation is null then if cell->>'label'is distinct from'not yet observed'then raise exception 'validation: missing score must remain unobserved';end if;
   else
    if cell->>'label'is distinct from'observed'or observation->>'criterion'is distinct from cell->>'criterion'or jsonb_typeof(observation->'score')is distinct from'number'or(observation->>'score')::numeric not between 0 and 5 or length(trim(coalesce(observation->>'reason','')))=0 or jsonb_typeof(observation->'evidenceIds')is distinct from'array'or jsonb_array_length(observation->'evidenceIds')<1 then raise exception 'validation: score observation malformed';end if;
    for ref in select jsonb_array_elements_text(observation->'evidenceIds')loop
     select value into fact from jsonb_array_elements(ctx->'evidence')where value->>'id'=ref and value->>'trust'<>'planned'and(value#>>'{payload,criterion}'=cell->>'criterion'or(cell->>'criterion'='price'and value->>'kind'='supplier_quote'and jsonb_typeof(value#>'{payload,terms,unitPriceMinor}')='number'));
     if fact is null then raise exception 'validation: score lacks current supplier evidence for this criterion';end if;
    end loop;
   end if;
  end loop;
 else
  if p_mandate is null or p_assessment->>'trust'is distinct from'claimed'or jsonb_typeof(p_assessment->'eligible')is distinct from'boolean'or jsonb_typeof(p_assessment->'reasons')is distinct from'array'or jsonb_typeof(p_assessment->'verificationEvidenceIds')is distinct from'array'then raise exception 'validation: sourcing route assessment malformed';end if;
  for ref in select jsonb_array_elements_text(p_assessment->'verificationEvidenceIds')loop if not exists(select from jsonb_array_elements(ctx->'evidence')e where e->>'id'=ref and e->>'trust'in('verified','founder_confirmed'))then raise exception 'validation: supplier verification corrected or stale';end if;end loop;
  if(p_assessment->>'eligible')::boolean then
   q:=ctx#>'{quote,quote}';bounds:=ctx->'bounds';compat:=ctx#>'{spec,sourcingCompatibility}';price:=(q->>'unitPriceMinor')::numeric;
   if jsonb_typeof(bounds)is distinct from'object'or not(bounds?&array['currency','maxUnitPriceMinor','maxMoq','maxLeadDays','maxDepositPercent'])or coalesce(bounds->>'currency','')!~'^[A-Z]{3}$'then raise exception 'validation: complete negotiation bounds required';end if;
   foreach ref in array array['maxUnitPriceMinor','maxMoq','maxLeadDays','maxDepositPercent']loop if jsonb_typeof(bounds->ref)is distinct from'number'or(bounds->>ref)::numeric<0 then raise exception 'validation: numeric negotiation bound required';end if;end loop;
   if ctx#>>'{quote,status}'is distinct from'confirmed_reading'or jsonb_array_length(p_assessment->'reasons')<>0 or p_assessment->>'requiresFounderDecision'is distinct from'false'or private.readiness_date(q->>'validUntil')<=clock_timestamp()then raise exception 'validation: unconfirmed or expired quote cannot be shortlisted';end if;
   if q->>'currency'<>bounds->>'currency'then
    select *into fx from public.fx_quotes where mission_id=p_mission and id=(p_assessment->>'fxQuoteId')::uuid and from_currency=q->>'currency'and to_currency=bounds->>'currency'and observed_at<=clock_timestamp()and expires_at>clock_timestamp();if fx.id is null then raise exception 'validation: source FX required for shortlist';end if;
    price:=private.fx_minor(price::bigint,fx.numerator,fx.denominator);
   end if;
   if price>(bounds->>'maxUnitPriceMinor')::numeric or(q->>'moq')::numeric>(bounds->>'maxMoq')::numeric or(q->>'leadDays')::numeric>(bounds->>'maxLeadDays')::numeric or(q->>'depositPercent')::numeric>(bounds->>'maxDepositPercent')::numeric then raise exception 'needs_approval: quotation exceeds approved negotiation bounds';end if;
   if(select count(distinct value#>>'{payload,independentSource}')from jsonb_array_elements(ctx->'evidence')where value->>'trust'in('verified','founder_confirmed')and value->>'id'in(select jsonb_array_elements_text(p_assessment->'verificationEvidenceIds'))and length(coalesce(value#>>'{payload,independentSource}',''))>0)<2 or not exists(select from jsonb_array_elements(ctx->'evidence')where value->>'trust'in('verified','founder_confirmed')and value->>'id'in(select jsonb_array_elements_text(p_assessment->'verificationEvidenceIds'))and value#>>'{payload,signalKind}'in('registry','marketplace_history'))then raise exception 'validation: independent supplier verification required';end if;
   if jsonb_typeof(compat->'dimensionsMm')is distinct from'object'or jsonb_typeof(compat->'rules')is distinct from'array'then raise exception 'validation: approved compatibility rules required';end if;
   dimensions:='{}'::jsonb;for ref,fact in select key,value from jsonb_each(compat->'dimensionsMm')loop dimensions:=dimensions||jsonb_build_object('spec.'||ref,fact);end loop;
   if jsonb_typeof(q->'dimensionsMm')='object'then for ref,fact in select key,value from jsonb_each(q->'dimensionsMm')loop dimensions:=dimensions||jsonb_build_object('quote.'||ref,fact);end loop;end if;
   for rule in select value from jsonb_array_elements(compat->'rules')loop
    if jsonb_typeof(rule)is distinct from'object'or not(rule?&array['left','right','relation','toleranceMm'])or jsonb_typeof(rule->'left')is distinct from'string'or jsonb_typeof(rule->'right')is distinct from'string'or jsonb_typeof(rule->'toleranceMm')is distinct from'number'or(rule->>'toleranceMm')::numeric<0 or coalesce(rule->>'relation','')not in('equal','fits')then raise exception 'validation: compatibility rule malformed';end if;
    left_value:=(dimensions->>(rule->>'left'))::numeric;right_value:=(dimensions->>(rule->>'right'))::numeric;
    if left_value is null or right_value is null or(rule->>'relation'='equal'and abs(left_value-right_value)>(rule->>'toleranceMm')::numeric)or(rule->>'relation'='fits'and left_value>right_value-(rule->>'toleranceMm')::numeric)or rule->>'relation'not in('equal','fits')then raise exception 'validation: component compatibility failed';end if;
   end loop;
  end if;
 end if;
 insert into public.sourcing_assessments(mission_id,ingestion_id,spec_version_id,negotiation_mandate_id,assessment)values(p_mission,p_quote,p_spec,p_mandate,p_assessment)returning id into result;return result;
end$$;
create function public.flag_sourcing_term_change(p_mission uuid,p_accepted uuid,p_quote uuid)returns jsonb language plpgsql security definer set search_path=''as $$
declare accepted_id uuid;a jsonb;b jsonb;changed text[]:='{}';field text;result uuid;begin
 perform private.require_role(array['specialist_role']);perform private.lock_mission(p_mission);
 if not private.readiness_current_approved(p_mission,p_accepted)then raise exception 'needs_approval: current accepted terms artifact required';end if;
 select(v.content#>>'{acceptedQuote,quoteId}')::uuid into accepted_id from public.artifact_versions v join public.artifacts a on a.mission_id=v.mission_id and a.id=v.artifact_id where v.mission_id=p_mission and v.id=p_accepted and a.outcome='supply'and a.type in('quotation','accepted_terms','proforma_invoice');
 if accepted_id is null then raise exception 'validation: accepted quotation reference required';end if;
 a:=public.sourcing_quote_result(accepted_id);b:=public.sourcing_quote_result(p_quote);
 if a->>'status'<>'confirmed_reading'or b->>'status'<>'confirmed_reading'or a->>'supplierId'<>b->>'supplierId'or not exists(select from public.sourcing_quote_ingestions q where q.mission_id=p_mission and q.id=p_quote)then raise exception 'validation: two current same-supplier quotations required';end if;
 if not exists(select from public.dependencies d where d.mission_id=p_mission and d.upstream_id=(a->>'sourceEvidenceId')::uuid and d.dependent_id=p_accepted)then raise exception 'validation: accepted terms lack frozen source evidence dependency';end if;
 for field in select jsonb_object_keys(a->'quote')loop if a->'quote'->field is distinct from b->'quote'->field then changed:=array_append(changed,field);end if;end loop;
 select id into result from public.sourcing_term_changes where mission_id=p_mission and accepted_version_id=p_accepted and ingestion_id=p_quote;
 if result is null then
  insert into public.sourcing_term_changes(mission_id,accepted_version_id,ingestion_id,changed_fields)values(p_mission,p_accepted,p_quote,changed)returning id into result;
  if cardinality(changed)>0 then
   insert into public.activity(mission_id,label,summary,refs,actor_id)values(p_mission,'blocked','Accepted supplier terms changed. A specific founder decision is required before commitment.',array[p_accepted,(b->>'sourceEvidenceId')::uuid],private.actor_id());
   insert into public.outbox(mission_id,type,payload)values(p_mission,'sourcing.accepted_terms_changed',jsonb_build_object('changeId',result,'acceptedVersionId',p_accepted,'quoteId',p_quote,'changedFields',changed));
  end if;
 end if;
 return jsonb_build_object('id',result,'needsDecision',cardinality(changed)>0,'changedFields',changed,'acceptedVersionId',p_accepted,'quoteId',p_quote);
end$$;
revoke all on function private.validate_sourcing_reading(jsonb)from public;
revoke all on function public.sourcing_message_source(uuid,uuid),public.sourcing_quote_result(uuid),public.record_sourcing_readings(uuid,uuid,text,jsonb,jsonb),public.sourcing_route_context(uuid,uuid,uuid,uuid),public.record_sourcing_assessment(uuid,uuid,uuid,uuid,jsonb),public.flag_sourcing_term_change(uuid,uuid,uuid)from public;
grant execute on function public.sourcing_message_source(uuid,uuid),public.sourcing_quote_result(uuid),public.sourcing_route_context(uuid,uuid,uuid,uuid)to lead_role,specialist_role;
grant execute on function public.sourcing_quote_result(uuid)to founder_role;
grant execute on function public.record_sourcing_readings(uuid,uuid,text,jsonb,jsonb),public.record_sourcing_assessment(uuid,uuid,uuid,uuid,jsonb),public.flag_sourcing_term_change(uuid,uuid,uuid)to specialist_role;
commit;
