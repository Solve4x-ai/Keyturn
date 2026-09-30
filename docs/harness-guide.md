# Harness guide — connecting an LLM client

How to point a second MCP-capable assistant (Devin, Cursor, Claude Desktop, a
custom harness) at this command center, and the contract it must honor.

## What it is connecting to

Two **separate stdio MCP processes**, never merged:

| Process | Auth | Purpose |
|---|---|---|
| **reporting** | API Services client-credentials (`config/reporting.env`) | Read-only tenant data + all local evidence/review/report reads |
| **command** | Native app auth-code + PKCE (`config/command.env`) | Same reads + gated writes + plan/dispatch tools |

Both share one SQLite workspace at
`%USERPROFILE%\.ninjaone-mcp\data\<tenant>.db`. Entity metadata only — no
credentials live in the DB or the MCP client config.

## Client configuration

Register **both** servers in the harness's MCP config (example shape — each
harness names its file differently):

```json
{
  "mcpServers": {
    "ninjaone-reporting": {
      "command": "node",
      "args": ["--require", "C:\\MCP\\NinjaOne\\node_modules\\dotenv\\config.js",
               "C:\\MCP\\NinjaOne\\dist\\index.js"],
      "env": { "DOTENV_CONFIG_PATH": "C:\\MCP\\NinjaOne\\config\\reporting.env" }
    },
    "ninjaone-command": {
      "command": "node",
      "args": ["--require", "C:\\MCP\\NinjaOne\\node_modules\\dotenv\\config.js",
               "C:\\MCP\\NinjaOne\\dist\\index.js"],
      "env": { "DOTENV_CONFIG_PATH": "C:\\MCP\\NinjaOne\\config\\command.env" }
    }
  }
}
```

Prerequisite: `npm run verify` has produced `dist/`, both env files exist and
are populated, and `npm run auth` (command profile) has been completed once.
See `SETUP.md`. Stdio only — there is no HTTP endpoint to hand to a harness;
the local browser UI (`npm run serve:*`) is a separate, human-facing surface.

## The golden rules for the LLM

1. **Nothing executes without a human.** `create_plan` produces an immutable
   plan + `reviewUrl`. A human approves in the browser UI; only then does
   `dispatch_plan` act. The LLM proposes — it never approves. `confirm: true`
   on write tools declares intent inside the call; it is not approval.
2. **`accepted` is not `verified`.** Dispatch means submitted upstream. A
   result is final only at `verified`/`failed`; read receipts via
   `get_operation` / `list_operation_targets`.
3. **Evidence is honest about uncertainty.** Infrastructure data is
   *observed* state with collection timestamps and coverage status.
   `not_observed` is claimed only when a complete enumeration ran. Never
   flatten `unverified` into `absent`, or `attempted` into `done`.
4. **Review provenance matters.** `propose_review_item` /
   `answer_review_question` from a harness are `reported` context — they
   inform humans, they never become confirmed decisions. Only
   `record_review_decision` with `direct`/`delegated` provenance decides.
5. **One org per scope.** Selections, plans, review items, and reports are
   organization-scoped; cross-org work is separate calls.
6. **Names resolve, never guess.** `resolve_devices`/`resolve_organizations`
   return exact/prefix/substring matches; ambiguity errors with candidates —
   re-resolve, don't pick one.

## Canonical workflows

**Run a diagnostic on one device**
`list_runbooks` → `get_runbook` (params + digest) → `create_plan` → hand the
user `reviewUrl` → after approval, `dispatch_plan` → `get_operation` until
`verified` → results land in the evidence store automatically.

**Fan out across many devices**
`select_devices` (frozen set → `selectionId`) → `create_plan` with
`selectionId` + optional `canarySize` → approve → `dispatch_plan` →
`list_operation_targets` for per-target truth.

**Review a finding**
`get_review_digest` → `list_review_items` → `get_review_item` (evidence,
questions, history) → `answer_review_question` / `add_org_annotation` as
`reported` context → humans decide via `record_review_decision` or the UI.

**Point-in-time / reporting**
`list_infrastructure_entities` with `asOf:"<ISO date>"` replays what was
*known* by that date (evidence-collected semantics; `evidenceHorizon`
disclosed). `generate_report` (`reportType:"operations"|"org"`,
`format:"json"|"markdown"`, `sinceDays`/`since`/`until`) produces windowed
management reports — feed the JSON to the LLM for prose/PDF rendering.

## Tool surface map

- **Phase 1 reads**: resolve_* / sync_entities / get_entity_changes /
  get_operation_journal / filters / context — plus all tenant reads
  (devices, orgs, tickets, alerts, inventory, exports).
- **Phase 2 writes** (command only, policy-gated, `confirm` dry-run):
  tickets, reboots, maintenance, services.
- **Phase 5 operation contract**: select_devices, create_plan,
  dispatch_plan, get_operation, list_operations, list_operation_targets,
  cancel_operation, list_runbooks, get_runbook.
- **Infrastructure evidence**: get_infrastructure_summary,
  list_infrastructure_entities (`asOf` supported),
  get_infrastructure_entity, get_infrastructure_coverage,
  get_infrastructure_changes, get_endpoint_infrastructure.
- **Review Center**: get_review_digest, list_review_items,
  get_review_item, list_review_questions, list_org_annotations (reads) +
  propose_review_item, revise_review_item, ask_review_question,
  answer_review_question, add_org_annotation, record_review_decision,
  suppress_review, link_review_operation (writes; command profile +
  `reviewWritesEnabled` policy flag).
- **Reporting**: generate_report (`reportType` selects operations vs org).

Full parameter tables: `TOOLS.md`. Review lifecycle semantics:
`docs/review-center.md`. Evidence model: `docs/infra1-packet.md` onward.
