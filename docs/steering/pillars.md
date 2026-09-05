# Pillars

The dimensions this repo is healthy or unhealthy on. A sprint advances at least one.
Current state is what a review measured most recently; it is restated, not linked,
so this page does not depend on a review date.

| pillar | what it means | healthy when |
|---|---|---|
| **Correct** | the CLI reports what it observed, on both runtimes | every mutating path checks the runtime after acting; a deploy journey passes on Docker and Podman; the edge is found by its generated name or label, never a literal |
| **Legible** | one fact, one owner; comments carry invariants, not history | no behaviour has two implementations; runtime observation lives in the runtime adapter and nowhere else; no comment narrates a past fix |
| **Verified** | a test that names a behaviour runs it | no test asserts only that a mock was called; a test compiles a system app and asks the deploy path which container it targets; `doctor --json` cannot be `ok` over an unknown |
| **Harvested** | the rewrite carries every lesson paid for here | each seam finding has a lesson in the rewrite's design record; the rewrite's arch test enforces the ownership rules this repo learned by hand |
| **Documented** | docs describe the code as it is | `docs/README.md` names only directories that exist; every path and symbol a doc names resolves; `README.md` quick start runs |

## Current state

Measured on the first seam review, before any fix:

- **Correct:** failing. The deploy path targets an edge container name that the
  namespace change renamed; every ingress app has reported started-but-unrouted since.
  Nine container-start sites, two observe afterwards.
- **Legible:** failing. Three copies of the command wrapper, five home resolvers, three
  `.env` parsers, two doctors, 348 fix-narrative comment blocks.
- **Verified:** partial. 95 test files; four assert only a mock call; no deploy journey
  has run since the namespace change.
- **Harvested:** partial. The rewrite's design record carries eight lessons; five more
  are proposed from the seam review.
- **Documented:** partial. The docs map names four directories that do not exist.
