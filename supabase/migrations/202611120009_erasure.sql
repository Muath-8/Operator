begin;
create table private.erasure_context(transaction_id bigint not null,backend_pid integer not null,mission_id uuid not null,primary key(transaction_id,backend_pid,mission_id));
revoke all on private.erasure_context from public,founder_role,lead_role,specialist_role,policy_role,ingress_role,voice_role;
create table public.erasure_receipts(id uuid primary key default gen_random_uuid(),founder_id uuid not null references public.founders(id),mission_fingerprint text not null,erased_at timestamptz not null default clock_timestamp());
alter table public.erasure_receipts enable row level security;alter table public.erasure_receipts force row level security;
create policy tenant_scope on public.erasure_receipts using(private.owns_founder(founder_id));
grant select on public.erasure_receipts to founder_role;
create or replace function private.immutable_row() returns trigger language plpgsql security definer set search_path='' as $$
declare mission uuid;begin
  mission:=coalesce((to_jsonb(old)->>'mission_id')::uuid,case when tg_table_name='missions' then (to_jsonb(old)->>'id')::uuid end);
  if tg_op='DELETE' and mission is not null and exists(select from private.erasure_context where transaction_id=txid_current() and backend_pid=pg_backend_pid() and mission_id=mission) then return old;end if;
  raise exception 'invariant_violation: append-only ledger' using errcode='42501';
end$$;
revoke all on function private.immutable_row() from public;
create function public.erase_mission(p_mission uuid,p_request uuid) returns uuid language plpgsql security definer set search_path='' as $$
declare pending text[];remaining text[];target text;progress boolean;receipt uuid;founder uuid;begin
  perform private.require_role(array['founder_role']);perform private.lock_mission(p_mission);
  if not exists(select from public.mission_deletion_requests where id=p_request and mission_id=p_mission and actor_id=private.actor_id()) then raise exception 'needs_approval: confirmed deletion request required';end if;
  select founder_id into strict founder from public.missions where id=p_mission;
  insert into private.erasure_context values(txid_current(),pg_backend_pid(),p_mission);
  select array_agg(format('%I.%I',c.table_schema,c.table_name)) into pending from information_schema.columns c join pg_tables t on t.schemaname=c.table_schema and t.tablename=c.table_name where c.column_name='mission_id' and c.table_schema in('public','private') and c.table_name<>'erasure_context';
  -- Delete children before parents without weakening FK constraints or disabling
  -- ledger triggers. A future cyclic FK fails closed and rolls the whole erase back.
  while cardinality(pending)>0 loop
    remaining:='{}';progress:=false;
    foreach target in array pending loop
      begin execute 'delete from '||target||' where mission_id=$1' using p_mission;progress:=true;
      exception when foreign_key_violation then remaining:=array_append(remaining,target);end;
    end loop;
    if not progress then raise exception 'invariant_violation: erasure dependency cycle requires migration review';end if;
    pending:=remaining;
  end loop;
  delete from public.missions where id=p_mission;
  delete from private.erasure_context where transaction_id=txid_current() and backend_pid=pg_backend_pid() and mission_id=p_mission;
  insert into public.erasure_receipts(founder_id,mission_fingerprint) values(founder,encode(sha256(convert_to(p_mission::text,'UTF8')),'hex')) returning id into receipt;
  return receipt;
end$$;
revoke all on function public.erase_mission(uuid,uuid) from public;
grant execute on function public.erase_mission(uuid,uuid) to founder_role;
do $$begin
  if to_regclass('storage.objects') is not null then
    execute 'create policy lo_delete_mission_files on storage.objects for delete to founder_role using(bucket_id=''mission-files'' and public.can_join_mission(''mission:''||split_part(name,''/'',1)))';
  end if;
end$$;
commit;
