begin;
create table public.model_usage_reservations(
 id uuid primary key default gen_random_uuid(),mission_id uuid not null,run_id uuid not null,call_key text not null unique,
 ceiling_micro_usd bigint not null check(ceiling_micro_usd>=0),created_at timestamptz not null default clock_timestamp(),
 foreign key(mission_id,run_id)references public.runs(mission_id,id),unique(mission_id,id)
);
create table public.model_usage(
 id uuid primary key default gen_random_uuid(),mission_id uuid not null,run_id uuid not null,call_key text not null unique,
 model text not null,input_tokens bigint not null,output_tokens bigint not null,cached_input_tokens bigint not null,
 cost_micro_usd bigint,usage_complete boolean not null,price_snapshot jsonb,response_id text,
 created_at timestamptz not null default clock_timestamp(),foreign key(mission_id,run_id)references public.runs(mission_id,id)
);
do $$declare t text;begin foreach t in array array['model_usage_reservations','model_usage']loop
 execute format('alter table public.%I enable row level security',t);execute format('alter table public.%I force row level security',t);
 execute format('create policy mission_scope on public.%I using(private.owns_mission(mission_id))with check(private.owns_mission(mission_id))',t);
 execute format('create trigger immutable_row before update or delete on public.%I for each row execute function private.immutable_row()',t);
 execute format('grant select on public.%I to lead_role,specialist_role,policy_role',t);
end loop;end$$;
create function public.reserve_model_budget(p_mission uuid,p_run uuid,p_key text,p_ceiling bigint,p_daily_cap bigint)returns boolean language plpgsql security definer set search_path=''as $$
declare f uuid;used bigint;prior public.model_usage_reservations;begin
 perform private.require_role(array['policy_role']);perform private.assert_mission(p_mission);
 select founder_id into strict f from public.missions where id=p_mission;perform 1 from public.founders where id=f for update;
 select *into prior from public.model_usage_reservations where call_key=p_key;
 if prior.id is not null then
  if prior.mission_id<>p_mission or prior.run_id<>p_run or prior.ceiling_micro_usd<>p_ceiling then raise exception 'conflict: model reservation key reused';end if;return true;
 end if;
 if p_ceiling is null or p_daily_cap is null or p_ceiling<0 or p_daily_cap<1 or coalesce(length(p_key),0)=0 then raise exception 'validation: explicit model budget required';end if;
 select coalesce(sum(coalesce(u.cost_micro_usd,r.ceiling_micro_usd)),0)into used from public.model_usage_reservations r
 join public.missions m on m.id=r.mission_id left join public.model_usage u on u.call_key=r.call_key
 where m.founder_id=f and r.created_at>=date_trunc('day',clock_timestamp()at time zone 'UTC')at time zone 'UTC';
 if used+p_ceiling>p_daily_cap then return false;end if;
 insert into public.model_usage_reservations(mission_id,run_id,call_key,ceiling_micro_usd)values(p_mission,p_run,p_key,p_ceiling);return true;
end$$;
create function public.record_model_usage(p_mission uuid,p_run uuid,p_key text,p_model text,p_input bigint,p_output bigint,p_cached bigint,p_cost bigint,p_complete boolean,p_price jsonb,p_response text)returns void language plpgsql security definer set search_path=''as $$
declare r public.model_usage_reservations;prior public.model_usage;begin
 perform private.require_role(array['policy_role']);perform private.assert_mission(p_mission);
 if p_input is null or p_output is null or p_cached is null or p_complete is null or p_input<0 or p_output<0 or p_cached<0 or p_cached>p_input or p_cost<0 or coalesce(length(p_key),0)=0 or coalesce(length(p_model),0)=0 then raise exception 'validation: invalid model usage';end if;
 select *into r from public.model_usage_reservations where mission_id=p_mission and run_id=p_run and call_key=p_key;
 if p_cost is not null and(r.id is null or p_cost>r.ceiling_micro_usd)then raise exception 'invariant_violation: model usage exceeds reserved ceiling';end if;
 if not p_complete and p_cost is not null then raise exception 'validation: unknown usage cannot have a measured cost';end if;
 insert into public.model_usage(mission_id,run_id,call_key,model,input_tokens,output_tokens,cached_input_tokens,cost_micro_usd,usage_complete,price_snapshot,response_id)
 values(p_mission,p_run,p_key,p_model,p_input,p_output,p_cached,p_cost,p_complete,p_price,p_response)on conflict(call_key)do nothing;
 select *into strict prior from public.model_usage where call_key=p_key;
 if row(prior.mission_id,prior.run_id,prior.model,prior.input_tokens,prior.output_tokens,prior.cached_input_tokens,prior.cost_micro_usd,prior.usage_complete,prior.price_snapshot,prior.response_id)
 is distinct from row(p_mission,p_run,p_model,p_input,p_output,p_cached,p_cost,p_complete,p_price,p_response)then raise exception 'conflict: model usage key reused with changed data';end if;
end$$;
revoke all on function public.reserve_model_budget(uuid,uuid,text,bigint,bigint),public.record_model_usage(uuid,uuid,text,text,bigint,bigint,bigint,bigint,boolean,jsonb,text)from public;
grant execute on function public.reserve_model_budget(uuid,uuid,text,bigint,bigint),public.record_model_usage(uuid,uuid,text,text,bigint,bigint,bigint,bigint,boolean,jsonb,text)to policy_role;
create view public.mission_costs with(security_invoker=true)as
 with pending as(select r.mission_id,count(*)unresolved_reservations,sum(r.ceiling_micro_usd)held_ceiling_micro_usd from public.model_usage_reservations r where not exists(select from public.model_usage u where u.call_key=r.call_key)group by r.mission_id),
 measured as(select mission_id,count(*)model_calls,sum(input_tokens)input_tokens,sum(output_tokens)output_tokens,
 case when bool_and(usage_complete and cost_micro_usd is not null)then sum(cost_micro_usd)else null end measured_model_micro_usd,
 count(*)filter(where not usage_complete or cost_micro_usd is null)unpriced_calls from public.model_usage group by mission_id)
 select coalesce(m.mission_id,p.mission_id)mission_id,coalesce(m.model_calls,0)model_calls,m.input_tokens,m.output_tokens,
 case when coalesce(p.unresolved_reservations,0)=0 then m.measured_model_micro_usd else null end measured_model_micro_usd,
 coalesce(m.unpriced_calls,0)unpriced_calls,coalesce(p.unresolved_reservations,0)unresolved_reservations,coalesce(p.held_ceiling_micro_usd,0)held_ceiling_micro_usd
 from measured m full join pending p on p.mission_id=m.mission_id;
grant select on public.mission_costs to lead_role,policy_role;
commit;
