-- TEST ONLY: minimal Supabase-owned surfaces for real PostgreSQL policy tests.
create role authenticated nologin noinherit nobypassrls;
create schema realtime;
create table realtime.messages(id bigint generated always as identity,topic text not null,extension text not null,payload jsonb);
alter table realtime.messages enable row level security;
create table realtime.test_broadcasts(topic text not null,event text not null,payload jsonb,private boolean not null);
create function realtime.send(payload jsonb,event text,topic text,private boolean)returns void language sql as $$insert into realtime.test_broadcasts values(topic,event,payload,private)$$;
create schema storage;
create table storage.buckets(id text primary key,name text,public boolean);
create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text);
alter table storage.objects enable row level security;
