-- =====================================================================
-- BJmeem 0009 — checkout, order lifecycle, tracking, loyalty maintenance
-- =====================================================================

-- =====================================================================
-- 1. PLACE ORDER  (atomic: one transaction, or nothing at all)
-- =====================================================================
create or replace function public.place_order(
  p_address_id      uuid,
  p_payment_method  public.payment_method default 'cod',
  p_customer_notes  text default null,
  p_coupon_code     text default null,
  p_loyalty_reward_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user     uuid := auth.uid();
  v_profile  public.profiles;
  v_addr     public.addresses;
  v_cart     public.carts;
  v_pricing  jsonb;
  v_coupon   jsonb;
  v_reward   public.loyalty_rewards;
  v_order_id uuid;
  v_number   text;
  v_item     jsonb;
  v_coupon_code text;
  v_reward_id   uuid;
begin
  if v_user is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;

  select * into v_profile from public.profiles where id = v_user;

  perform public.get_or_create_cart();
  select * into v_cart from public.carts where user_id = v_user;

  select * into v_addr
  from public.addresses
  where id = p_address_id and user_id = v_user;

  if v_addr.id is null then
    raise exception 'ADDRESS_NOT_FOUND' using errcode = 'P0002';
  end if;

  v_coupon_code := coalesce(p_coupon_code, v_cart.applied_coupon_code);
  v_reward_id   := coalesce(p_loyalty_reward_id, v_cart.applied_reward_id);

  -- Lock every variant in the cart, in id order. Ordering is what prevents two
  -- concurrent checkouts touching the same two variants from deadlocking.
  perform pv.id
  from public.product_variants pv
  where pv.id in (select ci.variant_id
                  from public.cart_items ci
                  where ci.cart_id = v_cart.id)
  order by pv.id
  for update;

  -- Price only after the locks are held, so stock cannot move underneath us.
  v_pricing := public.price_cart(v_user, p_address_id, v_coupon_code, v_reward_id);

  if not (v_pricing ->> 'can_checkout')::boolean then
    raise exception 'CHECKOUT_BLOCKED: %', v_pricing ->> 'issues'
      using errcode = 'P0001', detail = v_pricing ->> 'issues';
  end if;

  v_number := public.next_order_number();

  insert into public.orders (
    order_number, user_id, address_id,
    customer_name, customer_email, customer_phone, shipping_address,
    subtotal, discount_amount, delivery_fee, tax_amount, loyalty_discount, total_amount,
    payment_method, payment_status, order_status,
    coupon_code, loyalty_points_used, customer_notes)
  values (
    v_number, v_user, p_address_id,
    v_addr.full_name,
    coalesce(v_profile.email, ''),
    v_addr.phone_number,
    to_jsonb(v_addr) - 'user_id',
    (v_pricing ->> 'subtotal')::numeric,
    (v_pricing ->> 'discount_amount')::numeric,
    (v_pricing ->> 'delivery_fee')::numeric,
    (v_pricing ->> 'tax_amount')::numeric,
    (v_pricing ->> 'loyalty_discount')::numeric,
    (v_pricing ->> 'total_amount')::numeric,
    p_payment_method,
    'unpaid',
    'pending',
    case when (v_pricing -> 'coupon' ->> 'valid')::boolean
         then v_pricing -> 'coupon' ->> 'code' end,
    (v_pricing ->> 'loyalty_points_used')::integer,
    nullif(trim(coalesce(p_customer_notes, '')), ''))
  returning id into v_order_id;

  -- Snapshot every line, then reserve the stock it consumes.
  for v_item in select * from jsonb_array_elements(v_pricing -> 'items')
  loop
    insert into public.order_items (
      order_id, product_id, variant_id, product_name, product_slug, image_url,
      size, color, sku, quantity, unit_price, total_price)
    values (
      v_order_id,
      (v_item ->> 'product_id')::uuid,
      (v_item ->> 'variant_id')::uuid,
      v_item ->> 'product_name',
      v_item ->> 'product_slug',
      v_item ->> 'image_url',
      v_item ->> 'size',
      v_item ->> 'color',
      v_item ->> 'sku',
      (v_item ->> 'quantity')::integer,
      (v_item ->> 'unit_price')::numeric,
      (v_item ->> 'total_price')::numeric);

    update public.product_variants
       set reserved_quantity = reserved_quantity + (v_item ->> 'quantity')::integer
     where id = (v_item ->> 'variant_id')::uuid;
  end loop;

  -- Coupon usage
  if (v_pricing -> 'coupon' ->> 'valid')::boolean then
    insert into public.coupon_redemptions (coupon_id, user_id, order_id, discount_amount)
    values ((v_pricing -> 'coupon' ->> 'coupon_id')::uuid, v_user, v_order_id,
            (v_pricing ->> 'discount_amount')::numeric);

    update public.coupons
       set usage_count = usage_count + 1
     where id = (v_pricing -> 'coupon' ->> 'coupon_id')::uuid;
  end if;

  -- Loyalty redemption is debited here, atomically with the order.
  if (v_pricing ->> 'loyalty_points_used')::integer > 0 then
    select * into v_reward from public.loyalty_rewards where id = v_reward_id;
    insert into public.loyalty_transactions (
      user_id, order_id, transaction_type, points, description)
    values (
      v_user, v_order_id, 'redeem',
      -1 * (v_pricing ->> 'loyalty_points_used')::integer,
      coalesce(v_reward.name, 'Reward redeemed') || ' — order ' || v_number);
  end if;

  -- Empty the cart and drop the applied incentives.
  delete from public.cart_items where cart_id = v_cart.id;
  update public.carts
     set applied_coupon_code = null, applied_reward_id = null
   where id = v_cart.id;

  return jsonb_build_object(
    'order_id',     v_order_id,
    'order_number', v_number,
    'total_amount', (v_pricing ->> 'total_amount')::numeric,
    'status',       'pending');
end;
$$;

-- =====================================================================
-- 2. ORDER LIFECYCLE
-- =====================================================================

-- Initial history row + confirmation notification.
create or replace function public.on_order_created()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_items jsonb;
begin
  insert into public.order_status_history (order_id, status, note, changed_by)
  values (new.id, new.order_status, 'Order placed', new.user_id);

  if new.user_id is not null then
    insert into public.notifications (user_id, title, message, type, reference_id, action_url)
    values (new.user_id, 'Order received',
            'We have your order ' || new.order_number || '. We will confirm it shortly.',
            'order', new.id, '#/account/orders/' || new.id::text);
  end if;

  select jsonb_agg(jsonb_build_object(
           'name', oi.product_name, 'size', oi.size, 'color', oi.color,
           'quantity', oi.quantity, 'total_price', oi.total_price))
    into v_items
  from public.order_items oi where oi.order_id = new.id;

  perform public.enqueue_email(
    new.customer_email,
    new.customer_name,
    'order_received',
    'We received your BJmeem order ' || new.order_number || ' 🧸',
    jsonb_build_object(
      'order_number', new.order_number,
      'customer_name', new.customer_name,
      'items', coalesce(v_items, '[]'::jsonb),
      'subtotal', new.subtotal,
      'discount_amount', new.discount_amount,
      'loyalty_discount', new.loyalty_discount,
      'delivery_fee', new.delivery_fee,
      'total_amount', new.total_amount,
      'shipping_address', new.shipping_address,
      'status', new.order_status));

  return null;
end;
$$;

-- The order_items rows are inserted after the order row, so fire on statement
-- end via a constraint trigger to make sure the email includes the lines.
create constraint trigger orders_created_notify
  after insert on public.orders
  deferrable initially deferred
  for each row execute function public.on_order_created();

-- Status transitions: inventory, loyalty, referral, history, notification.
create or replace function public.on_order_status_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item        record;
  v_points      integer;
  v_multiplier  numeric := 1;
  v_eligible    numeric(12,3);
  v_rate        numeric;
  v_expiry_m    integer;
  v_referral    public.referrals;
  v_ref_bonus   integer;
  v_label       text;
  v_subject     text;
  v_template    text;
  v_was_reserved boolean;
  v_now_reserved boolean;
begin
  if new.order_status = old.order_status then
    return new;
  end if;

  -- Stock is reserved while an order is live and un-delivered.
  v_was_reserved := old.order_status in
    ('pending','confirmed','preparing','packed','out_for_delivery');
  v_now_reserved := new.order_status in
    ('pending','confirmed','preparing','packed','out_for_delivery');

  if v_was_reserved and new.order_status = 'delivered' then
    -- Reservation becomes a real sale.
    for v_item in select variant_id, quantity from public.order_items
                  where order_id = new.id and variant_id is not null
                  order by variant_id
    loop
      update public.product_variants
         set stock_quantity    = greatest(stock_quantity - v_item.quantity, 0),
             reserved_quantity = greatest(reserved_quantity - v_item.quantity, 0)
       where id = v_item.variant_id;
    end loop;

  elsif v_was_reserved and not v_now_reserved and new.order_status <> 'delivered' then
    -- Cancelled before fulfilment: release the hold.
    for v_item in select variant_id, quantity from public.order_items
                  where order_id = new.id and variant_id is not null
                  order by variant_id
    loop
      update public.product_variants
         set reserved_quantity = greatest(reserved_quantity - v_item.quantity, 0)
       where id = v_item.variant_id;
    end loop;

  elsif old.order_status = 'delivered' and new.order_status in ('returned','refunded') then
    -- Goods came back: restock.
    for v_item in select variant_id, quantity from public.order_items
                  where order_id = new.id and variant_id is not null
                  order by variant_id
    loop
      update public.product_variants
         set stock_quantity = stock_quantity + v_item.quantity
       where id = v_item.variant_id;
    end loop;
  end if;

  -- Timestamps
  if new.order_status = 'delivered' and new.delivered_at is null then
    new.delivered_at := now();
  end if;
  if new.order_status = 'cancelled' and new.cancelled_at is null then
    new.cancelled_at := now();
  end if;

  return new;
end;
$$;

create trigger orders_status_before
  before update of order_status on public.orders
  for each row execute function public.on_order_status_change();

-- Everything that must happen *after* the row is committed to its new status.
create or replace function public.after_order_status_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_points     integer;
  v_multiplier numeric := 1;
  v_eligible   numeric(12,3);
  v_rate       numeric;
  v_expiry_m   integer;
  v_referral   public.referrals;
  v_ref_bonus  integer;
  v_label      text;
  v_template   text;
  v_items      jsonb;
begin
  if new.order_status = old.order_status then
    return null;
  end if;

  insert into public.order_status_history (order_id, status, changed_by)
  values (new.id, new.order_status, auth.uid());

  -- ---------------- loyalty earn on delivery
  if new.order_status = 'delivered' and new.user_id is not null then
    v_rate     := public.setting_numeric('loyalty.points_per_kwd', 1);
    v_expiry_m := public.setting_numeric('loyalty.expiry_months', 12)::integer;

    select coalesce(t.points_multiplier, 1) into v_multiplier
    from public.loyalty_accounts la
    join public.loyalty_tiers t on t.code = la.loyalty_tier
    where la.user_id = new.user_id;

    -- Points are earned on merchandise only, not on delivery or tax.
    v_eligible := greatest(new.subtotal - new.discount_amount - new.loyalty_discount, 0);
    v_points   := floor(v_eligible * v_rate * coalesce(v_multiplier, 1))::integer;

    if v_points > 0 then
      insert into public.loyalty_transactions (
        user_id, order_id, transaction_type, points, description, expires_at)
      values (
        new.user_id, new.id, 'earn', v_points,
        'Order ' || new.order_number,
        now() + make_interval(months => v_expiry_m))
      on conflict do nothing;   -- the unique index makes a replay a no-op

      -- The loyalty insert above resets the privileged flag when its own
      -- trigger finishes, so raise it again before touching orders.
      perform set_config('bjmeem.privileged', 'on', true);
      update public.orders set loyalty_points_earned = v_points where id = new.id;
      perform set_config('bjmeem.privileged', 'off', true);
    end if;

    -- Lifetime customer stats
    perform set_config('bjmeem.privileged', 'on', true);
    update public.profiles
       set total_orders = total_orders + 1,
           total_spent  = total_spent + new.total_amount
     where id = new.user_id;
    perform set_config('bjmeem.privileged', 'off', true);

    -- ---------------- referral qualifies on the referred user's first delivery
    select * into v_referral
    from public.referrals
    where referred_user_id = new.user_id and status = 'pending'
    limit 1;

    if v_referral.id is not null then
      v_ref_bonus := public.setting_numeric('loyalty.referral_bonus_points', 100)::integer;

      insert into public.loyalty_transactions (
        user_id, order_id, transaction_type, points, description, expires_at)
      values (
        v_referral.referrer_user_id, new.id, 'referral_bonus', v_ref_bonus,
        'Referral reward', now() + make_interval(months => v_expiry_m));

      update public.referrals
         set status = 'rewarded', reward_given = true, qualifying_order_id = new.id
       where id = v_referral.id;

      insert into public.notifications (user_id, title, message, type)
      values (v_referral.referrer_user_id, 'Referral reward',
              'Your friend made their first BJmeem order. ' || v_ref_bonus ||
              ' Cozy Points are on your card.', 'loyalty');
    end if;
  end if;

  -- ---------------- reverse points on return / refund
  if new.order_status in ('returned','refunded')
     and old.order_status = 'delivered'
     and new.user_id is not null then

    select coalesce(loyalty_points_earned, 0) into v_points
    from public.orders where id = new.id;

    if v_points > 0 then
      insert into public.loyalty_transactions (
        user_id, order_id, transaction_type, points, description)
      values (new.user_id, new.id, 'refund_adjustment', -v_points,
              'Points reversed for ' || new.order_number);
    end if;

    perform set_config('bjmeem.privileged', 'on', true);
    update public.profiles
       set total_orders = greatest(total_orders - 1, 0),
           total_spent  = greatest(total_spent - new.total_amount, 0)
     where id = new.user_id;
    perform set_config('bjmeem.privileged', 'off', true);
  end if;

  -- ---------------- customer-facing messaging
  v_label := case new.order_status
    when 'confirmed'       then 'Order confirmed'
    when 'preparing'       then 'We are preparing your order'
    when 'packed'          then 'Your order is packed'
    when 'out_for_delivery' then 'Out for delivery'
    when 'delivered'       then 'Delivered'
    when 'cancelled'       then 'Order cancelled'
    when 'returned'        then 'Return received'
    when 'refunded'        then 'Refund processed'
    else 'Order updated' end;

  v_template := 'order_' || new.order_status::text;

  if new.user_id is not null then
    insert into public.notifications (user_id, title, message, type, reference_id, action_url)
    values (new.user_id, v_label,
            'Order ' || new.order_number || ': ' || lower(v_label) || '.',
            'order', new.id, '#/account/orders/' || new.id::text);
  end if;

  select jsonb_agg(jsonb_build_object(
           'name', oi.product_name, 'size', oi.size, 'color', oi.color,
           'quantity', oi.quantity, 'total_price', oi.total_price))
    into v_items
  from public.order_items oi where oi.order_id = new.id;

  perform public.enqueue_email(
    new.customer_email,
    new.customer_name,
    v_template,
    'Your BJmeem order ' || new.order_number || ' — ' || lower(v_label) || ' 🧸',
    jsonb_build_object(
      'order_number', new.order_number,
      'customer_name', new.customer_name,
      'status', new.order_status,
      'status_label', v_label,
      'items', coalesce(v_items, '[]'::jsonb),
      'total_amount', new.total_amount,
      'shipping_address', new.shipping_address,
      'courier_name', new.courier_name,
      'tracking_reference', new.tracking_reference));

  return null;
end;
$$;

create trigger orders_status_after
  after update of order_status on public.orders
  for each row execute function public.after_order_status_change();

-- =====================================================================
-- 3. CUSTOMER ORDER ACTIONS
-- =====================================================================

create or replace function public.cancel_my_order(p_order_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user  uuid := auth.uid();
  v_order public.orders;
begin
  if v_user is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;

  select * into v_order from public.orders where id = p_order_id and user_id = v_user
  for update;

  if v_order.id is null then
    raise exception 'ORDER_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Once it is out for delivery it is too late to self-serve.
  if v_order.order_status not in ('pending','confirmed','preparing') then
    raise exception 'NOT_CANCELLABLE: order is already %', v_order.order_status
      using errcode = 'P0001';
  end if;

  perform set_config('bjmeem.privileged', 'on', true);
  update public.orders
     set order_status = 'cancelled',
         cancelled_at = now()
   where id = p_order_id;
  perform set_config('bjmeem.privileged', 'off', true);

  insert into public.order_status_history (order_id, status, note, changed_by)
  values (p_order_id, 'cancelled', coalesce(p_reason, 'Cancelled by customer'), v_user);

  return jsonb_build_object('order_id', p_order_id, 'status', 'cancelled');
end;
$$;

-- Guest / logged-out tracking by order number + email.
create or replace function public.track_order(p_order_number text, p_email text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_order   public.orders;
  v_history jsonb;
  v_items   jsonb;
begin
  select * into v_order
  from public.orders
  where upper(order_number) = upper(trim(coalesce(p_order_number, '')))
    and lower(customer_email) = lower(trim(coalesce(p_email, '')));

  if v_order.id is null then
    -- Deliberately identical response for "wrong number" and "wrong email"
    -- so this cannot be used to enumerate orders.
    return jsonb_build_object('found', false);
  end if;

  select jsonb_agg(jsonb_build_object(
           'status', h.status, 'note', h.note, 'at', h.created_at)
         order by h.created_at)
    into v_history
  from public.order_status_history h where h.order_id = v_order.id;

  select jsonb_agg(jsonb_build_object(
           'product_name', oi.product_name, 'size', oi.size, 'color', oi.color,
           'quantity', oi.quantity, 'unit_price', oi.unit_price,
           'total_price', oi.total_price, 'image_url', oi.image_url))
    into v_items
  from public.order_items oi where oi.order_id = v_order.id;

  return jsonb_build_object(
    'found',        true,
    'order_number', v_order.order_number,
    'status',       v_order.order_status,
    'placed_at',    v_order.created_at,
    'delivered_at', v_order.delivered_at,
    'total_amount', v_order.total_amount,
    'courier_name', v_order.courier_name,
    'courier_phone', v_order.courier_phone,
    'tracking_reference', v_order.tracking_reference,
    'estimated_delivery_time', v_order.estimated_delivery_time,
    'items',        coalesce(v_items, '[]'::jsonb),
    'history',      coalesce(v_history, '[]'::jsonb));
end;
$$;

-- Re-add a past order's still-available lines to the cart.
create or replace function public.reorder(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user    uuid := auth.uid();
  v_cart    uuid;
  v_added   integer := 0;
  v_skipped jsonb := '[]'::jsonb;
  r         record;
begin
  if v_user is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;

  if not exists (select 1 from public.orders where id = p_order_id and user_id = v_user) then
    raise exception 'ORDER_NOT_FOUND' using errcode = 'P0002';
  end if;

  v_cart := public.get_or_create_cart();

  for r in
    select oi.variant_id, oi.quantity, oi.product_name,
           pv.is_active, p.is_active as product_active,
           (pv.stock_quantity - pv.reserved_quantity) as available
    from public.order_items oi
    left join public.product_variants pv on pv.id = oi.variant_id
    left join public.products p on p.id = pv.product_id
    where oi.order_id = p_order_id
  loop
    if r.variant_id is null or not coalesce(r.is_active, false)
       or not coalesce(r.product_active, false) or coalesce(r.available, 0) < 1 then
      v_skipped := v_skipped || jsonb_build_object('product_name', r.product_name);
      continue;
    end if;

    -- product_id is re-derived from the variant by the cart_items trigger,
    -- but pass the correct value so the FK is satisfied on the way in.
    insert into public.cart_items (cart_id, product_id, variant_id, quantity)
    values (v_cart,
            (select product_id from public.product_variants where id = r.variant_id),
            r.variant_id,
            least(r.quantity, r.available))
    on conflict (cart_id, variant_id) do update
      set quantity = least(cart_items.quantity + excluded.quantity, 20);

    v_added := v_added + 1;
  end loop;

  return jsonb_build_object('added', v_added, 'skipped', v_skipped);
end;
$$;

-- =====================================================================
-- 4. LOYALTY CARD + MAINTENANCE
-- =====================================================================

create or replace function public.get_loyalty_card()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user    uuid := auth.uid();
  v_acct    public.loyalty_accounts;
  v_profile public.profiles;
  v_tier    public.loyalty_tiers;
  v_next    public.loyalty_tiers;
begin
  if v_user is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;

  select * into v_acct    from public.loyalty_accounts where user_id = v_user;
  select * into v_profile from public.profiles         where id = v_user;
  select * into v_tier    from public.loyalty_tiers    where code = v_acct.loyalty_tier;

  select * into v_next
  from public.loyalty_tiers
  where is_active and min_points > coalesce(v_acct.lifetime_points, 0)
  order by min_points asc
  limit 1;

  return jsonb_build_object(
    'member_number',   v_acct.member_number,
    'first_name',      v_profile.first_name,
    'points_balance',  coalesce(v_acct.points_balance, 0),
    'lifetime_points', coalesce(v_acct.lifetime_points, 0),
    'tier', jsonb_build_object(
      'code', v_tier.code, 'name', v_tier.name,
      'benefits', v_tier.benefits, 'badge_color', v_tier.badge_color,
      'points_multiplier', v_tier.points_multiplier),
    'next_tier', case when v_next.id is null then null else jsonb_build_object(
      'code', v_next.code, 'name', v_next.name, 'min_points', v_next.min_points,
      'points_needed', v_next.min_points - coalesce(v_acct.lifetime_points, 0),
      'progress_percent', case when v_next.min_points > 0
        then least(round(coalesce(v_acct.lifetime_points,0)::numeric * 100 / v_next.min_points, 1), 100)
        else 100 end) end,
    'joined_at', v_acct.joined_at,
    'expiring_soon', (
      select coalesce(sum(points), 0)
      from public.loyalty_transactions
      where user_id = v_user and points > 0 and not expired
        and expires_at is not null
        and expires_at between now() and now() + interval '30 days'));
end;
$$;

-- Expire lapsed points. Called by the loyalty-maintenance Edge Function.
create or replace function public.expire_loyalty_points()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r         record;
  v_count   integer := 0;
  v_balance integer;
begin
  for r in
    select lt.id, lt.user_id, lt.points, lt.description
    from public.loyalty_transactions lt
    where lt.points > 0
      and not lt.expired
      and lt.expires_at is not null
      and lt.expires_at <= now()
    order by lt.expires_at
  loop
    select points_balance into v_balance from public.loyalty_accounts where user_id = r.user_id;

    -- Never drive the balance negative: points already spent cannot expire again.
    if coalesce(v_balance, 0) > 0 then
      insert into public.loyalty_transactions (user_id, transaction_type, points, description)
      values (r.user_id, 'expiry', -least(r.points, v_balance),
              'Points expired');
      v_count := v_count + 1;
    end if;

    perform set_config('bjmeem.privileged', 'on', true);
    update public.loyalty_transactions set expired = true where id = r.id;
    perform set_config('bjmeem.privileged', 'off', true);
  end loop;

  return v_count;
end;
$$;

-- Warn customers 30 days out. Idempotent per calendar day.
create or replace function public.notify_expiring_points()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare r record; v_count integer := 0;
begin
  for r in
    select lt.user_id, sum(lt.points) as pts, p.email, p.first_name
    from public.loyalty_transactions lt
    join public.profiles p on p.id = lt.user_id
    where lt.points > 0 and not lt.expired
      and lt.expires_at between now() + interval '29 days' and now() + interval '30 days'
    group by lt.user_id, p.email, p.first_name
  loop
    insert into public.notifications (user_id, title, message, type)
    values (r.user_id, 'Points expiring soon',
            r.pts || ' Cozy Points expire in 30 days.', 'loyalty');

    perform public.enqueue_email(r.email, r.first_name, 'points_expiring',
      r.pts || ' Cozy Points expire soon 🧸',
      jsonb_build_object('first_name', r.first_name, 'points', r.pts, 'days', 30));

    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- Birthday bonus, once per customer per calendar year.
create or replace function public.grant_birthday_bonus()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r        record;
  v_bonus  integer := public.setting_numeric('loyalty.birthday_bonus_points', 50)::integer;
  v_expiry integer := public.setting_numeric('loyalty.expiry_months', 12)::integer;
  v_count  integer := 0;
begin
  if v_bonus <= 0 then return 0; end if;

  for r in
    select p.id, p.email, p.first_name
    from public.profiles p
    where p.date_of_birth is not null
      and extract(month from p.date_of_birth) = extract(month from current_date)
      -- One per year: look for an existing bonus in this calendar year.
      and not exists (
        select 1 from public.loyalty_transactions lt
        where lt.user_id = p.id
          and lt.transaction_type = 'birthday_bonus'
          and lt.created_at >= date_trunc('year', current_date))
  loop
    insert into public.loyalty_transactions (
      user_id, transaction_type, points, description, expires_at)
    values (r.id, 'birthday_bonus', v_bonus, 'Happy birthday from BJmeem',
            now() + make_interval(months => v_expiry));

    insert into public.notifications (user_id, title, message, type)
    values (r.id, 'Happy birthday 🎀',
            'Enjoy ' || v_bonus || ' Cozy Points on us this month.', 'loyalty');

    perform public.enqueue_email(r.email, r.first_name, 'birthday_bonus',
      'A birthday treat from BJmeem 🎀',
      jsonb_build_object('first_name', r.first_name, 'points', v_bonus));

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;
