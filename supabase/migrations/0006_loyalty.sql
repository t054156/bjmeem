-- =====================================================================
-- BJmeem 0006 — Cozy Club: tiers, accounts, ledger, rewards, referrals
--
-- The ledger (loyalty_transactions) is the source of truth.
-- points_balance / lifetime_points on loyalty_accounts are a maintained cache.
-- =====================================================================

create table public.loyalty_tiers (
  id             uuid primary key default gen_random_uuid(),
  code           text not null unique,
  name           text not null,
  min_points     integer not null,
  max_points     integer,                     -- null = open-ended top tier
  benefits       jsonb not null default '[]'::jsonb,
  points_multiplier numeric(4,2) not null default 1.00,
  badge_color    text,
  sort_order     integer not null default 0,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint loyalty_tiers_min_chk   check (min_points >= 0),
  constraint loyalty_tiers_range_chk check (max_points is null or max_points >= min_points),
  constraint loyalty_tiers_mult_chk  check (points_multiplier > 0)
);

create trigger loyalty_tiers_touch
  before update on public.loyalty_tiers
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------- loyalty accounts
create table public.loyalty_accounts (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null unique references public.profiles(id) on delete cascade,
  -- Public-facing card number. Never expose the UUID on the card.
  member_number  text not null unique,
  points_balance integer not null default 0,
  lifetime_points integer not null default 0,
  loyalty_tier   text not null default 'cozy' references public.loyalty_tiers(code)
                   on update cascade on delete set default,
  joined_at      timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint loyalty_accounts_balance_chk  check (points_balance >= 0),
  constraint loyalty_accounts_lifetime_chk check (lifetime_points >= 0)
);

create index loyalty_accounts_tier_idx on public.loyalty_accounts (loyalty_tier);

create trigger loyalty_accounts_touch
  before update on public.loyalty_accounts
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------ loyalty transactions
create table public.loyalty_transactions (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles(id) on delete cascade,
  order_id         uuid references public.orders(id) on delete set null,
  transaction_type public.loyalty_txn_type not null,
  points           integer not null,          -- positive = credit, negative = debit
  description      text not null,
  balance_after    integer,
  earned_at        timestamptz not null default now(),
  expires_at       timestamptz,               -- only meaningful on credits
  expired          boolean not null default false,
  created_by       uuid references public.profiles(id) on delete set null,
  created_at       timestamptz not null default now(),

  constraint loyalty_txn_nonzero_chk check (points <> 0),
  -- Credits carry an expiry, debits never do.
  constraint loyalty_txn_expiry_chk check (
    (points > 0) or (expires_at is null))
);

create index loyalty_txn_user_idx    on public.loyalty_transactions (user_id, created_at desc);
create index loyalty_txn_order_idx   on public.loyalty_transactions (order_id);
create index loyalty_txn_type_idx    on public.loyalty_transactions (transaction_type);
-- Drives the nightly expiry sweep.
create index loyalty_txn_expiry_idx  on public.loyalty_transactions (expires_at)
  where points > 0 and not expired;
-- One earn row per order: a replayed trigger cannot double-credit.
create unique index loyalty_txn_one_earn_per_order
  on public.loyalty_transactions (order_id)
  where transaction_type = 'earn' and order_id is not null;

-- ------------------------------------------------------------ rewards
create table public.loyalty_rewards (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  description    text,
  points_required integer not null,
  reward_type    public.reward_type not null default 'fixed_discount',
  reward_value   numeric(12,3) not null default 0,
  min_tier       text references public.loyalty_tiers(code) on update cascade,
  is_active      boolean not null default true,
  sort_order     integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint rewards_points_chk check (points_required > 0),
  constraint rewards_value_chk  check (reward_value >= 0)
);

create trigger loyalty_rewards_touch
  before update on public.loyalty_rewards
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------- referrals
create table public.referrals (
  id                uuid primary key default gen_random_uuid(),
  referrer_user_id  uuid not null references public.profiles(id) on delete cascade,
  referred_user_id  uuid references public.profiles(id) on delete set null,
  referral_code     text not null,
  status            public.referral_status not null default 'pending',
  reward_given      boolean not null default false,
  qualifying_order_id uuid references public.orders(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- You cannot refer yourself.
  constraint referrals_no_self_chk check (
    referred_user_id is null or referred_user_id <> referrer_user_id)
);

-- A person can only ever be referred once.
create unique index referrals_one_per_referred_idx
  on public.referrals (referred_user_id) where referred_user_id is not null;
create index referrals_referrer_idx on public.referrals (referrer_user_id);
create index referrals_code_idx     on public.referrals (upper(referral_code));

create trigger referrals_touch
  before update on public.referrals
  for each row execute function public.touch_updated_at();

-- ------------------------------------- balance cache + tier maintenance
-- Recomputes the cached balance from the ledger after every transaction.
create or replace function public.apply_loyalty_transaction()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance  integer;
  v_lifetime integer;
  v_tier     text;
begin
  -- Lifetime drives the tier. Credits raise it; refund adjustments claw it back,
  -- so a buy-then-refund cycle cannot strand someone in an unearned tier.
  select
    coalesce(sum(points), 0),
    greatest(
      coalesce(sum(points) filter (where points > 0), 0)
        - coalesce(sum(abs(points)) filter (where transaction_type = 'refund_adjustment'), 0),
      0)
  into v_balance, v_lifetime
  from public.loyalty_transactions
  where user_id = new.user_id;

  if v_balance < 0 then
    raise exception 'INSUFFICIENT_POINTS: balance would fall below zero'
      using errcode = '23514';
  end if;

  -- Tier is driven by lifetime points and the configurable thresholds.
  select code into v_tier
  from public.loyalty_tiers
  where is_active
    and v_lifetime >= min_points
    and (max_points is null or v_lifetime <= max_points)
  order by min_points desc
  limit 1;

  v_tier := coalesce(v_tier, 'cozy');

  update public.loyalty_accounts
     set points_balance  = v_balance,
         lifetime_points = v_lifetime,
         loyalty_tier    = v_tier
   where user_id = new.user_id;

  -- Mirror onto profiles for cheap reads on the storefront header, and stamp the
  -- running balance onto the ledger row. Both writes are guarded by triggers, so
  -- raise the privileged flag for the duration.
  perform set_config('bjmeem.privileged', 'on', true);

  update public.profiles
     set loyalty_points = v_balance,
         loyalty_tier   = v_tier
   where id = new.user_id;

  update public.loyalty_transactions
     set balance_after = v_balance
   where id = new.id;

  perform set_config('bjmeem.privileged', 'off', true);

  return new;
end;
$$;

create trigger loyalty_txn_apply
  after insert on public.loyalty_transactions
  for each row execute function public.apply_loyalty_transaction();

-- The ledger is append-only. Corrections are new compensating rows.
create or replace function public.loyalty_ledger_is_append_only()
returns trigger
language plpgsql
as $$
begin
  -- The expiry sweep is allowed to flip the `expired` flag and nothing else.
  if tg_op = 'UPDATE'
     and coalesce(current_setting('bjmeem.privileged', true), 'off') = 'on'
     and new.points = old.points
     and new.user_id = old.user_id
     and new.transaction_type = old.transaction_type then
    return new;
  end if;
  raise exception 'LEDGER_APPEND_ONLY: loyalty transactions cannot be modified or deleted'
    using errcode = '42501';
end;
$$;

create trigger loyalty_txn_immutable
  before update or delete on public.loyalty_transactions
  for each row execute function public.loyalty_ledger_is_append_only();
