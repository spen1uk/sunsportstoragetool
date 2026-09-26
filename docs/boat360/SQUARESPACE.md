# Putting the 360° viewer on a Squarespace product page

Squarespace can't run this viewer itself. Instead, the viewer is hosted by this Next.js app, and the Squarespace page shows it in an iframe through a Code Block. It works the same way as embedding a YouTube video.

```
Squarespace product page ── Code Block (iframe) ──► https://<viewer host>/embed/boats/<slug>
```

## 1. Host the viewer (one-time)

- **Deploy the app** anywhere that runs Next.js, such as Vercel.
- **Set the environment variables** the app already uses (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`).
- **Public pages:** `/boats/*` and `/embed/*` are public. Every staff page still requires a login.
- **Custom domain (recommended):** add something like `viewer.sunsportmarineinc.com` in the host's settings and a CNAME record in Squarespace → Settings → Domains → DNS.
- **Allowed sites:** only the sites listed in `next.config.ts` (`EMBED_ANCESTORS`) may frame `/embed/*`. The list is `sunsportmarineinc.com`, `www.sunsportmarineinc.com` and `*.squarespace.com`, and `localhost` in development. Add any other domain the site uses.

## 2. Add the viewer to the boat's product page

1. In Squarespace, open **Commerce → Inventory** and open the product (e.g. the 2000 Harris-Kayot 220 Classic).
2. Scroll to **Additional Info** and click **+** → **Code**. Product descriptions can't hold code, but Additional Info can.
3. Paste the snippet from `docs/boat360/squarespace-embed.html` and replace these placeholders:
   - `VIEWER_ORIGIN`: the viewer host, e.g. `https://viewer.sunsportmarineinc.com`, with no trailing slash
   - `BOAT_SLUG`: `harris-kayot-220-classic` (it appears twice)
   - `BOAT_TITLE`: `2000 Harris-Kayot 220 Classic`
4. Turn **Display source code** off. Apply the change, then save.

Code Blocks that run JavaScript need a Squarespace plan that allows custom code (Core or higher, or a legacy Business/Commerce plan).

## What the snippet does

- **Shows the viewer** in the page: 360° spin, hotspots, galleries, zoom and the walkaround video.
- **Sizes the frame automatically**, so there's no inner scrollbar. The viewer reports its height with `postMessage`.
- **Fullscreen:** on desktop and Android the fullscreen button works normally. iPhones don't allow fullscreen inside an iframe, so the snippet expands the frame to cover the screen instead.
- **Links open in the full browser tab**, not inside the frame. This includes the trailer link.

## Adding more boats

Each boat is a data entry in `lib/boats/data/` plus media in `public/boat-media/<slug>/` (see `ARCHITECTURE.md`). Once a boat is deployed, paste the same snippet on its product page with that boat's slug.
