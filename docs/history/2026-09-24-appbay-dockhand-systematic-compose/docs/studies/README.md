# Study map

**Object of study.** Two products that both take a `docker-compose.yml` and run it:
AppBay (`appbay-cli-mac@9f00b579`, with `appbay-mac@d8f557bc` for the web surface) and
Dockhand (`99dc1044`). The question is not which has more features but whether AppBay's
stated purpose — deployment concerns declared once and compiled in, rather than layered on
as an overlay — is delivered by working code.

## Glossary

| term | meaning here |
|---|---|
| **trait** | a declaration in `appbay.yaml` that a compiler stage turns into compose changes and/or auxiliary files: `ingress`, `auth`, `gpu`, `secrets`, `scoped-env`, `hooks`, `backup` |
| **auxiliary file** | compiler output that is *not* the compose file — an edge route or an authorization policy. The product's distinguishing output |
| **overlay** | in AppBay, a conditional compose fragment selected by a `when:` clause. Distinct from *overlay model* below |
| **overlay model** | the general question of deliverable 2: does a tool systematically add deployment concerns to a compose file it did not author? |
| **edge** | the reverse proxy fronting every app on one install: Traefik or Caddy, installation-level |
| **stack** | Dockhand's unit — a compose file plus its `.env`, deployed to one environment |
| **environment** (Dockhand) | one Docker host: a row carrying connection type, address and credentials |

## Analysis roles used

**Result** answers the named question for the named population. **Contrast** is a
deterministic comparison (the two spellings of `environment:`, the two deploy paths).
**Check** validates an instrument rather than answering the question — the mutation test of
the docs checker, and the test-suite run.

## Threads, in dependency order

1. **[compiler-mechanism.md](compiler-mechanism.md)** — what the trait compiler actually
   does to an untailored Compose file. Everything else depends on this being established
   first: the comparison is meaningless until the mechanism is traced end to end.
2. **[dockhand-overlay.md](dockhand-overlay.md)** — whether Dockhand does anything
   comparable, answered from call shape. Depends on (1) for what "comparable" means.
3. **[implementation-maturity.md](implementation-maturity.md)** — where the compiler's
   implementation does not match its design. Depends on (1).
4. **[exposure-and-presentation.md](exposure-and-presentation.md)** — what a user can find
   and script. Independent of (1)–(3); re-measures the prior review's claims.
5. **[dockhand-leads.md](dockhand-leads.md)** — where Dockhand goes further, and by what
   mechanism. Depends on (2) to avoid reading as a feature scorecard.

<!-- generated: facts -->
| hypothesis | analyses run | with a written passage | ids |
|---|---|---|---|
<!-- /generated -->
