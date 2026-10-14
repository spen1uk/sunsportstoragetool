// Bot City dashboard: tabs, polling, Floor / Data / Lab views. The 3D city lives in city.js.

export const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
export const usd = (v, sign = false) => (v == null ? "–" : (sign && v > 0 ? "+" : v < 0 ? "−" : "") + "$" + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
export const pct = (v, sign = true) => (v == null ? "–" : (sign && v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(2) + "%");
export const px = (v) => (v == null ? "–" : v >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : v >= 1 ? v.toFixed(3) : v.toPrecision(4));
export const when = (t) => String(t ?? "").slice(5).replace(" 00:00", "");
export const cls = (v) => (v > 0 ? "up" : v < 0 ? "down" : "");
export const color = (slot) => `var(--series-${((slot - 1) % 5) + 1})`;
export const ICON = { fire: "⚡", setup: "◔", scan: "◌", manage: "●", pause: "⏸", halted: "⛔" };

// ---------- tooltip
const tip = $("tip");
export function showTip(e, html) { tip.innerHTML = html; tip.style.display = "block";
  const x = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8), y = Math.max(8, e.clientY - tip.offsetHeight - 10);
  tip.style.left = x + "px"; tip.style.top = y + "px"; }
export function hideTip() { tip.style.display = "none"; }

// ---------- line chart with crosshair (equity curve + sparklines)
export function lineChart(svg, values, { stroke = "var(--accent)", labels = null, fmt = usd, axis = true, base = null } = {}) {
  const W = svg.clientWidth || 600, H = svg.clientHeight || 190;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.innerHTML = "";
  if (values.length < 2) { svg.innerHTML = `<text x="8" y="22" class="axis-t">No trades yet - the line appears after the first closed trade.</text>`; return; }
  const padL = axis ? 58 : 2, padR = axis ? 10 : 6, padT = 8, padB = axis ? 18 : 4;
  let lo = Math.min(...values, base ?? Infinity), hi = Math.max(...values, base ?? -Infinity);
  if (lo === hi) { lo -= 1; hi += 1; }
  const X = (i) => padL + (i / (values.length - 1)) * (W - padL - padR);
  const Y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
  let g = "";
  if (axis) for (const v of [lo, (lo + hi) / 2, hi]) g += `<line x1="${padL}" x2="${W - padR}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--grid)"/><text x="${padL - 6}" y="${Y(v) + 4}" text-anchor="end" class="axis-t">${fmt(v)}</text>`;
  if (base != null) g += `<line x1="${padL}" x2="${W - padR}" y1="${Y(base)}" y2="${Y(base)}" stroke="var(--axis)"/>`;
  const d = values.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join("");
  const last = values.length - 1;
  svg.innerHTML = g + `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linejoin="round" style="filter:drop-shadow(0 0 4px ${stroke})"/>`
    + `<circle cx="${X(last)}" cy="${Y(values[last])}" r="4" fill="${stroke}" stroke="var(--surface)" stroke-width="2"/>`
    + `<line class="xh" y1="${padT}" y2="${H - padB}" stroke="var(--ink-2)" stroke-width="1" visibility="hidden"/>`
    + `<circle class="xd" r="4" fill="${stroke}" stroke="var(--surface)" stroke-width="2" visibility="hidden"/>`
    + `<rect x="0" y="0" width="${W}" height="${H}" fill="transparent"/>`;
  const xh = svg.querySelector(".xh"), xd = svg.querySelector(".xd");
  svg.onmousemove = (e) => {
    const r = svg.getBoundingClientRect(), mx = (e.clientX - r.left) * (W / r.width);
    const i = Math.max(0, Math.min(last, Math.round(((mx - padL) / (W - padL - padR)) * last)));
    xh.setAttribute("x1", X(i)); xh.setAttribute("x2", X(i)); xh.setAttribute("visibility", "visible");
    xd.setAttribute("cx", X(i)); xd.setAttribute("cy", Y(values[i])); xd.setAttribute("visibility", "visible");
    showTip(e, `<b>${fmt(values[i])}</b>${labels ? `<div class="s">${esc(labels[i])}</div>` : ""}`);
  };
  svg.onmouseleave = () => { xh.setAttribute("visibility", "hidden"); xd.setAttribute("visibility", "hidden"); hideTip(); };
}

// ---------- daily profit/loss bars (good = green, loss = red, shared zero baseline)
export function dailyBars(svg, rows) {
  const W = svg.clientWidth || 600, H = svg.clientHeight || 190;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  if (!rows.length) { svg.innerHTML = `<text x="8" y="22" class="axis-t">No closed trades yet.</text>`; return; }
  const padL = 58, padR = 10, padT = 8, padB = 22;
  const vals = rows.map((r) => r.pnl), hi = Math.max(0, ...vals), lo = Math.min(0, ...vals), span = hi - lo || 1;
  const Y = (v) => padT + (1 - (v - lo) / span) * (H - padT - padB);
  const bw = (W - padL - padR) / rows.length, gap = Math.min(8, bw * 0.3);
  let s = "";
  for (const v of [lo, hi]) if (v !== 0) s += `<line x1="${padL}" x2="${W - padR}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--grid)"/><text x="${padL - 6}" y="${Y(v) + 4}" text-anchor="end" class="axis-t">${usd(v, true)}</text>`;
  rows.forEach((r, i) => {
    const x = padL + i * bw + gap / 2, w = bw - gap, y0 = Y(0), y1 = Y(r.pnl), h = Math.max(1, Math.abs(y1 - y0));
    s += `<rect data-i="${i}" x="${x}" y="${Math.min(y0, y1)}" width="${w}" height="${h}" rx="3" fill="${r.pnl >= 0 ? "var(--good)" : "var(--bad)"}"/>`;
    if (rows.length <= 14 && (i === 0 || i === rows.length - 1)) s += `<text x="${x + w / 2}" y="${H - 6}" text-anchor="middle" class="axis-t">${esc(r.day.slice(5))}</text>`;
  });
  s += `<line x1="${padL}" x2="${W - padR}" y1="${Y(0)}" y2="${Y(0)}" stroke="var(--axis)"/><text x="${padL - 6}" y="${Y(0) + 4}" text-anchor="end" class="axis-t">$0</text>`;
  svg.innerHTML = s;
  svg.querySelectorAll("rect").forEach((el) => {
    const r = rows[+el.dataset.i];
    el.onmousemove = (e) => showTip(e, `<b class="${cls(r.pnl)}">${r.pnl >= 0 ? "▲" : "▼"} ${usd(r.pnl, true)}</b><div class="s">${esc(r.day)}</div>`);
    el.onmouseleave = hideTip;
  });
}

// ---------- render
export function workerCard(w, sparkId) {
    const segs = w.checklist.map((c) => `<span class="seg ${c.ok ? "on" : ""}"></span>`).join("");
    const p = w.position;
    return `<article class="panel worker" style="--c:${color(w.slot)}">
      <div class="w-head"><span class="dot"></span><span class="w-name">${esc(w.name)}</span>
        <div class="w-price"><div class="p">${px(w.price)}</div><div class="c ${cls(w.change_pct)}">${pct(w.change_pct)}</div></div></div>
      <span class="status s-${w.status_kind}">${ICON[w.status_kind] || ""} ${esc(w.status)}</span>
      <div class="thought">${esc(w.thought)}</div>
      <svg class="spark" id="${sparkId}" role="img" aria-label="${esc(w.name)} recent closes"></svg>
      <div class="charge"><div class="row"><span>Signal charge</span><b>${Math.round(w.charge * 100)}% charged</b></div><div class="segs">${segs}</div></div>
      <ul class="checks">${w.checklist.map((c) => `<li class="${c.ok ? "ok" : "no"}"><span class="ic">${c.ok ? "✓" : "✗"}</span><span>${esc(c.name)}</span><span class="det">${esc(c.detail)}</span></li>`).join("")}</ul>
      ${p ? `<div class="pos"><div class="top"><span>${esc(p.side)} since ${esc(when(p.since))}</span><span class="${cls(p.upnl)}">${usd(p.upnl, true)} · ${p.r >= 0 ? "+" : "−"}${Math.abs(p.r).toFixed(2)}R</span></div>
        <div class="track"><i style="left:${(p.progress * 100).toFixed(1)}%"></i></div>
        <div class="track-l"><span>stop ${px(p.stop)}</span><span>entry ${px(p.entry)}</span><span>target ${px(p.target)}</span></div></div>` : ""}
      <div class="pay"><span>Today <b>${w.today.trades}</b> trades · <b class="${cls(w.today.earned)}">${usd(w.today.earned, true)}</b></span>
        <span>All time <b class="${cls(w.all.earned)}">${usd(w.all.earned, true)}</b></span></div>
    </article>`;
}

export function renderFloor(s) {
  $("mode").textContent = (s.demo ? "DEMO · simulated prices" : `${s.mode} · ${s.timeframe} candles`) + ` · rules v${s.version}`;
  let b = "";
  if (s.demo) b += `<div class="banner demo">⚠ Demo data from simulated prices - this shows how the dashboard works, not real performance.</div>`;
  if (s.guards.halted) b += `<div class="banner halt">⛔ ${esc(s.guards.halt_reason)}</div>`;
  else if (s.guards.paused_until) b += `<div class="banner pause">⏸ Cooling off after a losing streak until ${esc(s.guards.paused_until)} UTC</div>`;
  else if (s.guards.daily_loss_hit) b += `<div class="banner pause">⏸ Daily loss limit reached - no new trades until tomorrow (UTC)</div>`;
  $("banners").innerHTML = b;

  const v = s.vault;
  $("kpis").innerHTML = `
    <div class="panel kpi hero"><div class="k">The vault · equity (started ${usd(v.start)})</div><div class="v">${usd(v.equity)}</div><div class="${cls(v.return_pct)}">${pct(v.return_pct)} all time</div></div>
    <div class="panel kpi"><div class="k">Today</div><div class="v ${cls(v.today)}">${usd(v.today, true)}</div></div>
    <div class="panel kpi"><div class="k">Win rate</div><div class="v">${v.trades ? v.win_rate.toFixed(0) + "%" : "–"}</div><div class="k">${v.trades} closed trades</div></div>
    <div class="panel kpi"><div class="k">Open trades</div><div class="v">${v.open}</div></div>
    <div class="panel kpi"><div class="k">Below peak</div><div class="v">${v.drawdown_pct.toFixed(1)}%</div><div class="k">worst ${v.max_dd_pct.toFixed(1)}% · stops at 20%</div></div>`;

  $("workers").innerHTML = s.workers.map((w, i) => workerCard(w, "spark" + i)).join("");
  s.workers.forEach((w, i) => lineChart($("spark" + i), w.spark, { stroke: color(w.slot), axis: false, fmt: px }));

  lineChart($("curve"), s.curve.map((p) => p[1]), { labels: s.curve.map((p, i) => i ? `after trade ${i}` : "start"), base: v.start });
  dailyBars($("daily"), s.daily);

  $("feed").innerHTML = s.thoughts.length ? s.thoughts.map((t) =>
    `<li><span class="t">${esc(when(t.time))}</span><span class="tag ${esc(t.kind)}">${esc(t.kind)}</span><span class="m">${esc(t.message)}</span></li>`).join("")
    : `<li class="empty">No activity yet.</li>`;

  const rows = [...s.workers].sort((a, b) => b.all.earned - a.all.earned);
  $("payroll").innerHTML = `<thead><tr><th>#</th><th>Worker</th><th>Status</th><th class="n">Today trades</th><th class="n">Today earned</th><th class="n">All trades</th><th class="n">Win rate</th><th class="n">All earned</th></tr></thead><tbody>`
    + rows.map((w, i) => `<tr><td>${i + 1}</td><td><span class="dot" style="--c:${color(w.slot)};display:inline-block;margin-right:6px"></span>${esc(w.name)}</td>
      <td class="s-${w.status_kind}">${ICON[w.status_kind] || ""} ${esc(w.status)}</td><td class="n">${w.today.trades}</td>
      <td class="n ${cls(w.today.earned)}">${usd(w.today.earned, true)}</td><td class="n">${w.all.trades}</td>
      <td class="n">${w.all.trades ? Math.round((w.all.wins / w.all.trades) * 100) + "%" : "–"}</td>
      <td class="n ${cls(w.all.earned)}">${usd(w.all.earned, true)}</td></tr>`).join("") + `</tbody>`;

  const slotOf = Object.fromEntries(s.workers.map((w) => [w.symbol, w.slot]));
  $("trades").innerHTML = s.trades.length ? s.trades.map((t) => `<div class="tcard">
      <div class="top"><span class="dot" style="--c:${color(slotOf[t.symbol] || 1)}"></span>${esc(t.symbol.split("-")[0])} · ${esc(t.side)}</div>
      <div class="amt ${cls(t.pnl)}">${t.pnl >= 0 ? "▲" : "▼"} ${usd(t.pnl, true)}</div>
      <dl><dt>Entry</dt><dd>${esc(when(t.entry_time))} @ ${px(t.entry)}</dd><dt>Exit</dt><dd>${esc(when(t.exit_time))} @ ${px(t.exit)}</dd>
      <dt>Held</dt><dd>${t.bars} candles</dd><dt>How it closed</dt><dd>${esc(t.how)}</dd>
      <dt>Result</dt><dd>${t.r >= 0 ? "+" : "−"}${Math.abs(t.r).toFixed(2)}R · best ${t.best_r.toFixed(1)}R</dd></dl></div>`).join("")
    : `<div class="empty">No closed trades yet.</div>`;
}


// ====================================================================== DATA view
const STATUS = { ok: ["good", "●", "Healthy"], warn: ["warn", "▲", "Attention"], bad: ["bad", "■", "Problem"], idle: ["idle", "○", "Waiting"] };

function pipelineNodes(s) {
  const h = s.health || {}, feeds = Object.values(h.feeds || {}), lab = s.lab || {};
  const snapAge = s.demo ? 0 : (Date.now() - (h.snapshot_at || 0)) / 1000;
  const fetchAge = s.demo ? 0 : (Date.now() - (h.last_fetch_ok || 0)) / 1000;
  const fresh = feeds.filter((f) => f.fresh).length;
  const warm = feeds.every((f) => f.bars >= 60);
  const setups = s.workers.filter((w) => w.status_kind === "setup" || w.status_kind === "fire").length;
  const errs = (h.errors || []).length;
  return [
    { id: "api", name: "BloFin API", st: !h.last_fetch_ok ? "idle" : fetchAge < 180 ? (errs ? "warn" : "ok") : fetchAge < 900 ? "warn" : "bad",
      detail: h.last_fetch_ok ? `last price download ${Math.round(fetchAge)}s ago${errs ? ` · ${errs} recent errors` : ""}` : "not connected yet" },
    { id: "candles", name: "Candles", st: !feeds.length ? "idle" : fresh === feeds.length ? "ok" : fresh ? "warn" : "bad",
      detail: `${fresh}/${feeds.length} coins up to date (${s.timeframe} candles)` },
    { id: "ind", name: "Indicators", st: !feeds.length ? "idle" : warm ? "ok" : "warn",
      detail: warm ? "ribbon, SMMA, UT Bot, Stoch RSI calculated" : "warming up - needs 60+ candles" },
    { id: "signals", name: "Signals", st: s.workers.length ? "ok" : "idle",
      detail: `${setups} setup${setups === 1 ? "" : "s"} forming across ${s.workers.length} coins` },
    { id: "risk", name: "Risk manager", st: s.guards.halted ? "bad" : (s.guards.paused_until || s.guards.daily_loss_hit) ? "warn" : "ok",
      detail: s.guards.halted ? "kill switch ON" : s.guards.paused_until ? "cooling off after losses" : s.guards.daily_loss_hit ? "daily loss limit hit" : "all limits normal" },
    { id: "broker", name: "Paper broker", st: "ok", detail: `${s.vault.open} open trade${s.vault.open === 1 ? "" : "s"} · ${usd(s.vault.equity)} equity` },
    { id: "journal", name: "Journal", st: "ok", detail: `${s.vault.trades} trades logged` },
    { id: "learner", name: "Learner", st: (lab.versions || []).length || h.last_learn ? "ok" : "idle",
      detail: (lab.versions || []).length ? `rules v${s.version} · ${lab.versions.length} change(s) adopted` : h.last_learn ? "reviewed - no change passed testing" : "first review pending" },
    { id: "dash", name: "Dashboard", st: snapAge < 180 ? "ok" : "warn", detail: s.demo ? "demo data" : `updated ${Math.round(snapAge)}s ago` },
  ];
}

function renderData(s) {
  const nodes = pipelineNodes(s);
  const svg = $("pipeline"), W = svg.clientWidth || 1000, narrow = W < 700;
  const cols = narrow ? 3 : nodes.length, rows = Math.ceil(nodes.length / cols);
  const H = rows * 120 + 20; svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.style.height = H + "px";
  const cw = W / cols, pos = nodes.map((n, i) => {
    const r = Math.floor(i / cols), c = r % 2 ? cols - 1 - (i % cols) : i % cols; // snake layout on small screens
    return [cw * c + cw / 2, 60 + r * 120];
  });
  let g = "";
  for (let i = 0; i < nodes.length - 1; i++) {
    const [x1, y1] = pos[i], [x2, y2] = pos[i + 1];
    const d = y1 === y2 ? `M${x1},${y1} L${x2},${y2}` : `M${x1},${y1} C${x1},${(y1 + y2) / 2} ${x2},${(y1 + y2) / 2} ${x2},${y2}`;
    const live = nodes[i].st !== "idle" && nodes[i + 1].st !== "idle";
    g += `<path d="${d}" class="edge ${live ? "live" : ""}"/>`;
    if (live) g += `<circle r="3" class="packet"><animateMotion dur="${1.6 + (i % 3) * 0.3}s" repeatCount="indefinite" path="${d}"/></circle>`;
  }
  nodes.forEach((n, i) => {
    const [x, y] = pos[i], [k, icon] = STATUS[n.st];
    g += `<g class="node ${k}" transform="translate(${x},${y})"><circle r="20" class="halo"/><circle r="11" class="core"/>
      <text y="38" text-anchor="middle" class="nlabel">${esc(n.name)}</text><text y="-28" text-anchor="middle" class="nicon">${icon}</text></g>`;
  });
  svg.innerHTML = g;
  $("nodes").innerHTML = `<thead><tr><th>Step</th><th>Status</th><th>Details</th></tr></thead><tbody>` + nodes.map((n) => {
    const [k, icon, label] = STATUS[n.st];
    return `<tr><td>${esc(n.name)}</td><td class="st-${k}">${icon} ${label}</td><td class="muted">${esc(n.detail)}</td></tr>`;
  }).join("") + "</tbody>";
  const feeds = Object.entries((s.health || {}).feeds || {});
  $("feeds").innerHTML = `<thead><tr><th>Coin</th><th>Last candle</th><th class="n">Candles</th><th>Status</th></tr></thead><tbody>` +
    feeds.map(([c, f]) => `<tr><td>${esc(c)}</td><td>${esc(f.last_candle || "–")}</td><td class="n">${f.bars}</td><td class="${f.fresh ? "st-good" : "st-warn"}">${f.fresh ? "● fresh" : "▲ stale"}</td></tr>`).join("") + "</tbody>";
  const errs = (s.health || {}).errors || [];
  $("errors").innerHTML = errs.length ? errs.slice().reverse().map((e) => `<li><span class="t">${esc(when(e.time))}</span><span class="tag halt">error</span><span class="m">${esc(e.error)}</span></li>`).join("")
    : `<li class="empty">No errors. The bot retries automatically if BloFin hiccups.</li>`;
}

// ====================================================================== LAB view
function bars(svg, rows, { label = (r) => r.label, color = (r) => (r.value >= 0 ? "var(--good)" : "var(--bad)"), fmt = usd, tipFmt = null } = {}) {
  const W = svg.clientWidth || 600, H = svg.clientHeight || 190;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  if (!rows.length) { svg.innerHTML = `<text x="8" y="22" class="axis-t">No closed trades yet.</text>`; return; }
  const padL = 58, padR = 10, padT = 8, padB = 22;
  const vals = rows.map((r) => r.value), hi = Math.max(0, ...vals), lo = Math.min(0, ...vals), span = hi - lo || 1;
  const Y = (v) => padT + (1 - (v - lo) / span) * (H - padT - padB);
  const bw = (W - padL - padR) / rows.length, gap = Math.min(6, bw * 0.25);
  let s = "";
  for (const v of [lo, hi]) if (v !== 0) s += `<line x1="${padL}" x2="${W - padR}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--grid)"/><text x="${padL - 6}" y="${Y(v) + 4}" text-anchor="end" class="axis-t">${fmt(v)}</text>`;
  const every = Math.ceil(rows.length / 8);
  rows.forEach((r, i) => {
    const x = padL + i * bw + gap / 2, w = bw - gap, y0 = Y(0), y1 = Y(r.value);
    s += `<rect data-i="${i}" x="${x}" y="${Math.min(y0, y1)}" width="${w}" height="${Math.max(1, Math.abs(y1 - y0))}" rx="3" fill="${color(r)}"/>`;
    if (i % every === 0) s += `<text x="${x + w / 2}" y="${H - 6}" text-anchor="middle" class="axis-t">${esc(label(r))}</text>`;
  });
  s += `<line x1="${padL}" x2="${W - padR}" y1="${Y(0)}" y2="${Y(0)}" stroke="var(--axis)"/><text x="${padL - 6}" y="${Y(0) + 4}" text-anchor="end" class="axis-t">${fmt(0)}</text>`;
  svg.innerHTML = s;
  svg.querySelectorAll("rect").forEach((el) => {
    const r = rows[+el.dataset.i];
    el.onmousemove = (e) => showTip(e, tipFmt ? tipFmt(r) : `<b>${fmt(r.value)}</b><div class="s">${esc(label(r))}</div>`);
    el.onmouseleave = hideTip;
  });
}

function renderLab(s) {
  const L = s.lab || {}, st = L.stats || {};
  const pf = st.profit_factor == null ? "∞" : st.trades ? st.profit_factor.toFixed(2) : "–";
  $("lab-kpis").innerHTML = `
    <div class="panel kpi"><div class="k">Return</div><div class="v ${cls(st.return_pct)}">${pct(st.return_pct || 0)}</div></div>
    <div class="panel kpi"><div class="k">Trades</div><div class="v">${st.trades || 0}</div></div>
    <div class="panel kpi"><div class="k">Win rate</div><div class="v">${st.trades ? st.win_rate.toFixed(0) + "%" : "–"}</div></div>
    <div class="panel kpi"><div class="k">Profit factor</div><div class="v">${pf}</div><div class="k">$ won ÷ $ lost</div></div>
    <div class="panel kpi"><div class="k">Average trade</div><div class="v ${cls(st.expectancy_r)}">${st.trades ? (st.expectancy_r >= 0 ? "+" : "−") + Math.abs(st.expectancy_r).toFixed(2) + "R" : "–"}</div><div class="k">R = multiple of amount risked</div></div>
    <div class="panel kpi"><div class="k">Worst drawdown</div><div class="v">${(st.max_dd_pct || 0).toFixed(1)}%</div><div class="k">kill switch at ${L.risk ? L.risk.max_drawdown_pct : 20}%</div></div>`;
  lineChart($("drawdown"), [0, ...(L.drawdown || [])], { stroke: "var(--bad-text)", fmt: (v) => v.toFixed(1) + "%", base: 0,
    labels: [0, ...(L.drawdown || [])].map((_, i) => (i ? `after trade ${i}` : "start")) });
  const edges = [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4];
  const counts = edges.slice(0, -1).map((lo, i) => ({ lo, hi: edges[i + 1], value: 0 }));
  for (const r of L.r || []) { const c = Math.max(-2, Math.min(3.999, r)); counts[Math.min(counts.length - 1, Math.floor((c + 2) / 0.5))].value++; }
  bars($("hist"), counts, { label: (r) => (r.lo > 0 ? "+" : "") + r.lo + "R", color: (r) => (r.lo < 0 ? "var(--bad)" : "var(--good)"), fmt: (v) => String(Math.round(v)),
    tipFmt: (r) => `<b>${r.value} trade${r.value === 1 ? "" : "s"}</b><div class="s">ended between ${r.lo}R and ${r.hi}R</div>` });
  bars($("monthly"), (L.months || []).map((m) => ({ label: m.month.slice(2), value: m.pnl, month: m.month })), {
    tipFmt: (r) => `<b class="${cls(r.value)}">${r.value >= 0 ? "▲" : "▼"} ${usd(r.value, true)}</b><div class="s">${esc(r.month)}</div>` });
  const NAMES = { ribbon_filter: "EMA ribbon filter", smma_filter: "SMMA 50 filter", stoch_filter: "Stoch RSI filter", ut_exit: "Exit on UT Bot sell",
    btc_filter: "Bitcoin trend filter", atr_stop_mult: "Stop distance (× ATR)", take_profit_r: "Profit target (R)", breakeven_at_r: "Move stop to breakeven at (R)",
    trail_atr_mult: "Trailing stop (× ATR, 0 = off)", stoch_max: "Stoch RSI max for entry", ut_key: "UT Bot sensitivity (key)", partial_tp_r: "Bank half at (R, 0 = off)",
    max_extension_atr: "Don't chase beyond (ATR, 0 = off)", min_trend_strength: "Min trend strength (0 = off)", max_bars_in_trade: "Max candles in a trade",
    max_atr_pct: "Max volatility (ATR %)", rsi_min: "RSI min (pullback strategy)", rsi_max: "RSI max (pullback strategy)" };
  $("params").innerHTML = `<thead><tr><th>Rule</th><th class="n">Setting</th></tr></thead><tbody>` + Object.entries(L.params || {}).map(([k, v]) =>
    `<tr><td>${esc(NAMES[k] || k)}</td><td class="n">${typeof v === "boolean" ? (v ? "● ON" : "○ off") : esc(v)}</td></tr>`).join("") + "</tbody>";
  $("versions").innerHTML = (L.versions || []).length ? L.versions.slice().reverse().map((v) =>
    `<li><span class="t">v${v.version}</span><span class="tag learn">adopted</span><span class="m">${esc(v.reason)}<br><span class="muted">${esc(v.at || "")}</span></span></li>`).join("")
    : `<li class="empty">Still on the original rules (v0). Changes appear here when one passes testing.</li>`;
  $("learning").textContent = L.learning || "No learning cycles yet. The bot reviews itself once a day.";
}

// ====================================================================== REPLAY (watch history play out in the city)
const KIND_LABEL = { halted: "Halted", manage: "In a trade", pause: "Paused", fire: "Firing", setup: "Setup forming", scan: "Scanning" };
const RP = { data: null, active: false, playing: false, idx: 0, start: 0, acc: 0, thoughts: [], lastThought: [], raf: 0, prev: 0 };

function rpState(i) {
  const R = RP.data, f = R.frames[i], day = f.t.slice(0, 10);
  const trades = R.trades.slice(0, f.k);
  const today = trades.filter((t) => t.day === day).reduce((a, t) => a + t.pnl, 0);
  const workers = R.symbols.map((sym, j) => {
    const w = f.w[j], cl = R.rules[j].map((name, r) => ({ name, ok: !!w.c[r], detail: "" }));
    return { symbol: sym, name: R.names[j], slot: j + 1, status_kind: w.k, status: KIND_LABEL[w.k] || w.k,
      charge: cl.length ? cl.filter((c) => c.ok).length / cl.length : 0, checklist: cl, position: w.pos || null,
      all: { earned: w.e }, thought: RP.lastThought[j] || "" };
  });
  return { replay: true, demo: false, time: f.t, workers, vault: { equity: f.eq, today }, trades: trades.slice().reverse(), thoughts: RP.thoughts, guards: {} };
}

function rpLog(i) { // add this frame's thoughts and closed trades to the ticker
  const R = RP.data, f = R.frames[i], prevK = i ? R.frames[i - 1].k : 0;
  f.w.forEach((w, j) => { if (w.th) { RP.lastThought[j] = w.th; RP.thoughts.unshift({ kind: "thought", message: `${R.names[j]}: ${w.th}` }); } });
  for (const t of R.trades.slice(prevK, f.k))
    RP.thoughts.unshift({ kind: "exit", message: `${t.symbol.split("-")[0]} ${t.side} closed ${t.pnl >= 0 ? "+" : "−"}$${Math.abs(t.pnl).toFixed(2)} (${t.r >= 0 ? "+" : ""}${t.r.toFixed(2)}R)` });
  RP.thoughts.length = Math.min(RP.thoughts.length, 14);
}

function rpShow(i, sequential) {
  const R = RP.data;
  if (!sequential) { // jumped: rebuild the latest thought per coin from earlier frames
    RP.thoughts = []; RP.lastThought = [];
    for (let k = i; k >= 0 && RP.lastThought.filter(Boolean).length < R.symbols.length; k--)
      R.frames[k].w.forEach((w, j) => { if (w.th && !RP.lastThought[j]) RP.lastThought[j] = w.th; });
    RP.lastThought.forEach((t, j) => t && RP.thoughts.push({ kind: "thought", message: `${R.names[j]}: ${t}` }));
  } else rpLog(i);
  RP.idx = i;
  const s = rpState(i);
  if (city) city.update(s, { coins: sequential });
  renderCityHud(s);
  const base = R.frames[RP.start].eq, ch = (s.vault.equity / base - 1) * 100;
  $("rp-date").textContent = s.time.slice(0, 10);
  $("rp-eq").innerHTML = `${usd(s.vault.equity)} <span class="${cls(ch)}">${pct(ch)}</span>`;
  $("rp-seek").value = i;
}

function rpTick(now) {
  if (!RP.playing) return;
  const dt = Math.min(0.25, (now - (RP.prev || now)) / 1000); RP.prev = now;
  RP.acc += dt * +$("rp-speed").value;
  const last = RP.data.frames.length - 1;
  while (RP.acc >= 1 && RP.idx < last) { RP.acc -= 1; rpShow(RP.idx + 1, true); }
  if (RP.idx >= last) { rpPause(); rpSummary(); return; }
  RP.raf = requestAnimationFrame(rpTick);
}
function rpPlay() {
  if (RP.idx >= RP.data.frames.length - 1) rpShow(RP.start, false);
  $("replay-msg").hidden = true;
  RP.playing = true; RP.prev = 0; RP.acc = 0; $("rp-play").textContent = "❚❚"; $("rp-play").setAttribute("aria-label", "Pause");
  RP.raf = requestAnimationFrame(rpTick);
}
function rpPause() { RP.playing = false; cancelAnimationFrame(RP.raf); $("rp-play").textContent = "▶"; $("rp-play").setAttribute("aria-label", "Play"); }
function rpSummary() {
  const R = RP.data, a = R.frames[RP.start], b = R.frames[R.frames.length - 1], n = b.k - a.k;
  const wins = R.trades.slice(a.k, b.k).filter((t) => t.pnl > 0).length, ch = (b.eq / a.eq - 1) * 100;
  rpMsg(`Replay finished: ${a.t.slice(0, 10)} → ${b.t.slice(0, 10)}<br/>
${n} trades · ${wins} wins · ${usd(a.eq)} → ${usd(b.eq)} <span class="${cls(ch)}">(${pct(ch)})</span>`);
}
function rpMsg(html) { $("replay-msg").innerHTML = html; $("replay-msg").hidden = !html; }

function rpRange() {
  const R = RP.data, v = $("rp-range").value, last = R.frames.length - 1;
  let start = 0;
  if (v !== "all") {
    const cutoff = new Date(R.frames[last].t.replace(" ", "T") + "Z").getTime() - +v * 86400000;
    start = Math.max(0, R.frames.findIndex((f) => new Date(f.t.replace(" ", "T") + "Z").getTime() >= cutoff));
  }
  RP.start = start; $("rp-seek").min = start; $("rp-seek").max = last;
  if (city) city.resetMoney();
  rpShow(start, false);
}

async function rpStart() {
  if (!city) return;
  RP.active = true; document.body.classList.add("replaying"); $("replay-bar").hidden = false; closeDrawer();
  if (!RP.data) {
    rpMsg("Building the replay from price history…<br><span class='muted small'>The first time can take up to a minute.</span>");
    for (;;) {
      const r = await fetch("api/replay", { cache: "no-store" });
      if (r.status === 202) { await new Promise((ok) => setTimeout(ok, 1500)); if (!RP.active) return; continue; }
      const d = await r.json();
      if (d.error || !d.frames || !d.frames.length) { rpMsg(esc(d.error || "No history available to replay.")); return; }
      RP.data = d; break;
    }
  }
  rpMsg(""); rpRange(); rpPlay();
}
function rpExit() {
  rpPause(); RP.active = false; document.body.classList.remove("replaying"); $("replay-bar").hidden = true; rpMsg("");
  if (city) { city.resetMoney(); if (lastState) city.update(lastState, { coins: false }); }
  if (lastState) renderAll(lastState);
}
$("btn-replay").onclick = () => (RP.active ? rpExit() : rpStart());
$("rp-play").onclick = () => (RP.playing ? rpPause() : rpPlay());
$("rp-exit").onclick = rpExit;
$("rp-range").onchange = () => { const was = RP.playing; rpPause(); rpRange(); if (was) rpPlay(); };
$("rp-seek").oninput = () => { rpShow(+$("rp-seek").value, false); };

// ====================================================================== tabs, polling, city glue
let city = null, cityFailed = false, lastOk = 0, lastState = null;
const views = ["city", "floor", "data", "lab"];
function currentView() { const v = location.hash.slice(1); return views.includes(v) ? v : "city"; }

async function showView() {
  const v = currentView();
  document.querySelectorAll(".view").forEach((el) => el.classList.toggle("active", el.id === "view-" + v));
  document.querySelectorAll(".topnav a").forEach((a) => a.classList.toggle("active", a.dataset.view === v));
  document.body.dataset.view = v;
  if (v === "city" && !city && !cityFailed) {
    try { const mod = await import("./city.js"); city = mod.createCity($("city-canvas"), { onSelect: openDrawer }); }
    catch (err) { cityFailed = true; console.error(err); $("no-webgl").hidden = false; }
  }
  if (city) city.setActive(v === "city");
  if (lastState) renderAll(lastState);
}

function openDrawer(symbol) {
  const s = lastState; if (!s) return;
  const w = s.workers.find((x) => x.symbol === symbol); if (!w) return;
  $("drawer-body").innerHTML = workerCard(w, "drawer-spark");
  lineChart($("drawer-spark"), w.spark, { stroke: color(w.slot), axis: false, fmt: px });
  $("drawer").classList.add("open"); $("drawer").setAttribute("aria-hidden", "false");
  $("drawer").dataset.symbol = symbol;
}
function closeDrawer() { $("drawer").classList.remove("open"); $("drawer").setAttribute("aria-hidden", "true"); delete $("drawer").dataset.symbol; if (city) city.select(null); }

function renderCityHud(s) {
  $("hud-workers").innerHTML = s.workers.map((w) => `<button class="hud-chip" data-sym="${esc(w.symbol)}" style="--c:${color(w.slot)}">
    <span class="dot"></span><b>${esc(w.name)}</b><span class="s-${w.status_kind}">${ICON[w.status_kind] || ""} ${esc(w.status)}</span>
    <span class="${cls(w.all.earned)}">${usd(w.all.earned, true)}</span></button>`).join("");
  $("hud-workers").querySelectorAll(".hud-chip").forEach((b) => (b.onclick = () => { city && city.select(b.dataset.sym); openDrawer(b.dataset.sym); }));
  let b = "";
  if (s.replay) b = `⏪ REPLAY · ${s.time.slice(0, 10)}`;
  else if (s.demo) b = "⚠ Demo - simulated prices";
  else if (s.guards.halted) b = "⛔ Kill switch on";
  else if (s.guards.paused_until) b = "⏸ Cooling off after losses";
  $("hud-banner").textContent = b; $("hud-banner").hidden = !b;
  const items = s.thoughts.slice(0, 14).map((t) => `<span class="tk"><b class="tag ${esc(t.kind)}">${esc(t.kind)}</b> ${esc(t.message)}</span>`).join("");
  if ($("ticker").dataset.sig !== items) { $("ticker").innerHTML = items + items; $("ticker").dataset.sig = items; }
  $("payroll-city").innerHTML = $("payroll").innerHTML;
  if (!s.replay && $("drawer").dataset.symbol) openDrawer($("drawer").dataset.symbol);
}

function renderAll(s) {
  renderFloor(s); // also fills shared header + payroll table
  const v = currentView();
  if (v === "city" && !RP.active) { renderCityHud(s); if (city) city.update(s); }
  if (v === "data") renderData(s);
  if (v === "lab") renderLab(s);
}

async function poll() {
  try {
    const r = await fetch("api/state", { cache: "no-store" });
    const s = await r.json();
    if (s.error) throw new Error(s.error);
    lastState = s; lastOk = Date.now(); renderAll(s);
  } catch (err) {
    if (!lastState) $("updated").textContent = String(err.message || err);
  }
}
setInterval(() => {
  if (!lastOk) return;
  const sec = Math.round((Date.now() - lastOk) / 1000);
  $("updated").textContent = sec < 15 ? `live · ${lastState.market_time}` : `no update for ${sec}s`;
  $("live").classList.toggle("stale", sec >= 15);
}, 1000);

$("drawer-close").onclick = closeDrawer;
$("btn-payroll").onclick = () => ($("payroll-modal").hidden = false);
$("payroll-close").onclick = () => ($("payroll-modal").hidden = true);
$("payroll-modal").onclick = (e) => { if (e.target.id === "payroll-modal") $("payroll-modal").hidden = true; };
$("btn-rotate").onclick = () => {
  const on = $("btn-rotate").getAttribute("aria-pressed") !== "true";
  $("btn-rotate").setAttribute("aria-pressed", String(on)); if (city) city.setAutoRotate(on);
};
addEventListener("keydown", (e) => { if (e.key === "Escape") { closeDrawer(); $("payroll-modal").hidden = true; } });
addEventListener("hashchange", showView);
const setNavH = () => document.documentElement.style.setProperty("--nav-h", document.querySelector(".topnav").offsetHeight + "px");
addEventListener("resize", () => { setNavH(); if (lastState) renderAll(lastState); });
setNavH();
showView(); poll(); setInterval(poll, 5000);
