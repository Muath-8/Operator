-- Explicit sandbox fixtures. No simulated provider receipts or payment success.
-- Repeat-safe; never replaces founder data or mutates immutable ledger rows.
begin;
insert into public.category_profiles(id,version,content,review_status,sources)values
('perfume',1,'{"category":"perfume","components":["bottle","pump","cap","box"],"regulatedIngredients":true,"labelRequirements":["ingredients","volume","batch","manufacturer","market-specific warnings"],"licensedProfessionalRequired":["formulation review","regulatory confirmation"],"verification":"research all market-specific requirements before use","typicalLeadDays":{"min":30,"max":90},"moqResearchRequired":true}','unverified',array['BRD 3.2','BRD 4A']),
('watch-strap',1,'{"category":"watch strap","components":["strap","buckle","spring bars"],"specFields":["lug_width_mm","length_mm","thickness_mm","material","finish","tolerances"],"researchRequired":["material safety","market labelling","fit testing"],"verification":"research and review before commercial use"}','unverified',array['BRD flexibility requirement']),
('generic',1,'{"category":null,"components":[],"researchRequired":["materials","market requirements","manufacturing route","quality assurance","labelling"],"verified":false}','unverified',array['BRD 3.2'])on conflict do nothing;
insert into public.playbooks(id,version,content,review_status,sources)values
('sourcing',1,'{"steps":["research 8-12 candidates","verify before shortlist","send identical RFQ","compare 3-5 quotes","approve physical samples","negotiate documented terms","approve production order","arrange AQL inspection"],"optionalStepsRequireSkip":true}','unverified',array['BRD 4A']),
('launch-gates',1,'{"method":"Stage-Gate per outcome","outcomes":["brand","product","supply","commerce","compliance","demand"],"readinessDerived":true}','unverified',array['BRD 4.2','BRD 17.1'])on conflict do nothing;
insert into public.founders(id,auth_user_id,profile,locale)values('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','{"displayName":"Layla","fixture":true}','en')on conflict do nothing;
insert into public.missions(id,founder_id,type,goal_brief,currency,sandbox_mode,metadata)values
('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','launch','Launch a considered fragrance identity with a SAR 30,000 initial budget. Compare verified manufacturing routes before committing.','SAR',true,'{"title":"A scent of your own","summary":"A fragrance brand for Saudi Arabia","categoryProfileId":"perfume","market":"Saudi Arabia","budgetMinor":3000000,"locale":"en","fixture":true}'),
('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','launch','Create an everyday watch strap with a clear technical specification and tested fit.','SAR',true,'{"title":"An everyday watch strap","summary":"A considered everyday accessory","categoryProfileId":"watch-strap","market":"Saudi Arabia","budgetMinor":1500000,"locale":"en","fixture":true}')on conflict do nothing;
insert into public.counterparties(id,founder_id,kind,name,verification)values
('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','supplier','Supplier A','{"status":"unverified","fixture":true}'),
('30000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','supplier','Supplier B','{"status":"unverified","fixture":true}'),
('30000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001','supplier','Supplier C','{"status":"unverified","fixture":true}')on conflict do nothing;
do $$declare m uuid;d uuid;a uuid;v uuid;e uuid;e1 uuid;e2 uuid;e3 uuid;t uuid;packet jsonb;begin
  m:='20000000-0000-4000-8000-000000000001';
  if exists(select from public.artifacts where mission_id=m)then return;end if;
  perform set_config('request.jwt.claims',jsonb_build_object('sub','00000000-0000-4000-8000-000000000001','mission_id',m)::text,true);
  perform set_config('role','lead_role',true);
  packet:='{"question":"Approve this direction?","options":[{"id":"approve","label":"Approve direction","evidenceIds":[],"cost":null,"timeDays":0,"consequences":"Use the direction for future work"}],"recommendation":{"optionId":"approve","reasons":["Matches the founder brief"]},"staleImpact":[],"defaultIfNoAnswer":{"optionId":"approve","at":null,"binding":true}}';
  d:=public.propose_decision(m,'selection',packet,'brand','direction',null);
  perform set_config('role','founder_role',true);perform public.resolve_decision(m,d,'approve','approve');
  perform set_config('role','specialist_role',true);
  e:=public.append_evidence(m,'brand','research','claimed','{"note":"Sandbox fixture research; no real availability checks completed"}','document','seed:brand-research');
  a:=public.create_artifact(m,'brand_directions','brand','Three directions, one point of view');
  v:=public.append_artifact_version(m,a,'{"directions":[{"id":"quiet","name":"Quiet ritual","positioning":"An everyday ritual grounded in warm materials and clarity.","palette":["#e9e0d1","#2e352d","#9b7056"],"mark":"O","typography":"serif"},{"id":"light","name":"A trace of light","positioning":"A bright, open identity with room to breathe.","palette":["#f3ede1","#b6bd95","#5a654a"],"mark":"L","typography":"serif"},{"id":"earth","name":"After the rain","positioning":"A tactile identity inspired by the meeting of earth and air.","palette":["#d9cdb8","#786859","#313b35"],"mark":"R","typography":"serif"}],"editableSource":"structured identity JSON","fixture":true}',array[]::uuid[],array[d],array[e]);
  perform public.set_artifact_status(m,v,'proposed');perform set_config('role','founder_role',true);perform public.set_artifact_status(m,v,'approved',d);
  perform set_config('role','lead_role',true);d:=public.propose_decision(m,'selection',packet,'product','direction',null);perform set_config('role','founder_role',true);perform public.resolve_decision(m,d,'approve','approve');
  perform set_config('role','lead_role',true);d:=public.propose_decision(m,'selection',packet,'product','specification',null);perform set_config('role','founder_role',true);perform public.resolve_decision(m,d,'approve','approve');
  perform set_config('role','specialist_role',true);
  e:=public.append_evidence(m,'product','research','claimed','{"fixture":true,"source":"founder brief"}','document','seed:product-research');
  e:=public.append_evidence(m,'product','specification','claimed','{"fixture":true,"volumeMl":50,"materials":["glass","aluminium"]}','document','seed:product-spec');
  a:=public.create_artifact(m,'product_spec','product','The approved specification');v:=public.append_artifact_version(m,a,'{"kind":"bottle","dims_mm":{"width":42,"height":105,"depth":28},"volume_ml":50,"parts":[{"name":"body","material":"glass","finish":"clear"},{"name":"cap","material":"aluminium","finish":"brushed"},{"name":"pump","material":"mixed","finish":"matte"}],"fixture":true}',array[]::uuid[],array[d],array[e]);perform public.set_artifact_status(m,v,'proposed');perform set_config('role','founder_role',true);perform public.set_artifact_status(m,v,'approved',d);
  perform set_config('role','specialist_role',true);
  e1:=public.append_evidence(m,'supply','quotation','claimed','{"supplier":"Supplier A","unitPriceMinor":284,"currency":"USD","moq":3000,"leadDays":45,"fixture":true}','document','seed:quote-a');
  e2:=public.append_evidence(m,'supply','quotation','claimed','{"supplier":"Supplier B","unitPriceMinor":240,"currency":"USD","moq":500,"leadDays":30,"fixture":true}','document','seed:quote-b');
  e3:=public.append_evidence(m,'supply','quotation','claimed','{"supplier":"Supplier C","unitPriceMinor":315,"currency":"USD","moq":1000,"leadDays":35,"fixture":true}','document','seed:quote-c');
  a:=public.create_artifact(m,'comparison','supply','Three routes to a first sample');
  v:=public.append_artifact_version(m,a,jsonb_build_object('quotes',jsonb_build_array(
    jsonb_build_object('id','a','title','Supplier A','unitPriceMinor',284,'currency','USD','moq',3000,'leadDays',45,'evidenceId',e1,'spec',jsonb_build_object('kind','bottle','dims_mm',jsonb_build_object('width',44,'height',108,'depth',30),'parts',jsonb_build_array(jsonb_build_object('t','rect','x',-22.0,'y',0,'w',44,'h',80,'r',5,'m','glass','role','body'),jsonb_build_object('t','rect','x',-5,'y',76,'w',10,'h',14,'m','glass','role','neck'),jsonb_build_object('t','rect','x',-11,'y',86,'w',22,'h',22,'r',2,'m','metal','role','cap')))),
    jsonb_build_object('id','b','title','Supplier B','unitPriceMinor',240,'currency','USD','moq',500,'leadDays',30,'evidenceId',e2,'spec',jsonb_build_object('kind','bottle','dims_mm',jsonb_build_object('width',42,'height',105,'depth',28),'parts',jsonb_build_array(jsonb_build_object('t','rect','x',-21.0,'y',0,'w',42,'h',77,'r',5,'m','glass','role','body'),jsonb_build_object('t','rect','x',-5,'y',73,'w',10,'h',14,'m','glass','role','neck'),jsonb_build_object('t','rect','x',-11,'y',83,'w',22,'h',22,'r',2,'m','metal','role','cap')))),
    jsonb_build_object('id','c','title','Supplier C','unitPriceMinor',315,'currency','USD','moq',1000,'leadDays',35,'evidenceId',e3,'spec',jsonb_build_object('kind','bottle','dims_mm',jsonb_build_object('width',45,'height',102,'depth',32),'parts',jsonb_build_array(jsonb_build_object('t','rect','x',-22.5,'y',0,'w',45,'h',74,'r',5,'m','glass','role','body'),jsonb_build_object('t','rect','x',-5,'y',70,'w',10,'h',14,'m','glass','role','neck'),jsonb_build_object('t','rect','x',-11,'y',80,'w',22,'h',22,'r',2,'m','metal','role','cap'))))),'limit',1000,'fixture',true),array[]::uuid[],array[]::uuid[],array[e1,e2,e3]);
  perform public.set_artifact_status(m,v,'proposed');
  perform set_config('role','lead_role',true);
  packet:=jsonb_build_object('question','Shall I request a sample from Supplier B?','options',jsonb_build_array(
    jsonb_build_object('id','b','label','Request Supplier B sample','evidenceIds',jsonb_build_array(e2),'cost',jsonb_build_object('amountMinor',22500,'currency','SAR'),'timeDays',7,'consequences','A small trial batch fits the approved quantity limit; payment requires a separate approval'),
    jsonb_build_object('id','compare','label','Keep comparing','evidenceIds',jsonb_build_array(e1,e3),'cost',null,'timeDays',3,'consequences','Research alternatives before contacting anyone')),
    'recommendation',jsonb_build_object('optionId','b','reasons',jsonb_build_array('Lowest claimed minimum quantity','Fits the approved dimensions; verification still required')),'staleImpact','[]'::jsonb,'defaultIfNoAnswer',jsonb_build_object('optionId','compare','at',null,'binding',true));
  d:=public.propose_decision(m,'selection',packet,'supply','direction');
  perform set_config('role','specialist_role',true);insert into public.threads(mission_id)values(m)returning id into t; -- founder conversation, no outreach
  perform set_config('role','lead_role',true);perform public.append_lead_message(m,t,'Three quoted routes are ready to compare. Supplier B claims the lowest minimum quantity; supplier verification and sample approval are still outstanding.');
  insert into public.focus_events(mission_id,node_id,actor_id)values(m,a,private.actor_id());
  perform set_config('role','none',true);
end$$;
do $$declare m uuid;d uuid;a uuid;e uuid;begin
  m:='20000000-0000-4000-8000-000000000002';if exists(select from public.artifacts where mission_id=m)then return;end if;
  perform set_config('request.jwt.claims',jsonb_build_object('sub','00000000-0000-4000-8000-000000000001','mission_id',m)::text,true);perform set_config('role','lead_role',true);
  d:=public.propose_decision(m,'selection','{"question":"Use this direction?","options":[{"id":"a","label":"Approve","evidenceIds":[],"cost":null,"timeDays":0,"consequences":"Continue to specification"}],"recommendation":{"optionId":"a","reasons":["A versatile everyday direction"]},"staleImpact":[],"defaultIfNoAnswer":{"optionId":"a","at":null,"binding":true}}','brand','direction');perform set_config('role','founder_role',true);perform public.resolve_decision(m,d,'approve','a');perform set_config('role','specialist_role',true);
  e:=public.append_evidence(m,'brand','research','claimed','{"fixture":true}','document','seed:second-category-research');
  a:=public.create_artifact(m,'brand_directions','brand','Built for the everyday');perform public.append_artifact_version(m,a,'{"directions":[{"id":"field","name":"Field notes","positioning":"Quietly dependable essentials for everyday movement.","palette":["#ded6c8","#3e4a3b","#a78960"],"mark":"F"}],"fixture":true}',array[]::uuid[],array[d],array[e]);
  a:=public.create_artifact(m,'product_spec','product','A measured fit');perform public.append_artifact_version(m,a,'{"kind":"strap","dims_mm":{"width":20,"height":120,"depth":3},"parts":[{"name":"long section","material":"woven textile"},{"name":"short section","material":"woven textile"},{"name":"buckle","material":"steel"}],"fixture":true}');
  perform set_config('role','none',true);
end$$;
commit;

