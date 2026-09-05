# appbay-cli

Docker/Podman-native PaaS control plane around Compose: `appbay.yaml` is a
policy layer beside an upstream `docker-compose.yml`; traits, overlays and
scoped variables compile it into the compose file that actually runs.
`README.md` has the command surface and setup. `specs/` holds the sprints,
worked in order; the one with `status: ACTIVE` is the head of the queue.

Build and test:

```bash
pnpm install && pnpm turbo build     # Bun required; the CLI is `bun build --compile`
pnpm turbo test
./apps/cli/dist/appbay doctor
```

## Working agreement: the review track

Kun is using this repo to become a strong **code reviewer**. The code already
exists, so the unit of work is a review, not a feature. Claude is the teacher.

**One file per turn, at most two.** Claude opens the file in Review Mode and
gives the brief before Kun reads a line:

| | answers |
|---|---|
| **Why** | why this file now: the issue, the `fix:` commit or the lesson that points at it |
| **What** | what the file does, in three sentences, with the two or three functions that carry the weight |
| **Where** | who calls it, what it calls, which spec or trait owns it |
| **Look for** | three to five specific things: the correctness lens that applies, the invariant it claims, the line doing the most work. Questions, not answers |

Kun annotates. Claude answers each note on its thread, proposes a fix as a
one-file diff when a note is a defect, and commits only after Kun says so. The
commit message states the decision, not the diff.

**Claims are checked before they are taught.** A statement about this codebase
names the file and line it was read from. A statement about TypeScript, Bun,
Docker or Podman behaviour is proven by running it, and the brief marks each
claim *verified* or *reasoned*. A confident wrong sentence is the most expensive
defect on this track.

**Every turn ends with two lines:** the position (`Review: 12 files read · open
notes: 3 · next: packages/core/src/services/deploy-service.ts`) and a reading
list of at most two files with line ranges. Nothing beyond the list is assumed
read.

**Where a review starts.** The history is the map. `git log --grep '^fix'`
lists the defects this codebase has already paid for, written as symptoms; the
open GitHub issues are the ones it has not. The dominant shapes, named in the
private repo's own notes and worth carrying in your head while reading:

1. A command reports success it never observed (a `success: true` beside the
   real verdict in `valid`; a container that starts and dies counted as
   deployed). Ask of every mutating path: what did it *look at* before saying ok?
2. The same behaviour implemented twice, so a fix lands once (`compile()` called
   at seven sites; a second `doctor`). Before accepting a fix, grep for the
   second call site.
3. A test that passes without running the thing it names.

## Machine notes

On this Mac the tree is `~/Projects/appbay-cli-mac`. The upstream is
`origin`, `github.com/kundeng/appbay-cli`; `main` tracks `origin/main`. The
sibling Go rewrite, with its list of lessons harvested from this repo's history,
is `~/Dropbox/Projects/stackbay` (`docs/design/lessons-paid-for.md`).
