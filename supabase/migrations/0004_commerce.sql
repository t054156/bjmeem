-- =====================================================================
-- BJmeem 0004 — carts, wishlist, coupons
-- =====================================================================

create table public.carts (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null unique references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger carts_touch
  before update on public.carts
  for each row execute function public.touch_updated_at();

create table public.cart_items (
  id         uuid primary key default gen_random_uuid(),
  cart_id    uuid not null references public.carts(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  variant_id uuid not null references public.product_variants(id) on delete cascade,
  quantity   integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint cart_items_qty_chk check (quantity > 0 and quantity <= 20),
  -- Adding the same variant twice increments instead of duplicating.
  constraint cart_items_unique_variant unique (cart_id, variant_id)
);

create index cart_items_cart_idx on public.cart_items (cart_id);

create trigger cart_items_touch
  before update on public.cart_items
  for each row execute function public.touch_updated_at();

-- The variant must actually belong to the product it is filed under.
create or replace function public.assert_variant_matches_product()
returns trigger
language plpgsql
as $$
declare v_product uuid;
begin
  select product_id into v_product from public.product_variants where id = new.variant_id;
  if v_product is null then
    raise exception 'VARIANT_NOT_FOUND' using errcode = '23503';
  end if;
  new.product_id := v_product;   -- authoritative, ignores whatever the client sent
  return new;
end;
$$;

create trigger cart_items_variant_matches
  before insert or update of variant_id on public.cart_items
  for each row execute function public.assert_variant_matches_product();

-- ------------------------------------------------------------ wishlist
create table public.wishlist_items (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  created_at timestamptz not null default now(),

  constraint wishlist_unique unique (user_id, product_id)
);

create index wishlist_user_idx on public.wishlist_items (user_id);

-- ------------------------------------------------------------- coupons
create table public.coupons (
  id                   uuid primary key default gen_random_uuid(),
  code                 text not null,
  description          text,
  discount_type        public.discount_type not null,
  discount_value       numeric(12,3) not null default 0,
  minimum_order_amount numeric(12,3) not null default 0,
  maximum_discount     numeric(12,3),
  usage_limit          integer,
  usage_per_customer   integer not null default 1,
  usage_count          integer not null default 0,
  first_order_only     boolean not null default false,
  -- Gating: null means "everyone". Otherwise the customer's tier must be listed.
  allowed_tiers        text[],
  loyalty_members_only boolean not null default false,
  starts_at            timestamptz not null default now(),
  expires_at           timestamptz,
  is_active            boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint coupons_value_chk    check (discount_value >= 0),
  constraint coupons_pct_chk      check (
    discount_type <> 'percentage' or discount_value <= 100),
  constraint coupons_min_chk      check (minimum_order_amount >= 0),
  constraint coupons_max_chk      check (maximum_discount is null or maximum_discount >= 0),
  constraint coupons_limit_chk    check (usage_limit is null or usage_limit > 0),
  constraint coupons_per_cust_chk check (usage_per_customer > 0),
  constraint coupons_window_chk   check (expires_at is null or expires_at > starts_at)
);

create unique index coupons_code_idx on public.coupons (upper(code));
create index coupons_active_idx on public.coupons (is_active, starts_at, expires_at);

create trigger coupons_touch
  before update on public.coupons
  for each row execute function public.touch_updated_at();

-- Normalise codes so WELCOME10 and welcome10 are the same coupon.
create or replace function public.normalise_coupon_code()
returns trigger
language plpgsql
as $$
begin
  new.code := upper(trim(new.code));
  return new;
end;
$$;

create trigger coupons_normalise
  before insert or update of code on public.coupons
  for each row execute function public.normalise_coupon_code();

create table public.coupon_redemptions (
  id              uuid primary key default gen_random_uuid(),
  coupon_id       uuid not null references public.coupons(id) on delete cascade,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  order_id        uuid,                       -- FK added in 0005 once orders exists
  discount_amount numeric(12,3) not null default 0,
  redeemed_at     timestamptz not null default now(),

  constraint coupon_redemptions_amount_chk check (discount_amount >= 0)
);

create index coupon_redemptions_coupon_idx on public.coupon_redemptions (coupon_id);
create index coupon_redemptions_user_idx   on public.coupon_redemptions (user_id);
-- One redemption row per order, so a retry cannot double-count usage.
create unique index coupon_redemptions_order_idx
  on public.coupon_redemptions (order_id) where order_id is not null;
