begin;
create table public.mission_creation_requests(
  id uuid primary key default gen_random_uuid(),founder_id uuid not null references public.founders(id),
  idempotency_key text not null,mission_id uuid not null references public.missions(id),created_at timestamptz not null default now(),unique(founder_id,idempotency_key)
);
alter table public.mission_creation_requests enable row level security;
alter table public.mission_creation_requests force row level security;
create policy tenant_scope on public.mission_creation_requests using(private.owns_founder(founder_id)) with check(private.owns_founder(founder_id));
grant select on public.mission_creation_requests to founder_role;
create trigger immutable_row before update or delete on public.mission_creation_requests for each row execute function private.immutable_row();
create function public.start_mission(p_key text,p_sandbox boolean) returns uuid language plpgsql security definer set search_path='' as $$
declare founder uuid;mission uuid;begin
  perform private.require_role(array['founder_role']);
  if length(p_key)<16 or length(p_key)>256 then raise exception 'validation: idempotency key required';end if;
  perform pg_advisory_xact_lock(hashtextextended(private.actor_id()::text,1));
  select id into founder from public.founders where auth_user_id=private.actor_id();
  if founder is null then insert into public.founders(auth_user_id) values(private.actor_id()) returning id into founder;end if;
  select mission_id into mission from public.mission_creation_requests where founder_id=founder and idempotency_key=p_key;
  if mission is not null then return mission;end if;
  mission:=public.create_mission(founder,'discover','Find a viable business direction','SAR',p_sandbox,jsonb_build_object('title','Untitled','intakeStatus','awaiting_founder','timeZone','Asia/Riyadh','language','en'));
  insert into public.threads(mission_id) values(mission);
  insert into public.mission_creation_requests(founder_id,idempotency_key,mission_id) values(founder,p_key,mission);
  insert into public.outbox(mission_id,type,payload) values(mission,'mission.created',jsonb_build_object('authUserId',private.actor_id()));
  return mission;
end$$;
revoke all on function public.start_mission(text,boolean) from public;
grant execute on function public.start_mission(text,boolean) to founder_role;
create table public.mission_deletion_requests(
  id uuid primary key default gen_random_uuid(),mission_id uuid not null references public.missions(id),actor_id uuid not null,
  retained_assets jsonb not null,requested_at timestamptz not null default now(),unique(mission_id)
);
alter table public.mission_deletion_requests enable row level security;
alter table public.mission_deletion_requests force row level security;
create policy tenant_scope on public.mission_deletion_requests using(private.owns_mission(mission_id)) with check(private.owns_mission(mission_id));
grant select on public.mission_deletion_requests to founder_role;
create function public.request_mission_deletion(p_mission uuid) returns uuid language plpgsql security definer set search_path='' as $$
declare request uuid;assets jsonb;begin
  perform private.require_role(array['founder_role']);perform private.lock_mission(p_mission);
  select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'provider',a.provider,'status',a.status)),'[]') into assets from public.founder_accounts a join public.missions m on m.founder_id=a.founder_id where m.id=p_mission;
  insert into public.mission_deletion_requests(mission_id,actor_id,retained_assets) values(p_mission,private.actor_id(),assets) on conflict(mission_id) do nothing returning id into request;
  if request is null then select id into request from public.mission_deletion_requests where mission_id=p_mission;end if;
  if not exists(select from public.mission_transitions where mission_id=p_mission and status='ended') then perform public.transition_mission(p_mission,'paused');end if;
  return request;
end$$;
revoke all on function public.request_mission_deletion(uuid) from public;
grant execute on function public.request_mission_deletion(uuid) to founder_role;
commit;
