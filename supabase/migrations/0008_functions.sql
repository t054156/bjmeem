-- =====================================================================
-- BJmeem 0008 — signup wiring, pricing engine, checkout, order lifecycle
--
-- Everything that decides money or entitlement lives here, as SECURITY
-- DEFINER functions. The browser may call them but cannot supply amounts.
-- =====================================================================

-- Cart-level intent: which coupon / reward the customer has applied.
-- Stored server-side so preview and checkout can never disagree.
alter table public.carts
  add column applied_coupon_code text,
  add column applied_reward_id   uuid references public.loyalty_rewards(id) on delete set null;

-- =====================================================================
-- 1. SIGNUP
-- =====================================================================

create or replace function public.generate_referral_code(p_first_name text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base text;
  v_code text;
  i integer := 0;
begin
  v_base := upper(regexp_replace(coalesce(nullif(trim(p_first_name), ''), 'BJMEEM'),
                                 '[^A-Za-z]', '', 'g'));
  v_base := left(coalesce(nullif(v_base, ''), 'BJMEEM'), 10);

  loop
    v_code := v_base || '-BJ' || lpad((floor(random() * 10000))::int::text, 4, '0');
    exit when not exists (select 1 from public.profiles where referral_code = v_code);
    i := i + 1;
    if i > 25 then
      v_code := v_base || '-BJ' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
      exit;
    end if;
  end loop;

  return v_code;
end;
$$;

-- Fires as the auth user is created, before any session exists.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_meta        jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_first       text  := nullif(trim(v_meta ->> 'first_name'), '');
  v_last        text  := nullif(trim(v_meta ->> 'last_name'), '');
  v_phone       text  := nullif(trim(v_meta ->> 'phone_number'), '');
  v_dob         date;
  v_ref_code    text  := nullif(upper(trim(v_meta ->> 'referral_code')), '');
  v_referrer    uuid;
  v_member_no   text;
  v_signup_bonus integer;
begin
  begin
    v_dob := nullif(v_meta ->> 'date_of_birth', '')::date;
  exception when others then
    v_dob := null;
  end;

  -- Who referred them, if anyone. Self-referral is impossible here because the
  -- code belongs to an existing profile and this user does not exist yet.
  if v_ref_code is not null then
    select id into v_referrer from public.profiles where referral_code = v_ref_code;
  end if;

  insert into public.profiles (
    id, email, first_name, last_name, phone_number, date_of_birth,
    gender, avatar_url, referral_code, referred_by)
  values (
    new.id,
    new.email,
    v_first,
    v_last,
    v_phone,
    v_dob,
    nullif(v_meta ->> 'gender', ''),
    nullif(v_meta ->> 'avatar_url', ''),
    public.generate_referral_code(v_first),
    v_referrer);

  v_member_no := 'BJ-' || nextval('public.loyalty_member_seq')::text;

  insert into public.loyalty_accounts (user_id, member_number)
  values (new.id, v_member_no);

  insert into public.carts (user_id) values (new.id) on conflict do nothing;

  -- Signup bonus, configurable, credited immediately.
  v_signup_bonus := public.setting_numeric('loyalty.signup_bonus_points', 25)::integer;
  if v_signup_bonus > 0 then
    insert into public.loyalty_transactions (
      user_id, transaction_type, points, description, expires_at)
    values (
      new.id, 'signup_bonus', v_signup_bonus,
      'Welcome to the BJmeem Cozy Club',
      now() + make_interval(months => public.setting_numeric('loyalty.expiry_months', 12)::int));
  end if;

  -- Referral is recorded now, rewarded only after a qualifying delivered order.
  if v_referrer is not null then
    insert into public.referrals (referrer_user_id, referred_user_id, referral_code, status)
    values (v_referrer, new.id, v_ref_code, 'pending')
    on conflict do nothing;
  end if;

  insert into public.notifications (user_id, title, message, type)
  values (new.id, 'Welcome to BJmeem',
          'Your Cozy Club account is ready. Enjoy your welcome points!', 'system');

  perform public.enqueue_email(
    new.email,
    coalesce(v_first, 'there'),
    'welcome',
    'Welcome to BJmeem 🧸',
    jsonb_build_object('first_name', coalesce(v_first, 'there'),
                       'member_number', v_member_no,
                       'signup_bonus', v_signup_bonus));

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Keep the profile email aligned if the customer changes it in Auth.
create or replace function public.handle_user_email_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.email is distinct from old.email then
    update public.profiles set email = new.email where id = new.id;
  end if;
  return new;
end;
$$;

create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row execute function public.handle_user_email_change();

-- =====================================================================
-- 2. CART HELPERS
-- =====================================================================

create or replace function public.get_or_create_cart()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_cart uuid;
begin
  if v_user is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;

  insert into public.carts (user_id) values (v_user)
  on conflict (user_id) do update set updated_at = now()
  returning id into v_cart;

  return v_cart;
end;
$$;

-- =====================================================================
-- 3. DELIVERY + COUPON RULES
-- =====================================================================

create or replace function public.resolve_delivery_zone(p_governorate text)
returns public.delivery_zones
language sql
stable
security definer
set search_path = public
as $$
  select *
  from public.delivery_zones
  where is_active
    and lower(governorate) = lower(coalesce(p_governorate, ''))
  limit 1;
$$;

-- Returns { valid, reason, discount, free_delivery, coupon_id }.
-- Used identically by preview and checkout so the customer is never surprised.
create or replace function public.validate_coupon(
  p_code     text,
  p_subtotal numeric default null,
  p_user_id  uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user     uuid := coalesce(p_user_id, auth.uid());
  v_coupon   public.coupons;
  v_used_by_user integer;
  v_tier     text;
  v_discount numeric(12,3) := 0;
  v_orders   integer;
begin
  if p_code is null or trim(p_code) = '' then
    return jsonb_build_object('valid', false, 'reason', 'NO_CODE', 'discount', 0);
  end if;

  select * into v_coupon from public.coupons where upper(code) = upper(trim(p_code));

  if v_coupon.id is null then
    return jsonb_build_object('valid', false, 'reason', 'NOT_FOUND', 'discount', 0);
  end if;
  if not v_coupon.is_active then
    return jsonb_build_object('valid', false, 'reason', 'INACTIVE', 'discount', 0);
  end if;
  if now() < v_coupon.starts_at then
    return jsonb_build_object('valid', false, 'reason', 'NOT_STARTED', 'discount', 0);
  end if;
  if v_coupon.expires_at is not null and now() > v_coupon.expires_at then
    return jsonb_build_object('valid', false, 'reason', 'EXPIRED', 'discount', 0);
  end if;
  if v_coupon.usage_limit is not null and v_coupon.usage_count >= v_coupon.usage_limit then
    return jsonb_build_object('valid', false, 'reason', 'USAGE_LIMIT_REACHED', 'discount', 0);
  end if;

  if v_coupon.loyalty_members_only and v_user is null then
    return jsonb_build_object('valid', false, 'reason', 'MEMBERS_ONLY', 'discount', 0);
  end if;

  if v_user is not null then
    select count(*) into v_used_by_user
    from public.coupon_redemptions
    where coupon_id = v_coupon.id and user_id = v_user;

    if v_used_by_user >= v_coupon.usage_per_customer then
      return jsonb_build_object('valid', false, 'reason', 'ALREADY_USED', 'discount', 0);
    end if;

    if v_coupon.first_order_only then
      select count(*) into v_orders
      from public.orders
      where user_id = v_user and order_status <> 'cancelled';
      if v_orders > 0 then
        return jsonb_build_object('valid', false, 'reason', 'FIRST_ORDER_ONLY', 'discount', 0);
      end if;
    end if;

    if v_coupon.allowed_tiers is not null and array_length(v_coupon.allowed_tiers, 1) > 0 then
      select loyalty_tier into v_tier from public.loyalty_accounts where user_id = v_user;
      if v_tier is null or not (v_tier = any (v_coupon.allowed_tiers)) then
        return jsonb_build_object('valid', false, 'reason', 'TIER_NOT_ELIGIBLE', 'discount', 0);
      end if;
    end if;
  end if;

  if p_subtotal is not null and p_subtotal < v_coupon.minimum_order_amount then
    return jsonb_build_object(
      'valid', false, 'reason', 'MINIMUM_NOT_MET', 'discount', 0,
      'minimum_order_amount', v_coupon.minimum_order_amount);
  end if;

  if p_subtotal is not null then
    v_discount := case v_coupon.discount_type
      when 'percentage'    then round(p_subtotal * v_coupon.discount_value / 100.0, 3)
      when 'fixed'         then least(v_coupon.discount_value, p_subtotal)
      when 'free_delivery' then 0
    end;

    if v_coupon.maximum_discount is not null then
      v_discount := least(v_discount, v_coupon.maximum_discount);
    end if;
    v_discount := least(v_discount, p_subtotal);
  end if;

  return jsonb_build_object(
    'valid', true,
    'reason', 'OK',
    'coupon_id', v_coupon.id,
    'code', v_coupon.code,
    'description', v_coupon.description,
    'discount_type', v_coupon.discount_type,
    'discount', coalesce(v_discount, 0),
    'free_delivery', v_coupon.discount_type = 'free_delivery');
end;
$$;

-- =====================================================================
-- 4. PRICING ENGINE
--    One implementation, shared by preview_cart() and place_order(),
--    so what the customer is quoted is exactly what they are charged.
-- =====================================================================

create or replace function public.price_cart(
  p_user_id    uuid,
  p_address_id uuid default null,
  p_coupon_code text default null,
  p_reward_id  uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_cart_id   uuid;
  v_items     jsonb := '[]'::jsonb;
  v_subtotal  numeric(12,3) := 0;
  v_discount  numeric(12,3) := 0;
  v_loyalty_discount numeric(12,3) := 0;
  v_points_used integer := 0;
  v_delivery  numeric(12,3) := 0;
  v_tax       numeric(12,3) := 0;
  v_total     numeric(12,3);
  v_zone      public.delivery_zones;
  v_addr      public.addresses;
  v_coupon    jsonb;
  v_reward    public.loyalty_rewards;
  v_balance   integer := 0;
  v_tier      text;
  v_free_delivery boolean := false;
  v_issues    jsonb := '[]'::jsonb;
  r           record;
  v_tax_rate  numeric;
begin
  select id into v_cart_id from public.carts where user_id = p_user_id;

  -- Line items priced from the database, never from the client.
  for r in
    select
      ci.id            as cart_item_id,
      ci.quantity,
      ci.variant_id,
      pv.product_id,
      pv.size, pv.color, pv.sku,
      pv.is_active     as variant_active,
      (pv.stock_quantity - pv.reserved_quantity) as available,
      coalesce(pv.price_override, p.price) as unit_price,
      p.name           as product_name,
      p.slug           as product_slug,
      p.is_active      as product_active,
      (select pi.image_url from public.product_images pi
        where pi.product_id = p.id
        order by pi.is_primary desc, pi.sort_order asc limit 1) as image_url
    from public.cart_items ci
    join public.product_variants pv on pv.id = ci.variant_id
    join public.products p          on p.id  = pv.product_id
    where ci.cart_id = v_cart_id
    order by ci.created_at
  loop
    if not r.product_active or not r.variant_active then
      v_issues := v_issues || jsonb_build_object(
        'variant_id', r.variant_id, 'code', 'UNAVAILABLE', 'product_name', r.product_name);
      continue;
    end if;

    if r.available < r.quantity then
      v_issues := v_issues || jsonb_build_object(
        'variant_id', r.variant_id, 'code', 'INSUFFICIENT_STOCK',
        'product_name', r.product_name, 'available', r.available, 'requested', r.quantity);
    end if;

    v_subtotal := v_subtotal + round(r.unit_price * r.quantity, 3);

    v_items := v_items || jsonb_build_object(
      'cart_item_id', r.cart_item_id,
      'variant_id',   r.variant_id,
      'product_id',   r.product_id,
      'product_name', r.product_name,
      'product_slug', r.product_slug,
      'image_url',    r.image_url,
      'size',         r.size,
      'color',        r.color,
      'sku',          r.sku,
      'quantity',     r.quantity,
      'unit_price',   r.unit_price,
      'total_price',  round(r.unit_price * r.quantity, 3),
      'available',    r.available);
  end loop;

  -- Coupon
  if p_coupon_code is not null and trim(p_coupon_code) <> '' then
    v_coupon := public.validate_coupon(p_coupon_code, v_subtotal, p_user_id);
    if (v_coupon ->> 'valid')::boolean then
      v_discount := (v_coupon ->> 'discount')::numeric;
      v_free_delivery := coalesce((v_coupon ->> 'free_delivery')::boolean, false);
    end if;
  end if;

  -- Loyalty reward
  if p_reward_id is not null then
    select * into v_reward from public.loyalty_rewards where id = p_reward_id and is_active;
    select points_balance, loyalty_tier into v_balance, v_tier
      from public.loyalty_accounts where user_id = p_user_id;

    if v_reward.id is null then
      v_issues := v_issues || jsonb_build_object('code', 'REWARD_NOT_FOUND');
    elsif coalesce(v_balance, 0) < v_reward.points_required then
      v_issues := v_issues || jsonb_build_object(
        'code', 'INSUFFICIENT_POINTS',
        'required', v_reward.points_required, 'balance', coalesce(v_balance, 0));
    else
      v_points_used := v_reward.points_required;
      if v_reward.reward_type = 'fixed_discount' then
        v_loyalty_discount := least(v_reward.reward_value, greatest(v_subtotal - v_discount, 0));
      elsif v_reward.reward_type = 'percentage_discount' then
        v_loyalty_discount := round((v_subtotal - v_discount) * v_reward.reward_value / 100.0, 3);
      elsif v_reward.reward_type = 'free_delivery' then
        v_free_delivery := true;
      end if;
    end if;
  end if;

  -- Delivery, from the zone that matches the chosen address.
  if p_address_id is not null then
    select * into v_addr from public.addresses
      where id = p_address_id and user_id = p_user_id;
    if v_addr.id is not null then
      v_zone := public.resolve_delivery_zone(v_addr.governorate);
    end if;
  end if;

  if v_zone.id is null then
    select * into v_zone from public.delivery_zones where is_active
      order by delivery_fee asc limit 1;
  end if;

  v_delivery := coalesce(v_zone.delivery_fee,
                         public.setting_numeric('delivery.default_fee', 1.500));

  if v_zone.free_delivery_threshold is not null
     and (v_subtotal - v_discount - v_loyalty_discount) >= v_zone.free_delivery_threshold then
    v_delivery := 0;
  end if;
  if v_free_delivery then
    v_delivery := 0;
  end if;
  if v_subtotal = 0 then
    v_delivery := 0;
  end if;

  -- Kuwait has no VAT today; the rate is a setting so it can be switched on.
  v_tax_rate := public.setting_numeric('tax.rate_percent', 0);
  v_tax := round((v_subtotal - v_discount - v_loyalty_discount) * v_tax_rate / 100.0, 3);

  v_total := round(v_subtotal - v_discount - v_loyalty_discount + v_delivery + v_tax, 3);

  return jsonb_build_object(
    'cart_id',           v_cart_id,
    'items',             v_items,
    'item_count',        (select coalesce(sum((i ->> 'quantity')::int), 0)
                            from jsonb_array_elements(v_items) i),
    'subtotal',          v_subtotal,
    'discount_amount',   v_discount,
    'loyalty_discount',  v_loyalty_discount,
    'loyalty_points_used', v_points_used,
    'delivery_fee',      v_delivery,
    'tax_amount',        v_tax,
    'total_amount',      v_total,
    'coupon',            v_coupon,
    'delivery_zone',     case when v_zone.id is null then null else jsonb_build_object(
                            'id', v_zone.id, 'name', v_zone.name,
                            'min_hours', v_zone.estimated_min_hours,
                            'max_hours', v_zone.estimated_max_hours,
                            'free_delivery_threshold', v_zone.free_delivery_threshold) end,
    'issues',            v_issues,
    'can_checkout',      (v_subtotal > 0 and jsonb_array_length(v_issues) = 0));
end;
$$;

-- Customer-facing preview. Reads the coupon/reward the customer has applied
-- to their cart unless explicitly overridden.
create or replace function public.preview_cart(
  p_address_id  uuid default null,
  p_coupon_code text default null,
  p_reward_id   uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_cart public.carts;
begin
  if v_user is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;

  select * into v_cart from public.carts where user_id = v_user;

  return public.price_cart(
    v_user,
    coalesce(p_address_id,
             (select id from public.addresses where user_id = v_user and is_default limit 1)),
    coalesce(p_coupon_code, v_cart.applied_coupon_code),
    coalesce(p_reward_id,   v_cart.applied_reward_id));
end;
$$;

-- Apply / clear a coupon on the cart. Validates immediately so the UI can
-- show a reason rather than failing at checkout.
create or replace function public.apply_coupon_to_cart(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user   uuid := auth.uid();
  v_cart   uuid;
  v_result jsonb;
  v_sub    numeric(12,3);
begin
  if v_user is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  v_cart := public.get_or_create_cart();

  if p_code is null or trim(p_code) = '' then
    update public.carts set applied_coupon_code = null where id = v_cart;
    return jsonb_build_object('valid', true, 'reason', 'CLEARED', 'discount', 0);
  end if;

  v_sub := (public.price_cart(v_user) ->> 'subtotal')::numeric;
  v_result := public.validate_coupon(p_code, v_sub, v_user);

  if (v_result ->> 'valid')::boolean then
    update public.carts set applied_coupon_code = upper(trim(p_code)) where id = v_cart;
  end if;

  return v_result;
end;
$$;

-- Stake a loyalty reward against the cart. Points are debited atomically at
-- checkout, not here, so an abandoned cart never loses the customer points.
create or replace function public.redeem_loyalty_reward(p_reward_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user    uuid := auth.uid();
  v_cart    uuid;
  v_reward  public.loyalty_rewards;
  v_account public.loyalty_accounts;
  v_tier    public.loyalty_tiers;
begin
  if v_user is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  v_cart := public.get_or_create_cart();

  if p_reward_id is null then
    update public.carts set applied_reward_id = null where id = v_cart;
    return jsonb_build_object('applied', false, 'reason', 'CLEARED');
  end if;

  select * into v_reward from public.loyalty_rewards where id = p_reward_id and is_active;
  if v_reward.id is null then
    return jsonb_build_object('applied', false, 'reason', 'REWARD_NOT_FOUND');
  end if;

  select * into v_account from public.loyalty_accounts where user_id = v_user;
  if coalesce(v_account.points_balance, 0) < v_reward.points_required then
    return jsonb_build_object('applied', false, 'reason', 'INSUFFICIENT_POINTS',
      'required', v_reward.points_required, 'balance', coalesce(v_account.points_balance, 0));
  end if;

  if v_reward.min_tier is not null then
    select * into v_tier from public.loyalty_tiers where code = v_reward.min_tier;
    if v_tier.id is not null and
       (select min_points from public.loyalty_tiers where code = v_account.loyalty_tier)
         < v_tier.min_points then
      return jsonb_build_object('applied', false, 'reason', 'TIER_NOT_ELIGIBLE',
        'required_tier', v_reward.min_tier);
    end if;
  end if;

  update public.carts set applied_reward_id = p_reward_id where id = v_cart;

  return jsonb_build_object('applied', true, 'reason', 'OK',
    'reward', jsonb_build_object('id', v_reward.id, 'name', v_reward.name,
      'points_required', v_reward.points_required,
      'reward_type', v_reward.reward_type, 'reward_value', v_reward.reward_value));
end;
$$;
