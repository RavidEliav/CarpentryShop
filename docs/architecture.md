# BanAI — Architecture & Implementation Plan (Milestone 0)

## Context
You want a working MVP of an AI wardrobe designer. A chat agent (OpenAI), a manual properties editor, and a Three.js 3D viewer all share one canonical wardrobe state. Designs are saved in Supabase and opened through secure links, an AI photoreal render is generated from the 3D view, and the app is deployed on Railway with a `dev` and a `production` environment. Work proceeds milestone by milestone. This file is the Milestone 0 deliverable: the environment assessment, architecture, schema, protocols, and checklist.

## 1. Environment assessment (verified read-only, 2026-10-14)
| Item | Status |
|---|---|
| `C:\Users\User\Desktop\BanAI` | Empty and not a git repo. There is no existing work to overwrite. |
| git 2.54, node 22.17, npm 10.9, python 3.13.5, uv 0.8.11 | Available |
| GitHub CLI | Authenticated as `JonathanZouari` (repo, workflow scopes) |
| Railway CLI 5.59.0 | Authenticated. Workspace "Jonathan Zouari's Projects" (`5178648f-…`). No `banai` project exists yet. |
| Existing look-alike | Railway project and GitHub repo `aron-behatama` (Flask, pricing, dashboard). **Left untouched** (your decision). |
| Supabase CLI 2.118.0 | Authenticated. Org "Kindra" (`mqmgjlbatfmoxunyepzc`) holds kindra-dev and kindra-prod, both INACTIVE. No banai projects exist yet. |
| Stitch MCP | Tools are available (`mcp__stitch__*`). I'll verify they work on first use. |
| OpenAI key | Not present. You'll provide it at Milestone 5. Until then, mocks are used. |

## 2. Decisions (yours) and assumptions (mine, configurable)
**Your decisions:** new private GitHub repo `banai`; new Railway project `banai`; two new Supabase projects (`banai-dev`, `banai-prod`, Kindra org, eu-central-1); you'll supply the OpenAI key when needed.

**Technical assumptions.** These are configurable prototype values, not business rules. Documented in `docs/assumptions.md`.
- Internal unit: **integer millimetres**. The UI shows cm and accepts cm (one decimal).
- Default basic wardrobe: 2000 W × 2400 H × 600 D, 18 mm panels, 3 equal compartments, hinged doors, white matte.
- Validation ranges (rendering safety only): width 300–6000, height 300–3500, depth 200–1200 mm.
- LLM and image models come from `OPENAI_CHAT_MODEL` and `OPENAI_IMAGE_MODEL` env vars. Current models are checked against the OpenAI docs at M5 and M8, with image-edit-capable `gpt-image-*` as the candidate.
- Starter material catalog: about 6 colors × 3 finishes, plus a "custom" entry (free name, hex, finish) flagged `custom: true`.
- Environment names follow your Railway brief: `production` and `dev`. These replace the skill's default `staging`.

## 3. Architecture
```
Browser (vanilla JS + Three.js, Vite)
 ├─ store.js  ← single committed state {design, revision}  + separate pendingProposal
 │    ├─ viewer/   (renders from state, raycast → selection)
 │    ├─ editor/   (dispatches ops → store, no LLM)
 │    └─ chat/     (sends design+revision with each message; shows proposal card)
 └─ api/client.js ──HTTPS──► FastAPI backend
                              ├─ domain/   (Pydantic schema, ops engine, validation)  ← authoritative
                              ├─ agent/    (OpenAI tool-calling → proposal ops; never applies)
                              ├─ persistence/ (repository iface; Supabase + in-memory impls)
                              └─ services/ (image gen, HMAC proposal signing, tokens)
                                              └─► Supabase Postgres (designs table, RLS deny-all)
```
**Single operation protocol.** Every change, whether manual or AI, is a list of typed ops, for example `{op:"add_shelf", compartmentId, y, …}`. The ops engine exists in Python (authoritative, used for AI validation and save) and in JS (instant manual editing). **Parity is guaranteed by shared golden fixtures** in `shared/fixtures/ops/*.json` (input design + ops → expected design or error), run by both pytest and vitest. Each op is pure: `(design) → newDesign`. Nothing is mutated.

Op set: `create_wardrobe, update_dimensions, configure_doors, add_compartment, modify_compartment, add_partition, modify_partition, add_shelf, modify_shelf, add_drawer, modify_drawer, add_rail, modify_rail, set_material, remove_component`.

## 4. Canonical schema (v1, JSON/JSONB)
```jsonc
{
  "schemaVersion": 1, "units": "mm",
  "dimensions": {"width":2000,"height":2400,"depth":600},
  "carcass": {"panelThickness":18, "materialId":"mat_body"},
  "compartments": [                       // ordered left→right
    {"id":"cmp_…","width":645,
     "shelves":[{"id":"shf_…","y":800,"thickness":18,"materialId":null}],
     "drawers":[{"id":"drw_…","y":0,"height":200,"materialId":null}],
     "rails":[{"id":"rail_…","y":1900}]}
  ],
  "partitions": [{"id":"prt_…","thickness":18}],   // partitions[i] sits between compartments i and i+1
  "doors": {"type":"hinged|sliding|none",
            "items":[{"id":"dr_…","compartmentIds":["cmp_…"],"hingeSide":"left|right|null","materialId":"mat_door"}]},
  "materials": {"mat_body":{"catalogId":"white_matte"},
                "mat_door":{"custom":true,"name":"Oak veneer","color":"#b08850","finish":"satin"}}
}
```
**Structural rules**, checked in `validation.py` and `validation.js`:
- IDs are unique and stable. The prefixes are typed, and IDs are generated client- or server-side with crypto random.
- Σ compartment widths + Σ partition thicknesses + 2 × panelThickness equals the overall width. Changing the overall width rescales compartments proportionally. Moving a partition adjusts its two neighbors.
- `len(partitions) == len(compartments) - 1`.
- Every y and height value stays within the interior height. Items inside a compartment may not overlap. This is a geometry sanity check, not a manufacturing rule.
- Every door `compartmentIds` entry must exist. Removing a compartment cascades to its items and to door references.
- Every `materialId` must resolve to a catalog entry or a custom entry.

Revision and persistence metadata (`revision`, `designId`) stay **outside** the design object.

## 5. AI proposal and approval protocol
1. Each chat message sends `POST /api/chat {messages, design, revision}`. The agent always sees the latest committed state, and it is only called on user messages.
2. The backend calls OpenAI with function tools, one per op category plus `ask_clarification`. The tool arguments are parsed with Pydantic and then dry-run on a copy of the design. Any invalid op is fed back to the model to repair, up to 2 retries. If it still fails, the user gets a clarification message instead.
3. The response is `{reply, proposal?: {proposalId, baseRevision, baseHash, ops, summary, signature}}`. The signature is an HMAC over (ops, baseRevision, baseHash) using `PROPOSAL_SIGNING_KEY`. The server stores nothing.
4. The UI shows the proposal card with **Confirm** and **Cancel**. The committed state is never touched while a proposal is pending. An optional ghost preview is drawn in a separate scene layer.
5. **Confirm** sends `POST /api/proposals/apply {design, revision, proposal}`. The server verifies the signature, then checks `revision == baseRevision` and `hash(design) == baseHash`, otherwise it returns **409 STALE**. It re-validates, applies, and returns `{design, revision+1}`. The frontend then commits, and the viewer and editor re-render.
6. **Cancel** discards the proposal on the client only, and a "cancelled" note goes into the chat history.
7. Any manual edit made while a proposal is pending bumps the revision. The card then shows "design changed – ask agent to re-propose".

### 5a. Voice (chained pipeline, added 2026-10-16)
Voice was originally an excluded feature. It was added on request, following OpenAI's voice-agents guide, as a **chained pipeline**: speech-to-text, then the existing agent, then optional text-to-speech.
- **Mic → `POST /api/voice/transcribe`.**
  - The request is a raw audio body with a content-type allowlist and a 1 MB streamed cap. The browser stops recording itself at 60 s.
  - It returns `{text}`. No language hint is sent, so either language is transcribed as spoken.
  - The text then goes through the normal `submit()`, which detects the language and calls `/api/chat`.
- **Read replies aloud** (opt-in, remembered per browser): `POST /api/voice/speech {text, language}` returns `audio/mpeg`.
  - The toggle and its notice disclose that the voice is AI-generated, as OpenAI's usage policies require.
- **Why chained and not Realtime speech-to-speech.** A Realtime session would need its own tool loop and browser ephemeral keys, and it would bypass the signed-proposal protocol. Chained keeps one agent, one scope policy, and one Confirm step.
- **Defaults (configurable):**
  - `OPENAI_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe`
  - `OPENAI_TTS_MODEL=gpt-4o-mini-tts`
  - `OPENAI_TTS_VOICE=marin`
  - The voices are optimized for English, so Hebrew read-aloud may sound accented.

## 6. API contracts (FastAPI, Pydantic, `{success, data, error}` envelope)
| Method | Route | Purpose |
|---|---|---|
| GET | `/api/health` | liveness |
| GET | `/api/catalog` | materials, colors, finishes (backend owns the catalog) |
| GET | `/api/designs/default` | basic wardrobe template |
| POST | `/api/chat` | agent turn → reply + optional signed proposal |
| POST | `/api/proposals/apply` | verify, check stale, apply → new design |
| POST | `/api/voice/transcribe` | raw audio (≤ 1 MB) → `{text}` |
| POST | `/api/voice/speech` | `{text, language}` → `audio/mpeg` |
| POST | `/api/designs/validate` | server validation of a manual design (used before save) |
| POST | `/api/designs` | create → `{designId, accessToken, revision}` |
| GET | `/api/designs/{id}` | header `Authorization: Bearer <token>` → design |
| PUT | `/api/designs/{id}` | token + `If-Match: revision` → optimistic save (409 on conflict) |
| POST | `/api/render` | `{design, imagePngBase64}` → `{imageBase64, disclaimer}` (does not touch state) |

CORS is restricted to the frontend origin for each environment. Rate limiting (slowapi) applies to `/chat` and `/render`.

## 7. Supabase schema and security
Migration `supabase/migrations/<ts>_designs.sql`, created with `supabase migration new`:
- `public.designs(id uuid pk default gen_random_uuid(), token_hash bytea not null, state jsonb not null, schema_version int, revision int not null default 1, created_at, updated_at)`.
- **RLS enabled with no policies.** `revoke all on designs from anon, authenticated`. Only the backend, using the server-side secret key, can access the table. The browser never talks to Supabase.
- The share link is `https://<frontend>/#d=<uuid>.<token>`. The token is `secrets.token_urlsafe(32)` (256 bits) and is stored only as a SHA-256 hash. Verification uses `hmac.compare_digest`. The fragment keeps the token out of server logs and Referer headers. The UUID alone grants nothing.
- Saves use `UPDATE … WHERE id=$1 AND revision=$2`, which gives optimistic concurrency. Every save is validated by the domain layer before it is written.
- Run `supabase db advisors` after the migration. The migration is applied to both banai-dev and banai-prod via `supabase link` + `supabase db push`.

## 8. Railway topology (follows the `railway-provision` skill, adapted)
- Project `banai` in workspace "Jonathan Zouari's Projects".
- Environments: `production` (the default) and `dev` (`railway environment new dev --duplicate production`).
- Services: `backend` and `frontend` (`railway add --service …`). Repo `JonathanZouari/banai`.
  - production: source `main`, rootDirectory `/backend` or `/frontend`.
  - dev: source `dev`, same root directories. Wired with `railway environment edit --json`.
- Per-service `railway.json`:
  - backend: start command `uvicorn app.main:app --host 0.0.0.0 --port $PORT`, healthcheck `/api/health`.
  - frontend: `npm run build`, then `npx serve -s dist -l $PORT`.
- Per-environment variables, never shared:
  - backend: `OPENAI_API_KEY, OPENAI_CHAT_MODEL, OPENAI_IMAGE_MODEL, SUPABASE_URL, SUPABASE_SECRET_KEY, PROPOSAL_SIGNING_KEY, CORS_ORIGINS`
  - frontend: `VITE_API_BASE_URL=https://${{backend.RAILWAY_PUBLIC_DOMAIN}}`
- dev points to banai-dev and production points to banai-prod.
- **Production safety:** `main` holds only the scaffold until you approve a release. Code lands on `dev` first. Merging `dev`→`main` (which triggers a prod deploy) happens only with your explicit OK. Connecting prod to `main` may start a scaffold build, and I'll report whatever happens.

## 9. Repository structure
```
banai/
  backend/  app/{main,config}.py
            app/api/{chat,proposals,designs,render,catalog}.py
            app/domain/{schema,operations,validation,defaults,catalog,ids}.py
            app/agent/{orchestrator,tools,prompts}.py
            app/persistence/{repository,supabase_repo,memory_repo}.py
            app/services/{image_gen,signing,tokens}.py
            tests/  pyproject.toml (uv)  railway.json  .env.example
  frontend/ index.html  vite.config.js  package.json  railway.json  .env.example
            src/main.js  src/state/{store,operations,validation,ids}.js
            src/viewer/{scene,controls,picking,dimensions}.js  src/viewer/builders/{carcass,partition,shelf,drawer,rail,door}.js
            src/editor/{panel,globalProps,componentProps,materials}.js
            src/chat/{chatPanel,proposalCard}.js  src/entry/{startScreen}.js  src/api/client.js  src/styles/*.css
            tests/unit (vitest)  tests/e2e (playwright)
  shared/fixtures/ops/*.json        # golden parity fixtures (tests only)
  supabase/{config.toml,migrations/}
  docs/{architecture,schema,agent-protocol,api,security,railway,assumptions,testing,deployment,limitations}.md
  README.md  .gitignore
```

## 10a. Phased execution (the project is NOT built in one pass)
The work is split into separate **phases**. At the end of each phase I stop, report (what was built, files, real test output, known issues), and **wait for your approval** before starting the next one. A phase is never started until the previous phase's verification gate has passed.

| Phase | Milestones | Stop point / deliverable |
|---|---|---|
| **Phase 1 – Foundations & Infra** | 1a, 1b, 1c | Repo + `dev`/`main` branches, Railway project (2 envs × 2 services wired), Supabase dev/prod projects, runnable skeletons |
| **Phase 2 – Domain Model** | 2 | Canonical schema + ops engine (Py & JS) with green parity tests |
| **Phase 3 – 3D Viewer** | 3 | Wardrobe rendered from state, selection, dimensions |
| **Phase 4 – UI & Manual Editing** | 4 | Stitch-designed 3-column UI, properties editor synced to viewer |
| **Phase 5 – AI Agent** | 5 | Chat + signed proposals + confirm/cancel/stale |
| **Phase 6 – Integrated Co-Design** | 6 | 3 entry paths, acceptance steps 1–16 passing locally |
| **Phase 7 – Persistence** | 7 | Supabase save/reopen via secure link |
| **Phase 8 – AI Rendering** | 8 | Photoreal preview without state change |
| **Phase 9 – Deploy dev** | 9 | Live dev environment (production only on explicit approval) |
| **Phase 10 – Final Validation** | 10 | Full E2E acceptance report + docs + limitations |

**This approval covers Phase 1 only.** Later phases start only after you say go.

## 10. Milestones and verification gates
| # | Work | Gate (must pass before the next milestone) |
|---|---|---|
| 1a | `git init`, `.gitignore`, scaffold, create private repo `banai` (`gh repo create --private`), push `main` (scaffold) and create `dev` | `gh repo view` shows both branches |
| 1b | **Railway provisioning** (section 8) and **Supabase projects** banai-dev and banai-prod (check the org plan and cost first; DB passwords go to a gitignored `.env`) | `railway environment config --json` shows the 4 service/env wirings with the correct branch and root. `supabase projects list` shows both projects. |
| 1c | FastAPI skeleton plus `/health`, Vite + Three.js skeleton, env templates, dev scripts | `pytest` and `vitest` run; `uvicorn` and `vite` start locally |
| 2 | Domain schema, ops, validation (Python then JS) plus golden fixtures | pytest and vitest green with identical golden results; ≥80% coverage on the domain |
| 3 | 3D viewer: builders, orbit/zoom, raycast selection, highlight, dimension labels | Unit tests on builder output (mesh count and positions from state); visual check in the browser |
| 4 | Stitch UI design (3-column layout); properties editor; manual ops → store → viewer | vitest for editor→store; Playwright: select shelf → panel shows it → edit y → mesh moves |
| 5 | OpenAI agent, tools, proposal signing, apply/cancel/stale (you provide the key) | pytest with a mocked OpenAI (parse, validate, confirm, cancel, stale 409, no commit before confirm); one live smoke call |
| 6 | Integration: three entry paths (guided chat, free text, basic wardrobe), concurrency | Playwright runs acceptance steps 1–16 with the mocked LLM |
| 7 | Supabase migration, repository, links, save/reopen | pytest against the in-memory repo plus a live banai-dev test: save, reopen, wrong token → 401/404, stale save → 409; advisors clean |
| 8 | Canvas capture (`preserveDrawingBuffer`, clean background), `/render`, disclaimer UI | pytest: the image sent equals the captured PNG; service error → graceful error; design hash unchanged |
| 9 | Railway env vars, domains, deploy **dev** | Live dev URL passes the acceptance scenario. Production waits for your approval. |
| 10 | Full E2E acceptance (steps 1–23) against dev, docs, limitations | Report with real test output. Nothing claimed without a run. |

After each milestone I'll report what was implemented, the files changed, the tests run and their results, known issues, and the next step. Each milestone gets its own conventional commits on `dev`. Code review uses the code-reviewer and python-reviewer agents.

## 11. External or consequential actions I'll still pause for
- Creating Supabase projects if the Kindra org is on a paid plan (each project costs money).
- Entering the OpenAI key (M5) and Supabase secret keys into Railway variables.
- Any deploy to `production` or merge to `main` beyond the initial scaffold.
