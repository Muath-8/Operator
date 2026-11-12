begin;
create table public.readiness_observations(id uuid primary key default gen_random_uuid(),mission_id uuid not null references public.missions(id),outcome text not null,level integer not null check(level between 0 and 5),missing text[]not null,source_revision bigint not null,cause_table text not null,cause_id text not null,created_at timestamptz not null default clock_timestamp());
create table public.cost_estimates(id uuid primary key default gen_random_uuid(),mission_id uuid not null references public.missions(id),line_key text not null,description text not null,amount_minor bigint not null check(amount_minor between 0 and 9007199254740991),currency text not null check(currency~'^[A-Z]{3}$'),created_at timestamptz not null default clock_timestamp(),unique(mission_id,id),unique(mission_id,line_key));
create table public.cost_acceptances(id uuid primary key default gen_random_uuid(),mission_id uuid not null,cost_line_id uuid not null,evidence_id uuid not null,artifact_version_id uuid not null,amount_minor bigint not null check(amount_minor between 0 and 9007199254740991),currency text not null,created_at timestamptz not null default clock_timestamp(),unique(cost_line_id,artifact_version_id),foreign key(mission_id,cost_line_id)references public.cost_estimates(mission_id,id),foreign key(mission_id,evidence_id)references public.evidence(mission_id,id),foreign key(mission_id,artifact_version_id)references public.artifact_versions(mission_id,id));
create table public.mission_obstacles(id uuid primary key default gen_random_uuid(),mission_id uuid not null references public.missions(id),kind text not null,description text not null,source_evidence_ids uuid[]not null,created_at timestamptz not null default clock_timestamp(),unique(mission_id,id));
create table public.obstacle_resolutions(id uuid primary key default gen_random_uuid(),mission_id uuid not null,obstacle_id uuid not null unique,evidence_ids uuid[]not null,founder_decision_id uuid,created_at timestamptz not null default clock_timestamp(),foreign key(mission_id,obstacle_id)references public.mission_obstacles(mission_id,id),foreign key(mission_id,founder_decision_id)references public.decisions(mission_id,id));
do $$declare t text;begin foreach t in array array['readiness_observations','cost_estimates','cost_acceptances','mission_obstacles','obstacle_resolutions']loop
 execute format('alter table public.%I enable row level security',t);execute format('alter table public.%I force row level security',t);
 execute format('create policy mission_scope on public.%I using(private.owns_mission(mission_id))',t);
 execute format('create trigger immutable_row before update or delete on public.%I for each row execute function private.immutable_row()',t);
 execute format('grant select on public.%I to founder_role,lead_role,specialist_role',t);
 execute format('create trigger ledger_revision after insert on public.%I for each row execute function private.record_ledger_revision()',t);
 execute format('create trigger broadcast_ledger after insert on public.%I for each row execute function private.broadcast_ledger()',t);
end loop;end$$;
create function private.observe_readiness()returns trigger language plpgsql security definer set search_path=''as $$declare mission uuid;r record;prior public.readiness_observations;rev bigint;begin
 mission:=coalesce(to_jsonb(new)->>'mission_id',to_jsonb(new)->>'id')::uuid;
 -- Import/admin writes without founder scope cannot invent historical milestones.
 if not private.owns_mission(mission)then return null;end if;
 select coalesce(max(revision),0)into rev from public.ledger_events where mission_id=mission;
 for r in select*from public.readiness(mission)loop
  select*into prior from public.readiness_observations where mission_id=mission and outcome=r.outcome order by created_at desc,id desc limit 1;
  if prior.id is null or prior.level<>r.level or prior.missing is distinct from r.missing then insert into public.readiness_observations(mission_id,outcome,level,missing,source_revision,cause_table,cause_id)values(mission,r.outcome,r.level,r.missing,rev,tg_table_name,new.id::text);end if;
 end loop;return null;
end$$;
do $$declare t text;begin foreach t in array array['missions','evidence','artifact_statuses','decision_resolutions','decision_supersessions','stale_marks','inspection_commitments','commitment_states']loop execute format('create constraint trigger observe_readiness after insert on public.%I deferrable initially deferred for each row execute function private.observe_readiness()',t);end loop;end$$;
create function public.record_cost_estimate(p_mission uuid,p_key text,p_description text,p_amount bigint,p_currency text)returns uuid language plpgsql security definer set search_path=''as $$declare found public.cost_estimates;begin
 perform private.require_role(array['lead_role','specialist_role']);perform private.lock_mission(p_mission);
 if length(p_key)not between 1 and 120 or length(p_description)not between 1 and 1000 or p_currency is distinct from(select currency from public.effective_missions where id=p_mission)then raise exception 'validation: scoped estimate in mission currency required';end if;
 select*into found from public.cost_estimates where mission_id=p_mission and line_key=p_key;
 if found.id is not null then if found.description<>p_description or found.amount_minor<>p_amount or found.currency<>p_currency then raise exception 'invariant_violation: first cost estimate is immutable';end if;return found.id;end if;
 insert into public.cost_estimates(mission_id,line_key,description,amount_minor,currency)values(p_mission,p_key,p_description,p_amount,p_currency)returning id into found.id;return found.id;
end$$;
create function public.accept_cost_line(p_mission uuid,p_decision uuid,p_version uuid)returns uuid language plpgsql security definer set search_path=''as $$declare c jsonb;line public.cost_estimates;e public.evidence;body jsonb;quantity bigint;amount numeric;fx public.fx_quotes;result uuid;begin
 perform private.require_role(array['founder_role']);perform private.lock_mission(p_mission);
 if p_version not in(select private.selected_approved_versions(p_mission,p_decision))or not private.readiness_current_approved(p_mission,p_version)then raise exception 'needs_approval: selected approved cost acceptance required';end if;
 select content->'costAcceptance'into c from public.artifact_versions where mission_id=p_mission and id=p_version;
 if jsonb_typeof(c)is distinct from'object'or c-array['costLineId','evidenceId','quantity','fxQuoteId']<>'{}'::jsonb then raise exception 'validation: cost acceptance references only';end if;
 select*into strict line from public.cost_estimates where mission_id=p_mission and id=(c->>'costLineId')::uuid;
 select*into strict e from public.evidence where mission_id=p_mission and id=coalesce((c->>'evidenceId')::uuid,(select id from public.evidence where mission_id=p_mission and kind='accepted_quote'and source_reference='accepted-quote:'||p_version::text)) and trust in('verified','founder_confirmed')and(kind='accepted_quote'or payload->>'accepted'='true')and not exists(select from public.stale_marks where node_id=evidence.id)and not exists(select from public.evidence n where n.supersedes_id=evidence.id);
 quantity:=coalesce((c->>'quantity')::bigint,1);if quantity not between 1 and 999999999 then raise exception 'validation: positive bounded quantity required';end if;
 body:=case when jsonb_typeof(e.payload->'terms')='object'then e.payload->'terms'else e.payload end;
 if coalesce(body->>'unitPriceMinor',body->>'amountMinor','')!~'^[0-9]{1,15}$'then raise exception 'validation: accepted source amount required';end if;
 amount:=coalesce(body->>'unitPriceMinor',body->>'amountMinor')::numeric*quantity;
 if body->>'currency'is distinct from line.currency then select*into strict fx from public.fx_quotes where mission_id=p_mission and id=(c->>'fxQuoteId')::uuid and from_currency=body->>'currency'and to_currency=line.currency and observed_at<=clock_timestamp()and expires_at>clock_timestamp();amount:=ceil(amount*fx.numerator/fx.denominator);end if;
 if amount>9007199254740991 then raise exception 'validation: accepted cost exceeds safe integer money';end if;
 insert into public.cost_acceptances(mission_id,cost_line_id,evidence_id,artifact_version_id,amount_minor,currency)values(p_mission,line.id,e.id,p_version,amount::bigint,line.currency)on conflict(cost_line_id,artifact_version_id)do nothing returning id into result;
 insert into public.dependencies(mission_id,upstream_id,dependent_id,reason)values(p_mission,e.id,p_version,'accepted cost source')on conflict do nothing;
 return coalesce(result,(select id from public.cost_acceptances where cost_line_id=line.id and artifact_version_id=p_version));
end$$;
create function public.record_obstacle(p_mission uuid,p_kind text,p_description text,p_sources uuid[])returns uuid language plpgsql security definer set search_path=''as $$declare result uuid;begin
 perform private.require_role(array['lead_role','specialist_role']);perform private.lock_mission(p_mission);
 if p_kind not in('unresponsive_supplier','changed_terms','provider_outage','quality_failure','compliance_gap','budget_gap','requirement_change','other')or length(p_description)not between 1 and 1000 or cardinality(p_sources)<1 or exists(select from unnest(p_sources)s where not exists(select from public.evidence where mission_id=p_mission and id=s))then raise exception 'validation: sourced obstacle required';end if;
 insert into public.mission_obstacles(mission_id,kind,description,source_evidence_ids)values(p_mission,p_kind,p_description,p_sources)returning id into result;return result;
end$$;
create function public.resolve_obstacle(p_mission uuid,p_obstacle uuid,p_evidence uuid[],p_decision uuid default null)returns uuid language plpgsql security definer set search_path=''as $$declare result uuid;begin
 perform private.require_role(array['lead_role','specialist_role']);perform private.lock_mission(p_mission);
 if not exists(select from public.mission_obstacles where mission_id=p_mission and id=p_obstacle)or coalesce(cardinality(p_evidence),0)<1 or exists(select from unnest(p_evidence)s where not exists(select from public.evidence e where e.mission_id=p_mission and e.id=s and e.trust in('verified','founder_confirmed','performed')and not exists(select from public.stale_marks where node_id=e.id)and not exists(select from public.evidence n where n.supersedes_id=e.id)))then raise exception 'validation: current observed resolution evidence required';end if;
 if p_decision is not null and not exists(select from public.active_decisions where mission_id=p_mission and id=p_decision)then raise exception 'validation: resolution decision is not current';end if;
 insert into public.obstacle_resolutions(mission_id,obstacle_id,evidence_ids,founder_decision_id)values(p_mission,p_obstacle,p_evidence,p_decision)on conflict(obstacle_id)do nothing returning id into result;return coalesce(result,(select id from public.obstacle_resolutions where obstacle_id=p_obstacle));
end$$;
revoke all on function private.observe_readiness(),public.record_cost_estimate(uuid,text,text,bigint,text),public.accept_cost_line(uuid,uuid,uuid),public.record_obstacle(uuid,text,text,uuid[]),public.resolve_obstacle(uuid,uuid,uuid[],uuid)from public;
grant execute on function public.record_cost_estimate(uuid,text,text,bigint,text),public.record_obstacle(uuid,text,text,uuid[]),public.resolve_obstacle(uuid,uuid,uuid[],uuid)to lead_role,specialist_role;
grant execute on function public.accept_cost_line(uuid,uuid,uuid)to founder_role;

create function private.business_metrics_data(p_mission uuid)returns jsonb language sql stable security definer set search_path=''as $$
 with m as(select*from public.effective_missions where id=p_mission),
 receipts as(select*from public.provider_receipts where mission_id=p_mission),
 contacts as(select distinct a.intent->>'counterpartyId' supplier from receipts r join public.effect_authorizations a on a.id=r.authorization_id join public.counterparties c on c.id::text=a.intent->>'counterpartyId'where r.operation='send_message'and c.kind='supplier'),
 responders as(select distinct q.supplier_id from public.sourcing_quote_ingestions q where q.mission_id=p_mission and q.status='confirmed_reading'and q.supplier_id::text in(select supplier from contacts)and not exists(select from public.stale_marks where node_id=q.source_evidence_id)and not exists(select from public.evidence n where n.supersedes_id=q.source_evidence_id)and(select count(distinct e.payload->>'independentSource')from public.evidence e where e.mission_id=p_mission and e.payload->>'supplierId'=q.supplier_id::text and e.trust in('verified','founder_confirmed')and e.kind='supplier_signal'and e.payload->>'signalKind'in('registry','address','marketplace_history','factory_video','reference')and not exists(select from public.stale_marks where node_id=e.id)and not exists(select from public.evidence n where n.supersedes_id=e.id))>=2),
 turnaround as(select extract(epoch from(r.created_at-d.created_at))seconds from public.decisions d join public.decision_resolutions r on r.decision_id=d.id where d.mission_id=p_mission and r.resolution_source='founder'and r.response in('approve','choose','reject')),
 costs as(select e.*,a.amount_minor accepted_minor,a.evidence_id,a.artifact_version_id,a.created_at accepted_at from public.cost_estimates e left join lateral(select*from public.cost_acceptances a where a.cost_line_id=e.id order by created_at desc,id desc limit 1)a on true where e.mission_id=p_mission),
 totals as(select*from public.money_totals where mission_id=p_mission),
 obstacles as(select o.*,r.id resolution_id,r.created_at resolved_at,r.founder_decision_id from public.mission_obstacles o left join public.obstacle_resolutions r on r.obstacle_id=o.id where o.mission_id=p_mission),
 launch as(select min(t.created_at)at from public.mission_transitions t join public.decision_resolutions r on r.decision_id=t.terminal_decision_id and r.option_id='launch'where t.mission_id=p_mission and t.status='ended')
 select jsonb_build_object('missionId',m.id,'sandboxMode',m.sandbox_mode,'observedAt',clock_timestamp(),'startedAt',m.created_at,
 'externalActionsPerformed',(select count(*)from receipts where length(provider_reference)>0 and provider<>'launch-operator-demand'),
 'decisionsRequested',(select count(*)from public.decisions where mission_id=p_mission),
 'founderCorrections',(select count(*)from public.command_requests where mission_id=p_mission and kind='requestChange'),
 'decisionTurnaroundSeconds',(select coalesce(jsonb_agg(seconds),'[]')from turnaround),'medianDecisionTurnaroundSeconds',(select percentile_cont(0.5)within group(order by seconds)from turnaround),
 'supplierContacted',(select count(*)from contacts),'verifiedUsableSupplierResponses',(select count(*)from responders),'verifiedSupplierResponseRate',(select count(*)from responders)::numeric/nullif((select count(*)from contacts),0),
 'focusedWorkspaceSeconds',(select coalesce(sum(active_seconds),0)from public.founder_presence where mission_id=p_mission),
 'modeCEffortMinutes',(select sum((payload->>'effortMinutes')::numeric)from public.evidence where mission_id=p_mission and kind='kit_verified'and trust='founder_confirmed'and payload->>'effortMinutes'~'^[0-9]{1,5}$'),
 'effortBasis','Workspace is a focused heartbeat estimate. Mode C effort is only explicit founder-reported time; missing is unknown.',
 'budgetMinor',case when m.metadata->>'budgetMinor'~'^[0-9]{1,15}$'then(m.metadata->>'budgetMinor')::bigint end,
 'moneyBySandbox',(select coalesce(jsonb_agg(jsonb_build_object('currency',currency,'sandboxMode',sandbox_mode,'spentMinor',spent_minor-refund_minor,'committedMinor',committed_minor,'budgetAdherence',case when m.metadata->>'budgetMinor'~'^[1-9][0-9]{0,14}$'then(spent_minor-refund_minor+committed_minor)::numeric/(m.metadata->>'budgetMinor')::numeric end)),'[]')from totals),
 'estimateAccuracy',(select coalesce(jsonb_agg(jsonb_build_object('lineId',id,'lineKey',line_key,'currency',currency,'firstEstimateMinor',amount_minor,'acceptedMinor',accepted_minor,'acceptedAt',accepted_at,'sourceEvidenceId',evidence_id,'artifactVersionId',artifact_version_id,'relativeError',case when amount_minor>0 then(accepted_minor-amount_minor)::numeric/amount_minor end)),'[]')from costs),
 'obstaclesTotal',(select count(*)from obstacles),'obstaclesResolved',(select count(*)from obstacles where resolution_id is not null),
 'obstaclesResolvedWithoutFounderDecision',(select count(*)from obstacles o where resolution_id is not null and founder_decision_id is null and not exists(select from public.decision_resolutions r where r.mission_id=p_mission and r.resolution_source='founder'and r.created_at between o.created_at and o.resolved_at)),
 'readinessMilestones',(select coalesce(jsonb_agg(jsonb_build_object('outcome',outcome,'level',level,'firstObservedAt',at,'secondsFromMissionStart',extract(epoch from(at-m.created_at)))),'[]')from(select outcome,n level,min(created_at)at from public.readiness_observations cross join generate_series(0,5)n where mission_id=p_mission and readiness_observations.level>=n group by outcome,n)r),
 'readinessHistoryCompleteFrom',(select min(created_at)from public.readiness_observations where mission_id=p_mission),
 'launchAt',(select at from launch),'calendarSecondsToLaunch',(select extract(epoch from(at-m.created_at))from launch),
 'honestyIncidentsKnown',(select count(*)from public.activity where mission_id=p_mission and label='performed'and receipt_id is null),
 'honestyMeasurementLimit','Structural missing-receipt count only; semantic honesty requires reviewed evaluations.')from m
$$;
create function public.mission_business_metrics(p_mission uuid)returns jsonb language plpgsql stable security definer set search_path=''as $$begin perform private.require_role(array['founder_role','lead_role']);perform private.assert_mission(p_mission);return private.business_metrics_data(p_mission);end$$;
create function public.operator_business_metrics()returns jsonb language plpgsql stable security definer set search_path=''as $$begin perform private.require_role(array['operator_role']);return jsonb_build_object('observedAt',clock_timestamp(),'missions',(select coalesce(jsonb_agg(private.business_metrics_data(id)),'[]')from public.missions));end$$;
revoke all on function private.business_metrics_data(uuid),public.mission_business_metrics(uuid),public.operator_business_metrics()from public;
grant execute on function public.mission_business_metrics(uuid)to founder_role,lead_role;
grant execute on function public.operator_business_metrics()to operator_role;
commit;
