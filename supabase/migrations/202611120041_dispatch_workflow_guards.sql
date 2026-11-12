begin;
create function private.mandate_contact_usage(p_mission uuid,p_mandate uuid)returns bigint language sql stable security definer set search_path=''as $$
 select count(distinct auth.intent->>'counterpartyId')from public.effect_authorizations auth where auth.mission_id=p_mission and auth.mandate_id=p_mandate and(coalesce((auth.intent->>'newContact')::boolean,false)or(auth.intent->>'action'in('send_message','marketplace_message')and not exists(select from public.messages msg join public.threads thread on thread.id=msg.thread_id and thread.mission_id=msg.mission_id where msg.mission_id=p_mission and thread.counterparty_id::text=auth.intent->>'counterpartyId'and msg.direction='outbound'and msg.receipt_id is not null and msg.created_at<=auth.created_at)))
$$;
create function public.mandate_usage(p_mission uuid,p_mandate uuid)returns jsonb language plpgsql stable security definer set search_path=''as $$begin
 perform private.require_role(array['founder_role','lead_role','policy_role']);perform private.assert_mission(p_mission);
 if not exists(select from public.mandates where mission_id=p_mission and id=p_mandate)then raise exception 'validation: scoped mandate required';end if;
 return jsonb_build_object('contacts',private.mandate_contact_usage(p_mission,p_mandate)::text,'usedMinor',private.mandate_exposure(p_mission,p_mandate)::text);
end$$;
revoke all on function private.mandate_contact_usage(uuid,uuid),public.mandate_usage(uuid,uuid)from public;
grant execute on function public.mandate_usage(uuid,uuid)to founder_role,lead_role,policy_role;
create function private.check_chase_dispatch(p_mission uuid,p_intent jsonb)returns void language plpgsql security definer set search_path=''as $$
declare a public.commitment_chase_attempts;ch public.commitment_chases;c public.commitments;last_stage integer;last_sent timestamptz;begin
 select *into a from public.commitment_chase_attempts where mission_id=p_mission and task_id::text=p_intent->>'taskId';if not found then return;end if;
 select *into strict ch from public.commitment_chases where mission_id=p_mission and id=a.chase_id;
 select *into strict c from public.commitments where mission_id=p_mission and id=ch.commitment_id;
 if not private.chase_open(p_mission,ch.id)or p_intent->>'action'is distinct from'send_message'or p_intent->>'effectClass'is distinct from'communicate'or p_intent->>'channel'is distinct from a.channel or p_intent->>'counterpartyId'is distinct from c.party_id::text or p_intent->>'purpose'is distinct from'follow_up'then raise exception 'needs_approval: chase closed, replied, escalated or changed before dispatch';end if;
 select max(at.stage),max(r.created_at)into last_stage,last_sent from public.commitment_chase_attempts at join public.commitment_chase_results r on r.attempt_id=at.id and r.status='sent'where at.mission_id=p_mission and at.chase_id=ch.id;
 if a.stage<>coalesce(last_stage,0)+1 or a.channel is distinct from(case when a.stage=1 then ch.primary_channel else ch.alternate_channel end)or(last_sent is not null and last_sent+make_interval(hours=>ch.interval_hours)>clock_timestamp())then raise exception 'needs_approval: chase sequence or response window changed before dispatch';end if;
end$$;
revoke all on function private.check_chase_dispatch(uuid,jsonb)from public;

create or replace function public.begin_effect(p_mission uuid,p_authorization uuid)returns jsonb language plpgsql security definer set search_path='' as $$declare v_a public.effect_authorizations;v_status text;v_ceiling bigint;v_voice public.voice_sessions;begin
  perform private.require_role(array['policy_role']);perform private.lock_mission(p_mission);perform private.active_mission(p_mission);
  select * into strict v_a from public.effect_authorizations where mission_id=p_mission and id=p_authorization for update;
  perform private.check_chase_dispatch(p_mission,v_a.intent);
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

create or replace function public.reserve_effect(p_mission uuid,p_intent jsonb,p_token_hash text default null)returns jsonb language plpgsql security definer set search_path='' as $$
declare v_existing public.effect_authorizations;v_m public.missions;v_mandate public.mandates;v_approval public.approvals;v_hash text;v_binding jsonb;v_id uuid;v_amount bigint;v_used bigint;v_contacts bigint;v_always boolean;v_conversion jsonb;v_actions bigint;v_source jsonb;v_ceiling bigint;begin
  perform private.require_role(array['policy_role']);perform private.lock_mission(p_mission);perform private.active_mission(p_mission);perform private.assert_safe_content(p_intent);
  if not(p_intent?&array['missionId','taskId','action','effectClass','counterpartyId','idempotencyKey','mode','sandboxMode'])or p_intent->>'missionId'<>p_mission::text or length(p_intent->>'idempotencyKey')not between 16 and 256 or p_intent->>'effectClass'not in('communicate','spend','publish','bind')then raise exception 'validation: incomplete effect intent'using errcode='22023';end if;
  v_hash:=encode(public.digest(p_intent::text,'sha256'),'hex');
  select * into v_existing from public.effect_authorizations where mission_id=p_mission and idempotency_key=p_intent->>'idempotencyKey';
  if found then if v_existing.intent_hash<>v_hash then raise exception 'invariant_violation: idempotency intent mismatch';end if;return private.authorization_json(v_existing.id,true);end if;
  select * into strict v_m from public.effective_missions where id=p_mission;
  if (p_intent->>'sandboxMode')::boolean<>v_m.sandbox_mode then raise exception 'invariant_violation: environment mismatch';end if;
  if not exists(select from public.counterparties where id=(p_intent->>'counterpartyId')::uuid and founder_id=v_m.founder_id and not opt_out)then raise exception 'invariant_violation: counterparty denied';end if;
  if p_token_hash is null and p_intent->>'effectClass'='communicate'and(p_intent->>'mode'<>'do'or private.effect_mode(p_mission,p_intent)<>'do')then raise exception 'needs_approval: guide or help mode requires founder approval';end if;
  v_amount:=coalesce((p_intent->>'amountMinor')::bigint,0);
  if v_amount<0 then raise exception 'validation: negative amount'using errcode='22023';end if;
  if p_intent->>'effectClass'='spend' then
    if not(p_intent?&array['amountMinor','currency','artifactVersionId','instrumentId'])or(v_amount=0 and not(v_m.sandbox_mode and p_intent->>'action'='store_test_order')) then raise exception 'validation: spend requires positive amount mission currency artifact and instrument (sandbox store_test_order may be zero)'using errcode='22023';end if;
    if not exists(select from public.founder_accounts a where a.id=(p_intent->>'instrumentId')::uuid and a.founder_id=v_m.founder_id and a.status='connected' and not exists(select from public.account_revocations where account_id=a.id))then raise exception 'invariant_violation: instrument revoked or not founder owned';end if;
  end if;
  perform private.check_version(p_mission,(p_intent->>'artifactVersionId')::uuid);
  if p_intent->>'effectClass'='communicate'and private.effect_mode(p_mission,p_intent)<>'do'and not(p_intent?'artifactVersionId')then raise exception 'needs_approval: Guide or Help requires a reviewed immutable draft';end if;
  if p_intent->>'action'in('payment_refund','payment_authorization_capture','payment_authorization_void')then v_source:=private.payment_source(p_mission,p_intent);v_conversion:=v_source;v_amount:=0;elsif p_intent->>'effectClass'='spend'then v_conversion:=private.fx_for_intent(p_mission,p_intent);v_amount:=(v_conversion->>'amountMinor')::bigint;end if;
  v_always:=p_intent->>'effectClass'in('publish','bind')or p_intent->>'action'=any(array['production_order','agreement','publish','legal_filing','mission_end','final_selection','material_terms','refund','payment_refund','store_publish','place_production_order','sign_agreement','submit_legal_filing','end_mission','place_order','accept_agreement','marketing_publish','registration','mission_pivot']);
  if p_token_hash is not null then
    select * into v_approval from public.approvals where mission_id=p_mission and token_hash=p_token_hash for update;
    v_binding:=jsonb_build_object('action',p_intent->>'action','counterpartyId',p_intent->>'counterpartyId','amountMinor',p_intent->'amountMinor','currency',p_intent->'currency','artifactVersionId',p_intent->'artifactVersionId');
    if v_approval.id is null or v_approval.expires_at<=clock_timestamp()or v_approval.binding<>v_binding or exists(select from public.approval_consumptions where approval_id=v_approval.id)or exists(select from public.approval_invalidations where approval_id=v_approval.id)or exists(select from public.decision_supersessions where previous_id=v_approval.decision_id)or exists(select from public.stale_marks where mission_id=p_mission and node_id=v_approval.decision_id)then raise exception 'needs_approval: invalid expired stale or consumed approval';end if;
  elsif v_always then raise exception 'needs_approval: action always requires approval';
  else
    select * into v_mandate from public.mandates where mission_id=p_mission and id=(p_intent->>'mandateId')::uuid for update;
    if v_mandate.id is null or v_mandate.expires_at<=clock_timestamp()or exists(select from public.mandate_revocations where mandate_id=v_mandate.id)or exists(select from public.decision_supersessions where previous_id=v_mandate.decision_id)or exists(select from public.stale_marks where mission_id=p_mission and node_id=v_mandate.decision_id)then raise exception 'needs_approval: no live mandate';end if;
    if not(v_mandate.scope->'actions'?(p_intent->>'action'))or not(v_mandate.scope->'effectClasses'?(p_intent->>'effectClass'))or not(v_mandate.scope->'counterpartyIds'?(p_intent->>'counterpartyId'))or(p_intent?'channel'and not(v_mandate.scope->'channels'?(p_intent->>'channel')))or(p_intent?'purpose'and not(v_mandate.scope->'purposes'?(p_intent->>'purpose')))or(p_intent?'instrumentId'and not(v_mandate.scope->'instrumentIds'?(p_intent->>'instrumentId')))then raise exception 'needs_approval: outside mandate scope';end if;
    if p_intent->>'effectClass'='spend'and(v_amount>v_mandate.ceiling_per or v_mandate.currency<>v_m.currency)then raise exception 'needs_approval: per action ceiling exceeded';end if;
    select private.mandate_exposure(p_mission,v_mandate.id),private.mandate_contact_usage(p_mission,v_mandate.id)into v_used,v_contacts;
    if p_intent->>'effectClass'='spend'and v_mandate.scope?'maxActions'then select count(*)into v_actions from public.effect_authorizations where mandate_id=v_mandate.id and intent->>'effectClass'='spend';if v_actions>=(v_mandate.scope->>'maxActions')::bigint then raise exception 'needs_approval: mandate action count exceeded';end if;end if;
    if v_used+v_amount>v_mandate.ceiling_total then raise exception 'needs_approval: total ceiling exceeded';end if;
    if(coalesce((p_intent->>'newContact')::boolean,false)or(p_intent->>'action'in('send_message','marketplace_message')and not exists(select from public.messages msg join public.threads thread on thread.id=msg.thread_id and thread.mission_id=msg.mission_id where msg.mission_id=p_mission and thread.counterparty_id::text=p_intent->>'counterpartyId'and msg.direction='outbound'and msg.receipt_id is not null)))and v_contacts>=coalesce((v_mandate.scope->>'maxNewContacts')::integer,0)then raise exception 'needs_approval: contact ceiling exceeded';end if;
  end if;
  -- Approved budget envelopes are independent of payment authorization.
  if p_intent->>'effectClass'='spend'and p_intent->>'action'<>'payment_refund'then v_ceiling:=private.current_budget_ceiling(p_mission);if v_ceiling is not null and v_amount+private.mission_exposure(p_mission)>v_ceiling then raise exception 'needs_approval: current approved budget exceeded';end if;end if;
  insert into public.effect_authorizations(mission_id,intent,intent_hash,idempotency_key,mandate_id,approval_id,amount_minor,sandbox_mode)values(p_mission,p_intent,v_hash,p_intent->>'idempotencyKey',v_mandate.id,v_approval.id,v_amount,v_m.sandbox_mode)returning id into v_id;
  if v_conversion?'quoteId'then insert into public.effect_fx_conversions(mission_id,authorization_id,quote_id,original_amount_minor,original_currency,mission_amount_minor,mission_currency)values(p_mission,v_id,(v_conversion->>'quoteId')::uuid,(p_intent->>'amountMinor')::bigint,p_intent->>'currency',(v_conversion->>'amountMinor')::bigint,v_m.currency);end if;
  if p_intent->>'action'='payment_refund'then insert into public.refund_claims(mission_id,payment_id,effect_authorization_id,amount_minor)values(p_mission,(v_source->>'paymentId')::uuid,v_id,(p_intent->>'amountMinor')::bigint);elsif p_intent->>'action'in('payment_authorization_capture','payment_authorization_void')then insert into public.authorization_followups(mission_id,source_authorization_id,effect_authorization_id,action)values(p_mission,(v_source->>'sourceAuthorizationId')::uuid,v_id,p_intent->>'action');end if;
  if v_approval.id is not null then insert into public.approval_consumptions(mission_id,approval_id,authorization_id)values(p_mission,v_approval.id,v_id);end if;
  insert into public.effect_states(mission_id,authorization_id,status)values(p_mission,v_id,'reserved');
  perform private.audit(p_mission,'planned','Effect authorized and reserved',array[v_id]);return private.authorization_json(v_id,false);
end$$;



create function private.outbound_version_refs(p_mission uuid,p_auth uuid)returns uuid[] language sql stable security definer set search_path=''as $$
 select coalesce(array_agg(distinct ref order by ref),'{}')from(
 select v.id ref from public.effect_authorizations a join public.artifact_versions v on v.mission_id=a.mission_id and v.id::text=a.intent->>'artifactVersionId'where a.mission_id=p_mission and a.id=p_auth
 union select refs.ref from public.effect_authorizations a join public.sourcing_campaign_recipients r on r.mission_id=a.mission_id and r.task_id::text=a.intent->>'taskId'join public.sourcing_campaigns c on c.id=r.campaign_id join public.artifact_versions rfq on rfq.id=c.rfq_version_id join public.artifact_versions sent on sent.mission_id=a.mission_id and sent.id::text=a.intent->>'artifactVersionId'cross join lateral unnest(array[c.rfq_version_id,c.spec_version_id])refs(ref)where a.mission_id=p_mission and a.id=p_auth and rfq.content->'payload'=sent.content->'payload'
 )frozen
$$;
revoke all on function private.outbound_version_refs(uuid,uuid)from public;

-- Filing an already-performed send is historical recovery, never new authority.
create function public.reconcile_outbound_receipts(p_mission uuid)returns integer language plpgsql security definer set search_path=''as $$
declare item record;envelope jsonb;done integer:=0;thread uuid;begin
 perform private.require_role(array['policy_role']);perform private.lock_mission(p_mission);
 for item in select r.*,a.intent,a.mandate_id,a.approval_id from public.provider_receipts r join public.effect_authorizations a on a.id=r.authorization_id and a.mission_id=r.mission_id join public.missions m on m.id=r.mission_id
 where r.mission_id=p_mission and r.operation='send_message'and a.intent->>'action'='send_message'and r.sandbox_mode=a.sandbox_mode and r.sandbox_mode=m.sandbox_mode
 and exists(select from public.effect_states es where es.authorization_id=a.id and es.mission_id=a.mission_id and es.status='performed'and es.receipt_id=r.id)
 and not exists(select from public.messages msg where msg.mission_id=r.mission_id and msg.receipt_id=r.id and msg.direction='outbound')order by r.created_at,r.id limit 100 loop
 envelope:=item.data->'outbound';
 -- Old approved-message receipts can recover from their immutable bound payload.
 if envelope is null and item.intent->>'artifactVersionId'is not null then
 select jsonb_build_object('channel',v.content#>>'{payload,channel}','original',v.content#>>'{payload,text}','translation',v.content#>>'{payload,translation}','purpose',v.content#>>'{payload,purpose}')into envelope from public.artifact_versions v where v.mission_id=p_mission and v.id::text=item.intent->>'artifactVersionId';end if;
 if jsonb_typeof(envelope)is distinct from'object'or envelope->>'channel'is distinct from item.intent->>'channel'or envelope->>'purpose'is distinct from item.intent->>'purpose'or length(coalesce(envelope->>'original',''))not between 1 and 10000 or length(coalesce(envelope->>'translation',''))=0 then continue;end if;
 if not((item.provider='resend'and envelope->>'channel'='email')or(item.provider='twilio'and envelope->>'channel'in('whatsapp','sms','voice')))then continue;end if;
 if not exists(select from public.counterparties cp join public.missions m on m.founder_id=cp.founder_id where m.id=p_mission and cp.id::text=item.intent->>'counterpartyId')then continue;end if;
 perform private.assert_safe_content(envelope);
 select t.id into thread from public.threads t where t.mission_id=p_mission and t.counterparty_id::text=item.intent->>'counterpartyId'order by t.created_at,t.id limit 1;
 if thread is null then insert into public.threads(mission_id,counterparty_id)values(p_mission,(item.intent->>'counterpartyId')::uuid)returning id into thread;end if;
 insert into public.messages(mission_id,thread_id,channel,direction,original,translation,provider_id,mandate_id,approval_id,receipt_id,created_at,artifact_version_refs)values(p_mission,thread,envelope->>'channel','outbound',envelope->>'original',envelope->>'translation',item.provider_reference,item.mandate_id,item.approval_id,item.id,item.created_at,private.outbound_version_refs(p_mission,item.authorization_id));done:=done+1;
 end loop;return done;
end$$;
revoke all on function public.reconcile_outbound_receipts(uuid)from public;
grant execute on function public.reconcile_outbound_receipts(uuid)to policy_role;

-- Guide sends and process crashes may leave a real receipt ahead of its chase
-- result. Recover only the same correlation accepted by the original recorder.
create function public.reconcile_commitment_chase_receipts(p_mission uuid)returns integer language plpgsql security definer set search_path=''as $$
declare item record;recovered integer:=0;begin
 perform public.reconcile_outbound_receipts(p_mission);
 perform private.require_role(array['policy_role']);perform private.lock_mission(p_mission);
 for item in select distinct on(a.id)a.id attempt_id,r.id receipt_id
 from public.commitment_chase_attempts a
 join public.commitment_chases ch on ch.id=a.chase_id and ch.mission_id=a.mission_id
 join public.commitments c on c.id=ch.commitment_id and c.mission_id=ch.mission_id
 join public.effect_authorizations e on e.mission_id=a.mission_id and e.intent->>'taskId'=a.task_id::text
 join public.provider_receipts r on r.authorization_id=e.id and r.mission_id=e.mission_id
 join public.messages m on m.receipt_id=r.id and m.mission_id=r.mission_id
 join public.threads t on t.id=m.thread_id and t.mission_id=m.mission_id
 where a.mission_id=p_mission and r.operation='send_message'and e.intent->>'action'='send_message'
 and e.intent->>'counterpartyId'=c.party_id::text and e.intent->>'channel'=a.channel
 and m.channel=a.channel and m.direction='outbound'and t.counterparty_id=c.party_id
 and right(m.original,length(a.body))=a.body
 and not exists(select from public.commitment_chase_results cr where cr.attempt_id=a.id and cr.status='sent')
 order by a.id,r.created_at,r.id limit 100 loop
 perform public.record_commitment_chase_result(p_mission,item.attempt_id,'sent','Recovered the matching written provider receipt.',item.receipt_id);recovered:=recovered+1;
 end loop;return recovered;
end$$;
revoke all on function public.reconcile_commitment_chase_receipts(uuid)from public;
grant execute on function public.reconcile_commitment_chase_receipts(uuid)to policy_role;

create or replace function private.queue_mandate_warning(p_mission uuid,p_mandate uuid,p_source uuid,p_at timestamptz)returns void language plpgsql security definer set search_path=''as $$
declare m public.mandates;used numeric;contacts bigint;actions bigint;max_actions numeric;max_contacts numeric;near boolean;reached boolean;begin
 select *into strict m from public.mandates where mission_id=p_mission and id=p_mandate;
 select private.mandate_exposure(p_mission,m.id),private.mandate_contact_usage(p_mission,m.id),count(*)filter(where a.intent->>'effectClass'='spend')into used,contacts,actions from public.effect_authorizations a where a.mission_id=p_mission and a.mandate_id=m.id;
 max_actions:=coalesce((m.scope->>'maxActions')::numeric,0);max_contacts:=coalesce((m.scope->>'maxNewContacts')::numeric,0);
 near:=(m.ceiling_total>0 and used*5>=m.ceiling_total*4::numeric)or(max_contacts>0 and contacts*5>=max_contacts*4)or(max_actions>0 and actions*5>=max_actions*4);
 reached:=(m.ceiling_total>0 and used>=m.ceiling_total)or(max_contacts>0 and contacts>=max_contacts)or(max_actions>0 and actions>=max_actions);
 if near then perform private.notification_source(p_mission,'effect_authorizations',p_source,'mandate','mandate:'||m.id||':80',p_at);end if;
 if reached then perform private.notification_source(p_mission,'effect_authorizations',p_source,'mandate','mandate:'||m.id||':100',p_at);end if;
end$$;

create or replace function public.record_outbound_message(p_mission uuid,p_party uuid,p_reference text,p_channel text,p_original text,p_translation text,p_mandate uuid)returns uuid language plpgsql security definer set search_path=''as $$declare v_receipt uuid;v_authorization_id uuid;v_authorization public.effect_authorizations;v_thread uuid;v_id uuid;begin
  perform private.require_role(array['policy_role']);perform private.lock_mission(p_mission);perform private.assert_safe_content(jsonb_build_object('original',p_original,'translation',p_translation));
  select r.id,a.id into v_receipt,v_authorization_id from public.provider_receipts r join public.effect_authorizations a on a.id=r.authorization_id and a.mission_id=r.mission_id where r.mission_id=p_mission and r.provider_reference=p_reference and a.intent->>'counterpartyId'=p_party::text and a.intent->>'action'='send_message';
  if v_receipt is null then raise exception 'invariant_violation: outbound message has no matching receipt';end if;
  select *into strict v_authorization from public.effect_authorizations where id=v_authorization_id and mission_id=p_mission;
  select id into v_id from public.messages where receipt_id=v_receipt and direction='outbound';if v_id is not null then return v_id;end if;
  select id into v_thread from public.threads where mission_id=p_mission and counterparty_id=p_party order by created_at limit 1;if v_thread is null then insert into public.threads(mission_id,counterparty_id)values(p_mission,p_party)returning id into v_thread;end if;
  insert into public.messages(mission_id,thread_id,channel,direction,original,translation,provider_id,mandate_id,approval_id,receipt_id,artifact_version_refs)values(p_mission,v_thread,p_channel,'outbound',p_original,p_translation,p_reference,v_authorization.mandate_id,v_authorization.approval_id,v_receipt,private.outbound_version_refs(p_mission,v_authorization_id))returning id into v_id;return v_id;
end$$;
commit;
