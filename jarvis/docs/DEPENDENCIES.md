# Dependency inventory & outside-code review

## Installed (exact pins, `npm audit`: 0 vulnerabilities on 2026-10-10)

| Package | Version | Role | Notes |
|---|---|---|---|
| react / react-dom | 19.2.8 | UI | Meta; MIT |
| three | 0.186.1 | WebGL scene | MIT; large (≈ 650 kB min) — acceptable |
| zod | 4.6.5 | API/tool argument validation | MIT |
| vite, @vitejs/plugin-react, typescript, @types/* | pinned in lockfile | build/typecheck (dev only) | no runtime exposure |

No package uses install scripts that we rely on; nothing downloads binaries. Server has **no** runtime framework dependency. Before each release: `npm audit`, review lockfile diff, secret scan (`git secrets`/gitleaks — not yet wired into CI).
Update process: monthly `npm outdated`, read changelogs of the 4 runtime deps, bump one at a time with tests green.

## Candidates (NOT installed, NOT approved)
Reviewing means: provenance, exact release/commit, license + notices, transitive deps, advisories, install hooks, downloaded binaries, telemetry/endpoints, permissions, auth, update mechanism. **None of that has been done** for the following; READMEs are not evidence.

| Candidate | Intended use | State |
|---|---|---|
| [LiveKit Agents](https://github.com/livekit/agents) + [turn handling docs](https://docs.livekit.io/agents/logic/turns/), [telephony](https://docs.livekit.io/telephony/) | Streaming voice, interruption, SIP | Leading candidate for Phase 2. Review required first. Run in an isolated sandbox with throwaway keys. |
| [isair/jarvis](https://github.com/isair/jarvis) | Inspiration only | Not cloned/installed. Reading source in a sandbox is permitted; running it is not. |
| [letta-ai/letta](https://github.com/letta-ai/letta) | Memory layer idea | Search on 2026-10-10 indicates this repo's AGENTS.md says it is the **legacy** self-hosted server in maintenance mode, with active work in `letta-code` / Agent SDK / App Server (secondary sources; not verified against official docs). **Do not use old server images/tutorials.** Our memory design is deliberately simple (rows + search) so we don't need it yet. |

Rules when we do review: sandbox with limited filesystem/network, isolated credentials, pinned commit, no curl-to-shell, no admin installs, no disabling macOS protections. An AI-assisted review is not a guarantee.
