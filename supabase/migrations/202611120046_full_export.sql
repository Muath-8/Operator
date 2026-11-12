begin;
-- Whole-mission portable export is a separate capability from the concise
-- business Launch Record. It never opens the private schema or credentials.
create function public.mission_export_tables(p_mission uuid)returns text[]language plpgsql stable security definer set search_path=''as $$declare names text[];begin
 perform private.require_role(array['founder_role']);perform private.assert_mission(p_mission);
 select array_agg(c.relname::text order by c.relname)into names from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace join pg_catalog.pg_attribute a on a.attrelid=c.oid and a.attname='mission_id'and not a.attisdropped
 where n.nspname='public'and c.relkind in('r','p');return coalesce(names,'{}');
end$$;
create function public.mission_export_rows(p_mission uuid,p_table text)returns setof jsonb language plpgsql stable security definer set search_path=''as $$begin
 perform private.require_role(array['founder_role']);perform private.assert_mission(p_mission);
 if not(p_table=any(public.mission_export_tables(p_mission)))then raise exception 'validation: export table outside scoped business ledger';end if;
 return query execute format('select to_jsonb(t)-array[''token_hash'',''secret_ref'',''encrypted_email'']from public.%I t where mission_id=$1',p_table)using p_mission;
end$$;
create function public.mission_export_files(p_mission uuid)returns setof jsonb language plpgsql stable security definer set search_path=''as $$begin
 perform private.require_role(array['founder_role']);perform private.assert_mission(p_mission);
 if pg_catalog.to_regclass('storage.objects')is null then return;end if;
 return query execute 'select jsonb_build_object(''id'',o.id,''name'',o.name,''metadata'',to_jsonb(o)->''metadata'',''version'',to_jsonb(o)->''version'')from storage.objects o where bucket_id=''mission-files''and split_part(name,''/'',1)=$1 order by name'using p_mission::text;
end$$;
revoke all on function public.mission_export_tables(uuid),public.mission_export_rows(uuid,text),public.mission_export_files(uuid)from public;
grant execute on function public.mission_export_tables(uuid),public.mission_export_rows(uuid,text),public.mission_export_files(uuid)to founder_role;
commit;
