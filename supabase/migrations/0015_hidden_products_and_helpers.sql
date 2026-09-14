-- =====================================================================
-- BJmeem 0015 — three holes found while verifying 0014 against a real
-- Supabase project. All three were reproduced from outside, by an
-- anonymous caller holding nothing but the public key.
--
--   A  "Hide product" did not hide its stock rows, sizes, colours or SKUs.
--   B  The availability view ignored Row Level Security entirely.
--   C  Internal helper functions were callable by strangers, including
--      the one that issues order numbers.
-- =====================================================================

-- =====================================================================
-- A + B — hiding a product must hide everything that belongs to it.
--
-- variants_read only asked whether the VARIANT was active. Hiding a
-- product leaves its variants active, so the variant rows stayed public.
-- The view made it worse: a view runs with its creator's rights unless
-- told otherwise, so it returned rows RLS would have refused.
-- =====================================================================

alter view public.v_variant_availability set (security_invoker = true);

drop policy if exists variants_read on public.product_variants;
create policy variants_read on public.product_variants
  for select to anon, authenticated
  using (
    public.is_staff()
    or (is_active and exists (select 1 from public.products p
                              where p.id = product_variants.product_id
                                and p.is_active)));

-- Photos of a hidden product were readable too: the old rule was
-- "using (true)". Shop photographs stay public, but only for products
-- that are actually on sale.
drop policy if exists images_read on public.product_images;
create policy images_read on public.product_images
  for select to anon, authenticated
  using (
    public.is_staff()
    or exists (select 1 from public.products p
               where p.id = product_images.product_id
                 and p.is_active));

-- =====================================================================
-- C — internal plumbing is not a public API.
--
-- Postgres grants EXECUTE to PUBLIC on every new function. These were
-- never meant to be called from a browser. next_order_number() was the
-- live one: an anonymous caller could burn order numbers at will.
--
-- Deliberately NOT revoked, because policies and the storefront need
-- them: auth_role, is_admin, is_staff, is_owner, has_permission,
-- resolve_delivery_zone, track_order, and the customer-facing RPCs.
-- =====================================================================

revoke execute on function public.next_order_number()              from public, anon, authenticated;
revoke execute on function public.generate_referral_code(text)     from public, anon, authenticated;

-- validate_coupon takes a user id, so an anonymous caller could probe
-- another customer's coupon history. Signed-in customers still need it.
revoke execute on function public.validate_coupon(text, numeric, uuid) from public, anon;
grant  execute on function public.validate_coupon(text, numeric, uuid) to authenticated;

-- Trigger functions. Calling one directly does nothing useful, but it
-- does not belong on the public API surface.
revoke execute on function public.touch_updated_at()                       from public, anon, authenticated;
revoke execute on function public.unset_other_default_addresses()          from public, anon, authenticated;
revoke execute on function public.first_address_is_default()               from public, anon, authenticated;
revoke execute on function public.unset_other_primary_images()             from public, anon, authenticated;
revoke execute on function public.assert_variant_matches_product()         from public, anon, authenticated;
revoke execute on function public.normalise_coupon_code()                  from public, anon, authenticated;
revoke execute on function public.loyalty_ledger_is_append_only()          from public, anon, authenticated;
revoke execute on function public.apply_loyalty_transaction()              from public, anon, authenticated;
revoke execute on function public.audit_row_change()                       from public, anon, authenticated;
revoke execute on function public.handle_new_user()                        from public, anon, authenticated;
revoke execute on function public.handle_user_email_change()               from public, anon, authenticated;
revoke execute on function public.on_order_created()                       from public, anon, authenticated;
revoke execute on function public.on_order_status_change()                 from public, anon, authenticated;
revoke execute on function public.after_order_status_change()              from public, anon, authenticated;
revoke execute on function public.orders_guard()                           from public, anon, authenticated;
revoke execute on function public.orders_rate_limit()                      from public, anon, authenticated;
revoke execute on function public.enforce_profile_privileged_columns()     from public, anon, authenticated;
revoke execute on function public.notifications_only_mark_read()           from public, anon, authenticated;
revoke execute on function public.refresh_product_rating()                 from public, anon, authenticated;
revoke execute on function public.set_review_verification()                from public, anon, authenticated;

-- Admin RPCs already refuse a stranger server-side, but there is no
-- reason for a signed-out visitor to be able to reach them at all.
revoke execute on function public.admin_overview()                                  from anon;
revoke execute on function public.admin_dashboard_stats(integer)                    from anon;
revoke execute on function public.admin_sales_report(timestamptz, timestamptz, text) from anon;
revoke execute on function public.admin_best_sellers(integer, integer)              from anon;
revoke execute on function public.admin_adjust_loyalty(uuid, integer, text)         from anon;
revoke execute on function public.admin_set_stock(uuid, integer, text)              from anon;
revoke execute on function public.admin_duplicate_product(uuid)                     from anon;
revoke execute on function public.admin_set_product_visibility(uuid, boolean)       from anon;
revoke execute on function public.admin_set_role(uuid, public.user_role, jsonb)     from anon;
revoke execute on function public.admin_update_order_status(
  uuid, public.order_status, text, text, text, text, timestamptz)                   from anon;
revoke execute on function public.admin_upsert_variant(
  uuid, text, text, text, integer, uuid, numeric, boolean)                          from anon;

-- Customer RPCs already raise AUTH_REQUIRED for a signed-out caller;
-- take them off the anonymous surface as well.
revoke execute on function public.get_or_create_cart()                     from anon;
revoke execute on function public.preview_cart(uuid, text, uuid)           from anon;
revoke execute on function public.apply_coupon_to_cart(text)               from anon;
revoke execute on function public.redeem_loyalty_reward(uuid)              from anon;
revoke execute on function public.cancel_my_order(uuid, text)              from anon;
revoke execute on function public.reorder(uuid)                            from anon;
revoke execute on function public.get_loyalty_card()                       from anon;
revoke execute on function public.place_order(
  uuid, public.payment_method, text, text, uuid)                           from anon;

-- =====================================================================
-- Hardening: pin the search path on the trigger functions that lacked
-- one, so a rogue schema on the search path cannot shadow a table name.
-- =====================================================================
alter function public.touch_updated_at()                   set search_path = public;
alter function public.unset_other_default_addresses()      set search_path = public;
alter function public.first_address_is_default()           set search_path = public;
alter function public.unset_other_primary_images()         set search_path = public;
alter function public.assert_variant_matches_product()     set search_path = public;
alter function public.normalise_coupon_code()              set search_path = public;
alter function public.loyalty_ledger_is_append_only()      set search_path = public;
