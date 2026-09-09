-- =====================================================================
-- BJmeem 0011 — storage buckets, settings, tiers, rewards, zones, catalogue
-- Idempotent: safe to re-run.
-- =====================================================================

-- ---------------------------------------------------------- storage
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('product-images', 'product-images', true,  5242880,
   array['image/jpeg','image/png','image/webp','image/avif','image/svg+xml']),
  ('avatars',        'avatars',        true,  2097152,
   array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

-- Anyone may look at product photos; only staff may change them.
create policy "product images are public"
  on storage.objects for select
  using (bucket_id = 'product-images');

create policy "staff manage product images"
  on storage.objects for all to authenticated
  using (bucket_id = 'product-images' and public.is_staff())
  with check (bucket_id = 'product-images' and public.is_staff());

-- Avatars are public to read, but you may only write inside your own folder,
-- i.e. avatars/<your-uid>/whatever.png
create policy "avatars are public"
  on storage.objects for select
  using (bucket_id = 'avatars');

create policy "users manage own avatar"
  on storage.objects for all to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- --------------------------------------------------------- settings
insert into public.app_settings (key, value, description) values
  ('loyalty.points_per_kwd',        '1',     'Cozy Points earned per KWD of merchandise'),
  ('loyalty.expiry_months',         '12',    'Months until earned points expire'),
  ('loyalty.signup_bonus_points',   '25',    'Points credited on registration'),
  ('loyalty.birthday_bonus_points', '50',    'Points credited during birthday month'),
  ('loyalty.referral_bonus_points', '100',   'Points to referrer after referred first delivery'),
  ('delivery.default_fee',          '1.500', 'Fallback delivery fee in KWD'),
  ('delivery.free_threshold',       '20',    'Order value for free delivery in KWD'),
  ('tax.rate_percent',              '0',     'VAT percentage; Kuwait is currently 0'),
  ('inventory.low_stock_threshold', '5',     'Available units before a variant is flagged low'),
  ('store.currency',                '"KWD"', 'Display currency'),
  ('store.name',                    '"BJmeem"', 'Store name used in emails')
on conflict (key) do nothing;

-- ------------------------------------------------------------ tiers
insert into public.loyalty_tiers
  (code, name, min_points, max_points, points_multiplier, badge_color, sort_order, benefits) values
  ('cozy',  'Cozy Member',  0,   199,  1.00, '#F0A0B8', 1,
   '["Earn 1 Cozy Point per KWD","Member-only promotions"]'::jsonb),
  ('teddy', 'Teddy Member', 200, 499,  1.25, '#B98457', 2,
   '["Everything in Cozy","Extra birthday reward","Early access to new collections"]'::jsonb),
  ('dream', 'Dream Member', 500, null, 1.50, '#C96482', 3,
   '["Everything in Teddy","Higher point earning","Exclusive offers","Free-delivery campaigns"]'::jsonb)
on conflict (code) do nothing;

-- ---------------------------------------------------------- rewards
insert into public.loyalty_rewards
  (name, description, points_required, reward_type, reward_value, sort_order) values
  ('1 KWD off',   'Redeem 100 Cozy Points for 1 KWD off your order',  100, 'fixed_discount', 1.000, 1),
  ('3 KWD off',   'Redeem 250 Cozy Points for 3 KWD off your order',  250, 'fixed_discount', 3.000, 2),
  ('7 KWD off',   'Redeem 500 Cozy Points for 7 KWD off your order',  500, 'fixed_discount', 7.000, 3),
  ('Free delivery','Redeem 75 Cozy Points for free delivery',          75, 'free_delivery',  0.000, 0)
on conflict do nothing;

-- --------------------------------------------------- delivery zones
insert into public.delivery_zones
  (name, governorate, delivery_fee, estimated_min_hours, estimated_max_hours, free_delivery_threshold)
values
  ('Capital',        'Al Asimah',      1.500, 24, 48, 20.000),
  ('Hawalli',        'Hawalli',        1.500, 24, 48, 20.000),
  ('Farwaniya',      'Al Farwaniyah',  1.750, 24, 72, 20.000),
  ('Mubarak Al-Kabeer','Mubarak Al-Kabeer', 1.750, 24, 72, 20.000),
  ('Ahmadi',         'Al Ahmadi',      2.000, 48, 72, 25.000),
  ('Jahra',          'Al Jahra',       2.500, 48, 96, 25.000)
on conflict do nothing;

-- ------------------------------------------------------- categories
insert into public.categories (name, slug, description, sort_order) values
  ('Cotton Pajamas', 'cotton-pajamas', 'Soft breathable pajama collections made from comfortable cotton fabrics.', 1),
  ('Pajama Sets',    'pajama-sets',    'Matching top and bottom pajama sets, made to be lived in.', 2),
  ('Cute Prints',    'cute-prints',    'Teddy bears, hearts, bows, clouds, flowers and minimal cute patterns.', 3),
  ('Plain Cotton',   'plain-cotton',   'Simple solid-color cotton pajamas for a calm, quiet wardrobe.', 4),
  ('New Arrivals',   'new-arrivals',   'The latest BJmeem collections, fresh off the folding table.', 5),
  ('Best Sellers',   'best-sellers',   'The most popular BJmeem pajama sets, loved on repeat.', 6)
on conflict (slug) do nothing;

-- ---------------------------------------------------------- coupons
insert into public.coupons
  (code, description, discount_type, discount_value, minimum_order_amount,
   maximum_discount, usage_per_customer, first_order_only, is_public, is_active)
values
  ('WELCOME10', '10% off your first BJmeem order', 'percentage', 10, 10.000, 5.000, 1, true,  true, true),
  ('COZY5',     '5 KWD off orders over 30 KWD',    'fixed',       5, 30.000, null,  1, false, true, true),
  ('FREESHIP',  'Free delivery on any order',      'free_delivery', 0, 0.000, null, 2, false, true, true)
on conflict do nothing;

insert into public.coupons
  (code, description, discount_type, discount_value, minimum_order_amount,
   allowed_tiers, loyalty_members_only, usage_per_customer, is_public, is_active)
values
  ('DREAM15', 'Dream Member exclusive: 15% off', 'percentage', 15, 15.000,
   array['dream'], true, 3, false, true)
on conflict do nothing;

-- ---------------------------------------------- catalogue + variants
-- Mirrors the 24 products the storefront ships with, expanded into
-- size x colour variants with SKUs and opening stock.
do $$
declare
  v_rows jsonb := $json$[
   {"n":"Teddy Cloud Cotton Set","d":"Soft cotton pajama set with tiny teddy bear print.","p":12.900,"c":16.500,"pat":"teddy","cat":"best-sellers","cols":["Pink","Cream","Baby Blue"],"new":false,"best":true},
   {"n":"Cloud Nine Long Set","d":"Long-sleeve set with fluffy cloud print and piped edges.","p":14.500,"c":null,"pat":"cloud","cat":"best-sellers","cols":["Baby Blue","White","Pink"],"new":false,"best":true},
   {"n":"Bow Bow Shorts Set","d":"Cropped tee and shorts with tiny satin bows.","p":9.900,"c":12.000,"pat":"bow","cat":"best-sellers","cols":["Pink","Cream"],"new":false,"best":true},
   {"n":"Honey Bear Oversized Tee","d":"Oversized sleep tee with a big honey teddy on the back.","p":7.500,"c":null,"pat":"teddy","cat":"cute-prints","cols":["Mocha","Cream"],"new":false,"best":true},
   {"n":"Milk Cotton Plain Set","d":"The quiet one — plain cotton set with a rounded collar.","p":11.500,"c":null,"pat":"plain","cat":"plain-cotton","cols":["White","Cream"],"new":false,"best":true},
   {"n":"Sweetheart Button Set","d":"Button-down top and long pants covered in tiny hearts.","p":15.900,"c":18.900,"pat":"heart","cat":"pajama-sets","cols":["Pink","White"],"new":false,"best":true},
   {"n":"Cotton Cloud Wide Pants","d":"Wide-leg cotton pants with a soft covered waistband.","p":8.900,"c":null,"pat":"plain","cat":"plain-cotton","cols":["Cream","Baby Blue","Mocha"],"new":false,"best":false},
   {"n":"Blossom Cotton Set","d":"Tiny pressed flowers on breathable cotton poplin.","p":13.900,"c":null,"pat":"floral","cat":"cute-prints","cols":["Cream","Pink"],"new":false,"best":false},
   {"n":"Bear Hug Hoodie Set","d":"Brushed cotton hoodie set with little bear ears on the hood.","p":18.900,"c":22.500,"pat":"teddy","cat":"new-arrivals","cols":["Mocha","Pink"],"new":true,"best":false},
   {"n":"Vanilla Stripe Set","d":"Soft vertical stripes on light cotton — very Sunday morning.","p":12.500,"c":null,"pat":"stripe","cat":"new-arrivals","cols":["Cream","Baby Blue"],"new":true,"best":false},
   {"n":"Peach Heart Shorts Set","d":"Camisole and shorts with a scattered heart print.","p":8.500,"c":null,"pat":"heart","cat":"new-arrivals","cols":["Pink","White"],"new":true,"best":false},
   {"n":"Snow Cotton Nightdress","d":"Loose cotton nightdress with a soft ruffled hem.","p":10.900,"c":null,"pat":"plain","cat":"new-arrivals","cols":["White","Pink"],"new":true,"best":false},
   {"n":"Latte Bow Pants Set","d":"Warm latte tones with tiny bows down the side seam.","p":14.900,"c":null,"pat":"bow","cat":"new-arrivals","cols":["Mocha","Cream"],"new":true,"best":false},
   {"n":"Sleepy Cloud Oversized Set","d":"Extra-roomy set for people who starfish in bed.","p":16.500,"c":19.900,"pat":"cloud","cat":"new-arrivals","cols":["Baby Blue","Cream"],"new":true,"best":false},
   {"n":"Rosewater Plain Shorts Set","d":"Solid dusty-rose cotton, tee and shorts.","p":7.900,"c":null,"pat":"plain","cat":"plain-cotton","cols":["Pink","Cream"],"new":false,"best":false},
   {"n":"Teddy Picnic Set","d":"Bears having a picnic, printed small and soft.","p":13.500,"c":null,"pat":"teddy","cat":"cute-prints","cols":["Cream","Baby Blue"],"new":false,"best":false},
   {"n":"Bow Ribbon Nightdress","d":"Cotton nightdress finished with a ribbon at the waist.","p":11.900,"c":null,"pat":"bow","cat":"cute-prints","cols":["Pink","White"],"new":false,"best":false},
   {"n":"Warm Milk Cotton Robe","d":"Lightweight cotton robe that layers over everything.","p":16.900,"c":null,"pat":"plain","cat":"plain-cotton","cols":["Cream","White","Mocha"],"new":false,"best":false},
   {"n":"Petal Floral Long Set","d":"Long sleeves, long pants, small floral, big comfort.","p":15.500,"c":null,"pat":"floral","cat":"cute-prints","cols":["Pink","Cream"],"new":false,"best":false},
   {"n":"Soft Stripe Shorts Set","d":"Breezy striped shorts set for warm Kuwait nights.","p":9.500,"c":null,"pat":"stripe","cat":"pajama-sets","cols":["Baby Blue","White"],"new":false,"best":false},
   {"n":"Cocoa Teddy Pants Set","d":"Cocoa cotton with a teddy patch on the pocket.","p":14.900,"c":17.500,"pat":"teddy","cat":"cute-prints","cols":["Mocha","Cream"],"new":false,"best":false},
   {"n":"Angel Heart Camisole Set","d":"Delicate camisole with a matching short — hearts all over.","p":9.900,"c":null,"pat":"heart","cat":"pajama-sets","cols":["White","Pink"],"new":false,"best":false},
   {"n":"Pure Cotton Everyday Set","d":"The one you will reach for every single night.","p":12.000,"c":null,"pat":"plain","cat":"plain-cotton","cols":["Cream","White","Baby Blue"],"new":false,"best":false},
   {"n":"Marshmallow Cloud Shorts","d":"Cloud-print shorts with the softest elastic waist.","p":6.900,"c":null,"pat":"cloud","cat":"cute-prints","cols":["White","Pink"],"new":false,"best":false}
  ]$json$::jsonb;

  r          jsonb;
  v_slug     text;
  v_cat      uuid;
  v_product  uuid;
  v_colour   text;
  v_size     text;
  v_sizes    text[] := array['XS','S','M','L','XL'];
  v_sku_seq  integer := 0;
begin
  for r in select * from jsonb_array_elements(v_rows)
  loop
    v_slug := lower(regexp_replace(trim(r ->> 'n'), '[^a-zA-Z0-9]+', '-', 'g'));
    v_slug := trim(both '-' from v_slug);

    select id into v_cat from public.categories where slug = r ->> 'cat';

    insert into public.products (
      name, slug, description, category_id, price, compare_at_price,
      material, fabric, pattern, care_instructions,
      is_active, is_new_arrival, is_best_seller, is_featured)
    values (
      r ->> 'n', v_slug, r ->> 'd', v_cat,
      (r ->> 'p')::numeric,
      nullif(r ->> 'c', '')::numeric,
      '100% cotton',
      case when (r ->> 'pat') = 'plain'
           then '100% breathable cotton'
           else '100% breathable cotton, printed with water-based inks' end,
      r ->> 'pat',
      'Machine wash cold on a gentle cycle. Wash inside out with similar colors. Tumble dry low.',
      true,
      (r ->> 'new')::boolean,
      (r ->> 'best')::boolean,
      (r ->> 'best')::boolean)
    on conflict (slug) do update set description = excluded.description
    returning id into v_product;

    -- Expand colour x size into stock-keeping variants.
    for v_colour in select jsonb_array_elements_text(r -> 'cols')
    loop
      foreach v_size in array v_sizes
      loop
        v_sku_seq := v_sku_seq + 1;
        insert into public.product_variants (
          product_id, size, color, sku, stock_quantity)
        values (
          v_product, v_size, v_colour,
          'BJM-' || upper(left(regexp_replace(v_slug, '-', '', 'g'), 8)) || '-'
                 || upper(left(regexp_replace(v_colour, '\s', '', 'g'), 3)) || '-' || v_size,
          25)
        on conflict (product_id, size, color) do nothing;
      end loop;
    end loop;
  end loop;
end $$;
