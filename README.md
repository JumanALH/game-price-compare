# GamePrice — Steam vs GOG

Compare the live price of any game across Steam and GOG, browse both stores'
current discounts, and find the cheapest Steam region to buy in.

Live at <https://game-price-compare.onrender.com>

Built by JumanALH.

## Features

- **Compare** — search a game and see Steam and GOG side by side, with the
  cheaper store marked and the exact saving.
- **Free for a limited time** — claim-and-keep giveaways on either store.
  Only normally-paid games currently at zero; free-to-play titles and demos
  are excluded.
- **Store deals** — the full discount catalogue for each store, filterable by
  genre and paginated.
- **Regions** — a game's Steam price across 11 regions, converted to USD, with
  the five cheapest listed alongside Saudi Arabia.
- **Favorites** — saved in the browser, no account needed.
- 18 currencies, light and dark themes, and a mobile layout.

## Running locally

Requires Node.js 18 or newer.

```
npm install
npm start
```

Then open <http://localhost:3000>.

## How it works

Steam and GOG block browsers from reading their prices directly (CORS), so a
small Express server sits in between and talks to them on the page's behalf.

- Steam returns prices in the requested currency. GOG always returns USD, so
  those are converted at the current exchange rate, with fallback rates if the
  rate API is unavailable.
- Region prices are fetched per region, converted to USD, then sorted.
- Responses are cached for a few minutes. GOG rate-limits aggressively, and if
  it is unreachable the site still renders Steam results.

## Notes

- Region prices are estimates, and buying cross-region may require a payment
  method from that region.
- A game missing from one store means it is not sold there, or is listed under
  a different name.
- A personal comparison tool, not affiliated with Valve or GOG.

## Files

| File | Purpose |
|------|---------|
| `server.js` | API, currency conversion, deals, regions, caching, security headers |
| `public/index.html` | The entire front end — markup, styles and script in one file |
| `public/v0/index.html` | The previous design, kept for reference |
| `DEPLOY.md` | Deployment steps |

The front end is deliberately a single self-contained file: external
stylesheets, scripts and images were failing to load for some visitors, so
everything including the header image is inlined.
