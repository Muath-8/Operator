-- I-1..4, I-13, I-16. Reservation/dispatch is serialised with pause/revocation.
begin;
create function private.active_mission(p_mission uuid) returns void language plpgsql set search_path='' as $$declare v_status text;v_enabled boolean;begin
  select effects_enabled into v_enabled from private.platform_controls where singleton for share;
  if not v_enabled then raise exception 'invariant_violation: platform effects disabled';end if;
  select status into v_status from public.mission_transitions where mission_id=p_mission order by created_at desc,id desc limit 1;
  if coalesce(v_status,'active')<>'active' then raise exception 'invariant_violation: mission paused or ended';end if;
end$$;
create function private.authorization_json(p_id uuid,p_replay boolean)returns jsonb language sql stable set search_path='' as $$
  select jsonb_strip_nulls(jsonb_build_object('authorizationId',a.id,'status',coalesce(s.status,'reserved'),'receiptId',s.receipt_id,'replay',p_replay))from public.effect_authorizations a left join lateral(select status,receipt_id from public.effect_states where authorization_id=a.id order by created_at desc,id desc limit 1)s on true where a.id=p_id
$$;
create function private.check_version(p_mission uuid,p_version uuid)returns void language plpgsql stable set search_path='' as $$begin
  if p_version is null then return;end if;
  -- Typed proformas reference the approved spec even when a model omitted derivedFrom.
  -- UNION deduplicates cycles; every referenced node still must be current and approved.
  if exists(with recursive refs(id)as(select p_version union select(v.content#>>'{proformaInvoice,specVersionId}')::uuid from public.artifact_versions v join refs r on r.id=v.id where v.mission_id=p_mission and v.content#>>'{proformaInvoice,specVersionId}'is not null)
    select from refs r left join public.artifact_versions v on v.id=r.id and v.mission_id=p_mission left join public.artifacts a on a.id=v.artifact_id and a.mission_id=p_mission
    left join lateral(select s.*from public.artifact_statuses s where s.mission_id=p_mission and s.artifact_version_id=v.id order by s.created_at desc,s.id desc limit 1)s on true
    where v.id is null or(r.id<>p_version and a.outcome<>'product')or exists(select from public.artifact_versions n where n.artifact_id=v.artifact_id and n.version_no>v.version_no)or exists(select from public.stale_marks d where d.mission_id=p_mission and d.node_id=v.id)
    or s.status is distinct from 'approved'or not exists(select from public.decision_resolutions d where d.mission_id=p_mission and d.decision_id=s.decision_id and d.response in('approve','choose'))or exists(select from public.decision_supersessions d where d.mission_id=p_mission and d.previous_id=s.decision_id)or exists(select from public.stale_marks d where d.mission_id=p_mission and d.node_id=s.decision_id))then raise exception 'needs_approval: artifact version stale or not approved (including referenced specification)';end if;
end$$;
create function public.reserve_effect(p_mission uuid,p_intent jsonb,p_token_hash text default null)returns jsonb language plpgsql security definer set search_path='' as $$
declare v_existing public.effect_authorizations;v_m public.missions;v_mandate public.mandates;v_approval public.approvals;v_hash text;v_binding jsonb;v_id uuid;v_amount bigint;v_used bigint;v_contacts bigint;v_always boolean;begin
  perform private.require_role(array['policy_role']);perform private.lock_mission(p_mission);perform private.active_mission(p_mission);perform private.assert_safe_content(p_intent);
  if not(p_intent?&array['missionId','taskId','action','effectClass','counterpartyId','idempotencyKey','mode','sandboxMode'])or p_intent->>'missionId'<>p_mission::text or length(p_intent->>'idempotencyKey')not between 16 and 256 or p_intent->>'effectClass'not in('communicate','spend','publish','bind')then raise exception 'validation: incomplete effect intent'using errcode='22023';end if;
  v_hash:=encode(public.digest(p_intent::text,'sha256'),'hex');
  select * into v_existing from public.effect_authorizations where mission_id=p_mission and idempotency_key=p_intent->>'idempotencyKey';
  if found then if v_existing.intent_hash<>v_hash then raise exception 'invariant_violation: idempotency intent mismatch';end if;return private.authorization_json(v_existing.id,true);end if;
  select * into strict v_m from public.missions where id=p_mission;
  if (p_intent->>'sandboxMode')::boolean<>v_m.sandbox_mode then raise exception 'invariant_violation: environment mismatch';end if;
  if not exists(select from public.counterparties where id=(p_intent->>'counterpartyId')::uuid and founder_id=v_m.founder_id and not opt_out)then raise exception 'invariant_violation: counterparty denied';end if;
  if p_token_hash is null and p_intent->>'effectClass'='communicate'and(p_intent->>'mode'<>'do'or v_m.involvement<>'do')then raise exception 'needs_approval: guide or help mode requires founder approval';end if;
  v_amount:=coalesce((p_intent->>'amountMinor')::bigint,0);
  if v_amount<0 then raise exception 'validation: negative amount'using errcode='22023';end if;
  if p_intent->>'effectClass'='spend' then
    if not(p_intent?&array['amountMinor','currency','artifactVersionId','instrumentId'])or(v_amount=0 and not(v_m.sandbox_mode and p_intent->>'action'='store_test_order'))or p_intent->>'currency'<>v_m.currency then raise exception 'validation: spend requires positive amount mission currency artifact and instrument (sandbox store_test_order may be zero)'using errcode='22023';end if;
    if not exists(select from public.founder_accounts a where a.id=(p_intent->>'instrumentId')::uuid and a.founder_id=v_m.founder_id and a.status='connected' and not exists(select from public.account_revocations where account_id=a.id))then raise exception 'invariant_violation: instrument revoked or not founder owned';end if;
  end if;
  perform private.check_version(p_mission,(p_intent->>'artifactVersionId')::uuid);
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
    if p_intent->>'effectClass'='spend'and(v_amount>v_mandate.ceiling_per or v_mandate.currency<>p_intent->>'currency')then raise exception 'needs_approval: per action ceiling exceeded';end if;
    select coalesce(sum(amount_minor),0),count(*)filter(where(intent->>'newContact')::boolean)into v_used,v_contacts from public.effect_authorizations where mandate_id=v_mandate.id;
    if v_used+v_amount>v_mandate.ceiling_total then raise exception 'needs_approval: total ceiling exceeded';end if;
    if coalesce((p_intent->>'newContact')::boolean,false)and v_contacts>=coalesce((v_mandate.scope->>'maxNewContacts')::integer,0)then raise exception 'needs_approval: contact ceiling exceeded';end if;
  end if;
  -- Approved budget envelopes are independent of payment authorization.
  if p_intent->>'effectClass'='spend'and exists(select from public.money_ledger where mission_id=p_mission and kind='envelope')and v_amount+(select coalesce(sum(amount_minor),0)from public.effect_authorizations where mission_id=p_mission)>(select sum(amount_minor)from public.money_ledger where mission_id=p_mission and kind='envelope')then raise exception 'needs_approval: budget envelope exceeded';end if;
  insert into public.effect_authorizations(mission_id,intent,intent_hash,idempotency_key,mandate_id,approval_id,amount_minor,sandbox_mode)values(p_mission,p_intent,v_hash,p_intent->>'idempotencyKey',v_mandate.id,v_approval.id,v_amount,v_m.sandbox_mode)returning id into v_id;
  if v_approval.id is not null then insert into public.approval_consumptions(mission_id,approval_id,authorization_id)values(p_mission,v_approval.id,v_id);end if;
  insert into public.effect_states(mission_id,authorization_id,status)values(p_mission,v_id,'reserved');
  perform private.audit(p_mission,'planned','Effect authorized and reserved',array[v_id]);return private.authorization_json(v_id,false);
end$$;
create function public.begin_effect(p_mission uuid,p_authorization uuid)returns jsonb language plpgsql security definer set search_path='' as $$declare v_a public.effect_authorizations;v_status text;begin
  perform private.require_role(array['policy_role']);perform private.lock_mission(p_mission);perform private.active_mission(p_mission);
  select * into strict v_a from public.effect_authorizations where mission_id=p_mission and id=p_authorization for update;
  select status into v_status from public.effect_states where authorization_id=p_authorization order by created_at desc,id desc limit 1;
  if v_a.mandate_id is not null and(exists(select from public.mandate_revocations where mandate_id=v_a.mandate_id)or exists(select from public.mandates m where m.id=v_a.mandate_id and(m.expires_at<=clock_timestamp()or exists(select from public.decision_supersessions where previous_id=m.decision_id)or exists(select from public.stale_marks where mission_id=p_mission and node_id=m.decision_id))))then raise exception 'invariant_violation: mandate revoked or expired';end if;
  if v_a.approval_id is not null and(exists(select from public.approval_invalidations where approval_id=v_a.approval_id)or exists(select from public.approvals where id=v_a.approval_id and expires_at<=clock_timestamp()))then raise exception 'needs_approval: approval invalidated or expired';end if;
  perform private.check_version(p_mission,(v_a.intent->>'artifactVersionId')::uuid);
  perform 1 from public.founder_accounts where id=(v_a.intent->>'instrumentId')::uuid for share;
  if exists(select from public.account_revocations where account_id=(v_a.intent->>'instrumentId')::uuid)then raise exception 'invariant_violation: instrument revoked';end if;
  if v_status<>'reserved' then return private.authorization_json(p_authorization,true);end if;
  insert into public.effect_states(mission_id,authorization_id,status)values(p_mission,p_authorization,'started');return private.authorization_json(p_authorization,false);
end$$;
create function public.complete_effect(p_mission uuid,p_authorization uuid,p_receipt jsonb)returns jsonb language plpgsql security definer set search_path='' as $$declare v_a public.effect_authorizations;v_status text;v_receipt uuid;begin
  perform private.require_role(array['policy_role']);perform private.lock_mission(p_mission);perform private.assert_safe_content(p_receipt);
  select * into strict v_a from public.effect_authorizations where mission_id=p_mission and id=p_authorization for update;
  select status into v_status from public.effect_states where authorization_id=p_authorization order by created_at desc,id desc limit 1;
  if v_status='performed'then return private.authorization_json(p_authorization,true);end if;
  if v_status not in('started','ambiguous')then raise exception 'invariant_violation: effect not started';end if;
  if not(p_receipt?&array['provider','providerReference','operation','sandboxMode','data'])or length(p_receipt->>'providerReference')=0 or(p_receipt->>'sandboxMode')::boolean<>v_a.sandbox_mode or p_receipt->>'operation'<>v_a.intent->>'action' then raise exception 'invariant_violation: invalid provider receipt';end if;
  insert into public.provider_receipts(mission_id,authorization_id,provider,provider_reference,operation,sandbox_mode,data)values(p_mission,p_authorization,p_receipt->>'provider',p_receipt->>'providerReference',p_receipt->>'operation',v_a.sandbox_mode,p_receipt->'data')returning id into v_receipt;
  insert into public.effect_states(mission_id,authorization_id,status,receipt_id)values(p_mission,p_authorization,'performed',v_receipt);
  perform private.audit(p_mission,'performed','Provider receipt recorded',array[p_authorization],v_receipt);return private.authorization_json(p_authorization,false);
end$$;
create function public.fail_effect(p_mission uuid,p_authorization uuid,p_ambiguous boolean,p_reason text)returns jsonb language plpgsql security definer set search_path='' as $$declare v_status text;begin
  perform private.require_role(array['policy_role']);perform private.lock_mission(p_mission);
  perform 1 from public.effect_authorizations where mission_id=p_mission and id=p_authorization for update;if not found then raise exception 'validation: unknown authorization'using errcode='22023';end if;
  select status into v_status from public.effect_states where authorization_id=p_authorization order by created_at desc,id desc limit 1;
  if v_status in('performed','failed')then return private.authorization_json(p_authorization,true);end if;
  insert into public.effect_states(mission_id,authorization_id,status,reason)values(p_mission,p_authorization,case when p_ambiguous then 'ambiguous'else'failed'end,left(p_reason,500));perform private.audit(p_mission,'failed','Effect failed; reconciliation required for ambiguous outcomes',array[p_authorization]);return private.authorization_json(p_authorization,false);
end$$;
create function public.prepare_payment(p_mission uuid,p_authorization uuid,p_provider text)returns uuid language plpgsql security definer set search_path='' as $$declare v_a public.effect_authorizations;v_id uuid;begin
  perform private.require_role(array['policy_role']);perform private.lock_mission(p_mission);select * into strict v_a from public.effect_authorizations where mission_id=p_mission and id=p_authorization;
  if v_a.intent->>'effectClass'<>'spend' then raise exception 'invariant_violation: payment requires spend authorization';end if;
  insert into public.payments(mission_id,authorization_id,provider,payee_id,instrument_id,amount_minor,currency,purpose,artifact_version_id,sandbox_mode)values(p_mission,p_authorization,p_provider,(v_a.intent->>'counterpartyId')::uuid,(v_a.intent->>'instrumentId')::uuid,v_a.amount_minor,v_a.intent->>'currency',coalesce(v_a.intent->>'purpose',v_a.intent->>'action'),(v_a.intent->>'artifactVersionId')::uuid,v_a.sandbox_mode)on conflict(authorization_id)do nothing returning id into v_id;
  if v_id is null then select id into v_id from public.payments where authorization_id=p_authorization;return v_id;end if;
  insert into public.payment_states(mission_id,payment_id,state)values(p_mission,v_id,'approved');
  insert into public.money_ledger(mission_id,kind,amount_minor,currency,basis,envelope,ref_id,sandbox_mode)values(p_mission,'committed',v_a.amount_minor,v_a.intent->>'currency','accepted',coalesce(v_a.intent->>'purpose','general'),v_id,v_a.sandbox_mode);return v_id;
end$$;
create function public.confirm_payment(p_mission uuid,p_payment uuid,p_receipt uuid,p_confirmation uuid)returns uuid language plpgsql security definer set search_path='' as $$declare v_p public.payments;v_id uuid;begin
  perform private.require_role(array['policy_role']);perform private.lock_mission(p_mission);select * into strict v_p from public.payments where mission_id=p_mission and id=p_payment for update;
  if not exists(select from public.provider_receipts where id=p_receipt and mission_id=p_mission and authorization_id=v_p.authorization_id and sandbox_mode=v_p.sandbox_mode and provider=v_p.provider)then raise exception 'invariant_violation: payment receipt mismatch';end if;
  if not exists(select from public.events e join public.provider_receipts r on r.id=p_receipt and r.mission_id=e.mission_id where e.id=p_confirmation and e.mission_id=p_mission and e.signature_verified and e.provider=v_p.provider and e.type in('payment.captured','payment.verified_poll')and(e.payload->>'paymentId')=p_payment::text and(e.payload->>'amountMinor')::bigint=v_p.amount_minor and e.payload->>'currency'=v_p.currency and(e.payload->>'sandboxMode')::boolean=v_p.sandbox_mode and e.payload->>'payeeId'=v_p.payee_id::text and e.payload->>'providerReference'=r.provider_reference and e.payload->>'orderId'=r.data->>'orderId'and length(e.payload->>'orderId')>0)then raise exception 'invariant_violation: verified payment confirmation required';end if;
  if exists(select from public.payment_states where payment_id=p_payment and state='captured')then select id into v_id from public.payment_states where payment_id=p_payment and state='captured';return v_id;end if;
  insert into public.payment_states(mission_id,payment_id,state,receipt_id,confirmation_event_id)values(p_mission,p_payment,'captured',p_receipt,p_confirmation)returning id into v_id;
  insert into public.money_ledger(mission_id,kind,amount_minor,currency,basis,envelope,ref_id,receipt_id,confirmation_event_id,sandbox_mode)values(p_mission,'spent',v_p.amount_minor,v_p.currency,'accepted',v_p.purpose,p_payment,p_receipt,p_confirmation,v_p.sandbox_mode);
  insert into public.outbox(mission_id,type,payload)values(p_mission,'payment.captured',jsonb_build_object('paymentId',p_payment));return v_id;
end$$;
create function public.effect_receipt(p_mission uuid,p_authorization uuid)returns jsonb language plpgsql security definer stable set search_path='' as $$declare v_result jsonb;begin perform private.require_role(array['policy_role']);perform private.assert_mission(p_mission);select jsonb_build_object('provider',provider,'providerReference',provider_reference,'operation',operation,'sandboxMode',sandbox_mode,'data',data)into v_result from public.provider_receipts where mission_id=p_mission and authorization_id=p_authorization;return v_result;end$$;
create function public.revoke_account(p_founder uuid,p_account uuid)returns uuid language plpgsql security definer set search_path='' as $$declare v_id uuid;begin perform private.require_role(array['founder_role','authenticated']);if not private.owns_founder(p_founder)then raise exception 'invariant_violation: account tenant denied';end if;perform 1 from public.founder_accounts where founder_id=p_founder and id=p_account for update;insert into public.account_revocations(founder_id,account_id)values(p_founder,p_account)on conflict(account_id)do nothing returning id into v_id;return v_id;end$$;
revoke execute on all functions in schema private from public;
revoke execute on all functions in schema public from public;
grant execute on function public.reserve_effect(uuid,jsonb,text),public.begin_effect(uuid,uuid),public.complete_effect(uuid,uuid,jsonb),public.fail_effect(uuid,uuid,boolean,text),public.prepare_payment(uuid,uuid,text),public.confirm_payment(uuid,uuid,uuid,uuid),public.effect_receipt(uuid,uuid)to policy_role;
grant execute on function public.revoke_account(uuid,uuid)to founder_role;
commit;
