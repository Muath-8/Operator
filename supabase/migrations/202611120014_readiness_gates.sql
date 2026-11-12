begin;
-- Append a reviewed structural rules version. Prior immutable rules remain history;
-- 'reviewed' describes the coded BRD mapping, not a human category/domain signoff.
alter table public.readiness_rules add column founder_kinds text[] not null default '{}';
alter table public.readiness_rules add column ledger_gate text check(ledger_gate='sourcing_sequence');
insert into public.readiness_rules(id,version,outcome,level,evidence_kinds,decision_gates,high_trust,review_status,performed_kinds,founder_kinds,ledger_gate)
select outcome||':'||level||':v2',2,outcome,level,
case when level=5 and outcome='brand' then array['name_availability','name_approved','founder_owned_domain','founder_owned_handles','trademark_screen','identity_approved','guidelines_approved','identity_assets_delivered']
when level=5 and outcome='demand' then array['validation_result','first_customer_channel','launch_week_plan','launch_content_approved']else evidence_kinds end,
decision_gates,high_trust,review_status,
case when level=5 then array['founder_owned_domain','founder_owned_handles','identity_assets_delivered','production_or_fulfilment','domain_live','store_published','shipping_configured']else performed_kinds end,
case when level=5 and outcome='brand' then array['name_approved','identity_approved','guidelines_approved']when level=5 and outcome='demand' then array['launch_week_plan','launch_content_approved']else '{}'::text[]end,
case when level=5 and outcome='supply'then 'sourcing_sequence' end
from public.readiness_rules where version=1;

create function private.readiness_current_approved(p_mission uuid,p_version uuid)returns boolean language sql stable security definer set search_path=''as $$
 select exists(select from public.artifact_versions v where v.mission_id=p_mission and v.id=p_version
 and not exists(select from public.artifact_versions n where n.artifact_id=v.artifact_id and n.version_no>v.version_no)
 and not exists(select from public.stale_marks s where s.mission_id=p_mission and s.node_id=v.id)
 and(select s.status='approved'and exists(select from public.active_decisions d where d.mission_id=p_mission and d.id=s.decision_id)from public.artifact_statuses s where s.mission_id=p_mission and s.artifact_version_id=v.id order by s.created_at desc,s.id desc limit 1))
$$;
create function private.readiness_date(p_value text)returns timestamptz language plpgsql immutable set search_path=''as $$begin
 if p_value !~ '^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?(Z|[+-]((0\d|1[0-3]):[0-5]\d|14:00))$' then return null;end if;
 return p_value::timestamptz;
 exception when invalid_datetime_format or datetime_field_overflow then return null;
end$$;
create function private.readiness_proforma(p_content jsonb)returns boolean language plpgsql immutable set search_path=''as $$declare p jsonb:=p_content->'proformaInvoice';amount numeric;begin
 if jsonb_typeof(p->'amountMinor')is distinct from 'number'or jsonb_typeof(p->'currency')is distinct from 'string'or jsonb_typeof(p->'incoterm')is distinct from 'string'or p->>'currency'!~'^[A-Z]{3}$'or length(trim(coalesce(p->>'incoterm','')))=0 then return false;end if;
 amount:=(p->>'amountMinor')::numeric;
 return amount>0 and amount<=9007199254740991 and trunc(amount)=amount and p->>'currency' is not null;
 exception when invalid_text_representation or numeric_value_out_of_range then return false;
end$$;
-- Typed semantics cannot be inferred from a generic commitment's free text.
-- The checked constructor creates the actual pre-shipment commitment and binds
-- its checklist to one approved proforma and its exact approved specification.
create table public.inspection_commitments(
 id uuid primary key default gen_random_uuid(),mission_id uuid not null references public.missions(id),commitment_id uuid not null unique,
 proforma_version_id uuid not null,spec_version_id uuid not null,checks text[] not null check(cardinality(checks)between 1 and 50),
 purpose text not null default 'pre_shipment_before_balance'check(purpose='pre_shipment_before_balance'),created_at timestamptz not null default clock_timestamp(),
 unique(mission_id,id),foreign key(mission_id,commitment_id)references public.commitments(mission_id,id),
 foreign key(mission_id,proforma_version_id)references public.artifact_versions(mission_id,id),foreign key(mission_id,spec_version_id)references public.artifact_versions(mission_id,id)
);
alter table public.inspection_commitments enable row level security;
alter table public.inspection_commitments force row level security;
create policy mission_scope on public.inspection_commitments using(private.owns_mission(mission_id))with check(private.owns_mission(mission_id));
create trigger immutable_row before update or delete on public.inspection_commitments for each row execute function private.immutable_row();
grant select on public.inspection_commitments to founder_role,lead_role,specialist_role,policy_role,ingress_role,voice_role;
-- Native state-only migrations1–4 do not include the runtime revision trigger.
do $$begin if to_regprocedure('private.record_ledger_revision()')is not null then execute 'create trigger ledger_revision after insert on public.inspection_commitments for each row execute function private.record_ledger_revision()';end if;end$$;
create trigger broadcast_ledger after insert on public.inspection_commitments for each row execute function private.broadcast_ledger();
create function public.open_inspection_commitment(p_mission uuid,p_party uuid,p_proforma uuid,p_checks text[],p_due timestamptz)returns uuid language plpgsql security definer set search_path=''as $$
declare spec uuid;commitment uuid;begin
 perform private.require_role(array['lead_role','specialist_role']);perform private.lock_mission(p_mission);
 if p_checks is null or cardinality(p_checks)not between 1 and 50 or exists(select from unnest(p_checks)c where c is null or length(trim(c))=0)or p_due is null or not isfinite(p_due)then raise exception 'validation: dated inspection checklist required';end if;
 select s.id into spec from public.artifact_versions v join public.artifacts a on a.mission_id=v.mission_id and a.id=v.artifact_id
 join public.artifact_versions s on s.mission_id=v.mission_id and s.id::text=v.content->'proformaInvoice'->>'specVersionId'
 join public.artifacts sa on sa.mission_id=s.mission_id and sa.id=s.artifact_id
 where v.mission_id=p_mission and v.id=p_proforma and a.type='proforma_invoice'and a.outcome='supply'and sa.outcome='product'
 and private.readiness_proforma(v.content)and private.readiness_current_approved(p_mission,v.id)and private.readiness_current_approved(p_mission,s.id);
 if spec is null then raise exception 'validation: inspection requires a current approved proforma and exact specification';end if;
 commitment:=public.open_commitment(p_mission,p_party,'inbound','Pre-shipment inspection of the approved proforma/specification before balance payment',p_due);
 insert into public.inspection_commitments(mission_id,commitment_id,proforma_version_id,spec_version_id,checks)values(p_mission,commitment,p_proforma,spec,p_checks);
 insert into public.dependencies(mission_id,upstream_id,dependent_id,reason)values(p_mission,p_proforma,commitment,'inspection approved proforma'),(p_mission,spec,commitment,'inspection exact specification');return commitment;
end$$;
revoke all on function public.open_inspection_commitment(uuid,uuid,uuid,text[],timestamptz)from public;
grant execute on function public.open_inspection_commitment(uuid,uuid,uuid,text[],timestamptz)to lead_role,specialist_role;
create function private.readiness_sourcing(p_mission uuid)returns table(missing text[],evidence_ids uuid[])language plpgsql stable security definer set search_path=''as $$
declare risk uuid;inspection uuid;has_proforma boolean;begin
 -- A risk exception is an explicit dated founder confirmation of the chosen,
 -- current approved frozen source. Claimed/verified/model-authored risk is invalid.
 select e.id into risk from public.evidence e join public.active_decisions d on d.mission_id=e.mission_id and d.id::text=e.payload->>'decisionId'
 join public.decision_resolutions r on r.decision_id=d.id and r.response in('approve','choose')
 join public.artifact_versions v on v.mission_id=e.mission_id and v.id::text=e.payload->>'artifactVersionId'
 join public.artifacts source on source.mission_id=v.mission_id and source.id=v.artifact_id and source.outcome='supply'
 where e.mission_id=p_mission and e.outcome='supply' and e.kind='sourcing_risk_accepted' and e.trust='founder_confirmed'
 and e.payload->'riskAccepted'='true'::jsonb and jsonb_typeof(e.payload->'statement')='string'and length(trim(coalesce(e.payload->>'statement','')))>0
 and private.readiness_date(e.payload->>'confirmedAt')<=current_timestamp
 and d.kind='engagement' and d.outcome='supply' and d.gate='sourcing_risk_accepted'
 and v.id=any(d.approved_version_refs) and exists(select from jsonb_array_elements(d.packet->'options')o where o->>'id'=r.option_id
 and coalesce(o->'artifactVersionIds',case when jsonb_array_length(d.packet->'options')=1 then to_jsonb(d.approved_version_refs)else '[]'::jsonb end)?v.id::text)
 and private.readiness_current_approved(p_mission,v.id)
 and v.content->'founderConfirmation'->>'kind'='sourcing_risk_accepted' and v.content->'founderConfirmation'->>'outcome'='supply'
 and jsonb_typeof(v.content->'founderConfirmation'->'statement')='string'and v.content->'founderConfirmation'->>'statement'=e.payload->>'statement' and v.content->'founderConfirmation'->'payload'->'riskAccepted'='true'::jsonb
 and not exists(select from public.stale_marks s where s.mission_id=p_mission and s.node_id=e.id)
 and not exists(select from public.evidence n where n.mission_id=p_mission and n.supersedes_id=e.id)limit 1;
 if risk is not null then missing:='{}';evidence_ids:=array[risk];return next;return;end if;
 select exists(select from public.artifacts a join public.artifact_versions v on v.mission_id=a.mission_id and v.artifact_id=a.id
 join public.artifact_versions spec on spec.mission_id=v.mission_id and spec.id::text=v.content->'proformaInvoice'->>'specVersionId'
 join public.artifacts spec_artifact on spec_artifact.mission_id=spec.mission_id and spec_artifact.id=spec.artifact_id
 where a.mission_id=p_mission and a.outcome='supply' and a.type='proforma_invoice' and spec_artifact.outcome='product'
 and private.readiness_current_approved(p_mission,v.id)and private.readiness_current_approved(p_mission,spec.id)and private.readiness_proforma(v.content))into has_proforma;
 select e.id into inspection from public.evidence e join public.commitments c on c.mission_id=e.mission_id and c.id::text=e.payload->>'commitmentId'
 join public.inspection_commitments i on i.mission_id=c.mission_id and i.commitment_id=c.id
 join public.artifact_versions invoice on invoice.mission_id=i.mission_id and invoice.id=i.proforma_version_id
 join public.artifacts invoice_artifact on invoice_artifact.mission_id=invoice.mission_id and invoice_artifact.id=invoice.artifact_id
 join lateral(select cs.status,cs.closed_by_evidence_id from public.commitment_states cs where cs.mission_id=c.mission_id and cs.commitment_id=c.id order by cs.created_at desc,cs.id desc limit 1)state on true
 where e.mission_id=p_mission and e.outcome='supply' and e.kind='inspection_plan' and e.trust in('verified','founder_confirmed')
 and i.purpose='pre_shipment_before_balance'and cardinality(i.checks)>0 and not exists(select from unnest(i.checks)check_item where check_item is null or length(trim(check_item))=0)
 and invoice_artifact.type='proforma_invoice'and invoice_artifact.outcome='supply'and private.readiness_proforma(invoice.content)
 and private.readiness_current_approved(p_mission,i.proforma_version_id)and private.readiness_current_approved(p_mission,i.spec_version_id)
 and invoice.content->'proformaInvoice'->>'specVersionId'=i.spec_version_id::text
 and state.status<>'cancelled' and isfinite(c.due_at)
 and not exists(select from public.stale_marks s where s.mission_id=p_mission and s.node_id in(e.id,c.id))
 and not exists(select from public.evidence n where n.mission_id=p_mission and n.supersedes_id=e.id)
 and(state.status<>'closed'or exists(select from public.evidence proof where proof.id=state.closed_by_evidence_id and proof.mission_id=p_mission and proof.trust in('verified','founder_confirmed')and proof.kind='inspection_completed'and proof.outcome='supply'
 and proof.payload->>'commitmentId'=i.commitment_id::text and proof.payload->>'proformaVersionId'=i.proforma_version_id::text and proof.payload->>'specVersionId'=i.spec_version_id::text
 and not exists(select from public.stale_marks s where s.mission_id=p_mission and s.node_id=proof.id)and not exists(select from public.evidence n where n.mission_id=p_mission and n.supersedes_id=proof.id)))limit 1;
 missing:=case when has_proforma then '{}'::text[]else array['artifact:proforma_invoice']end||case when inspection is not null then '{}'::text[]else array['commitment:inspection']end;
 evidence_ids:=case when inspection is null then '{}'::uuid[]else array[inspection]end;return next;
end$$;
create or replace function public.readiness(p_mission uuid)returns table(outcome text,level integer,missing text[],evidence_ids uuid[],decision_ids uuid[],stale boolean)language plpgsql stable security definer set search_path=''as $$
declare v_outcome text;v_rule public.readiness_rules;v_missing text[];v_evidence uuid[];v_decisions uuid[];v_ledger record;begin
 perform private.assert_mission(p_mission);
 foreach v_outcome in array array['brand','product','supply','commerce','compliance','demand']loop
  outcome:=v_outcome;level:=0;missing:='{}';evidence_ids:='{}';decision_ids:='{}';
  stale:=exists(select from public.stale_marks s join public.state_nodes n on n.mission_id=s.mission_id and n.id=s.node_id where n.mission_id=p_mission and(n.id in(select e.id from public.evidence e where e.mission_id=p_mission and e.outcome=v_outcome)or n.id in(select d.id from public.decisions d where d.mission_id=p_mission and d.outcome=v_outcome)));
  for v_rule in select * from public.readiness_rules r where r.outcome=v_outcome and r.version=2 order by r.level loop
   select coalesce(array_agg(required),'{}')into v_missing from unnest(v_rule.evidence_kinds)required where not exists(
    select from public.evidence e where e.mission_id=p_mission and e.outcome=v_outcome and e.kind=required
    and(not(e.kind=any(v_rule.founder_kinds))or e.trust='founder_confirmed')
    and(not v_rule.high_trust or e.trust in('verified','founder_confirmed')or(e.trust='performed'and e.kind=any(v_rule.performed_kinds)))
    and not exists(select from public.evidence n where n.mission_id=p_mission and n.supersedes_id=e.id)and not exists(select from public.stale_marks s where s.mission_id=p_mission and s.node_id=e.id));
   select v_missing||coalesce(array_agg('decision:'||required),'{}')into v_missing from unnest(v_rule.decision_gates)required where not exists(select from public.active_decisions d where d.mission_id=p_mission and d.outcome=v_outcome and d.gate=required);
   if v_rule.ledger_gate='sourcing_sequence'then select * into v_ledger from private.readiness_sourcing(p_mission);v_missing:=v_missing||v_ledger.missing;end if;
   if cardinality(v_missing)>0 then missing:=v_missing;exit;end if;
   level:=v_rule.level;
   select coalesce(array_agg(e.id),'{}')into v_evidence from public.evidence e where e.mission_id=p_mission and e.outcome=v_outcome and e.kind=any(v_rule.evidence_kinds)
    and(not(e.kind=any(v_rule.founder_kinds))or e.trust='founder_confirmed')
    and(not v_rule.high_trust or e.trust in('verified','founder_confirmed')or(e.trust='performed'and e.kind=any(v_rule.performed_kinds)))
    and not exists(select from public.stale_marks s where s.mission_id=p_mission and s.node_id=e.id)and not exists(select from public.evidence n where n.mission_id=p_mission and n.supersedes_id=e.id);
   select coalesce(array_agg(d.id),'{}')into v_decisions from public.active_decisions d where d.mission_id=p_mission and d.outcome=v_outcome and d.gate=any(v_rule.decision_gates);
   evidence_ids:=evidence_ids||v_evidence;decision_ids:=decision_ids||v_decisions;
   if v_rule.ledger_gate='sourcing_sequence'then evidence_ids:=evidence_ids||v_ledger.evidence_ids;end if;
  end loop;return next;
 end loop;
end$$;
revoke all on function private.readiness_current_approved(uuid,uuid),private.readiness_date(text),private.readiness_proforma(jsonb),private.readiness_sourcing(uuid)from public;
commit;
