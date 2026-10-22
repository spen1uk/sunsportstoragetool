# The Founder skill pack (third-party, vendored)

- Source: https://github.com/Jakeschincariol/founder-skill
- Pinned commit: `fd9385b0cfe1b96bebce3898fbd506d73eff5a9d` ("The Founder skill: 11 Claude skills, v1.0"), the only commit on `main` at install time
- License: MIT (see `LICENSE`)
- Installed: 2026-10-22, at Luke's request, after his own review of this commit
- Copied byte-for-byte from `skills/founder-*`. Nothing in `skills/` has been edited. Jarvis's own code lives in `server/founder.ts`.
- No auto-update, no `git submodule`, no package install. To update, a person re-reviews a new commit and replaces this folder.
- `MANIFEST.sha256` lists a checksum for every file; Jarvis refuses to run the pack if any file differs (`node scripts/founder-verify.ts` checks it by hand).
- Re-check done at install: the four Python scripts (`unit_economics.py`, `van_westendorp.py`, `panel.py`, `compile.py`) import only the Python standard library (argparse, json, math, sys, csv, glob, os, random, importlib), make no network calls, run no other programs, and only read their inputs and write their reports.

## To remove it completely
1. Delete this `founder/` folder.
2. Delete `server/founder.ts`, `server/test/founder.test.ts`, `server/migrations/035_founder.sql` (or leave the empty table), and the lines mentioning `founder` in `server/converse.ts`, `server/intent.ts`, `server/persona.ts`, `server/calendarwrite.ts`, `server/emergency.ts`, `server/index.ts`.
3. Working files live in `data/founder-work/` (outside git). Delete that folder to erase them.
