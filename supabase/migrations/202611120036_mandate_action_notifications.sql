begin;
-- Forward correction for mandates bounded by an action count as well as money
-- and new contacts. Counts use the same reserved spend rows as reserve_effect.
create function private.queue_mandate_warning(p_mission uuid,p_mandate uuid,p_source uuid,p_at timestamptz)returns void language plpgsql security definer set search_path=''as $$
declare m public.mandates;used numeric;contacts bigint;actions bigint;max_actions numeric;max_contacts numeric;near boolean;reached boolean;begin
 select *into strict m from public.mandates where mission_id=p_mission and id=p_mandate;
 select coalesce(sum(a.amount_minor),0),count(*)filter(where a.intent->>'newContact'='true'),count(*)filter(where a.intent->>'effectClass'='spend')into used,contacts,actions from public.effect_authorizations a where a.mission_id=p_mission and a.mandate_id=m.id;
 max_actions:=coalesce((m.scope->>'maxActions')::numeric,0);max_contacts:=coalesce((m.scope->>'maxNewContacts')::numeric,0);
 near:=(m.ceiling_total>0 and used*5>=m.ceiling_total*4::numeric)or(max_contacts>0 and contacts*5>=max_contacts*4)or(max_actions>0 and actions*5>=max_actions*4);
 reached:=(m.ceiling_total>0 and used>=m.ceiling_total)or(max_contacts>0 and contacts>=max_contacts)or(max_actions>0 and actions>=max_actions);
 if near then perform private.notification_source(p_mission,'effect_authorizations',p_source,'mandate','mandate:'||m.id||':80',p_at);end if;
 if reached then perform private.notification_source(p_mission,'effect_authorizations',p_source,'mandate','mandate:'||m.id||':100',p_at);end if;
end$$;
create function private.capture_mandate_notification()returns trigger language plpgsql security definer set search_path=''as $$begin
 if new.mandate_id is not null then perform private.queue_mandate_warning(new.mission_id,new.mandate_id,new.id,new.created_at);end if;return new;
end$$;
drop trigger notification_source on public.effect_authorizations;
create trigger notification_source after insert on public.effect_authorizations for each row execute function private.capture_mandate_notification();
-- Existing live reservations also gain missing count warnings on upgrade.
do $$declare a record;begin
 for a in select distinct on(auth.mandate_id)auth.mission_id,auth.mandate_id,auth.id from public.effect_authorizations auth join public.mandates m on m.mission_id=auth.mission_id and m.id=auth.mandate_id
 where m.expires_at>clock_timestamp()and not exists(select from public.mandate_revocations r where r.mandate_id=m.id)order by auth.mandate_id,auth.created_at desc,auth.id desc loop
 perform private.queue_mandate_warning(a.mission_id,a.mandate_id,a.id,clock_timestamp());
 end loop;
end$$;
revoke all on function private.queue_mandate_warning(uuid,uuid,uuid,timestamptz),private.capture_mandate_notification()from public;
commit;
