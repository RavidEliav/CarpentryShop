# Supabase Projects

**This copy of the project (RavidEliav):**

| Environment | Project | Ref | Region |
|---|---|---|---|
| dev | banai-dev | `jtxnizqsssigalqbkbax` | eu-central-1 |

- Organization: RavidEliav's Org (`lbksktpjbzpujcukeqnv`). The local CLI is linked to this project.
- The `designs` migration is applied and verified live (2026-10-19): only `service_role` has `select, insert, update`; `anon` and `authenticated` get `42501 permission denied`. The security advisors report only the expected INFO `rls_enabled_no_policy`.
- **Corporate networks:** if Postgres ports 5432/6543 are blocked, `supabase db push` and `supabase db query --linked` cannot connect. Apply migrations over HTTPS with the Management API instead (`POST https://api.supabase.com/v1/projects/<ref>/database/query`, bearer = a Supabase access token), and record each one in `supabase_migrations.schema_migrations` so a later `db push` skips it.

**Upstream project (JonathanZouari/banai):**

| Environment | Project | Ref | Region |
|---|---|---|---|
| dev | banai-dev | `lrulgstsqnxllknfvdpr` | eu-central-1 |
| production | banai-prod | `lkslzvgypmbjltrtcrec` | eu-central-1 |

- Organization: Kindra (`mqmgjlbatfmoxunyepzc`).
- The CLI is linked to **banai-dev** by default. To target prod, run `supabase link --project-ref lkslzvgypmbjltrtcrec` explicitly, and only for an approved release.
- DB passwords are kept in the gitignored `.env.supabase` at the repo root, never committed.

## Saved designs (Phase 7)

Migration: `supabase/migrations/20261019103337_designs.sql`.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK, `gen_random_uuid()` | The public half of a share link. Grants nothing on its own. |
| `token_hash` | `text`, 64 hex chars | SHA-256 of the 256-bit link token. The token itself is never stored. |
| `state` | `jsonb` object, ≤ 256 KB | The canonical design, validated by the domain engine before every write. |
| `schema_version` | `integer` | Design schema version (currently 1). |
| `revision` | `integer`, starts at 1 | Bumped by each save; used for optimistic concurrency. |
| `created_at`, `updated_at` | `timestamptz` | |

**Security model**
- RLS is enabled with **no policies**. `anon` and `authenticated` have **no grants**, so the publishable key can never read or write a design.
- Only the backend touches the table, through the Data API with the **secret key** (`service_role`, which bypasses RLS). It has `select, insert, update` only: no delete, no truncate.
- New tables are no longer exposed to the Data API automatically, so the grants are explicit in the migration.
- A share link is `/#d=<uuid>.<token>`. The fragment never reaches a server or a `Referer` header. The backend looks the row up by id and compares `sha256(token)` with `token_hash` in constant time. A wrong token and an unknown id both return the same 404.
- A save is `PATCH … WHERE id = $1 AND revision = $2`. If another save landed first, nothing is written and the API returns 409.
- The secret key is sent only in the `apikey` header (new `sb_secret_…` keys are not JWTs) and is never logged. `SUPABASE_URL` must be `https://` (plain HTTP is accepted only for a local stack), or the backend refuses to start.

**Backend configuration** (`backend/.env` or the Railway variables per environment):

| Variable | Value |
|---|---|
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `SUPABASE_SECRET_KEY` | A secret key (`sb_secret_…`) from **Settings → API Keys**. Backend only. |

Without these, `APP_ENV=local` and `APP_ENV=e2e` save to an in-memory store (lost on restart), and every other environment reports saving as unavailable (`/api/health` → `persistence: false`). Playwright always blanks them, so E2E never writes to a real project.

**Applying the migration**

```bash
supabase link --project-ref <project-ref>   # banai-dev by default; prod only for an approved release
supabase db push                            # applies supabase/migrations/*
supabase db advisors                        # CLI v2.81.3+; expect no findings for public.designs
```

Then check from the SQL editor that the browser roles cannot reach the table:

```sql
select grantee, privilege_type from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'designs';
-- expected: only service_role with SELECT, INSERT, UPDATE
```
