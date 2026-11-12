begin;
create table public.founder_presence(
 id uuid primary key default gen_random_uuid(),mission_id uuid not null references public.missions(id),actor_id uuid not null,
 window_id bigint not null,active_seconds integer not null check(active_seconds between 0 and 30),created_at timestamptz not null default clock_timestamp(),
 unique(mission_id,actor_id,window_id)
);
alter table public.founder_presence enable row level security;
alter table public.founder_presence force row level security;
create policy mission_scope on public.founder_presence using(private.owns_mission(mission_id))with check(private.owns_mission(mission_id));
create trigger immutable_row before update or delete on public.founder_presence for each row execute function private.immutable_row();
grant select on public.founder_presence to founder_role,lead_role;
create table public.founder_presence_signals(id uuid primary key default gen_random_uuid(),mission_id uuid not null references public.missions(id),actor_id uuid not null,active boolean not null,created_at timestamptz not null default clock_timestamp());
alter table public.founder_presence_signals enable row level security;alter table public.founder_presence_signals force row level security;
create policy mission_scope on public.founder_presence_signals using(private.owns_mission(mission_id));
create trigger immutable_row before update or delete on public.founder_presence_signals for each row execute function private.immutable_row();
grant select on public.founder_presence_signals to founder_role,lead_role;
create function public.record_founder_presence(p_mission uuid,p_active boolean)returns void language plpgsql security definer set search_path=''as $$
declare observed timestamptz:=clock_timestamp();previous timestamptz;previous_active boolean;seconds integer;begin
 perform private.require_role(array['founder_role']);perform private.lock_mission(p_mission);
 select created_at,active into previous,previous_active from public.founder_presence_signals where mission_id=p_mission and actor_id=private.actor_id()order by created_at desc,id desc limit 1;
 seconds:=case when p_active is true and previous_active is true and previous>observed-interval '90 seconds'then least(30,greatest(0,floor(extract(epoch from(observed-previous)))::integer))else 0 end;
 if p_active is null then raise exception 'validation: active state required';end if;
 insert into public.founder_presence_signals(mission_id,actor_id,active,created_at)values(p_mission,private.actor_id(),p_active,observed);
 insert into public.founder_presence(mission_id,actor_id,window_id,active_seconds,created_at)values(p_mission,private.actor_id(),floor(extract(epoch from observed)/30)::bigint,seconds,observed)on conflict(mission_id,actor_id,window_id)do nothing;
end$$;
create function public.mission_engagement(p_mission uuid)returns jsonb language plpgsql security definer set search_path=''as $$
declare absence numeric;begin
 perform private.require_role(array['founder_role','lead_role']);perform private.assert_mission(p_mission);
 select case when jsonb_typeof(metadata->'absenceHours')='number'then greatest(1,least(168,(metadata->>'absenceHours')::numeric))else 48 end into absence from public.effective_missions where id=p_mission;
 return(select jsonb_build_object('activeSeconds',coalesce(sum(active_seconds),0),'lastSeenAt',(select max(created_at)from public.founder_presence_signals where mission_id=p_mission),'absenceHours',absence,'basis','focused visible interaction heartbeats; gaps over 90 seconds excluded')from public.founder_presence where mission_id=p_mission);
end$$;
revoke all on function public.record_founder_presence(uuid,boolean),public.mission_engagement(uuid)from public;
grant execute on function public.record_founder_presence(uuid,boolean)to founder_role;
grant execute on function public.mission_engagement(uuid)to founder_role,lead_role;
commit;
