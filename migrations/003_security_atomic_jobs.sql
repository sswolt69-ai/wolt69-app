-- WOLT 69 development migration. Replace owner UUID once before executing.
-- Run against a backed-up development Supabase project, not blindly on production.
begin;
create schema if not exists wolt_private;
revoke all on schema wolt_private from public, anon, authenticated;
create table if not exists wolt_private.config (singleton boolean primary key default true check (singleton), owner_uid uuid not null references auth.users(id));
revoke all on wolt_private.config from public, anon, authenticated;
-- IMPORTANT: Replace the literal UUID below with the owner's actual auth.users.id.
insert into wolt_private.config(singleton, owner_uid)
values (true, 'REPLACE_WITH_OWNER_AUTH_USER_UUID'::uuid)
on conflict (singleton) do update set owner_uid = excluded.owner_uid;

create or replace function public.wolt_is_owner() returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from wolt_private.config where singleton = true and owner_uid = (select auth.uid()));
$$;
revoke all on function public.wolt_is_owner() from public, anon;
grant execute on function public.wolt_is_owner() to authenticated;

do $$ declare t text; begin
  foreach t in array array['customers','vehicles','jobs','parts','stockmoves','workers','advances','expenses','vendors','vendorentries','notes','attendance'] loop
    execute format('alter table public.%I enable row level security', t);
    -- Clear all legacy permissive policies; owner-only must be the only client policy.
    execute (select coalesce(string_agg(format('drop policy if exists %I on public.%I;', policyname, t), ' '), '')
             from pg_policies where schemaname='public' and tablename=t);
    execute format('create policy wolt_owner_only on public.%I for all to authenticated using ((select public.wolt_is_owner())) with check ((select public.wolt_is_owner()))',t);
  end loop;
end $$;

-- The current React code uses these columns. Add missing ones non-destructively.
alter table public.jobs add column if not exists payments jsonb not null default '[]'::jsonb;
alter table public.jobs add column if not exists logistics jsonb not null default '{}'::jsonb;
alter table public.jobs add column if not exists deleted_at timestamptz;
alter table public.parts add column if not exists category text default 'part';
alter table public.parts add column if not exists models text[] default '{}';
alter table public.vehicles add column if not exists next_service_due date;
alter table public.vendors add column if not exists opening_balance numeric not null default 0;
alter table public.advances add column if not exists method text;
do $$ declare t text; begin
  foreach t in array array['customers','vehicles','parts','workers','vendors','expenses','notes'] loop
    execute format('alter table public.%I add column if not exists deleted_at timestamptz',t);
  end loop;
end $$;

-- One RPC = one Postgres transaction, serialized on the relevant job and part.
create or replace function public.wolt_add_job_part(p_job_id uuid, p_part_id uuid, p_qty numeric, p_line jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare j public.jobs%rowtype; available numeric;
begin
 if not public.wolt_is_owner() then raise exception 'Not authorized' using errcode='42501'; end if;
 if p_qty is null or p_qty <= 0 or p_qty > 100000 then raise exception 'Invalid quantity'; end if;
 if jsonb_typeof(p_line) <> 'object' or p_line->>'partId' <> p_part_id::text or (p_line->>'partQty')::numeric <> p_qty then raise exception 'Invalid part line'; end if;
 select * into j from public.jobs where id=p_job_id and deleted_at is null for update;
 if not found then raise exception 'Job not found'; end if;
 perform 1 from public.parts where id=p_part_id and deleted_at is null for update;
 if not found then raise exception 'Part not found'; end if;
 select coalesce(sum(qty),0) into available from public.stockmoves where part_id=p_part_id;
 if available < p_qty then raise exception 'Insufficient stock: % remaining', available; end if;
 update public.jobs set lines=coalesce(j.lines,'[]'::jsonb)||jsonb_build_array(p_line) where id=p_job_id;
 insert into public.stockmoves(part_id,qty,note) values(p_part_id,-p_qty,'Used in job '||p_job_id::text);
end $$;

create or replace function public.wolt_remove_job_line(p_job_id uuid,p_index integer)
returns void language plpgsql security definer set search_path = '' as $$
declare j public.jobs%rowtype; line jsonb; pid uuid; qty numeric;
begin
 if not public.wolt_is_owner() then raise exception 'Not authorized' using errcode='42501'; end if;
 select * into j from public.jobs where id=p_job_id and deleted_at is null for update;
 if not found then raise exception 'Job not found'; end if;
 if p_index < 0 or p_index >= jsonb_array_length(coalesce(j.lines,'[]'::jsonb)) then raise exception 'Invalid line index'; end if;
 line := j.lines->p_index;
 if line->>'type'='part' and nullif(line->>'partId','') is not null then
   pid := (line->>'partId')::uuid; qty := coalesce(nullif(line->>'partQty','')::numeric,1);
   perform 1 from public.parts where id=pid for update;
   if not found then raise exception 'Linked part missing'; end if;
 end if;
 update public.jobs set lines=lines-p_index where id=p_job_id;
 if pid is not null then insert into public.stockmoves(part_id,qty,note) values(pid,qty,'Removed from job '||p_job_id::text); end if;
end $$;

create or replace function public.wolt_toggle_job_deleted(p_job_id uuid,p_restore boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare j public.jobs%rowtype; item jsonb; pid uuid; q numeric; existing_qty numeric;
begin
 if not public.wolt_is_owner() then raise exception 'Not authorized' using errcode='42501'; end if;
 select * into j from public.jobs where id=p_job_id for update;
 if not found then raise exception 'Job not found'; end if;
 if (j.deleted_at is null) = p_restore then raise exception 'Job already in requested state'; end if;
 -- Lock all referenced parts in stable order to prevent deadlocks.
 perform 1 from public.parts where id in
  (select (x->>'partId')::uuid from jsonb_array_elements(coalesce(j.lines,'[]'::jsonb)) x where x->>'type'='part' and nullif(x->>'partId','') is not null)
  order by id for update;
 for item in select x from jsonb_array_elements(coalesce(j.lines,'[]'::jsonb)) x where x->>'type'='part' and nullif(x->>'partId','') is not null loop
   pid:=(item->>'partId')::uuid; q:=coalesce(nullif(item->>'partQty','')::numeric,1);
   if p_restore then
     select coalesce(sum(qty),0) into existing_qty from public.stockmoves where part_id=pid;
     if existing_qty < q then raise exception 'Cannot restore: insufficient stock for part %',pid; end if;
   end if;
   insert into public.stockmoves(part_id,qty,note) values(pid, case when p_restore then -q else q end, case when p_restore then 'Job restored ' else 'Job deleted ' end||p_job_id::text);
 end loop;
 update public.jobs set deleted_at = case when p_restore then null else now() end where id=p_job_id;
end $$;

revoke all on function public.wolt_add_job_part(uuid,uuid,numeric,jsonb) from public,anon;
revoke all on function public.wolt_remove_job_line(uuid,integer) from public,anon;
revoke all on function public.wolt_toggle_job_deleted(uuid,boolean) from public,anon;
grant execute on function public.wolt_add_job_part(uuid,uuid,numeric,jsonb) to authenticated;
grant execute on function public.wolt_remove_job_line(uuid,integer) to authenticated;
grant execute on function public.wolt_toggle_job_deleted(uuid,boolean) to authenticated;
commit;
