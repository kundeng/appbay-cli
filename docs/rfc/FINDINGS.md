# Findings F35–F57 — the measured basis for RFC-001

Extracted 2026-08-31 from `work-splunk-ops/investigations/2026-08-30-preprod02-sim-stack-review/INVESTIGATION-2026-08-30-preprod02-sim-stack-review.md`.
Every finding cites a probe record in `evidence/`. Findings are append-only and in discovery order;
where one supersedes another the relation is stated in the finding itself.

**F35 — REFINES F30. The byte-identical half of that finding is wrong; the real gate is the target set.**
F30 said a newly-true `when:` clause renders byte-identical, so the plan says `UNCHANGED` and
the app is never recompiled. Compiling the same app twice against one `rendersDir` — first
with `ollama` absent, then with it active — gives plan status **`changed`**, not `unchanged`.
The overlay's `OLLAMA_BASE_URL` is in the second render and the two renders differ, because
`overlay-engine.ts` merges overlay fragments into the compose service map *before* the render
is hashed. `activeApps` is an input to `compile()` (`deploy-service.ts:607` → `compile.ts:171`),
so change detection sees the overlay.

What survives is the narrower gate F30 also stated: **an app is only re-rendered when it is in
this invocation's target set.** `appbay up ollama` does not recompile `openwebui`; `appbay up`
with no target does.

⇒ Under the deploy-time reading of `when:` — *"both apps are installed at converge time"*,
which is the reading the operator asked for — this is correct behaviour, not a defect. Ansible
re-converges the whole set every run, so the condition is re-evaluated every run. Two of
probe-65's five limits stand: `ps` has no `-a`, so **stopped-but-installed reads as false**,
and there is no health dimension. Those are the two a deploy-time predicate gets wrong, and
they are the ones to fix.
Evidence: `raw/probe-67-when-overlay-does-replan-so-limit-c-is-false.yaml`

**F36 — EXTENDS F31. Six sites, not one, and two of them leak the stored secret, not just the master password.**
`keepass.ts:151` has five siblings in `vault-service.ts`, all through `promisify(exec)`:

| site | in the argv |
|---|---|
| `keepass.ts:151` | master password |
| `vault-service.ts:452` | master password (generic `keepassxc-cli` runner) |
| `vault-service.ts:513` | master password (`db-create --set-password`) |
| `vault-service.ts:565` | master password **and the stored secret value** (`edit --password '<value>'`) |
| `vault-service.ts:570` | master password (`mkdir`) |
| `vault-service.ts:578` | master password **and the stored secret value** (`printf '%s\n%s'`) |

The repo already states the rule against exactly this, at `apps/cli/src/commands/secrets.ts:359`:
*"THIS EXISTS BECAUSE ARGV IS WORLD-READABLE … it is NOT fine for a configuration-management
run seeding real credentials onto a shared host."* That comment exists to justify making
`appbay secrets set`'s value argument optional. Six sites in the keepass path break the rule,
and `:565` / `:578` break it for the credential itself.
Evidence: `raw/probe-71-six-argv-leaks-and-a-constant-kdf-salt.yaml`, F31

**F37 — the vault's KDF salt is a compile-time constant, and the file format has nowhere to put a real one.**
`vault.ts:41` is `const SCRYPT_SALT = "appbay-vault-v1"`, passed to `scryptSync` at `:51`. The
derived AES-256 key is therefore a pure function of the master password: two hosts with the
same password hold interchangeable `vault.enc` files, and one cracked password is reusable
against every vault that shares it.

The fix is not one line. The file is `IV(12) + tag(16) + ciphertext` with no header
(`vault.ts:191`, `:223`), so a per-vault random salt needs a format version byte and a read
path that accepts both shapes. ⇒ Schedule it as a format migration, not as a constant swap.
Evidence: `raw/probe-71-six-argv-leaks-and-a-constant-kdf-salt.yaml`

**F38 — four passwords, gating four different things, and only one of them collapses today.**

| # | password | minted | gates | stored |
|---|---|---|---|---|
| 1 | control-plane | `admin.ts:33` | signing in to **appbay itself** | hash in `etc/control-plane/users.yaml` |
| 2 | edge user | `edge-identity-service.ts:87` | a human signing in to the **deployed apps** through Caddy | hash in `etc/apps/caddy/config/security/users.json` |
| 3 | vault master | `vault-service.ts:198` | decrypts `var/lib/vault.enc` | **plaintext, mode 0600**, `etc/vault-password` |
| 4 | KeePass master | `keepass.ts` `resolveDbPassword` | opens the `.kdbx` | plaintext, `etc/kdbx-password` |

**#4 already collapses.** `resolveDbPassword` falls through to `APPBAY_VAULT_PASSWORD` at step 3
and to `etc/vault-password` at step 4, so it is a separate password only when
`etc/kdbx-password` exists.

**#1 and #2 are not the same thing** and merging them would be wrong. #2 is the SSO login a
person uses to reach Open WebUI and LiteLLM; it is the one legitimate human password in the
system. #1 exists only to sign in to appbay's own web UI — the component this deployment does
not run.

**#3 already has the home the operator asked for.** `initVault` (`vault-service.ts:187`,
`:203`) writes it in the clear at `$APPBAY_HOME/etc/vault-password` with `mode: 0o600` plus a
following `chmodSync`, during `appbay init`. No change needed; the location is
`$APPBAY_HOME/etc/vault-password`.
Evidence: `raw/probe-70-four-passwords-at-head-and-which-are-collapsible.yaml`

**F39 — `appbay admin reset-password` is unusable on a CLI-only host, and leaves a stray database behind.**
Run against an `APPBAY_HOME` with no control-plane store and no cache — the state a
CLI-only install is always in, because the SQLite mirror is built by the server we do not
deploy — the command creates an empty **0-byte `var/lib/appbay.db`** and exits 1 with a raw
`SQLiteError: no such table: users` and a Bun stack trace.

`admin.ts:35` opens the database unconditionally, and bun:sqlite creates the file. The
legacy-migration query at `admin.ts:41` sits *outside* the try/catch at `:88` that the file
uses elsewhere to tolerate a missing cache — the one carrying the comment *"a failure here
must NOT be reported as a failed reset."* So the intended message, `Local AppBay user 'admin'
not found`, is never reached.

⇒ This is the command an operator reaches for when locked out of appbay's own web UI, and it
does not work in the only mode this project deploys. It strengthens the case for treating
appbay's own UI as a stack like any other: the special-cased control-plane password brings its
own store, its own cache, and its own broken recovery path.
Evidence: `raw/probe-68-control-plane-reset-is-unusable-on-a-cli-only-host.yaml`

**F40 — REFINES probe-64. Moving the UOM stack to `sources/uom-ai-stack` hands `litellm` and `portainer` to upstream.**
The proposed fix — leave `bundled` to appbay, add ours as a named source — was tested by
building both layouts on disk and asking `discoverCatalog()` which entry survives.

| our app | also in upstream `bundled` | wins |
|---|---|---|
| `openwebui` | no (upstream calls it `open-webui`) | **uom-ai-stack** |
| `mcp` | no | **uom-ai-stack** |
| `sysinfo` | no | **uom-ai-stack** |
| `litellm` | **yes** | **bundled** |
| `portainer` | **yes** | **bundled** |

`discover.ts:55-62` keeps the bundled entry on a name collision, and bundled is scanned first.
So the move swaps our LiteLLM gateway definition and our amd64-pinned Portainer for upstream's,
with no error and no warning. `openwebui` survives only because it was already renamed to dodge
the same collision — the rename probe-64 read as a workaround is the only reason three of five
apps are safe.

⇒ The move is still right, but it needs one of: a `uom-` prefix on every app name, or a
`sources` entry that can override `bundled`. Upstream's catalog is also not clean — 10 of its
150 entries fail to parse.
Evidence: `raw/probe-69-moving-uom-to-a-source-lets-upstream-shadow-two-of-our-apps.yaml`

**F41 — `vault://` already takes arbitrary depth. Only the docblock says three.**
Nine-segment URIs round-trip through the real `Vault`: `parseVaultUri` (`vault.ts:112`) takes
the last segment as the key and joins the rest as the scope, and `listAll()` splits on the last
slash and reconstructs the same pair. All five tested depths — 1, 2, 3, 5, 9 — read back, and
`listAll()` matched `parseVaultUri` exactly. The list at `vault.ts:96-101` is examples, not a
limit. Nothing to fix but the comment.

The real leak of backend into manifests is elsewhere: `appbay-yaml.ts:212` is
`provider: z.enum(["vault", "keepass", "file", "env", "sops"])`, so an app manifest names its
storage backend. Five values, not two.
Evidence: `raw/probe-72-vault-uri-takes-arbitrary-depth-only-the-docblock-says-three.yaml`

**F42 — the `.env.local` plaintext fallback is announced, not silent. One residual defect.**
`catalog-service.ts:222-235` writes a secret to plaintext `.env.local` when the vault is
unreachable, and it does so loudly: the operator sees
`NAME (VAULT UNAVAILABLE — written to .env.local in PLAINTEXT; …)` through
`install.ts:116-118`, the file body carries a `PLAINTEXT SECRETS` warning header with the
remediation commands, and the file is chmod 0600 when it holds one. It was written that way
deliberately (issue #47) to replace an earlier version that announced the fallback and wrote
nothing, leaving an undeployable app that reported success.

The residual defect is small and real: `writeFile` then `chmod` (`:259`, `:264`) leaves the
file at the process umask between the two calls. `writeFile(path, body, { mode: 0o600 })`
closes it.
Evidence: source read at `packages/core/src/services/catalog-service.ts:188-266`


**F43 — RFC-001's citations hold, with one dead work item and two premises that do not survive checking.**
Eight of nine cited `file:line` pairs point at what the work item says. Three do not survive:

- **2.6 has nothing to fix.** It says the docblock at `vault.ts:8-11` calls the payload YAML. It
  says *"encrypted JSON file"* and *"the decrypted contents are a JSON object"*, and the string
  `yaml` appears zero times in the file. Drop the item.
- **§5 consequence 1 is backwards.** "An appbay upgrade that re-seeds `bundled` clobbers the UOM
  tree" cannot happen: `seedCatalog` returns `"exists"` the moment `bundled` has content
  (`init.ts:409-415`), and our tree is symlinked in, so a re-seed short-circuits and prints
  *"Catalog already present."* The real consequence is the reverse — appbay's own 150-app
  catalog is **never installed at all**, because our five apps hold the slot.
- **§5 consequence 2's reasoning is off.** The `openwebui` / `open-webui` rename cannot have
  been forced by bundled-wins in the current layout: with our tree *as* `bundled`, upstream's
  `open-webui` is not present, so there is nothing to collide with. The rename is defensive and
  becomes load-bearing only after the move to `sources/` — see F40, where it is the only reason
  three of five apps survive.

Confirmed as cited: `system-config.ts` `readSystemConfig` parses `owner`/`service_user`/`home`
by regex, so `secrets_backend` drops straight in (2.1); `set-kdbx` takes a required `<value>`
argument at `secrets.ts:591` with no stdin path, exactly the exposure `secrets set` was fixed
for (3.3); all four `discoverRunningApps` call sites are where 4.1 says, at `up.ts:62`,
`apply.ts:32`, `compile.ts:66` and `eject.ts:129` (4.1); `docker.ts:76` and `:91` swallow
failures behind `status === 0` gates, so a runtime outage is indistinguishable from an empty
estate (limit f); source-vs-source collisions are decided by `readdir` order with no detection
(5.4); dedup keys on `catalog.yaml`'s `name` field, not the directory (5.5).
Evidence: `raw/probe-73-rfc-001-citations-hold-except-two.yaml`


**F44 — REFINES F38. The edge password is a portal-local account, not a federated one, and the path where nothing is stored is dead code.**
The shipped Caddyfile declares exactly one identity store (`system-apps.ts:110`):

```
security {
    local identity store appbay_local {
        realm local
        path /etc/caddy/security/users.json
    }
```

`appbay edge users` writes bcrypt cost-10 hashes into **that same `users.json`**
(`edge-identity-service.ts:9`, `:174`), which is Caddy Security's own store — not a second
copy of an account held elsewhere. So the password exists because the portal has no upstream
to ask. It is a local account, and calling it an SSO login was wrong.

**The no-password-stored shape is already modelled, and is not wired.** `EdgeIdentityProvider`
is a `local | ldap | oidc` union (`edge-identity-providers.ts:39`, `:46`, `:70`);
`edge-portal-config.ts` has `renderLocal`, `renderLdap` and `renderOidc`; and an ldap or oidc
provider stores no user password at all — only `bindPasswordRef` (`:53`) or `clientSecretRef`
(`:75`), both `SecretRefSchema`, both routed through the ordinary `vault://` path by
`edgeSecretEnvMapping`. Under either provider a person's own directory password never reaches
appbay.

But `renderEdgeSecurityBlock` and `edgeSecretEnvMapping` have **zero callers and zero tests**
across the repo, outside their own definitions and an `export *`. The live Caddyfile hardcodes
the local store with no provider selection, so nothing can reach the renderer. Also:
`apps/` contains only `cli` — the "web control plane" that `edge-identity-service.ts:118-124`
and `deploy-service.ts:652` describe as a second writer is not in this repo.

⇒ **RFC-001 §1's "#2 is the only human password" is true today and is the wrong target.** Local
identities are the fallback for an edge with no identity provider. Wire `renderEdgeSecurityBlock`
and point it at UMMS LDAP or OIDC and the human-password count goes to **zero**: what remains is
one bind password or client secret, which is a `vault://` secret like every other. §1 should say
so, and `appbay user add` should read as the no-IdP fallback rather than the primary path.
Evidence: `raw/probe-74-edge-password-is-a-portal-local-account-and-the-idp-path-is-dead-code.yaml`


**F45 — the system config splits into a pointer and a payload. Only the pointer must stay outside `$APPBAY_HOME`.**
RFC-001 §2.1 puts `secrets_backend` in `/etc/appbay/config`, and §2's layout then carries
`var/lib/secrets/backend` as a mirror of it *"(mirrors system config; the operative value)"*.
Two copies of one decision is the drift this repo keeps finding. The file does not need to be
outside at all, except for one field.

`/etc/appbay/config` holds `owner`, `service_user`, `home`. **`readSystemConfig()` has exactly
two non-test callers — `appbay-home.ts:101` and `:147` — and both take `.home` and nothing
else.** `owner` and `service_user` are written and never read by any command.
`writeSystemConfig()` has no non-test caller either: `init-system` writes the file with
`sh -c 'mkdir -p /etc/appbay && tee /etc/appbay/config'` (`init-system.ts:523`).

| field | can it move into `$APPBAY_HOME`? | why |
|---|---|---|
| `home` | **no** | it is the pointer *to* `$APPBAY_HOME`; inside it, it is circular |
| `owner` | yes | a property of the tree, read after the tree is located |
| `service_user` | yes | same |
| `secrets_backend` | yes | decides how `var/lib/secrets/` is read — same lifetime as the tree |

⇒ **The payload moves to `$APPBAY_HOME/etc/system`** and the mirror in §2's layout goes away:
one file, one operative value, no sync step. `secrets_backend` belongs there for a second
reason — in `/etc` it is a *host* property, so one host cannot hold two trees with different
backends, which is exactly what a rehearsal home beside a production home would need.

**The pointer needs no root.** Resolution is already four tiers (`appbay-home.ts:130-152`):
`$APPBAY_HOME` → `/etc/appbay/config` → `~/.config/appbay/home` → `~/.appbay`. Tier 3 is
written by `appbay init` with no privilege. Tier 2 exists only so a root-installed service
account outranks a per-operator choice. So `/etc/appbay/config` shrinks to one line, or
disappears entirely if service-mode installs export `APPBAY_HOME` from the systemd unit —
tier 1, which outranks everything.

⚠️ Ordering constraint on the move: `owner` and `service_user` are read by nothing today, but
`init-system` runs **before** `$APPBAY_HOME` exists on a service install — it creates the
account and the tree. Whatever writes `$APPBAY_HOME/etc/system` has to run after
directory creation and before first use.
Evidence: `raw/probe-75-only-the-home-pointer-must-live-outside-appbay-home.yaml`


**F46 — SUPERSEDES the "circular" objection in F45. Discovery and self-declaration are two jobs, and only discovery must live outside.**
F45 said `home` cannot move into `$APPBAY_HOME` because it points there. That conflates two
things:

| job | question | must live | form |
|---|---|---|---|
| discovery | where is the tree? | **outside** — it is answered before the tree is in hand | env var, or one line in a known place |
| self-declaration | where does this tree believe it lives? | **inside**, `$APPBAY_HOME/etc/system` | **absolute** |

The self-declaration is not circular: nothing *finds* the tree with it. It is read after the
tree is located and compared against where it was actually found. A disagreement means the tree
was moved or copied.

**Absolute is right; relative would be worse than nothing.** `home: ../..` is true by
construction wherever the directory sits, so it can never disagree with reality and detects
nothing. An absolute path can disagree, and that is the entire value.

**Nothing detects a moved tree today.** `looksScaffolded()` is `existsSync(path/etc)` and that
is the whole check (`home.ts:59-61`); zero code compares the resolved path against anything
recorded inside the tree. The repo already knows this failure class — `init.ts:131-132` makes
the runtime socket gid overridable precisely because *"copying an APPBAY_HOME to another
machine must not silently keep the old one."* Renders survive a move (`compile.ts:395` writes a
relative path back to `appsDir`); host-specific facts do not.

**And tier 2 can go.** `llm-stack` has **zero** `init-system` calls and never reads
`/etc/appbay/config`: every appbay invocation is wrapped with an explicit `APPBAY_HOME`
(`provision-appbay.yml:120`, `:639`, `:656`; `verify-payload.yml:39`; `verify-stack.yml:42`)
and `provision-substrate.yml:662` exports it from the systemd unit. We are tier 1 only. Spec 25
decision 3 lets ansible write exactly two things outside `$APPBAY_HOME` — the binary and the
catalog source — and this is neither.

```
$APPBAY_HOME/etc/system      owner, service_user, secrets_backend, home (absolute, asserted)
~/.config/appbay/home        discovery, one line, no root — tier 3
$APPBAY_HOME (env)           tier 1, what this project actually uses
/etc/appbay/config           deleted
```

⚠️ The one thing tier 2 bought was a **root-level** answer that outranks a per-operator one, for
a service-account install where `~/.config` belongs to the wrong user. `Environment=APPBAY_HOME=`
in the systemd unit covers that at tier 1, which outranks everything — so removing tier 2 needs
the unit, not just the deletion.
Evidence: `raw/probe-76-discovery-and-self-declaration-are-two-jobs-in-one-file.yaml`

**F47 — two of the four config levels do not exist. The one that does is in the wrong place under the wrong name.**
RFC-001 §2 lists four layers as present and correct. Measured:

| level | intended path | schema | read? |
|---|---|---|---|
| instance | `$APPBAY_HOME/project.yaml` | `InstanceConfigSchema` | ✅ 8+ sites |
| project | `etc/projects/<name>/project.yaml` | `ProjectConfigSchema` | ❌ **zero readers** |
| environment | `etc/projects/<name>/environments/<env>.yaml` | `EnvironmentConfigSchema` | ❌ **zero readers** |
| app | `etc/apps/<app>/.env{,.local}` | — | ✅ |

`ProjectConfigSchema` and `EnvironmentConfigSchema` have no non-test consumers; the string
`"projects"` is never joined into a path anywhere in `apps/` or `packages/`, so
`etc/projects/<name>/` is never constructed, let alone read; and `compile()`'s `environmentVars`
flows from its own default `{}` at `compile.ts:176` to `:422` with no caller ever passing it.
No file named `env.yaml` or `environments.yaml` exists anywhere — zero matches. What the
compiler calls "project vars" comes from the **instance** file via `loadProjectVars`
(`deploy-service.ts:320-323`); environment vars come from `--project-vars` / `--env-vars`.

**The one real file is misplaced and misnamed.** `$APPBAY_HOME/project.yaml` sits at the root
and holds `domain`, `container_runtime`, `container_store`, `ingress_provider`,
`acme_dns_provider`, `control_plane_selinux`, `catalog_source` — none project-scoped; its
`project:` key is only the default project *name*. It shares a filename with a different schema,
and `instance.ts:4-16` carries a warning block whose only job is to stop a reader confusing them.

⇒ It is the same kind of thing as F46's `etc/system`: facts about this installation. **Merge
them into one `$APPBAY_HOME/etc/system.yaml`.** The filename collision goes away with the merge,
`etc/projects/<name>/project.yaml` becomes the only `project.yaml`, and when the project and
environment tiers are eventually built they land where their schemas already say they live.
Nothing needs *moving* at those two levels, because there is nothing there.
Evidence: `raw/probe-77-two-files-named-project-yaml-and-the-instance-one-is-outside-etc.yaml`


**F48 — there is no scope chain. One variable resolves at compile time, and the only working overlay is Compose's own.**
`project.ts:9` states *"the canonical resolution order: service > environment > project."*
Nothing implements it. `ScopeResolver.resolveRef` requires an **explicit** scope in the
reference and consults exactly that one map (`scope-resolver.ts:113-114`, and again at
`:150-151`); a miss is an error, never a fallback to the next scope.

What the resolver is fed (`compile.ts:417-421`):

| scope | contents | source |
|---|---|---|
| `project` | `{ DOMAIN }` — one key | `loadProjectVars` regexes one `domain:` line out of `$APPBAY_HOME/project.yaml` and returns nothing else |
| `environment` | `{}` | hardcoded; no caller ever passes it |
| `service` | `{}` | hardcoded literal |

So `${{project.DOMAIN}}` is the only reference in the whole vocabulary that can resolve. Every
other `${{...}}` is a compile error whose suggestion (`compile.ts:435`, `:517`) reads *"Define
the variable in project.yaml or environment.yaml, or use `--project-vars` / `--env-vars`
flags"* — naming two files nothing reads (F47) and two flags that do not exist: **0** commander
options match either name. `catalog-service.ts:484` is a second, separate implementation of the
same syntax, project-scope only, used when writing `.env.local`.

**The overlay that works is at the app level and is Docker Compose's, not appbay's.**
`upstream-transform.ts:216-220` injects `env_file: [<app>/.env, <app>/.env.local]`, both
`required: false`, and relies on Compose's later-wins rule. `config-service.ts:147-150` mirrors
the same merge for reads so `appbay config` can show which values are overridden. That is the
entire live overlay: **upstream defaults, then local overrides, one level.**

**Neither enumerated nor inferred.** Nothing joins `"projects"` (0 matches) or `"environments"`
(0) into a path, so the set of available projects and environments is not defined by a registry
file *and* not discovered from the directory tree — the question has no answer yet because the
tier does not exist.

⇒ For the RFC: infer both sets from `readdir`, not from a registry. A list of available
projects in a file is a second source of truth beside the directories that hold them, and this
repo has already been bitten twice by exactly that shape — §2's `var/lib/secrets/backend`
mirror (F45) and the two files named `project.yaml` (F47). `etc/projects/<name>/project.yaml`
then holds only what a directory listing cannot tell you — `vars` and `defaults`, which is
already what `ProjectConfigSchema` says — and the environment file stays
`environments/<env>.yaml`, keyed by filename, not a single `env.yaml`. The scope chain has to
be written either way; the docblock has been describing it as though it exists.
Evidence: `raw/probe-78-the-only-working-env-overlay-is-env-then-env-local.yaml`


**F49 — the app directory name already namespaces a second instance. Only the hostname does not, and the fix is two small changes.**
Copying one catalog entry into `etc/apps` under two names, giving each its own `.env.local`,
and compiling both:

| identity field | `litellm-sim` | `litellm-prod` | separates? |
|---|---|---|---|
| container names | `appbay.litellm-sim.litellm` | `appbay.litellm-prod.litellm` | ✅ `upstream-transform.ts:153` |
| internal network | `litellm-sim_internal` | `litellm-prod_internal` | ✅ `upstream-transform.ts:260` |
| volumes | `litellm-sim_litellm-db` | `litellm-prod_litellm-db` | ✅ Compose prefixes by project |
| aux edge config | `<appName>.caddy` | `<appName>.caddy` | ✅ `caddyAuxPath` |
| `appbay_shared` | shared | shared | **by design** — the edge network both attach to |
| **ingress host** | `litellm.${{project.DOMAIN}}` | `litellm.${{project.DOMAIN}}` | ❌ **identical** |

`ingress.ts:68` takes `props.host` as a literal from `appbay.yaml`, and `DOMAIN` is one value
per `$APPBAY_HOME` (F48). So two instances in one home claim the same hostname and fight at the
edge. Everything else is already keyed on the directory name.

**What does not work today**

| approach | |
|---|---|
| two hosts, one home each | ✅ works now — this is what `llm-stack` does; `group_vars` supplies the difference |
| two app dirs, one home | ✅ except the hostname, which must be hand-edited in each copied `appbay.yaml` |
| two homes, one host | ❌ container names carry no home component, so they collide; and one edge owns `:80`/`:443` |

**The quick fix is two changes, both small.**

1. **`appbay install <entry> --as <name>`.** `catalogInstall` (`catalog-service.ts:92-94`) uses
   one `name` for both the catalog lookup and `targetDir = join(appsDir, name)`. Splitting
   them is a parameter and one line; everything in the table above then separates on its own.
2. **An `app` scope in the resolver**, so `host: "${{app.NAME}}.${{project.DOMAIN}}"` works.
   `ScopeValues` is three `Record<string,string>` fields and `VALID_SCOPES` is a three-element
   const (`scope-resolver.ts:19-23`, `:50`); `appName` is already in scope where the resolver
   is built (`compile.ts:555`). Adding a fourth entry is smaller than the `environment` tier
   F48 says is still unbuilt, and it is the piece that makes instancing work.

⇒ This is the operator's own reading confirmed: the deployed runtime already lives in its own
directory, and the render is already per-app. Instancing did not need a new concept — it needed
the one identity field that was still a literal to become a reference.
Evidence: `raw/probe-79-app-dir-name-already-namespaces-a-second-instance.yaml`


**F50 — chaining scopes in `appbay.yaml` already works. What is missing is the loader that would give two apps different values.**
`appbay.yaml` is the right place, and no resolver work is needed. `compile.ts:508` runs the
**same** `ScopeResolver` over each trait object that `:427` runs over compose — which is how the
existing `host: "litellm.${{project.DOMAIN}}"` resolves at all — and `resolve()` replaces with a
**global** regex (`scope-resolver.ts:64`), so several references in one string all resolve and
scopes may be mixed.

Measured, resolver alone:

| template | resolves to |
|---|---|
| `litellm.${{project.DOMAIN}}` | `litellm.example.org` |
| `litellm.${{environment.TIER}}.${{project.DOMAIN}}` | `litellm.sim.example.org` |
| `${{environment.TIER}}-litellm.${{environment.TIER}}.${{project.DOMAIN}}` | `sim-litellm.sim.example.org` |
| `litellm.${{env.TIER}}.${{project.DOMAIN}}` | ⚠️ left literal — *Unknown scope "env"* |

⚠️ **The scope is spelled `environment`.** `VALID_SCOPES` is `["service", "environment", "project"]`
(`scope-resolver.ts:50`), so `${{env.X}}` records a scope error and the literal survives the
render — but it FAILS SAFE: `deploy-service.ts:707-715` skips any app with a compile error and
marks it failed, with the message *"not deployed: its configuration did not compile … Deploying
it would start a container that cannot serve its declared routes."* A misspelled scope costs a
failed app, never a live vhost with `${{env.TIER}}` in its name.

End to end through `compile()` with **one** app directory, changing only `environmentVars`, the
rendered Caddy aux file carried `litellm.sim.example.org {` and `litellm.prod.example.org {`,
zero compile errors. So the whole chain works today and nothing populates it.

**Two apps in two different projects: the field exists, the wiring stops one step short.**
`appbay.yaml` carries `project:` and `environment:` (`appbay-yaml.ts:19-20`), and `compile.ts:380-381`
already resolves them per app — `appProject = config?.project ?? defaultProject`. But those two
values are used only for the trait context and the generated-values store key. Forty lines later
the resolver is built with the **run-level** maps:

```ts
const scopeResolver = new ScopeResolver({          // compile.ts:420
  project: projectVars,                            // one map for every app in the run
  environment: environmentVars,                    // always {}
  service: {},
});
```

So two apps declaring different `project:` values still resolve `${{project.DOMAIN}}` to the same
string. The change is one step: feed `varsForProject(appProject)` and
`varsForEnvironment(appProject, appEnvironment)` instead, backed by a loader for
`etc/projects/<project>/project.yaml` and `.../environments/<env>.yaml` — the tier F47 and F48
show has zero readers. `appProject` and `appEnvironment` are already in scope at that point.

**But no scope axis fixes identity.** Container names are `appbay.<appDir>.<service>`
(`upstream-transform.ts:153`), networks `<appDir>_internal`, the edge fragment `<appDir>.caddy`.
Neither `project:` nor `environment:` appears in any of them. Two instances in one home therefore
still need two directories — F49's `--as` — *or* container naming has to take the project and
environment. Splitting the two concerns plainly:

| concern | fixed by |
|---|---|
| **identity** — container, network, volume, aux filename | the app directory name (`--as`), or adding project/env to `upstream-transform.ts:153` |
| **values** — hostname, env vars | the project/environment loader; the resolver is already done |

⇒ The operator's `litellm.${{environment.TIER}}.${{project.DOMAIN}}` is the right shape and needs
no new syntax. It needs someone to load the file that supplies `TIER`.
Evidence: `raw/probe-80-chained-multi-scope-ingress-host-already-resolves-in-appbay-yaml.yaml`


**F51 — the word lands on three surfaces. One cannot move, one is free to rename, one should be deleted. And the manifest silently shadows the invocation.**

| surface | where | occurrences | do what |
|---|---|---|---|
| **Compose's `environment:`** — a service's env vars | `docker-compose.yml`, and inside `appbay.yaml` because `overrides` (`appbay-yaml.ts:370`) and `overlays[].services` (`:93`) are free-form compose records | **93** in upstream `appbay.yaml` files | **cannot rename** — it is Compose's spec |
| **the scope name** in `${{environment.KEY}}` | `VALID_SCOPES` (`scope-resolver.ts:50`) | **0** across both catalogs | **rename freely** — costs nothing today |
| **the tier fields** `project:` / `environment:` | `appbay-yaml.ts:19-20`, `:361-362` | **150** manifests, every one `default` | **delete, don't rename** — zero information |

So both meanings do coexist inside one `appbay.yaml`: a top-level `environment: default` and, ten
lines down in an overlay, a service's `environment:` list. That is the collision, and only
appbay's half can move.

🚨 **A live defect underneath it.** `compile.ts:380-381`:

```ts
const appProject     = config?.project ?? defaultProject;
const appEnvironment = config?.environment ?? defaultEnvironment;
```

The fields are `z.string().default("default")`, so after parsing they are **never undefined**.
`config?.environment ?? defaultEnvironment` therefore always yields `config.environment` whenever
an `appbay.yaml` exists — which is always. **The `project` and `environment` values passed into
`compile()` are unreachable.** A future `appbay up --environment sim` would be silently ignored
by all 150 manifests, because each one declares `environment: default` and wins.

⇒ **A tier is not a property of the app manifest.** The same catalog entry must deploy to sim and
to prod; `environment: sim` in `appbay.yaml` bakes the tier into the app definition, which is
backwards for the two-stacks-one-code case. The tier belongs to the invocation, or to the
installed instance, never to the catalog entry. Fixing the precedence — invocation wins, manifest
is the fallback — is the same edit as fixing the shadowing.

⇒ **Sequence matters.** Rename the scope now, while it has zero users; drop the two boilerplate
fields now, while they carry nothing. Build the loader (F50) afterwards. Doing it in the other
order means migrating `etc/projects/*/environments/*.yaml` files and every manifest that has by
then started using `${{environment.X}}`.
Evidence: `raw/probe-81-the-tier-fields-are-boilerplate-and-shadow-the-invocation.yaml`


**F52 — SUPERSEDES F51's rename recommendation. Keep `environment`. The rest of F51 stands.**
F51 recommended renaming appbay's `environment` keyword because the word also names Compose's
per-service env var map. Withdrawn:

- `environment` is the standard name for a deployment target — Kubernetes, Terraform, Rails and
  every CI system use it for this concept. A non-standard name costs every future reader more
  than the collision does.
- The collision is weak in practice. Compose's `environment:` only ever appears **nested inside a
  compose fragment** — `overrides.<service>` or `overlays[].services.<service>` — where the author
  already knows they are writing Compose. The two differ in nesting depth and in shape: appbay's
  is a top-level string, Compose's is a nested list or map.
- `tier` and `stage` are both worse. `tier` reads as a ranking and collides with n-tier
  architecture; `stage` collides with Docker build stages and implies a pipeline order that these
  peers do not have.

**What F51 established still holds**, and none of it depended on the rename: the three surfaces
and their counts (93 Compose-side, 0 scope uses, 150 boilerplate fields), the finding that the
fields carry no information and should be dropped rather than kept, and the defect below.

🚨 **The live defect is the part that matters.** `compile.ts:380-381` reads
`config?.environment ?? defaultEnvironment` against a field declared
`z.string().default("default")`. After Zod parsing the field is never undefined, so `??` never
fires and the value passed into `compile()` is discarded. `appbay up --environment sim` will be
silently ignored by all 150 manifests until that line takes the invocation first.
Evidence: `raw/probe-81-the-tier-fields-are-boilerplate-and-shadow-the-invocation.yaml`, F51


**F53 — collapsing `project` + `environment` into one `namespace` is small, migrates nothing, and is the change that makes two-stacks-one-code work. One fork remains.**

`ScopeSchema` (`appbay-yaml.ts:18-25`) already mixes four unrelated axes, and two of them are the
k8s model the operator reached for:

| axis | fields |
|---|---|
| **namespace** | `project`, `environment` |
| **selector** | `collection`, `tags` — labels and selectors, already present |
| placement | `operator` |
| connectivity | `shared_network` |

**Five surfaces, and no data behind any of them.**

| surface | sites |
|---|---|
| field declarations | `appbay-yaml.ts:19-20`, `:361-362` |
| pair-keyed compile sites | `compile.ts:370-371`, `:380-381`, `:446-447`, `:555-556`, `:976` |
| generated-values key | `generated-values.ts:72`, `:131`; `state.ts:27-28`, `:75-76` |
| resolver vocabulary | `scope-resolver.ts:20-22`, `:50` |
| **identity — where a namespace would newly have to appear** | `upstream-transform.ts:153` (container), `:260` (network), `ingress.ts:147`/`:161` (aux filename) |

Migration cost is nil: `generated-values.yaml` on the sim is `values: []` (probe-66), and all 150
manifests read `default`/`default` (F51). This is a text edit, not a data migration — which is
the argument for doing it before the tier is built, not after.

**The keystone is one word.** `z.string().default("default")` → `z.string().optional()`. That is
what makes *absence* expressible, and it makes the existing `config?.namespace ?? defaultNamespace`
at `compile.ts:380-381` correct as written rather than dead (F51). Declared in `appbay.yaml` means
pinned; absent means decided at deploy time. No new precedence machinery.

**Why this beats F49's `--as` and F50's loader — it subsumes both.** Put the namespace into
`container_name`, the internal network and the aux filename and two instances of one app in one
home stop colliding without a second app directory. Namespace then fixes **identity and values
together**, which is what neither `project:` nor `environment:` does today.

🚨 **The one open fork: flat or hierarchical.** Two namespaces that differ only by tier want to
share most of their values. Flat names cannot inherit.

| | |
|---|---|
| **flat** (`namespace: uom-sim`), true k8s | Shared values do not live in a parent namespace — they live one level up, in `etc/system.yaml`, which already holds `domain` (F47). Only per-namespace deltas go in the namespace file. Layering comes from *which value files you compose*, the way `-f values.yaml` does — not from the name. |
| **hierarchical** (`namespace: uom/sim`) | Keeps inheritance in the name, and matches `vault://`, which F41 proved is already arbitrary-depth with last-segment-is-key. One path idea across both. Cost: reintroduces "which level did this value come from", the question the four-layer scheme already makes hard to answer. |

⇒ Recommend **flat**, because `domain` is already instance-level so the main shared value needs no
parent, and because the operator's own reference — *"in k8s case, even another file"* — is
composition of value files, not hierarchy of names.
Evidence: `raw/probe-82-namespace-collapse-touches-five-places-and-migrates-no-data.yaml`


**F54 — `namespace: uom.sim`, flat and dotted, is decided. The dot is safe everywhere except DNS, and one parser must change either way.**

Where the namespace string would land, and whether the dot survives:

| lands in | becomes | dot ok? |
|---|---|---|
| container name (`upstream-transform.ts:153`) | `appbay.uom.sim.litellm.litellm` | ✅ Podman allows `.` in names |
| internal network (`:260`) | `uom.sim_litellm_internal` | ✅ a compose network key |
| aux edge file (`ingress.ts:161`) | `uom.sim.litellm.caddy` | ✅ the import is a `*.caddy` glob |
| volume prefix | `uom.sim_litellm_litellm-db` | ✅ |
| **shared-network alias** (`upstream-transform.ts:167`) | `uom.sim_litellm_litellm` | 🚨 **no** |

🚨 **The alias is the one real hazard.** `upstream-transform.ts:167` builds
`alias = ${appName}_${name}`, and that string is the **DNS name other apps dial** —
`ingress.ts:70` and `:195` both construct `http://${appName}_${serviceName}:${port}` from it. In
DNS a dot is not a character, it is the label separator: `uom.sim_litellm_litellm` is two labels,
not one name. ⇒ Normalise the dot to a hyphen wherever the namespace enters a DNS-bearing string.
`uom.sim` in config, `uom-sim` in aliases. Container names, filenames and volume prefixes keep
the dot.

**One parser reads `appbay.*` names, and it breaks — but it had to change anyway.**
`docker.ts:72` is `/^appbay\.([^.]+)/`, which takes the first segment: against
`appbay.uom.sim.litellm.litellm` it yields **`uom`**, so `discoverRunningApps()` would report the
app set as `{uom}` and every `when:` clause would fail, silently, with overlays deactivating and
nothing erroring (F35 limit f). `builds.ts:285` reconstructs the same name to find a build
container and needs the same treatment.

⚠️ But that parser must become namespace-aware whatever the delimiter, because it scans **every**
`appbay.*` container on the host: without a namespace filter, `when: [litellm]` in `uom.sim` would
be satisfied by `uom.prod`'s litellm. So this is a requirement of namespacing, not a cost of the
dot — and it is the same edit either way.

⇒ Work items, smallest first: (1) `z.string().optional()` on the field, (2) namespace-aware
`discoverRunningApps` + `builds.ts:285`, (3) namespace into container name / network / aux
filename, (4) a `dnsSafe(namespace)` helper used at `upstream-transform.ts:167` and both
`ingress.ts` construction sites.
Evidence: `raw/probe-83-a-dotted-namespace-breaks-the-appbay-name-parser.yaml`


**F55 — the Ansible-everything model never went away. It is `site.yml`, it is live, and it is in this repo.**
`ansible/llm-stack` holds **two** deployment models side by side, distinguished only by which
playbook and which host group:

| | playbook | hosts | how containers start |
|---|---|---|---|
| Ansible-everything | `site.yml` | `rddgx001` (DGX Spark) | `templates/compose.yaml.j2` → `tasks/compose.yml` → `community.docker.docker_compose_v2` |
| appbay | `provision-substrate.yml`, `provision-appbay.yml` | `vmhost` (splunkpp-ap-ds1a) | the `appbay` binary |

`site.yml:125` still imports `tasks/compose.yml`; 15 containers, staged by `--tags`, with
`tasks/preflight.yml` asserting every required secret is non-empty before anything renders. Its
own header already states the secret posture: *"compose.yaml carries `${VAR}` REFERENCES ONLY
(0644, reviewable); values land in a sibling .env at 0600."*

⇒ Retargeting that model at `vmhost` is a change of inventory group and a rewrite of the
container graph in `compose.yaml.j2` — not a new codebase.

**F56 — `docker compose --env-file` cannot take a secret that never touches disk. The process environment can.**
Measured against compose 5.1.2:

| route | result |
|---|---|
| `--env-file <(printf 'SECRET=…')` | 🚨 **silently empty** |
| `--env-file <FIFO>` | 🚨 **silently empty** |
| `--env-file /dev/stdin` | 🚨 **silently empty** |
| `--env-file <real file>` | ✅ resolves |
| **`SECRET=… docker compose config`, no file present** | ✅ **resolves** |
| exported variable, the shape an ansible `environment:` block produces | ✅ resolves |
| `.env` and process env both set | **process env wins** |
| bare `- SECRET` under a service's `environment:` | ✅ passes through by name |

The three failing routes emit only *"The SECRET variable is not set. Defaulting to a blank
string"* and leave the exit status unchanged. A deployment built on process substitution would
start every container with blank credentials and report success — the same class of silent
failure as F51's shadowed field.

⇒ **The workable shape is: compose file at 0644 carrying `${VAR}` references only, values passed
through the ansible task's `environment:`, and no `.env` with real values written at all.** That
is strictly better than `site.yml` today, which writes them to a 0600 sibling. It is also what
appbay already does — `docker.ts`'s `dockerCompose(args, path, extraEnv)` carries the comment
*"these exist only in the process env chain and never touch disk."*

⚠️ Not zero exposure: the values sit in the compose client's `/proc/<pid>/environ`, readable by
the same user and root. That is materially better than argv, which is world-readable (F36), and
it does not persist — but it is not a secure enclave and should not be described as one.
Evidence: `raw/probe-84-compose-takes-an-env-file-that-never-touches-disk.yaml`,
`raw/probe-85-compose-interpolates-from-the-process-environment.yaml`


**F57 — `ks` and `kstack` already exist, and `ks` is already right about the thing appbay gets wrong six times.**
`~/Dropbox/Dev/dsx_dev_runstack/`, dated 2025-07-29. The scheme is **`kp://`**, not `ks://` —
which is why searching for `ks://` finds nothing.

**`ks`** — 525 lines, *"KStack Secrets CLI … Modeled after `op run --` and `op read`"*. Verbs:
`run`, `read`, `ls`, `add`, `db:create`.

| | |
|---|---|
| **read path — already correct** | `ks:181`, `:251`, `:302` pipe the master through a bash **builtin** `echo` into `keepassxc-cli`'s stdin. No process carries it in argv, and no composed string reaches `sh -c`. This is precisely the pattern appbay violates at `keepass.ts:151` and five sites in `vault-service.ts` (F36) |
| **run path — the F56 shape** | `ks:343-374`: resolve `kp://` refs, `export`, exec the command. Values live in the process environment and are never written back to a file — what probe-85 proved `docker compose` accepts |
| 🚨 **one real leak** | `add_secret` takes `--password=<value>` (`ks:199`), putting the stored secret in **`ks`'s own argv**, visible in `ps`. The inner `keepassxc-cli` call at `:257` is correct — both values go to stdin. Fix by reading the value from stdin, the same change `appbay secrets set` already made |

**`kstack`** — the stack manager beside it: `deploy`/`stop`/`logs`/`status`/`clean`, plus
`secrets_init|add|read|ls`, `create_network`, `copy_stack_files`, `set_environment`,
`load_and_resolve_environment`. Laid out as `etc/sys.env` + `stacks/` + `var/run/` + `var/data/`.

⚠️ **That layout is the one F45 and F47 arrived at independently for appbay** — an `etc/`
holding a single system file, a `var/` holding runtime state. The operator built this shape once
already and then met it again from the other direction.

⇒ The Ansible-native path is not a build; it is **an integration plus one bug fix**. What is
missing: keepass-web or KeeWeb mounted over the same `.kdbx` so humans get a browser (one store,
two readers); an Ansible layer that renders the llm-stack container graph into
`stacks/<name>/docker-compose.yml`; and a decision on the driver split below.

**The driver question worth settling early.** `community.docker.docker_compose_v2` and
`ks run -- docker compose up -d` are two different drivers and only one can own idempotency.
Recommended: **Ansible resolves `kp://` refs itself** — via `ks read` — into task variables and
hands them to `docker_compose_v2`'s `environment:`. That keeps Ansible's change detection *and*
writes no file (F56). `ks run --` stays as the human's manual escape hatch, not the deploy path.
Evidence: `raw/probe-86-ks-and-kstack-are-the-ansible-native-design-already-built.yaml`

