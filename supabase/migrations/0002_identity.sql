-- =====================================================================
-- BJmeem 0002 — profiles, addresses, delivery zones, signup wiring
-- =====================================================================

-- ------------------------------------------------------------ profiles
create table public.profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  email           text not null,
  first_name      text,
  last_name       text,
  phone_number    text,
  date_of_birth   date,
  gender          text,
  avatar_url      text,
  role            public.user_role not null default 'customer',
  loyalty_points  integer not null default 0,
  loyalty_tier    text    not null default 'cozy',
  total_spent     numeric(12,3) not null default 0,
  total_orders    integer not null default 0,
  referral_code   text,
  referred_by     uuid references public.profiles(id) on delete set null,
  marketing_opt_in boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint profiles_gender_chk check (
    gender is null or gender in ('female','male','other','prefer_not_to_say')),
  constraint profiles_points_chk       check (loyalty_points >= 0),
  constraint profiles_total_spent_chk  check (total_spent >= 0),
  constraint profiles_total_orders_chk check (total_orders >= 0),
  -- Kuwait mobile numbers are 8 digits; allow an optional +965 and spacing.
  constraint profiles_phone_chk check (
    phone_number is null or phone_number ~ '^\+?[0-9][0-9 \-]{6,19}$'),
  -- Nobody is born in the future and nobody is 130.
  constraint profiles_dob_chk check (
    date_of_birth is null
    or (date_of_birth <= current_date and date_of_birth > current_date - interval '130 years'))
);

create unique index profiles_email_lower_idx on public.profiles (lower(email));
create unique index profiles_referral_code_idx on public.profiles (referral_code)
  where referral_code is not null;
create index profiles_role_idx on public.profiles (role);
create index profiles_dob_month_idx
  on public.profiles (extract(month from date_of_birth))
  where date_of_birth is not null;

create trigger profiles_touch
  before update on public.profiles
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------- role helpers
-- SECURITY DEFINER so they read profiles without tripping RLS. Without this
-- indirection, a policy on profiles that queries profiles recurses infinitely.
create or replace function public.auth_role()
returns public.user_role
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select role from public.profiles where id = auth.uid()),
    'customer'::public.user_role);
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.auth_role() = 'admin';
$$;

create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.auth_role() in ('admin','staff');
$$;

grant execute on function public.auth_role() to authenticated;
grant execute on function public.is_admin()  to authenticated;
grant execute on function public.is_staff()  to authenticated;

-- Column-level guard. RLS decides *which rows* you may write; this decides
-- *which columns*. Customers own their profile row but must not be able to
-- promote themselves to admin or mint loyalty points.
create or replace function public.enforce_profile_privileged_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Three legitimate callers:
  --   1. a SECURITY DEFINER routine that raised the privileged flag,
  --   2. an admin,
  --   3. no end-user session at all (service role, SQL editor, psql) — this is
  --      how the very first admin gets promoted. Not exploitable from the anon
  --      key because the RLS policy requires id = auth.uid() to reach the row.
  if coalesce(current_setting('bjmeem.privileged', true), 'off') = 'on'
     or auth.uid() is null
     or public.is_admin() then
    return new;
  end if;

  if new.role is distinct from old.role
     or new.loyalty_points is distinct from old.loyalty_points
     or new.loyalty_tier   is distinct from old.loyalty_tier
     or new.total_spent    is distinct from old.total_spent
     or new.total_orders   is distinct from old.total_orders
     or new.referral_code  is distinct from old.referral_code
     or new.referred_by    is distinct from old.referred_by
  then
    raise exception 'PRIVILEGED_COLUMN: role, loyalty and order totals are not user-writable'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

create trigger profiles_privileged_guard
  before update on public.profiles
  for each row execute function public.enforce_profile_privileged_columns();

-- ------------------------------------------------------ delivery zones
create table public.delivery_zones (
  id                      uuid primary key default gen_random_uuid(),
  name                    text not null,
  governorate             text not null,
  areas                   text[] not null default '{}',
  delivery_fee            numeric(12,3) not null default 1.500,
  estimated_min_hours     integer not null default 24,
  estimated_max_hours     integer not null default 72,
  free_delivery_threshold numeric(12,3),
  is_active               boolean not null default true,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint delivery_zones_fee_chk   check (delivery_fee >= 0),
  constraint delivery_zones_hours_chk check (
    estimated_min_hours >= 0 and estimated_max_hours >= estimated_min_hours),
  constraint delivery_zones_thresh_chk check (
    free_delivery_threshold is null or free_delivery_threshold >= 0)
);

create unique index delivery_zones_governorate_idx
  on public.delivery_zones (lower(governorate)) where is_active;

create trigger delivery_zones_touch
  before update on public.delivery_zones
  for each row execute function public.touch_updated_at();

-- ----------------------------------------------------------- addresses
create table public.addresses (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references public.profiles(id) on delete cascade,
  label                  public.address_label not null default 'home',
  full_name              text not null,
  phone_number           text not null,
  country                text not null default 'Kuwait',
  governorate            text not null,
  area                   text not null,
  block                  text not null,
  street                 text not null,
  avenue                 text,
  building_number        text not null,
  floor                  text,
  apartment              text,
  additional_directions  text,
  -- Coordinates are voluntary, submitted once per address to help the driver.
  -- This is not a tracking system: see docs/BACKEND_ARCHITECTURE.md §1.
  latitude               numeric(9,6),
  longitude              numeric(9,6),
  is_default             boolean not null default false,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint addresses_lat_chk check (latitude  is null or latitude  between -90  and 90),
  constraint addresses_lng_chk check (longitude is null or longitude between -180 and 180),
  constraint addresses_latlng_pair_chk check (
    (latitude is null) = (longitude is null)),
  constraint addresses_phone_chk check (phone_number ~ '^\+?[0-9][0-9 \-]{6,19}$')
);

create index addresses_user_idx on public.addresses (user_id);
-- At most one default per customer, enforced by the database rather than by hope.
create unique index addresses_one_default_idx
  on public.addresses (user_id) where is_default;

create trigger addresses_touch
  before update on public.addresses
  for each row execute function public.touch_updated_at();

-- Setting a new default silently clears the previous one.
create or replace function public.unset_other_default_addresses()
returns trigger
language plpgsql
as $$
begin
  if new.is_default then
    update public.addresses
       set is_default = false
     where user_id = new.user_id
       and id <> new.id
       and is_default;
  end if;
  return new;
end;
$$;

create trigger addresses_single_default
  before insert or update of is_default on public.addresses
  for each row when (new.is_default) execute function public.unset_other_default_addresses();

-- The customer's first address becomes the default automatically.
create or replace function public.first_address_is_default()
returns trigger
language plpgsql
as $$
begin
  if not exists (select 1 from public.addresses where user_id = new.user_id) then
    new.is_default := true;
  end if;
  return new;
end;
$$;

create trigger addresses_first_is_default
  before insert on public.addresses
  for each row execute function public.first_address_is_default();
