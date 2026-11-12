begin;
do $$begin if not exists(select from pg_roles where rolname='scheduler_role') then create role scheduler_role nologin noinherit nobypassrls;end if;end$$;
grant usage on schema public to scheduler_role;
create function public.runtime_mission_scopes() returns table(mission_id uuid,auth_user_id uuid) language plpgsql stable security definer set search_path='' as $$begin
  perform private.require_role(array['scheduler_role']);
  return query select m.id,f.auth_user_id from public.missions m join public.founders f on f.id=m.founder_id where not exists(select from public.mission_deletion_requests d where d.mission_id=m.id) and coalesce((select status from public.mission_transitions t where t.mission_id=m.id order by t.created_at desc,t.id desc limit 1),'active')<>'ended';
end$$;
revoke all on function public.runtime_mission_scopes() from public;
grant execute on function public.runtime_mission_scopes() to scheduler_role;
commit;
