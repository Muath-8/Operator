begin;
alter table public.messages add constraint messages_mission_identity unique(mission_id,id);
alter table public.mission_questions add column fact_key text check(fact_key~'^[a-z][a-zA-Z0-9_]{0,79}$');
alter table public.mission_questions add column fact_scope text not null default 'mission'check(fact_scope in('mission','founder'));
create table public.founder_facts(id uuid primary key default gen_random_uuid(),founder_id uuid not null references public.founders(id),mission_id uuid not null references public.missions(id),scope text not null check(scope in('mission','founder')),fact_key text not null,value jsonb not null,evidence_id uuid not null,created_at timestamptz not null default clock_timestamp(),foreign key(mission_id,evidence_id)references public.evidence(mission_id,id));
alter table public.founder_facts enable row level security;alter table public.founder_facts force row level security;
create policy scoped_facts on public.founder_facts using(private.owns_founder(founder_id)and(scope='founder'or private.owns_mission(mission_id)));
create trigger immutable_row before update or delete on public.founder_facts for each row execute function private.immutable_row();
create trigger ledger_revision after insert on public.founder_facts for each row execute function private.record_ledger_revision();
create trigger broadcast_ledger after insert on public.founder_facts for each row execute function private.broadcast_ledger();
grant select on public.founder_facts to founder_role,lead_role,specialist_role;
create function private.canonical_fact_key(p_key text)returns text language sql immutable set search_path=''as $$select case lower(p_key)
 when 'budget'then'budgetMinor'when 'budget_minor'then'budgetMinor'when 'budgetminor'then'budgetMinor'when 'budgetceiling'then'budgetMinor'when 'initialbudget'then'budgetMinor'
 when 'country'then'market'when 'targetmarket'then'market'when 'marketcountry'then'market'when 'market'then'market'
 when 'language'then'locale'when 'preferredlanguage'then'locale'when 'locale'then'locale'
 when 'timezone'then'timeZone'when 'time_zone'then'timeZone'
 when 'category'then'categoryProfileId'when 'categoryprofileid'then'categoryProfileId'when 'productcategory'then'categoryProfileId'
 when 'brand_name'then'brandName'when 'brandname'then'brandName'when 'existingname'then'brandName'
 else p_key end$$;
create function public.conversation_facts(p_mission uuid)returns jsonb language plpgsql stable security definer set search_path=''as $$
declare result jsonb;founder uuid;begin
 perform private.require_role(array['founder_role','lead_role','specialist_role']);perform private.assert_mission(p_mission);
 select m.founder_id,jsonb_strip_nulls(jsonb_build_object('locale',f.locale,'timeZone',f.profile->'timeZone','involvement',m.involvement))||m.metadata into founder,result from public.effective_missions m join public.founders f on f.id=m.founder_id where m.id=p_mission;
 -- Confirmed answers can fill missing fields; an approved mission brief remains
 -- authoritative for fields already established by that binding decision.
 return coalesce((select jsonb_object_agg(fact_key,value)from(select distinct on(fact_key)fact_key,value from public.founder_facts where founder_id=founder and(mission_id=p_mission or scope='founder')order by fact_key,created_at desc,id desc)f),'{}')||result;
end$$;
create function private.question_fact_guard()returns trigger language plpgsql security definer set search_path=''as $$begin
 new.fact_key:=private.canonical_fact_key(new.fact_key);
 if new.fact_scope='founder'and new.fact_key not in('locale','timeZone','availabilityHours','contactPreference')then raise exception 'validation: this fact is mission-specific';end if;
 if new.fact_key is not null and(public.conversation_facts(new.mission_id)?new.fact_key or exists(select from public.mission_questions q where q.mission_id=new.mission_id and q.fact_key=new.fact_key))then raise exception 'validation: known or already asked fact cannot be asked again';end if;return new;
end$$;
create trigger question_fact_guard before insert on public.mission_questions for each row execute function private.question_fact_guard();
create function public.propose_mission_question(p_mission uuid,p_key text,p_scope text,p_question text,p_default text,p_blocking boolean,p_outcome text)returns uuid language plpgsql security definer set search_path=''as $$declare result uuid;begin
 perform private.require_role(array['lead_role']);perform private.lock_mission(p_mission);
 p_key:=private.canonical_fact_key(p_key);
 if p_key is null or p_key!~'^[a-z][a-zA-Z0-9_]{0,79}$'then raise exception 'validation: semantic fact key required';end if;
 if public.conversation_facts(p_mission)?p_key then return null;end if;
 select id into result from public.mission_questions where mission_id=p_mission and fact_key=p_key;if found then return result;end if;
 if(select count(*)from public.mission_questions q where mission_id=p_mission and not exists(select from public.question_answers a where a.question_id=q.id))>=5 then return null;end if;
 if not exists(select from public.active_decisions where mission_id=p_mission and kind='goal')and(select count(*)from public.mission_questions where mission_id=p_mission)>=5 then return null;end if;
 insert into public.mission_questions(mission_id,question,recommended_default,blocking,outcome,fact_key,fact_scope)values(p_mission,p_question,p_default,p_blocking,p_outcome,p_key,p_scope)returning id into result;return result;
end$$;
create function private.capture_answer_fact()returns trigger language plpgsql security definer set search_path=''as $$declare q public.mission_questions;begin
 select*into strict q from public.mission_questions where id=new.question_id;
 if q.fact_key is not null then insert into public.founder_facts(founder_id,mission_id,scope,fact_key,value,evidence_id)select founder_id,new.mission_id,q.fact_scope,q.fact_key,to_jsonb(new.answer),new.evidence_id from public.missions where id=new.mission_id;end if;return new;
end$$;
create trigger capture_answer_fact after insert on public.question_answers for each row execute function private.capture_answer_fact();
create table public.glossary_terms(id text primary key,term_en text not null,term_ar text not null,definition_en text not null,definition_ar text not null,aliases text[] not null);
grant select on public.glossary_terms to founder_role,lead_role,specialist_role;
create table public.glossary_first_uses(id uuid primary key default gen_random_uuid(),mission_id uuid not null references public.missions(id),term_id text not null references public.glossary_terms(id),message_id uuid not null,created_at timestamptz not null default clock_timestamp(),unique(mission_id,term_id),foreign key(mission_id,message_id)references public.messages(mission_id,id));
alter table public.glossary_first_uses enable row level security;alter table public.glossary_first_uses force row level security;
create policy mission_scope on public.glossary_first_uses using(private.owns_mission(mission_id));
create trigger immutable_row before update or delete on public.glossary_first_uses for each row execute function private.immutable_row();
grant select on public.glossary_first_uses to founder_role,lead_role,specialist_role;
insert into public.glossary_terms values
 ('moq','MOQ','الحد الأدنى للطلب','The smallest quantity a supplier agrees to make or sell.','أقل كمية يوافق المورد على تصنيعها أو بيعها.',array['MOQ','minimum order quantity','الحد الأدنى للطلب']),
 ('landed_cost','Landed cost','التكلفة الواصلة','The total cost to have one sellable unit ready to ship, with each cost basis shown.','إجمالي تكلفة تجهيز وحدة قابلة للبيع للشحن، مع توضيح أساس كل تكلفة.',array['landed cost','التكلفة الواصلة']),
 ('incoterm','Incoterm','شرط التسليم','A trade term allocating delivery costs and responsibilities between buyer and seller.','شرط تجاري يحدد مسؤوليات وتكاليف التسليم بين البائع والمشتري.',array['Incoterm','Incoterms','شرط التسليم']),
 ('aql','AQL','مستوى الجودة المقبول','A sampling-plan quality limit; it is not a guarantee that every item is defect-free.','حد جودة لخطة فحص بالعينة، وليس ضمانًا لخلو كل قطعة من العيوب.',array['AQL','مستوى الجودة المقبول']),
 ('gross_margin','Gross margin','هامش الربح الإجمالي','The share of the selling price remaining after the stated unit costs.','حصة سعر البيع المتبقية بعد تكاليف الوحدة المحددة.',array['gross margin','هامش الربح الإجمالي']),
 ('proforma','Proforma invoice','الفاتورة الأولية','A preliminary invoice recording proposed goods, price and terms before final payment.','فاتورة مبدئية توضح البضائع والسعر والشروط المقترحة قبل الدفع النهائي.',array['proforma','الفاتورة الأولية']);
create or replace function public.append_lead_message(p_mission uuid,p_thread uuid,p_text text)returns uuid language plpgsql security definer set search_path=''as $$
declare result uuid;term record;body text:=p_text;lang text;first_terms text[]:='{}';begin
 perform private.require_role(array['lead_role']);perform private.lock_mission(p_mission);
 select coalesce(metadata->>'locale','en')into lang from public.effective_missions where id=p_mission;
 for term in select t.*from public.glossary_terms t where not exists(select from public.glossary_first_uses u where u.mission_id=p_mission and u.term_id=t.id)and exists(select from unnest(t.aliases)a where position(lower(a)in lower(p_text))>0)order by t.id loop
  body:=body||E'\n\n'||case when lang='ar'then term.term_ar||': '||term.definition_ar else term.term_en||': '||term.definition_en end;first_terms:=array_append(first_terms,term.id);
 end loop;
 insert into public.messages(mission_id,thread_id,channel,direction,original)values(p_mission,p_thread,'app','lead',body)returning id into result;
 insert into public.glossary_first_uses(mission_id,term_id,message_id)select p_mission,t,result from unnest(first_terms)t;return result;
end$$;
revoke all on function public.conversation_facts(uuid),public.propose_mission_question(uuid,text,text,text,text,boolean,text)from public;
grant execute on function public.conversation_facts(uuid)to founder_role,lead_role,specialist_role;
grant execute on function public.propose_mission_question(uuid,text,text,text,text,boolean,text)to lead_role;
commit;
