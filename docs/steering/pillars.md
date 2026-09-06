# Pillars

The dimensions this product is healthy or unhealthy on. A sprint advances at least one.
Current state is what a review measured most recently; it is restated, not linked,
so this page does not depend on a review date.

| pillar | what it means | healthy when |
|---|---|---|
| **Correct** | the CLI reports what it observed, on both runtimes | every mutating path checks the runtime after acting; a deploy journey passes on Docker and Podman; the edge is found by its generated name or label, never a literal |
| **Legible** | one fact, one owner; comments carry invariants, not history | no behaviour has two implementations; runtime observation lives in the runtime adapter and nowhere else; no comment narrates a past fix |
| **Verified** | a test that names a behaviour runs it | no test asserts only that a mock was called; a test compiles a system app and asks the deploy path which container it targets; `doctor --json` cannot be `ok` over an unknown |
| **Documented** | docs describe the code as it is | `docs/README.md` names only directories that exist; every path and symbol a doc names resolves; `README.md` quick start runs |
| **Review-ready** | a file can be reviewed in one sitting, and a note lands in one place | no file on the compile, deploy or observe path is longer than a reviewer reads in a turn (about 300 lines); a behaviour has one code path, so a fix has one place to land; each unit states the invariant it holds where it holds it; the brief for a file (why it exists, what it does, who calls it, what to look for) can be written from the file and its tests alone |

## Current state

After the hardening, ownership, verification, boot-order, socket, crash, one-scope and
identity sprints that followed the first seam review:

- **Correct:** the deploy path finds the edge by label, observes the runtime over its API
  socket, waits for readiness in project order, and reports unknown when it could not look.
  Every app carries its identity, with or without an upstream block. Verified on Docker, on
  rootful Podman, and on a RHEL-family Docker service install.
- **Legible:** one loader per file, one home resolver, one observer, one compile entry; the
  arch test enforces the rules with lists that only shrink. Fix-narrative comments are down
  by a third and the moved functions carry invariants.
- **Verified:** command actions run end to end against a scratch home; observation tests run
  against a real unix-socket server; a system app is compiled and its edge target pinned.
- **Documented:** the docs map, the one-scope model, the projects file and the injection
  modes describe the code as it is; the docs checks are green.
- **Review-ready:** the deploy path is the counter-example the pillar was named for: one
  870-line file, the converge written twice, and the verdict kept in fifteen counter sites
  with one decrement. The reconcile restructure of that path is the first work on this pillar.
