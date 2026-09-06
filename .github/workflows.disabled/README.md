# Disabled workflows

`ci.yml` ran on every push and failed within seconds on each one, so its red marks said
nothing about the code (Kun, 2026-09-06: "disable CI scripts, no need for it right now").
GitHub runs only files under `.github/workflows/`; this directory is where the file waits.

The failure was `ERR_PNPM_OUTDATED_LOCKFILE`: `pnpm-lock.yaml` no longer matched
`packages/db/package.json` (its `@appbay/core` dependency was removed), and CI installs
with `--frozen-lockfile`. To re-enable: run `pnpm install` so the lockfile is current, commit
it, then `git mv .github/workflows.disabled/ci.yml .github/workflows/ci.yml`. `release.yml` stays live: it runs on a
`v*.*.*` tag only and produces no noise on push.
