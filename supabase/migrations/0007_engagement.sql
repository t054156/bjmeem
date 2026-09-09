-- =====================================================================
-- BJmeem 0007 — notifications, reviews, audit log, email outbox
-- =====================================================================

create table public.notifications (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  title        text not null,
  message      text not null,
  type         public.notification_type not null default 'system',
  reference_id uuid,
  action_url   text,
  is_read      boolean not null default false,
  created_at   timestamptz not null default now()
);

create index notifications_user_idx on public.notifications (user_id, created_at desc);
create index notifications_unread_idx on public.notifications (user_id) where not is_read;

-- ------------------------------------------------------------ reviews
create table public.product_reviews (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references public.profiles(id) on delete cascade,
  product_id           uuid not null references public.products(id) on delete cascade,
  order_id             uuid references public.orders(id) on delete set null,
  rating               integer not null,
  title                text,
  review_text          text,
  is_verified_purchase boolean not null default false,
  status               public.review_status not null default 'pending',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint reviews_rating_chk check (rating between 1 and 5),
  -- One review per customer per product.
  constraint reviews_unique unique (user_id, product_id)
);

create index reviews_product_idx on public.product_reviews (product_id, status);
create index reviews_user_idx    on public.product_reviews (user_id);

create trigger product_reviews_touch
  before update on public.product_reviews
  for each row execute function public.touch_updated_at();

-- Verified-purchase status is derived, never accepted from the client.
create or replace function public.set_review_verification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_order uuid;
begin
  select o.id into v_order
  from public.orders o
  join public.order_items oi on oi.order_id = o.id
  where o.user_id = new.user_id
    and oi.product_id = new.product_id
    and o.order_status = 'delivered'
  order by o.delivered_at desc nulls last
  limit 1;

  new.is_verified_purchase := v_order is not null;
  new.order_id := v_order;
  -- Verified buyers publish immediately; everyone else waits for moderation.
  if not public.is_staff() then
    new.status := case when v_order is not null then 'approved' else 'pending' end;
  end if;
  return new;
end;
$$;

create trigger product_reviews_verify
  before insert on public.product_reviews
  for each row execute function public.set_review_verification();

-- Keep the denormalised rating on products in step with approved reviews.
create or replace function public.refresh_product_rating()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product uuid := coalesce(new.product_id, old.product_id);
  v_avg numeric(3,2);
  v_cnt integer;
begin
  select round(coalesce(avg(rating), 0)::numeric, 2), count(*)
  into v_avg, v_cnt
  from public.product_reviews
  where product_id = v_product and status = 'approved';

  update public.products
     set rating_average = v_avg,
         rating_count   = v_cnt
   where id = v_product;

  return null;
end;
$$;

create trigger product_reviews_rating
  after insert or update or delete on public.product_reviews
  for each row execute function public.refresh_product_rating();

-- ---------------------------------------------------------- audit log
create table public.audit_logs (
  id         uuid primary key default gen_random_uuid(),
  actor_id   uuid references public.profiles(id) on delete set null,
  actor_role public.user_role,
  action     text not null,
  entity     text not null,
  entity_id  uuid,
  old_data   jsonb,
  new_data   jsonb,
  ip_address inet,
  created_at timestamptz not null default now()
);

create index audit_logs_entity_idx  on public.audit_logs (entity, entity_id, created_at desc);
create index audit_logs_actor_idx   on public.audit_logs (actor_id, created_at desc);
create index audit_logs_created_idx on public.audit_logs (created_at desc);

create or replace function public.write_audit(
  p_action text,
  p_entity text,
  p_entity_id uuid,
  p_old jsonb default null,
  p_new jsonb default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.audit_logs (actor_id, actor_role, action, entity, entity_id, old_data, new_data)
  values (auth.uid(), public.auth_role(), p_action, p_entity, p_entity_id, p_old, p_new);
end;
$$;

-- Generic audit trigger for admin-sensitive tables.
create or replace function public.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end;
  v_new jsonb := case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end;
  v_id  uuid;
begin
  -- Not every audited table is keyed on a uuid `id` (app_settings is keyed on
  -- `key`), so resolve it defensively instead of assuming the column exists.
  begin
    v_id := coalesce(v_new ->> 'id', v_old ->> 'id')::uuid;
  exception when others then
    v_id := null;
  end;

  insert into public.audit_logs (actor_id, actor_role, action, entity, entity_id, old_data, new_data)
  values (auth.uid(), public.auth_role(), lower(tg_op), tg_table_name, v_id, v_old, v_new);
  return null;
end;
$$;

create trigger audit_products
  after insert or update or delete on public.products
  for each row execute function public.audit_row_change();

create trigger audit_variants
  after update or delete on public.product_variants
  for each row execute function public.audit_row_change();

create trigger audit_coupons
  after insert or update or delete on public.coupons
  for each row execute function public.audit_row_change();

create trigger audit_tiers
  after insert or update or delete on public.loyalty_tiers
  for each row execute function public.audit_row_change();

create trigger audit_settings
  after insert or update or delete on public.app_settings
  for each row execute function public.audit_row_change();

-- ------------------------------------------------------- email outbox
-- Triggers enqueue here; the process-email-queue Edge Function drains it.
-- Keeping the provider call out of the transaction means a flaky mail API can
-- never roll back an order.
create table public.email_queue (
  id           uuid primary key default gen_random_uuid(),
  to_email     text not null,
  to_name      text,
  template     text not null,
  subject      text not null,
  payload      jsonb not null default '{}'::jsonb,
  status       text not null default 'pending',
  attempts     integer not null default 0,
  last_error   text,
  scheduled_at timestamptz not null default now(),
  sent_at      timestamptz,
  created_at   timestamptz not null default now(),

  constraint email_queue_status_chk check (status in ('pending','sending','sent','failed')),
  constraint email_queue_attempts_chk check (attempts >= 0)
);

create index email_queue_pending_idx
  on public.email_queue (scheduled_at)
  where status = 'pending';

create or replace function public.enqueue_email(
  p_to_email text,
  p_to_name  text,
  p_template text,
  p_subject  text,
  p_payload  jsonb default '{}'::jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_id uuid;
begin
  if p_to_email is null or p_to_email = '' then
    return null;
  end if;
  insert into public.email_queue (to_email, to_name, template, subject, payload)
  values (p_to_email, p_to_name, p_template, p_subject, coalesce(p_payload, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end;
$$;
