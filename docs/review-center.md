# REVIEW-1 — Review Center

Status: implemented. Commit: see `git log` (schema `MIGRATION_12`, service
`src/review.ts`, UI `public/js/review.js`, routes in `src/serve.ts`, tools in
`src/index.ts`).

The Review Center is the org-scoped interpretation layer over retained
infrastructure evidence. Findings stop being flat annotations and become
durable review items that humans and harnesses triage, question, decide, and
link to work — without anything in this layer ever executing on an endpoint.

## What it is / is not

- **Is**: observations, risks, and improvements as first-class durable
  records with immutable revisions, provenance, evidence links, questions,
  answers, decisions, suppressions, and operation/plan links.
- **Is not**: a task runner. There is no "Fix" action. A decision like
  `accept_risk` or `verified_resolved` records judgment — related work is
  *linked* (plan/operation id) after it goes through the normal
  plan → approval → dispatch path in `operations.ts`.

## Data model (schema v13)

| Table | Purpose |
|---|---|
| `review_items` | the durable item: type, workflow, assessment, disposition, review_state, fingerprint (dedupe), subject_json, **severity + confidence + priority_score** |
| `review_item_revisions` | immutable content versions — `current_revision` on the item, optimistic concurrency via `expectedRevision`; carries `proposed_severity`/`proposed_confidence` |
| `review_item_revisions` | immutable content versions — `current_revision` on the item, optimistic concurrency via `expectedRevision` |
| `review_questions` | clarifying questions; status open/answered/needs_clarification/withdrawn/superseded |
| `review_answers` | answers with actor + provenance; `is_current` + `conflicts_with` keep contradictory answers honest |
| `review_evidence_links` | typed links (entity, observation, operation, annotation, relationship) — validated same-org |
| `review_decisions` | disposition records; supersede chain preserved (`superseded_by`) |
| `review_suppressions` | durable suppression by fingerprint / ruleId / itemId with reason + optional expiry |
| `review_item_ops` | links to `operations` / `operation_plans` (proposed/approved/executed/verification) |
| `review_events` | audit trail with actor_kind, provenance, idempotency key |
| `org_annotations` | human-supplied context (lifecycle, ownership, intent, exception) — attribution direct vs reported |

### Triage scoring

`severity` ∈ `critical|high|medium|low` (how bad if true) × `confidence` ∈
`high|medium|low` (how sure the evidence is) → `priority_score` (sev 4/3/2/1
× conf 3/2/1 = 1–12). Set on propose/revise; rule-imported findings get
defaults from `FINDING_RULE_META`. Inbox and digest sort by score — the
highest-stakes best-evidenced items surface first. `impact`/`urgency` remain
as free-text assessor fields; a free-text impact naming a level maps onto
`severity` when severity isn't given.

## Provenance

`actor_kind` = who acted (`human_ui`, `harness`, `ai`, `rule`, `system`).
`provenance` = how the statement arrived (`direct`, `delegated`, `reported`,
`system`). Decisions require `direct` or `delegated` — a harness relaying
"the user says accept this" records as `delegated`, which is honest; a
`reported` statement is context and cannot close an item.

## Rules that cannot be bypassed

- `dismiss`, `unverified_closure`, `accept_risk` require a rationale.
- `verified_resolved` requires `evidenceBasis`; `unverified_closure` is the
  honest alternative when nothing proves resolution.
- Conflicting current answers coexist — `needs_clarification`, both retained.
- "I don't know" is a terminal answer (`normalized.value = 'unknown'`).
- Contradictory evidence flags `reassessment_needed` without rewriting the
  recorded decision; due dates surface `review_due` in digests.
- Suppression by fingerprint/ruleId blocks re-import of matching findings.
- All writes are idempotent (`idempotencyKey`) and org-isolated.

## MCP surface

Reads (both profiles): `review_digest`, `list_review_items`,
`get_review_item`, `list_review_questions`, `list_org_annotations`,
`get_review_history`.

Writes (command profile + `reviewWritesEnabled` policy flag):
`propose_review_item`, `revise_review_item`, `ask_review_question`,
`answer_review_question`, `add_org_annotation`, `record_review_decision`,
`suppress_review`, `link_review_operation`, `import_review_findings`.

Zero-executor invariant is structural: `ReviewService` holds only the
EntityStore — no API reference exists to call. Tested in
`tests/review.test.mjs`.

## REST surface (UI)

`GET /api/v1/orgs/:org/review` (digest), `GET .../review/items`,
`GET .../review/items/:id`, `GET .../review/questions`,
`GET/POST .../review/annotations`, `POST .../review/items` (propose),
`POST .../review/items/:id/revise`, `POST .../review/items/:id/decision`,
`POST .../review/questions/:id/answer`, `POST .../review/suppressions`,
`POST .../review/items/:id/links`, `POST .../review/import-findings`.
Writes return 403 when `reviewWritesEnabled` is off.

## UI

`#/review/<org>/<tab>` — Inbox (digest: open, proposed, questions, due),
Questions, Risks, Improvements (category filter + propose), Decisions
(accepted/deferred/resolved/unverified/dismissed groupings), Context
(org annotations). Every item row opens a dedicated page at
`#/review/<org>/item?i=<itemId>` — plain language first (what we noticed,
why it matters, known vs unknown), evidence links, operation/plan links,
question-answer history, decisions with evidence basis, event history, and
an edit form writing a new immutable revision under `expectedRevision`
optimistic concurrency (a `revision_conflict` forces refetch, never an
overwrite). Nav badge shows open items + open questions.

## Ingestion

The reconcile sweep runs two deterministic passes after ingestion:

- `importFindings(org)` — infra findings materialize as `proposed` review
  items, fingerprint-deduped and suppression-aware. Per-rule meta fills
  `consequence`/`knowns_unknowns` and attaches entity-specific open
  questions (imported items land in `awaiting_context`). Pre-meta items are
  backfilled in place — never duplicated.
- `reassessDecidedItems(org)` — a decided item whose evidence-linked
  entity gains a new finding *after* the decision is flagged
  `reassessment_needed`. The recorded decision is preserved; the item
  resurfaces in digests. Bounded to already-collected evidence.

## Reporting & point-in-time (R5)

- `GET /api/v1/orgs/:org/report?sinceDays=N&format=markdown` and MCP
  `generate_report` with `reportType:'org'` — windowed org report:
  operations (verified vs attempted), infrastructure entity/coverage
  state, and review outcomes (decisions by disposition, open questions,
  reassessments, suppressions). `renderOrgReportMarkdown` produces the
  management-readable document.
- As-of browsing: `GET .../infrastructure/entities?at=<ms|ISO>` replays
  the latest observation per entity collected at-or-before T. "As of T"
  means *evidence collected by T* — first-ever collection bounds the
  horizon, disclosed in the response. The Infrastructure tabs carry an
  "As of" date selector that replays every tab against that timestamp.
- UI Reports view (`#/reports/<org>`) renders the report and prints to
  PDF via browser print (print stylesheet strips chrome).
