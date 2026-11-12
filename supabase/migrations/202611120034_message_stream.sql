begin;
-- Ephemeral transport cache, not an evidence or business ledger. The committed
-- messages table remains the sole conversation record. No broadcast/outbox loop.
create table public.agent_message_streams(
 mission_id uuid not null,run_id uuid not null,attempt_key text not null,
 sequence integer not null check(sequence>=0),text text not null check(length(text)<=24000),
 updated_at timestamptz not null default clock_timestamp(),expires_at timestamptz not null,
 primary key(mission_id,run_id),foreign key(mission_id,run_id)references public.runs(mission_id,id)
);
alter table public.agent_message_streams enable row level security;
alter table public.agent_message_streams force row level security;
create policy mission_scope on public.agent_message_streams using(private.owns_mission(mission_id));
grant select on public.agent_message_streams to founder_role,lead_role;
create function public.publish_agent_message_stream(p_mission uuid,p_run uuid,p_attempt text,p_sequence integer,p_text text)returns void language plpgsql security definer set search_path=''as $$begin
 perform private.require_role(array['lead_role']);perform private.assert_mission(p_mission);
 if not exists(select from public.runs where mission_id=p_mission and id=p_run and role='lead')or p_sequence<0 or length(p_attempt)not between 1 and 256 or length(p_text)>24000 then raise exception 'validation: invalid draft stream';end if;
 perform private.assert_safe_content(jsonb_build_object('text',p_text));
 if exists(select from public.run_results where mission_id=p_mission and run_id=p_run)then return;end if;
 insert into public.agent_message_streams(mission_id,run_id,attempt_key,sequence,text,expires_at)values(p_mission,p_run,p_attempt,p_sequence,p_text,clock_timestamp()+interval'5 minutes')
 on conflict(mission_id,run_id)do update set attempt_key=excluded.attempt_key,sequence=excluded.sequence,text=excluded.text,updated_at=clock_timestamp(),expires_at=excluded.expires_at
 where(agent_message_streams.attempt_key=excluded.attempt_key and excluded.sequence>agent_message_streams.sequence)or(excluded.sequence=0 and agent_message_streams.attempt_key<>excluded.attempt_key);
end$$;
create function public.clear_agent_message_stream(p_mission uuid,p_run uuid)returns void language plpgsql security definer set search_path=''as $$begin
 perform private.require_role(array['lead_role']);perform private.assert_mission(p_mission);delete from public.agent_message_streams where mission_id=p_mission and run_id=p_run;
end$$;
revoke all on function public.publish_agent_message_stream(uuid,uuid,text,integer,text),public.clear_agent_message_stream(uuid,uuid)from public;
grant execute on function public.publish_agent_message_stream(uuid,uuid,text,integer,text),public.clear_agent_message_stream(uuid,uuid)to lead_role;

create table public.run_progress(id uuid primary key default gen_random_uuid(),mission_id uuid not null,run_id uuid not null,step_key text not null,phase text not null check(phase in('started','finished','failed')),label text not null,created_at timestamptz not null default clock_timestamp(),unique(run_id,step_key,phase),foreign key(mission_id,run_id)references public.runs(mission_id,id));
alter table public.run_progress enable row level security;
alter table public.run_progress force row level security;
create policy mission_scope on public.run_progress using(private.owns_mission(mission_id));
create trigger immutable_row before update or delete on public.run_progress for each row execute function private.immutable_row();
create trigger ledger_revision after insert on public.run_progress for each row execute function private.record_ledger_revision();
create trigger broadcast_ledger after insert on public.run_progress for each row execute function private.broadcast_ledger();
grant select on public.run_progress to founder_role,lead_role,specialist_role;
create function public.record_run_progress(p_mission uuid,p_run uuid,p_step text,p_phase text,p_label text)returns void language plpgsql security definer set search_path=''as $$begin
 perform private.require_role(array['lead_role','specialist_role']);perform private.assert_mission(p_mission);
 if not exists(select from public.runs where mission_id=p_mission and id=p_run and(case when role='lead'then current_setting('role',true)='lead_role'else current_setting('role',true)='specialist_role'end))or length(p_step)not between 1 and 200 or length(p_label)not between 1 and 200 then raise exception 'validation: scoped run progress required';end if;
 insert into public.run_progress(mission_id,run_id,step_key,phase,label)values(p_mission,p_run,p_step,p_phase,p_label)on conflict(run_id,step_key,phase)do nothing;
end$$;
revoke all on function public.record_run_progress(uuid,uuid,text,text,text)from public;
grant execute on function public.record_run_progress(uuid,uuid,text,text,text)to lead_role,specialist_role;
commit;
