begin;
alter table public.runs add constraint runs_mission_identity unique(mission_id,id);
create table public.editable_assets(id uuid primary key default gen_random_uuid(),mission_id uuid not null references public.missions(id),source_run_id uuid not null,name text not null,mime_type text not null check(mime_type='image/svg+xml'),content_base64 text not null check(length(content_base64)<=1400000),payload_hash text not null check(payload_hash~'^[0-9a-f]{64}$'),actor_id uuid not null,created_at timestamptz not null default clock_timestamp(),unique(mission_id,source_run_id,payload_hash),foreign key(mission_id,source_run_id)references public.runs(mission_id,id));
alter table public.editable_assets enable row level security;alter table public.editable_assets force row level security;
create policy mission_scope on public.editable_assets using(private.owns_mission(mission_id))with check(private.owns_mission(mission_id)and actor_id=private.actor_id());
create trigger immutable_row before update or delete on public.editable_assets for each row execute function private.immutable_row();
create trigger ledger_revision after insert on public.editable_assets for each row execute function private.record_ledger_revision();
create trigger broadcast_ledger after insert on public.editable_assets for each row execute function private.broadcast_ledger();
grant select on public.editable_assets to founder_role,lead_role,specialist_role,policy_role;
grant insert on public.editable_assets to specialist_role;
-- Internal SECURITY DEFINER helpers are not public RPCs. Preserve only the
-- explicitly granted RLS identity helpers from the initial state migration.
revoke execute on all functions in schema private from public;
alter default privileges revoke execute on functions from public;
commit;
