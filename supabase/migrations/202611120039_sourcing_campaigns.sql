begin;
create table public.sourcing_campaigns(
 id uuid primary key default gen_random_uuid(),mission_id uuid not null references public.missions(id),rfq_version_id uuid not null,spec_version_id uuid not null,
 request_key text not null,request_hash text not null,exception_evidence_id uuid,created_at timestamptz not null default clock_timestamp(),unique(mission_id,id),unique(mission_id,request_key),
 foreign key(mission_id,rfq_version_id)references public.artifact_versions(mission_id,id),foreign key(mission_id,spec_version_id)references public.artifact_versions(mission_id,id),foreign key(mission_id,exception_evidence_id)references public.evidence(mission_id,id)
);
create table public.sourcing_campaign_recipients(
 id uuid primary key default gen_random_uuid(),mission_id uuid not null,campaign_id uuid not null,supplier_id uuid not null references public.counterparties(id),email text not null,
 verification_evidence_ids uuid[] not null,mandate_id uuid not null,task_id uuid not null default gen_random_uuid(),created_at timestamptz not null default clock_timestamp(),
 unique(mission_id,id),unique(campaign_id,supplier_id),unique(task_id),foreign key(mission_id,campaign_id)references public.sourcing_campaigns(mission_id,id),foreign key(mission_id,mandate_id)references public.mandates(mission_id,id)
);
create table public.sourcing_campaign_deliveries(
 id uuid primary key default gen_random_uuid(),mission_id uuid not null,recipient_id uuid not null unique,receipt_id uuid not null unique,rfq_version_id uuid not null,spec_version_id uuid not null,
 created_at timestamptz not null default clock_timestamp(),foreign key(mission_id,recipient_id)references public.sourcing_campaign_recipients(mission_id,id),foreign key(mission_id,receipt_id)references public.provider_receipts(mission_id,id),foreign key(mission_id,rfq_version_id)references public.artifact_versions(mission_id,id),foreign key(mission_id,spec_version_id)references public.artifact_versions(mission_id,id)
);
create table public.sourcing_campaign_holds(
 id uuid primary key default gen_random_uuid(),mission_id uuid not null,recipient_id uuid not null,status text not null check(status in('draft','blocked','ambiguous')),reason text not null,
 created_at timestamptz not null default clock_timestamp(),foreign key(mission_id,recipient_id)references public.sourcing_campaign_recipients(mission_id,id)
);
create table public.sourcing_campaign_shortlists(
 id uuid primary key default gen_random_uuid(),mission_id uuid not null,campaign_id uuid not null unique,comparison_version_id uuid not null,supplier_ids uuid[] not null check(cardinality(supplier_ids)between 3 and 5),created_at timestamptz not null default clock_timestamp(),unique(mission_id,id),
 foreign key(mission_id,campaign_id)references public.sourcing_campaigns(mission_id,id),foreign key(mission_id,comparison_version_id)references public.artifact_versions(mission_id,id)
);
create table public.sourcing_campaign_samples(
 id uuid primary key default gen_random_uuid(),mission_id uuid not null,campaign_id uuid not null,payment_id uuid not null unique,supplier_id uuid not null references public.counterparties(id),commitment_id uuid not null,
 tracking_reference text not null,created_at timestamptz not null default clock_timestamp(),foreign key(mission_id,campaign_id)references public.sourcing_campaigns(mission_id,id),foreign key(mission_id,payment_id)references public.payments(mission_id,id),foreign key(mission_id,commitment_id)references public.commitments(mission_id,id)
);
create table public.sourcing_campaign_proformas(
 id uuid primary key default gen_random_uuid(),mission_id uuid not null,campaign_id uuid not null unique,proforma_version_id uuid not null,supplier_id uuid not null references public.counterparties(id),created_at timestamptz not null default clock_timestamp(),
 foreign key(mission_id,campaign_id)references public.sourcing_campaigns(mission_id,id),foreign key(mission_id,proforma_version_id)references public.artifact_versions(mission_id,id)
);
create table public.sourcing_campaign_inspections(
 id uuid primary key default gen_random_uuid(),mission_id uuid not null,campaign_id uuid not null unique,commitment_id uuid not null,created_at timestamptz not null default clock_timestamp(),
 foreign key(mission_id,campaign_id)references public.sourcing_campaigns(mission_id,id),foreign key(mission_id,commitment_id)references public.commitments(mission_id,id)
);
do $$declare t text;begin foreach t in array array['sourcing_campaigns','sourcing_campaign_recipients','sourcing_campaign_deliveries','sourcing_campaign_holds','sourcing_campaign_shortlists','sourcing_campaign_samples','sourcing_campaign_proformas','sourcing_campaign_inspections']loop
 execute format('alter table public.%I enable row level security',t);execute format('alter table public.%I force row level security',t);execute format('create policy mission_scope on public.%I using(private.owns_mission(mission_id))with check(private.owns_mission(mission_id))',t);
 execute format('create trigger immutable_row before update or delete on public.%I for each row execute function private.immutable_row()',t);execute format('create trigger ledger_revision after insert on public.%I for each row execute function private.record_ledger_revision()',t);execute format('create trigger broadcast_ledger after insert on public.%I for each row execute function private.broadcast_ledger()',t);
 execute format('grant select on public.%I to founder_role,lead_role,specialist_role,policy_role',t);
end loop;end$$;

create function private.rfq_payload(p_spec uuid,p_content jsonb,p_rfq jsonb)returns jsonb language plpgsql immutable set search_path=''as $$declare body text;begin
 body:=case when p_rfq->>'language'='ar'then 'أنا مساعد يعمل بالذكاء الاصطناعي للمؤسس. طلب عرض أسعار فقط؛ لا يمثل طلب شراء أو قبولاً للشروط.'else 'I am an AI-assisted agent for the founder. This is a request for quotation only, not a purchase order or acceptance of terms.'end||E'\n'||jsonb_build_object('specVersionId',p_spec,'approvedSpecification',p_content,'quantityMin',p_rfq->'quantityMin','quantityMax',p_rfq->'quantityMax','targetDate',p_rfq->'targetDate','artworkVersionIds',p_rfq->'artworkVersionIds')::text;
 return jsonb_build_object('channel','email','text',body,'translation',body,'language',p_rfq->>'language','purpose','quotation_request','subject',p_rfq->>'subject','hasDocument',false);
end$$;
create function private.campaign_current(p_mission uuid,p_campaign uuid)returns public.sourcing_campaigns language plpgsql stable security definer set search_path=''as $$
declare c public.sourcing_campaigns;ids uuid[];begin
 select *into strict c from public.sourcing_campaigns where mission_id=p_mission and id=p_campaign;perform private.check_version(p_mission,c.rfq_version_id);perform private.check_version(p_mission,c.spec_version_id);
 if not exists(select from public.artifact_versions v where v.mission_id=p_mission and v.id=c.rfq_version_id and coalesce(private.readiness_date(v.content#>>'{rfq,targetDate}')>clock_timestamp(),false))then raise exception 'needs_approval: RFQ target date passed';end if;
 select array_agg(supplier_id order by supplier_id)into ids from public.sourcing_campaign_recipients where mission_id=p_mission and campaign_id=c.id;
 if cardinality(ids)<8 and not private.campaign_exception_current(p_mission,c.exception_evidence_id,c.rfq_version_id,ids)then raise exception 'needs_approval: campaign count exception stale';end if;return c;
end$$;
create function public.next_sourcing_campaign_recipient(p_mission uuid,p_recipient uuid)returns jsonb language plpgsql security definer set search_path=''as $$
declare r public.sourcing_campaign_recipients;c public.sourcing_campaigns;draft uuid;begin
 perform private.require_role(array['lead_role']);perform private.lock_mission(p_mission);perform private.active_mission(p_mission);select *into strict r from public.sourcing_campaign_recipients where mission_id=p_mission and id=p_recipient;c:=private.campaign_current(p_mission,r.campaign_id);
 if exists(select from public.sourcing_campaign_deliveries where recipient_id=r.id)then return null;end if;
 if not private.campaign_candidate_current(p_mission,r.supplier_id,r.email,r.verification_evidence_ids)then raise exception 'needs_approval: supplier verification, contact or consent changed';end if;
 select v.id into draft from public.artifact_versions v join public.artifacts a on a.id=v.artifact_id where v.mission_id=p_mission and a.type='outbound_message'and v.content->>'originatingTaskId'=r.task_id::text and v.content->'payload'=(select content->'payload'from public.artifact_versions where id=c.rfq_version_id)and private.readiness_current_approved(p_mission,v.id)order by v.created_at desc,v.id desc limit 1;
 return jsonb_build_object('dispatchVersionId',coalesce(draft,c.rfq_version_id),'recipientId',r.id,'campaignId',c.id,'taskId',r.task_id,'supplierId',r.supplier_id,'mandateId',r.mandate_id,'rfqVersionId',c.rfq_version_id);
end$$;
create function public.record_sourcing_campaign_delivery(p_mission uuid,p_recipient uuid,p_receipt uuid)returns uuid language plpgsql security definer set search_path=''as $$
declare r public.sourcing_campaign_recipients;c public.sourcing_campaigns;result uuid;begin
 perform private.require_role(array['policy_role']);perform private.lock_mission(p_mission);select *into strict r from public.sourcing_campaign_recipients where mission_id=p_mission and id=p_recipient;select *into strict c from public.sourcing_campaigns where mission_id=p_mission and id=r.campaign_id;
 if not exists(select from public.provider_receipts pr join public.effect_authorizations a on a.mission_id=pr.mission_id and a.id=pr.authorization_id join public.messages m on m.mission_id=pr.mission_id and m.receipt_id=pr.id join public.threads t on t.mission_id=m.mission_id and t.id=m.thread_id join public.artifact_versions v on v.id=c.rfq_version_id and v.mission_id=c.mission_id
 where pr.mission_id=p_mission and pr.id=p_receipt and pr.operation='send_message'and pr.sandbox_mode=(select sandbox_mode from public.missions where id=p_mission)and a.intent->>'taskId'=r.task_id::text and a.intent->>'counterpartyId'=r.supplier_id::text and exists(select from public.artifact_versions source where source.mission_id=p_mission and source.id::text=a.intent->>'artifactVersionId'and(source.id=c.rfq_version_id or source.content->>'originatingTaskId'=r.task_id::text)and source.content->'payload'=v.content->'payload') and a.intent->>'channel'='email'and a.intent->>'purpose'='quotation_request'and m.direction='outbound'and m.channel='email'and t.counterparty_id=r.supplier_id and m.original=v.content#>>'{payload,text}')then raise exception 'invariant_violation: identical approved RFQ and matching recorded provider receipt required';end if;
 select id into result from public.sourcing_campaign_deliveries where recipient_id=r.id;if result is not null then return result;end if;
 insert into public.sourcing_campaign_deliveries(mission_id,recipient_id,receipt_id,rfq_version_id,spec_version_id)values(p_mission,r.id,p_receipt,c.rfq_version_id,c.spec_version_id)returning id into result;
 insert into public.outbox(mission_id,type,payload)values(p_mission,'sourcing.rfq_delivered',jsonb_build_object('campaignId',c.id,'supplierId',r.supplier_id,'rfqVersionId',c.rfq_version_id,'specVersionId',c.spec_version_id,'receiptId',p_receipt));return result;
end$$;
create function public.hold_sourcing_campaign_recipient(p_mission uuid,p_recipient uuid,p_status text,p_reason text)returns void language plpgsql security definer set search_path=''as $$begin
 perform private.require_role(array['policy_role']);perform private.lock_mission(p_mission);
 if not exists(select from public.sourcing_campaign_recipients where mission_id=p_mission and id=p_recipient)or p_status not in('draft','blocked','ambiguous')or length(coalesce(p_reason,''))not between 1 and 500 then raise exception 'validation: bounded scoped campaign hold required';end if;
 if not exists(select from public.sourcing_campaign_holds where mission_id=p_mission and recipient_id=p_recipient and status=p_status and reason=p_reason)then insert into public.sourcing_campaign_holds(mission_id,recipient_id,status,reason)values(p_mission,p_recipient,p_status,p_reason);end if;
end$$;
create function private.campaign_assessment_current(p_mission uuid,p_assessment uuid,p_supplier uuid,p_spec uuid)returns boolean language sql stable security definer set search_path=''as $$
 select exists(select from public.sourcing_assessments a join public.sourcing_quote_ingestions q on q.mission_id=a.mission_id and q.id=a.ingestion_id join public.mandates m on m.mission_id=a.mission_id and m.id=a.negotiation_mandate_id
 where a.mission_id=p_mission and a.id=p_assessment and q.supplier_id=p_supplier and a.spec_version_id=p_spec and a.assessment->>'eligible'='true'and q.status='confirmed_reading'and private.readiness_date(q.quote->>'validUntil')>clock_timestamp()and private.readiness_current_approved(p_mission,p_spec)
 and not exists(select from public.stale_marks s where s.node_id=q.source_evidence_id)and not exists(select from public.evidence e where e.supersedes_id=q.source_evidence_id)
 and exists(select from public.sourcing_assessments score where score.mission_id=p_mission and score.ingestion_id=q.id and score.spec_version_id=p_spec and score.assessment->>'kind'='scorecard'and jsonb_array_length(score.assessment->'cells')=8)
 and m.type='negotiation'and m.expires_at>clock_timestamp()and m.scope->'counterpartyIds'?p_supplier::text and exists(select from public.active_decisions d where d.id=m.decision_id and d.mission_id=p_mission)and not exists(select from public.mandate_revocations r where r.mandate_id=m.id)
 and not exists(select from public.sourcing_assessments n where n.mission_id=p_mission and n.ingestion_id=q.id and n.spec_version_id=p_spec and n.assessment?'eligible'and(n.created_at,n.id)>(a.created_at,a.id))
 and not exists(select from jsonb_array_elements_text(a.assessment->'verificationEvidenceIds')ref where not exists(select from public.evidence e where e.id::text=ref.value and e.mission_id=p_mission and e.trust in('verified','founder_confirmed')and not exists(select from public.stale_marks s where s.node_id=e.id)and not exists(select from public.evidence n where n.supersedes_id=e.id))))
$$;
create function private.campaign_shortlist_current(p_mission uuid,p_campaign uuid)returns boolean language plpgsql stable security definer set search_path=''as $$
declare s public.sourcing_campaign_shortlists;c public.sourcing_campaigns;comparison jsonb;supplier uuid;row jsonb;r public.sourcing_campaign_recipients;begin
 c:=private.campaign_current(p_mission,p_campaign);select *into s from public.sourcing_campaign_shortlists where mission_id=p_mission and campaign_id=c.id;if s.id is null then return false;end if;
 select v.content into comparison from public.artifact_versions v where v.mission_id=p_mission and v.id=s.comparison_version_id and not exists(select from public.artifact_versions n where n.artifact_id=v.artifact_id and n.version_no>v.version_no)and not exists(select from public.stale_marks mark where mark.node_id=v.id)and(select status from public.artifact_statuses st where st.artifact_version_id=v.id order by created_at desc,id desc limit 1)in('proposed','approved');
 if comparison->>'specVersionId'is distinct from c.spec_version_id::text then return false;end if;
 foreach supplier in array s.supplier_ids loop
  select value into row from jsonb_array_elements(comparison->'ranking')where value->>'supplierId'=supplier::text;
  select *into r from public.sourcing_campaign_recipients where mission_id=p_mission and campaign_id=c.id and supplier_id=supplier;
  if row is null or r.id is null or not private.campaign_candidate_current(p_mission,supplier,r.email,r.verification_evidence_ids)or not private.campaign_assessment_current(p_mission,(row->>'assessmentId')::uuid,supplier,c.spec_version_id)or not exists(select from public.sourcing_campaign_deliveries where recipient_id=r.id)then return false;end if;
 end loop;return true;
end$$;
create function public.shortlist_sourcing_campaign(p_mission uuid,p_campaign uuid,p_comparison uuid,p_suppliers uuid[])returns uuid language plpgsql security definer set search_path=''as $$
declare c public.sourcing_campaigns;result uuid;begin
 perform private.require_role(array['specialist_role']);perform private.lock_mission(p_mission);c:=private.campaign_current(p_mission,p_campaign);
 if cardinality(p_suppliers)not between 3 and 5 or cardinality(p_suppliers)<>(select count(distinct x)from unnest(p_suppliers)x)or not exists(select from public.artifact_versions v join public.artifacts a on a.id=v.artifact_id where v.mission_id=p_mission and v.id=p_comparison and a.type='supplier_comparison')then raise exception 'validation: three to five distinct compared suppliers required';end if;
 if(select count(*)from public.sourcing_campaign_deliveries d join public.sourcing_campaign_recipients r on r.id=d.recipient_id where r.campaign_id=c.id)<>(select count(*)from public.sourcing_campaign_recipients where campaign_id=c.id)then raise exception 'needs_approval: identical RFQ fan-out is not receipt-complete';end if;
 select id into result from public.sourcing_campaign_shortlists where campaign_id=c.id;
 if result is not null then if not exists(select from public.sourcing_campaign_shortlists where id=result and comparison_version_id=p_comparison and supplier_ids=p_suppliers)then raise exception 'invariant_violation: campaign shortlist frozen; revise campaign sources';end if;return result;end if;
 insert into public.sourcing_campaign_shortlists(mission_id,campaign_id,comparison_version_id,supplier_ids)values(p_mission,c.id,p_comparison,p_suppliers)returning id into result;
 if not private.campaign_shortlist_current(p_mission,c.id)then raise exception 'needs_approval: shortlist lacks current eligible assessment, consent or approved spec';end if;return result;
end$$;
create function private.campaign_paid_samples(p_mission uuid,p_campaign uuid)returns integer language sql stable security definer set search_path=''as $$
 select count(distinct s.supplier_id)::integer from public.sourcing_campaign_samples s join public.payments p on p.id=s.payment_id and p.mission_id=s.mission_id
 where s.mission_id=p_mission and s.campaign_id=p_campaign and exists(select from public.payment_states ps where ps.payment_id=p.id and ps.state='captured'and ps.confirmation_event_id is not null)and coalesce((select sum(f.amount_minor)from public.payment_refunds f join public.refund_confirmations c on c.refund_id=f.id where f.payment_id=p.id),0)<p.amount_minor
$$;
create function public.register_sourcing_campaign_sample(p_mission uuid,p_campaign uuid,p_payment uuid,p_arrival timestamptz,p_tracking text)returns uuid language plpgsql security definer set search_path=''as $$
declare c public.sourcing_campaigns;p public.payments;content jsonb;result uuid;commitment uuid;begin
 perform private.require_role(array['policy_role']);perform private.lock_mission(p_mission);select *into strict c from public.sourcing_campaigns where mission_id=p_mission and id=p_campaign;
 -- A completed payment remains a historical fact after its source changes.
 -- Dispatch already checked the live shortlist; accounting must not lose it.
 if not exists(select from public.sourcing_campaign_shortlists where mission_id=p_mission and campaign_id=c.id)then raise exception 'validation: frozen campaign shortlist required';end if;
 select *into strict p from public.payments where mission_id=p_mission and id=p_payment;select v.content->'sampleOrder'into content from public.artifact_versions v where v.mission_id=p_mission and v.id=p.artifact_version_id;
 if content->>'campaignId'is distinct from c.id::text or content->>'specVersionId'is distinct from c.spec_version_id::text or content->>'supplierId'is distinct from p.payee_id::text or not exists(select from public.sourcing_campaign_shortlists where campaign_id=c.id and p.payee_id=any(supplier_ids))or p.sandbox_mode is distinct from(select sandbox_mode from public.missions where id=p_mission)then raise exception 'validation: confirmed sample payment must bind campaign, spec and shortlisted payee';end if;
 if not exists(select from public.payment_states s join public.provider_receipts r on r.id=s.receipt_id and r.mission_id=s.mission_id join public.events e on e.id=s.confirmation_event_id and e.mission_id=s.mission_id where s.mission_id=p_mission and s.payment_id=p.id and s.state='captured'and e.signature_verified and r.operation in('payment_capture','payment_authorization_capture'))then raise exception 'invariant_violation: actual confirmed sample payment required';end if;
 if p_arrival is null or not isfinite(p_arrival)or length(trim(coalesce(p_tracking,'')))not between 1 and 500 then raise exception 'validation: sample arrival and tracking reference or tracking-request commitment required';end if;
 select id into result from public.sourcing_campaign_samples where payment_id=p.id;if result is not null then return result;end if;
 commitment:=public.open_commitment(p_mission,p.payee_id,'inbound','Paid sample delivery; tracking reference: '||p_tracking,p_arrival);
 insert into public.sourcing_campaign_samples(mission_id,campaign_id,payment_id,supplier_id,commitment_id,tracking_reference)values(p_mission,c.id,p.id,p.payee_id,commitment,p_tracking)returning id into result;return result;
end$$;
create function public.link_sourcing_campaign_proforma(p_mission uuid,p_campaign uuid,p_version uuid)returns uuid language plpgsql security definer set search_path=''as $$
declare c public.sourcing_campaigns;invoice jsonb;supplier uuid;result uuid;ref text;begin
 perform private.require_role(array['specialist_role']);perform private.lock_mission(p_mission);c:=private.campaign_current(p_mission,p_campaign);
 if not private.campaign_shortlist_current(p_mission,c.id)or private.campaign_paid_samples(p_mission,c.id)<2 then raise exception 'needs_approval: current shortlist and paid samples from two suppliers required before proforma';end if;
 perform private.check_version(p_mission,p_version);select v.content->'proformaInvoice'into invoice from public.artifact_versions v join public.artifacts a on a.id=v.artifact_id where v.mission_id=p_mission and v.id=p_version and a.type='proforma_invoice';supplier:=(invoice->>'supplierId')::uuid;
 if not private.readiness_proforma(jsonb_build_object('proformaInvoice',invoice))or invoice->>'specVersionId'is distinct from c.spec_version_id::text or invoice->'stamped'is distinct from'true'::jsonb or not exists(select from public.sourcing_campaign_samples where campaign_id=c.id and supplier_id=supplier)then raise exception 'validation: stamped approved proforma with sampled supplier and exact spec required';end if;
 if jsonb_typeof(invoice->'stampEvidenceIds')is distinct from'array'or jsonb_array_length(invoice->'stampEvidenceIds')<1 then raise exception 'validation: stamped proforma source document required';end if;
 for ref in select jsonb_array_elements_text(invoice->'stampEvidenceIds')loop if not exists(select from public.evidence e where e.mission_id=p_mission and e.id::text=ref and e.payload->>'supplierId'=supplier::text and e.trust in('claimed','verified','founder_confirmed')and e.source_type in('document','message')and not exists(select from public.stale_marks s where s.node_id=e.id)and not exists(select from public.evidence n where n.supersedes_id=e.id))then raise exception 'validation: current supplier proforma document required';end if;end loop;
 insert into public.dependencies(mission_id,upstream_id,dependent_id,reason)values(p_mission,c.spec_version_id,p_version,'campaign proforma exact spec')on conflict do nothing;
 for ref in select jsonb_array_elements_text(invoice->'stampEvidenceIds')loop insert into public.dependencies(mission_id,upstream_id,dependent_id,reason)values(p_mission,ref::uuid,p_version,'stamped proforma document')on conflict do nothing;end loop;
 select id into result from public.sourcing_campaign_proformas where campaign_id=c.id;if result is not null then if not exists(select from public.sourcing_campaign_proformas where id=result and proforma_version_id=p_version)then raise exception 'invariant_violation: proforma binding frozen';end if;return result;end if;
 insert into public.sourcing_campaign_proformas(mission_id,campaign_id,proforma_version_id,supplier_id)values(p_mission,c.id,p_version,supplier)returning id into result;return result;
end$$;
create function public.link_sourcing_campaign_inspection(p_mission uuid,p_campaign uuid,p_commitment uuid)returns uuid language plpgsql security definer set search_path=''as $$declare c public.sourcing_campaigns;result uuid;begin
 perform private.require_role(array['specialist_role']);perform private.lock_mission(p_mission);c:=private.campaign_current(p_mission,p_campaign);
 if not exists(select from public.sourcing_campaign_proformas p join public.inspection_commitments i on i.mission_id=p.mission_id and i.proforma_version_id=p.proforma_version_id where p.mission_id=p_mission and p.campaign_id=c.id and i.commitment_id=p_commitment and i.spec_version_id=c.spec_version_id and i.purpose='pre_shipment_before_balance'and not exists(select from public.stale_marks s where s.node_id=i.commitment_id))then raise exception 'validation: exact typed proforma/spec inspection commitment required';end if;
 select id into result from public.sourcing_campaign_inspections where campaign_id=c.id;if result is not null then if not exists(select from public.sourcing_campaign_inspections where id=result and commitment_id=p_commitment)then raise exception 'invariant_violation: inspection binding frozen';end if;return result;end if;
 insert into public.sourcing_campaign_inspections(mission_id,campaign_id,commitment_id)values(p_mission,c.id,p_commitment)returning id into result;return result;
end$$;
create function public.prepare_sourcing_rfq(p_mission uuid,p_spec uuid,p_rfq jsonb)returns uuid language plpgsql security definer set search_path=''as $$
declare spec jsonb;art uuid;version uuid;ref text;payload jsonb;component jsonb;dimension jsonb;begin
 perform private.require_role(array['specialist_role']);perform private.lock_mission(p_mission);perform private.check_version(p_mission,p_spec);
 select v.content into spec from public.artifact_versions v join public.artifacts a on a.id=v.artifact_id and a.mission_id=v.mission_id where v.mission_id=p_mission and v.id=p_spec and a.type='product_spec'and a.outcome='product';
 if spec is null or jsonb_typeof(spec->'components')is distinct from'array'or jsonb_array_length(spec->'components')=0 then raise exception 'validation: approved component specification required';end if;
 for component in select value from jsonb_array_elements(spec->'components')loop
  if length(trim(coalesce(component->>'name','')))=0 or length(trim(coalesce(component->>'material','')))=0 or length(trim(coalesce(component->>'finish','')))=0 or jsonb_typeof(component->'dimensions')is distinct from'object'or component->'dimensions'='{}'::jsonb or jsonb_typeof(component->'tolerances')is distinct from'object'then raise exception 'validation: manufacturing brief needs component material, finish, dimensions and tolerances';end if;
  for dimension in select value from jsonb_each(component->'dimensions')loop if jsonb_typeof(dimension)is distinct from'number'or dimension::numeric<=0 then raise exception 'validation: physical component dimensions required';end if;end loop;
 end loop;
 if p_rfq is null or jsonb_typeof(p_rfq)is distinct from'object'or not(p_rfq?&array['quantityMin','quantityMax','targetDate','artworkVersionIds','language','subject'])or p_rfq-array['quantityMin','quantityMax','targetDate','artworkVersionIds','language','subject']<>'{}'::jsonb
 or jsonb_typeof(p_rfq->'quantityMin')is distinct from'number'or jsonb_typeof(p_rfq->'quantityMax')is distinct from'number'or coalesce(p_rfq->>'quantityMin','')!~'^[1-9][0-9]{0,8}$'or coalesce(p_rfq->>'quantityMax','')!~'^[1-9][0-9]{0,8}$'or(p_rfq->>'quantityMin')::bigint>(p_rfq->>'quantityMax')::bigint
 or coalesce(private.readiness_date(p_rfq->>'targetDate')>clock_timestamp(),false)<>true or coalesce(p_rfq->>'language','')not in('en','ar')or length(trim(coalesce(p_rfq->>'subject','')))not between 1 and 200 or jsonb_typeof(p_rfq->'artworkVersionIds')is distinct from'array'then raise exception 'validation: complete bounded RFQ brief required';end if;
 for ref in select jsonb_array_elements_text(p_rfq->'artworkVersionIds')loop perform private.check_version(p_mission,ref::uuid);end loop;
 payload:=private.rfq_payload(p_spec,spec,p_rfq);if length(payload->>'text')>10000 then raise exception 'validation: RFQ exceeds guarded channel size; prepare a bounded approved specification';end if;
 art:=public.create_artifact(p_mission,'rfq','supply','Identical supplier request for quotation');version:=public.append_artifact_version(p_mission,art,jsonb_build_object('rfq',p_rfq||jsonb_build_object('specVersionId',p_spec),'payload',payload));
 insert into public.dependencies(mission_id,upstream_id,dependent_id,reason)values(p_mission,p_spec,version,'RFQ exact approved specification')on conflict do nothing;
 for ref in select jsonb_array_elements_text(p_rfq->'artworkVersionIds')loop insert into public.dependencies(mission_id,upstream_id,dependent_id,reason)values(p_mission,ref::uuid,version,'RFQ approved artwork')on conflict do nothing;end loop;
 perform public.set_artifact_status(p_mission,version,'proposed');return version;
end$$;
create function private.campaign_candidate_current(p_mission uuid,p_supplier uuid,p_email text,p_evidence uuid[])returns boolean language sql stable security definer set search_path=''as $$
 select exists(select from public.counterparties c join public.missions m on m.founder_id=c.founder_id where m.id=p_mission and c.id=p_supplier and c.kind='supplier'and not c.opt_out and c.channels->>'email'=p_email and c.verification->>'emailVerified'='true'and not exists(select from public.counterparty_optouts o where o.counterparty_id=c.id))
 and cardinality(p_evidence)>=2 and not exists(select from unnest(p_evidence)ref where not exists(select from public.evidence e where e.mission_id=p_mission and e.id=ref and e.payload->>'supplierId'=p_supplier::text and e.trust in('verified','founder_confirmed')and length(coalesce(e.payload->>'independentSource',''))>0 and not exists(select from public.stale_marks s where s.mission_id=p_mission and s.node_id=e.id)and not exists(select from public.evidence n where n.mission_id=p_mission and n.supersedes_id=e.id)))
 and(select count(distinct e.payload->>'independentSource')from public.evidence e where e.mission_id=p_mission and e.id=any(p_evidence))>=2
 and exists(select from public.evidence e where e.mission_id=p_mission and e.id=any(p_evidence)and e.payload->>'signalKind'in('registry','marketplace_history'))
$$;
create function public.confirm_sourcing_campaign_exception(p_mission uuid,p_decision uuid,p_version uuid)returns uuid language plpgsql security definer set search_path=''as $$
declare c jsonb;ref text;id uuid;begin
 perform private.require_role(array['founder_role']);perform private.lock_mission(p_mission);
 select v.content->'founderConfirmation'into c from public.artifact_versions v join public.active_decisions d on d.mission_id=v.mission_id and d.id=p_decision where v.mission_id=p_mission and v.id=p_version and d.kind='engagement'and d.outcome='supply'and d.gate='sourcing_campaign_exception'and v.id in(select private.selected_approved_versions(p_mission,p_decision))and private.readiness_current_approved(p_mission,v.id);
 if c is null or c->>'kind'is distinct from'sourcing_campaign_exception'or c->>'outcome'is distinct from'supply'or length(trim(coalesce(c->>'statement','')))=0 or c#>'{payload,riskAccepted}'is distinct from'true'::jsonb or c#>>'{payload,exception}'is distinct from'rfq_candidate_count'or jsonb_typeof(c#>'{payload,supplierIds}')is distinct from'array'or jsonb_array_length(c#>'{payload,supplierIds}')not between 1 and 7 or jsonb_typeof(c#>'{payload,sourceEvidenceIds}')is distinct from'array'or jsonb_array_length(c#>'{payload,sourceEvidenceIds}')<1 then raise exception 'needs_approval: explicit narrow RFQ-count exception required';end if;
 perform private.check_version(p_mission,(c#>>'{payload,rfqVersionId}')::uuid);
 for ref in select jsonb_array_elements_text(c#>'{payload,sourceEvidenceIds}')loop if not exists(select from public.evidence e where e.mission_id=p_mission and e.id::text=ref and e.trust<>'planned'and not exists(select from public.stale_marks s where s.node_id=e.id)and not exists(select from public.evidence n where n.supersedes_id=e.id))then raise exception 'validation: current supply-limit evidence required';end if;end loop;
 select e.id into id from public.evidence e where e.mission_id=p_mission and e.kind='sourcing_campaign_exception'and e.source_reference='campaign-exception:'||p_decision::text||':'||p_version::text;if id is not null then return id;end if;
 id:=public.append_evidence(p_mission,'supply','sourcing_campaign_exception','founder_confirmed',c->'payload'||jsonb_build_object('statement',c->>'statement','confirmedAt',clock_timestamp(),'decisionId',p_decision,'artifactVersionId',p_version),'document','campaign-exception:'||p_decision::text||':'||p_version::text);
 insert into public.dependencies(mission_id,upstream_id,dependent_id,reason)values(p_mission,p_version,id,'narrow founder exception'),(p_mission,p_decision,id,'selected exception approval'),(p_mission,(c#>>'{payload,rfqVersionId}')::uuid,id,'exception exact RFQ');
 for ref in select jsonb_array_elements_text(c#>'{payload,sourceEvidenceIds}')loop insert into public.dependencies(mission_id,upstream_id,dependent_id,reason)values(p_mission,ref::uuid,id,'supply-limit exception evidence')on conflict do nothing;end loop;return id;
end$$;
create function private.campaign_exception_current(p_mission uuid,p_evidence uuid,p_rfq uuid,p_suppliers uuid[])returns boolean language sql stable security definer set search_path=''as $$
 select exists(select from public.evidence e join public.active_decisions d on d.mission_id=e.mission_id and d.id::text=e.payload->>'decisionId'join public.artifact_versions v on v.mission_id=e.mission_id and v.id::text=e.payload->>'artifactVersionId'
 where e.mission_id=p_mission and e.id=p_evidence and e.kind='sourcing_campaign_exception'and e.trust='founder_confirmed'and d.kind='engagement'and d.gate='sourcing_campaign_exception'and e.payload->>'exception'='rfq_candidate_count'and e.payload->'riskAccepted'='true'::jsonb and e.payload->>'rfqVersionId'=p_rfq::text and private.readiness_date(e.payload->>'confirmedAt')<=clock_timestamp()
 and(array(select value::uuid from jsonb_array_elements_text(e.payload->'supplierIds')order by value::uuid))=(array(select distinct x from unnest(p_suppliers)x order by x))
 and v.id in(select private.selected_approved_versions(p_mission,d.id))and private.readiness_current_approved(p_mission,v.id)and v.content#>'{founderConfirmation,payload}'=e.payload-array['statement','confirmedAt','decisionId','artifactVersionId']and v.content#>>'{founderConfirmation,kind}'='sourcing_campaign_exception'and e.payload->>'statement'=v.content#>>'{founderConfirmation,statement}'and not exists(select from public.stale_marks s where s.mission_id=p_mission and s.node_id=e.id)and not exists(select from public.evidence n where n.mission_id=p_mission and n.supersedes_id=e.id))
$$;
create function public.create_sourcing_campaign(p_mission uuid,p_rfq uuid,p_recipients jsonb,p_key text,p_exception uuid default null)returns uuid language plpgsql security definer set search_path=''as $$
declare content jsonb;spec jsonb;spec_id uuid;ids uuid[];recipient jsonb;evidence uuid[];email text;campaign uuid;hash text;prior public.sourcing_campaigns;begin
 perform private.require_role(array['specialist_role']);perform private.lock_mission(p_mission);perform private.check_version(p_mission,p_rfq);
 select v.content into content from public.artifact_versions v join public.artifacts a on a.id=v.artifact_id and a.mission_id=v.mission_id where v.id=p_rfq and v.mission_id=p_mission and a.type='rfq'and a.outcome='supply';spec_id:=(content#>>'{rfq,specVersionId}')::uuid;perform private.check_version(p_mission,spec_id);select v.content into spec from public.artifact_versions v where v.id=spec_id and v.mission_id=p_mission;
 if content is null or spec is null or content->'payload'is distinct from private.rfq_payload(spec_id,spec,(content->'rfq')-'specVersionId')or coalesce(private.readiness_date(content#>>'{rfq,targetDate}')>clock_timestamp(),false)<>true then raise exception 'validation: exact canonical current approved RFQ required';end if;
 if p_key is null or length(p_key)not between 16 and 256 or jsonb_typeof(p_recipients)is distinct from'array'or jsonb_array_length(p_recipients)not between 1 and 50 then raise exception 'validation: bounded recipient list and retry key required';end if;
 select array_agg((r->>'supplierId')::uuid order by r->>'supplierId')into ids from jsonb_array_elements(p_recipients)r;
 if cardinality(ids)<>(select count(distinct x)from unnest(ids)x)then raise exception 'validation: duplicate campaign supplier';end if;
 if cardinality(ids)<8 and not private.campaign_exception_current(p_mission,p_exception,p_rfq,ids)then raise exception 'needs_approval: at least eight verified suppliers or exact dated founder count exception required';end if;
 hash:=encode(public.digest(jsonb_build_array(p_rfq,p_recipients,p_exception)::text,'sha256'),'hex');select *into prior from public.sourcing_campaigns where mission_id=p_mission and request_key=p_key;
 if prior.id is not null then if prior.request_hash<>hash then raise exception 'invariant_violation: campaign retry changed';end if;return prior.id;end if;
 insert into public.sourcing_campaigns(mission_id,rfq_version_id,spec_version_id,request_key,request_hash,exception_evidence_id)values(p_mission,p_rfq,spec_id,p_key,hash,p_exception)returning id into campaign;
 for recipient in select value from jsonb_array_elements(p_recipients)loop
  if recipient-array['supplierId','verificationEvidenceIds','mandateId']<>'{}'::jsonb or not(recipient?&array['supplierId','verificationEvidenceIds','mandateId'])then raise exception 'validation: typed campaign recipient required';end if;
  select array_agg(value::uuid)into evidence from jsonb_array_elements_text(recipient->'verificationEvidenceIds');select c.channels->>'email'into email from public.counterparties c where c.id=(recipient->>'supplierId')::uuid;
  if not private.campaign_candidate_current(p_mission,(recipient->>'supplierId')::uuid,email,evidence)then raise exception 'needs_approval: current verified supplier and consented email required';end if;
  if not exists(select from public.mandates m where m.mission_id=p_mission and m.id=(recipient->>'mandateId')::uuid and m.type='outreach'and m.expires_at>clock_timestamp()and m.scope->'counterpartyIds'?(recipient->>'supplierId')and m.scope->'actions'?'send_message'and m.scope->'channels'?'email'and m.scope->'purposes'?'quotation_request'and exists(select from public.active_decisions d where d.id=m.decision_id)and not exists(select from public.mandate_revocations r where r.mandate_id=m.id))then raise exception 'needs_approval: current scoped RFQ outreach mandate required';end if;
  insert into public.sourcing_campaign_recipients(mission_id,campaign_id,supplier_id,email,verification_evidence_ids,mandate_id)values(p_mission,campaign,(recipient->>'supplierId')::uuid,email,evidence,(recipient->>'mandateId')::uuid);
 end loop;return campaign;
end$$;

create function public.confirm_sourcing_campaign_inspection(p_mission uuid,p_decision uuid,p_version uuid)returns uuid language plpgsql security definer set search_path=''as $$
declare confirmation jsonb;c public.sourcing_campaigns;i public.inspection_commitments;ref text;fact uuid;begin
 perform private.require_role(array['founder_role']);perform private.lock_mission(p_mission);
 select v.content->'founderConfirmation'into confirmation from public.artifact_versions v join public.active_decisions d on d.id=p_decision and d.mission_id=v.mission_id where v.id=p_version and v.mission_id=p_mission and d.kind='engagement'and d.outcome='supply'and d.gate='campaign_inspection_result'and v.id in(select private.selected_approved_versions(p_mission,p_decision))and private.readiness_current_approved(p_mission,v.id);
 if confirmation is null or confirmation->>'kind'is distinct from'campaign_inspection_result'or confirmation->>'outcome'is distinct from'supply'or length(trim(coalesce(confirmation->>'statement','')))=0 or coalesce(confirmation#>>'{payload,result}','')not in('clean','failed')or jsonb_typeof(confirmation#>'{payload,sourceEvidenceIds}')is distinct from'array'or jsonb_array_length(confirmation#>'{payload,sourceEvidenceIds}')<1 then raise exception 'needs_approval: selected explicit inspection report confirmation required';end if;
 c:=private.campaign_current(p_mission,(confirmation#>>'{payload,campaignId}')::uuid);
 select inspection.*into i from public.sourcing_campaign_inspections linked join public.inspection_commitments inspection on inspection.commitment_id=linked.commitment_id and inspection.mission_id=linked.mission_id where linked.mission_id=p_mission and linked.campaign_id=c.id and linked.commitment_id::text=confirmation#>>'{payload,commitmentId}';
 if i.commitment_id is null or not private.readiness_current_approved(p_mission,i.proforma_version_id)then raise exception 'validation: exact current campaign inspection required';end if;
 for ref in select jsonb_array_elements_text(confirmation#>'{payload,sourceEvidenceIds}')loop if not exists(select from public.evidence e where e.mission_id=p_mission and e.id::text=ref and e.payload->>'inspectionCommitmentId'=i.commitment_id::text and e.trust in('claimed','verified','founder_confirmed')and e.source_type in('document','message','url')and not exists(select from public.stale_marks s where s.node_id=e.id)and not exists(select from public.evidence n where n.supersedes_id=e.id))then raise exception 'validation: current source report for this exact inspection required';end if;end loop;
 select id into fact from public.evidence where mission_id=p_mission and source_reference='campaign-inspection:'||p_decision::text||':'||p_version::text;if fact is not null then return fact;end if;
 fact:=public.append_evidence(p_mission,'supply',case when confirmation#>>'{payload,result}'='clean'then'inspection_completed'else'inspection_failed'end,'founder_confirmed',confirmation->'payload'||jsonb_build_object('commitmentId',i.commitment_id,'proformaVersionId',i.proforma_version_id,'specVersionId',i.spec_version_id,'statement',confirmation->>'statement','confirmedAt',clock_timestamp(),'decisionId',p_decision,'artifactVersionId',p_version),'document','campaign-inspection:'||p_decision::text||':'||p_version::text);
 insert into public.dependencies(mission_id,upstream_id,dependent_id,reason)values(p_mission,p_version,fact,'selected report confirmation'),(p_mission,p_decision,fact,'founder report decision'),(p_mission,i.proforma_version_id,fact,'report exact proforma'),(p_mission,i.spec_version_id,fact,'report exact spec');
 for ref in select jsonb_array_elements_text(confirmation#>'{payload,sourceEvidenceIds}')loop insert into public.dependencies(mission_id,upstream_id,dependent_id,reason)values(p_mission,ref::uuid,fact,'actual inspection report source')on conflict do nothing;end loop;
 if confirmation#>>'{payload,result}'='clean'then insert into public.dependencies(mission_id,upstream_id,dependent_id,reason)values(p_mission,fact,i.commitment_id,'clean inspection report closure')on conflict do nothing;insert into public.commitment_states(mission_id,commitment_id,status,closed_by_evidence_id)values(p_mission,i.commitment_id,'closed',fact);end if;
 return fact;
end$$;
create function private.check_campaign_payment_version(p_mission uuid,p_version uuid)returns void language plpgsql stable security definer set search_path=''as $$
declare v jsonb;metadata jsonb;c public.sourcing_campaigns;supplier uuid;phase text;invoice jsonb;proforma public.sourcing_campaign_proformas;begin
 select content into v from public.artifact_versions where mission_id=p_mission and id=p_version;
 if not(v?'sampleOrder')and not(v?'campaignPayment')then
  if v#>>'{effectIntent,action}'='payment_capture'and exists(select from public.sourcing_campaign_recipients r where r.mission_id=p_mission and r.supplier_id::text=v#>>'{effectIntent,counterpartyId}')then raise exception 'needs_approval: campaign supplier payment requires explicit sample or production phase binding';end if;return;
 end if;
 if v#>>'{effectIntent,action}'in('payment_refund','payment_authorization_void')then return;end if;
 if v?'sampleOrder'and v?'campaignPayment'then raise exception 'validation: one campaign payment phase required';end if;
 metadata:=coalesce(v->'sampleOrder',v->'campaignPayment');c:=private.campaign_current(p_mission,(metadata->>'campaignId')::uuid);supplier:=(metadata->>'supplierId')::uuid;
 if metadata->>'specVersionId'is distinct from c.spec_version_id::text or not private.campaign_shortlist_current(p_mission,c.id)or not exists(select from public.sourcing_campaign_shortlists where campaign_id=c.id and supplier=any(supplier_ids))or v#>>'{effectIntent,counterpartyId}'is distinct from supplier::text then raise exception 'needs_approval: current campaign spec, shortlist and exact payment payee required';end if;
 if v?'sampleOrder'then return;end if;
 phase:=metadata->>'stage';if phase is null or phase not in('deposit','balance')or private.campaign_paid_samples(p_mission,c.id)<2 then raise exception 'needs_approval: two actually paid supplier samples required before production payment';end if;
 select *into proforma from public.sourcing_campaign_proformas where campaign_id=c.id and mission_id=p_mission and supplier_id=supplier and proforma_version_id::text=metadata->>'proformaVersionId';
 if proforma.id is null or not private.readiness_current_approved(p_mission,proforma.proforma_version_id)then raise exception 'needs_approval: current approved bound proforma required before deposit';end if;
 select content->'proformaInvoice'into invoice from public.artifact_versions where mission_id=p_mission and id=proforma.proforma_version_id;
 if v#>>'{effectIntent,currency}'is distinct from invoice->>'currency'or coalesce(v#>>'{effectIntent,amountMinor}','')!~'^[1-9][0-9]{0,14}$'or(v#>>'{effectIntent,amountMinor}')::numeric>(invoice->>'amountMinor')::numeric then raise exception 'needs_approval: production payment must match proforma currency and not exceed invoice total';end if;
 if phase='balance'and not exists(select from public.sourcing_campaign_inspections linked join public.inspection_commitments i on i.commitment_id=linked.commitment_id and i.mission_id=linked.mission_id join public.commitment_states state on state.commitment_id=i.commitment_id and state.status='closed'join public.evidence e on e.id=state.closed_by_evidence_id and e.mission_id=state.mission_id where linked.mission_id=p_mission and linked.campaign_id=c.id and i.proforma_version_id=proforma.proforma_version_id and i.spec_version_id=c.spec_version_id and i.commitment_id::text=metadata->>'inspectionCommitmentId'and e.kind='inspection_completed'and e.trust in('verified','founder_confirmed')and e.payload->>'result'='clean'and e.payload->>'commitmentId'=i.commitment_id::text and e.payload->>'proformaVersionId'=i.proforma_version_id::text and e.payload->>'specVersionId'=i.spec_version_id::text and not exists(select from public.stale_marks mark where mark.node_id in(i.commitment_id,e.id))and not exists(select from public.evidence n where n.supersedes_id=e.id)and(select status from public.commitment_states latest where latest.commitment_id=i.commitment_id order by created_at desc,id desc limit 1)='closed')then raise exception 'needs_approval: exact current clean inspection report required before balance';end if;
end$$;
-- Extend the existing source-aware guard without replacing or weakening its
-- preceding supplier, specification, shipping and approval checks. Both reserve
-- and the second locked begin_effect invocation call the same function.
do $$declare before text;after text;begin
 before:=pg_get_functiondef('private.check_version(uuid,uuid)'::regprocedure);
 after:=replace(before,'if p_version is null then return;end if;','if p_version is null then return;end if; perform private.check_campaign_payment_version(p_mission,p_version);');
 if before=after then raise exception 'migration: version guard extension anchor changed; explicit review required';end if;execute after;
end$$;
create function public.sourcing_campaign_snapshot(p_mission uuid,p_campaign uuid)returns jsonb language plpgsql stable security definer set search_path=''as $$declare c public.sourcing_campaigns;current boolean:=true;shortlisted boolean:=false;begin
 perform private.require_role(array['founder_role','lead_role','specialist_role','policy_role']);perform private.assert_mission(p_mission);select *into strict c from public.sourcing_campaigns where mission_id=p_mission and id=p_campaign;
 begin perform private.campaign_current(p_mission,c.id);shortlisted:=private.campaign_shortlist_current(p_mission,c.id);exception when others then current:=false;end;
 if exists(select from public.sourcing_campaign_shortlists where campaign_id=c.id)and not shortlisted then current:=false;end if;
 if exists(select from public.sourcing_campaign_proformas p where p.campaign_id=c.id and not private.readiness_current_approved(p_mission,p.proforma_version_id))or exists(select from public.sourcing_campaign_inspections i where i.campaign_id=c.id and(exists(select from public.stale_marks mark where mark.node_id=i.commitment_id)or(select status from public.commitment_states st where st.commitment_id=i.commitment_id order by created_at desc,id desc limit 1)='cancelled'))then current:=false;end if;
 return jsonb_build_object('sandboxMode',(select sandbox_mode from public.missions where id=p_mission),'id',c.id,'rfqVersionId',c.rfq_version_id,'specVersionId',c.spec_version_id,'current',current,'recipientCount',(select count(*)from public.sourcing_campaign_recipients where campaign_id=c.id),'sentCount',(select count(*)from public.sourcing_campaign_deliveries d join public.sourcing_campaign_recipients r on r.id=d.recipient_id where r.campaign_id=c.id),'shortlistCurrent',shortlisted,'shortlistedSupplierIds',coalesce((select to_jsonb(supplier_ids)from public.sourcing_campaign_shortlists where campaign_id=c.id),'[]'::jsonb),'paidSampleSupplierCount',private.campaign_paid_samples(p_mission,c.id),'proformaVersionId',(select proforma_version_id from public.sourcing_campaign_proformas where campaign_id=c.id),'inspectionCommitmentId',(select commitment_id from public.sourcing_campaign_inspections where campaign_id=c.id),'exceptionEvidenceId',c.exception_evidence_id);
end$$;
revoke all on function private.rfq_payload(uuid,jsonb,jsonb),private.campaign_current(uuid,uuid),private.campaign_candidate_current(uuid,uuid,text,uuid[]),private.campaign_exception_current(uuid,uuid,uuid,uuid[]),private.campaign_assessment_current(uuid,uuid,uuid,uuid),private.campaign_shortlist_current(uuid,uuid),private.campaign_paid_samples(uuid,uuid),private.check_campaign_payment_version(uuid,uuid)from public;
revoke all on function public.prepare_sourcing_rfq(uuid,uuid,jsonb),public.create_sourcing_campaign(uuid,uuid,jsonb,text,uuid),public.next_sourcing_campaign_recipient(uuid,uuid),public.record_sourcing_campaign_delivery(uuid,uuid,uuid),public.hold_sourcing_campaign_recipient(uuid,uuid,text,text),public.shortlist_sourcing_campaign(uuid,uuid,uuid,uuid[]),public.register_sourcing_campaign_sample(uuid,uuid,uuid,timestamptz,text),public.link_sourcing_campaign_proforma(uuid,uuid,uuid),public.link_sourcing_campaign_inspection(uuid,uuid,uuid),public.confirm_sourcing_campaign_exception(uuid,uuid,uuid),public.confirm_sourcing_campaign_inspection(uuid,uuid,uuid),public.sourcing_campaign_snapshot(uuid,uuid)from public;
grant execute on function public.prepare_sourcing_rfq(uuid,uuid,jsonb),public.create_sourcing_campaign(uuid,uuid,jsonb,text,uuid),public.shortlist_sourcing_campaign(uuid,uuid,uuid,uuid[]),public.link_sourcing_campaign_proforma(uuid,uuid,uuid),public.link_sourcing_campaign_inspection(uuid,uuid,uuid)to specialist_role;
grant execute on function public.next_sourcing_campaign_recipient(uuid,uuid)to lead_role;
grant execute on function public.record_sourcing_campaign_delivery(uuid,uuid,uuid),public.hold_sourcing_campaign_recipient(uuid,uuid,text,text),public.register_sourcing_campaign_sample(uuid,uuid,uuid,timestamptz,text)to policy_role;
grant execute on function public.confirm_sourcing_campaign_exception(uuid,uuid,uuid),public.confirm_sourcing_campaign_inspection(uuid,uuid,uuid)to founder_role;
grant execute on function public.sourcing_campaign_snapshot(uuid,uuid)to founder_role,lead_role,specialist_role,policy_role;

create function private.check_sourcing_campaign_dispatch(p_mission uuid,p_intent jsonb)returns void language plpgsql stable security definer set search_path=''as $$
declare r public.sourcing_campaign_recipients;c public.sourcing_campaigns;source jsonb;rfq jsonb;begin
 select *into r from public.sourcing_campaign_recipients where mission_id=p_mission and task_id::text=p_intent->>'taskId';if r.id is null then return;end if;c:=private.campaign_current(p_mission,r.campaign_id);
 if not private.campaign_candidate_current(p_mission,r.supplier_id,r.email,r.verification_evidence_ids)or p_intent->>'action'is distinct from'send_message'or p_intent->>'channel'is distinct from'email'or p_intent->>'purpose'is distinct from'quotation_request'or p_intent->>'counterpartyId'is distinct from r.supplier_id::text or(p_intent?'mandateId'and p_intent->>'mandateId'is distinct from r.mandate_id::text) then raise exception 'needs_approval: campaign supplier consent, verification or dispatch identity changed';end if;
 select content into source from public.artifact_versions where mission_id=p_mission and id::text=p_intent->>'artifactVersionId';select content into rfq from public.artifact_versions where mission_id=p_mission and id=c.rfq_version_id;
 if source is null or source->'payload'is distinct from rfq->'payload'or(p_intent->>'artifactVersionId'<>c.rfq_version_id::text and source->>'originatingTaskId'is distinct from r.task_id::text)then raise exception 'needs_approval: campaign draft differs from identical approved RFQ';end if;
end$$;
revoke all on function private.check_sourcing_campaign_dispatch(uuid,jsonb)from public;
-- Root migration41 invokes this hook after the authorization SELECT in both
-- durable claim and locked dispatch begins, alongside the chase race correction.

do $$declare before text;after text;anchor text:='select * into strict v_a from public.effect_authorizations where mission_id=p_mission and id=p_authorization for update;';begin
 before:=pg_get_functiondef('public.begin_effect(uuid,uuid)'::regprocedure);
 after:=replace(before,anchor,anchor||' perform private.check_sourcing_campaign_dispatch(p_mission,v_a.intent);');
 if before=after then raise exception 'migration: effect dispatch extension anchor changed; explicit review required';end if;execute after;
end$$;

create function private.link_campaign_artifact_sources(p_mission uuid,p_version uuid,p_content jsonb)returns void language plpgsql security definer set search_path=''as $$
declare metadata jsonb;c public.sourcing_campaigns;ref uuid;refs uuid[];begin
 if not(p_content?'sampleOrder')and not(p_content?'campaignPayment')then return;end if;
 if p_content#>>'{effectIntent,action}'in('payment_refund','payment_authorization_void')then return;end if;
 metadata:=coalesce(p_content->'sampleOrder',p_content->'campaignPayment');select *into strict c from public.sourcing_campaigns where mission_id=p_mission and id=(metadata->>'campaignId')::uuid;
 if metadata->>'specVersionId'is distinct from c.spec_version_id::text then raise exception 'validation: campaign payment source specification differs';end if;
 refs:=array[c.spec_version_id,c.rfq_version_id];
 select refs||comparison_version_id into refs from public.sourcing_campaign_shortlists where campaign_id=c.id;
 if refs is null then refs:=array[c.spec_version_id,c.rfq_version_id];end if;
 if metadata?'proformaVersionId'then refs:=refs||array[(metadata->>'proformaVersionId')::uuid];end if;
 if metadata?'inspectionCommitmentId'then refs:=refs||array[(metadata->>'inspectionCommitmentId')::uuid];end if;
 foreach ref in array refs loop
  if not exists(select from public.state_nodes n where n.mission_id=p_mission and n.id=ref)then raise exception 'validation: scoped campaign source node required';end if;
  if exists(with recursive downstream(id)as(select p_version union select d.dependent_id from public.dependencies d join downstream x on x.id=d.upstream_id where d.mission_id=p_mission)select from downstream where id=ref)then raise exception 'validation: campaign dependency cycle';end if;
  insert into public.dependencies(mission_id,upstream_id,dependent_id,reason)values(p_mission,ref,p_version,'typed campaign payment source')on conflict do nothing;
  if exists(select from public.stale_marks mark where mark.mission_id=p_mission and mark.node_id=ref)then perform private.invalidate(p_mission,p_version,ref);end if;
 end loop;
end$$;
revoke all on function private.link_campaign_artifact_sources(uuid,uuid,jsonb)from public;
do $$declare before text;after text;begin
 before:=pg_get_functiondef('public.append_artifact_version(uuid,uuid,jsonb,uuid[],uuid[],uuid[],text[],text,uuid)'::regprocedure);
 if(length(before)-length(replace(before,'return v_id;','')))/length('return v_id;')<>1 then raise exception 'migration: artifact lineage extension anchor changed; explicit review required';end if;
 after:=replace(before,'return v_id;','perform private.link_campaign_artifact_sources(p_mission,v_id,p_content);return v_id;');execute after;
end$$;

-- Invoice exposure is cumulative across distinct approvals/versions. Only an
-- actual confirmed refund or completed void releases original provider units;
-- reserved, started and ambiguous authorizations remain fully exposed.
create function private.check_campaign_exposure(p_mission uuid,p_intent jsonb,p_authorization uuid default null)returns void language plpgsql stable security definer set search_path=''as $$
declare metadata jsonb;invoice jsonb;used numeric;amount numeric;begin
 if p_intent->>'action'is distinct from'payment_capture'then return;end if;
 select content->'campaignPayment'into metadata from public.artifact_versions where mission_id=p_mission and id::text=p_intent->>'artifactVersionId';if metadata is null then return;end if;
 select content->'proformaInvoice'into invoice from public.artifact_versions where mission_id=p_mission and id::text=metadata->>'proformaVersionId';
 amount:=(p_intent->>'amountMinor')::numeric;
 if invoice is null or p_intent->>'currency'is distinct from invoice->>'currency'or p_intent->>'counterpartyId'is distinct from invoice->>'supplierId'or amount is null or amount<=0 or trunc(amount)<>amount then raise exception 'needs_approval: invoice exposure requires exact payee currency and positive amount';end if;
 select coalesce(sum(case when exists(select from public.payments p join public.payment_authorizations pa on pa.payment_id=p.id and pa.mission_id=p.mission_id join public.authorization_followups followup on followup.source_authorization_id=pa.id and followup.action='payment_authorization_void'join public.provider_receipts receipt on receipt.authorization_id=followup.effect_authorization_id and receipt.operation='payment_authorization_void'and receipt.mission_id=p.mission_id join public.payment_states state on state.payment_id=p.id and state.mission_id=p.mission_id and state.state='failed'and state.receipt_id=receipt.id where p.authorization_id=a.id and p.mission_id=p_mission)then 0 else greatest(0,(a.intent->>'amountMinor')::numeric-coalesce((select sum(refund.amount_minor)from public.payments payment join public.payment_refunds refund on refund.payment_id=payment.id and refund.mission_id=payment.mission_id where payment.authorization_id=a.id and payment.mission_id=p_mission and exists(select from public.refund_confirmations confirmed where confirmed.refund_id=refund.id and confirmed.mission_id=p_mission)),0))end),0)into used
 from public.effect_authorizations a join public.artifact_versions source on source.mission_id=a.mission_id and source.id::text=a.intent->>'artifactVersionId'
 where a.mission_id=p_mission and a.intent->>'action'='payment_capture'and a.id is distinct from p_authorization and source.content#>>'{campaignPayment,proformaVersionId}'=metadata->>'proformaVersionId';
 if used+amount>(invoice->>'amountMinor')::numeric then raise exception 'needs_approval: cumulative proforma invoice exposure exceeded';end if;
end$$;
create function private.campaign_exposure_reservation()returns trigger language plpgsql security definer set search_path=''as $$begin perform private.check_campaign_exposure(new.mission_id,new.intent);return new;end$$;
create trigger campaign_invoice_exposure before insert on public.effect_authorizations for each row execute function private.campaign_exposure_reservation();
revoke all on function private.check_campaign_exposure(uuid,jsonb,uuid),private.campaign_exposure_reservation()from public;
do $$declare before text;after text;anchor text:='select * into strict v_a from public.effect_authorizations where mission_id=p_mission and id=p_authorization for update;';begin before:=pg_get_functiondef('public.begin_effect(uuid,uuid)'::regprocedure);after:=replace(before,anchor,anchor||' perform private.check_campaign_exposure(p_mission,v_a.intent,v_a.id);');if before=after then raise exception 'migration: invoice dispatch extension anchor changed';end if;execute after;end$$;

create function public.reconcile_sourcing_campaign_deliveries(p_mission uuid)returns integer language plpgsql security definer set search_path=''as $$declare item record;done integer:=0;begin
 perform private.require_role(array['policy_role']);perform private.lock_mission(p_mission);
 for item in select recipient.id recipient_id,receipt.id receipt_id from public.sourcing_campaign_recipients recipient join public.sourcing_campaigns campaign on campaign.id=recipient.campaign_id and campaign.mission_id=recipient.mission_id
 join public.effect_authorizations authz on authz.mission_id=recipient.mission_id and authz.intent->>'taskId'=recipient.task_id::text and authz.intent->>'counterpartyId'=recipient.supplier_id::text and authz.intent->>'channel'='email'and authz.intent->>'purpose'='quotation_request'
 join public.provider_receipts receipt on receipt.mission_id=authz.mission_id and receipt.authorization_id=authz.id and receipt.operation='send_message'
 join public.artifact_versions rfq on rfq.id=campaign.rfq_version_id and rfq.mission_id=campaign.mission_id
 join public.artifact_versions source on source.mission_id=recipient.mission_id and source.id::text=authz.intent->>'artifactVersionId'and(source.id=rfq.id or source.content->>'originatingTaskId'=recipient.task_id::text)and source.content->'payload'=rfq.content->'payload'
 join public.messages message on message.mission_id=recipient.mission_id and message.receipt_id=receipt.id and message.direction='outbound'and message.channel='email'and message.original=rfq.content#>>'{payload,text}'
 join public.threads thread on thread.id=message.thread_id and thread.mission_id=message.mission_id and thread.counterparty_id=recipient.supplier_id
 where recipient.mission_id=p_mission and not exists(select from public.sourcing_campaign_deliveries d where d.recipient_id=recipient.id)order by receipt.created_at,receipt.id limit 100 loop
 perform public.record_sourcing_campaign_delivery(p_mission,item.recipient_id,item.receipt_id);done:=done+1;
 end loop;return done;
end$$;
revoke all on function public.reconcile_sourcing_campaign_deliveries(uuid)from public;grant execute on function public.reconcile_sourcing_campaign_deliveries(uuid)to policy_role;
commit;
