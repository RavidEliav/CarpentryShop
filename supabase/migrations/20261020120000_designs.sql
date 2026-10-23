-- BanAI: saved projects (the design and, optionally, the customer's details), reached by a link that carries a
-- secret token. No accounts: whoever holds the link may open and change the project.
-- Only the backend talks to this table, with the service key. RLS is on with no policies, and the anon and
-- authenticated roles have no grants, so the public API keys can read and write nothing.
create table public.designs (
  id uuid primary key default gen_random_uuid(),
  -- SHA-256 (hex) of the access token; the token itself is shown once and never stored.
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  name text not null check (char_length(name) between 1 and 60),
  design jsonb not null,
  customer jsonb,
  -- Optimistic concurrency: a save names the revision it started from and only succeeds if it is still current.
  revision integer not null default 1 check (revision >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.designs enable row level security;

revoke all on table public.designs from anon, authenticated;

create index designs_updated_at_idx on public.designs (updated_at);
