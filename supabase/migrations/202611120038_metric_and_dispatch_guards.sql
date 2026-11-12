begin;
create or replace function private.check_version(p_mission uuid,p_version uuid)returns void language plpgsql stable set search_path='' as $$declare shipping jsonb;begin
  if p_version is null then return;end if;
  if exists(with recursive ancestors(id)as(select p_version union select d.upstream_id from public.dependencies d join ancestors a on a.id=d.dependent_id where d.mission_id=p_mission)
   select from ancestors a join public.artifact_versions v on v.id=a.id and v.mission_id=p_mission
   left join public.sourcing_quote_ingestions q on q.id::text=v.content#>>'{acceptedQuote,quoteId}'and q.mission_id=p_mission
   where v.content?'acceptedQuote'and((v.content#>>'{acceptedQuote,specVersionId}'is not null and not private.readiness_current_approved(p_mission,(v.content#>>'{acceptedQuote,specVersionId}')::uuid))or q.id is null or q.status<>'confirmed_reading'or coalesce(private.readiness_date(q.quote->>'validUntil')>clock_timestamp(),false)<>true or exists(select from public.stale_marks where node_id=q.source_evidence_id)or exists(select from public.evidence n where n.supersedes_id=q.source_evidence_id)))then raise exception 'needs_approval: accepted supplier quotation expired or changed';end if;
  -- Typed proformas reference the approved spec even when a model omitted derivedFrom.
  -- UNION deduplicates cycles; every referenced node still must be current and approved.
  if exists(with recursive refs(id)as(select p_version union select coalesce(v.content#>>'{proformaInvoice,specVersionId}',v.content#>>'{acceptedQuote,specVersionId}')::uuid from public.artifact_versions v join refs r on r.id=v.id where v.mission_id=p_mission and coalesce(v.content#>>'{proformaInvoice,specVersionId}',v.content#>>'{acceptedQuote,specVersionId}')is not null)
    select from refs r left join public.artifact_versions v on v.id=r.id and v.mission_id=p_mission left join public.artifacts a on a.id=v.artifact_id and a.mission_id=p_mission
    left join lateral(select s.*from public.artifact_statuses s where s.mission_id=p_mission and s.artifact_version_id=v.id order by s.created_at desc,s.id desc limit 1)s on true
    where v.id is null or(r.id<>p_version and a.outcome<>'product')or exists(select from public.artifact_versions n where n.artifact_id=v.artifact_id and n.version_no>v.version_no)or exists(select from public.stale_marks d where d.mission_id=p_mission and d.node_id=v.id)
    or s.status is distinct from 'approved'or not exists(select from public.decision_resolutions d where d.mission_id=p_mission and d.decision_id=s.decision_id and d.response in('approve','choose'))or exists(select from public.decision_supersessions d where d.mission_id=p_mission and d.previous_id=s.decision_id)or exists(select from public.stale_marks d where d.mission_id=p_mission and d.node_id=s.decision_id))then raise exception 'needs_approval: artifact version stale or not approved (including referenced specification)';end if;
  select coalesce(content->'payload',content)into shipping from public.artifact_versions where mission_id=p_mission and id=p_version;
  if shipping->>'kind'='shipping'and not exists(select from public.evidence e where e.mission_id=p_mission and e.id::text=shipping->>'quoteEvidenceId'and e.kind='shipping_rate_confirmed'and e.trust in('verified','founder_confirmed')and e.payload->'rate'->>'currency'=shipping->>'currency'and e.payload->'rate'->>'countryCode'=shipping->>'countryCode'and jsonb_typeof(e.payload->'rate'->'amountMinor')='number'and(e.payload->'rate'->>'amountMinor')::numeric>0 and not exists(select from public.stale_marks st where st.mission_id=p_mission and st.node_id=e.id)and not exists(select from public.evidence newer where newer.mission_id=p_mission and newer.supersedes_id=e.id))then raise exception 'needs_approval: current confirmed carrier quote currency and country required';end if;
end$$;

create or replace function private.business_metrics_data(p_mission uuid)returns jsonb language sql stable security definer set search_path=''as $$
 with m as(select*from public.effective_missions where id=p_mission),
 receipts as(select*from public.provider_receipts where mission_id=p_mission),
 contacts as(select distinct a.intent->>'counterpartyId' supplier from receipts r join public.effect_authorizations a on a.id=r.authorization_id join public.counterparties c on c.id::text=a.intent->>'counterpartyId'where r.operation='send_message'and c.kind='supplier'),
 responders as(select distinct q.supplier_id from public.sourcing_quote_ingestions q where q.mission_id=p_mission and q.status='confirmed_reading'and private.readiness_date(q.quote->>'validUntil')>clock_timestamp()and q.supplier_id::text in(select supplier from contacts)and not exists(select from public.stale_marks where node_id=q.source_evidence_id)and not exists(select from public.evidence n where n.supersedes_id=q.source_evidence_id)and(select count(distinct e.payload->>'independentSource')from public.evidence e where e.mission_id=p_mission and e.payload->>'supplierId'=q.supplier_id::text and e.trust in('verified','founder_confirmed')and e.kind='supplier_signal'and e.payload->>'signalKind'in('registry','address','marketplace_history','factory_video','reference')and not exists(select from public.stale_marks where node_id=e.id)and not exists(select from public.evidence n where n.supersedes_id=e.id))>=2),
 turnaround as(select extract(epoch from(r.created_at-d.created_at))seconds from public.decisions d join public.decision_resolutions r on r.decision_id=d.id where d.mission_id=p_mission and r.resolution_source='founder'and r.response in('approve','choose','reject')),
 costs as(select e.*,a.amount_minor accepted_minor,a.evidence_id,a.artifact_version_id,a.created_at accepted_at,(a.id is not null and private.readiness_current_approved(p_mission,a.artifact_version_id)and not exists(select from public.stale_marks where node_id=a.evidence_id)and not exists(select from public.evidence n where n.supersedes_id=a.evidence_id))source_current from public.cost_estimates e left join lateral(select*from public.cost_acceptances a where a.cost_line_id=e.id order by created_at desc,id desc limit 1)a on true where e.mission_id=p_mission),
 totals as(select*from public.money_totals where mission_id=p_mission),
 obstacles as(select o.*,r.id resolution_id,r.created_at resolved_at,r.founder_decision_id from public.mission_obstacles o left join public.obstacle_resolutions r on r.obstacle_id=o.id where o.mission_id=p_mission),
 launch as(select min(t.created_at)at from public.mission_transitions t join public.decision_resolutions r on r.decision_id=t.terminal_decision_id and r.option_id='launch'where t.mission_id=p_mission and t.status='ended')
 select jsonb_build_object('missionId',m.id,'sandboxMode',m.sandbox_mode,'observedAt',clock_timestamp(),'startedAt',m.created_at,
 'externalActionsPerformed',(select count(*)from receipts where length(provider_reference)>0 and provider<>'launch-operator-demand'),
 'decisionsRequested',(select count(*)from public.decisions where mission_id=p_mission),
 'founderInterventions',(select count(*)from public.command_requests c where c.mission_id=p_mission and c.kind in('resolveDecision','deferDecision','requestChange','confirmChange','keepDecision','justGo','sendMessage','answerQuestion','setHelpMode','approveDraft','discardDraft','retryStep','requestVariation','runArtifactAction','setMandateStatus','setMissionStatus')and exists(select from public.command_results r where r.command_id=c.id and r.mission_id=p_mission and r.status='completed')),
 'founderInterventionBasis','Successful distinct founder commands that supply input, decide, correct, or control work. Completion acknowledgements, notification preferences, read markers and exports are excluded; retries with the same idempotency key count once.',
 'founderCorrections',(select count(*)from public.command_requests where mission_id=p_mission and kind='requestChange'),
 'decisionTurnaroundSeconds',(select coalesce(jsonb_agg(seconds),'[]')from turnaround),'medianDecisionTurnaroundSeconds',(select percentile_cont(0.5)within group(order by seconds)from turnaround),
 'supplierContacted',(select count(*)from contacts),'verifiedUsableSupplierResponses',(select count(*)from responders),'verifiedSupplierResponseRate',(select count(*)from responders)::numeric/nullif((select count(*)from contacts),0),
 'focusedWorkspaceSeconds',(select coalesce(sum(active_seconds),0)from public.founder_presence where mission_id=p_mission),
 'modeCEffortMinutes',(select sum((payload->>'effortMinutes')::numeric)from public.evidence where mission_id=p_mission and kind='kit_verified'and trust='founder_confirmed'and payload->>'effortMinutes'~'^[0-9]{1,5}$'),
 'effortBasis','Workspace is a focused heartbeat estimate. Mode C effort is only explicit founder-reported time; missing is unknown.',
 'budgetMinor',case when m.metadata->>'budgetMinor'~'^[0-9]{1,15}$'then(m.metadata->>'budgetMinor')::bigint end,
 'moneyBySandbox',(select coalesce(jsonb_agg(jsonb_build_object('currency',currency,'sandboxMode',sandbox_mode,'spentMinor',spent_minor-refund_minor,'committedMinor',committed_minor,'budgetAdherence',case when m.metadata->>'budgetMinor'~'^[1-9][0-9]{0,14}$'then(spent_minor-refund_minor+committed_minor)::numeric/(m.metadata->>'budgetMinor')::numeric end)),'[]')from totals),
 'estimateAccuracy',(select coalesce(jsonb_agg(jsonb_build_object('lineId',id,'currency',currency,'firstEstimateMinor',amount_minor,'acceptedMinor',accepted_minor,'acceptedAt',accepted_at,'sourceEvidenceId',evidence_id,'artifactVersionId',artifact_version_id,'sourceCurrent',source_current,'status',case when accepted_minor is null then 'awaiting_quote'when source_current then 'current'else 'historical'end,'relativeError',case when source_current and amount_minor>0 then(accepted_minor-amount_minor)::numeric/amount_minor end)),'[]')from costs),
 'obstaclesTotal',(select count(*)from obstacles),'obstaclesResolved',(select count(*)from obstacles where resolution_id is not null),
 'obstaclesResolvedWithoutFounderDecision',(select count(*)from obstacles o where resolution_id is not null and founder_decision_id is null and not exists(select from public.decision_resolutions r where r.mission_id=p_mission and r.resolution_source='founder'and r.created_at between o.created_at and o.resolved_at)),
 'readinessMilestones',(select coalesce(jsonb_agg(jsonb_build_object('outcome',outcome,'level',level,'firstObservedAt',at,'secondsFromMissionStart',extract(epoch from(at-m.created_at)))),'[]')from(select outcome,n level,min(created_at)at from public.readiness_observations cross join generate_series(0,5)n where mission_id=p_mission and readiness_observations.level>=n group by outcome,n)r),
 'readinessHistoryCompleteFrom',(select min(created_at)from public.readiness_observations where mission_id=p_mission),
 'launchAt',(select at from launch),'calendarSecondsToLaunch',(select extract(epoch from(at-m.created_at))from launch),
 'honestyIncidentsKnown',(select count(*)from public.activity where mission_id=p_mission and label='performed'and receipt_id is null),
 'honestyMeasurementLimit','Structural missing-receipt count only; semantic honesty requires reviewed evaluations.')from m
$$;

do $$declare r record;begin
 for r in select v.mission_id,v.id,coalesce(spec.id,v.id)cause from public.artifact_versions v left join public.artifact_versions spec on spec.id::text=v.content#>>'{acceptedQuote,specVersionId}'and spec.mission_id=v.mission_id where v.content#>>'{acceptedQuote,specVersionId}'is not null and not private.readiness_current_approved(v.mission_id,spec.id)loop perform private.invalidate(r.mission_id,r.id,r.cause);end loop;
end$$;
create function public.lock_pending_outbox(p_mission uuid,p_limit integer default 100)returns setof public.outbox language plpgsql security definer set search_path=''as $$begin
 perform private.require_role(array['lead_role']);perform private.assert_mission(p_mission);
 if p_limit is null or p_limit not between 1 and 100 then raise exception 'validation: bounded outbox batch required';end if;
 return query select o.*from public.outbox o where o.mission_id=p_mission and not exists(select from public.outbox_deliveries d where d.outbox_id=o.id)order by o.created_at,o.id limit p_limit for update skip locked;
end$$;
revoke all on function public.lock_pending_outbox(uuid,integer)from public;
grant execute on function public.lock_pending_outbox(uuid,integer)to lead_role;

commit;
