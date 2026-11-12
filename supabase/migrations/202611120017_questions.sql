begin;
create table public.mission_questions(
 id uuid primary key default gen_random_uuid(),mission_id uuid not null references public.missions(id),
 question text not null check(length(trim(question))>0),recommended_default text not null check(length(trim(recommended_default))>0),blocking boolean not null,outcome text not null check(outcome in('brand','product','supply','commerce','compliance','demand')),
 created_at timestamptz not null default clock_timestamp(),unique(mission_id,id)
);
create table public.question_answers(
 id uuid primary key default gen_random_uuid(),mission_id uuid not null,question_id uuid not null,answer text not null,
 skipped boolean not null,evidence_id uuid,actor_id uuid not null,created_at timestamptz not null default clock_timestamp(),
 unique(question_id),foreign key(mission_id,question_id)references public.mission_questions(mission_id,id),
 foreign key(mission_id,evidence_id)references public.evidence(mission_id,id)
);
do $$declare t text;begin foreach t in array array['mission_questions','question_answers']loop
 execute format('alter table public.%I enable row level security',t);execute format('alter table public.%I force row level security',t);
 execute format('create policy mission_scope on public.%I using(private.owns_mission(mission_id))with check(private.owns_mission(mission_id))',t);
 execute format('create trigger immutable_row before update or delete on public.%I for each row execute function private.immutable_row()',t);
 execute format('create trigger ledger_revision after insert on public.%I for each row execute function private.record_ledger_revision()',t);
 execute format('create trigger broadcast_ledger after insert on public.%I for each row execute function private.broadcast_ledger()',t);
 execute format('grant select on public.%I to founder_role,lead_role,specialist_role,policy_role',t);
end loop;end$$;
grant insert on public.mission_questions to lead_role;
create function public.answer_mission_question(p_mission uuid,p_question uuid,p_answer text,p_skipped boolean)returns uuid language plpgsql security definer set search_path=''as $$
declare q public.mission_questions;e uuid;a uuid;effective_answer text;begin
 perform private.require_role(array['founder_role','authenticated']);perform private.lock_mission(p_mission);
 select *into strict q from public.mission_questions where mission_id=p_mission and id=p_question;
 if exists(select from public.question_answers where question_id=p_question)then raise exception 'conflict: question already answered';end if;
 if p_skipped is null or length(p_answer)>12000 or(not p_skipped and length(trim(p_answer))=0)then raise exception 'validation: answer or explicit skip required';end if;
 effective_answer:=case when p_skipped then q.recommended_default else p_answer end;
 e:=public.append_evidence(p_mission,q.outcome,'founder_input','founder_confirmed',jsonb_build_object('questionId',q.id,'question',q.question,'answer',effective_answer,'appliedDefault',p_skipped),'document','founder-answer:'||q.id::text);
 insert into public.question_answers(mission_id,question_id,answer,skipped,evidence_id,actor_id)values(p_mission,p_question,effective_answer,p_skipped,e,private.actor_id())returning id into a;
 insert into public.outbox(mission_id,type,payload)values(p_mission,'founder.answered',jsonb_build_object('questionId',q.id,'answerId',a,'skipped',p_skipped));return a;
end$$;
revoke all on function public.answer_mission_question(uuid,uuid,text,boolean)from public;
grant execute on function public.answer_mission_question(uuid,uuid,text,boolean)to founder_role;
commit;
