-- =====================================================================
-- BJmeem 0016 — finish the job 0015 started.
--
-- 0015 revoked EXECUTE from `anon`, which did nothing: Postgres grants
-- EXECUTE to PUBLIC on every new function, and `anon` inherits that.
-- Revoking from a role while PUBLIC still holds the grant leaves the
-- door open. PUBLIC has to go first; then each role is granted back
-- exactly what it needs.
--
-- These functions all refuse an unauthorised caller on their own, so
-- this is a second lock on a door that was already locked, not a fix
-- for an open one.
-- =====================================================================

-- ---------------------------------------------------- admin routines
-- Signed-in staff only. Each one re-checks is_staff()/has_permission()
-- internally; this just removes them from the anonymous API surface.
revoke execute on function public.admin_overview()                                   from public;
revoke execute on function public.admin_dashboard_stats(integer)                     from public;
revoke execute on function public.admin_sales_report(timestamptz, timestamptz, text) from public;
revoke execute on function public.admin_best_sellers(integer, integer)               from public;
revoke execute on function public.admin_adjust_loyalty(uuid, integer, text)          from public;
revoke execute on function public.admin_set_stock(uuid, integer, text)               from public;
revoke execute on function public.admin_duplicate_product(uuid)                      from public;
revoke execute on function public.admin_set_product_visibility(uuid, boolean)        from public;
revoke execute on function public.admin_set_role(uuid, public.user_role, jsonb)      from public;
revoke execute on function public.admin_update_order_status(
  uuid, public.order_status, text, text, text, text, timestamptz)                    from public;
revoke execute on function public.admin_upsert_variant(
  uuid, text, text, text, integer, uuid, numeric, boolean)                           from public;

grant execute on function public.admin_overview()                                   to authenticated;
grant execute on function public.admin_dashboard_stats(integer)                     to authenticated;
grant execute on function public.admin_sales_report(timestamptz, timestamptz, text) to authenticated;
grant execute on function public.admin_best_sellers(integer, integer)               to authenticated;
grant execute on function public.admin_adjust_loyalty(uuid, integer, text)          to authenticated;
grant execute on function public.admin_set_stock(uuid, integer, text)               to authenticated;
grant execute on function public.admin_duplicate_product(uuid)                      to authenticated;
grant execute on function public.admin_set_product_visibility(uuid, boolean)        to authenticated;
grant execute on function public.admin_set_role(uuid, public.user_role, jsonb)      to authenticated;
grant execute on function public.admin_update_order_status(
  uuid, public.order_status, text, text, text, text, timestamptz)                   to authenticated;
grant execute on function public.admin_upsert_variant(
  uuid, text, text, text, integer, uuid, numeric, boolean)                          to authenticated;

-- ------------------------------------------------- customer routines
-- Every one of these raises AUTH_REQUIRED without a session anyway.
revoke execute on function public.get_or_create_cart()                     from public;
revoke execute on function public.preview_cart(uuid, text, uuid)           from public;
revoke execute on function public.apply_coupon_to_cart(text)               from public;
revoke execute on function public.redeem_loyalty_reward(uuid)              from public;
revoke execute on function public.cancel_my_order(uuid, text)              from public;
revoke execute on function public.reorder(uuid)                            from public;
revoke execute on function public.get_loyalty_card()                       from public;
revoke execute on function public.place_order(
  uuid, public.payment_method, text, text, uuid)                           from public;

grant execute on function public.get_or_create_cart()                     to authenticated;
grant execute on function public.preview_cart(uuid, text, uuid)           to authenticated;
grant execute on function public.apply_coupon_to_cart(text)               to authenticated;
grant execute on function public.redeem_loyalty_reward(uuid)              to authenticated;
grant execute on function public.cancel_my_order(uuid, text)              to authenticated;
grant execute on function public.reorder(uuid)                            to authenticated;
grant execute on function public.get_loyalty_card()                       to authenticated;
grant execute on function public.place_order(
  uuid, public.payment_method, text, text, uuid)                          to authenticated;

-- ------------------------------------------------ deliberately public
-- track_order       — a guest with an order number and email may check it.
-- resolve_delivery_zone — the shop quotes delivery before you sign in.
-- auth_role / is_admin / is_staff / is_owner / has_permission
--                   — the access rules themselves call these, including
--                     the rules that decide what a signed-out visitor
--                     may see. Revoking them would blank the shop.
