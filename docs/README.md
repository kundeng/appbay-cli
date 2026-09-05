# AppBay Documentation Map

Where each kind of truth lives. A directory is listed only if it exists.

| directory | holds | maintained |
|---|---|---|
| `steering/` | durable intent: what the product is, its pillars, its layers, and the definitions Kun has decided | by hand |
| `guide/` | operator-facing guides: apps, traits, overlays, concepts, the web UI | by hand, checked by `scripts/check-docs-manifests.mjs` |
| `reference/` | contract material: `appbay.yaml`, CLI commands, the scope model, API endpoints | by hand, checked by `check:docs-cli` |
| `deploy/` | installation, deployment, migration procedures | by hand |
| `rfc/` | RFC-001 and its measured findings and evidence probes | frozen once a spec adopts an item |
| `history/` | dated evidence: review sets under `<date>-review/`, the review ledger, the seam review | by reviews and by hand |
| `images/` | screenshots the guides embed | |

Sprints live in `specs/` at the repo root, worked in numeric order; the one with
`status: ACTIVE` is the head. They are execution records, not permanent teaching docs.

Current truth belongs in steering, guides, reference, and code. Time-bound findings belong in
history. A durable doc never names a sprint id or a review date; a sprint points up to the
durable doc it must obey.

Not present yet: `design/`, the stable cross-cutting anchors. Every spec declares
`anchors: [data-architecture]`; the document is owed and is the first write of the next
sprint.
