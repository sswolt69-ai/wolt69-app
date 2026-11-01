-- Wolt 69 — Supabase schema
-- Run this once in: Supabase project → SQL Editor → New query → paste → Run

create extension if not exists "uuid-ossp";

create table customers (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  phone text,
  created_at timestamptz not null default now()
);

create table vehicles (
  id uuid primary key default uuid_generate_v4(),
  customer_id uuid references customers(id) on delete cascade,
  reg_no text,
  model text,
  created_at timestamptz not null default now()
);

create table parts (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  cost numeric default 0,
  sale numeric default 0,
  min_qty numeric default 0,
  original boolean default true,
  brands text[] default '{}',
  created_at timestamptz not null default now()
);

create table stockmoves (
  id uuid primary key default uuid_generate_v4(),
  part_id uuid references parts(id) on delete cascade,
  qty numeric not null,
  note text,
  at timestamptz not null default now()
);

create table jobs (
  id uuid primary key default uuid_generate_v4(),
  customer_id uuid references customers(id),
  vehicle_id uuid references vehicles(id),
  status text default 'received',       -- received | in_progress | ready | delivered
  lines jsonb default '[]',             -- [{type,desc,amount,partId,partQty}]
  discount numeric default 0,
  advance numeric default 0,
  created_at timestamptz not null default now()
);

create table workers (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  pay_type text default 'fixed',        -- fixed | daily
  salary numeric default 0,
  wage_day numeric default 0,
  created_at timestamptz not null default now()
);

create table advances (
  id uuid primary key default uuid_generate_v4(),
  worker_id uuid references workers(id) on delete cascade,
  amount numeric not null,
  note text,
  at timestamptz not null default now()
);

create table attendance (
  id uuid primary key default uuid_generate_v4(),
  worker_id uuid references workers(id) on delete cascade,
  at timestamptz not null default now()
);

create table expenses (
  id uuid primary key default uuid_generate_v4(),
  description text,
  amount numeric not null,
  at timestamptz not null default now()
);

create table vendors (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  phone text,
  created_at timestamptz not null default now()
);

create table vendorentries (
  id uuid primary key default uuid_generate_v4(),
  vendor_id uuid references vendors(id) on delete cascade,
  type text,                            -- purchase | payment
  amount numeric not null,
  note text,
  at timestamptz not null default now()
);

create table notes (
  id uuid primary key default uuid_generate_v4(),
  text text not null,
  remind_at timestamptz,
  notified boolean default false,
  done boolean default false,
  created_at timestamptz not null default now()
);

-- Single-shop app: allow the shop's own logged-in device(s) full access.
-- We'll lock this to one shared login (your dad's account) rather than public access.
alter table customers enable row level security;
alter table vehicles enable row level security;
alter table parts enable row level security;
alter table stockmoves enable row level security;
alter table jobs enable row level security;
alter table workers enable row level security;
alter table advances enable row level security;
alter table attendance enable row level security;
alter table expenses enable row level security;
alter table vendors enable row level security;
alter table vendorentries enable row level security;
alter table notes enable row level security;

create policy "authenticated full access" on customers for all using (auth.role() = 'authenticated');
create policy "authenticated full access" on vehicles for all using (auth.role() = 'authenticated');
create policy "authenticated full access" on parts for all using (auth.role() = 'authenticated');
create policy "authenticated full access" on stockmoves for all using (auth.role() = 'authenticated');
create policy "authenticated full access" on jobs for all using (auth.role() = 'authenticated');
create policy "authenticated full access" on workers for all using (auth.role() = 'authenticated');
create policy "authenticated full access" on advances for all using (auth.role() = 'authenticated');
create policy "authenticated full access" on attendance for all using (auth.role() = 'authenticated');
create policy "authenticated full access" on expenses for all using (auth.role() = 'authenticated');
create policy "authenticated full access" on vendors for all using (auth.role() = 'authenticated');
create policy "authenticated full access" on vendorentries for all using (auth.role() = 'authenticated');
create policy "authenticated full access" on notes for all using (auth.role() = 'authenticated');
