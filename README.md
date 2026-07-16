# Next Sailing

A quick-glance dashboard for the Russell Island ⇄ Redland Bay ferry (SMBI service): your distance to the terminal, the next sailing, and when to leave.

## Run locally

```
npm install
npm run dev
```

## Deploy

Push this repo to GitHub, then import it on [vercel.com](https://vercel.com) — it deploys with no extra config.

### Optional: live ferry-time lookups

Out of the box, the app shows an approximate schedule (~every 30 min, based on the published service span) plus links to check exact times — no setup needed.

To switch on live, web-search-backed lookups instead:

1. Get an API key from [console.anthropic.com](https://console.anthropic.com)
2. In your Vercel project: Settings → Environment Variables → add `ANTHROPIC_API_KEY`
3. Redeploy — `api/next-ferry.js` will start returning live times

The key stays server-side and is never exposed to the browser.

## Notes

- Terminal coordinates are hardcoded (Russell Island ferry terminal + Redland Bay Marina)
- Drive-time estimate is straight-line distance ÷ 32 km/h — a rough guide, not turn-by-turn directions
- Your direction/distance preferences are saved in the browser's local storage
