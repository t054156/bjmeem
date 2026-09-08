# BJmeem

Cute cotton pajamas & cozy sleepwear — a responsive front-end e-commerce store.

## Stack

- HTML5 / CSS3 / vanilla JavaScript — no framework, no build step
- All product imagery is generated at runtime as inline SVG, so the site ships with zero image assets
- Cart, wishlist, login state and orders persist in `localStorage`

## Run locally

Open `index.html` directly in a browser — no server required.

Optionally, with Node installed:

```bash
node server.js   # http://localhost:5173
```

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Markup for every view (home, shop, product, wishlist, about, account, info) |
| `style.css` | Design tokens, layout, components, responsive rules, animations |
| `script.js` | Catalog, SVG artwork factory, router, filters, cart, auth, checkout |
| `server.js` | Optional static preview server |

## Backend integration

All persistence goes through a single `store` helper in `script.js`. The `API_STUB` comment at the
end of that file lists the endpoints a real backend would need.
