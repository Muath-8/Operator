begin;
-- Sources contain identifiers only. Content is read from the scoped authoritative
-- ledgers at release time. An in-app release is not an email/SMS/provider receipt.
alter table public.notification_events add constraint notification_events_mission_id_id_key unique(mission_id,id);
create table public.notification_sources(
 id uuid primary key default gen_random_uuid(),mission_id uuid not null references public.missions(id),
 source_table text not null check(source_table in('decisions','payment_states','effect_states','run_results','activity','effect_authorizations','money_ledger')),
 source_id uuid not null,class text not null check(class in('decision','mandate','payment_executed','payment_failure','blocking_failure','recommendation_changed','routine')),
 source_key text not null,created_at timestamptz not null default clock_timestamp(),unique(mission_id,id),unique(mission_id,source_key)
);
create table public.notification_schedules(
 id uuid primary key default gen_random_uuid(),mission_id uuid not null,source_id uuid not null,configuration_hash text not null check(configuration_hash~'^[0-9a-f]{64}$'),
 due_at timestamptz not null,delivery text not null check(delivery in('immediate','digest','after_quiet_hours')),created_at timestamptz not null default clock_timestamp(),
 foreign key(mission_id,source_id)references public.notification_sources(mission_id,id)
);
create table public.notification_releases(
 id uuid primary key default gen_random_uuid(),mission_id uuid not null,source_id uuid not null unique,notification_id uuid not null,
 created_at timestamptz not null default clock_timestamp(),foreign key(mission_id,source_id)references public.notification_sources(mission_id,id),
 foreign key(mission_id,notification_id)references public.notification_events(mission_id,id)
);
create table public.notification_suppressions(
 id uuid primary key default gen_random_uuid(),mission_id uuid not null,source_id uuid not null unique,reason text not null check(reason in('decision_resolved_or_stale','payment_recovered')),
 created_at timestamptz not null default clock_timestamp(),foreign key(mission_id,source_id)references public.notification_sources(mission_id,id)
);
do $$declare t text;begin foreach t in array array['notification_sources','notification_schedules','notification_releases','notification_suppressions']loop
 execute format('alter table public.%I enable row level security',t);execute format('alter table public.%I force row level security',t);
 execute format('create policy mission_scope on public.%I using(private.owns_mission(mission_id))with check(private.owns_mission(mission_id))',t);
 execute format('create trigger immutable_row before update or delete on public.%I for each row execute function private.immutable_row()',t);
 execute format('create trigger ledger_revision after insert on public.%I for each row execute function private.record_ledger_revision()',t);
 execute format('create trigger broadcast_ledger after insert on public.%I for each row execute function private.broadcast_ledger()',t);
 execute format('grant select on public.%I to founder_role,lead_role,specialist_role,policy_role',t);
end loop;end$$;
-- Existing notification rows already have a revision trigger from SQL0005.
drop trigger if exists broadcast_ledger on public.notification_events;
create trigger broadcast_ledger after insert on public.notification_events for each row execute function private.broadcast_ledger();
revoke insert on public.notification_events from lead_role;

create function private.notification_source(p_mission uuid,p_table text,p_id uuid,p_class text,p_key text,p_at timestamptz)returns void language sql security definer set search_path=''as $$
 insert into public.notification_sources(mission_id,source_table,source_id,class,source_key,created_at)values(p_mission,p_table,p_id,p_class,p_key,p_at)on conflict(mission_id,source_key)do nothing
$$;
create function private.capture_notification_source()returns trigger language plpgsql security definer set search_path=''as $$
declare class text;mandate public.mandates;used numeric;contacts bigint;near boolean;reached boolean;begin
 if tg_table_name='decisions'then
  class:=case when new.kind='mandate'then 'mandate'else 'decision'end;
  if new.supersedes_id is not null and exists(select from public.decisions previous where previous.mission_id=new.mission_id and previous.id=new.supersedes_id and previous.packet->'recommendation'is distinct from new.packet->'recommendation')
   and exists(select from public.evidence e join public.messages m on m.mission_id=e.mission_id and(m.id::text=e.source_reference or m.id::text=e.payload->>'messageId')where e.mission_id=new.mission_id and e.id=any(new.evidence_refs)and m.direction='inbound')then class:='recommendation_changed';end if;
  perform private.notification_source(new.mission_id,tg_table_name,new.id,class,tg_table_name||':'||new.id,new.created_at);
 elsif tg_table_name='payment_states'then
  if new.state in('captured','failed')then perform private.notification_source(new.mission_id,tg_table_name,new.id,case when new.state='captured'then 'payment_executed'else 'payment_failure'end,tg_table_name||':'||new.id,new.created_at);end if;
 elsif tg_table_name='effect_states'then
  if new.status in('failed','ambiguous')and exists(select from public.effect_authorizations a where a.mission_id=new.mission_id and a.id=new.authorization_id and a.intent->>'effectClass'='spend')then perform private.notification_source(new.mission_id,tg_table_name,new.id,'payment_failure','payment_failure:'||new.authorization_id||':'||new.status,new.created_at);end if;
 elsif tg_table_name='run_results'then
  if new.result->>'status'='failed'or new.result?'error'then perform private.notification_source(new.mission_id,tg_table_name,new.id,'blocking_failure',tg_table_name||':'||new.id,new.created_at);end if;
 elsif tg_table_name='activity'then
  -- fail_effect also writes an audit activity row; one financial failure must
  -- not become a second, quieter generic failure notification.
  if new.label='failed'and exists(select from public.effect_authorizations a where a.mission_id=new.mission_id and a.id=any(new.refs)and a.intent->>'effectClass'='spend')then return new;end if;
  perform private.notification_source(new.mission_id,tg_table_name,new.id,case when new.label in('failed','blocked')then 'blocking_failure'else 'routine'end,tg_table_name||':'||new.id,new.created_at);
 elsif tg_table_name='money_ledger'then
  perform private.notification_source(new.mission_id,tg_table_name,new.id,'routine',tg_table_name||':'||new.id,new.created_at);
 elsif tg_table_name='effect_authorizations'then
  if new.mandate_id is null then return new;end if;
  select *into mandate from public.mandates where id=new.mandate_id and mission_id=new.mission_id;
  select coalesce(sum(a.amount_minor),0),count(*)filter(where a.intent->>'newContact'='true')into used,contacts from public.effect_authorizations a where a.mission_id=new.mission_id and a.mandate_id=mandate.id;
  near:=(mandate.ceiling_total>0 and used*5>=mandate.ceiling_total*4::numeric)or(coalesce((mandate.scope->>'maxNewContacts')::bigint,0)>0 and contacts*5>=(mandate.scope->>'maxNewContacts')::numeric*4);
  reached:=(mandate.ceiling_total>0 and used>=mandate.ceiling_total)or(coalesce((mandate.scope->>'maxNewContacts')::bigint,0)>0 and contacts>=(mandate.scope->>'maxNewContacts')::bigint);
  if near then perform private.notification_source(new.mission_id,tg_table_name,new.id,'mandate','mandate:'||mandate.id||':80',new.created_at);end if;
  if reached then perform private.notification_source(new.mission_id,tg_table_name,new.id,'mandate','mandate:'||mandate.id||':100',new.created_at);end if;
 end if;return new;
end$$;
do $$declare t text;begin foreach t in array array['decisions','payment_states','effect_states','run_results','activity','money_ledger','effect_authorizations']loop execute format('create trigger notification_source after insert on public.%I for each row execute function private.capture_notification_source()',t);end loop;end$$;
-- Preserve actionable pending approvals already present when this migration is
-- applied. Routine historical activity is not retroactively announced as new.
insert into public.notification_sources(mission_id,source_table,source_id,class,source_key,created_at)
select d.mission_id,'decisions',d.id,case when d.kind='mandate'then 'mandate'else 'decision'end,'decisions:'||d.id,d.created_at from public.decisions d
where not exists(select from public.decision_resolutions r where r.decision_id=d.id)and not exists(select from public.stale_marks s where s.mission_id=d.mission_id and s.node_id=d.id)on conflict do nothing;

create function public.lock_notification_reconcile(p_mission uuid)returns void language plpgsql security definer set search_path=''as $$begin perform private.require_role(array['lead_role']);perform private.lock_mission(p_mission);end$$;
create function public.schedule_notification(p_mission uuid,p_source uuid,p_hash text,p_due timestamptz,p_delivery text)returns uuid language plpgsql security definer set search_path=''as $$
declare prior public.notification_schedules;id uuid;begin
 perform private.require_role(array['lead_role']);perform private.lock_mission(p_mission);
 if not exists(select from public.notification_sources where mission_id=p_mission and notification_sources.id=p_source)or p_hash!~'^[0-9a-f]{64}$'or p_due is null or not isfinite(p_due)or p_delivery not in('immediate','digest','after_quiet_hours')then raise exception 'validation: scoped notification schedule required';end if;
 select *into prior from public.notification_schedules s where s.mission_id=p_mission and s.source_id=p_source order by s.created_at desc,s.id desc limit 1;
 if prior.configuration_hash=p_hash and prior.due_at=p_due and prior.delivery=p_delivery then return prior.id;end if;
 insert into public.notification_schedules(mission_id,source_id,configuration_hash,due_at,delivery)values(p_mission,p_source,p_hash,p_due,p_delivery)returning notification_schedules.id into id;return id;
end$$;
create function public.suppress_notification(p_mission uuid,p_source uuid)returns void language plpgsql security definer set search_path=''as $$
declare source public.notification_sources;why text;begin
 perform private.require_role(array['lead_role']);perform private.lock_mission(p_mission);select *into strict source from public.notification_sources where mission_id=p_mission and id=p_source;
 if source.source_table='decisions'and exists(select from public.decisions d where d.mission_id=p_mission and d.id=source.source_id and(exists(select from public.decision_resolutions r where r.decision_id=d.id)or exists(select from public.stale_marks s where s.mission_id=p_mission and s.node_id=d.id)or exists(select from public.decision_supersessions s where s.previous_id=d.id)))then why:='decision_resolved_or_stale';
 elsif source.class='payment_failure'and exists(select from public.payment_states old join lateral(select state from public.payment_states recent where recent.mission_id=old.mission_id and recent.payment_id=old.payment_id order by created_at desc,id desc limit 1)current on true where old.mission_id=p_mission and old.id=source.source_id and current.state<>'failed')then why:='payment_recovered';
 elsif source.source_table='effect_states'and source.class='payment_failure'and exists(select from public.effect_states old join lateral(select status from public.effect_states recent where recent.mission_id=old.mission_id and recent.authorization_id=old.authorization_id order by created_at desc,id desc limit 1)current on true where old.mission_id=p_mission and old.id=source.source_id and current.status not in('failed','ambiguous'))then why:='payment_recovered';
 else raise exception 'validation: notification source is still actionable';end if;
 insert into public.notification_suppressions(mission_id,source_id,reason)values(p_mission,p_source,why)on conflict(source_id)do nothing;
end$$;
create function public.release_notification(p_mission uuid,p_sources uuid[],p_kind text,p_title text,p_why text,p_target jsonb,p_delivery text,p_locale text)returns uuid language plpgsql security definer set search_path=''as $$
declare id uuid;n integer;classes text[];begin
 perform private.require_role(array['lead_role']);perform private.lock_mission(p_mission);
 perform private.assert_safe_content(jsonb_build_object('title',p_title,'why',p_why,'target',p_target));
 if p_sources is null or cardinality(p_sources)not between 1 and 500 or p_kind not in('decision','mandate','payment','failure','reply','digest')or p_locale not in('en','ar')or length(p_title)not between 1 and 500 or length(p_why)not between 1 and 12000 then raise exception 'validation: notification content required';end if;
 select count(*),array_agg(distinct source.class)into n,classes from public.notification_sources source where source.mission_id=p_mission and source.id=any(p_sources)
 and not exists(select from public.notification_releases r where r.source_id=source.id)and not exists(select from public.notification_suppressions s where s.source_id=source.id)
 and(select schedule.due_at<=clock_timestamp()and schedule.delivery=p_delivery from public.notification_schedules schedule where schedule.mission_id=p_mission and schedule.source_id=source.id order by schedule.created_at desc,schedule.id desc limit 1);
 if n<>cardinality(p_sources)then raise exception 'conflict: source missing released suppressed or not yet due';end if;
 if n>1 and(classes<>array['routine']::text[]and classes<>array['mandate']::text[])then raise exception 'validation: only routine digests or matching mandate warnings may batch';end if;
 if classes=array['routine']::text[]and(p_kind<>'digest'or p_delivery<>'digest')then raise exception 'validation: routine events require digest';end if;
 if classes&&array['mandate','payment_failure']and p_delivery<>'immediate'then raise exception 'validation: urgent notification must be immediate';end if;
 insert into public.notification_events(mission_id,kind,title,why,target,delivery,locale)values(p_mission,p_kind,p_title,p_why,p_target,p_delivery,p_locale)returning notification_events.id into id;
 insert into public.notification_releases(mission_id,source_id,notification_id)select p_mission,source_id,id from unnest(p_sources)source_id;return id;
end$$;
revoke all on function private.notification_source(uuid,text,uuid,text,text,timestamptz),private.capture_notification_source()from public;
revoke all on function public.lock_notification_reconcile(uuid),public.schedule_notification(uuid,uuid,text,timestamptz,text),public.suppress_notification(uuid,uuid),public.release_notification(uuid,uuid[],text,text,text,jsonb,text,text)from public;
grant execute on function public.lock_notification_reconcile(uuid),public.schedule_notification(uuid,uuid,text,timestamptz,text),public.suppress_notification(uuid,uuid),public.release_notification(uuid,uuid[],text,text,text,jsonb,text,text)to lead_role;
commit;
