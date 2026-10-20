import { chromium, type BrowserContext, type Page } from 'playwright-core';
import path from 'node:path';
import { mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { config } from './config.ts';
import type { Driver, BrowserPage, Snap } from './browser.ts';

/**
 * The real browser behind the Jarvis browser (Playwright, driving the Google Chrome already on this Mac in its own profile folder, so your everyday Chrome,
 * history and passwords are never touched). While Jarvis is acting, the browser itself refuses: anything that changes data (PUT, DELETE, PATCH), form posts to other
 * sites, moving to another site, downloads, pop-up windows and dialogs. While Luke is logging in, nothing is blocked, because he is the one driving.
 */
const profileDir = (id = 'custom') => path.join(config.dataDir, `browser-profile-${id}`);   // one folder per browser: a profile made by one browser can break in another
const SCHEME = process.env.JARVIS_BROWSER_ALLOW_HTTP === '1' ? '^https?:' : '^https:';   // http only ever for the local test page
const COLLECT = `() => {
  const vis = (el) => { const r = el.getBoundingClientRect(), cs = getComputedStyle(el); return r.width > 2 && r.height > 2 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  document.querySelectorAll('[data-jv]').forEach((e) => e.removeAttribute('data-jv'));
  const items = []; let n = 1;
  for (const el of document.querySelectorAll('a[href], button, [role=button], [role=tab], [role=link], [role=menuitem], summary')) {
    if (!vis(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
    const form = el.closest('form'); if (form && (el.matches('button[type=submit]') || form.querySelector('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, select'))) continue;
    const text = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\\s+/g, ' ').trim().slice(0, 80); if (!text) continue;
    const isA = el.tagName === 'A'; if (isA && !/${SCHEME}/i.test(el.href)) continue;
    el.setAttribute('data-jv', String(n)); items.push({ n, text, kind: isA ? 'link' : 'button', href: isA ? el.href : undefined }); n++; if (n > 150) break;
  }
  const pw = [...document.querySelectorAll('input[type=password]')].some(vis);
  return { url: location.href, title: document.title, text: document.body ? document.body.innerText : '', items, needsLogin: pw };
}`;

/** The Chromium-based browsers Jarvis can drive, in the order tried when none is chosen. */
export const BROWSERS: { id: string; label: string; app: string; exe: string }[] = [
  { id: 'brave', label: 'Brave', app: 'Brave Browser', exe: 'Brave Browser' },
  { id: 'chrome', label: 'Google Chrome', app: 'Google Chrome', exe: 'Google Chrome' },
  { id: 'edge', label: 'Microsoft Edge', app: 'Microsoft Edge', exe: 'Microsoft Edge' },
  { id: 'chromium', label: 'Chromium', app: 'Chromium', exe: 'Chromium' },
];
const bases = () => ['/Applications', `${homedir()}/Applications`];
export const exePath = (b: { app: string; exe: string }) => bases().map((d) => `${d}/${b.app}.app/Contents/MacOS/${b.exe}`).find((p) => existsSync(p)) ?? null;
/** The browser to use: his choice if installed, else the first one found. */
export function pickBrowser(prefer?: string): { id: string; label: string; path: string } | null {
  const order = [...BROWSERS.filter((b) => b.id === prefer), ...BROWSERS.filter((b) => b.id !== prefer)];
  for (const b of order) { const p = exePath(b); if (p) return { id: b.id, label: b.label, path: p }; } return null;
}
export function realDriver(): Driver {
  return {
    async open(_startUrl, allow, prefer) {
      const picked = process.env.JARVIS_BROWSER_PATH ? { id: 'custom', path: process.env.JARVIS_BROWSER_PATH } : pickBrowser(prefer); if (!picked) throw new Error('no browser: install Brave, Google Chrome, Microsoft Edge or Chromium'); const exe = picked.path;
      mkdirSync(profileDir(picked.id), { recursive: true, mode: 0o700 });
      const ctx: BrowserContext = await chromium.launchPersistentContext(profileDir(picked.id), { executablePath: exe, headless: process.env.JARVIS_BROWSER_HEADLESS === '1', viewport: { width: 1240, height: 860 }, acceptDownloads: false, args: ['--no-first-run', '--no-default-browser-check'] });
      let acting = false, blocked = 0; const page: Page = ctx.pages()[0] ?? await ctx.newPage();
      await ctx.route('**/*', async (route) => {
        try {
          if (!acting) return await route.continue();
          const rq = route.request(), m = rq.method(), url = rq.url();
          if (!/^(https?|data|blob|about):/.test(url)) { blocked++; return await route.abort('blockedbyclient'); }
          if (m === 'PUT' || m === 'DELETE' || m === 'PATCH') { blocked++; return await route.abort('blockedbyclient'); }
          if (m === 'POST' && /^https?:/.test(url) && !allow(url)) { blocked++; return await route.abort('blockedbyclient'); }
          if (rq.isNavigationRequest()) {   // moving to another site is refused; so is a new window (its frame is not yet known)
            let main = false; try { main = rq.frame() === page.mainFrame(); } catch { main = true; }
            if (main && /^https?:/.test(url) && !allow(url)) { blocked++; return await route.abort('blockedbyclient'); }
          }
          return await route.continue();
        } catch { try { await route.abort('blockedbyclient'); } catch { /* the page went away */ } }   // anything unexpected: refuse
      });
      ctx.on('page', (p) => { if (p !== page && acting) void p.close().catch(() => undefined); });
      page.on('dialog', (d) => void d.dismiss().catch(() => undefined)); page.on('download', (d) => void d.cancel().catch(() => undefined));
      const act = async (f: () => Promise<unknown>) => {
        acting = true;
        try {
          await f(); await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => undefined); await page.waitForTimeout(400);
          const here = page.url(); if (/^(https?:|chrome-error:)/.test(here) && !allow(here)) { await page.goBack({ timeout: 8000 }).catch(() => undefined); await page.waitForTimeout(300); }   // landed on a refused address or its error page: step back while still guarded
        } finally { acting = false; }
      };
      const bp: BrowserPage = {
        goto: (url) => act(() => page.goto(url, { timeout: 20_000, waitUntil: 'domcontentloaded' })).then(() => undefined),
        snapshot: async () => { const s = await page.evaluate(`(${COLLECT})()`) as Snap; return s; },
        click: (n) => act(() => page.locator(`[data-jv="${Math.trunc(n)}"]`).first().click({ timeout: 5000 })).then(() => undefined),
        scroll: () => act(() => page.evaluate('window.scrollBy(0, Math.round(window.innerHeight * 0.85))')).then(() => undefined),
        back: () => act(() => page.goBack({ timeout: 10_000 })).then(() => undefined),
        url: () => page.url(),
        close: async () => { await ctx.close().catch(() => undefined); },
        blockedRequests: () => blocked,
      };
      return bp;
    },
    async clearLogins() { try { for (const d of readdirSync(config.dataDir)) if (d.startsWith('browser-profile')) rmSync(path.join(config.dataDir, d), { recursive: true, force: true }); } catch { /* nothing to clear */ } },
  };
}
