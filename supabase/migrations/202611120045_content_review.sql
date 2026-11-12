begin;
-- Exact approved checklist screening is deterministic. It complements, rather
-- than asserts, legal or semantic certification of a phrase or image.
create function private.claim_text(p_text text)returns text language plpgsql immutable set search_path=''as $$
declare result text:=normalize(coalesce(p_text,''),NFKC);entity text;token text[];code integer;begin
 for token in select regexp_matches(result,'(&#([xX][0-9a-fA-F]+|[0-9]+);?)','g')loop
 entity:=token[2];if length(entity)>9 then raise exception 'validation: invalid content entity';end if;
 if lower(left(entity,1))='x'then code:=('x'||lpad(substr(entity,2),8,'0'))::bit(32)::integer;else code:=entity::integer;end if;
 if code<1 or code>1114111 or code between 55296 and 57343 then raise exception 'validation: invalid content entity';end if;
 result:=replace(result,token[1],chr(code));end loop;
 result:=replace(replace(replace(replace(replace(replace(result,'&nbsp;',' '),'&amp;','&'),'&lt;','<'),'&gt;','>'),'&quot;','"'),'&apos;','''');
 if result~'&[A-Za-z][A-Za-z0-9]+;'or result~'&#'then raise exception 'validation: unsupported named content entity; use literal text for review';end if;
 result:=normalize(result,NFKC);
 if lower(result)~'<\s*/?\s*(script|style|template|noscript)([\s>/]|$)'then raise exception 'validation: hidden or executable HTML content requires plain text review';end if;
 for token in select regexp_matches(result,'(<[^>]*>)','g')loop
 if lower(token[1])!~'^</?(p|div|span|b|i|em|strong|u|s|ul|ol|li|br|h[1-6])\s*/?>$'then raise exception 'validation: HTML attributes or unsupported markup require plain text review';end if;end loop;
 result:=regexp_replace(result,'<[^>]*>','','g');
 result:=translate(result,U&'\00AD\034F\061C\180E\200B\200C\200D\200E\200F\202A\202B\202C\202D\202E\2060\2061\2062\2063\2064\2066\2067\2068\2069\FE0E\FE0F\FEFF\0640\064B\064C\064D\064E\064F\0650\0651\0652','');
 return lower(regexp_replace(result,'\s+',' ','g'));
end$$;
create function public.check_content_claims(p_mission uuid,p_checklist uuid,p_text text)returns jsonb language plpgsql stable security definer set search_path=''as $$
declare content jsonb;phrase text;matches jsonb:='[]';normalized text;begin
 perform private.require_role(array['lead_role','specialist_role','policy_role','founder_role']);perform private.assert_mission(p_mission);
 if length(coalesce(p_text,''))>1000000 then raise exception 'validation: bounded publication copy required';end if;
 select v.content into content from public.artifact_versions v join public.artifacts a on a.id=v.artifact_id and a.mission_id=v.mission_id where v.mission_id=p_mission and v.id=p_checklist and a.type='compliance_checklist';
 if content is null or jsonb_typeof(content->'prohibitedClaims')is distinct from'array'or not private.readiness_current_approved(p_mission,p_checklist)then raise exception 'needs_approval: current approved compliance checklist required';end if;
 normalized:=private.claim_text(p_text);
 for phrase in select jsonb_array_elements_text(content->'prohibitedClaims')loop
 if length(trim(phrase))=0 then raise exception 'validation: empty prohibited claim';end if;
 if strpos(normalized,private.claim_text(phrase))>0 or strpos(regexp_replace(normalized,'\s','','g'),regexp_replace(private.claim_text(phrase),'\s','','g'))>0 then matches:=matches||jsonb_build_array(phrase);end if;end loop;
 return jsonb_build_object('checklistVersionId',p_checklist,'matches',matches,'clear',jsonb_array_length(matches)=0,'requiresDomainReview',true);
end$$;
create function private.publication_copy(p_content jsonb,p_depth integer default 0)returns text language plpgsql immutable set search_path=''as $$declare part jsonb;copy text:='';begin
 if p_depth>32 then raise exception 'validation: publication content too deeply nested';end if;
 if jsonb_typeof(p_content)='string'then return p_content#>>'{}';
 elsif jsonb_typeof(p_content)='array'then for part in select value from jsonb_array_elements(p_content)loop copy:=copy||' '||private.publication_copy(part,p_depth+1);end loop;
 elsif jsonb_typeof(p_content)='object'then for part in select value from jsonb_each(p_content)loop copy:=copy||' '||private.publication_copy(part,p_depth+1);end loop;end if;return copy;
end$$;
revoke all on function private.publication_copy(jsonb,integer)from public;
create function private.check_publication_content(p_mission uuid,p_version uuid)returns void language plpgsql stable security definer set search_path=''as $$
declare v jsonb;guard jsonb;copy jsonb;report jsonb;source uuid;action text;begin
 select content into v from public.artifact_versions where mission_id=p_mission and id=p_version;
 action:=v#>>'{effectIntent,action}';
 if action not in('store_configure','store_publish','store_publish_policy','marketing_publish')or action is null then return;end if;
 guard:=v->'contentReview';if guard is null or guard->>'checklistVersionId'is null then raise exception 'needs_approval: publication content must bind a compliance checklist';end if;
 copy:=coalesce(v->'payload',v);
 if action='store_publish'then
 source:=(guard->>'sourceVersionId')::uuid;
 if source is null or not private.readiness_current_approved(p_mission,source)then raise exception 'needs_approval: approved original product copy required';end if;
 select content->'payload'into copy from public.artifact_versions where mission_id=p_mission and id=source and content#>>'{effectIntent,action}'='store_configure'and content#>>'{payload,kind}'='product';
 if copy is null or not exists(select from public.provider_receipts r join public.effect_authorizations a on a.id=r.authorization_id and a.mission_id=r.mission_id where r.mission_id=p_mission and r.provider='shopify'and r.operation='store_configure'and r.provider_reference=v#>>'{payload,productId}'and a.intent->>'artifactVersionId'=source::text and a.intent->>'instrumentId'=v#>>'{effectIntent,instrumentId}')then raise exception 'needs_approval: product must match its receipt-backed approved draft';end if;
 end if;
 report:=public.check_content_claims(p_mission,(guard->>'checklistVersionId')::uuid,private.publication_copy(copy));
 if report->'clear'<>'true'::jsonb then raise exception 'rejected: prohibited claim in proposed publication';end if;
end$$;
-- Keep every earlier source/payment/tenant guard in the chain.
alter function private.check_version(uuid,uuid)rename to check_version_before_content_review;
create function private.check_version(p_mission uuid,p_version uuid)returns void language plpgsql stable security definer set search_path=''as $$begin
 perform private.check_version_before_content_review(p_mission,p_version);perform private.check_publication_content(p_mission,p_version);
end$$;
create function private.content_review_dependencies()returns trigger language plpgsql security definer set search_path=''as $$declare ref uuid;begin
 if new.content?'contentReview'then
 for ref in select value::uuid from jsonb_each_text(new.content->'contentReview')where key in('checklistVersionId','sourceVersionId')loop
 if not exists(select from public.artifact_versions where mission_id=new.mission_id and id=ref)then raise exception 'validation: content review source outside mission';end if;
 insert into public.dependencies(mission_id,upstream_id,dependent_id,reason)values(new.mission_id,ref,new.id,'approved publication copy and checklist')on conflict do nothing;
 end loop;end if;return new;
end$$;
create trigger content_review_dependencies after insert on public.artifact_versions for each row execute function private.content_review_dependencies();
revoke all on function private.claim_text(text),private.check_publication_content(uuid,uuid),private.check_version(uuid,uuid),private.check_version_before_content_review(uuid,uuid),private.content_review_dependencies(),public.check_content_claims(uuid,uuid,text)from public;
grant execute on function public.check_content_claims(uuid,uuid,text)to founder_role,lead_role,specialist_role,policy_role;
commit;
