begin;
do $$begin if not exists(select from pg_roles where rolname='operator_role')then create role operator_role nologin noinherit nobypassrls;end if;end$$;
grant usage on schema public to operator_role;
-- Aggregate operational measurements only. This role cannot inspect founder
-- content, account references, provider credentials or business ledger rows.
create function public.operator_health_snapshot(p_alarm_micro_usd bigint)returns jsonb language plpgsql security definer set search_path=''as $$
declare v_report jsonb;begin
 perform private.require_role(array['operator_role']);
 if p_alarm_micro_usd is null or p_alarm_micro_usd<1 then raise exception 'validation: model alarm threshold required';end if;
 with mission_status as(
  select m.id,m.sandbox_mode,m.created_at,coalesce((select status from public.mission_transitions t where t.mission_id=m.id order by created_at desc,id desc limit 1),'active')status,
  greatest(m.created_at,coalesce((select max(created_at)from public.runtime_ticks t where t.mission_id=m.id),m.created_at))last_tick
  from public.missions m
 ), pending as(select o.*from public.outbox o where not exists(select from public.outbox_deliveries d where d.outbox_id=o.id)),
 latest_payments as(select distinct on(payment_id)mission_id,payment_id,state,created_at from public.payment_states order by payment_id,created_at desc,id desc),
 latest_effects as(select distinct on(authorization_id)mission_id,authorization_id,status,created_at from public.effect_states order by authorization_id,created_at desc,id desc),
 costs as(select mission_id,sum(cost_micro_usd)known_micro_usd,count(*)filter(where cost_micro_usd is null or not usage_complete)unpriced_calls from public.model_usage group by mission_id),
 held as(select r.*from public.model_usage_reservations r where not exists(select from public.model_usage u where u.call_key=r.call_key)),
 alerts as(
  select 'stuck_mission'::text code,id mission_id,id reference_id,last_tick since from mission_status m where status='active'and last_tick<clock_timestamp()-interval '24 hours'
   and(exists(select from public.runs r where r.mission_id=m.id and not exists(select from public.run_results rr where rr.run_id=r.id))or exists(select from pending p where p.mission_id=m.id))
  union all select 'parked_event',mission_id,id,created_at from pending where created_at<clock_timestamp()-interval '1 hour'
  union all select 'payment_executing',mission_id,payment_id,created_at from latest_payments where state='executing'and created_at<clock_timestamp()-interval '1 hour'
  union all select 'payment_ambiguous',e.mission_id,e.authorization_id,e.created_at from latest_effects e join public.effect_authorizations a on a.id=e.authorization_id where e.status in('started','ambiguous')and a.intent->>'effectClass'='spend'and e.created_at<clock_timestamp()-interval '1 hour'
  union all select 'model_spend_alarm',mission_id,mission_id,null::timestamptz from costs where known_micro_usd>=p_alarm_micro_usd
  union all select 'unpriced_model_usage',c.mission_id,c.mission_id,null::timestamptz from costs c join mission_status m on m.id=c.mission_id where c.unpriced_calls>0 and not m.sandbox_mode
  union all select 'model_usage_pending',mission_id,id,created_at from held where created_at<clock_timestamp()-interval '15 minutes'
  union all select 'invariant_violation',mission_id,id,created_at from public.run_results where result->'error'->>'code'='invariant_violation'
 )
 select jsonb_build_object('observedAt',clock_timestamp(),'alarmMicroUsd',p_alarm_micro_usd,
 'metrics',jsonb_build_object('missions',(select count(*)from mission_status),'activeMissions',(select count(*)from mission_status where status='active'),'pendingOutbox',(select count(*)from pending),
 'failedRuns24h',(select count(*)from public.run_results where result->>'status'='failed'and created_at>clock_timestamp()-interval '24 hours'),
 'blockedActions24h',(select count(*)from public.activity where label='blocked'and created_at>clock_timestamp()-interval '24 hours'),
 'performedWithoutReceipt',(select count(*)from public.activity where label='performed'and receipt_id is null),
 'runLatencyP95Ms',(select percentile_cont(0.95)within group(order by elapsed_ms)from public.run_telemetry where created_at>clock_timestamp()-interval '24 hours'),
 'modelCalls',(select count(*)from public.model_usage),'modelInputTokens',(select coalesce(sum(input_tokens),0)from public.model_usage),'modelOutputTokens',(select coalesce(sum(output_tokens),0)from public.model_usage),
 'knownModelMicroUsd',(select coalesce(sum(known_micro_usd),0)from costs),'unpricedModelCalls',(select coalesce(sum(unpriced_calls),0)from costs),
 'pendingModelReservations',(select count(*)from held),'heldModelCeilingMicroUsd',(select coalesce(sum(ceiling_micro_usd),0)from held)),
 'missionCosts',coalesce((select jsonb_agg(to_jsonb(c))from costs c),'[]'::jsonb),
 'alerts',coalesce((select jsonb_agg(to_jsonb(a))from alerts a),'[]'::jsonb))into v_report;
 return v_report;
end$$;
revoke all on function public.operator_health_snapshot(bigint)from public;
grant execute on function public.operator_health_snapshot(bigint)to operator_role;
commit;
