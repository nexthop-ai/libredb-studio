# Storage-schema migrations

[dbmate](https://github.com/amacneil/dbmate) migrations for the app's own
storage database (`STORAGE_POSTGRES_URL` — the `app_user` / `db_connection`
tables). These are **not** the schema-diff feature in `src/lib/schema-diff/`,
which operates on databases users connect *to*.

## How they run

In Kubernetes the `db-migrate` init container in
[`k8s/base/deployment.yaml`](../k8s/base/deployment.yaml) runs
`dbmate --wait --no-dump-schema migrate` before the app container starts, over
the migrations mounted at `/migrations` (the `libredb-studio-migrations`
ConfigMap). dbmate records applied migrations in a `schema_migrations` ledger
table and skips anything already recorded, so only *pending* migrations run. The
runner never needs editing when a migration is added.

Manually / locally (or any non-k8s deploy):

```bash
export DATABASE_URL="$STORAGE_POSTGRES_URL"   # postgres:// or postgresql://
export DBMATE_MIGRATIONS_DIR=./migrations
dbmate --no-dump-schema status    # list applied + pending
dbmate --no-dump-schema migrate   # apply pending
dbmate --no-dump-schema down      # roll back the most recent migration
```

## Adding a migration

1. `DBMATE_MIGRATIONS_DIR=./migrations dbmate new <name>` — generates
   `migrations/<timestamp>_<name>.sql` (dbmate picks the timestamped version
   prefix; don't hand-name it). Fill in the `-- migrate:up` and `-- migrate:down`
   sections.
2. Add `../../migrations/<timestamp>_<name>.sql` to the `configMapGenerator.files`
   list in [`k8s/base/kustomization.yaml`](../k8s/base/kustomization.yaml).

This directory is the single source of truth — the kustomization references
these files directly (no vendored copy). That relies on
`--load-restrictor=LoadRestrictionsNone`, already set by `ng service deploy` and
the k8s CI workflow. `deployment.yaml` is never touched.

## Rules

- **Idempotent.** The runner applies pending migrations on every pod
  start/rollout and across the brief two-pod overlap of a `RollingUpdate`.
  Although dbmate's ledger prevents re-applying a recorded migration, guard the
  SQL with `IF NOT EXISTS` / `ON CONFLICT` / `to_regclass(...)` so a re-run (or a
  crash mid-migration) is still a no-op.
- **No explicit `BEGIN`/`COMMIT`.** dbmate wraps each migration in a transaction
  by default; add your own only with `-- migrate:up transaction:false` (needed
  for statements like `CREATE INDEX CONCURRENTLY`).
- **Write a real `down`** where feasible; forward-only data migrations should at
  least restore structure (see the initial migration, which renames the legacy
  `user_storage` table aside rather than dropping it).
