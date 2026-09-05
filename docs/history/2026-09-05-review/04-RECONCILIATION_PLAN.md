# Reconciliation plan — 2026-09-05

Where intention (`docs/steering/`), the specs, and the code disagree, grouped by area.
Each row names what the human intends, what the code does, what the spec claims, and the
decision. `APPROVED` rows are executable; `PROPOSED` and `HUMAN DECISION` rows are not until
Kun marks them.

Kun's standing instruction for this run: loop until done, no fake gates. Rows marked
`APPROVED` below are the ones that follow from that instruction and from the seam review he
read; rows marked `HUMAN DECISION` change product behaviour in a way he has not yet chosen.

## Area: deploy and route

| # | intention | code | spec claim | verdict | action | state |
|---|---|---|---|---|---|---|
| R1 | "deployed" means routed on an edge that exists | caddy: execs into a retired name; traefik: writes a file and checks nothing | S32 closed 1.3 as shipped (namespace into identity) without re-running the deploy journey | SPEC IS RIGHT about identity; CODE IS WRONG about the consumer | S36: resolve the edge through identity or label; add the compile-then-target test; run s29 on both VMs | APPROVED |
| R2 | one deploy path | `apply.ts` is a second one | none | CODE IS WRONG | S36: apply delegates to deploy() or is retired | APPROVED |
| R3 | unknown is never a verdict | four null-returning functions; seven passing doctor checks | ledger row 11 | CODE IS WRONG | S36: `Inspection<T>`; three-valued check; ok derives from unknown too | APPROVED |
| R4 | two instances of one app in one home | identity separates; hostname collides | RFC-001 §4 goal; S32 rejected 4.6 | NEITHER: the RFC's goal stands, the spec's rejection stands, and the hostname is unowned | derive the default host from the identity stem (ledger row 10 proposal) | HUMAN DECISION — accept the stem-derived host, or build a value tier |

## Area: runtime boundary

| # | intention | code | spec claim | verdict | action | state |
|---|---|---|---|---|---|---|
| R5 | no `if runtime == podman` and no literal binary (README states it) | 12 literal `docker` calls; 3 hand-written podman branches | none | CODE IS WRONG | S36: `cliContainerBin()` everywhere; branches into RuntimeProfile | APPROVED |
| R6 | one parser per output | two compose-ps parsers, six `ps --format` parsers, three tryExec | none | CODE IS WRONG | S37: runtime/ owns them | APPROVED |
| R7 | observe by socket | everything is a CLI text parse | none | HUMAN DECISION for this repo; DECIDED for stackbay (L5) | write the rule into stackbay's lessons now; this repo keeps the CLI parse behind one owner | HUMAN DECISION for this repo |

## Area: ownership

| # | intention | code | spec claim | verdict | action | state |
|---|---|---|---|---|---|---|
| R8 | one fact, one reader (`structure.md`) | see 03 S3 finding | none | CODE IS WRONG | S37: ownership map, then moves, behaviour-identical | APPROVED |
| R9 | specs anchor a data-architecture doc | none exists | all five specs claim the anchor | SPEC IS WRONG about the anchor's existence | write `docs/design/data-architecture.md` before S37 | APPROVED |
| R10 | comments carry invariants | 348 narrative blocks | none | CODE IS WRONG | S37, as each function moves | APPROVED |

## Area: verification

| # | intention | code | spec claim | verdict | action | state |
|---|---|---|---|---|---|---|
| R11 | a test runs the thing it names | four mock-call tests; no compile-then-target test | journeys README states the standard | CODE IS WRONG | S38: rename or replace; S36 adds the P1 test | APPROVED |
| R12 | both runtimes before done | no VM instances on this Mac; no journey since 2026-08-31 | S33/S34 cite VM runs | CODE UNVERIFIED on Podman | S36 close requires a Podman journey; if no VM can be provisioned, S36 closes FORK-FORWARD with that leftover named | APPROVED, with the wall named |

## Area: docs

| # | intention | code | spec claim | verdict | action | state |
|---|---|---|---|---|---|---|
| R13 | docs map names real directories | `docs/README.md` names `design/`, `dev/` which do not exist | — | DOC IS WRONG | Phase B, this run | APPROVED |
| R14 | `docker.ts` comment on home resolution | stale since e1d2eb9 | — | DOC IS WRONG | S37 | APPROVED |
| R15 | `instance.ts:92` "compose project prefix" | nothing sets one; the project is the app dir (measured) | — | DOC IS WRONG | S36, one line | APPROVED |

## Ordering

S36 hardening (R1, R2, R3, R5, R11 test, R12, R15) → `docs/design/data-architecture.md`
(R9) → S37 ownership (R6, R8, R10, R14) → S38 verification and docs (R11, R13 follow-ups).
R4 and R7 wait for Kun.

## Area: overlays and collections (added after Kun's note during this run)

| # | intention | code | spec claim | verdict | action | state |
|---|---|---|---|---|---|---|
| R16 | `when:` means "declared in the same collection", never "running" | `when:` means "declared anywhere in this home" (`compile.ts:251`); the guide documents that as the design | RFC-001 §5 and S32 3.1 chose installed-in-home over running; neither considered collection scope | NEITHER, now DECIDED by the owner: the definition in `docs/steering/product.md` wins | S35 refine: a collection has members; `when:` evaluates against the app's collections; guide and README follow | APPROVED (definition), SCHEDULE (code) → S35 |
| R17 | a provider switch is safe | `migrateEdge()` unreachable; init prints stop-then-hope (issue #7) | none | CODE IS WRONG | S36: `appbay edge migrate`; init advice repointed | APPROVED |
| R18 | both runtimes on RHEL-family bootstrap | Docker path never completed (issue #8) | S34 closed on Podman evidence | CODE UNVERIFIED | S38 or the next init-system sprint; needs a Fedora/Rocky VM | APPROVED, wall named |
