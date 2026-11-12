begin;
alter table public.decision_resolutions add column resolution_source text not null default 'founder'check(resolution_source in('founder','system_default'));
create table public.decision_moments(
 id uuid primary key default gen_random_uuid(),mission_id uuid not null references public.missions(id),urgent boolean not null,
 reason text not null check(reason in('scheduled','money','blocker','expiring_offer','recommendation_changed')),
 week_start date not null,scheduled_for timestamptz not null,created_at timestamptz not null default clock_timestamp(),unique(mission_id,id)
);
create unique index decision_regular_slot_once on public.decision_moments(mission_id,scheduled_for)where not urgent;
create table public.decision_moment_items(
 id uuid primary key default gen_random_uuid(),mission_id uuid not null,moment_id uuid not null,decision_id uuid not null,created_at timestamptz not null default clock_timestamp(),
 unique(moment_id,decision_id),foreign key(mission_id,moment_id)references public.decision_moments(mission_id,id),foreign key(mission_id,decision_id)references public.decisions(mission_id,id)
);
do $$declare t text;begin foreach t in array array['decision_moments','decision_moment_items']loop
 execute format('alter table public.%I enable row level security',t);execute format('alter table public.%I force row level security',t);
 execute format('create policy mission_scope on public.%I using(private.owns_mission(mission_id))with check(private.owns_mission(mission_id))',t);
 execute format('create trigger immutable_row before update or delete on public.%I for each row execute function private.immutable_row()',t);
 execute format('create trigger ledger_revision after insert on public.%I for each row execute function private.record_ledger_revision()',t);
 execute format('create trigger broadcast_ledger after insert on public.%I for each row execute function private.broadcast_ledger()',t);
 execute format('grant select on public.%I to founder_role,lead_role,specialist_role,policy_role',t);
end loop;end$$;
alter table public.notification_suppressions drop constraint notification_suppressions_reason_check;
alter table public.notification_suppressions add check(reason in('decision_resolved_or_stale','payment_recovered','batched_into_moment'));
-- Decision source notifications now originate from a released durable moment,
-- never directly from every proposal. Other urgent/routine source triggers stay.
drop trigger notification_source on public.decisions;

create function private.decision_default_allowed(d public.decisions,p_ignore_due boolean default false)returns boolean language sql stable set search_path=''as $$
select d.supersedes_id is null and d.kind in('selection','constraint')
 and d.gate in('colour_variant','color_variant','visual_preference','layout_preference','research_preference','planning_preference')
 and d.packet->'defaultIfNoAnswer'->'binding'='false'::jsonb
 and d.packet->'defaultIfNoAnswer'->>'optionId'=d.packet->'recommendation'->>'optionId'
 and(p_ignore_due or private.readiness_date(d.packet->'defaultIfNoAnswer'->>'at')<=clock_timestamp())
 and not exists(select from jsonb_array_elements(d.packet->'options')o where o->'cost'is not null and o->'cost'<>'null'::jsonb)
 and not exists(select from public.artifact_versions v where v.mission_id=d.mission_id and v.id=any(d.approved_version_refs)
  and(v.content::text~*'"(effectIntent|mandate|missionBrief|closingRecord|founderConfirmation|financialPlan|pricing|conversion)"\s*:'
   or not exists(select from public.artifact_versions current where current.id=v.id and not exists(select from public.artifact_versions newer where newer.artifact_id=v.artifact_id and newer.version_no>v.version_no))
   or exists(select from public.stale_marks s where s.mission_id=d.mission_id and s.node_id=v.id)))
 and coalesce((select r.response<>'question'from public.decision_resolutions r where r.decision_id=d.id order by r.created_at desc,r.id desc limit 1),true)
$$;
create function private.decision_urgency(d public.decisions)returns text language plpgsql stable set search_path=''as $$begin
 if exists(select from jsonb_array_elements(d.packet->'options')o where case when jsonb_typeof(o->'cost'->'amountMinor')='number'then(o->'cost'->>'amountMinor')::numeric>0 else false end)
  or exists(select from public.artifact_versions v where v.mission_id=d.mission_id and v.id=any(d.approved_version_refs)and(v.content->'effectIntent'->>'effectClass'='spend'or v.content?'financialPlan'or v.content->'mandate'->'scope'->'effectClasses'?'spend'))then return'money';end if;
 if exists(select from public.blockers b join public.readiness(d.mission_id)r on r.outcome=b.blocking_outcome where b.mission_id=d.mission_id and r.level<b.required_level and(b.node_id=d.id or b.node_id=any(d.approved_version_refs)))then return'blocker';end if;
 if exists(select from public.evidence e where e.mission_id=d.mission_id and e.id=any(d.evidence_refs)and private.readiness_date(e.payload->>'validUntil')>clock_timestamp()and private.readiness_date(e.payload->>'validUntil')<=clock_timestamp()+interval'48 hours')then return'expiring_offer';end if;
 if d.supersedes_id is not null and exists(select from public.decisions previous where previous.mission_id=d.mission_id and previous.id=d.supersedes_id and previous.packet->'recommendation'is distinct from d.packet->'recommendation')
  and exists(select from public.evidence e join public.messages m on m.mission_id=e.mission_id and(m.id::text=e.source_reference or m.id::text=e.payload->>'messageId')where e.mission_id=d.mission_id and e.id=any(d.evidence_refs)and m.direction='inbound')then return'recommendation_changed';end if;
 return null;
end$$;
create function private.final_decision_response_guard()returns trigger language plpgsql security definer set search_path=''as $$declare d public.decisions;begin
 if exists(select from public.decision_resolutions r where r.decision_id=new.decision_id and r.response in('approve','choose','reject'))then raise exception 'conflict: decision already has a final response';end if;
 if new.resolution_source='system_default'then
  select *into strict d from public.decisions where mission_id=new.mission_id and id=new.decision_id;
  if private.caller_role()<>'lead_role'or not coalesce(private.decision_default_allowed(d),false)or new.response<>'choose'or new.option_id is distinct from d.packet->'defaultIfNoAnswer'->>'optionId'then raise exception 'invariant_violation: automatic binding approval denied';end if;
 end if;return new;
end$$;
create trigger final_decision_response_guard before insert on public.decision_resolutions for each row execute function private.final_decision_response_guard();
create function public.configure_decision_timing(p_mission uuid,p_per_week integer)returns void language plpgsql security definer set search_path=''as $$begin
 perform private.require_role(array['founder_role']);perform private.lock_mission(p_mission);if p_per_week is null or p_per_week not between 1 and 7 then raise exception 'validation: decision moments must be between1and7perweek';end if;
 insert into public.founder_preferences(mission_id,kind,value,actor_id)values(p_mission,'decision_timing',jsonb_build_object('momentsPerWeek',p_per_week),private.actor_id());
end$$;
create function public.apply_safe_defaults(p_mission uuid,p_moment uuid default null)returns jsonb language plpgsql security definer set search_path=''as $$declare d public.decisions;resolved uuid[]:='{}';remaining uuid[];begin
 perform private.require_role(array['founder_role']);perform private.lock_mission(p_mission);
 if p_moment is not null and not exists(select from public.decision_moments where mission_id=p_mission and id=p_moment)then raise exception 'validation: scoped decision moment required';end if;
 for d in select proposal.*from public.decisions proposal where proposal.mission_id=p_mission and private.decision_default_allowed(proposal,true)
  and(p_moment is null or exists(select from public.decision_moment_items item where item.mission_id=p_mission and item.moment_id=p_moment and item.decision_id=proposal.id))
  and not exists(select from public.decision_resolutions r where r.decision_id=proposal.id and r.response in('approve','choose','reject'))and not exists(select from public.stale_marks s where s.mission_id=p_mission and s.node_id=proposal.id)and not exists(select from public.decision_supersessions s where s.previous_id=proposal.id)loop
  insert into public.decision_resolutions(mission_id,decision_id,response,option_id,actor_id,resolution_source)values(p_mission,d.id,'choose',d.packet->'defaultIfNoAnswer'->>'optionId',private.actor_id(),'founder');resolved:=array_append(resolved,d.id);
  insert into public.activity(mission_id,label,summary,refs,actor_id)values(p_mission,'corrected','Founder explicitly applied the recorded non-binding default; no artifact, payment or external authority was approved.',array[d.id],private.actor_id());
  insert into public.outbox(mission_id,type,payload)values(p_mission,'decision.defaults_applied',jsonb_build_object('decisionId',d.id,'resolutionSource','founder'));
 end loop;
 select coalesce(array_agg(proposal.id),'{}')into remaining from public.decisions proposal where proposal.mission_id=p_mission and not exists(select from public.decision_resolutions r where r.decision_id=proposal.id and r.response in('approve','choose','reject'))and not exists(select from public.stale_marks s where s.mission_id=p_mission and s.node_id=proposal.id)and not exists(select from public.decision_supersessions s where s.previous_id=proposal.id);
 return jsonb_build_object('resolvedDecisionIds',resolved,'remainingDecisionIds',remaining);
end$$;
create function private.create_decision_moment(p_mission uuid,p_ids uuid[],p_urgent boolean,p_reason text,p_week date,p_slot timestamptz)returns uuid language plpgsql set search_path=''as $$
declare moment uuid;did uuid;class text;begin
 if cardinality(p_ids)=0 then return null;end if;
 insert into public.decision_moments(mission_id,urgent,reason,week_start,scheduled_for)values(p_mission,p_urgent,p_reason,p_week,p_slot)returning id into moment;
 foreach did in array p_ids loop
  insert into public.decision_moment_items(mission_id,moment_id,decision_id)values(p_mission,moment,did);
  insert into public.notification_suppressions(mission_id,source_id,reason)select p_mission,s.id,'batched_into_moment'from public.notification_sources s where s.mission_id=p_mission and s.source_table='decisions'and s.source_id=did and s.source_key not like'moment:%'and not exists(select from public.notification_releases r where r.source_id=s.id)on conflict(source_id)do nothing;
  class:=case when p_reason='recommendation_changed'then'recommendation_changed'else'decision'end;
  perform private.notification_source(p_mission,'decisions',did,class,'moment:'||moment||':decision:'||did,clock_timestamp());
 end loop;return moment;
end$$;
create function private.reconcile_decision_timing_at(p_mission uuid,p_observed timestamptz)returns jsonb language plpgsql security definer set search_path=''as $$
declare d public.decisions;defaults uuid[]:='{}';moments uuid[]:='{}';moment uuid;ids uuid[];reason text;zone text;week date;per_week integer;offsets integer[];slot timestamptz;observed timestamptz:=p_observed;status text;begin
 perform private.require_role(array['lead_role']);perform private.lock_mission(p_mission);
 select coalesce((select t.status from public.mission_transitions t where t.mission_id=p_mission order by created_at desc,id desc limit 1),'active')into status;
 if status='ended'then return jsonb_build_object('autoDefaulted',defaults,'momentIds',moments);end if;
 if status='active'then
  for d in select proposal.*from public.decisions proposal where proposal.mission_id=p_mission and private.decision_default_allowed(proposal)
   and not exists(select from public.decision_resolutions r where r.decision_id=proposal.id and r.response in('approve','choose','reject'))and not exists(select from public.stale_marks s where s.mission_id=p_mission and s.node_id=proposal.id)and not exists(select from public.decision_supersessions s where s.previous_id=proposal.id)loop
   insert into public.decision_resolutions(mission_id,decision_id,response,option_id,actor_id,resolution_source)values(p_mission,d.id,'choose',d.packet->'defaultIfNoAnswer'->>'optionId',private.actor_id(),'system_default');
   insert into public.activity(mission_id,label,summary,refs,actor_id)values(p_mission,'corrected','System applied the recorded non-binding default after its stated date; no artifact, payment or external authority was approved.',array[d.id],private.actor_id());
   insert into public.outbox(mission_id,type,payload)values(p_mission,'decision.defaulted',jsonb_build_object('decisionId',d.id,'resolutionSource','system_default'));defaults:=array_append(defaults,d.id);
  end loop;
 end if;
 select coalesce(metadata->>'timeZone','UTC')into zone from public.effective_missions where id=p_mission;week:=date_trunc('week',observed at time zone zone)::date;
 select coalesce((select(value->>'momentsPerWeek')::integer from public.founder_preferences where mission_id=p_mission and kind='decision_timing'order by created_at desc,id desc limit 1),3)into per_week;
 if per_week not between 1 and 7 then raise exception 'validation: invalid decision timing preference';end if;
 foreach reason in array array['money','blocker','expiring_offer','recommendation_changed']loop
  select coalesce(array_agg(proposal.id order by proposal.created_at,proposal.id),'{}')into ids from public.decisions proposal where proposal.mission_id=p_mission and private.decision_urgency(proposal)=reason
   and not exists(select from public.decision_resolutions r where r.decision_id=proposal.id and r.response in('approve','choose','reject'))and not exists(select from public.stale_marks s where s.mission_id=p_mission and s.node_id=proposal.id)and not exists(select from public.decision_supersessions s where s.previous_id=proposal.id)
   and not exists(select from public.decision_moment_items item join public.decision_moments m on m.id=item.moment_id where item.mission_id=p_mission and item.decision_id=proposal.id and m.urgent);
  moment:=private.create_decision_moment(p_mission,ids,true,reason,week,observed);if moment is not null then moments:=array_append(moments,moment);end if;
 end loop;
 offsets:=case per_week when 1 then array[0]when 2 then array[0,3]when 3 then array[0,2,4]when 4 then array[0,1,3,4]when 5 then array[0,1,2,3,4]when 6 then array[0,1,2,3,4,5]else array[0,1,2,3,4,5,6]end;
 select max(((week+day)+time'09:00')at time zone zone)into slot from unnest(offsets)day where((week+day)+time'09:00')at time zone zone<=observed;
 if slot is not null and not exists(select from public.decision_moments m where m.mission_id=p_mission and not m.urgent and m.scheduled_for=slot)
  and(select count(*)from public.decision_moments m where m.mission_id=p_mission and not m.urgent and m.week_start=week)<per_week then
  select coalesce(array_agg(proposal.id order by proposal.created_at,proposal.id),'{}')into ids from public.decisions proposal where proposal.mission_id=p_mission and proposal.created_at<=slot and private.decision_urgency(proposal)is null
   and coalesce((select r.created_at from public.decision_resolutions r where r.decision_id=proposal.id and r.response in('defer','question')order by r.created_at desc,r.id desc limit 1),proposal.created_at)<=slot
   and not exists(select from public.decision_resolutions r where r.decision_id=proposal.id and r.response in('approve','choose','reject'))and not exists(select from public.stale_marks s where s.mission_id=p_mission and s.node_id=proposal.id)and not exists(select from public.decision_supersessions s where s.previous_id=proposal.id)
   and not exists(select from public.decision_moment_items item where item.mission_id=p_mission and item.decision_id=proposal.id);
  moment:=private.create_decision_moment(p_mission,ids,false,'scheduled',week,slot);if moment is not null then moments:=array_append(moments,moment);end if;
 end if;
 return jsonb_build_object('autoDefaulted',defaults,'momentIds',moments);
end$$;
-- Only the owner can call the clock-parameterized core. Application callers have
-- no clock override and cannot release an automatic decision before its date.
create function public.reconcile_decision_timing(p_mission uuid)returns jsonb language plpgsql security definer set search_path=''as $$begin return private.reconcile_decision_timing_at(p_mission,clock_timestamp());end$$;
create function public.release_decision_notifications(p_mission uuid,p_sources uuid[],p_kind text,p_title text,p_why text,p_target jsonb,p_delivery text,p_locale text)returns uuid language plpgsql security definer set search_path=''as $$
declare id uuid;n integer;moment_count integer;begin
 perform private.require_role(array['lead_role']);perform private.lock_mission(p_mission);perform private.assert_safe_content(jsonb_build_object('title',p_title,'why',p_why,'target',p_target));
 if p_sources is null or cardinality(p_sources)not between 1 and 500 or p_kind not in('decision','reply')or p_locale not in('en','ar')or length(p_title)not between 1 and 500 or length(p_why)not between 1 and 12000 or p_target->>'kind'<>'decision'then raise exception 'validation: decision moment notification content required';end if;
 select count(*),count(distinct item.moment_id)into n,moment_count from public.notification_sources source join public.decision_moment_items item on item.mission_id=source.mission_id and item.decision_id=source.source_id and source.source_key='moment:'||item.moment_id||':decision:'||item.decision_id
 where source.mission_id=p_mission and source.id=any(p_sources)and source.source_table='decisions'
 and not exists(select from public.notification_releases r where r.source_id=source.id)and not exists(select from public.notification_suppressions s where s.source_id=source.id)
 and(select schedule.due_at<=clock_timestamp()and schedule.delivery=p_delivery from public.notification_schedules schedule where schedule.source_id=source.id order by schedule.created_at desc,schedule.id desc limit 1);
 if n<>cardinality(p_sources)or moment_count<>1 or not exists(select from public.notification_sources s where s.id=any(p_sources)and s.source_id::text=p_target->>'decisionId')then raise exception 'conflict: decision moment source missing resolved or not due';end if;
 insert into public.notification_events(mission_id,kind,title,why,target,delivery,locale)values(p_mission,p_kind,p_title,p_why,p_target,p_delivery,p_locale)returning notification_events.id into id;
 insert into public.notification_releases(mission_id,source_id,notification_id)select p_mission,source_id,id from unnest(p_sources)source_id;return id;
end$$;
revoke all on function private.decision_default_allowed(public.decisions,boolean),private.decision_urgency(public.decisions),private.final_decision_response_guard(),private.create_decision_moment(uuid,uuid[],boolean,text,date,timestamptz),private.reconcile_decision_timing_at(uuid,timestamptz)from public;
revoke all on function public.configure_decision_timing(uuid,integer),public.apply_safe_defaults(uuid,uuid),public.reconcile_decision_timing(uuid),public.release_decision_notifications(uuid,uuid[],text,text,text,jsonb,text,text)from public;
grant execute on function public.configure_decision_timing(uuid,integer),public.apply_safe_defaults(uuid,uuid)to founder_role;
grant execute on function public.reconcile_decision_timing(uuid),public.release_decision_notifications(uuid,uuid[],text,text,text,jsonb,text,text)to lead_role;
commit;
