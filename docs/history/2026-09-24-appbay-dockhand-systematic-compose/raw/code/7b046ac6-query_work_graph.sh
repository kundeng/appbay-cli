#!/usr/bin/env bash
# Re-derive published findings from the loaded graph, rather than only counting rows.
#
# A graph that loads is not a graph that means something. Each query below re-derives a
# number this investigation published; if the graph disagrees with the workbook, one of
# the two is wrong and the disagreement is the point of running these.
set -uo pipefail
PY=${WG_PY:?set WG_PY}
INV=${WG_INV:?set WG_INV}
WG=/tmp/audited-ops-eval-20260924b/sources/audited-ops-tooling/work-graph.py

q() { echo "--- $1"; "$PY" "$WG" "$INV" --query "$2" 2>&1 | tail -20; echo; }

q "current beliefs (findings not superseded or overtaken)" \
  "MATCH (f:Finding) WHERE NOT EXISTS { MATCH ()-[:SUPERSEDES]->(f) } AND NOT EXISTS { MATCH ()-[:OVERTAKEN_BY]->(f) } RETURN count(f) AS current_findings"

q "evidence blast radius: records more than one finding leans on" \
  "MATCH (f:Finding)-[:CITES]->(p:ProbeRecord) WITH p, count(f) AS n WHERE n > 1 RETURN p.id, p.verdict, n ORDER BY n DESC"

q "F3's code sites — the environment disagreement, re-derived" \
  "MATCH (f:Finding)-[:ABOUT]->(c:CodeSite) WHERE f.id = 'F3' RETURN f.id, c.path, c.line, c.symbol ORDER BY c.path"

q "the disagreement itself, as edges" \
  "MATCH (a:CodeSite)-[:DISAGREES_WITH]->(b:CodeSite) RETURN a.site, a.symbol, b.site, b.symbol"

q "deploy paths by product — the parity finding, re-derived" \
  "MATCH (c:CodeSite)-[:SITE_IN]->(p:Product) WHERE c.kind = 'deploy-path' RETURN p.name, c.site, c.path, c.line ORDER BY p.name, c.site"

q "gaps to close vs leave, with the finding behind each" \
  "MATCH (g:Gap) OPTIONAL MATCH (g)-[:GAP_AT]->(c:CodeSite) RETURN g.gap_id, g.decision, g.spec, count(c) AS sites ORDER BY g.gap_id"

q "decisions and the evidence behind them" \
  "MATCH (j:Judgement) OPTIONAL MATCH (j)-[:BECAUSE]->(f:Finding) RETURN j.what, j.chose, j.instead_of, f.id ORDER BY j.id"

q "artifact provenance: which run wrote what, from which code" \
  "MATCH (r:Run)-[:WROTE]->(a:Artifact) WITH r, count(a) AS artifacts RETURN r.id, r.code_version, artifacts ORDER BY artifacts DESC"

q "the claim/domain bridge: findings and the records that examined the same code" \
  "MATCH (f:Finding)-[:ABOUT]->(c:CodeSite)<-[:DERIVES]-(p:ProbeRecord) RETURN f.id, p.id, c.site ORDER BY f.id"

q "cohorts and their members" \
  "MATCH (c:Cohort)-[:INCLUDES]->(t) RETURN c.id, c.definition, count(t) AS members"
