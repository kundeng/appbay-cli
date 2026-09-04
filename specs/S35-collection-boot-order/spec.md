---
spec_id: S35-collection-boot-order
status: DRAFT
closed_as: null
since: 2026-09-01
until: null
epic: platform
features: [collection-registry, dependency-ordered-deploy, readiness-gating]
supersedes: []
superseded_by: null
depends_on: [S34-service-account-runtime-access]
anchors: [data-architecture]
---

# S35: declared start order among collections

<!-- DRAFT. The requested feature is a `collections.yaml` that declares which collection starts
     after which. The measured obstacle is NOT the file — it is that appbay has no notion of an
     app being READY, so any ordering it expresses is weaker than the one an operator would read
     into it. One owner decision (§1.4) gates the schema. -->

# 1 · Requirements

## Introduction

**The ask:** let an operator write a `collections.yaml` declaring startup-order dependencies
among collections — `ai-stack` starts after `data-layer`.

**What the code can support today, measured.** Three layers stand between the request and a
working feature, and only the first is close.

### 1. A collection is a string. There is no collection object anywhere.

```ts packages/core/src/schemas/appbay-yaml.ts:60
  collection: z.array(z.string()).optional(),
```

Membership is a **label on each app**, resolved by scanning every manifest:

```ts packages/core/src/services/deploy-service.ts:345
export async function filterByCollection(
  appsDir: string,
  collectionName: string,
): Promise<string[]> {
  const discovered = await discoverApps({ appsDir });
  return discovered
    .filter((app) => app.appbayConfig?.collection?.includes(collectionName))
    .map((app) => app.name);
}
```

A collection has no registry, no file, no identity, and no attributes — it exists only as the
set of apps that happen to mention the same string. `appbay up --collection X`
(`apps/cli/src/commands/up.ts:29`) is its only consumer. **So `collections.yaml` would be the
first place a collection exists as a thing rather than a string**, and that is a genuine
addition to the data model, not a config file for an existing one.

### 2. The ordering machinery is a hardcoded two-element array.

```ts packages/core/src/boot-order.ts:22
export const SYSTEM_APP_BOOT_ORDER = [
  "traefik",
  "caddy",
] as const;
```

That is the entire model: **system-vs-user**, with two named system apps in fixed positions.
`sortByDeployOrder` (`boot-order.ts:81`) is a two-pass partition — system apps in list order,
then everything else in input order. User apps therefore deploy **alphabetically**, because
`discover.ts:137` sorts by name for determinism:

```ts packages/core/src/compiler/discover.ts:137
  apps.sort((a, b) => a.name.localeCompare(b.name));
```

There is no graph, no topological sort, and no cycle detection anywhere in the tree. Declared
dependencies replace this with a real toposort, and `down.ts:80` needs the reverse of it —
today shutdown gets its reverse ordering by calling `partitionByBootOrder` and reversing the
two-element system list.

### 3. 🚨 The blocker: "ordered" today means STARTED BEFORE, not READY BEFORE.

The deploy loop (`deploy-service.ts:699`–`833`) does exactly two things per app:

```ts packages/core/src/services/deploy-service.ts:816
      const dcResult = runDockerCompose(["up", "-d"], composePath, secretEnv);
      // `up -d` succeeding means "started", not "still running" — see findCrashedServices.
      const crashed = dcResult.exitCode === 0
        ? findCrashedServices(runDockerCompose, composePath, secretEnv)
        : null;
```

`findCrashedServices` catches containers that **exited immediately**. Nothing waits for an app
to be serving. `grep -n health packages/core/src/services/deploy-service.ts` returns three
comments and zero code.

**Which makes the two claims in `boot-order.ts` false:**

| line | claims | actual |
|---|---|---|
| `boot-order.ts:11` | "user apps following after all system apps are **healthy**" | after their `up -d` returned |
| `boot-order.ts:20` | "each app may depend on the ones above it being **healthy**" | no health is ever observed |

So a `collections.yaml` declaring "`ai-stack` after `data-layer`" would deliver:
*`data-layer`'s `compose up -d` returned before `ai-stack`'s was issued.* For a Postgres running
initdb, or an LLM server loading weights, that is **nearly no guarantee at all** — and it is the
opposite of what the declaration would be read to mean.

⚠️ **This is RFC-001's recurring bug class, one layer up.** `up -d` exit 0 answers *"did compose
accept the request"*, not *"is the app serving"*. Shipping the declaration on top of that gap
does not merely inherit it — it makes it worse, because a declaration converts an unstated
assumption into a **documented promise** that is still false. The RFC's other instances of this
(`?? 0` on a failed query, `[UNCHANGED]` about the artifact rather than the deployment,
`up -d` exit 0 vs. the container staying up) were all found the same way: the check answered a
different question than the one asked, and reported the reassuring answer.

⇒ **Readiness gating is not an enhancement to this feature. It is the feature.** The YAML is
perhaps 80 lines including the toposort; the readiness probe, its timeout policy, and what
happens to dependents when a dependency never becomes ready are the whole of the work.

### 1.4 🚦 The owner decision that gates the schema

`collection` is **multi-valued** — `z.array(z.string())`. `docs/guide/apps.qmd:61` documents
`collection: [ai-stack, gpu-apps]` as the normal case. So an app can inherit a position from
more than one collection, and **collection-level edges do not necessarily project down to a DAG
over apps**:

```
collections.yaml:  ai-stack  after  data-layer

app "vectordb":    collection: [data-layer, ai-stack]     ← in BOTH
```

`vectordb` must now start both before and after itself. This is not an edge case to handle at
implementation time; it decides what the file is allowed to say. Three defensible answers:

| | rule | cost |
|---|---|---|
| **A. Order over collections, reject overlap** | an app in two ordered collections is a manifest error | simple and total; breaks the documented multi-membership idiom |
| **B. Order over collections, apps resolve to earliest** | `vectordb` takes its earliest position; edges that would invert are dropped with a warning | nothing breaks, but the declared order is silently not the executed one |
| **C. Order over apps, collections are only a naming shorthand** | `collections.yaml` expands to app-level edges, toposorted, cycles are a hard error | says what it means; a cycle report names apps the operator never wrote down |

Not decidable from the code. **C is the recommendation** — it is the only one where the declared
order and the executed order are the same object, and B's "silently not what you wrote" is the
failure mode this whole spec exists to avoid.

## Requirements

### Requirement 1: a declared order is the order that actually happens

1.1 WHEN `collections.yaml` declares that collection B starts after collection A, THE deploy
    SHALL start no app of B until every app of A is **ready**, per Requirement 2.
1.2 WHERE the declaration cannot be honoured (a cycle, an unknown collection, an app in two
    collections whose orders conflict), THE deploy SHALL fail loudly BEFORE starting anything,
    naming the specific apps or collections involved.
1.3 THE ordering SHALL NOT silently degrade to a weaker one. No warn-and-continue path may
    produce a run whose executed order differs from the declared order.

### Requirement 2: "ready" is defined, observed, and bounded

2.1 THE deploy SHALL determine readiness by an observation of the running app, not by the exit
    code of `compose up -d`.
2.2 WHERE an app declares no readiness signal, THE spec SHALL define what readiness means for it
    and say so in the operator-facing docs — an undefined default that resolves to "started" is
    Requirement 1.3's failure wearing a different hat.
2.3 THE wait SHALL be bounded, and a timeout SHALL be a deploy failure for that app and a
    **skip-with-reason** for its dependents, never a silent proceed.

### Requirement 3: shutdown reverses the same graph

3.1 `appbay down` SHALL stop in the reverse of the executed start order, derived from the same
    graph rather than from a second hand-maintained list. (`down.ts:74` records that the previous
    hand-derived reversal was the exact opposite of what its comment claimed, latent only because
    one ingress provider is installed at a time.)

### Requirement 4: the two false comments stop being false

4.1 `boot-order.ts:11` and `boot-order.ts:20` SHALL either describe what the code does, or
    describe what it does after this sprint. They currently promise health gating that has never
    existed.

## Out of Scope

- Ordering *within* an app. Compose's own service-level `depends_on` already handles that and is
  passed through untouched (`upstream-transform.ts:88`).
- Restart/redeploy ordering for a single app. This is about batch runs — `up --all`,
  `up --collection`, `init`, and the systemd unit's `server start`.
- Any change to how collection **membership** is declared. `collection:` on the app stays the
  source of membership; `collections.yaml` adds only relationships between collections.

---

# 2 · Design

To be written at activation, once §1.4 is decided. The shape is constrained already:

- **A new reader** beside `catalog-service`/`config-service` that loads `etc/collections.yaml`
  and returns edges. Absent file = today's behaviour exactly, byte for byte.
- **`boot-order.ts` becomes a graph module.** `SYSTEM_APP_BOOT_ORDER` survives as seed edges
  (`caddy`/`traefik` before everything), not as the model. `sortByDeployOrder` keeps its
  signature and gains a toposort behind it, so `deploy-service.ts:680` and `down.ts:80` do not
  move.
- **A readiness probe** in the deploy loop between `findCrashedServices` and
  `installCaddyConfig`. This is the part with no existing code to extend and the part that
  decides whether the feature is real.

# 3 · Tasks

<!-- [ ] pending | [x] done | [!] BLOCKED: reason | [-] DROPPED: <reason> | [>] → <spec_id> -->

- [ ] 1. Decide the granularity
  - [ ] 1.1 Owner picks A, B or C from §1.4 — collection-level with overlap rejected,
        collection-level with earliest-wins, or expand-to-app-level.
    - **Requirements**: 1.2 · Recommendation: C, argued in §1.4.
- [ ] 2. Readiness, before any ordering work
  - [ ] 2.1 Define what "ready" means, including for an app that declares nothing
    - **Requirements**: 2.1, 2.2 · **Pillar**: Design
  - [ ] 2.2 Implement the bounded wait in the deploy loop; timeout fails the app and skips
        dependents with a named reason
    - **Depends**: 2.1 · **Requirements**: 2.1, 2.3 · **Pillar**: MVP, Test
  - [ ] 2.3 Correct `boot-order.ts:11` and `:20`
    - **Depends**: 2.2 · **Requirements**: 4.1 · **Pillar**: Docs
- [ ] 3. The graph
  - [ ] 3.1 `etc/collections.yaml` schema + reader; absent file is a byte-for-byte no-op
    - **Depends**: 1.1 · **Requirements**: 1.1 · **Pillar**: MVP
  - [ ] 3.2 Toposort behind `sortByDeployOrder`, seeded by `SYSTEM_APP_BOOT_ORDER`; cycles and
        unknown names fail before anything starts
    - **Depends**: 3.1 · **Requirements**: 1.1, 1.2, 1.3 · **Pillar**: MVP, Test
  - [ ] 3.3 `down` reverses the same graph rather than a second list
    - **Depends**: 3.2 · **Requirements**: 3.1 · **Pillar**: MVP, Test
- [ ] 4. Prove it on a host where the order matters
  - [ ] 4.1 A dependency with a slow start (initdb, or an image that loads on boot), verifying
        the dependent does not start until the dependency SERVES — the case `up -d` ordering
        gets wrong and the whole sprint exists to fix
    - **Depends**: 2.2, 3.2 · **Requirements**: 1.1, 2.1 · **Pillar**: Test
  - [ ] 4.2 Document the file where collections are described (`docs/guide/concepts.qmd:243`
        currently says collections are "purely a selection mechanism" — this changes that)
    - **Depends**: 3.2 · **Requirements**: 2.2 · **Pillar**: Docs
