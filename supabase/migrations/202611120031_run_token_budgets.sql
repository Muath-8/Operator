begin;
create table public.model_token_reservations(id uuid primary key default gen_random_uuid(),mission_id uuid not null references public.missions(id),run_id uuid not null references public.runs(id),call_key text not null,maximum_tokens bigint not null check(maximum_tokens>0),created_at timestamptz not null default clock_timestamp(),unique(mission_id,call_key));
alter table public.model_token_reservations enable row level security;alter table public.model_token_reservations force row level security;
create policy mission_scope on public.model_token_reservations using(private.owns_mission(mission_id));
create trigger immutable_row before update or delete on public.model_token_reservations for each row execute function private.immutable_row();
grant select on public.model_token_reservations to founder_role,lead_role,specialist_role,policy_role;
create function public.reserve_run_tokens(p_mission uuid,p_run uuid,p_key text,p_max bigint)returns void language plpgsql security definer set search_path=''as $$
declare maximum bigint;used bigint;prior public.model_token_reservations;begin
 perform private.require_role(array['policy_role']);perform private.lock_mission(p_mission);perform private.active_mission(p_mission);
 select (brief->>'maxTokens')::bigint into maximum from public.runs where mission_id=p_mission and id=p_run;
 if maximum is null or maximum<=0 or p_max is null or p_max<=0 or length(coalesce(p_key,''))not between 1 and 512 then raise exception 'validation: bounded existing model run required';end if;
 select*into prior from public.model_token_reservations where mission_id=p_mission and call_key=p_key;
 if found then if prior.run_id<>p_run or prior.maximum_tokens<>p_max then raise exception 'invariant_violation: model token reservation replay changed';end if;return;end if;
 select coalesce(sum(case when u.usage_complete and u.input_tokens+u.output_tokens>0 then u.input_tokens+u.output_tokens else r.maximum_tokens end),0)into used from public.model_token_reservations r left join public.model_usage u on u.mission_id=r.mission_id and u.call_key=r.call_key and u.run_id=r.run_id where r.mission_id=p_mission and r.run_id=p_run;
 if used+p_max>maximum then raise exception 'validation: aggregate run model token budget exhausted';end if;
 insert into public.model_token_reservations(mission_id,run_id,call_key,maximum_tokens)values(p_mission,p_run,p_key,p_max);
end$$;
revoke all on function public.reserve_run_tokens(uuid,uuid,text,bigint)from public;
grant execute on function public.reserve_run_tokens(uuid,uuid,text,bigint)to policy_role;
create or replace function public.record_model_usage(p_mission uuid,p_run uuid,p_key text,p_model text,p_input bigint,p_output bigint,p_cached bigint,p_cost bigint,p_complete boolean,p_price jsonb,p_response text)returns void language plpgsql security definer set search_path=''as $$
declare r public.model_usage_reservations;prior public.model_usage;begin
 perform private.require_role(array['policy_role']);perform private.assert_mission(p_mission);
 if p_input is null or p_output is null or p_cached is null or p_complete is null or p_input<0 or p_output<0 or p_cached<0 or p_cached>p_input or p_cost<0 or coalesce(length(p_key),0)=0 or coalesce(length(p_model),0)=0 then raise exception 'validation: invalid model usage';end if;
 if not exists(select from public.runs where id=p_run and mission_id=p_mission)then raise exception 'invariant_violation: model run outside mission';end if;
 if exists(select from public.model_usage_reservations where call_key=p_key and(mission_id<>p_mission or run_id<>p_run))or exists(select from public.model_token_reservations where call_key=p_key and(mission_id<>p_mission or run_id<>p_run))then raise exception 'invariant_violation: model usage reservation identity mismatch';end if;
 if p_complete and p_input+p_output=0 then raise exception 'validation: complete model usage must include measured tokens';end if;
 select *into r from public.model_usage_reservations where mission_id=p_mission and run_id=p_run and call_key=p_key;
 if p_cost is not null and(r.id is null or p_cost>r.ceiling_micro_usd)then raise exception 'invariant_violation: model usage exceeds reserved ceiling';end if;
 if not p_complete and p_cost is not null then raise exception 'validation: unknown usage cannot have a measured cost';end if;
 insert into public.model_usage(mission_id,run_id,call_key,model,input_tokens,output_tokens,cached_input_tokens,cost_micro_usd,usage_complete,price_snapshot,response_id)
 values(p_mission,p_run,p_key,p_model,p_input,p_output,p_cached,p_cost,p_complete,p_price,p_response)on conflict(call_key)do nothing;
 select *into strict prior from public.model_usage where call_key=p_key;
 if row(prior.mission_id,prior.run_id,prior.model,prior.input_tokens,prior.output_tokens,prior.cached_input_tokens,prior.cost_micro_usd,prior.usage_complete,prior.price_snapshot,prior.response_id)
 is distinct from row(p_mission,p_run,p_model,p_input,p_output,p_cached,p_cost,p_complete,p_price,p_response)then raise exception 'conflict: model usage key reused with changed data';end if;
end$$;
commit;
