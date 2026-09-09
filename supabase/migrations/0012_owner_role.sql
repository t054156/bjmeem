-- =====================================================================
-- BJmeem 0012 — add the `owner` role
--
-- This migration contains ONLY the enum change. Postgres will not let a
-- newly added enum value be *used* in the same transaction that adds it,
-- so everything that references 'owner' lives in 0013.
-- =====================================================================

alter type public.user_role add value if not exists 'owner';
