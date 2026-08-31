# RFC-001: identity, system home, secrets, namespace, `when`, catalog

Status: proposed, revision 2 (2026-08-31). Scope: `appbay-cli`. Driver: prep for the UOM LLM stack.

Line numbers are from `kundeng/appbay-cli` at `bd32116` / `v0.0.1-alpha.11`. Every claim below
that says "measured" has a probe record in
`investigations/2026-08-30-preprod02-sim-stack-review/raw/`; findings are `F<n>` in that slug's
`INVESTIGATION-` document.

> **Correction notice — what changed from revision 1.** Five decisions moved after the claims
> were tested against the running compiler and vault rather than read:
> **(a)** work item 4.3 is withdrawn; the defect it fixes does not exist [F35].
> **(b)** the catalog plan as written silently hands `litellm` and `portainer` to upstream's
> definitions [F40].
> **(c)** §1's target was wrong: the edge password is a portal-local account and the LDAP/OIDC
> path is dead code, so the reachable target is zero human passwords, not one [F44].
> **(d)** item 2.6 is withdrawn; the comment it corrects already says JSON [F43].
> **(e)** `project` + `environment` collapse into one `namespace`, which subsumes the
> instancing work and is now §4 [F53].

> **Scope notice (2026-08-31) — this RFC was measured against a subset.** Every finding here
> was produced by reading `appbay-cli`, which is a strict *subset* of the private `appbay`
> tree at identical paths: `public/apps/` holds only `cli`, while the private tree adds
> `apps/web` — the tRPC server and UI — at ~50k lines. So each "zero callers" claim
> established *no callers in this repo*, a weaker statement than the one the work items act on.
>
> Re-measured against the superset: **1.4** (`renderEdgeSecurityBlock`, `edgeSecretEnvMapping`)
> and **§2** (`ProjectConfigSchema`, `EnvironmentConfigSchema`, the unjoined `"projects"`)
> hold unchanged — zero hits in `apps/web` either. **1.1** and **5.1** do not; both carry a ⚠️
> below. Deleting `hashControlPlanePassword` remains safe: `apps/web` hashes with its own
> `server/auth.ts`, not that function.

---

## 1. Identity: four passwords, and the one that should not exist

### Measured state

| # | password | minted | gates | stored |
|---|---|---|---|---|
| 1 | control-plane | `admin.ts:33` | signing in to **appbay itself** | hash in `etc/control-plane/users.yaml` |
| 2 | edge user | `edge-identity-service.ts:87` | a person signing in to the **deployed apps** through Caddy | hash in `etc/apps/caddy/config/security/users.json` |
| 3 | vault master | `vault-service.ts:198` | decrypts `var/lib/vault.enc` | plaintext, mode 0600, `etc/vault-password` |
| 4 | KeePass master | `keepass.ts` `resolveDbPassword` | opens the `.kdbx` | plaintext, `etc/kdbx-password` |

**#4 already collapses** — `resolveDbPassword` falls through to `APPBAY_VAULT_PASSWORD` at step 3
and `etc/vault-password` at step 4, so it is separate only when `etc/kdbx-password` exists [F38].

**#2 is a portal-LOCAL account, not a federated identity** [F44]. The shipped Caddyfile declares
one identity store (`system-apps.ts:110`), `appbay edge users` writes bcrypt cost-10 hashes into
Caddy Security's own `users.json`, and the password exists because the portal has no upstream to
ask.

🚨 **The no-password-stored path is already modelled and is not wired.** `EdgeIdentityProvider` is
a `local | ldap | oidc` union (`edge-identity-providers.ts:39`, `:46`, `:70`);
`edge-portal-config.ts` has `renderLocal`, `renderLdap` and `renderOidc`; and an ldap or oidc
provider stores no user password at all — only `bindPasswordRef` or `clientSecretRef`, both
routed through the ordinary `vault://` path. But `renderEdgeSecurityBlock` and
`edgeSecretEnvMapping` have **zero callers and zero tests**, and the live Caddyfile hardcodes the
local store with no provider selection. Nothing can reach the renderer.

🚨 **#1's recovery command does not work in the only mode this project deploys** [F39]. Against an
`APPBAY_HOME` with no control-plane store and no cache — the state a CLI-only install is always
in, because the SQLite mirror is built by a server that is not deployed — `appbay admin
reset-password` creates an empty 0-byte `var/lib/appbay.db` and exits 1 with a raw
`SQLiteError: no such table: users` and a stack trace. `admin.ts:35` opens the database
unconditionally and bun:sqlite creates it; the legacy-migration query at `:41` sits outside the
try/catch at `:88` that exists to tolerate a missing cache, so the intended
`Local AppBay user 'admin' not found` is never reached.

### Decision

**#1 is deleted as a concept.** The AppBay web UI is a stack like any other. It sits behind the
edge and authenticates against the edge identity store, the same as Portainer or Open WebUI.
No separate account system, no `etc/control-plane/users.yaml`, no `password_hash` column, no
`appbay admin reset-password`.

**#2 is the fallback for an edge with no identity provider, not the primary path.** Renamed from
"edge user" to **user**: `appbay user add|passwd|rm|list`. Wire `renderEdgeSecurityBlock` and
point it at an LDAP or OIDC provider and the human-password count reaches **zero** — what remains
is one bind password or client secret, a `vault://` secret like any other.

**#3 stays** — something holds the root of the encryption tree — and moves per §2. **#4 collapses
into it.**

### Work

- **1.1** Delete `apps/cli/src/commands/admin.ts`, `packages/core/src/schemas/control-plane-users.ts`,
  `hashControlPlanePassword`, the `passwordHash` column (`packages/db/src/schema.ts:112`,
  `packages/db/src/index.ts:142`), and the control-plane branch of `retired.ts`.

  🚨 **The column is not dead — it has nine consumers, none of them in this repo.** Measured
  against the private superset, `passwordHash` is read by `apps/web`'s sign-in itself
  (`app/api/auth/[...all]/route.ts:152`, `verifyPassword(body.password,
  authoritativeUser.passwordHash)`), by `server/auth.ts:169,174,184`, by
  `server/control-plane-users.ts:62,103,110`, and by two test files. Dropping the column here
  breaks web-UI login on the next `git merge upstream/main`, and the break surfaces in the
  private tree with no diff in this one to point at.

  Order this as a migration, not a deletion: land 1.4 so the edge can actually carry the
  identity, cut `apps/web` over to it, *then* drop the column. The rest of 1.1 — `admin.ts`,
  the schema module, `hashControlPlanePassword`, the `retired.ts` branch — has no `apps/web`
  consumer and can go first.
- **1.2** Register the web UI as a normal catalog entry with the `auth` trait. ⚠️ Not
  executable in this repo: the web UI is `apps/web` in the private tree, so the manifest and
  the cutover are authored there. What belongs here is the `auth` trait support it consumes.
- **1.3** Rename `edge user` → `user` in `apps/cli/src/commands/edge.ts`; keep `edge` for proxy
  operations. Alias the old paths for one release.
- **1.4** 🆕 **Wire `renderEdgeSecurityBlock`.** It is complete and unreachable. Give the edge a
  provider selection in system config, render the chosen block, and route `bindPasswordRef` /
  `clientSecretRef` through `edgeSecretEnvMapping`, which is equally unwired. This is what makes
  §1's premise true rather than aspirational.
- **1.5** Migration: on first run with a `users.yaml` present, import each account into the edge
  identity store and print what happened.

Preserve: reset revokes all prior hashes (`edge-identity-service.ts:108-110`), the 0600 atomic
write (`:67-85`), and the restart-not-reload requirement (`:122-146`).

---

## 2. System home: one file, and the one field that cannot live in it

### Measured state

`readSystemConfig()` has exactly **two** non-test callers, `appbay-home.ts:101` and `:147`, and
**both take `.home`**. `owner` and `service_user` are written and never read by any command;
`writeSystemConfig()` has no non-test caller because `init-system` writes the file with
`sh -c 'mkdir -p /etc/appbay && tee …'` (`init-system.ts:523`) [F45].

Four config levels are documented. **Two do not exist** [F47]:

| level | intended path | schema | read? |
|---|---|---|---|
| instance | `$APPBAY_HOME/project.yaml` | `InstanceConfigSchema` | ✅ 8+ sites |
| project | `etc/projects/<name>/project.yaml` | `ProjectConfigSchema` | ❌ zero readers |
| environment | `etc/projects/<name>/environments/<env>.yaml` | `EnvironmentConfigSchema` | ❌ zero readers |
| app | `etc/apps/<app>/.env{,.local}` | — | ✅ |

The string `"projects"` is never joined into a path anywhere in `apps/` or `packages/`. The one
real file, `$APPBAY_HOME/project.yaml`, sits at the root, holds `domain`, `container_runtime`,
`container_store`, `ingress_provider`, `acme_dns_provider`, `control_plane_selinux` and
`catalog_source` — none project-scoped — and shares a filename with a different schema, which
`instance.ts:4-16` carries a warning block about.

### Decision

**Discovery and self-declaration are two jobs** [F46]. Discovery answers *where is the tree* and
must live outside it. Self-declaration answers *where does this tree believe it lives*, is read
after the tree is found, and belongs inside it as an **absolute** path — a relative one is true by
construction and detects nothing.

```
$APPBAY_HOME/etc/system.yaml   owner · service_user · secrets_backend · home (absolute, asserted)
                               · domain · container_runtime · container_store · ingress_provider
                               · acme_dns_provider · control_plane_selinux
$APPBAY_HOME/var/lib/secrets/  master-password (0600) · vault.enc | secrets.kdbx
$APPBAY_HOME/var/lib/state/    operator-id · generated-values.yaml
~/.config/appbay/home          discovery, one line, no root — tier 3
$APPBAY_HOME (env)             tier 1
/etc/appbay/config             DELETED
```

The instance file merges into `etc/system.yaml` and the filename collision dies with the merge.
`etc/projects/<name>/project.yaml` becomes the only `project.yaml`. There is **no**
`var/lib/secrets/backend` mirror — one file, one operative value.

⚠️ Tier 2's one real job was outranking a per-operator choice on a service install where
`~/.config` belongs to the wrong user. `Environment=APPBAY_HOME=` in the systemd unit covers that
at tier 1, so the deletion needs the unit, not just the deletion.

⚠️ `init-system` runs before `$APPBAY_HOME` exists on a service install. Whatever writes
`etc/system.yaml` must run after directory creation and before first use.

### Work

- **2.1** Merge `InstanceConfigSchema` and `SystemConfig` into one `etc/system.yaml`, adding
  `secrets_backend: vault|keepass` (default `vault`) and an asserted absolute `home`.
- **2.2** Single `resolveMasterPassword()` in core: `APPBAY_MASTER_PASSWORD` →
  `var/lib/secrets/master-password` → generate-and-persist. Delete the four-tier keepass ladder
  (`keepass.ts:92-125`) and the two duplicate resolvers (`vault.ts:308-328`,
  `vault-service.ts:98-113`).
- **2.3** Fold `appbay secrets init` into `appbay init`. Keep `rotate-password` and
  `repair-password-file`.
- **2.4** 🆕 **Compare the asserted `home` against the resolved path and fail loudly on
  disagreement.** Nothing detects a moved or copied tree today — `looksScaffolded()` is
  `existsSync(path/etc)` and that is the whole check. The repo already knows this failure class:
  `init.ts:131-132` makes the runtime socket gid overridable because *"copying an APPBAY_HOME to
  another machine must not silently keep the old one."*
- **2.5** Fix `vault.ts:41` — `SCRYPT_SALT` is the constant `"appbay-vault-v1"`, so the derived
  AES key is a pure function of the password and two hosts sharing one password hold
  interchangeable vault files [F37]. ⚠️ Not a one-line change: the file is `IV(12) + tag(16) +
  ciphertext` with no header (`vault.ts:191`, `:223`), so a per-vault salt needs a format version
  byte and a read path accepting both shapes. Schedule as a format migration.
- **2.6** ~~Fix the doc comment at `vault.ts:8-11`.~~ **WITHDRAWN** — it already says
  *"encrypted JSON file"* and *"the decrypted contents are a JSON object"*; `yaml` appears zero
  times in the file [F43].
- **2.7** ~~Delete `/etc/appbay/config` and `writeSystemConfig`, after the systemd unit exports
  `APPBAY_HOME`.~~ 🚨 **REFUTED by measurement — do not implement as written** [probe-86].
  A unit's `Environment=` reaches the processes systemd starts and nothing else: on
  appbay-docker the service saw `/var/lib/appbay` and an operator login shell on the same host
  saw `<unset>`. Tier 2 serves the opposite process tree — an operator typing `appbay …` — and
  it does the job this RFC credits it with: with the file present the CLI resolved
  `/var/lib/appbay` over a personal `~/.config/appbay/home`; with it deleted the CLI resolved
  the personal path, which is verbatim the failure "outranking a per-operator `~/.config`
  choice on a service install" describes. The unit is not a substitute, so writing it does not
  license the deletion.

  ⇒ What survives of 2.7, carried by S33: keep the tier, narrow it to `home`. `owner` and
  `service_user` are WRITE-ONLY — `readSystemConfig()` has two callers and both read `.home` —
  so the fields go, not the file. Ship the unit too, because running the control plane under
  systemd is right on its own merits, just not as this prerequisite.

---

## 3. Secrets: `vault://` is the only manifest notation

### Measured state

`parseVaultUri` (`vault.ts:112`) is **already arbitrary-depth**: nine-segment URIs round-trip
through the real `Vault`, and `listAll()` splits on the last slash and reconstructs the same pair
[F41]. The list at `vault.ts:96-101` is examples, not a limit. Nothing to fix but the comment.

The backend leaks into manifests at `appbay-yaml.ts:212`:
`provider: z.enum(["vault", "keepass", "file", "env", "sops"])` — five values, not two.

🚨 **The argv exposure is six sites, and two leak the stored value** [F36]:

| site | in the `/bin/sh -c` argv |
|---|---|
| `keepass.ts:151` | master password |
| `vault-service.ts:452` | master password |
| `vault-service.ts:513` | master password (`db-create --set-password`) |
| `vault-service.ts:565` | master password **and the stored secret** (`edit --password '<value>'`) |
| `vault-service.ts:570` | master password (`mkdir`) |
| `vault-service.ts:578` | master password **and the stored secret** (`printf '%s\n%s'`) |

The repo states the rule against exactly this at `apps/cli/src/commands/secrets.ts:359`:
*"THIS EXISTS BECAUSE ARGV IS WORLD-READABLE … it is NOT fine for a configuration-management run
seeding real credentials onto a shared host."*

> **Reference implementation, already correct.** `~/Dropbox/Dev/dsx_dev_runstack/ks` — the
> owner's own `kp://` secrets CLI — pipes the master through a bash **builtin** `echo` into
> `keepassxc-cli`'s stdin at `ks:181`, `:251` and `:302`, so nothing reaches argv and no composed
> string reaches `sh -c` [F57]. Copy that shape.

### Decision

`vault://PATH[/PATH...]/FIELD` is the only secret notation permitted in `appbay.yaml`. The backend
is invisible to manifests. `keepass://` remains usable at the CLI for direct inspection and is
rejected by manifest validation. The KeePass path needs no further work: mount one `.kdbx` into
KeeWeb for humans and point the backend at the same file. One store, two readers.

### Work

- **3.1 — first, before any real secret is stored.** Replace all six sites with `execFile` plus a
  write to the child's stdin. No shell.
- **3.2** Narrow the `provider:` enum at `appbay-yaml.ts:212` to `vault`; reject the other four in
  manifest validation.
- **3.3** Route `set-kdbx`/`get-kdbx`/`delete-kdbx` through the backend-neutral
  `secrets set|get|delete`. `set-kdbx` takes the value as a required argv argument
  (`secrets.ts:591`) with no stdin path — the exposure `secrets set` was already fixed for.
- **3.4** Extract the scope/key split (duplicated at `vault.ts:134-135` and `vault-service.ts:325,
  353, 375`) into one exported helper.
- **3.5** Confirm full CRUD survives: `set` (stdin), `get`, `delete`, `list`, `rotate-password`,
  `import`, `scan`, `check`.
- **3.6** `catalog-service.ts:222-235` writes a secret to plaintext `.env.local` when the vault is
  unreachable. ⚠️ **It is announced, not silent** [F42] — the operator sees
  `NAME (VAULT UNAVAILABLE — written to .env.local in PLAINTEXT; …)` through `install.ts:116-118`,
  the file body carries a warning header with remediation, and the file is chmod 0600 when it
  holds one. It was written that way deliberately (issue #47) to replace a version that announced
  the fallback and wrote nothing. With 2.3 the vault is *usually* available, not never
  unavailable — a corrupt file or a wrong `APPBAY_VAULT_PASSWORD` still reaches this branch. Keep
  an explicit failure path; make it fail rather than downgrade. Separately, `writeFile` then
  `chmod` (`:259`, `:264`) leaves a umask window — pass `{ mode: 0o600 }` at write.
- **3.7** Sweep `appbay-catalog` for `keepass://` in manifests; rewrite to `vault://`.
- **3.8** Fix the comment at `vault.ts:96-101` to say the depth is unbounded.

---

## 4. Namespace 🆕 — collapse `project` + `environment` into one axis

This section replaces revision 1's implicit two-tier model and subsumes the instancing work.

### Measured state

`ScopeSchema` (`appbay-yaml.ts:18-25`) mixes four unrelated axes: **namespace**
(`project`, `environment`), **selector** (`collection`, `tags` — k8s labels and selectors,
already present), **placement** (`operator`), **connectivity** (`shared_network`).

All **150** manifests across both catalogs read `project: default` and `environment: default`
[F51]. The fields carry no information.

🚨 **And they shadow the invocation.** `compile.ts:380-381` is
`config?.project ?? defaultProject`, against fields declared `z.string().default("default")`.
After Zod parsing they are never `undefined`, so the `??` never fires and the values passed into
`compile()` are unreachable. A future `appbay up --namespace uom.sim` would be **silently
ignored** by every manifest [F51, F52].

**No scope chain exists** [F48]. `project.ts:9` claims *"service > environment > project"*;
`ScopeResolver.resolveRef` requires an explicit scope and consults exactly that one map
(`scope-resolver.ts:113-114`). The maps it is fed are `project = { DOMAIN }` — `loadProjectVars`
regexes one `domain:` line and returns nothing else — `environment = {}` and `service = {}`. So
`${{project.DOMAIN}}` is the only reference in the vocabulary that can resolve. The failure
suggestion at `compile.ts:435` and `:517` names `--project-vars` / `--env-vars`: **0** commander
options match either.

Chaining and mixed scopes **already work** [F50]. `compile.ts:508` runs the same `ScopeResolver`
over each trait object that `:427` runs over compose, and `resolve()` replaces with a global
regex. Measured end to end through `compile()` with one app directory and only `environmentVars`
changed, the rendered Caddy file carried `litellm.sim.example.org {` and
`litellm.prod.example.org {`, zero compile errors.

### Decision

**One axis, named `namespace`, flat, dot-delimited: `uom.sim`.**

`environment` keeps its name where it is Compose's (`overrides`, `overlays[].services`,
`docker-compose.yml`) — that is Compose's spec and cannot move. Renaming appbay's tier concept to
`tier` or `stage` was considered and rejected: `environment` is the standard word for a deployment
target and a non-standard name costs more than the collision [F52].

**Flat, not hierarchical** [F53]. Values shared between namespaces live one level up in
`etc/system.yaml`, which already holds `domain`. Layering comes from composing value files, as
`-f values.yaml` does, not from hierarchy in the name.

**Presence in `appbay.yaml` means pinned; absence means decided at deploy time.** The keystone is
one word: `z.string().default("default")` → `z.string().optional()`. That makes absence
expressible and makes `compile.ts:380-381`'s existing `??` correct as written.

**Namespace enters identity, not just values.** Container names are `appbay.<appDir>.<service>`,
networks `<appDir>_internal`, the edge fragment `<appDir>.caddy` — neither `project:` nor
`environment:` appears in any of them [F49]. Putting the namespace in makes two instances of one
app coexist in one home without a second app directory.

🚨 **The dot is safe everywhere except DNS** [F54]. The shared-network alias
(`upstream-transform.ts:167`, `alias = ${appName}_${name}`) is the DNS name other apps dial
(`ingress.ts:70`, `:195`). In DNS a dot is the label separator, so `uom.sim_litellm_litellm` is
two labels, not one name.

### Work

- **4.1** Replace `project` + `environment` with `namespace: z.string().optional()` in
  `ScopeSchema` (`appbay-yaml.ts:19-20`, `:361-362`).
- **4.2** Collapse the pair-keyed sites: `compile.ts:370-371`, `:380-381`, `:446-447`, `:555-556`,
  `:976`; the generated-values key (`generated-values.ts:72`, `:131`; `state.ts:27-28`, `:75-76`)
  from a 4-tuple to a 3-tuple; and `ScopeValues` / `VALID_SCOPES`
  (`scope-resolver.ts:20-22`, `:50`).
- **4.3** Make `discoverRunningApps` namespace-aware. `docker.ts:72` is `/^appbay\.([^.]+)/`,
  which takes the first segment — against `appbay.uom.sim.litellm.litellm` it yields `uom`, so
  every `when:` clause fails silently. It must filter by namespace regardless of delimiter,
  or `when: [litellm]` in `uom.sim` would be satisfied by `uom.prod`'s litellm.
  `builds.ts:285` reconstructs the same name and needs the same treatment.
- **4.4** Put the namespace into `upstream-transform.ts:153` (container), `:260` (network) and
  `ingress.ts:161` (aux filename).
- **4.5** Add `dnsSafe(namespace)` — dot to hyphen — used at `upstream-transform.ts:167` and both
  `ingress.ts` construction sites.
- **4.6** Build the namespace value loader so `${{namespace.KEY}}` resolves per app, and make the
  invocation win over the manifest. `appNamespace` is already computed at `compile.ts:380`.
- **4.7** Add `appbay install <entry> --as <name>`. `catalogInstall` (`catalog-service.ts:92-94`)
  uses one `name` for both the catalog lookup and `targetDir = join(appsDir, name)`; split them.
  Still useful after 4.4 for two instances that want different app names.
- **4.8** Fix `compile.ts:435` / `:517`: the suggestion names two files nothing reads and two
  flags that do not exist.

Migration cost is nil: `generated-values.yaml` on the deployed host is `values: []`, and all 150
manifests read `default`/`default`. This is a text edit, which is the argument for doing it before
the tier is built rather than after.

---

## 5. `when` is deploy-time, not runtime

### Measured state

`when` is evaluated against `discoverRunningApps()` (`docker.ts:59-94`), two `podman ps` reads
with no `-a`, so `when: [portainer]` currently asserts *"a container named portainer happened to
be up at the instant this app was last compiled."*

| | limit | status |
|---|---|---|
| a | a snapshot during one compile, not a standing condition | real |
| b | running, not healthy — a restart-looping portainer satisfies it | real |
| c | ~~never re-evaluated; a newly-true condition renders byte-identical~~ | ❌ **does not exist** |
| d | app names only — no version, health, host fact, or predicate | real |
| e | only sees apps in this invocation's target set | real |
| f | Docker unavailable is indistinguishable from nothing running (`docker.ts:76`, `:91` swallow failures behind `status === 0` gates) | real |

**(c) was tested and is false** [F35]. Compiling one app twice against one `rendersDir` — `ollama`
absent, then active — gives plan status **`changed`**, not `unchanged`. The overlay's
`OLLAMA_BASE_URL` is in the second render and the renders differ, because `overlay-engine.ts`
merges into the compose service map before the render is hashed, and `activeApps` is an input to
`compile()`.

### Decision

**`when: [a, b]` means "when apps a and b are both *installed*."** Installed is a fact about the
declared app set, knowable at compile time, needing no daemon. This kills a, b, d, e and f.
(c) needs nothing.

Rejected: replacing `when` with an Ansible `group_vars` variable re-rendered every converge. That
is available only when there is an Ansible step, and it pushes cross-stack wiring out of the
manifest.

### Work

- **5.1** Replace the `activeApps` input with `installedApps`, derived from the declared app set.
  Delete `discoverRunningApps()` and its four sites (`up.ts:62`, `apply.ts:32`, `compile.ts:66`,
  `eject.ts:129`). ⚠️ Sequence against 4.3, which makes the same function namespace-aware — if
  5.1 lands first, 4.3 disappears.

  ⚠️ **Six sites, not four, and there are two implementations.** `apps/web` carries its own
  `discoverRunningApps` at `server/docker-utils.ts:25` — its docblock says it "centralises" the
  helper — feeding `activeApps` into the same compiler at `server/queue/workers/eject.ts:51`
  and importing it at `server/routers/deployments.ts:20`. Changing `compile()`'s parameter
  here without changing those leaves the private tree passing a running-set where an
  installed-set is expected: a type error at the merge if the field is renamed, and a silently
  wrong argument if it is not. Land both sides in one private commit, then cherry-pick the
  public half.
- **5.2** Make the set the *full* declared set, not the invocation's target set. This is what
  fixes (e), and it is the difference between `appbay up openwebui` and `appbay up` producing the
  same artifact. Needs a test.
- **5.3** ~~Fix (c).~~ **WITHDRAWN** — measured, does not exist [F35].
- **5.4** Keep the AND/OR algebra (`overlay-engine.ts:65-85`), including the tested degenerate
  cases: `when: []` always active, `when: {any: []}` never. Keep the mixed-form rejection.
- **5.5** Leave `BuildWhenSchema` (`appbay-yaml.ts:314-316`) alone; `:307-312` explains why.
- **5.6** Update `whenClauseLabel()` and the "Overlay skipped" warning to say *installed*.

---

## 6. Catalog: stop overwriting, start adding

### Measured state

Two locations exist and the mechanism is sound: `var/lib/catalog/bundled` (shipped) and
`var/lib/catalog/sources/<name>` (`appbay catalog add-source`), discovered by `discover.ts:32-68`.

`provision-appbay.yml:692` runs `appbay init --catalog /app/llm-stack-catalog`, and `seedCatalog()`
(`init.ts:405-449`) **symlinks that tree into `bundled`**. All seven apps report `SOURCE: bundled`
and `sources/` never exists.

Revision 1 named two consequences. **Both were wrong** [F43]:

- ~~"An appbay upgrade re-seeding `bundled` clobbers the UOM tree."~~ It cannot: `seedCatalog`
  returns `"exists"` the moment `bundled` has content (`init.ts:409-415`), so a re-seed
  short-circuits and prints *"Catalog already present."* The real consequence is the reverse —
  appbay's own **150-app catalog is never installed at all**, because five UOM apps hold the slot.
- ~~"Dedup is bundled-wins, which is why the front door resolves to `openwebui`."~~ With the UOM
  tree *as* `bundled`, upstream's `open-webui` is not present, so nothing collides. The rename is
  defensive and becomes load-bearing only after the move.

🚨 **And the move as planned loses two apps** [F40]. With upstream's 150 apps in `bundled` and the
UOM stack in `sources/uom-ai-stack`, `discoverCatalog()` resolves:

| our app | also in upstream `bundled` | wins |
|---|---|---|
| `openwebui` | no (upstream calls it `open-webui`) | uom-ai-stack |
| `mcp` | no | uom-ai-stack |
| `sysinfo` | no | uom-ai-stack |
| `litellm` | **yes** | ⚠️ **bundled** |
| `portainer` | **yes** | ⚠️ **bundled** |

`discover.ts:55-62` keeps the bundled entry on a name collision and bundled is scanned first, so
the move swaps the UOM LiteLLM gateway and the amd64-pinned Portainer for upstream's, with no
error and no warning. `openwebui` survives only because it was already renamed. Upstream's
catalog is also not clean — 10 of its 150 entries fail to parse.

### Decision

The UOM stack becomes its own repo, added as `sources/uom-ai-stack`; `bundled` is left alone.
**Plus a collision rule, without which the move is a silent regression.**

### Work

- **6.1** `--catalog` no longer writes to `bundled`. It registers a source:
  `appbay init --catalog <path|url>` ≡ `catalog add-source local <path|url>`. `bundled` is only
  ever written from the baked path.
- **6.2** 🆕 **Resolve the bundled-wins collision before 6.3 runs.** Either prefix every UOM app
  (`uom-litellm`, `uom-portainer`) or let an explicitly added source override `bundled`. Do not
  land 6.3 without one of them.
- **6.3** Extract the UOM stack into its own repo; change `provision-appbay.yml:692` to
  `appbay catalog add-source uom-ai-stack <url>`.
- **6.4** `--catalog` on an already-seeded home reports *"Catalog already present."* and ignores
  the flag, while `init.ts:885` advertises it as the remediation. After 6.1 it works.
- **6.5** Dedup between two *external* sources is `readdir` order (`discover.ts:44`) — undefined.
  Make a non-bundled collision an error naming both.
- **6.6** Dedup keys on `name` inside `catalog.yaml`, not the directory (`discover.ts:112`). Keep,
  but surface the directory in collision messages.
- **6.7** Resolve `openwebui` vs `open-webui` explicitly once `sources/` is real.

---

## Sequencing

| order | item | why here |
|---|---|---|
| 1 | **3.1** argv disclosure | Before any real secret is stored. Nothing else ships first. |
| 2 | **4.1–4.2** namespace collapse | Text edit today, a data migration once the tier is built. Do it while all 150 manifests still read `default`. |
| 3 | **§2** system home + master password | §1 and §3 depend on one master password in one place. |
| 4 | **3.2–3.8** | Needs §2. |
| 5 | **§1** password collapse, incl. 1.4 wiring the IdP renderer | Needs §2. |
| 6 | **6.2 then 6.1, 6.3** | Independent. Unblocks the stack. 6.2 gates 6.3. |
| 7 | **§5 `when`**, then **4.3–4.6** | 5.1 deletes the function 4.3 would fix; do `when` first. |
| 8 | **4.7–4.8**, **2.5** salt migration | Independent; 2.5 is a file-format change, give it room. |

**3.1 and §6 are independently shippable.** 3.1 is a security fix with no dependencies; §6
unblocks the stack.

## Release

The binary is pinned deliberately. Each landed group gets a release tag; send the tag and
`appbay_release_tag` is bumped and re-converged. No unpinned rolling.

## Deliberately not covered

Migration code for the `users.yaml` import and legacy path moves — write when 1.5 and 2.7 land.
