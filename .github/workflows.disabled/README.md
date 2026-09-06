# Disabled workflows

`ci.yml` ran on every push and failed within seconds on each one, so its red marks said
nothing about the code (Kun, 2026-09-06: "disable CI scripts, no need for it right now").
GitHub runs only files under `.github/workflows/`; this directory is where the file waits.

To re-enable: `git mv .github/workflows.disabled/ci.yml .github/workflows/ci.yml`, after
fixing what it needs (see the last failed run's log). `release.yml` stays live: it runs on a
`v*.*.*` tag only and produces no noise on push.
