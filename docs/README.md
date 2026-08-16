# AppBay Documentation Map

- `steering/` — durable product intent, vocabulary, pillars, stack decisions, and
  repository conventions.
- `design/` — stable cross-cutting architecture contracts that every feature must follow.
- `guide/` — user-facing operation and configuration guides.
- `deploy/` — installation, deployment, migration, and production procedures.
- `dev/` — developer guides and teaching chapters.
- `reference/` — generated or maintained contract/reference material.
- `history/` — dated investigations, reviews, handoffs, and other point-in-time evidence.
- `.kiro/specs/` — sprint requirements, designs, tasks, and verification logs; these are
  outside `docs/` because they are execution records rather than permanent teaching docs.

Current truth belongs in steering, design, guides, and code. Time-bound findings belong in
history. A durable design document does not depend on a sprint number; a sprint points to
the durable design it must obey.
