-- LC2-06A — Production Host Settlement Persistence
-- Run in the Supabase SQL Editor.
-- Service-role server access only; RLS remains enabled.

begin;

create table if not exists public.agv_host_balance_ledger (
  record_id text primary key,
  record_type text not null
    check (record_type in ('ACCOUNT', 'ENTRY')),
  host_id text not null,
  idempotency_key text,
  entry_type text,
  balance_bucket text,
  source_type text,
  source_id text,
  amount_cents bigint,
  status text,
  settlement_id text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists agv_host_balance_ledger_host_account_uidx
  on public.agv_host_balance_ledger (host_id)
  where record_type = 'ACCOUNT';

create unique index if not exists agv_host_balance_ledger_idempotency_uidx
  on public.agv_host_balance_ledger (idempotency_key)
  where record_type = 'ENTRY' and idempotency_key is not null;

create index if not exists agv_host_balance_ledger_host_idx
  on public.agv_host_balance_ledger (host_id);

create index if not exists agv_host_balance_ledger_created_idx
  on public.agv_host_balance_ledger (created_at desc);

create index if not exists agv_host_balance_ledger_source_idx
  on public.agv_host_balance_ledger (source_type, source_id);

create table if not exists public.agv_host_settlements (
  settlement_id text primary key,
  idempotency_key text not null unique,
  host_id text not null,
  settlement_type text not null
    check (settlement_type in ('PENDING_TO_AVAILABLE', 'HOST_PAYOUT')),
  settlement_method text,
  amount_cents bigint not null
    check (amount_cents > 0),
  source_id text not null,
  external_reference text,
  status text not null,
  note text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  paid_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists agv_host_settlements_host_idx
  on public.agv_host_settlements (host_id);

create index if not exists agv_host_settlements_created_idx
  on public.agv_host_settlements (created_at desc);

create index if not exists agv_host_settlements_source_idx
  on public.agv_host_settlements (source_id);

create index if not exists agv_host_settlements_status_idx
  on public.agv_host_settlements (status);

alter table public.agv_host_balance_ledger enable row level security;
alter table public.agv_host_settlements enable row level security;

revoke all on table public.agv_host_balance_ledger from anon, authenticated;
revoke all on table public.agv_host_settlements from anon, authenticated;

grant all on table public.agv_host_balance_ledger to service_role;
grant all on table public.agv_host_settlements to service_role;

commit;
