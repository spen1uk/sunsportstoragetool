import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('every API route is registered once: a later route with the same method and path would be silently shadowed by the earlier one', () => {
  const src = fs.readFileSync(new URL('../http.ts', import.meta.url), 'utf8'); const seen = new Map<string, number>();
  for (const m of src.matchAll(/^route\('([A-Z]+)', '([^']+)'/gm)) { const k = `${m[1]} ${m[2].replace(/:[A-Za-z]+/g, ':p')}`; seen.set(k, (seen.get(k) ?? 0) + 1); }
  const dupes = [...seen].filter(([, n]) => n > 1).map(([k]) => k); assert.deepEqual(dupes, []);
});
