-- =====================================================================
-- BJmeem 0001 — core types, settings, helpers
-- Money is numeric(12,3): the Kuwaiti Dinar has three decimal places.
-- =====================================================================

-- ---------------------------------------------------------------- enums
create type public.user_role         as enum ('customer','staff','admin');

create type public.order_status      as enum (
  'pending','confirmed','preparing','packed','out_for_delivery',
  'delivered','cancelled','returned','refunded');

create type public.payment_status    as enum ('unpaid','paid','refunded','failed');
create type public.payment_method    as enum ('cod','knet','card');
create type public.discount_type     as enum ('percentage','fixed','free_delivery');
create type public.address_label     as enum ('home','work','other');
create type public.review_status     as enum ('pending','approved','rejected');
create type public.referral_status   as enum ('pending','qualified','rewarded','void');
create type public.notification_type as enum ('order','loyalty','coupon','system','marketing');
create type public.reward_type       as enum ('fixed_discount','percentage_discount','free_delivery');

-- 'expiry' is not in the original spec list but point expiration needs a
-- ledger entry type of its own; everything else matches the spec.
create type public.loyalty_txn_type  as enum (
  'earn','redeem','bonus','refund_adjustment','manual_adjustment',
  'birthday_bonus','signup_bonus','referral_bonus','expiry');

-- ------------------------------------------------------------- settings
-- Every tunable business rule lives here so it can change without a deploy.
create table public.app_settings (
  key         text primary key,
  value       jsonb not null,
  description text,
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);
comment on table public.app_settings is
  'Configurable business rules. Read via public.setting(). Admin-writable only.';

create or replace function public.setting(p_key text, p_default jsonb default null)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select value from public.app_settings where key = p_key), p_default);
$$;

create or replace function public.setting_numeric(p_key text, p_default numeric)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((public.setting(p_key) #>> '{}')::numeric, p_default);
$$;

-- Role helpers (auth_role / is_admin / is_staff) live in 0002, immediately
-- after public.profiles exists — Postgres validates SQL function bodies at
-- creation time, so they cannot be declared before the table they read.

-- --------------------------------------------------------- updated_at
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ------------------------------------------------- human order numbers
-- A counter table rather than a sequence: order numbers restart each year and
-- must have no gaps that would confuse customer service.
create table public.order_counters (
  year        integer primary key,
  last_number integer not null default 0
);

create or replace function public.next_order_number()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_year integer := extract(year from (now() at time zone 'Asia/Kuwait'))::integer;
  v_n    integer;
begin
  -- Atomic: concurrent checkouts serialise on the primary-key row.
  insert into public.order_counters (year, last_number)
  values (v_year, 1)
  on conflict (year) do update
    set last_number = public.order_counters.last_number + 1
  returning last_number into v_n;

  return 'BJ-' || v_year::text || '-' || lpad(v_n::text, 6, '0');
end;
$$;

-- Public-facing loyalty member number (never the UUID).
create sequence public.loyalty_member_seq start with 10001;

grant execute on function public.setting(text, jsonb)           to anon, authenticated;
grant execute on function public.setting_numeric(text, numeric) to anon, authenticated;
