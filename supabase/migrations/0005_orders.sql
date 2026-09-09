-- =====================================================================
-- BJmeem 0005 — orders, items, status history, admin notes
-- =====================================================================

create table public.orders (
  id                   uuid primary key default gen_random_uuid(),
  order_number         text not null unique,
  user_id              uuid references public.profiles(id) on delete set null,
  address_id           uuid references public.addresses(id) on delete set null,

  -- Snapshot of the customer and destination as they were at purchase time.
  -- The address row may later be edited or deleted; the order must not change.
  customer_name        text not null,
  customer_email       text not null,
  customer_phone       text not null,
  shipping_address     jsonb not null default '{}'::jsonb,

  subtotal             numeric(12,3) not null default 0,
  discount_amount      numeric(12,3) not null default 0,
  delivery_fee         numeric(12,3) not null default 0,
  tax_amount           numeric(12,3) not null default 0,
  loyalty_discount     numeric(12,3) not null default 0,
  total_amount         numeric(12,3) not null default 0,

  payment_method       public.payment_method not null default 'cod',
  payment_status       public.payment_status not null default 'unpaid',
  order_status         public.order_status   not null default 'pending',

  coupon_code          text,
  loyalty_points_earned integer not null default 0,
  loyalty_points_used   integer not null default 0,
  customer_notes       text,

  -- Optional courier fields, populated by staff when a delivery is dispatched.
  courier_name            text,
  courier_phone           text,
  tracking_reference      text,
  estimated_delivery_time timestamptz,

  delivered_at         timestamptz,
  cancelled_at         timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint orders_subtotal_chk  check (subtotal         >= 0),
  constraint orders_discount_chk  check (discount_amount  >= 0),
  constraint orders_delivery_chk  check (delivery_fee     >= 0),
  constraint orders_tax_chk       check (tax_amount       >= 0),
  constraint orders_loyalty_chk   check (loyalty_discount >= 0),
  constraint orders_total_chk     check (total_amount     >= 0),
  constraint orders_points_chk    check (
    loyalty_points_earned >= 0 and loyalty_points_used >= 0),
  -- The arithmetic must hold. A bug that mangles a total fails loudly here
  -- instead of quietly charging the wrong amount.
  constraint orders_total_math_chk check (
    total_amount = round(
      subtotal - discount_amount - loyalty_discount + delivery_fee + tax_amount, 3)),
  constraint orders_discount_le_subtotal_chk check (
    discount_amount + loyalty_discount <= subtotal)
);

create index orders_user_idx        on public.orders (user_id, created_at desc);
create index orders_status_idx      on public.orders (order_status, created_at desc);
create index orders_created_idx     on public.orders (created_at desc);
create index orders_email_idx       on public.orders (lower(customer_email));
create index orders_payment_idx     on public.orders (payment_status);
create index orders_number_idx      on public.orders (upper(order_number));

create trigger orders_touch
  before update on public.orders
  for each row execute function public.touch_updated_at();

-- Deferred FK from 0004 now that orders exists.
alter table public.coupon_redemptions
  add constraint coupon_redemptions_order_fk
  foreign key (order_id) references public.orders(id) on delete cascade;

-- --------------------------------------------------------- order items
create table public.order_items (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references public.orders(id) on delete cascade,
  -- Nullable on purpose: a product may be deleted years later, the order stays.
  product_id   uuid references public.products(id) on delete set null,
  variant_id   uuid references public.product_variants(id) on delete set null,

  -- Snapshot. Never join back to products to render a historical order.
  product_name text not null,
  product_slug text,
  image_url    text,
  size         text not null,
  color        text not null,
  sku          text,
  quantity     integer not null,
  unit_price   numeric(12,3) not null,
  total_price  numeric(12,3) not null,
  created_at   timestamptz not null default now(),

  constraint order_items_qty_chk   check (quantity > 0),
  constraint order_items_price_chk check (unit_price >= 0),
  constraint order_items_total_chk check (total_price = round(unit_price * quantity, 3))
);

create index order_items_order_idx   on public.order_items (order_id);
create index order_items_product_idx on public.order_items (product_id);
create index order_items_variant_idx on public.order_items (variant_id);

-- ------------------------------------------------- order status history
create table public.order_status_history (
  id         uuid primary key default gen_random_uuid(),
  order_id   uuid not null references public.orders(id) on delete cascade,
  status     public.order_status not null,
  note       text,
  changed_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index order_status_history_order_idx
  on public.order_status_history (order_id, created_at);

-- ---------------------------------------------------- internal notes
-- Never exposed to customers. RLS in 0009 restricts this to staff/admin.
create table public.order_admin_notes (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references public.orders(id) on delete cascade,
  admin_user_id uuid references public.profiles(id) on delete set null,
  note          text not null,
  created_at    timestamptz not null default now()
);

create index order_admin_notes_order_idx on public.order_admin_notes (order_id, created_at desc);

-- ------------------------------------------------- customer write guard
-- Customers can read their orders but must not alter money or status.
create or replace function public.orders_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Same carve-out as profiles: privileged routine, staff, or no end-user
  -- session (service role / back-office SQL).
  if coalesce(current_setting('bjmeem.privileged', true), 'off') = 'on'
     or auth.uid() is null
     or public.is_staff() then
    return new;
  end if;

  raise exception 'ORDER_READONLY: use cancel_my_order() to cancel an order'
    using errcode = '42501';
end;
$$;

create trigger orders_customer_guard
  before update or delete on public.orders
  for each row execute function public.orders_guard();
