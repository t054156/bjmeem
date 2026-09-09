/* =====================================================================
   BJmeem — script.js
   Front-end only. All persistence is localStorage / sessionStorage so the
   data layer can be swapped for a real API later (see API_STUB at bottom).

   1. Helpers          5. Router          9.  Cart
   2. Artwork (SVG)    6. Home            10. Search
   3. Catalog          7. Shop + filters  11. Auth
   4. State/storage    8. Product page    12. Checkout + UI chrome
   ===================================================================== */
(function () {
  'use strict';

  /* ---------------------------------------------------------------
     1. HELPERS
  --------------------------------------------------------------- */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const money = (n) => Number(n).toFixed(3);
  const kwd = (n) => `${money(n)} <span class="kwd">KWD</span>`;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const debounce = (fn, ms = 180) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  const store = {
    get(k, fb) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch (e) { return fb; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} },
    sget(k, fb) { try { const v = sessionStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch (e) { return fb; } },
    sset(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    sdel(k) { try { sessionStorage.removeItem(k); } catch (e) {} }
  };

  const KEY = { CART: 'bjmeem_cart', WISH: 'bjmeem_wishlist', USER: 'bjmeem_user', USERS: 'bjmeem_users', ORDERS: 'bjmeem_orders', NEWS: 'bjmeem_news' };

  /* ---------------------------------------------------------------
     2. ARTWORK — every product image is generated as an inline SVG,
        so the store ships with zero external image dependencies.
  --------------------------------------------------------------- */
  const COLORS = {
    'Pink':       { key: 'pink',  hex: '#F7C9D6', shade: '#E9A9BE', accent: '#C96482', bg1: '#FDF2F5', bg2: '#F9E3EA' },
    'Cream':      { key: 'cream', hex: '#F5E7D6', shade: '#E4CFB6', accent: '#B98457', bg1: '#FDF8F1', bg2: '#F6EBDC' },
    'White':      { key: 'white', hex: '#FAF7F4', shade: '#E7DFD7', accent: '#B4A296', bg1: '#FCFAF8', bg2: '#F2ECE6' },
    'Baby Blue':  { key: 'blue',  hex: '#D2E2F1', shade: '#B2CBE3', accent: '#5D82A6', bg1: '#F4F8FC', bg2: '#E4EFF8' },
    'Mocha':      { key: 'brown', hex: '#DCBE9F', shade: '#C6A183', accent: '#8A5F3E', bg1: '#FBF4EC', bg2: '#F2E4D4' }
  };
  const COLOR_FILTERS = [
    { key: 'pink', label: 'Pink', hex: '#F7C9D6' },
    { key: 'cream', label: 'Cream', hex: '#F5E7D6' },
    { key: 'white', label: 'White', hex: '#FAF7F4' },
    { key: 'blue', label: 'Blue', hex: '#D2E2F1' },
    { key: 'brown', label: 'Brown', hex: '#DCBE9F' }
  ];

  const MOTIF = {
    teddy: (c) => `<g fill="${c}"><circle cx="8" cy="9" r="3.6"/><circle cx="22" cy="9" r="3.6"/><circle cx="15" cy="18" r="8"/><ellipse cx="15" cy="20.5" rx="4.2" ry="3.4" fill="#ffffff" opacity=".6"/><circle cx="11.6" cy="15" r="1.3" fill="#ffffff" opacity=".85"/><circle cx="18.4" cy="15" r="1.3" fill="#ffffff" opacity=".85"/></g>`,
    heart: (c) => `<path d="M15 26C15 26 4.5 19 4.5 12.4A5.4 5.4 0 0 1 15 9.4 5.4 5.4 0 0 1 25.5 12.4C25.5 19 15 26 15 26Z" fill="${c}"/>`,
    bow:   (c) => `<g fill="${c}"><path d="M15 15 3.5 7.5v15z"/><path d="M15 15 26.5 7.5v15z"/><circle cx="15" cy="15" r="3.6"/><path d="M13 18l-2.5 8M17 18l2.5 8" stroke="${c}" stroke-width="2.2" stroke-linecap="round" fill="none"/></g>`,
    cloud: (c) => `<g fill="${c}"><circle cx="9" cy="18" r="6"/><circle cx="17" cy="14" r="8.4"/><circle cx="24" cy="18.5" r="5.4"/><rect x="8" y="17.5" width="17" height="6.5" rx="3.2"/></g>`,
    floral:(c) => `<g fill="${c}"><circle cx="15" cy="7.5" r="4.2"/><circle cx="22.5" cy="13" r="4.2"/><circle cx="19.6" cy="22" r="4.2"/><circle cx="10.4" cy="22" r="4.2"/><circle cx="7.5" cy="13" r="4.2"/><circle cx="15" cy="15.5" r="3.4" fill="#ffffff" opacity=".85"/></g>`,
    stripe:(c) => `<g stroke="${c}" stroke-width="3" opacity=".85"><path d="M-4 8h38M-4 22h38"/></g>`,
    plain: () => ''
  };

  const teddyArt = (x, y, s) => `<g transform="translate(${x},${y}) scale(${s})">
    <circle cx="14" cy="15" r="11" fill="#C9976F"/><circle cx="54" cy="15" r="11" fill="#C9976F"/>
    <circle cx="14" cy="15" r="5.6" fill="#F4C6D2"/><circle cx="54" cy="15" r="5.6" fill="#F4C6D2"/>
    <circle cx="34" cy="36" r="22" fill="#B98457"/>
    <ellipse cx="34" cy="43" rx="12.5" ry="10" fill="#F3E2D2"/>
    <ellipse cx="34" cy="38.6" rx="3.6" ry="2.7" fill="#5A4034"/>
    <path d="M34 41.3v3.2M34 44.5c-2 2.3-5.2 1.5-5.2-.8M34 44.5c2 2.3 5.2 1.5 5.2-.8" stroke="#5A4034" stroke-width="2" fill="none" stroke-linecap="round"/>
    <circle cx="25.5" cy="31" r="2.7" fill="#4A332A"/><circle cx="42.5" cy="31" r="2.7" fill="#4A332A"/>
    <circle cx="20" cy="38" r="3.4" fill="#E7A9B8" opacity=".55"/><circle cx="48" cy="38" r="3.4" fill="#E7A9B8" opacity=".55"/>
  </g>`;

  const bowArt = (x, y, s, c) => `<g transform="translate(${x},${y}) scale(${s})" fill="${c}">
    <path d="M0 0-16-10v20z"/><path d="M0 0 16-10v20z"/><circle cx="0" cy="0" r="5"/></g>`;

  const svgURI = (inner, w, h) =>
    'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${inner}</svg>`);

  const imgCache = new Map();

  /** Product artwork. variant 'flat' = flat-lay set, 'fold' = folded stack. */
  function productImage(pattern, colorName, variant) {
    const ck = `${pattern}|${colorName}|${variant}`;
    if (imgCache.has(ck)) return imgCache.get(ck);
    const c = COLORS[colorName] || COLORS.Pink;
    const motif = (MOTIF[pattern] || MOTIF.plain)(c.accent);
    const hasMotif = pattern !== 'plain';

    const defs = `<defs>
      <linearGradient id="bg" x1="0" y1="0" x2="0.3" y2="1"><stop offset="0" stop-color="${c.bg1}"/><stop offset="1" stop-color="${c.bg2}"/></linearGradient>
      <linearGradient id="cloth" x1="0" y1="0" x2="0.4" y2="1"><stop offset="0" stop-color="${c.hex}"/><stop offset="1" stop-color="${c.shade}"/></linearGradient>
      <pattern id="pt" width="52" height="52" patternUnits="userSpaceOnUse" patternTransform="rotate(9)">
        <g transform="translate(11,11) scale(0.62)" opacity="${pattern === 'stripe' ? '.5' : '.62'}">${motif}</g>
      </pattern>
      <filter id="sh" x="-30%" y="-30%" width="160%" height="160%">
        <feDropShadow dx="0" dy="7" stdDeviation="9" flood-color="#9C7358" flood-opacity="0.20"/>
      </filter>
    </defs>`;

    const bg = `<rect width="400" height="500" fill="url(#bg)"/>
      <circle cx="330" cy="86" r="66" fill="#ffffff" opacity=".55"/>
      <circle cx="58" cy="418" r="80" fill="#ffffff" opacity=".40"/>
      <g opacity=".5" fill="${c.accent}"><circle cx="42" cy="70" r="3.4"/><circle cx="72" cy="46" r="2.2"/><circle cx="358" cy="404" r="3"/><circle cx="330" cy="440" r="2"/></g>`;

    let art;
    if (variant === 'fold') {
      const fold = (x, y, w, h, fill) =>
        `<g><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="17" fill="${fill}"/>
         <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="17" fill="url(#pt)" opacity="${hasMotif ? .95 : 0}"/>
         <path d="M${x + 12} ${y + h - 9}h${w - 24}" stroke="${c.accent}" stroke-opacity=".25" stroke-width="2.6" stroke-linecap="round"/></g>`;
      art = `<g filter="url(#sh)">
        ${fold(78, 330, 244, 62, 'url(#cloth)')}
        ${fold(90, 262, 220, 60, c.hex)}
        ${fold(102, 196, 196, 58, 'url(#cloth)')}
        <rect x="176" y="188" width="34" height="212" fill="${c.accent}" opacity=".18" rx="6"/>
        ${bowArt(193, 190, 1.25, c.accent)}
      </g>
      ${teddyArt(268, 372, 1.05)}
      <g fill="#ffffff" opacity=".85"><circle cx="96" cy="150" r="15"/><circle cx="120" cy="141" r="20"/><circle cx="143" cy="151" r="13"/><rect x="94" y="150" width="52" height="16" rx="8"/></g>`;
    } else {
      art = `<g filter="url(#sh)">
        <path d="M152 152C165 139 180 134 200 134s35 5 48 18l52 25-19 51-25-14v112c-24 11-88 11-112 0V214l-25 14-19-51z" fill="url(#cloth)"/>
        <path d="M152 152C165 139 180 134 200 134s35 5 48 18l52 25-19 51-25-14v112c-24 11-88 11-112 0V214l-25 14-19-51z" fill="url(#pt)" opacity="${hasMotif ? .95 : 0}"/>
        <path d="M181 139l19 24 19-24" fill="none" stroke="${c.accent}" stroke-opacity=".45" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>
        <rect x="214" y="252" width="44" height="38" rx="9" fill="${c.accent}" opacity=".14"/>
        ${bowArt(200, 176, .85, c.accent)}
      </g>
      <g filter="url(#sh)">
        <path d="M150 356h100l9 48-6 74h-38l-13-62-13 62h-38l-6-74z" fill="url(#cloth)"/>
        <path d="M150 356h100l9 48-6 74h-38l-13-62-13 62h-38l-6-74z" fill="url(#pt)" opacity="${hasMotif ? .95 : 0}"/>
        <rect x="146" y="346" width="108" height="20" rx="10" fill="${c.shade}"/>
        <path d="M156 356h88" stroke="${c.accent}" stroke-opacity=".3" stroke-width="2.4" stroke-linecap="round"/>
      </g>
      ${teddyArt(300, 400, .78)}`;
    }
    const uri = svgURI(defs + bg + art, 400, 500);
    imgCache.set(ck, uri);
    return uri;
  }

  function heroArt() {
    const inner = `<defs>
      <linearGradient id="bd" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#F6E9DC"/></linearGradient>
      <linearGradient id="bl" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FBD9E3"/><stop offset="1" stop-color="#F0A8BF"/></linearGradient>
      <filter id="s2" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#A0785F" flood-opacity=".18"/></filter>
    </defs>
    <circle cx="410" cy="70" r="46" fill="#FBEEDC"/>
    <g fill="#FFFFFF" opacity=".9"><circle cx="80" cy="70" r="26"/><circle cx="116" cy="56" r="34"/><circle cx="152" cy="72" r="22"/><rect x="78" y="70" width="76" height="24" rx="12"/></g>
    <g fill="#D8B99A" opacity=".7"><circle cx="356" cy="150" r="4"/><circle cx="392" cy="186" r="2.6"/><circle cx="60" cy="188" r="3.4"/></g>
    <g filter="url(#s2)">
      <rect x="46" y="250" width="420" height="150" rx="34" fill="url(#bd)"/>
      <rect x="46" y="316" width="420" height="84" rx="30" fill="url(#bl)"/>
      <path d="M46 330c70 22 350 22 420 0" fill="none" stroke="#ffffff" stroke-opacity=".6" stroke-width="5" stroke-linecap="round"/>
      <rect x="72" y="252" width="118" height="70" rx="24" fill="#FFFFFF"/>
      <rect x="86" y="262" width="90" height="50" rx="18" fill="#FDEFF3"/>
      <rect x="66" y="392" width="18" height="42" rx="8" fill="#C9976F"/>
      <rect x="428" y="392" width="18" height="42" rx="8" fill="#C9976F"/>
    </g>
    ${teddyArt(196, 196, 1.5)}
    <g filter="url(#s2)">
      <rect x="330" y="252" width="120" height="26" rx="12" fill="#F5E7D6"/>
      <rect x="336" y="224" width="108" height="24" rx="11" fill="#FBD9E3"/>
      <rect x="342" y="198" width="96" height="22" rx="10" fill="#FFFFFF"/>
      ${bowArt(390, 196, .8, '#E17E9C')}
    </g>`;
    return svgURI(inner, 520, 460);
  }

  function bannerArt() {
    const inner = `<defs><filter id="s3" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="8" stdDeviation="10" flood-color="#A0785F" flood-opacity=".18"/></filter></defs>
    <circle cx="200" cy="150" r="120" fill="#FFFFFF" opacity=".65"/>
    <g filter="url(#s3)">
      <path d="M110 96h180" stroke="#C9976F" stroke-width="7" stroke-linecap="round"/>
      <path d="M150 96v-16a22 22 0 0 1 44 0" fill="none" stroke="#C9976F" stroke-width="5"/>
      <path d="M126 116c10-12 24-18 40-18s30 6 40 18l30 16-11 30-15-9v66c-14 7-52 7-66 0v-66l-15 9-11-30z" fill="#FBD9E3"/>
      <path d="M232 116c10-12 24-18 40-18s30 6 40 18l26 14-10 28-14-8v62c-13 6-48 6-62 0v-62l-14 8-10-28z" fill="#F5E7D6"/>
      ${bowArt(166, 132, .8, '#E17E9C')}
    </g>
    ${teddyArt(120, 214, 1.15)}
    <g fill="#FFFFFF" opacity=".9"><circle cx="316" cy="238" r="18"/><circle cx="340" cy="228" r="24"/><circle cx="362" cy="240" r="15"/><rect x="314" y="238" width="50" height="18" rx="9"/></g>`;
    return svgURI(inner, 420, 330);
  }

  /* ---------------------------------------------------------------
     3. CATALOG
  --------------------------------------------------------------- */
  const CATS = [
    { key: 'cotton-pajamas', name: 'Cotton Pajamas', desc: 'Soft breathable pajama collections made from comfortable cotton fabrics.', tag: 'Everyday soft', art: ['teddy', 'Cream', 'flat'] },
    { key: 'pajama-sets',    name: 'Pajama Sets',    desc: 'Matching top and bottom pajama sets, made to be lived in.',              tag: 'Matching', art: ['heart', 'Pink', 'flat'] },
    { key: 'cute-prints',    name: 'Cute Prints',    desc: 'Teddy bears, hearts, bows, clouds, flowers and minimal cute patterns.',  tag: 'Printed', art: ['cloud', 'Baby Blue', 'fold'] },
    { key: 'plain-cotton',   name: 'Plain Cotton',   desc: 'Simple solid-color cotton pajamas for a calm, quiet wardrobe.',          tag: 'Solid', art: ['plain', 'White', 'fold'] },
    { key: 'new-arrivals',   name: 'New Arrivals',   desc: 'The latest BJmeem collections, fresh off the folding table.',            tag: 'Just in', art: ['bow', 'Mocha', 'flat'] },
    { key: 'best-sellers',   name: 'Best Sellers',   desc: 'The most popular BJmeem pajama sets, loved on repeat.',                  tag: 'Loved', art: ['floral', 'Pink', 'fold'] }
  ];
  const CAT_NAME = Object.fromEntries(CATS.map((c) => [c.key, c.name]));

  const PATTERNS = [
    { key: 'teddy', label: 'Teddy' }, { key: 'heart', label: 'Heart' }, { key: 'bow', label: 'Bow' },
    { key: 'floral', label: 'Floral' }, { key: 'cloud', label: 'Cloud' }, { key: 'stripe', label: 'Stripe' }, { key: 'plain', label: 'Plain' }
  ];
  const ALL_SIZES = ['XS', 'S', 'M', 'L', 'XL'];

  const RAW = [
    ['Teddy Cloud Cotton Set', 'Soft cotton pajama set with tiny teddy bear print.', 12.9, 16.5, 'teddy', ['Pink', 'Cream', 'Baby Blue'], ['cotton-pajamas', 'pajama-sets', 'cute-prints', 'best-sellers'], 4.9, 214, 980, ['long sleeve', 'set', 'teddy', 'cotton']],
    ['Cloud Nine Long Set', 'Long-sleeve set with fluffy cloud print and piped edges.', 14.5, 0, 'cloud', ['Baby Blue', 'White', 'Pink'], ['cotton-pajamas', 'pajama-sets', 'cute-prints', 'best-sellers'], 4.8, 168, 870, ['long sleeve', 'set', 'cloud', 'cotton']],
    ['Bow Bow Shorts Set', 'Cropped tee and shorts with tiny satin bows.', 9.9, 12.0, 'bow', ['Pink', 'Cream'], ['pajama-sets', 'cute-prints', 'best-sellers'], 4.7, 141, 760, ['shorts', 'set', 'bow', 'short sleeve']],
    ['Honey Bear Oversized Tee', 'Oversized sleep tee with a big honey teddy on the back.', 7.5, 0, 'teddy', ['Mocha', 'Cream'], ['cotton-pajamas', 'cute-prints', 'best-sellers'], 4.8, 122, 690, ['oversized', 'tee', 'teddy', 'cotton']],
    ['Milk Cotton Plain Set', 'The quiet one — plain cotton set with a rounded collar.', 11.5, 0, 'plain', ['White', 'Cream'], ['cotton-pajamas', 'pajama-sets', 'plain-cotton', 'best-sellers'], 4.6, 98, 640, ['plain', 'set', 'cotton', 'long sleeve']],
    ['Sweetheart Button Set', 'Button-down top and long pants covered in tiny hearts.', 15.9, 18.9, 'heart', ['Pink', 'White'], ['pajama-sets', 'cute-prints', 'best-sellers'], 4.9, 187, 830, ['button', 'set', 'heart', 'long sleeve']],
    ['Cotton Cloud Wide Pants', 'Wide-leg cotton pants with a soft covered waistband.', 8.9, 0, 'plain', ['Cream', 'Baby Blue', 'Mocha'], ['cotton-pajamas', 'plain-cotton'], 4.5, 76, 410, ['pants', 'plain', 'cotton', 'wide leg']],
    ['Blossom Cotton Set', 'Tiny pressed flowers on breathable cotton poplin.', 13.9, 0, 'floral', ['Cream', 'Pink'], ['cotton-pajamas', 'pajama-sets', 'cute-prints'], 4.7, 88, 380, ['floral', 'set', 'cotton', 'long sleeve']],
    ['Bear Hug Hoodie Set', 'Brushed cotton hoodie set with little bear ears on the hood.', 18.9, 22.5, 'teddy', ['Mocha', 'Pink'], ['cotton-pajamas', 'pajama-sets', 'cute-prints', 'new-arrivals'], 4.9, 64, 300, ['hoodie', 'set', 'teddy', 'winter']],
    ['Vanilla Stripe Set', 'Soft vertical stripes on light cotton — very Sunday morning.', 12.5, 0, 'stripe', ['Cream', 'Baby Blue'], ['cotton-pajamas', 'pajama-sets', 'new-arrivals'], 4.5, 52, 260, ['stripe', 'set', 'cotton', 'long sleeve']],
    ['Peach Heart Shorts Set', 'Camisole and shorts with a scattered heart print.', 8.5, 0, 'heart', ['Pink', 'White'], ['pajama-sets', 'cute-prints', 'new-arrivals'], 4.6, 71, 340, ['shorts', 'set', 'heart', 'sleeveless']],
    ['Snow Cotton Nightdress', 'Loose cotton nightdress with a soft ruffled hem.', 10.9, 0, 'plain', ['White', 'Pink'], ['cotton-pajamas', 'plain-cotton', 'new-arrivals'], 4.4, 45, 210, ['nightdress', 'plain', 'cotton']],
    ['Latte Bow Pants Set', 'Warm latte tones with tiny bows down the side seam.', 14.9, 0, 'bow', ['Mocha', 'Cream'], ['pajama-sets', 'cute-prints', 'new-arrivals'], 4.7, 58, 290, ['set', 'bow', 'long sleeve', 'pants']],
    ['Sleepy Cloud Oversized Set', 'Extra-roomy set for people who starfish in bed.', 16.5, 19.9, 'cloud', ['Baby Blue', 'Cream'], ['cotton-pajamas', 'pajama-sets', 'cute-prints', 'new-arrivals'], 4.8, 61, 320, ['oversized', 'set', 'cloud', 'long sleeve']],
    ['Rosewater Plain Shorts Set', 'Solid dusty-rose cotton, tee and shorts.', 7.9, 0, 'plain', ['Pink', 'Cream'], ['pajama-sets', 'plain-cotton'], 4.3, 39, 230, ['shorts', 'plain', 'set', 'short sleeve']],
    ['Teddy Picnic Set', 'Bears having a picnic, printed small and soft.', 13.5, 0, 'teddy', ['Cream', 'Baby Blue'], ['cotton-pajamas', 'pajama-sets', 'cute-prints'], 4.6, 67, 300, ['set', 'teddy', 'cotton', 'long sleeve']],
    ['Bow Ribbon Nightdress', 'Cotton nightdress finished with a ribbon at the waist.', 11.9, 0, 'bow', ['Pink', 'White'], ['cotton-pajamas', 'cute-prints'], 4.5, 42, 190, ['nightdress', 'bow', 'cotton']],
    ['Warm Milk Cotton Robe', 'Lightweight cotton robe that layers over everything.', 16.9, 0, 'plain', ['Cream', 'White', 'Mocha'], ['cotton-pajamas', 'plain-cotton'], 4.7, 54, 250, ['robe', 'plain', 'cotton', 'layer']],
    ['Petal Floral Long Set', 'Long sleeves, long pants, small floral, big comfort.', 15.5, 0, 'floral', ['Pink', 'Cream'], ['cotton-pajamas', 'pajama-sets', 'cute-prints'], 4.6, 49, 240, ['set', 'floral', 'long sleeve', 'cotton']],
    ['Soft Stripe Shorts Set', 'Breezy striped shorts set for warm Kuwait nights.', 9.5, 0, 'stripe', ['Baby Blue', 'White'], ['pajama-sets', 'plain-cotton'], 4.4, 44, 260, ['shorts', 'stripe', 'set', 'short sleeve']],
    ['Cocoa Teddy Pants Set', 'Cocoa cotton with a teddy patch on the pocket.', 14.9, 17.5, 'teddy', ['Mocha', 'Cream'], ['cotton-pajamas', 'pajama-sets', 'cute-prints'], 4.8, 73, 350, ['set', 'teddy', 'pants', 'long sleeve']],
    ['Angel Heart Camisole Set', 'Delicate camisole with a matching short — hearts all over.', 9.9, 0, 'heart', ['White', 'Pink'], ['pajama-sets', 'cute-prints'], 4.5, 51, 270, ['camisole', 'heart', 'set', 'sleeveless']],
    ['Pure Cotton Everyday Set', 'The one you will reach for every single night.', 12.0, 0, 'plain', ['Cream', 'White', 'Baby Blue'], ['cotton-pajamas', 'pajama-sets', 'plain-cotton'], 4.7, 96, 520, ['plain', 'set', 'cotton', 'everyday']],
    ['Marshmallow Cloud Shorts', 'Cloud-print shorts with the softest elastic waist.', 6.9, 0, 'cloud', ['White', 'Pink'], ['cotton-pajamas', 'cute-prints', 'plain-cotton'], 4.4, 37, 200, ['shorts', 'cloud', 'cotton']]
  ];

  // Replaced at runtime by the live Supabase catalogue when the store is
  // connected (see loadCatalogFromSupabase). Until then this built-in list is
  // the catalogue, so the site works standalone.
  let PRODUCTS = RAW.map((r, i) => {
    const [name, desc, price, old, pattern, colors, cats, rating, reviews, sold, tags] = r;
    return {
      id: slug(name), name, desc, price, old: old || 0, pattern, colors, cats,
      rating, reviews, sold, tags,
      sizes: i % 7 === 3 ? ['S', 'M', 'L', 'XL'] : i % 5 === 1 ? ['XS', 'S', 'M', 'L'] : ALL_SIZES,
      added: RAW.length - i, // higher = newer
      fabric: pattern === 'plain' ? '100% breathable cotton' : '100% breathable cotton, printed with water-based inks'
    };
  });
  const byId = (id) => PRODUCTS.find((p) => p.id === id);

  // Real uploaded photos win over the generated artwork when a product has them.
  const imgs = (p, color) => {
    const real = p.imageUrls ?? [];
    if (real.length) return [real[0], real[1] ?? real[0]];
    return [productImage(p.pattern, color, 'flat'), productImage(p.pattern, color, 'fold')];
  };

  /* ---------------------------------------------------------------
     LIVE CATALOGUE
     When js/config.js holds a Supabase project, products, prices, images
     and stock all come from the database, so the storefront reflects
     whatever the owner does in the admin dashboard with no code changes.
     Without a project it silently keeps the built-in demo catalogue.
  --------------------------------------------------------------- */
  const live = { on: false, api: null, variants: new Map() };

  /** available units for a size+colour; Infinity when running unconnected. */
  function availableFor(p, size, color) {
    if (!live.on) return Infinity;
    const v = live.variants.get(`${p.id}|${size}|${color}`);
    return v ? v.available : 0;
  }
  function variantIdFor(p, size, color) {
    return live.variants.get(`${p.id}|${size}|${color}`)?.id ?? null;
  }

  /** Map a Supabase product row onto the shape the storefront already uses. */
  function mapProduct(row, index, total) {
    const variants = (row.variants ?? []).filter((v) => v.is_active);
    const colors = [...new Set(variants.map((v) => v.color))];
    const sizes = [...new Set(variants.map((v) => v.size))];

    const cats = [];
    if (row.category?.slug) cats.push(row.category.slug);
    if (row.is_new_arrival) cats.push('new-arrivals');
    if (row.is_best_seller) cats.push('best-sellers');
    if (row.pattern && row.pattern !== 'plain' && !cats.includes('cute-prints')) {
      cats.push('cute-prints');
    }
    if (row.pattern === 'plain' && !cats.includes('plain-cotton')) cats.push('plain-cotton');

    variants.forEach((v) => {
      live.variants.set(`${row.slug}|${v.size}|${v.color}`, {
        id: v.id,
        available: Math.max((v.stock_quantity ?? 0) - (v.reserved_quantity ?? 0), 0),
      });
    });

    const images = [...(row.images ?? [])]
      .sort((a, b) => (b.is_primary - a.is_primary) || (a.sort_order - b.sort_order))
      .map((i) => i.image_url);

    return {
      id: row.slug,
      productId: row.id,
      name: row.name,
      desc: row.description ?? '',
      price: Number(row.price),
      old: row.compare_at_price ? Number(row.compare_at_price) : 0,
      pattern: row.pattern || 'plain',
      colors: colors.length ? colors : ['Cream'],
      cats,
      rating: Number(row.rating_average) || 4.6,
      reviews: row.rating_count ?? 0,
      // No public "units sold" column; rating volume is a reasonable stand-in
      // for the Best Selling sort, and Best Seller stays a curated flag.
      sold: (row.rating_count ?? 0) + (row.is_best_seller ? 1000 : 0),
      tags: [row.pattern, row.fabric, row.material, row.name]
        .filter(Boolean).join(' ').toLowerCase().split(/\s+/),
      sizes: sizes.length ? sizes : ['S', 'M', 'L'],
      added: total - index,
      fabric: row.fabric || '100% breathable cotton',
      imageUrls: images,
      totalAvailable: variants.reduce(
        (s, v) => s + Math.max((v.stock_quantity ?? 0) - (v.reserved_quantity ?? 0), 0), 0),
    };
  }

  async function loadCatalogFromSupabase(api) {
    const rows = await api.getProducts({ limit: 200, sort: 'newest' });
    if (!rows?.length) return false;         // empty catalogue: keep the demo one
    live.variants.clear();
    PRODUCTS = rows.map((r, i) => mapProduct(r, i, rows.length));
    live.on = true;
    live.api = api;
    return true;
  }

  /** Re-render whatever is on screen after the catalogue swaps in. */
  function repaintAfterCatalogChange() {
    buildFilterUI();
    renderHome();
    renderCart();
    router();
  }

  /* ---------------------------------------------------------------
     4. STATE
  --------------------------------------------------------------- */
  const state = {
    cart: store.get(KEY.CART, []),
    wish: store.get(KEY.WISH, []),
    user: store.get(KEY.USER, null) || store.sget(KEY.USER, null),
    filters: { cats: [], sizes: [], colors: [], patterns: [], max: 30 },
    sort: 'newest',
    q: ''
  };
  const persistCart = () => { store.set(KEY.CART, state.cart); syncBadges(); };
  const persistWish = () => { store.set(KEY.WISH, state.wish); syncBadges(); };

  function syncBadges() {
    const n = state.cart.reduce((s, i) => s + i.qty, 0);
    [['cartCount', n], ['bnCart', n], ['wishCount', state.wish.length], ['bnWish', state.wish.length]].forEach(([id, v]) => {
      const el = document.getElementById(id); if (!el) return;
      el.textContent = v; el.hidden = v === 0;
      if (v) { el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); }
    });
    const hc = $('#cartHeadCount'); if (hc) hc.textContent = `${n} item${n === 1 ? '' : 's'}`;
  }

  /* --- toasts --- */
  function toast(msg, ico = '🧸', type = '') {
    const wrap = $('#toasts');
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.innerHTML = `<span class="t-ico">${ico}</span><span>${msg}</span>`;
    wrap.appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, 2600);
  }

  function flyToBag(fromEl) {
    if (!fromEl || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const target = (window.innerWidth <= 760 ? $('[data-bn="bag"]') : $('#cartToggle'));
    if (!target) return;
    const a = fromEl.getBoundingClientRect(), b = target.getBoundingClientRect();
    const bear = document.createElement('span');
    bear.className = 'fly-bear'; bear.textContent = '🧸';
    bear.style.left = `${a.left + a.width / 2 - 14}px`;
    bear.style.top = `${a.top + a.height / 2 - 14}px`;
    bear.style.setProperty('--dx', `${b.left + b.width / 2 - a.left - a.width / 2}px`);
    bear.style.setProperty('--dy', `${b.top + b.height / 2 - a.top - a.height / 2}px`);
    document.body.appendChild(bear);
    setTimeout(() => bear.remove(), 850);
  }

  const starsHTML = (r) => {
    const full = Math.floor(r), half = r - full >= .5;
    return '★'.repeat(full) + (half ? '⯨' : '') + '☆'.repeat(5 - full - (half ? 1 : 0));
  };

  /* ---------------------------------------------------------------
     PRODUCT CARD
  --------------------------------------------------------------- */
  function cardHTML(p) {
    const color = p.colors[0];
    const [a, b] = imgs(p, color);
    const on = state.wish.includes(p.id);
    const badges = [];
    if (p.cats.includes('new-arrivals')) badges.push('<span class="pill new">New</span>');
    if (p.cats.includes('best-sellers')) badges.push('<span class="pill best">Best Seller</span>');
    if (p.old) badges.push('<span class="pill sale">Save ' + money(p.old - p.price) + '</span>');
    return `<article class="card" data-id="${p.id}">
      <a class="card-media" href="#/product/${p.id}" aria-label="${esc(p.name)}">
        <img class="img-a" src="${a}" alt="${esc(p.name)} in ${esc(color)}" loading="lazy" width="400" height="500">
        <img class="img-b" src="${b}" alt="" aria-hidden="true" loading="lazy" width="400" height="500">
      </a>
      <div class="card-badges">${badges.join('')}</div>
      <button class="wish ${on ? 'on' : ''}" data-wish="${p.id}" aria-label="${on ? 'Remove from' : 'Add to'} wishlist" aria-pressed="${on}">
        <svg viewBox="0 0 24 24"><path d="M12 20s-7.5-4.6-7.5-9.4A4.1 4.1 0 0 1 12 8.2a4.1 4.1 0 0 1 7.5 2.4C19.5 15.4 12 20 12 20z"/></svg>
      </button>
      <div class="card-body">
        <a href="#/product/${p.id}"><h3 class="card-name">${esc(p.name)}</h3></a>
        <p class="card-desc">${esc(p.desc)}</p>
        <div class="card-rate"><span class="stars">${starsHTML(p.rating)}</span> ${p.rating} (${p.reviews})</div>
        <p class="card-price">${kwd(p.price)} ${p.old ? `<s>${money(p.old)}</s>` : ''}</p>
        <div class="swatch-row" aria-label="Available colors">
          ${p.colors.map((c) => `<span class="sw" style="background:${COLORS[c].hex}" title="${c}"></span>`).join('')}
          <span class="tiny">${p.colors.join(' / ')}</span>
        </div>
        <div class="size-row" aria-label="Available sizes">${p.sizes.map((s) => `<span>${s}</span>`).join('')}</div>
        <button class="btn btn-primary card-atc" data-add="${p.id}">Add to Bag</button>
      </div>
    </article>`;
  }

  const skeletons = (n) => Array.from({ length: n }, () =>
    `<div class="sk"><div class="sk-media"></div><div class="sk-line"></div><div class="sk-line short"></div></div>`).join('');

  function paintGrid(el, list, emptyEl) {
    if (!list.length) { el.innerHTML = ''; if (emptyEl) emptyEl.hidden = false; return; }
    if (emptyEl) emptyEl.hidden = true;
    el.innerHTML = list.map(cardHTML).join('');
  }

  /* ---------------------------------------------------------------
     5. ROUTER
  --------------------------------------------------------------- */
  const PAGES = ['home', 'shop', 'product', 'wishlist', 'about', 'info', 'account'];
  function parseHash() {
    const raw = location.hash.replace(/^#/, '') || '/';
    const [path, qs] = raw.split('?');
    return { parts: path.split('/').filter(Boolean), params: new URLSearchParams(qs || '') };
  }

  function router() {
    const { parts, params } = parseHash();
    const root = parts[0] || '';
    let page = 'home';
    if (root === 'shop') page = 'shop';
    else if (root === 'product') page = 'product';
    else if (root === 'wishlist') page = 'wishlist';
    else if (root === 'about') page = 'about';
    else if (root === 'account') page = 'account';
    else if (root === 'info') page = 'info';

    PAGES.forEach((p) => { const el = document.getElementById('page-' + p); if (el) el.hidden = p !== page; });

    if (page === 'shop') openShop(params);
    if (page === 'product') renderPDP(parts[1]);
    if (page === 'wishlist') renderWishlist();
    if (page === 'account') renderAccount();
    if (page === 'info') renderInfo(parts[1] || 'faq');

    // nav highlighting
    const href = location.hash || '#/';
    $$('.nav a, .md-nav a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === href));
    $$('.bottomnav [data-bn]').forEach((b) => b.classList.remove('active'));
    const bn = page === 'home' ? 'home' : page === 'wishlist' ? 'wishlist' : null;
    if (bn) $(`.bottomnav [data-bn="${bn}"]`)?.classList.add('active');

    closeDrawer(); closeFilters();
    // jump, never smooth-crawl, when the route changes
    try { window.scrollTo({ top: 0, behavior: 'instant' }); } catch (e) { window.scrollTo(0, 0); }
    observeReveals();
  }

  /* ---------------------------------------------------------------
     6. HOME
  --------------------------------------------------------------- */
  function renderHome() {
    $('#heroArt').innerHTML = `<img src="${heroArt()}" alt="A cozy bed with folded BJmeem pajamas and a teddy bear" width="520" height="460">`;
    $('#bannerArt').innerHTML = `<img src="${bannerArt()}" alt="Matching pajama sets on a rail with a teddy bear" width="420" height="330">`;

    $('#catGrid').innerHTML = CATS.map((c) => `
      <article class="cat-card">
        <a class="cat-media" href="#/shop?cat=${c.key}" aria-label="Shop ${esc(c.name)}">
          <img src="${productImage(c.art[0], c.art[1], c.art[2])}" alt="${esc(c.name)}" loading="lazy" width="400" height="500">
        </a>
        <span class="cat-tag">${esc(c.tag)}</span>
        <div class="cat-body">
          <h3>${esc(c.name)}</h3>
          <p>${esc(c.desc)}</p>
          <a class="btn btn-soft btn-sm" href="#/shop?cat=${c.key}">Shop Now</a>
        </div>
      </article>`).join('');

    homeTab('best-sellers');

    const strip = ['🧸 Teddy-approved comfort', '☁️ 100% breathable cotton', '♡ Packed with love from BJmeem', '🎀 Free delivery over 20 KWD', '🌙 Made for cozy nights', '↺ 14-day easy returns'];
    $('#stripTrack').innerHTML = [...strip, ...strip].map((s) => `<span>${s}</span>`).join('');

    $$('[data-stars]').forEach((el) => { el.textContent = starsHTML(Number(el.dataset.stars)); });
  }

  function homeTab(key) {
    const list = PRODUCTS.filter((p) => p.cats.includes(key))
      .sort((a, b) => (key === 'new-arrivals' ? b.added - a.added : b.sold - a.sold)).slice(0, 8);
    const grid = $('#homeGrid');
    grid.innerHTML = skeletons(4);
    setTimeout(() => paintGrid(grid, list), 220);
  }

  $('#homeTabs')?.addEventListener('click', (e) => {
    const t = e.target.closest('.tab'); if (!t) return;
    $$('#homeTabs .tab').forEach((b) => { b.classList.toggle('active', b === t); b.setAttribute('aria-selected', b === t); });
    homeTab(t.dataset.tab);
  });

  /* ---------------------------------------------------------------
     7. SHOP + FILTERS
  --------------------------------------------------------------- */
  function buildFilterUI() {
    const count = (fn) => PRODUCTS.filter(fn).length;
    $('#fCat').innerHTML = CATS.map((c) =>
      `<label><input type="checkbox" data-f="cats" value="${c.key}"><span>${esc(c.name)}</span><span class="cnt">${count((p) => p.cats.includes(c.key))}</span></label>`).join('');
    $('#fSize').innerHTML = ALL_SIZES.map((s) =>
      `<label><input type="checkbox" data-f="sizes" value="${s}"><span class="sizebox">${s}</span></label>`).join('');
    $('#fColor').innerHTML = COLOR_FILTERS.map((c) =>
      `<label title="${c.label}"><input type="checkbox" data-f="colors" value="${c.key}"><span class="dot" style="background:${c.hex}"></span><span>${c.label}</span></label>`).join('');
    $('#fPattern').innerHTML = PATTERNS.map((p) =>
      `<label><input type="checkbox" data-f="patterns" value="${p.key}"><span>${p.label}</span><span class="cnt">${count((x) => x.pattern === p.key)}</span></label>`).join('');
  }

  function readFilters() {
    ['cats', 'sizes', 'colors', 'patterns'].forEach((f) => {
      state.filters[f] = $$(`#filters input[data-f="${f}"]:checked`).map((i) => i.value);
    });
    state.filters.max = Number($('#priceRange').value);
  }

  function writeFilters() {
    $$('#filters input[data-f]').forEach((i) => { i.checked = state.filters[i.dataset.f].includes(i.value); });
    $('#priceRange').value = state.filters.max;
    $('#priceOut').textContent = money(state.filters.max);
  }

  function matches(p) {
    const f = state.filters;
    if (f.cats.length && !f.cats.some((c) => p.cats.includes(c))) return false;
    if (f.sizes.length && !f.sizes.some((s) => p.sizes.includes(s))) return false;
    if (f.colors.length && !f.colors.some((c) => p.colors.some((pc) => COLORS[pc].key === c))) return false;
    if (f.patterns.length && !f.patterns.includes(p.pattern)) return false;
    if (p.price > f.max) return false;
    if (state.q) {
      const hay = `${p.name} ${p.desc} ${p.pattern} ${p.tags.join(' ')} ${p.colors.join(' ')} ${p.cats.map((c) => CAT_NAME[c]).join(' ')}`.toLowerCase();
      if (!state.q.toLowerCase().split(/\s+/).every((w) => hay.includes(w))) return false;
    }
    return true;
  }

  function sortList(list) {
    const s = state.sort;
    return list.slice().sort((a, b) =>
      s === 'asc' ? a.price - b.price :
      s === 'desc' ? b.price - a.price :
      s === 'best' ? b.sold - a.sold : b.added - a.added);
  }

  function activeChips() {
    const f = state.filters, chips = [];
    f.cats.forEach((c) => chips.push(['cats', c, CAT_NAME[c]]));
    f.sizes.forEach((s) => chips.push(['sizes', s, 'Size ' + s]));
    f.colors.forEach((c) => chips.push(['colors', c, COLOR_FILTERS.find((x) => x.key === c).label]));
    f.patterns.forEach((p) => chips.push(['patterns', p, PATTERNS.find((x) => x.key === p).label]));
    if (f.max < 30) chips.push(['max', '', 'Under ' + money(f.max) + ' KWD']);
    if (state.q) chips.push(['q', '', `“${state.q}”`]);
    $('#activeChips').innerHTML = chips.map(([g, v, l]) =>
      `<button class="chip" data-rm="${g}" data-val="${esc(v)}">${esc(l)} <b>&times;</b></button>`).join('');
    const n = chips.length;
    const fc = $('#fcount'); fc.textContent = n; fc.hidden = !n;
  }

  let shopTimer;
  function renderShop() {
    activeChips();
    const list = sortList(PRODUCTS.filter(matches));
    const grid = $('#shopGrid');
    grid.innerHTML = skeletons(6);
    $('#shopEmpty').hidden = true;
    $('#resultCount').textContent = 'Loading cozy things…';
    clearTimeout(shopTimer);
    shopTimer = setTimeout(() => {
      paintGrid(grid, list, $('#shopEmpty'));
      $('#resultCount').textContent = `${list.length} product${list.length === 1 ? '' : 's'}`;
    }, 260);
  }

  function openShop(params) {
    const cat = params.get('cat');
    const q = params.get('q');
    state.q = q || '';
    if (cat && CAT_NAME[cat]) state.filters.cats = [cat];
    else if (!params.has('keep')) state.filters.cats = [];
    if (!cat && !q) { state.filters = { cats: [], sizes: [], colors: [], patterns: [], max: 30 }; }
    writeFilters();
    const c = cat && CAT_NAME[cat] ? CATS.find((x) => x.key === cat) : null;
    $('#shopTitle').textContent = q ? `Results for “${q}”` : c ? c.name : 'All Pajamas';
    $('#shopBlurb').textContent = c ? c.desc : 'Soft cotton sleepwear, matching sets and cute prints — made for cozy nights.';
    $('#shopCrumb').textContent = q ? 'Search' : c ? c.name : 'Shop';
    renderShop();
  }

  $('#filters')?.addEventListener('change', (e) => {
    if (e.target.matches('input[data-f]')) { readFilters(); renderShop(); }
    if (e.target.id === 'priceRange') { $('#priceOut').textContent = money(e.target.value); readFilters(); renderShop(); }
  });
  $('#priceRange')?.addEventListener('input', (e) => { $('#priceOut').textContent = money(e.target.value); });
  $('#sortSelect')?.addEventListener('change', (e) => { state.sort = e.target.value; renderShop(); });
  $('#activeChips')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-rm]'); if (!b) return;
    const g = b.dataset.rm;
    if (g === 'max') state.filters.max = 30;
    else if (g === 'q') { state.q = ''; location.hash = '#/shop'; return; }
    else state.filters[g] = state.filters[g].filter((v) => v !== b.dataset.val);
    writeFilters(); renderShop();
  });
  function clearAll() {
    state.filters = { cats: [], sizes: [], colors: [], patterns: [], max: 30 };
    state.q = ''; writeFilters(); renderShop();
  }
  $('#clearFilters')?.addEventListener('click', clearAll);
  $('#emptyClear')?.addEventListener('click', clearAll);
  const openFilters = () => { $('#filters').classList.add('open'); $('#overlay').hidden = false; document.body.classList.add('locked'); };
  const closeFilters = () => { $('#filters')?.classList.remove('open'); if (!$('#cart').classList.contains('open') && !$('#mobileDrawer').classList.contains('open')) { $('#overlay').hidden = true; document.body.classList.remove('locked'); } };
  $('#filterToggle')?.addEventListener('click', openFilters);
  $('#filtersClose')?.addEventListener('click', closeFilters);
  $('#applyFilters')?.addEventListener('click', closeFilters);

  /* ---------------------------------------------------------------
     8. PRODUCT DETAIL
  --------------------------------------------------------------- */
  const pdp = { id: null, color: null, size: null, qty: 1, img: 0 };

  function renderPDP(id) {
    const p = byId(id);
    const body = $('#pdpBody');
    if (!p) {
      body.innerHTML = `<div class="empty" style="margin:60px 0"><span class="empty-ico">🧸</span><h3>We can't find that one</h3><p>It may have sold out or moved.</p><a class="btn btn-primary" href="#/shop">Back to shop</a></div>`;
      return;
    }
    pdp.id = p.id; pdp.color = p.colors[0]; pdp.size = null; pdp.qty = 1; pdp.img = 0;
    const gal = galleryFor(p, pdp.color);
    const on = state.wish.includes(p.id);
    const related = PRODUCTS.filter((x) => x.id !== p.id && (x.pattern === p.pattern || x.cats.some((c) => p.cats.includes(c)))).slice(0, 4);

    body.innerHTML = `
      <nav class="crumbs"><a href="#/">Home</a> <span>/</span> <a href="#/shop">Shop</a> <span>/</span> <b>${esc(p.name)}</b></nav>
      <div class="pdp">
        <div class="gallery">
          <div class="thumbs" id="pdpThumbs">${gal.map((g, i) => `<button class="thumb ${i === 0 ? 'active' : ''}" data-i="${i}" aria-label="View image ${i + 1}"><img src="${g}" alt="" width="400" height="500"></button>`).join('')}</div>
          <div class="gal-main"><img id="pdpMain" src="${gal[0]}" alt="${esc(p.name)}" width="400" height="500"></div>
        </div>

        <div class="pdp-info">
          <h1>${esc(p.name)}</h1>
          <div class="pdp-rate"><span class="stars">${starsHTML(p.rating)}</span> <b>${p.rating}</b> · ${p.reviews} reviews · ${p.sold}+ sold</div>
          <p class="pdp-price">${kwd(p.price)} ${p.old ? `<s>${money(p.old)} KWD</s>` : ''}</p>
          <p class="pdp-desc">${esc(p.desc)} Cut with a relaxed BJmeem fit, soft covered elastic and a rounded collar — made to be worn on repeat.</p>
          <span class="fabric">☁️ ${esc(p.fabric)}</span>

          <div class="opt">
            <div class="opt-head"><h3>Color</h3><span id="pdpColorName">${esc(pdp.color)}</span></div>
            <div class="opt-row" id="pdpColors">
              ${p.colors.map((c) => `<button class="color-btn ${c === pdp.color ? 'sel' : ''}" data-color="${esc(c)}"><span class="dot" style="background:${COLORS[c].hex}"></span>${esc(c)}</button>`).join('')}
            </div>
          </div>

          <div class="opt">
            <div class="opt-head"><h3>Size</h3><button class="linkbtn" id="openSizeGuide" type="button">Size guide</button></div>
            <div class="opt-row" id="pdpSizes">${sizeButtons(p, pdp.color)}</div>
            <span class="err" id="sizeErr">Please choose a size first 🎀</span>
          </div>

          <div class="opt">
            <div class="opt-head"><h3>Quantity</h3></div>
            <div class="qty">
              <button type="button" data-q="-1" aria-label="Decrease quantity">−</button>
              <input id="pdpQty" type="number" value="1" min="1" max="10" aria-label="Quantity">
              <button type="button" data-q="1" aria-label="Increase quantity">+</button>
            </div>
          </div>

          <div class="pdp-actions">
            <button class="btn btn-primary btn-lg" id="pdpAdd">Add to Bag</button>
            <button class="btn btn-dark btn-lg" id="pdpBuy">Buy Now</button>
            <button class="wish-btn ${on ? 'on' : ''}" id="pdpWish" aria-label="Add to wishlist" aria-pressed="${on}">
              <svg viewBox="0 0 24 24"><path d="M12 20s-7.5-4.6-7.5-9.4A4.1 4.1 0 0 1 12 8.2a4.1 4.1 0 0 1 7.5 2.4C19.5 15.4 12 20 12 20z"/></svg>
            </button>
          </div>
          <div class="pdp-note"><span>🚚 Delivery in 1–3 days</span><span>↺ 14-day returns</span><span>🎁 Gift-wrapped free</span></div>

          <div class="acc">
            <details open><summary>Product Details</summary><div class="acc-body"><ul>
              <li>Relaxed BJmeem fit — model wears size S</li>
              <li>${esc(p.pattern === 'plain' ? 'Solid dyed cotton, no print' : PATTERNS.find((x) => x.key === p.pattern).label + ' print, printed small and soft')}</li>
              <li>Covered elastic waistband with an inner drawcord</li>
              <li>Available in ${p.colors.join(', ')}</li>
            </ul></div></details>
            <details><summary>Material &amp; Care</summary><div class="acc-body"><ul>
              <li>${esc(p.fabric)}</li>
              <li>Machine wash cold on a gentle cycle</li>
              <li>Wash inside out with similar colors</li>
              <li>Tumble dry low, warm iron if needed — do not bleach</li>
            </ul></div></details>
            <details><summary>Size Guide</summary><div class="acc-body">
              <p>Our fits run relaxed. If you love an oversized look, size up one.</p>
              <div class="table-wrap"><table class="sg-table">
                <thead><tr><th>Size</th><th>Bust (cm)</th><th>Waist (cm)</th><th>Hip (cm)</th></tr></thead>
                <tbody><tr><td>XS</td><td>78–82</td><td>60–64</td><td>84–88</td></tr>
                <tr><td>S</td><td>83–87</td><td>65–69</td><td>89–93</td></tr>
                <tr><td>M</td><td>88–93</td><td>70–75</td><td>94–99</td></tr>
                <tr><td>L</td><td>94–99</td><td>76–81</td><td>100–105</td></tr>
                <tr><td>XL</td><td>100–106</td><td>82–88</td><td>106–112</td></tr></tbody>
              </table></div>
            </div></details>
            <details><summary>Delivery &amp; Returns</summary><div class="acc-body"><ul>
              <li>Delivery across Kuwait in 1–3 working days</li>
              <li>1.500 KWD flat delivery — free over 20.000 KWD</li>
              <li>Cash or KNET on delivery</li>
              <li>14-day returns on unworn items with tags attached</li>
            </ul></div></details>
          </div>
        </div>
      </div>

      <section class="you-may">
        <h2>You May Also Like</h2>
        <div class="prod-grid">${related.map(cardHTML).join('')}</div>
      </section>`;

    wirePDP(p);
    observeReveals();
  }

  /**
   * Size buttons for the chosen colour. When the store is connected to
   * Supabase, a variant with no stock is rendered disabled and labelled, so
   * an out-of-stock size cannot be selected at all (§7).
   */
  function sizeButtons(p, color) {
    return p.sizes.map((s) => {
      const avail = availableFor(p, s, color);
      const out = avail <= 0;
      return `<button class="size-btn${out ? ' is-out' : ''}" data-size="${s}"
        ${out ? 'disabled aria-disabled="true"' : ''}
        title="${out ? 'Out of stock in this colour' : (Number.isFinite(avail) ? avail + ' available' : '')}"
        >${s}${out ? ' <small>·&nbsp;out</small>' : ''}</button>`;
    }).join('');
  }

  function galleryFor(p, color) {
    const other = p.colors.find((c) => c !== color) || color;
    return [productImage(p.pattern, color, 'flat'), productImage(p.pattern, color, 'fold'), productImage(p.pattern, other, 'flat')];
  }

  function wirePDP(p) {
    const setImg = (i) => {
      pdp.img = i;
      $('#pdpMain').src = galleryFor(p, pdp.color)[i];
      $$('#pdpThumbs .thumb').forEach((t, k) => t.classList.toggle('active', k === i));
    };
    $('#pdpThumbs').addEventListener('click', (e) => { const t = e.target.closest('.thumb'); if (t) setImg(Number(t.dataset.i)); });

    $('#pdpColors').addEventListener('click', (e) => {
      const b = e.target.closest('[data-color]'); if (!b) return;
      pdp.color = b.dataset.color;
      $$('#pdpColors .color-btn').forEach((x) => x.classList.toggle('sel', x === b));
      $('#pdpColorName').textContent = pdp.color;
      const gal = galleryFor(p, pdp.color);
      $$('#pdpThumbs .thumb img').forEach((im, i) => { im.src = gal[i]; });
      setImg(pdp.img);

      // Availability is per size *and* colour, so the size row is rebuilt.
      $('#pdpSizes').innerHTML = sizeButtons(p, pdp.color);
      if (pdp.size && availableFor(p, pdp.size, pdp.color) <= 0) pdp.size = null;
      if (pdp.size) {
        $$('#pdpSizes .size-btn').forEach((x) =>
          x.classList.toggle('sel', x.dataset.size === pdp.size));
      }
    });

    $('#pdpSizes').addEventListener('click', (e) => {
      const b = e.target.closest('[data-size]'); if (!b) return;
      pdp.size = b.dataset.size;
      $$('#pdpSizes .size-btn').forEach((x) => x.classList.toggle('sel', x === b));
      $('#sizeErr').classList.remove('show');
    });

    const qtyIn = $('#pdpQty');
    $$('.pdp [data-q]').forEach((b) => b.addEventListener('click', () => {
      const v = Math.min(10, Math.max(1, Number(qtyIn.value) + Number(b.dataset.q)));
      qtyIn.value = v; pdp.qty = v;
    }));
    qtyIn.addEventListener('change', () => {
      const v = Math.min(10, Math.max(1, Math.round(Number(qtyIn.value) || 1)));
      qtyIn.value = v; pdp.qty = v;
    });

    const tryAdd = (btn) => {
      if (!pdp.size) {
        $('#sizeErr').classList.add('show');
        $('#pdpSizes').scrollIntoView({ block: 'center', behavior: 'smooth' });
        toast('Choose a size first 🎀', '🎀', 'err');
        return false;
      }
      addToCart(p.id, pdp.size, pdp.color, pdp.qty, btn);
      return true;
    };
    $('#pdpAdd').addEventListener('click', (e) => tryAdd(e.currentTarget));
    $('#pdpBuy').addEventListener('click', (e) => { if (tryAdd(e.currentTarget)) { closeCart(); openCheckout(); } });
    $('#pdpWish').addEventListener('click', (e) => toggleWish(p.id, e.currentTarget));
    $('#openSizeGuide').addEventListener('click', () => openModal('#sizeModal'));
  }

  /* ---------------------------------------------------------------
     WISHLIST
  --------------------------------------------------------------- */
  function toggleWish(id, btn) {
    const i = state.wish.indexOf(id);
    if (i > -1) { state.wish.splice(i, 1); toast('Removed from wishlist', '♡'); }
    else { state.wish.push(id); toast('Saved for later ♡', '💗'); }
    persistWish();
    const on = state.wish.includes(id);
    $$(`[data-wish="${id}"], #pdpWish`).forEach((b) => {
      if (b.id === 'pdpWish' && pdp.id !== id) return;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on);
      b.classList.remove('burst'); void b.offsetWidth; if (on) b.classList.add('burst');
    });
    if (btn) { btn.classList.remove('burst'); void btn.offsetWidth; if (on) btn.classList.add('burst'); }
    if (!$('#page-wishlist').hidden) renderWishlist();
  }

  function renderWishlist() {
    const list = state.wish.map(byId).filter(Boolean);
    paintGrid($('#wishGrid'), list, $('#wishEmpty'));
  }

  /* ---------------------------------------------------------------
     9. CART
  --------------------------------------------------------------- */
  const SHIP = 1.5, FREE_OVER = 20;
  const lineKey = (id, size, color) => `${id}__${size}__${color}`;

  function addToCart(id, size, color, qty, btn) {
    const p = byId(id); if (!p) return;
    const key = lineKey(id, size, color);
    const line = state.cart.find((l) => l.key === key);

    // Never let the bag hold more than the shop actually has. The server
    // checks this again at checkout — this is only for a kind error message.
    const avail = availableFor(p, size, color);
    if (avail <= 0) {
      toast(`${esc(p.name)} — ${size} / ${color} is out of stock`, '☁️', 'err');
      return;
    }
    const wanted = (line?.qty ?? 0) + qty;
    if (wanted > avail) {
      toast(`Only ${avail} left in ${size} / ${color}`, '🎀', 'err');
      if (!line) state.cart.push({ key, id, size, color, qty: avail });
      else line.qty = avail;
      persistCart(); renderCart();
      return;
    }

    if (line) line.qty = Math.min(10, line.qty + qty);
    else state.cart.push({ key, id, size, color, qty });
    persistCart(); renderCart();
    flyToBag(btn);
    toast(`Your cozy pick is in the bag 🧸♡ <br><span class="tiny">${esc(p.name)} · ${size} · ${color}</span>`);
    setTimeout(openCart, 480);
  }

  function renderCart() {
    const wrap = $('#cartItems');
    if (!state.cart.length) {
      wrap.innerHTML = ''; $('#cartEmpty').hidden = false; $('#cartFoot').hidden = true; $('#freeShip').hidden = true;
      return;
    }
    $('#cartEmpty').hidden = true; $('#cartFoot').hidden = false; $('#freeShip').hidden = false;

    wrap.innerHTML = state.cart.map((l) => {
      const p = byId(l.id); if (!p) return '';
      return `<div class="ci" data-key="${esc(l.key)}">
        <img src="${productImage(p.pattern, l.color, 'flat')}" alt="${esc(p.name)}" width="78" height="94">
        <div>
          <div class="ci-top">
            <a href="#/product/${p.id}" class="ci-name">${esc(p.name)}</a>
            <button class="ci-rm" data-rm-line="${esc(l.key)}" aria-label="Remove ${esc(p.name)}">Remove</button>
          </div>
          <p class="ci-meta">Size ${esc(l.size)} <span class="dot" style="background:${COLORS[l.color].hex}"></span> ${esc(l.color)}</p>
          <div class="ci-bot">
            <div class="qty">
              <button type="button" data-line="${esc(l.key)}" data-d="-1" aria-label="Decrease">−</button>
              <input type="number" value="${l.qty}" min="1" max="10" data-line-input="${esc(l.key)}" aria-label="Quantity for ${esc(p.name)}">
              <button type="button" data-line="${esc(l.key)}" data-d="1" aria-label="Increase">+</button>
            </div>
            <b class="ci-price">${money(p.price * l.qty)} KWD</b>
          </div>
        </div>
      </div>`;
    }).join('');

    const sub = cartSubtotal();
    const ship = sub >= FREE_OVER || sub === 0 ? 0 : SHIP;
    $('#sumSub').textContent = money(sub) + ' KWD';
    $('#sumShip').textContent = ship === 0 ? 'FREE' : money(ship) + ' KWD';
    $('#sumTotal').textContent = money(sub + ship) + ' KWD';

    const left = Math.max(0, FREE_OVER - sub);
    $('#freeShip').innerHTML = left > 0
      ? `Add <b>${money(left)} KWD</b> more for free delivery ☁️<div class="fs-bar"><i style="width:${Math.min(100, (sub / FREE_OVER) * 100)}%"></i></div>`
      : `You unlocked free delivery! 🧸<div class="fs-bar"><i style="width:100%"></i></div>`;
    syncBadges();
  }

  const cartSubtotal = () => state.cart.reduce((s, l) => { const p = byId(l.id); return s + (p ? p.price * l.qty : 0); }, 0);

  $('#cartItems')?.addEventListener('click', (e) => {
    const step = e.target.closest('[data-line]');
    if (step) {
      const l = state.cart.find((x) => x.key === step.dataset.line); if (!l) return;
      const next = l.qty + Number(step.dataset.d);
      if (next < 1) return removeLine(l.key);
      l.qty = Math.min(10, next); persistCart(); renderCart(); return;
    }
    const rm = e.target.closest('[data-rm-line]');
    if (rm) removeLine(rm.dataset.rmLine);
  });
  $('#cartItems')?.addEventListener('change', (e) => {
    const inp = e.target.closest('[data-line-input]'); if (!inp) return;
    const l = state.cart.find((x) => x.key === inp.dataset.lineInput); if (!l) return;
    const v = Math.min(10, Math.max(1, Math.round(Number(inp.value) || 1)));
    l.qty = v; persistCart(); renderCart();
  });

  function removeLine(key) {
    const el = $(`.ci[data-key="${CSS.escape(key)}"]`);
    const done = () => {
      state.cart = state.cart.filter((l) => l.key !== key);
      persistCart(); renderCart(); toast('Removed from your bag', '☁️');
    };
    if (el) { el.classList.add('removing'); setTimeout(done, 260); } else done();
  }

  const openCart = () => { $('#cart').classList.add('open'); $('#cart').setAttribute('aria-hidden', 'false'); $('#overlay').hidden = false; document.body.classList.add('locked'); };
  const closeCart = () => {
    $('#cart').classList.remove('open'); $('#cart').setAttribute('aria-hidden', 'true');
    if (!$('#filters')?.classList.contains('open') && !$('#mobileDrawer').classList.contains('open')) { $('#overlay').hidden = true; document.body.classList.remove('locked'); }
  };
  $('#cartToggle')?.addEventListener('click', openCart);
  $('#cartClose')?.addEventListener('click', closeCart);
  $('#emptyCartShop')?.addEventListener('click', () => { closeCart(); location.hash = '#/shop'; });
  $('#overlay')?.addEventListener('click', () => { closeCart(); closeDrawer(); closeFilters(); });

  // add-to-bag + wishlist delegation for every grid on the page
  document.addEventListener('click', (e) => {
    const add = e.target.closest('[data-add]');
    if (add) {
      const p = byId(add.dataset.add); if (!p) return;
      const color = p.colors[0];
      // Prefer M, but fall back to whatever size is actually in stock.
      const size = [p.sizes.includes('M') ? 'M' : null, ...p.sizes]
        .filter(Boolean).find((s) => availableFor(p, s, color) > 0);
      if (!size) {
        toast(`${esc(p.name)} is out of stock`, '☁️', 'err');
        return;
      }
      addToCart(p.id, size, color, 1, add);
      return;
    }
    const w = e.target.closest('[data-wish]');
    if (w) { toggleWish(w.dataset.wish, w); }
  });

  /* ---------------------------------------------------------------
     10. SEARCH
  --------------------------------------------------------------- */
  function searchProducts(q) {
    const words = q.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    return PRODUCTS.filter((p) => {
      const hay = `${p.name} ${p.desc} ${p.pattern} ${p.tags.join(' ')} ${p.colors.join(' ')} ${p.cats.map((c) => CAT_NAME[c]).join(' ')}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }

  function renderSearch(q) {
    const box = $('#searchResults');
    if (!q.trim()) { box.innerHTML = ''; return; }
    const res = searchProducts(q);
    if (!res.length) {
      box.innerHTML = `<p class="sr-none">No matches for “${esc(q)}” — try <b>cotton</b>, <b>teddy</b> or <b>set</b>.</p>`;
      return;
    }
    box.innerHTML = res.slice(0, 6).map((p) => `
      <a class="sr-item" href="#/product/${p.id}" data-close-search>
        <img src="${productImage(p.pattern, p.colors[0], 'flat')}" alt="" width="56" height="66">
        <span><b>${esc(p.name)}</b><span>${esc(p.desc)}</span></span>
        <span class="sr-price">${money(p.price)} KWD</span>
      </a>`).join('')
      + `<a class="btn btn-soft" href="#/shop?q=${encodeURIComponent(q)}" data-close-search>See all ${res.length} results</a>`;
  }

  const openSearch = () => {
    $('#searchBar').hidden = false; $('#searchToggle').setAttribute('aria-expanded', 'true');
    setTimeout(() => $('#searchInput').focus(), 40);
  };
  const closeSearch = () => { $('#searchBar').hidden = true; $('#searchToggle').setAttribute('aria-expanded', 'false'); };
  $('#searchToggle')?.addEventListener('click', () => ($('#searchBar').hidden ? openSearch() : closeSearch()));
  $('#searchClose')?.addEventListener('click', closeSearch);
  $('#searchInput')?.addEventListener('input', debounce((e) => renderSearch(e.target.value), 160));
  $('#searchForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('#searchInput').value.trim();
    if (q) { location.hash = `#/shop?q=${encodeURIComponent(q)}`; closeSearch(); }
  });
  $('.search-chips')?.addEventListener('click', (e) => {
    const c = e.target.closest('[data-term]'); if (!c) return;
    $('#searchInput').value = c.dataset.term; renderSearch(c.dataset.term); $('#searchInput').focus();
  });
  document.addEventListener('click', (e) => { if (e.target.closest('[data-close-search]')) closeSearch(); });

  /* ---------------------------------------------------------------
     11. AUTH  (front-end only — swap for a real API, see API_STUB)
  --------------------------------------------------------------- */
  const validEmail = (v) => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v.trim());
  // Demo-only obfuscation. A real build must hash + verify on the server.
  const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return 'h' + Math.abs(h).toString(36); };

  function setErr(inputId, errId, msg) {
    const i = $('#' + inputId), e = $('#' + errId);
    if (msg) { i?.classList.add('bad'); i?.classList.remove('good'); e.textContent = msg; e.classList.add('show'); }
    else { i?.classList.remove('bad'); i?.classList.add('good'); e.textContent = ''; e.classList.remove('show'); }
    return !msg;
  }

  function showAuth(view) {
    ['loginForm', 'registerForm', 'resetForm'].forEach((f) => { $('#' + f).hidden = true; });
    $('#authOk').hidden = true;
    $('#' + (view === 'register' ? 'registerForm' : view === 'reset' ? 'resetForm' : 'loginForm')).hidden = false;
    $('#authTitle').textContent = view === 'register' ? 'Create your account' : view === 'reset' ? 'Reset your password' : 'Welcome back';
    $('#authSub').textContent = view === 'register' ? 'Join the BJmeem Sleep Club 🧸' : view === 'reset' ? "We'll help you back in." : 'Log in to your BJmeem account.';
  }

  function openAuth(view = 'login') { showAuth(view); openModal('#authModal'); }

  $('#authModal')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-auth]'); if (b) showAuth(b.dataset.auth);
    const pk = e.target.closest('[data-peek]');
    if (pk) { const i = $('#' + pk.dataset.peek); const show = i.type === 'password'; i.type = show ? 'text' : 'password'; pk.textContent = show ? 'Hide' : 'Show'; }
  });

  $('#regPass')?.addEventListener('input', (e) => {
    const v = e.target.value;
    let s = 0;
    if (v.length >= 6) s++; if (v.length >= 10) s++;
    if (/[A-Z]/.test(v) && /[a-z]/.test(v)) s++;
    if (/\d/.test(v) || /[^\w]/.test(v)) s++;
    const m = $('#passMeter');
    m.style.width = `${(s / 4) * 100}%`;
    m.style.background = s <= 1 ? '#D2694E' : s === 2 ? '#E5A94F' : s === 3 ? '#8FBF7A' : '#5EA97F';
  });

  $('#loginForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const email = $('#loginEmail').value.trim(), pass = $('#loginPass').value;
    let ok = true;
    ok = setErr('loginEmail', 'loginEmailErr', !email ? 'Please enter your email address.' : !validEmail(email) ? "That email doesn't look right — check for a typo." : '') && ok;
    ok = setErr('loginPass', 'loginPassErr', !pass ? 'Please enter your password.' : '') && ok;
    if (!ok) return;

    const users = store.get(KEY.USERS, []);
    const found = users.find((u) => u.email.toLowerCase() === email.toLowerCase());
    if (!found) { setErr('loginEmail', 'loginEmailErr', "We can't find a BJmeem account with that email. Create one below."); return; }
    if (found.pass !== hash(pass)) { setErr('loginPass', 'loginPassErr', "That password doesn't match. Try again."); return; }
    signIn({ name: found.name, email: found.email }, $('#rememberMe').checked);
  });

  $('#registerForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('#regName').value.trim(), email = $('#regEmail').value.trim();
    const p1 = $('#regPass').value, p2 = $('#regPass2').value;
    let ok = true;
    ok = setErr('regName', 'regNameErr', name.length < 2 ? 'Please tell us your name.' : '') && ok;
    ok = setErr('regEmail', 'regEmailErr', !email ? 'Please enter your email address.' : !validEmail(email) ? "That email doesn't look right." : '') && ok;
    ok = setErr('regPass', 'regPassErr', p1.length < 6 ? 'Password must be at least 6 characters.' : '') && ok;
    ok = setErr('regPass2', 'regPass2Err', p2 !== p1 ? "Passwords don't match." : '') && ok;
    const terms = $('#regTerms').checked;
    $('#regTermsErr').textContent = terms ? '' : 'Please accept the terms to continue.';
    $('#regTermsErr').classList.toggle('show', !terms);
    if (!ok || !terms) return;

    const users = store.get(KEY.USERS, []);
    if (users.some((u) => u.email.toLowerCase() === email.toLowerCase())) {
      setErr('regEmail', 'regEmailErr', 'An account already exists with this email. Try logging in.');
      return;
    }
    users.push({ name, email, pass: hash(p1), joined: Date.now() });
    store.set(KEY.USERS, users);
    signIn({ name, email }, true, true);
  });

  $('#resetForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const email = $('#resetEmail').value.trim();
    if (!setErr('resetEmail', 'resetEmailErr', !email ? 'Please enter your email address.' : !validEmail(email) ? "That email doesn't look right." : '')) return;
    authSuccess('💌', 'Check your inbox', `If an account exists for <b>${esc(email)}</b>, a reset link is on its way.`);
  });

  function authSuccess(ico, title, msg) {
    ['loginForm', 'registerForm', 'resetForm'].forEach((f) => { $('#' + f).hidden = true; });
    const box = $('#authOk');
    box.hidden = false;
    box.innerHTML = `<span class="big-bear">${ico}</span><h3>${title}</h3><p>${msg}</p>`;
  }

  function signIn(user, remember, isNew) {
    state.user = user;
    if (remember) { store.set(KEY.USER, user); store.sdel(KEY.USER); }
    else { store.sset(KEY.USER, user); store.del(KEY.USER); }
    paintUser();
    authSuccess('🧸', isNew ? `Welcome to BJmeem, ${esc(user.name.split(' ')[0])}!` : `Welcome back, ${esc(user.name.split(' ')[0])}!`,
      isNew ? "Your account is ready. Let's find something soft." : "You're logged in. Your bag and wishlist are waiting.");
    toast(isNew ? 'Account created 🧸♡' : 'Logged in — welcome back ♡', '🧸');
    setTimeout(() => { closeModal('#authModal'); showAuth('login'); }, 1500);
  }

  function signOut() {
    state.user = null; store.del(KEY.USER); store.sdel(KEY.USER);
    paintUser(); toast('Logged out — sleep well 🌙', '🌙');
    if (!$('#page-account').hidden) renderAccount();
  }

  function paintUser() {
    const btn = $('#loginBtn');
    if (state.user) {
      btn.textContent = `Hi, ${state.user.name.split(' ')[0]}`;
      btn.classList.remove('btn-primary'); btn.classList.add('btn-outline');
      $('#drawerUser').innerHTML = `<p class="hi">Hi, ${esc(state.user.name.split(' ')[0])} 🧸</p><p class="tiny">${esc(state.user.email)}</p><a class="btn btn-soft btn-sm" href="#/account" style="margin-top:8px">My account</a>`;
    } else {
      btn.textContent = 'Login / Sign Up';
      btn.classList.add('btn-primary'); btn.classList.remove('btn-outline');
      $('#drawerUser').innerHTML = `<p class="tiny">Welcome to BJmeem 🧸</p><button class="btn btn-primary btn-sm" id="drawerLogin" style="margin-top:8px">Login / Sign Up</button>`;
    }
  }

  $('#loginBtn')?.addEventListener('click', () => (state.user ? (location.hash = '#/account') : openAuth('login')));
  $('#accountBtn')?.addEventListener('click', () => (state.user ? (location.hash = '#/account') : openAuth('login')));
  $('#drawerUser')?.addEventListener('click', (e) => { if (e.target.id === 'drawerLogin') { closeDrawer(); openAuth('login'); } });

  function renderAccount() {
    const box = $('#accountCard');
    if (!state.user) {
      box.innerHTML = `<div class="empty" style="border:0;background:none;padding:30px 0">
        <span class="empty-ico">🧸</span><h3>You're not logged in</h3>
        <p>Log in to see your details, wishlist and orders.</p>
        <button class="btn btn-primary btn-lg" id="acctLogin">Login / Sign Up</button></div>`;
      $('#acctLogin').addEventListener('click', () => openAuth('login'));
      return;
    }
    const orders = store.get(KEY.ORDERS, []).filter((o) => o.email === state.user.email);
    box.innerHTML = `
      <div class="acct-hero">
        <span class="avatar">${esc(state.user.name.trim()[0].toUpperCase())}</span>
        <div><h1 style="font-size:1.6rem">Hi, ${esc(state.user.name.split(' ')[0])} 🧸</h1><p class="muted">${esc(state.user.email)}</p></div>
      </div>
      <div class="acct-stats">
        <div class="acct-stat"><b>${orders.length}</b><span>Orders placed</span></div>
        <div class="acct-stat"><b>${state.wish.length}</b><span>Wishlist items</span></div>
        <div class="acct-stat"><b>${state.cart.reduce((s, l) => s + l.qty, 0)}</b><span>Items in bag</span></div>
      </div>
      ${orders.length ? `<h3 style="margin-top:22px">Recent orders</h3>
        <div class="table-wrap"><table class="sg-table"><thead><tr><th>Order</th><th>Date</th><th>Items</th><th>Total</th></tr></thead><tbody>
        ${orders.slice(-5).reverse().map((o) => `<tr><td>${esc(o.id)}</td><td>${new Date(o.at).toLocaleDateString()}</td><td>${o.items}</td><td>${money(o.total)} KWD</td></tr>`).join('')}
        </tbody></table></div>` : `<p class="muted" style="margin-top:14px">No orders yet — your first cozy pick is waiting.</p>`}
      <div class="acct-actions">
        <a class="btn btn-primary" href="#/shop">Continue shopping</a>
        <a class="btn btn-outline" href="#/wishlist">My wishlist</a>
        <button class="btn btn-soft" id="logoutBtn">Log out</button>
      </div>`;
    $('#logoutBtn').addEventListener('click', signOut);
  }

  /* ---------------------------------------------------------------
     12. CHECKOUT
  --------------------------------------------------------------- */
  function openCheckout() {
    if (!state.cart.length) { toast('Your bag is empty — add something soft first ☁️', '☁️', 'err'); return; }
    const sub = cartSubtotal(), ship = sub >= FREE_OVER ? 0 : SHIP;
    $('#coSum').innerHTML = `
      ${state.cart.map((l) => { const p = byId(l.id); return `<div class="row"><span>${esc(p.name)} · ${esc(l.size)} · ${esc(l.color)} × ${l.qty}</span><b>${money(p.price * l.qty)}</b></div>`; }).join('')}
      <div class="row"><span>Delivery</span><b>${ship ? money(ship) : 'FREE'}</b></div>
      <div class="row total"><span>Total</span><b>${money(sub + ship)} KWD</b></div>`;
    $('#coForm').hidden = false; $('#coDone').hidden = true;
    if (state.user) { $('#coName').value = state.user.name; $('#coEmail').value = state.user.email; }
    closeCart();
    openModal('#checkoutModal');
  }
  $('#checkoutBtn')?.addEventListener('click', openCheckout);

  $('#coForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    let ok = true;
    ok = setErr('coName', 'coNameErr', $('#coName').value.trim().length < 2 ? 'Please enter your full name.' : '') && ok;
    ok = setErr('coPhone', 'coPhoneErr', !/^[0-9+\s-]{8,15}$/.test($('#coPhone').value.trim()) ? 'Enter a valid phone number (8 digits).' : '') && ok;
    ok = setErr('coEmail', 'coEmailErr', !validEmail($('#coEmail').value) ? 'Enter a valid email address.' : '') && ok;
    ok = setErr('coArea', 'coAreaErr', $('#coArea').value.trim().length < 2 ? 'Please enter your area.' : '') && ok;
    ok = setErr('coBlock', 'coBlockErr', $('#coBlock').value.trim().length < 3 ? 'Please enter block, street and house.' : '') && ok;
    if (!ok) return;

    // Connected store: place a real order through Supabase so inventory,
    // coupons, loyalty and the admin dashboard all stay in step. The server
    // re-prices everything and re-checks stock; nothing here is trusted.
    if (live.on && live.api) {
      placeOrderOnline(e.target);
      return;
    }

    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Placing your order…';
    setTimeout(() => {
      const sub = cartSubtotal(), ship = sub >= FREE_OVER ? 0 : SHIP;
      const order = {
        id: 'BJM-' + Math.random().toString(36).slice(2, 7).toUpperCase(),
        at: Date.now(), email: $('#coEmail').value.trim(),
        items: state.cart.reduce((s, l) => s + l.qty, 0), total: sub + ship
      };
      const orders = store.get(KEY.ORDERS, []); orders.push(order); store.set(KEY.ORDERS, orders);
      state.cart = []; persistCart(); renderCart();
      $('#coForm').hidden = true;
      $('#coDone').hidden = false;
      $('#coDone').innerHTML = `<span class="big-bear">🧸</span><h3>Your cozy order is confirmed!</h3>
        <p class="muted">Order <span class="oid">${order.id}</span> · ${order.items} item${order.items === 1 ? '' : 's'} · ${money(order.total)} KWD</p>
        <p style="margin-top:10px">We'll deliver in 1–3 days. Packed with love from BJmeem ♡</p>
        <button class="btn btn-primary btn-lg" style="margin-top:18px" id="coKeep">Keep shopping</button>`;
      $('#coKeep').addEventListener('click', () => { closeModal('#checkoutModal'); location.hash = '#/shop'; });
      btn.disabled = false; btn.textContent = 'Place Order';
      toast('Order placed — sleep tight 🌙♡', '🎉');
    }, 800);
  });

  /**
   * Checkout against Supabase. Requires a signed-in customer, because an
   * order has to belong to someone. The local bag is pushed to the server
   * cart, then place_order() re-prices it and reserves the stock atomically.
   */
  async function placeOrderOnline(form) {
    const api = live.api;
    const btn = form.querySelector('button[type=submit]');
    const setBusy = (t) => { btn.disabled = !!t; btn.textContent = t || 'Place Order'; };

    try {
      setBusy('Checking your account…');
      const session = await api.getSession();
      if (!session) {
        setBusy(null);
        closeModal('#checkoutModal');
        toast('Please log in or create an account to place your order 🧸', '🧸', 'err');
        openAuth('login');
        return;
      }

      setBusy('Saving your address…');
      const address = await api.createAddress({
        label: 'home',
        fullName: $('#coName').value.trim(),
        phone: $('#coPhone').value.trim(),
        governorate: $('#coArea').value.trim(),   // zone lookup uses governorate
        area: $('#coArea').value.trim(),
        block: $('#coBlock').value.trim(),
        street: $('#coBlock').value.trim(),
        buildingNumber: $('#coBlock').value.trim(),
      });

      setBusy('Reserving your items…');
      // Rebuild the server cart from the local bag, then let the server price it.
      await api.clearCart().catch(() => {});
      for (const l of state.cart) {
        const p = byId(l.id);
        const variantId = p && variantIdFor(p, l.size, l.color);
        if (variantId) await api.addToCart(variantId, l.qty);
      }

      setBusy('Placing your order…');
      const order = await api.createOrder({
        addressId: address.id,
        paymentMethod: (form.querySelector('input[name=pay]:checked')?.value === 'knet')
          ? 'knet' : 'cod',
        notes: null,
      });

      state.cart = [];
      persistCart();
      renderCart();

      $('#coForm').hidden = true;
      $('#coDone').hidden = false;
      $('#coDone').innerHTML = `<span class="big-bear">🧸</span><h3>Your cozy order is confirmed!</h3>
        <p class="muted">Order <span class="oid">${esc(order.order_number)}</span> ·
          ${money(order.total_amount)} KWD</p>
        <p style="margin-top:10px">We'll deliver in 1–3 days. Packed with love from BJmeem ♡</p>
        <button class="btn btn-primary btn-lg" style="margin-top:18px" id="coKeep">Keep shopping</button>`;
      $('#coKeep').addEventListener('click', () => {
        closeModal('#checkoutModal'); location.hash = '#/shop';
      });
      toast('Order placed — sleep tight 🌙♡', '🎉');
    } catch (err) {
      toast(err?.message || 'We could not place that order.', '☁️', 'err');
      // Refresh stock so the bag reflects what is genuinely available.
      loadCatalogFromSupabase(api).then(repaintAfterCatalogChange).catch(() => {});
    } finally {
      setBusy(null);
    }
  }

  /* ---------------------------------------------------------------
     NEWSLETTER
  --------------------------------------------------------------- */
  $('#newsForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#newsEmail').value.trim();
    if (!v) return setErr('newsEmail', 'newsErr', 'Please enter your email address.');
    if (!validEmail(v)) return setErr('newsEmail', 'newsErr', "That email doesn't look right — check for a typo.");
    setErr('newsEmail', 'newsErr', '');
    const list = store.get(KEY.NEWS, []);
    if (!list.includes(v.toLowerCase())) { list.push(v.toLowerCase()); store.set(KEY.NEWS, list); }
    $('#newsEmail').value = '';
    toast("You're in the Sleep Club 🧸♡", '💌');
  });

  /* ---------------------------------------------------------------
     INFO PAGES
  --------------------------------------------------------------- */
  const INFO = {
    'contact': ['Contact Us', `<p>We answer every message — usually within a few hours.</p>
      <h3>Talk to us</h3><ul><li>WhatsApp: +965 0000 0000</li><li>Email: hello@bjmeem.com</li><li>Instagram / TikTok / Snapchat: @bjmeem</li></ul>
      <h3>Customer care hours</h3><p>Sunday to Thursday, 10:00 — 20:00 (Kuwait time). Friday and Saturday we are cozy at home.</p>`],
    'size-guide': ['Size Guide', `<p>Our fits run relaxed. If you love an oversized look, size up one.</p>
      <div class="table-wrap"><table class="sg-table"><thead><tr><th>Size</th><th>Bust (cm)</th><th>Waist (cm)</th><th>Hip (cm)</th><th>Fits</th></tr></thead>
      <tbody><tr><td>XS</td><td>78–82</td><td>60–64</td><td>84–88</td><td>UK 6</td></tr>
      <tr><td>S</td><td>83–87</td><td>65–69</td><td>89–93</td><td>UK 8</td></tr>
      <tr><td>M</td><td>88–93</td><td>70–75</td><td>94–99</td><td>UK 10</td></tr>
      <tr><td>L</td><td>94–99</td><td>76–81</td><td>100–105</td><td>UK 12</td></tr>
      <tr><td>XL</td><td>100–106</td><td>82–88</td><td>106–112</td><td>UK 14</td></tr></tbody></table></div>
      <h3>Between sizes?</h3><p>Go up. Cotton softens with every wash and a roomier fit sleeps better.</p>`],
    'faq': ['FAQ', `<h3>Are BJmeem pajamas really 100% cotton?</h3><p>Yes — every core piece is 100% breathable cotton. Printed styles use gentle water-based inks.</p>
      <h3>Will the print fade?</h3><p>Not if you wash cold, inside out, on a gentle cycle.</p>
      <h3>Do you gift wrap?</h3><p>Always, and always free. Tissue, a little bow and a teddy sticker.</p>
      <h3>How long does delivery take?</h3><p>1–3 working days across Kuwait.</p>
      <h3>Can I exchange a size?</h3><p>Yes, within 14 days as long as the item is unworn with tags attached.</p>`],
    'shipping': ['Shipping &amp; Delivery', `<ul><li>Flat delivery fee of 1.500 KWD across Kuwait</li><li>Free delivery on orders over 20.000 KWD</li>
      <li>Orders placed before 4pm are packed the same day</li><li>Delivery in 1–3 working days</li><li>Cash or KNET on delivery</li></ul>
      <h3>Tracking</h3><p>You'll get a message with your order number as soon as your parcel leaves us.</p>`],
    'returns': ['Returns &amp; Exchanges', `<p>If it isn't cozy enough, send it back.</p>
      <ul><li>14 days from delivery to return or exchange</li><li>Items must be unworn, unwashed and with tags attached</li>
      <li>Refunds are issued to the original payment method within 5 working days</li><li>Sale items can be exchanged but not refunded</li></ul>
      <h3>How to start a return</h3><p>Message us on WhatsApp with your order number and we'll arrange a pickup.</p>`],
    'privacy': ['Privacy Policy', `<p>We collect only what we need to deliver your order: your name, contact details and address.</p>
      <ul><li>We never sell or share your personal data</li><li>Payment details are never stored by BJmeem</li>
      <li>You can ask us to delete your data at any time</li><li>This demo store keeps your cart, wishlist and login in your own browser's localStorage only</li></ul>`],
    'terms': ['Terms &amp; Conditions', `<p>By shopping with BJmeem you agree to the following.</p>
      <ul><li>Prices are shown in Kuwaiti Dinar (KWD) and include applicable taxes</li>
      <li>Product colors may vary slightly between screens</li><li>Orders can be cancelled before dispatch</li>
      <li>All BJmeem designs, artwork and content belong to BJmeem</li></ul>`]
  };

  function renderInfo(key) {
    const [title, html] = INFO[key] || INFO.faq;
    $('#infoCrumb').innerHTML = title;
    $('#infoBody').innerHTML = `<h1>${title}</h1>${html}`;
  }

  /* ---------------------------------------------------------------
     UI CHROME — drawer, modals, reveals, announcements
  --------------------------------------------------------------- */
  const openDrawer = () => {
    $('#mobileDrawer').classList.add('open'); $('#mobileDrawer').setAttribute('aria-hidden', 'false');
    $('#hamburger').setAttribute('aria-expanded', 'true'); $('#overlay').hidden = false; document.body.classList.add('locked');
  };
  function closeDrawer() {
    const d = $('#mobileDrawer'); if (!d) return;
    d.classList.remove('open'); d.setAttribute('aria-hidden', 'true');
    $('#hamburger').setAttribute('aria-expanded', 'false');
    if (!$('#cart').classList.contains('open') && !$('#filters')?.classList.contains('open')) { $('#overlay').hidden = true; document.body.classList.remove('locked'); }
  }
  $('#hamburger')?.addEventListener('click', () => ($('#mobileDrawer').classList.contains('open') ? closeDrawer() : openDrawer()));
  $('#drawerClose')?.addEventListener('click', closeDrawer);
  // Links to the route we're already on fire no hashchange, so close the drawer here too.
  $('#mobileDrawer')?.addEventListener('click', (e) => { if (e.target.closest('a[href^="#/"]')) closeDrawer(); });

  let lastFocus = null;
  function openModal(sel) {
    lastFocus = document.activeElement;
    const m = $(sel); m.hidden = false; document.body.classList.add('locked');
    setTimeout(() => m.querySelector('input, button')?.focus(), 60);
  }
  function closeModal(sel) {
    const m = $(sel); m.hidden = true;
    if (!$('#cart').classList.contains('open') && !$('#mobileDrawer').classList.contains('open') && !$('#filters')?.classList.contains('open')) document.body.classList.remove('locked');
    lastFocus?.focus?.();
  }
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-modal-close]')) { closeModal('#' + e.target.closest('.modal').id); return; }
    if (e.target.classList.contains('modal')) closeModal('#' + e.target.id);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    $$('.modal:not([hidden])').forEach((m) => closeModal('#' + m.id));
    closeCart(); closeDrawer(); closeFilters();
    if (!$('#searchBar').hidden) closeSearch();
  });

  // bottom nav
  $$('.bottomnav [data-bn]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.bn;
    if (k === 'search') { openSearch(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    if (k === 'bag') openCart();
    if (k === 'account') { state.user ? (location.hash = '#/account') : openAuth('login'); }
  }));

  // scroll reveal
  let io;
  function observeReveals() {
    if (!('IntersectionObserver' in window)) { $$('.reveal').forEach((r) => r.classList.add('in')); return; }
    io = io || new IntersectionObserver((entries) => {
      entries.forEach((en) => { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } });
    }, { rootMargin: '0px 0px -8% 0px', threshold: .06 });
    $$('.reveal:not(.in)').forEach((r) => io.observe(r));
  }

  // sticky header shadow
  addEventListener('scroll', () => { $('#header').classList.toggle('scrolled', scrollY > 8); }, { passive: true });

  // rotating announcement
  const ANN = ['Packed with love from BJmeem ♡', 'Teddy-approved comfort 🧸', 'Free delivery on orders over 20 KWD ☁️', 'Made for cozy nights. 🌙', 'New cotton drops every month 🎀'];
  let annI = 0;
  const setAnn = (i) => { annI = (i + ANN.length) % ANN.length; const el = $('#announceText'); el.style.animation = 'none'; void el.offsetWidth; el.style.animation = ''; el.textContent = ANN[annI]; };
  let annTimer = setInterval(() => setAnn(annI + 1), 4200);
  $('#annNext')?.addEventListener('click', () => { clearInterval(annTimer); setAnn(annI + 1); annTimer = setInterval(() => setAnn(annI + 1), 6000); });
  $('#annPrev')?.addEventListener('click', () => { clearInterval(annTimer); setAnn(annI - 1); annTimer = setInterval(() => setAnn(annI + 1), 6000); });

  /* ---------------------------------------------------------------
     BOOT
  --------------------------------------------------------------- */
  function init() {
    buildFilterUI();
    renderHome();
    renderCart();
    paintUser();
    syncBadges();
    observeReveals();
    addEventListener('hashchange', router);
    router();
    connectToSupabase();
  }

  /**
   * Swap the demo catalogue for the live one, if a Supabase project is
   * configured. Deliberately non-blocking and non-fatal: the storefront has
   * already rendered by this point, so a slow or absent backend costs nothing.
   */
  function connectToSupabase() {
    const start = async () => {
      const api = window.BJmeemAPI;
      if (!api || !api.isConfigured) return;
      try {
        if (await loadCatalogFromSupabase(api)) repaintAfterCatalogChange();
      } catch (e) {
        console.warn('[BJmeem] Falling back to the built-in catalogue:', e?.message || e);
      }
    };
    if (window.BJmeemAPI) start();
    else addEventListener('bjmeem:api-ready', start, { once: true });
  }
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init) : init();

  /* ---------------------------------------------------------------
     API_STUB — swap these for real endpoints when a backend exists.
     Every read/write above goes through `store`, so only this layer
     and the four calls in the auth/checkout handlers need to change.
       POST /api/auth/login     { email, password }
       POST /api/auth/register  { name, email, password }
       POST /api/auth/reset     { email }
       GET  /api/products?cat&size&color&pattern&max&sort&q
       POST /api/cart           { items:[{id,size,color,qty}] }
       POST /api/orders         { customer, items, total }
  --------------------------------------------------------------- */
  window.BJmeem = { state, PRODUCTS, addToCart, toggleWish, openAuth, openCheckout };
})();
