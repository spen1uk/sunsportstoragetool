# Skills registry (Phase 3)

One catalog (`server/skills/catalog.ts`) lists every capability agents have. A skill is a **reviewed manifest in code**; the database (`skill_state`, `skill_versions`, `skill_grants`, `skill_runs`, `skill_workflows`) only holds what is on or off, which version is live, who may use it, and the history. The Skills page (`#/skills`) shows and controls this.

## What a manifest says
id (`area.name`), title, purpose, owner (jarvis / prometheus), version, **permissions** (from the closed list in `server/skills/manifest.ts`), data sensitivity (public / private / secret), side effects (none / internal_write / external_read / external_write / money), `untrustedOutput` (comes from the web), external services, cost per call, trust (builtin / reviewed / experimental), run path, tests, docs. Output and input shapes are described (input is a strict zod schema). Audit history, runs and rollback version come from the database.

## Rules the code enforces (tests: `server/test/phase3.test.ts`)
1. **No self-granting.** Only Luke (HTTP layer, fresh passphrase/passkey spent per grant, enable, activate) grants a skill, switches one on, or activates a version. Switching off and revoking need no confirmation.
2. **Agent ceilings are fixed in code.** Prometheus holds only web/catalog/weather/docs/research-queue capabilities and public data. It can never be given a skill that touches private data (memory, tasks) even by a grant. Public, free, read-only skills marked `autoShare` reach every agent that may hold them without a grant.
3. **Tier 3+ is never run by an agent**: anything that sends, spends, deletes, allows a website, raises a cap or moves money exists only as an approval request. They cannot be granted at all.
4. **Only `direct` skills run through `invoke`.** Existing features (chat suggestions, protected actions, research jobs, web answers) keep their own tested path (dual-run); the registry describes and governs them. Parity tests fail if a new chat suggestion or protected action is added without a catalog entry, or if risk / standing-permission / model-proposable flags disagree with the old tables.
5. **Versions.** Code can hold several versions; a newer one waits **staged** until Luke activates it; activating an older one is a recorded **rollback**. Editing a manifest without changing its version is flagged as drift.
6. **Runs never store what was asked or returned** (only a hash, timing, who, and the outcome), and every refusal is logged with its reason. Pause refuses everything.
7. **Workflows** (saved chains): permissions are the union of the steps, tier / side effects / sensitivity the highest, every step must be allowed for whoever runs it, web content may only flow into side-effect-free steps, the chain is re-validated against the live skills on every run, an agent can only stage one and Luke activates it. Only chains of plain `direct` read/compute skills can run.

## Adding a skill (the reviewed path)
1. Add an entry to `DIRECT` in `catalog.ts` with `define({...manifest}, inputSchema, run)`; if it needs a capability that does not exist, add it to `CAPABILITIES` in `manifest.ts` (a reviewed change; this is what no skill can do for itself).
2. Add tests; run `npm test` (the parity tests will tell you if anything is inconsistent).
3. It appears staged-then-live on first start; grant it on the Skills page if it is not `autoShare`.
A new *version* of an existing skill: add a second `define` with a higher `version`; it appears staged and you activate or roll back on the page.

## Not in this phase
Third-party skills and any skill written by an agent (Phase 9 only proposes workflows of existing skills, or words for a person to build; see STATUS.md) (any install needs your approval and the review in docs/DEPENDENCIES.md). Re-routing chat suggestions and approvals through `invoke` happens only after a period of parity.
