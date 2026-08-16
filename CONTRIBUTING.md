# Contributing to Appbay

Thanks for considering a contribution.

## Getting set up

```bash
git clone https://github.com/kundeng/appbay-cli.git
cd appbay-cli
pnpm install
pnpm turbo build
pnpm turbo test
```

**Bun is required.** The CLI compiles to a single binary with `bun build --compile`, and the
sources use `.js` specifiers for `.ts` files, so Node cannot run them directly.

```bash
./apps/cli/dist/appbay doctor    # the binary you just built
```

## What this repository contains

The Appbay CLI and its compiler: `packages/core` (compiler pipeline, schemas, traits,
secret resolution), `packages/db` (SQLite cache), `apps/cli` (the binary), and
`system-apps/` (bundled app definitions).

The web control plane is a separate component, distributed as a container image
(`ghcr.io/kundeng/appbay-server`) and started with `appbay server start`. It is not built
from this repository, so `make dev` and `make docker` will tell you so rather than fail
obscurely.

## Making a change

1. **Open an issue first for anything non-trivial.** Appbay is spec-driven; a change that
   cuts against a design decision is better discussed before it is written.
2. Keep the change focused. One concern per pull request.
3. Match the surrounding code — its naming, its comment density, its idioms.
4. `pnpm turbo test` and `pnpm turbo typecheck` must pass.

### Editing `system-apps/`

`packages/core/src/system-apps.ts` is **generated** from the `system-apps/` directory.
Edit the directory, then run the generator:

```bash
pnpm generate:system-apps
pnpm check:system-apps     # fails if the committed output has drifted
```

Hand-editing `system-apps.ts` will be overwritten. A test guards this, because the two
copies silently diverged for two sprints once and it cost the default ingress.

## On tests, and what counts as evidence

Appbay orchestrates Compose, filesystem state, secret vaults and reverse-proxy routing.
Those are integration concerns, and the unit suite is not the primary validation — a green
suite has shipped over an ingress that could not deploy.

So:

- **Fix a bug? Show the failure first.** A test that has never failed has proven nothing.
  When you add a guard, verify it goes red without your fix.
- **Assert the property, not the label.** `exit 0` is not "it worked"; a summary line
  reading `0 error(s)` will match a grep for "error".
- **Suspect the harness before the product.** More than one "defect" here has turned out to
  be the test asserting something the design never promised.

Please say in the PR what you actually ran and what you observed.

## Commit messages

Describe the behaviour that changed and why it mattered, not the diff. If a bug was
invisible for a while, say what hid it — that is usually the more useful half.

Conventional prefixes are used: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, with an
optional scope: `fix(compiler): ...`.

## Sign-off

Contributions are accepted under the Developer Certificate of Origin. Add a `Signed-off-by`
line to each commit, which git will do for you:

```bash
git commit -s -m "fix(compiler): ..."
```

That line certifies you wrote the patch or otherwise have the right to submit it under the
project's license (MIT — see [LICENSE](LICENSE)).

## Reporting security issues

Please do not open a public issue for a security vulnerability. Report it privately to the
maintainer.
