# Supabase Projects

| Environment | Project | Ref | Region |
|---|---|---|---|
| dev | banai-dev | `lrulgstsqnxllknfvdpr` | eu-central-1 |
| production | banai-prod | `lkslzvgypmbjltrtcrec` | eu-central-1 |

- Organization: Kindra (`mqmgjlbatfmoxunyepzc`).
- The CLI is linked to **banai-dev** by default. To target prod, run `supabase link --project-ref lkslzvgypmbjltrtcrec` explicitly, and only for an approved release.
- DB passwords are kept in the gitignored `.env.supabase` at the repo root, never committed.
- Schema: `supabase/migrations/20261020120000_designs.sql`, table `public.designs`. RLS is on with no policies, and anon/authenticated have no grants: only the backend reaches it.
- The backend (`app/persistence/repository.py`) calls PostgREST with `SUPABASE_URL` and `SUPABASE_SECRET_KEY`, set per Railway environment: dev uses banai-dev and production uses banai-prod. `/api/health` reports `storage: true` when they are set.
- API: `POST /api/designs`, then `GET` / `PUT /api/designs/{id}` with `Authorization: Bearer <token>`. `PUT` also needs `If-Match: <revision>` and returns 409 `STALE` when someone saved in between. A wrong token and a missing design both return the same 404.
