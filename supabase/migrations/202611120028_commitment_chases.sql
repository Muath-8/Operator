begin;
-- Append-only follow-up state. A provider API response alone never advances it.
create table public.commitment_chases(
 id uuid primary key default gen_random_uuid(),mission_id uuid not null,commitment_id uuid not null,origin_message_id uuid not null,
 primary_channel text not null check(primary_channel in('email','whatsapp')),alternate_channel text check(alternate_channel in('email','whatsapp')),
 mandate_id uuid,comparison_version_id uuid,interval_hours integer not null check(interval_hours between 1 and 168),
 created_at timestamptz not null default clock_timestamp(),unique(mission_id,id),unique(commitment_id),
 foreign key(mission_id,commitment_id)references public.commitments(mission_id,id),foreign key(origin_message_id)references public.messages(id),
 foreign key(mission_id,mandate_id)references public.mandates(mission_id,id),foreign key(mission_id,comparison_version_id)references public.artifact_versions(mission_id,id),check(alternate_channel is null or alternate_channel<>primary_channel)
);
create table public.commitment_chase_attempts(
 id uuid primary key default gen_random_uuid(),mission_id uuid not null,chase_id uuid not null,stage integer not null check(stage in(1,2)),task_id uuid not null default gen_random_uuid(),
 channel text not null check(channel in('email','whatsapp')),body text not null,created_at timestamptz not null default clock_timestamp(),
 unique(mission_id,id),unique(chase_id,stage),unique(task_id),foreign key(mission_id,chase_id)references public.commitment_chases(mission_id,id)
);
create table public.commitment_chase_results(
 id uuid primary key default gen_random_uuid(),mission_id uuid not null,attempt_id uuid not null,status text not null check(status in('sent','blocked','draft','failed','ambiguous')),
 receipt_id uuid,reason text not null,created_at timestamptz not null default clock_timestamp(),
 foreign key(mission_id,attempt_id)references public.commitment_chase_attempts(mission_id,id),foreign key(mission_id,receipt_id)references public.provider_receipts(mission_id,id),check((status='sent')=(receipt_id is not null))
);
create unique index chase_sent_once on public.commitment_chase_results(attempt_id)where status='sent';
create table public.commitment_chase_escalations(
 id uuid primary key default gen_random_uuid(),mission_id uuid not null,chase_id uuid not null unique,disposition text not null check(disposition in('replacement_decision','candidate_promoted','no_eligible_candidate')),
 promoted_supplier_id uuid,promoted_assessment_id uuid,created_at timestamptz not null default clock_timestamp(),foreign key(mission_id,chase_id)references public.commitment_chases(mission_id,id)
);
do $$declare t text;begin foreach t in array array['commitment_chases','commitment_chase_attempts','commitment_chase_results','commitment_chase_escalations']loop
 execute format('alter table public.%I enable row level security',t);execute format('alter table public.%I force row level security',t);
 execute format('create policy mission_scope on public.%I using(private.owns_mission(mission_id))with check(private.owns_mission(mission_id))',t);
 execute format('create trigger immutable_row before update or delete on public.%I for each row execute function private.immutable_row()',t);
 execute format('create trigger ledger_revision after insert on public.%I for each row execute function private.record_ledger_revision()',t);
 execute format('create trigger broadcast_ledger after insert on public.%I for each row execute function private.broadcast_ledger()',t);
end loop;end$$;
grant select on public.commitment_chases,public.commitment_chase_attempts,public.commitment_chase_results,public.commitment_chase_escalations to founder_role,lead_role,specialist_role,policy_role;

create function public.configure_commitment_chase(p_mission uuid,p_commitment uuid,p_message uuid,p_alternate text default null,p_mandate uuid default null,p_comparison uuid default null,p_hours integer default 24)returns uuid language plpgsql security definer set search_path=''as $$
declare c public.commitments;party public.counterparties;channel text;result uuid;begin
 perform private.require_role(array['lead_role']);perform private.lock_mission(p_mission);
 select *into strict c from public.commitments where mission_id=p_mission and id=p_commitment and direction='inbound'and party_id is not null;
 select *into strict party from public.counterparties where id=c.party_id and founder_id=(select founder_id from public.missions where id=p_mission)and kind='supplier';
 select m.channel into channel from public.messages m join public.threads t on t.id=m.thread_id and t.mission_id=m.mission_id where m.mission_id=p_mission and m.id=p_message and t.counterparty_id=c.party_id and m.direction='inbound'and m.channel in('email','whatsapp')and length(m.provider_id)>0;
 if channel is null or p_hours is null or p_hours not between 1 and 168 then raise exception 'validation: recorded inbound channel and bounded follow-up window required';end if;
 if p_alternate is not null and(p_alternate not in('email','whatsapp')or p_alternate=channel or(p_alternate='email'and(coalesce(party.verification->>'emailVerified','false')<>'true'or length(coalesce(party.channels->>'email',''))=0))or(p_alternate='whatsapp'and(coalesce(party.verification->>'phoneVerified','false')<>'true'or length(coalesce(party.channels->>'phone',''))=0)))then raise exception 'validation: alternate channel must be independently verified';end if;
 if p_comparison is not null and not exists(select from public.artifact_versions v join public.artifacts a on a.id=v.artifact_id and a.mission_id=v.mission_id where v.mission_id=p_mission and v.id=p_comparison and a.type='supplier_comparison'and a.outcome='supply')then raise exception 'validation: scoped supplier comparison required';end if;
 select id into result from public.commitment_chases where commitment_id=c.id;
 if result is not null then
  if not exists(select from public.commitment_chases where id=result and origin_message_id=p_message and alternate_channel is not distinct from p_alternate and mandate_id is not distinct from p_mandate and comparison_version_id is not distinct from p_comparison and interval_hours=p_hours)then raise exception 'invariant_violation: chase configuration is immutable';end if;return result;
 end if;
 insert into public.commitment_chases(mission_id,commitment_id,origin_message_id,primary_channel,alternate_channel,mandate_id,comparison_version_id,interval_hours)values(p_mission,c.id,p_message,channel,p_alternate,p_mandate,p_comparison,p_hours)returning id into result;return result;
end$$;

create function private.chase_open(p_mission uuid,p_chase uuid)returns boolean language sql stable security definer set search_path=''as $$
 select exists(select from public.commitment_chases ch join public.commitments c on c.id=ch.commitment_id and c.mission_id=ch.mission_id where ch.mission_id=p_mission and ch.id=p_chase
 and c.due_at<=clock_timestamp()and coalesce((select s.status from public.commitment_states s where s.mission_id=p_mission and s.commitment_id=c.id order by s.created_at desc,s.id desc limit 1),'open')not in('closed','cancelled')
 and not exists(select from public.messages m join public.threads t on t.id=m.thread_id and t.mission_id=m.mission_id where m.mission_id=p_mission and t.counterparty_id=c.party_id and m.direction='inbound'and m.created_at>(select created_at from public.messages where id=ch.origin_message_id))
 and not exists(select from public.commitment_chase_escalations e where e.chase_id=ch.id))
$$;

create function public.next_commitment_chase(p_mission uuid,p_chase uuid)returns jsonb language plpgsql security definer set search_path=''as $$
declare ch public.commitment_chases;c public.commitments;a public.commitment_chase_attempts;v_stage integer;last_sent timestamptz;channel text;body text;begin
 perform private.require_role(array['lead_role']);perform private.lock_mission(p_mission);
 if not private.chase_open(p_mission,p_chase)or (select status from public.mission_transitions where mission_id=p_mission order by created_at desc,id desc limit 1)in('paused','ended')then return null;end if;
 select *into strict ch from public.commitment_chases where mission_id=p_mission and id=p_chase;select *into strict c from public.commitments where mission_id=p_mission and id=ch.commitment_id;
 select max(attempt.stage),max(r.created_at)into v_stage,last_sent from public.commitment_chase_attempts attempt join public.commitment_chase_results r on r.attempt_id=attempt.id and r.status='sent'where attempt.chase_id=ch.id;
 v_stage:=coalesce(v_stage,0)+1;
 if last_sent is not null and last_sent+make_interval(hours=>ch.interval_hours)>clock_timestamp()then return null;end if;
 if v_stage=2 and ch.alternate_channel is null or v_stage>2 then return jsonb_build_object('escalate',true,'chaseId',ch.id);end if;
 channel:=case when v_stage=1 then ch.primary_channel else ch.alternate_channel end;
 body:=case when(select locale from public.counterparties where id=c.party_id)like'ar%'then 'أتابع التحديث الكتابي المستحق في هذه المحادثة. يرجى الرد هنا. هذه متابعة فقط ولا توافق على أي شروط أو طلب شراء.'else 'Following up on the outstanding written update in this thread. Please reply here. This follow-up agrees no terms or purchase order.'end;
 insert into public.commitment_chase_attempts(mission_id,chase_id,stage,channel,body)values(p_mission,ch.id,v_stage,channel,body)on conflict(chase_id,stage)do nothing;
 select *into strict a from public.commitment_chase_attempts where chase_id=ch.id and commitment_chase_attempts.stage=v_stage;
 return jsonb_build_object('escalate',false,'chaseId',ch.id,'attemptId',a.id,'taskId',a.task_id,'partyId',c.party_id,'channel',a.channel,'body',a.body,'mandateId',ch.mandate_id,'language',case when(select locale from public.counterparties where id=c.party_id)like'ar%'then'ar'else'en'end);
end$$;

create function public.record_commitment_chase_result(p_mission uuid,p_attempt uuid,p_status text,p_reason text,p_receipt uuid default null)returns void language plpgsql security definer set search_path=''as $$
declare a public.commitment_chase_attempts;party uuid;begin
 perform private.require_role(array['policy_role']);perform private.lock_mission(p_mission);
 select *into strict a from public.commitment_chase_attempts where mission_id=p_mission and id=p_attempt;
 select c.party_id into strict party from public.commitment_chases ch join public.commitments c on c.id=ch.commitment_id and c.mission_id=ch.mission_id where ch.id=a.chase_id;
 if p_status='sent'and not exists(select from public.provider_receipts r join public.effect_authorizations e on e.id=r.authorization_id and e.mission_id=r.mission_id join public.messages m on m.receipt_id=r.id and m.mission_id=r.mission_id join public.threads t on t.id=m.thread_id and t.mission_id=m.mission_id where r.mission_id=p_mission and r.id=p_receipt and r.operation='send_message'and e.intent->>'taskId'=a.task_id::text and e.intent->>'action'='send_message'and e.intent->>'counterpartyId'=party::text and e.intent->>'channel'=a.channel and m.channel=a.channel and m.direction='outbound'and t.counterparty_id=party and right(m.original,length(a.body))=a.body)then raise exception 'invariant_violation: matching task, recipient, channel and written provider receipt required';end if;
 if exists(select from public.commitment_chase_results where attempt_id=a.id and status='sent')then return;end if;
 if length(coalesce(p_reason,''))not between 1 and 500 then raise exception 'validation: bounded result reason required';end if;
 if exists(select from public.commitment_chase_results where attempt_id=a.id and status=p_status and reason=p_reason and receipt_id is not distinct from p_receipt)then return;end if;
 insert into public.commitment_chase_results(mission_id,attempt_id,status,receipt_id,reason)values(p_mission,a.id,p_status,p_receipt,p_reason);
end$$;

create function public.escalate_commitment_chase(p_mission uuid,p_chase uuid)returns jsonb language plpgsql security definer set search_path=''as $$
declare ch public.commitment_chases;c public.commitments;sent integer;last_sent timestamptz;selected boolean;comparison jsonb;candidate jsonb;assessment public.sourcing_assessments;supplier uuid;promoted uuid;aid uuid;disposition text;result uuid;begin
 perform private.require_role(array['lead_role']);perform private.lock_mission(p_mission);
 if not private.chase_open(p_mission,p_chase)or (select status from public.mission_transitions where mission_id=p_mission order by created_at desc,id desc limit 1)in('paused','ended')then return null;end if;
 select *into strict ch from public.commitment_chases where mission_id=p_mission and id=p_chase;select *into strict c from public.commitments where mission_id=p_mission and id=ch.commitment_id;
 select count(*),max(r.created_at)into sent,last_sent from public.commitment_chase_attempts a join public.commitment_chase_results r on r.attempt_id=a.id and r.status='sent'where a.chase_id=ch.id;
 if sent<>(case when ch.alternate_channel is null then 1 else 2 end)or last_sent+make_interval(hours=>ch.interval_hours)>clock_timestamp()then raise exception 'invariant_violation: receipt-backed chase sequence and response window required';end if;
 -- A corrected/stale acceptance is still a past founder choice. It cannot turn
 -- into permission for an automatic supplier switch.
 select exists(select from public.decisions d join public.decision_resolutions r on r.decision_id=d.id and r.mission_id=d.mission_id and r.response in('approve','choose')
 cross join lateral jsonb_array_elements(d.packet->'options')o cross join lateral jsonb_array_elements_text(coalesce(o->'artifactVersionIds',case when jsonb_array_length(d.packet->'options')=1 then to_jsonb(d.approved_version_refs)else'[]'::jsonb end))ref
 join public.artifact_versions v on v.id::text=ref.value and v.mission_id=d.mission_id join public.sourcing_quote_ingestions q on q.id::text=(v.content#>>'{acceptedQuote,quoteId}')and q.mission_id=v.mission_id
 where d.mission_id=p_mission and o->>'id'=r.option_id and q.supplier_id=c.party_id)into selected;
 if not selected and ch.comparison_version_id is not null then
  select v.content into comparison from public.artifact_versions v where v.mission_id=p_mission and v.id=ch.comparison_version_id and not exists(select from public.artifact_versions n where n.mission_id=v.mission_id and n.artifact_id=v.artifact_id and n.version_no>v.version_no)and not exists(select from public.stale_marks s where s.mission_id=p_mission and s.node_id=v.id);
  if jsonb_typeof(comparison->'ranking')='array'and not exists(select from jsonb_array_elements(comparison->'ranking')r where coalesce(r->>'rank','')!~'^[1-9][0-9]{0,3}$')then
   for candidate in select value from jsonb_array_elements(comparison->'ranking')order by(value->>'rank')::integer loop
    supplier:=(candidate->>'supplierId')::uuid;if supplier=c.party_id then continue;end if;
    select a.*into assessment from public.sourcing_assessments a join public.sourcing_quote_ingestions q on q.id=a.ingestion_id and q.mission_id=a.mission_id join public.counterparties party on party.id=q.supplier_id
    where a.id=(candidate->>'assessmentId')::uuid and a.mission_id=p_mission and q.supplier_id=supplier and a.spec_version_id::text=comparison->>'specVersionId'and a.assessment->>'eligible'='true'
    and private.readiness_date(q.quote->>'validUntil')>clock_timestamp()and not party.opt_out and not exists(select from public.counterparty_optouts o where o.counterparty_id=party.id)
    and not exists(select from public.sourcing_assessments newer where newer.mission_id=a.mission_id and newer.ingestion_id=a.ingestion_id and newer.spec_version_id=a.spec_version_id and(newer.created_at,newer.id)>(a.created_at,a.id))
    and not exists(select from jsonb_array_elements_text(coalesce(a.assessment->'verificationEvidenceIds','[]'))ref where not exists(select from public.evidence e where e.mission_id=p_mission and e.id::text=ref.value and e.trust in('verified','founder_confirmed')and not exists(select from public.stale_marks sm where sm.mission_id=p_mission and sm.node_id=e.id)and not exists(select from public.evidence corrected where corrected.mission_id=p_mission and corrected.supersedes_id=e.id)));
    if found and not exists(select from public.commitment_chase_escalations e join public.commitment_chases cc on cc.id=e.chase_id join public.commitments cm on cm.id=cc.commitment_id where e.mission_id=p_mission and cm.party_id=supplier)then
     begin perform public.sourcing_route_context(p_mission,assessment.ingestion_id,assessment.spec_version_id,assessment.negotiation_mandate_id);promoted:=supplier;aid:=assessment.id;exit;exception when others then continue;end;
    end if;
   end loop;
  end if;
 end if;
 disposition:=case when selected then'replacement_decision'when promoted is not null then'candidate_promoted'else'no_eligible_candidate'end;
 insert into public.commitment_chase_escalations(mission_id,chase_id,disposition,promoted_supplier_id,promoted_assessment_id)values(p_mission,ch.id,disposition,promoted,aid)returning id into result;
 insert into public.activity(mission_id,label,summary,refs,actor_id)values(p_mission,'planned',case when selected then'Supplier unresponsive after recorded follow-ups. A founder replacement decision is required; the selected supplier was not changed.'when promoted is not null then'Supplier unresponsive after recorded follow-ups. The next evidence-ranked candidate is promoted for research only; no supplier agreement was made.'else'Supplier unresponsive after recorded follow-ups. Sourcing must establish an eligible replacement candidate.'end,array[c.id,result],private.actor_id());
 insert into public.outbox(mission_id,type,payload)values(p_mission,'sourcing.chase_escalated',jsonb_build_object('escalationId',result,'commitmentId',c.id,'supplierId',c.party_id,'disposition',disposition,'promotedSupplierId',promoted,'assessmentId',aid));
 return jsonb_build_object('id',result,'disposition',disposition,'promotedSupplierId',promoted);
end$$;
revoke all on function private.chase_open(uuid,uuid)from public;
revoke all on function public.configure_commitment_chase(uuid,uuid,uuid,text,uuid,uuid,integer),public.next_commitment_chase(uuid,uuid),public.escalate_commitment_chase(uuid,uuid),public.record_commitment_chase_result(uuid,uuid,text,text,uuid)from public;
grant execute on function public.configure_commitment_chase(uuid,uuid,uuid,text,uuid,uuid,integer),public.next_commitment_chase(uuid,uuid),public.escalate_commitment_chase(uuid,uuid)to lead_role;
grant execute on function public.record_commitment_chase_result(uuid,uuid,text,text,uuid)to policy_role;
commit;
