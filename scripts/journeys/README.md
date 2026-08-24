# Journeys

Runnable acceptance evidence. Each script drives a **real install on a real VM** through one
property and prints `N passed, M failed`, exiting non-zero on any failure.

These are the evidence base for the alpha gate (issue #60). Its standard is deliberately
hostile to the failure this project keeps hitting:

> No simulated success, mock fallback, HTTP-only smoke test, or aggregate test count can
> close a journey by itself.

A green unit-test suite does not close a journey. A screenshot does not. A manual walk does
not — journey 2 stayed unchecked for a day *after* it had been walked in a browser, because
walking it is not running it.

## Running them

Every script takes the same three variables:

```bash
VM=appbay-docker ./s26-journey-lifecycle.sh                       # Docker
VM=appbay-rhel PRIV=sudo CBIN=podman ./s26-journey-lifecycle.sh   # rootful Podman
```

| Variable | Default | Meaning |
|---|---|---|
| `VM` | `appbay-docker` | multipass instance to run against |
| `PRIV` | `env` | privilege prefix. **`env` is a no-op on purpose** — an empty variable collapses to a zero-length argv element and breaks the exec. Rootful installs need `sudo`. |
| `CBIN` | `docker` | container CLI (`podman` on the RHEL host) |
| `HOME_DIR` | `/home/ubuntu/.appbay` | APPBAY_HOME on the target |

**Six of these run LOCALLY and ignore `VM` entirely.** Passing `VM=…` to one of them does
nothing — it inspects whatever machine you are sitting on, which is how a batch run reported
`caddy version — expected v2.11.4, got '<none>'` against a workstation that simply did not
have the image. Audited 2026-08-12 by grepping each script for `multipass`:

| Local (ignores `VM`) | Needs |
|---|---|
| `s25-caddy-modules` | the edge image present **here** (`IMAGE=` to override the tag) |
| `s25-caddy-tree-validate` | the edge image present here, **and `TREE=<candidate config dir>`** — it refuses without it |
| `s25-control-plane-rebuild` | **`APPBAY_HOME=<install>`** — it refuses without it |
| `s26-journey-doctor-parity` | `pnpm` and the built CLI |
| `s26-journey-first-run-auth` | `pnpm` and `agent-browser` |
| `s26-journey-web-api-secrets` | `pnpm` |

Everything else drives a VM through `multipass exec`. ⚠️ `s25-edge-authz` is VM-based despite
having no `vm()` helper — it uses `vmsh()`/`ab()`. Grep for `multipass`, not for `vm()`.

🚨 **The VM's binary is not the one you just built.** Journeys run `appbay` as installed on the
target, so a VM carrying an older build silently tests older code — measured 2026-08-12, when
the Docker VM was 19 commits behind and its green run meant nothing. Before trusting a suite:

```bash
multipass exec "$VM" -- md5sum /usr/local/bin/appbay
md5sum apps/cli/dist/appbay          # these must match
```

## What a target host must already have

Only two things, and both come from the product itself:

1. **An initialised install** — `appbay init`, and `appbay` on PATH.
2. **The Caddy edge deployed** — `appbay up caddy`. The edge image is built by the
   compiler's build stage from `system-apps/caddy/config/Dockerfile.cloudflare`, which is in
   this repo; nothing needs fetching by hand.

Everything else each journey needs, it creates and removes: apps, edge users, control-plane
accounts, vault entries, databases. ⚠️ **If you find yourself preparing a host by hand to
make a journey pass, that is the bug.** `s25-edge-authz.sh` once required "an app with an
auth trait declaring `group:`" — an app that existed only because someone had edited a
manifest on one VM, which is exactly how `tests/bdd/` went months with no passing run.

## The runtime matrix

| Host | Runtime | Status |
|---|---|---|
| `appbay-docker` | Ubuntu 24.04, Docker 29.1.3 | supported |
| `appbay-rhel` | Fedora 43, **SELinux Enforcing**, rootful podman 5.6.2 + podman-compose 1.5.0 | supported |

The fleet is these two VMs. The **pristine** journeys (`s27-journey-public-install`,
`s28-journey-install-integrity`) launch an ephemeral multipass VM of their own and tear it
down on exit, so they no longer pin a named "fresh" box — a standing fresh VM stops being
fresh after its first run.

## What each journey proves

| Script | Proves |
|---|---|
| `s25-caddy-modules.sh` | the edge image contains the Caddy Security modules it claims |
| `s25-caddy-tree-validate.sh` | the whole assembled edge config validates before it reaches a live edge |
| `s25-acme-config-validate.sh` | institutional ACME config parses **and its directives reach the adapted config** — a copied-but-inert file cannot pass |
| `s25-control-plane-rebuild.sh` | control-plane users survive deletion and rebuild of the SQLite cache |
| `s25-edge-authz.sh` | group-based authorization enforces **in both directions** — a member is admitted *and* a non-member refused. Fully self-provisioning: creates its own gated app, member and outsider, and removes all three |
| `s25-interface-optionality.sh` | the binary is moved aside and the edge and apps keep serving |
| `s26-credential-boundaries.sh` | the three credential domains are independent — exactly one store moves per reset |
| `s26-legacy-user-migration.sh` | the legacy SQLite→`users.yaml` export runs **once**, at mode 0600 |
| `s26-journey-compile.sh` | compile determinism (byte-identical recompile) and compile-failure diagnostics |
| `s26-journey-apply-success.sh` | progress output tracks reality: `[plan: NEW]` → `[plan: UNCHANGED]` → `[plan: CHANGED]` |
| `s26-journey-aux-transactional.sh` | a rejected deploy rolls back **and leaves the bystander untouched** |
| `s26-journey-lifecycle.sh` | start/stop/restart, verified by `StartedAt`, plus out-of-band stop detection |
| `s26-journey-logs.sh` | logs are the container's **real** output, cross-checked against the runtime |
| `s26-journey-secrets-never-leak.sh` | a sentinel secret reaches no artifact, plan, log or status output (CLI surfaces) |
| `s26-journey-web-api-secrets.sh` | no tRPC **response body** carries a plaintext secret — runs locally, greps payloads not pages |
| `s26-journey-sysinfo.sh` | the diagnostic contract, **and** that it has no runtime socket or host mount |
| `s26-journey-degradation.sh` | an absent GPU is refused clearly and **nothing deploys anyway** |
| `s26-journey-first-run-auth.sh` | setup → login → session invalidation, including a **wrong password being refused** |
| `s26-journey-doctor-parity.sh` | the CLI and the web report the **same health for the same install** — same checks, same verdicts. Runs locally |
| `s27-journey-public-install.sh` | a stranger with **no credentials** installs from the public repo and gets a working install — one sitting, one machine |
| `s28-journey-install-integrity.sh` | the installer **refuses** a corrupted or truncated download. Includes a control that must still install, or "refused" would be indistinguishable from a broken harness |
| `s28-journey-build-rebuild.sh` | a source edit rebuilds, asserted on the **running container** with the image tag held constant — same name, different bytes |
| `s28-journey-rootful-podman.sh` | the rootful Podman contract end to end: runtime-aware doctor, one provider-neutral server compose, healthy control plane, login, data surviving a converge |
| `s29-journey-deploy-reporting.sh` | the summary counts the **deployment**, not the compiled artifact (appbay-cli#4), and a validator that cannot run does not return a verdict (appbay-cli#5). Carries two controls: an idempotent converge must still report `0 deployed`, and the plan must still be UNCHANGED on the run that must report a deployment |

⚠️ **This table is hand-maintained and it silently stopped being an index.** Audited
2026-08-16: it listed 19 of 23 scripts — `s27-journey-public-install.sh` had been missing
since S27, and a reader would have concluded the public-install path had no journey at all.
An index that is not checked is a document that quietly becomes wrong, which is the exact
failure this directory exists to catch elsewhere. Check it before trusting it:

```bash
diff <(ls scripts/journeys/*.sh | xargs -n1 basename | sort) \
     <(grep -oE '`s[0-9]+-[a-z0-9-]+\.sh`' scripts/journeys/README.md | tr -d '`' | sort -u)
```

## Writing a new one

Six rules, each learned by getting it wrong in this directory:

**1. Assert the property, not the label.** A grep for `backup` matched the fixture app's own
name (`degr-backup`) in `container_name` and reported a leak that did not exist. An
assertion that cannot distinguish the thing under test from its label is not an assertion.

**2. A before/after comparison must first prove "before" is good.**
`s25-interface-optionality.sh` compares the edge's behaviour before and after removing
AppBay. On the Podman host its default `HOST` did not resolve, so *both* probes returned
`000` — and it reported "gated app unchanged (000)" three times. **Comparing two broken
states passes.** It now aborts unless the baseline is genuinely serving.

**3. Prove the check can fail.** Plant the defect and watch it go red *before* trusting a
green run. Several checks here passed vacuously on first write: asserting running-state
against `appbay status <app>` (a **configuration** view that never says "running"), and a
leak detector that had never detected a leak. A control assertion helps — the secrets
journey asserts the secret *did* reach the container, so "no leak" cannot mean "nothing was
delivered".

**4. When element refs keep going stale, drive the page with JS.** `agent-browser`'s `@eN`
refs are assigned per snapshot and invalidate on any re-render, so a
select → compile → assert flow loses them between steps. `agent-browser eval` with
`querySelector` and a native value-setter + `input` event survives re-renders and made an
otherwise unverifiable UI assertion observable. Verifying by inspection is honest only if
you say so; getting to observation is better.

**5. Suspect the harness first.** Of the journeys written for S26, most initially reported a
product defect that was really a harness bug: a wrong container name (namespace isolation
overrides `container_name`), a ref pattern that never matched `button "Create admin &
continue"`, heredocs mangled through `multipass → bash → python`, a launcher hardcoding
`APPBAY_HOME`. **The tell is always the same: a hand-run of the identical steps works.**
Check that before filing anything.

**6. `PRIV` applies to every command, not just the container runs.** On a rootful install
parts of the config tree are root-owned, so an unprivileged `cp -r` stages an *incomplete*
copy and the test then fails for a reason unrelated to what it is testing. And a harness
that mounts host paths needs `:z` on SELinux for exactly the reason the compiler does —
without it the container reports `permission denied`, which reads as invalid config.

**7. Never marshal results back through shell variables, and never nest a heredoc.**
`s26-journey-doctor-parity.sh` had python print `ONLY_CLI=<names>` for bash to source. Check
names contain spaces, so `ONLY_CLI=Shared network DNS` parsed as a temporary assignment
prefixing a command named `network` — the variable never persisted, and **all four parity
assertions reported ✅ while the web was genuinely missing a check**. Rewriting it as a
heredoc then silently ended the *outer* heredoc at the inner `PY`. Both are fixed the same
way: the comparator is its own file under `lib/`, and it prints `OK|…` / `BAD|…` lines that
the shell only has to classify. Note the first version was **green** — rule 3 is what found
this, not the passing run.

**8. A journey may not leave SHARED state broken — and "shared" includes things it did not
create.** Rule 7 covers cleaning up what you made. This is the other half: what you
*borrowed*. `s29-journey-deploy-reporting` needed an install whose edge was not deployed, and
its first version got there with `rm -f appbay.caddy`. That container belongs to the host
install. The next sweep opened with **three unrelated journeys red** — `s25-edge-authz`
(`landed chrome-error://chromewebdata/`), `s25-interface-optionality` (`returned 000`) and
`s26-journey-aux-transactional` (`the good app produced no artifact`) — every one of which
reads like a product defect, and none of which was.

Prefer the **reversible** form of the condition you need: `stop` the edge and start it again,
rather than removing it. Record what you found before you change it, and restore exactly
that. Where the condition genuinely requires a pristine host, launch an ephemeral VM instead
— see `s27-journey-public-install` and `s28-journey-install-integrity`.

⚠️ The tell is a sweep whose failures cluster on one shared dependency. That is rule 3
("suspect the harness first") applied across scripts rather than within one.

Fixtures must be **self-provisioning** and must clean up after themselves — including
anything they created that the install did not have before. A suite that needs a
hand-prepared host cannot run on a second runtime, which is how `tests/bdd/` ended up with
no passing run for months.
