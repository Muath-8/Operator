begin;
create table public.financial_plans(id uuid primary key default gen_random_uuid(),mission_id uuid not null,decision_id uuid not null,artifact_version_id uuid not null unique,total_envelope_minor bigint not null check(total_envelope_minor>=0),created_at timestamptz not null default clock_timestamp(),foreign key(mission_id,decision_id)references public.decisions(mission_id,id),foreign key(mission_id,artifact_version_id)references public.artifact_versions(mission_id,id));
create table public.generated_launch_records(id uuid primary key default gen_random_uuid(),mission_id uuid not null,artifact_version_id uuid not null unique,source_revision bigint not null,created_at timestamptz not null default clock_timestamp(),foreign key(mission_id,artifact_version_id)references public.artifact_versions(mission_id,id));
do $$declare t text;begin foreach t in array array['financial_plans','generated_launch_records']loop
 execute format('alter table public.%I enable row level security',t);execute format('alter table public.%I force row level security',t);
 execute format('create policy mission_scope on public.%I using(private.owns_mission(mission_id))with check(private.owns_mission(mission_id))',t);
 execute format('create trigger immutable_row before update or delete on public.%I for each row execute function private.immutable_row()',t);
 execute format('grant select on public.%I to founder_role,lead_role,specialist_role,policy_role',t);
 execute format('create trigger ledger_revision after insert on public.%I for each row execute function private.record_ledger_revision()',t);
 execute format('create trigger broadcast_ledger after insert on public.%I for each row execute function private.broadcast_ledger()',t);
end loop;end$$;
create function private.current_financial_version(p_mission uuid)returns uuid language sql stable security definer set search_path=''as $$
 select p.artifact_version_id from public.financial_plans p
 join public.effective_missions m on m.id=p.mission_id
 join public.artifact_versions v on v.id=p.artifact_version_id
 where p.mission_id=p_mission and private.readiness_current_approved(p_mission,p.artifact_version_id)
 and v.content->'financialPlan'->>'currency'=m.currency
 and (coalesce(m.metadata->>'budgetMinor','')!~'^[0-9]{1,15}$' or p.total_envelope_minor<=(m.metadata->>'budgetMinor')::bigint)
 order by p.created_at desc,p.id desc limit 1
$$;
create function private.current_budget_ceiling(p_mission uuid)returns bigint language plpgsql stable security definer set search_path=''as $$
declare version uuid;budget bigint;begin
 version:=private.current_financial_version(p_mission);
 if version is not null then return(select total_envelope_minor from public.financial_plans where artifact_version_id=version);end if;
 if exists(select from public.financial_plans where mission_id=p_mission)then raise exception 'needs_approval: financial plan is stale or superseded';end if;
 select case when metadata->>'budgetMinor'~'^[0-9]{1,15}$'then(metadata->>'budgetMinor')::bigint end into budget from public.effective_missions where id=p_mission;
 return coalesce(budget,(select sum(amount_minor)from public.money_ledger where mission_id=p_mission and kind='envelope'));
end$$;
create function public.current_financial_plan(p_mission uuid)returns uuid language plpgsql stable security definer set search_path=''as $$begin perform private.require_role(array['founder_role','lead_role','specialist_role','policy_role']);perform private.assert_mission(p_mission);return private.current_financial_version(p_mission);end$$;
create function private.cost_line_matches(p_mission uuid,p_line jsonb,p_currency text,p_accepted boolean)returns boolean language plpgsql stable security definer set search_path=''as $$
declare ref text;e public.evidence;body jsonb;amount numeric;quantity bigint;fx public.fx_quotes;begin
 if coalesce(p_line->>'quantity','1')!~'^[1-9][0-9]{0,8}$'then return false;end if;quantity:=coalesce((p_line->>'quantity')::bigint,1);
 for ref in select jsonb_array_elements_text(p_line->'evidenceIds')loop
  select*into e from public.evidence where mission_id=p_mission and id::text=ref and trust in('claimed','verified','founder_confirmed')and not exists(select from public.stale_marks where node_id=evidence.id)and not exists(select from public.evidence newer where newer.supersedes_id=evidence.id);
  if e.id is null or(p_accepted and(e.trust not in('verified','founder_confirmed')or not coalesce(e.kind='accepted_quote'or e.payload->>'accepted'='true',false)))then continue;end if;
  body:=case when jsonb_typeof(e.payload->'terms')='object'then e.payload->'terms'else e.payload end;
  if coalesce(body->>'unitPriceMinor',body->>'amountMinor','')!~'^[0-9]{1,15}$'then continue;end if;
  amount:=coalesce(body->>'unitPriceMinor',body->>'amountMinor')::numeric*quantity;
  if body->>'currency'is distinct from p_currency then
   select*into fx from public.fx_quotes where mission_id=p_mission and id::text=p_line->>'fxQuoteId'and from_currency=body->>'currency'and to_currency=p_currency and observed_at<=clock_timestamp()and expires_at>clock_timestamp();
   if fx.id is null then continue;end if;amount:=ceil(amount*fx.numerator/fx.denominator);
  end if;
  if amount=(p_line->>'amountMinor')::numeric then return true;end if;
 end loop;return false;
end$$;
create function public.apply_financial_plan(p_mission uuid,p_decision uuid,p_version uuid)returns void language plpgsql security definer set search_path=''as $$
declare plan jsonb;item jsonb;v_currency text;total bigint:=0;forecast_total numeric:=0;goal_budget bigint;ref text;prior_decision uuid;begin
 perform private.require_role(array['founder_role']);perform private.lock_mission(p_mission);
 if exists(select from public.financial_plans where artifact_version_id=p_version and mission_id=p_mission)then return;end if;
 if not exists(select from public.active_decisions where id=p_decision and mission_id=p_mission and kind in('constraint','change')and gate='financial_plan')or p_version not in(select private.selected_approved_versions(p_mission,p_decision))or not private.readiness_current_approved(p_mission,p_version)then raise exception 'needs_approval: exact approved financial plan required';end if;
 select f.decision_id into prior_decision from public.financial_plans f where mission_id=p_mission order by created_at desc,id desc limit 1;
 if prior_decision is not null and not exists(select from public.decisions where id=p_decision and kind='change'and supersedes_id=prior_decision)then raise exception 'needs_approval: replace a financial plan through Change';end if;
 select content->'financialPlan'into plan from public.artifact_versions where mission_id=p_mission and id=p_version;
 select m.currency,case when metadata->>'budgetMinor'~'^[0-9]{1,15}$'then(metadata->>'budgetMinor')::bigint end into v_currency,goal_budget from public.effective_missions m where id=p_mission;
 if jsonb_typeof(plan)is distinct from 'object'or plan->>'currency'is distinct from v_currency or jsonb_typeof(plan->'envelopes')is distinct from 'array'or jsonb_array_length(plan->'envelopes')not between 1 and 20 or jsonb_typeof(plan->'forecastToFirstRestock')is distinct from 'array'or jsonb_array_length(plan->'forecastToFirstRestock')not between 1 and 100 then raise exception 'validation: currency, envelopes and first-restock forecast required';end if;
 if(select count(distinct e->>'name')from jsonb_array_elements(plan->'envelopes')e)<>jsonb_array_length(plan->'envelopes')then raise exception 'validation: unique envelope names required';end if;
 for item in select *from jsonb_array_elements(plan->'envelopes')loop
  if coalesce(length(trim(item->>'name')),0)not between 1 and 80 or coalesce(item->>'amountMinor','')!~'^[0-9]{1,15}$'then raise exception 'validation: named integer budget envelope required';end if;
  total:=total+(item->>'amountMinor')::bigint;
 end loop;
 if total>9007199254740991 or(goal_budget is not null and total>goal_budget)then raise exception 'needs_approval: envelopes exceed approved goal budget';end if;
 for item in select *from jsonb_array_elements(plan->'forecastToFirstRestock')loop
  if not exists(select from jsonb_array_elements(plan->'envelopes')e where e->>'name'=item->>'envelope')or coalesce(item->>'amountMinor','')!~'^[0-9]{1,15}$'or coalesce(item->>'basis','')not in('estimate','claimed','accepted')or jsonb_typeof(item->'evidenceIds')is distinct from 'array'then raise exception 'validation: sourced forecast line required';end if;
  forecast_total:=forecast_total+(item->>'amountMinor')::numeric;if forecast_total>9007199254740991 then raise exception 'validation: forecast total exceeds safe integer money';end if;
  if item->>'basis'<>'estimate'and jsonb_array_length(item->'evidenceIds')=0 then raise exception 'validation: claimed or accepted forecast needs evidence';end if;
  if item->>'basis'<>'estimate'and not private.cost_line_matches(p_mission,item,v_currency,item->>'basis'='accepted')then raise exception 'validation: forecast amount or currency does not match its sourced quote';end if;
  for ref in select jsonb_array_elements_text(item->'evidenceIds')loop
   if not exists(select from public.evidence e where e.mission_id=p_mission and e.id::text=ref and not exists(select from public.stale_marks s where s.node_id=e.id)and not exists(select from public.evidence n where n.supersedes_id=e.id)and(item->>'basis'<>'accepted'or e.trust in('verified','founder_confirmed')))then raise exception 'validation: forecast evidence is missing, stale or insufficiently trusted';end if;
   insert into public.dependencies(mission_id,upstream_id,dependent_id,reason)values(p_mission,ref::uuid,p_version,'financial forecast evidence')on conflict do nothing;
  end loop;
 end loop;
 insert into public.financial_plans(mission_id,decision_id,artifact_version_id,total_envelope_minor)values(p_mission,p_decision,p_version,total);
 for item in select *from jsonb_array_elements(plan->'envelopes')loop
  insert into public.money_ledger(mission_id,kind,amount_minor,currency,basis,envelope,ref_id,sandbox_mode)select p_mission,'envelope',(item->>'amountMinor')::bigint,v_currency,'accepted',item->>'name',p_version,sandbox_mode from public.missions where id=p_mission;
 end loop;
 for item in select *from jsonb_array_elements(plan->'forecastToFirstRestock')loop
  insert into public.money_ledger(mission_id,kind,amount_minor,currency,basis,envelope,ref_id,sandbox_mode)select p_mission,'forecast',(item->>'amountMinor')::bigint,v_currency,item->>'basis',item->>'envelope',p_version,sandbox_mode from public.missions where id=p_mission;
 end loop;
end$$;
create function public.prepare_launch_record(p_mission uuid)returns uuid language plpgsql security definer set search_path=''as $$
declare snapshot jsonb;record jsonb:='{}';key text;artifact uuid;version uuid;revision bigint;begin
 perform private.require_role(array['lead_role']);perform private.lock_mission(p_mission);snapshot:=public.mission_snapshot(p_mission);
 foreach key in array array['mission','status','decisions','decision_resolutions','decision_supersessions','artifacts','artifact_versions','artifact_statuses','evidence','commitments','commitment_states','money_ledger','payments','payment_states','mandates','mandate_revocations','readiness']loop record:=record||jsonb_build_object(key,snapshot->key);end loop;
 -- Exclude previous generated records/closing packets to avoid recursive exports.
 record:=record||jsonb_build_object('artifact_versions',(select coalesce(jsonb_agg(v),'[]')from public.artifact_versions v where v.mission_id=p_mission and not exists(select from public.generated_launch_records g where g.artifact_version_id=v.id)),'financial_plans',(select coalesce(jsonb_agg(f),'[]')from public.financial_plans f where f.mission_id=p_mission),'inspection_commitments',(select coalesce(jsonb_agg(c),'[]')from public.inspection_commitments c where c.mission_id=p_mission),'current_financial_plan',private.current_financial_version(p_mission));
 record:=record||jsonb_build_object('founder_accounts',(select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'provider',a.provider,'status',a.status,'ownerFounderId',a.founder_id)),'[]')from public.founder_accounts a join public.missions m on m.founder_id=a.founder_id where m.id=p_mission),'generatedAt',clock_timestamp(),'schemaVersion',1);
 artifact:=public.create_artifact(p_mission,'launch_record','commerce','Launch Record');version:=public.append_artifact_version(p_mission,artifact,jsonb_build_object('launchRecord',record));perform public.set_artifact_status(p_mission,version,'proposed');
 select coalesce(max(l.revision),0)into revision from public.ledger_events l where mission_id=p_mission;
 insert into public.generated_launch_records(mission_id,artifact_version_id,source_revision)values(p_mission,version,revision);return version;
end$$;
create function private.assert_terminal_checklist(p_mission uuid,p_terminal text,p_closing uuid)returns void language plpgsql security definer set search_path=''as $$
declare closing jsonb;closing_decision uuid;record_decision uuid;c record;item jsonb;pricing uuid;launch_record uuid;source_revision bigint;price jsonb;cost jsonb;cost_sum bigint:=0;ref text;begin
 select content->'closingRecord'into closing from public.artifact_versions where mission_id=p_mission and id=p_closing;
 if jsonb_typeof(closing->'openCommitments')is distinct from 'array'then raise exception 'needs_approval: closing record must enumerate open commitments and recommended actions';end if;
 for c in select cm.*from public.commitments cm where cm.mission_id=p_mission and coalesce((select status from public.commitment_states s where s.commitment_id=cm.id order by created_at desc,id desc limit 1),'open')not in('closed','cancelled')loop
  if not exists(select from jsonb_array_elements(closing->'openCommitments')i where i->>'commitmentId'=c.id::text and i->>'ownerId'is not distinct from c.party_id::text and date_trunc('milliseconds',private.readiness_date(i->>'dueAt'))=date_trunc('milliseconds',c.due_at) and coalesce(length(trim(i->>'recommendedAction')),0)>0)then raise exception 'needs_approval: each open commitment needs its exact owner, date and action';end if;
 end loop;
 if p_terminal<>'launch'then return;end if;
 if private.current_financial_version(p_mission)is null then raise exception 'needs_approval: current approved budget and first-restock forecast required';end if;
 select decision_id into closing_decision from public.artifact_statuses where mission_id=p_mission and artifact_version_id=p_closing and status='approved'order by created_at desc,id desc limit 1;
 pricing:=(closing->'launch'->>'pricingVersionId')::uuid;launch_record:=(closing->'launch'->>'launchRecordVersionId')::uuid;
 if not coalesce(private.readiness_current_approved(p_mission,pricing),false)or not coalesce(private.readiness_current_approved(p_mission,launch_record),false)then raise exception 'needs_approval: current approved pricing and generated Launch Record required';end if;
 select decision_id into record_decision from public.artifact_statuses where mission_id=p_mission and artifact_version_id=launch_record and status='approved'order by created_at desc,id desc limit 1;
 select content->'pricing'into price from public.artifact_versions where id=pricing and mission_id=p_mission;
 if jsonb_typeof(price)is distinct from 'object'or jsonb_typeof(price->'costs')is distinct from 'array'or jsonb_array_length(price->'costs')=0 or coalesce(price->>'priceMinor','')!~'^[1-9][0-9]{0,14}$'or coalesce(price->>'landedCostMinor','')!~'^[0-9]{1,15}$'or price->>'currency'is distinct from(select currency from public.effective_missions where id=p_mission)then raise exception 'validation: approved unit pricing and accepted landed costs required';end if;
 for cost in select *from jsonb_array_elements(price->'costs')loop
  if cost->>'basis'is distinct from 'accepted'or coalesce(cost->>'amountMinor','')!~'^[0-9]{1,15}$'or jsonb_typeof(cost->'evidenceIds')is distinct from 'array'or jsonb_array_length(cost->'evidenceIds')=0 then raise exception 'needs_approval: launch costs must use accepted source quotes';end if;
  if not private.cost_line_matches(p_mission,cost,price->>'currency',true)then raise exception 'needs_approval: accepted cost amount or currency does not match its source';end if;
  for ref in select jsonb_array_elements_text(cost->'evidenceIds')loop
   if not exists(select from public.evidence e where e.mission_id=p_mission and e.id::text=ref and e.trust in('verified','founder_confirmed')and(e.kind='accepted_quote'or e.payload->>'accepted'='true')and not exists(select from public.stale_marks s where s.node_id=e.id)and not exists(select from public.evidence n where n.supersedes_id=e.id))then raise exception 'needs_approval: accepted cost evidence missing or stale';end if;
  end loop;cost_sum:=cost_sum+(cost->>'amountMinor')::bigint;
 end loop;
 if cost_sum<>(price->>'landedCostMinor')::bigint then raise exception 'validation: landed cost does not reconcile to accepted lines';end if;
 if exists(select from public.mandates m where m.mission_id=p_mission and private.mandate_exposure(p_mission,m.id)>m.ceiling_total)then raise exception 'invariant_violation: mandate exceeded';end if;
 if jsonb_typeof(closing->'launch'->'accountOwnershipConfirmedIds')is distinct from 'array'or exists(select from public.founder_accounts a join public.missions m on m.founder_id=a.founder_id where m.id=p_mission and not(closing->'launch'->'accountOwnershipConfirmedIds' ? a.id::text))then raise exception 'needs_approval: founder must confirm ownership of every configured account';end if;
 select g.source_revision into source_revision from public.generated_launch_records g where g.mission_id=p_mission and g.artifact_version_id=launch_record;
 if source_revision is null then raise exception 'validation: Launch Record must be generated from current ledgers';end if;
 if exists(select from public.ledger_events l where l.mission_id=p_mission and l.revision>source_revision and l.source_table in('money_ledger','commitments','commitment_states','evidence','mandates','mandate_revocations','stale_marks','mission_brief_revisions','financial_plans','provider_receipts'))then raise exception 'needs_approval: launch source ledgers changed; regenerate the Launch Record';end if;
 if exists(select from public.ledger_events l where l.mission_id=p_mission and l.revision>source_revision and (
  (l.source_table='artifact_versions'and exists(select from public.artifact_versions v where v.id::text=l.row_id and v.id not in(launch_record,p_closing)))
  or(l.source_table='artifact_statuses'and exists(select from public.artifact_statuses a join public.artifact_versions v on v.id=a.artifact_version_id where a.id::text=l.row_id and v.id not in(launch_record,p_closing)))
 ))then raise exception 'needs_approval: launch artifacts changed; regenerate the Launch Record';end if;
 if exists(select from public.ledger_events l join public.decisions d on d.mission_id=l.mission_id and(
   (l.source_table='decisions'and d.id::text=l.row_id)
   or(l.source_table='decision_resolutions'and exists(select from public.decision_resolutions r where r.id::text=l.row_id and r.decision_id=d.id))
   or(l.source_table='decision_supersessions'and exists(select from public.decision_supersessions r where r.id::text=l.row_id and(r.previous_id=d.id or r.replacement_id=d.id)))
  )where l.mission_id=p_mission and l.revision>source_revision
   and not coalesce(d.id=closing_decision and d.kind='terminal',false)
   and not coalesce(d.id=record_decision and d.kind='selection'and d.approved_version_refs=array[launch_record],false)
 )then raise exception 'needs_approval: launch decisions changed; regenerate the Launch Record';end if;
 if exists(select from public.founder_accounts a join public.missions m on m.founder_id=a.founder_id where m.id=p_mission and(a.created_at>(select created_at from public.generated_launch_records where artifact_version_id=launch_record)or exists(select from public.account_revocations r where r.account_id=a.id and r.created_at>(select created_at from public.generated_launch_records where artifact_version_id=launch_record))))then raise exception 'needs_approval: account ownership changed; regenerate the Launch Record';end if;

end$$;
-- Existing terminal authority and six R5 gates remain; this trigger adds the
-- mission-level closing and launch requirements in the same transaction.
create function private.check_terminal_insert()returns trigger language plpgsql security definer set search_path=''as $$declare terminal text;begin
 if new.status='ended'then select option_id into terminal from public.decision_resolutions where decision_id=new.terminal_decision_id and response in('approve','choose');perform private.assert_terminal_checklist(new.mission_id,terminal,new.closing_record_version_id);end if;return new;end$$;
create trigger mission_terminal_checklist before insert on public.mission_transitions for each row execute function private.check_terminal_insert();
revoke all on function public.current_financial_plan(uuid)from public;
grant execute on function public.current_financial_plan(uuid)to founder_role,lead_role,specialist_role,policy_role;
revoke all on function public.apply_financial_plan(uuid,uuid,uuid),public.prepare_launch_record(uuid)from public;
grant execute on function public.apply_financial_plan(uuid,uuid,uuid)to founder_role;
grant execute on function public.prepare_launch_record(uuid)to lead_role;
create or replace view public.money_totals with(security_invoker=true)as select mission_id,currency,sandbox_mode,coalesce(sum(amount_minor)filter(where kind='spent'),0)as spent_minor,coalesce(sum(amount_minor)filter(where kind='refund'),0)as refund_minor,coalesce(sum(amount_minor)filter(where kind='forecast'and(not exists(select from public.financial_plans f where f.mission_id=money_ledger.mission_id)or ref_id=public.current_financial_plan(mission_id))),0)as forecast_minor,coalesce(sum(amount_minor)filter(where kind='committed'and not exists(select from public.money_ledger paid where paid.mission_id=money_ledger.mission_id and paid.ref_id=money_ledger.ref_id and paid.kind='spent')),0)as committed_minor from public.money_ledger group by mission_id,currency,sandbox_mode;
revoke all on function private.current_financial_version(uuid),private.current_budget_ceiling(uuid),private.cost_line_matches(uuid,jsonb,text,boolean),private.assert_terminal_checklist(uuid,text,uuid),private.check_terminal_insert()from public;
commit;
