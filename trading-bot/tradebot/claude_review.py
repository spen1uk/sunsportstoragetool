"""Optional: Claude reads the journal + your playbook and writes a coaching review.

Claude's suggested parameter changes are NOT applied directly - they are handed to the
learner as extra candidates and must pass the same walk-forward test as everything else.
Requires `pip install anthropic` and ANTHROPIC_API_KEY.
"""
import json
import os
import re

from .backtest import stats
from .config import ROOT
from .util import ts_iso

SYSTEM = (
    "You are a disciplined crypto trading coach reviewing an automated paper-trading bot's journal. "
    "Capital preservation comes first. Judge the trades against the trader's written playbook. "
    "Be concrete: cite trade ids, exit reasons, R multiples and MFE/MAE. Never suggest raising risk "
    "per trade, leverage or removing stops. Losses cannot be eliminated; aim to cut avoidable ones."
)


def review(cfg, params, trades, lessons, log=print):
    """Returns (review_text, proposals) or (None, []) if unavailable."""
    cr = cfg.get("claude_review", {})
    if not cr.get("enabled"):
        return None, []
    try:
        import anthropic
    except ImportError:
        log("[claude] `pip install anthropic` to enable Claude reviews")
        return None, []

    playbook_path = os.path.join(ROOT, "playbook", "RULES.md")
    playbook = open(playbook_path).read() if os.path.exists(playbook_path) else "(no playbook)"
    recent = trades[-60:]
    rows = [
        f"{t['id']} {t['symbol']} {t['side']} in {ts_iso(t['entry_ts'])} @ {t['entry_price']:.4f} "
        f"out {ts_iso(t['exit_ts'])} @ {t['exit_price']:.4f} {t['exit_reason']} "
        f"net ${t['net_pnl']:+.2f} R={t['r_multiple']:+.2f} MFE={t['mfe_r']:+.2f} MAE={t['mae_r']:+.2f} "
        f"| {t['entry_reasons']}" for t in recent
    ]
    tunable = cfg["learning"]["tunable"]
    prompt = (
        f"<playbook>\n{playbook}\n</playbook>\n\n"
        f"<current_parameters>\n{json.dumps(params, indent=1)}\n</current_parameters>\n\n"
        f"<tunable_bounds>\n{json.dumps(tunable)}\n</tunable_bounds>\n\n"
        f"<stats>\n{json.dumps(stats(trades, cfg['starting_balance']), default=str)}\n</stats>\n\n"
        f"<automatic_lessons>\n" + "\n".join(lessons) + "\n</automatic_lessons>\n\n"
        f"<recent_trades>\n" + "\n".join(rows) + "\n</recent_trades>\n\n"
        "Write a short review (what worked, what didn't, which losses broke or followed the playbook, "
        "what to watch next). Then, on the final line, output a JSON object exactly like "
        '{"proposals": [{"params": {"<tunable name>": <value>}, "why": "<one sentence>"}]} '
        "with at most 3 proposals, using only tunable parameter names within bounds."
    )
    client = anthropic.Anthropic()
    # Server-side refusal fallback is enabled so a declined request is retried on Anthropic's
    # recommended fallback model instead of failing the review.
    resp = client.beta.messages.create(
        model=cr.get("model", "claude-opus-5-5"),
        max_tokens=16000,
        system=SYSTEM,
        output_config={"effort": cr.get("effort", "high")},
        betas=["server-side-fallback-2026-07-01"],
        extra_body={"fallbacks": "default"},
        messages=[{"role": "user", "content": prompt}],
    )
    if resp.stop_reason == "refusal":
        log("[claude] review declined")
        return None, []
    text = "".join(b.text for b in resp.content if b.type == "text").strip()
    proposals = []
    m = re.search(r"\{\s*\"proposals\".*\}\s*$", text, re.S)
    if m:
        try:
            for p in json.loads(m.group(0)).get("proposals", [])[:3]:
                if isinstance(p.get("params"), dict):
                    proposals.append((p["params"], "Claude: " + str(p.get("why", ""))[:200]))
        except json.JSONDecodeError:
            pass
        text = text[:m.start()].strip()
    return text, proposals
