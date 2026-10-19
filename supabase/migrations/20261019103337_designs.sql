-- Saved wardrobe designs (Phase 7, docs/architecture.md section 7).
-- Only the backend reads or writes this table, through the Data API with the server-side secret
-- key (the service_role role, which bypasses RLS). RLS is enabled with NO policies and the browser
-- roles get no grants, so the publishable key can never reach a design.

create table public.designs (
  id uuid primary key default gen_random_uuid(),
  -- SHA-256 (hex) of the 256-bit share-link token. The token itself is never stored.
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  state jsonb not null check (jsonb_typeof(state) = 'object' and octet_length(state::text) <= 262144),
  schema_version integer not null check (schema_version >= 1),
  -- Optimistic concurrency: every save is UPDATE ... WHERE id = $1 AND revision = $2.
  revision integer not null default 1 check (revision >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.designs is
  'Saved wardrobe designs. Backend-only (secret key); opened by id + share-link token hash.';

alter table public.designs enable row level security;

-- Tables are no longer exposed to the Data API automatically, and the default grants differ between
-- older and newer projects, so both sides are explicit: nothing for the browser roles, and only what
-- the backend uses for service_role (no delete, no truncate).
revoke all on table public.designs from anon, authenticated, service_role;
grant select, insert, update on table public.designs to service_role;
