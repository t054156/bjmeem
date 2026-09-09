-- =====================================================================
-- BJmeem 0003 — categories, products, variants, images
-- =====================================================================

create table public.categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique,
  description text,
  image_url   text,
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index categories_active_idx on public.categories (is_active, sort_order);

create trigger categories_touch
  before update on public.categories
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------ products
create table public.products (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  slug             text not null unique,
  description      text,
  category_id      uuid references public.categories(id) on delete set null,
  price            numeric(12,3) not null,
  compare_at_price numeric(12,3),
  cost_price       numeric(12,3),
  material         text,
  fabric           text,
  pattern          text,
  care_instructions text,
  is_active        boolean not null default true,
  is_featured      boolean not null default false,
  is_new_arrival   boolean not null default false,
  is_best_seller   boolean not null default false,
  rating_average   numeric(3,2) not null default 0,
  rating_count     integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint products_price_chk      check (price >= 0),
  constraint products_compare_chk    check (compare_at_price is null or compare_at_price >= price),
  constraint products_cost_chk       check (cost_price is null or cost_price >= 0),
  constraint products_rating_chk     check (rating_average between 0 and 5),
  constraint products_rating_cnt_chk check (rating_count >= 0)
);

create index products_category_idx    on public.products (category_id) where is_active;
create index products_active_idx      on public.products (is_active);
create index products_new_idx         on public.products (is_new_arrival) where is_active;
create index products_best_idx        on public.products (is_best_seller)  where is_active;
create index products_price_idx       on public.products (price)           where is_active;
create index products_created_idx     on public.products (created_at desc);
-- Full-text search over name + description, used by getProducts({ search }).
create index products_search_idx on public.products
  using gin (to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(description,'')));

create trigger products_touch
  before update on public.products
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------- product variants
create table public.product_variants (
  id                uuid primary key default gen_random_uuid(),
  product_id        uuid not null references public.products(id) on delete cascade,
  size              text not null,
  color             text not null,
  sku               text not null unique,
  stock_quantity    integer not null default 0,
  reserved_quantity integer not null default 0,
  price_override    numeric(12,3),
  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint variants_stock_chk    check (stock_quantity >= 0),
  constraint variants_reserved_chk check (reserved_quantity >= 0),
  -- Overselling is made structurally impossible, not merely unlikely.
  constraint variants_reserve_le_stock_chk check (reserved_quantity <= stock_quantity),
  constraint variants_price_chk    check (price_override is null or price_override >= 0),
  constraint variants_unique_combo unique (product_id, size, color)
);

create index variants_product_idx on public.product_variants (product_id);
create index variants_active_idx  on public.product_variants (product_id, is_active);
create index variants_low_stock_idx
  on public.product_variants ((stock_quantity - reserved_quantity))
  where is_active;

create trigger variants_touch
  before update on public.product_variants
  for each row execute function public.touch_updated_at();

-- Convenience view of sellable stock.
create or replace view public.v_variant_availability as
  select
    pv.id            as variant_id,
    pv.product_id,
    pv.size,
    pv.color,
    pv.sku,
    pv.is_active,
    pv.stock_quantity,
    pv.reserved_quantity,
    (pv.stock_quantity - pv.reserved_quantity) as available_quantity,
    coalesce(pv.price_override, p.price)       as effective_price
  from public.product_variants pv
  join public.products p on p.id = pv.product_id;

-- ------------------------------------------------------ product images
create table public.product_images (
  id         uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  image_url  text not null,
  alt_text   text,
  sort_order integer not null default 0,
  is_primary boolean not null default false,
  created_at timestamptz not null default now()
);

create index product_images_product_idx on public.product_images (product_id, sort_order);
create unique index product_images_one_primary_idx
  on public.product_images (product_id) where is_primary;

create or replace function public.unset_other_primary_images()
returns trigger
language plpgsql
as $$
begin
  if new.is_primary then
    update public.product_images
       set is_primary = false
     where product_id = new.product_id
       and id <> new.id
       and is_primary;
  end if;
  return new;
end;
$$;

create trigger product_images_single_primary
  before insert or update of is_primary on public.product_images
  for each row when (new.is_primary) execute function public.unset_other_primary_images();
