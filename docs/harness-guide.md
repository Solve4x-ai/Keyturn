# Harness guide — connecting an AI client

How to point an MCP-capable assistant (Claude Desktop, Claude Code, Cursor,
Windsurf, Codex, Devin, or a custom harness) at Keyturn, and the
contract it must honor.

## What it is connecting to

Two **separate stdio MCP processes**, never merged:

| Process | Auth | Purpose |
|---|---|---|
| **reporting** | API Services client credentials (`config/reporting.env`) | Read-only tenant data + all local evidence / review / report reads |
| **command** | Native app auth code + PKCE (`config/command.env`) | Same reads + policy-gated writes + plan / dispatch tools |

Both share one local SQLite workspace under
`%USERPROFILE%\.ninjaone-mcp\data\`. It holds entity metadata and evidence —
never credentials.

## Client configuration

**Easiest:** open **Settings → MCP clients** in the dashboard. It detects
installed clients (Claude Desktop, Cursor, Windsurf, Codex, Devin), shows the
exact entries for your install path, and can merge them into the client's
config for you (with a backup).

**By hand:** register both servers in the client's MCP config. Replace
`C:\\Keyturn` with your checkout path:

```json
{
  "mcpServers": {
    "ninjaone-reporting": {
      "command": "node",
      "args": ["--require", "C:\\Keyturn\\node_modules\\dotenv\\config.js",
               "C:\\Keyturn\\dist\\index.js"],
      "env": { "DOTENV_CONFIG_PATH": "C:\\Keyturn\\config\\reporting.env" }
    },
    "ninjaone-command": {
      "command": "node",
      "args": ["--require", "C:\\Keyturn\\node_modules\\dotenv\\config.js",
               "C:\\Keyturn\\dist\\index.js"],
      "env": { "DOTENV_CONFIG_PATH": "C:\\Keyturn\\config\\command.env" }
    }
  }
}
```

Prerequisites: `npm run build` has produced `dist/`, both env files are
filled in, and the command profile has been authorized once (see
[SETUP.md](../SETUP.md)). Restart the client after changing its config.

Stdio only — there is no HTTP endpoint to hand to a harness. The browser UI is
a separate, human-facing surface.

## The golden rules for the AI

1. **Nothing executes without a human.** `create_plan` produces an immutable
   plan and a `reviewUrl`. A human approves in the browser UI; only then does
   `dispatch_plan` act. The AI proposes — it never approves. `confirm: true`
   declares intent inside a call; it is not approval.
2. **`accepted` is not `verified`.** Dispatch means submitted upstream. A
   result is final only at `verified` / `failed`; read receipts with
   `get_operation` / `list_operation_targets`.
3. **Evidence is honest about uncertainty.** Infrastructure data is *observed*
   state with collection timestamps and coverage. `not_observed` is claimed
   only when a complete enumeration ran. Never flatten `unverified` into
   `absent`, or `attempted` into `done`.
4. **Review provenance matters.** `propose_review_item` /
   `answer_review_question` from an AI are `reported` context — they inform
   humans and never become decisions. Only `record_review_decision` with
   `direct` / `delegated` provenance decides.
5. **One org per scope.** Selections, plans, review items, and reports are
   organization-scoped; cross-org work is separate calls.
6. **Names resolve, never guess.** `resolve_devices` /
   `resolve_organizations` return exact / prefix / substring matches;
   ambiguity errors with candidates — re-resolve, don't pick one.

## Canonical workflows

**Run a diagnostic on one device**
`list_runbooks` → `get_runbook` (params + digest) → `create_plan` → give the
user the `reviewUrl` → after approval, `dispatch_plan` → `get_operation` until
`verified` → results land in the evidence store automatically.

**Fan out across many devices**
`select_devices` (frozen set → `selectionId`) → `create_plan` with
`selectionId` + optional `canarySize` → approve → `dispatch_plan` →
`list_operation_targets` for per-target truth.

**Review a finding**
`get_review_digest` → `list_review_items` → `get_review_item` (evidence,
questions, history) → `answer_review_question` / `add_org_annotation` as
`reported` context → humans decide via `record_review_decision` or the UI.

**Point-in-time and reporting**
`list_infrastructure_entities` with `asOf: "<ISO date>"` replays what was
*known* by that date. `generate_report` (`reportType: "operations" | "org"`,
`format: "json" | "markdown"`, `sinceDays` / `since` / `until`) produces
windowed management reports — feed the JSON to the AI for prose or PDF.

## Tool surface map

- **Reads**: `resolve_*`, `sync_entities`, `get_entity_changes`,
  `get_operation_journal`, saved filters, plus all tenant reads (devices,
  orgs, tickets, alerts, inventory, exports).
- **Writes** (command only, policy-gated, `confirm` dry-run): tickets,
  maintenance mode.
- **Operations**: `select_devices`, `create_plan`, `dispatch_plan`,
  `get_operation`, `list_operations`, `list_operation_targets`,
  `cancel_operation`, `list_runbooks`, `get_runbook`.
- **Infrastructure evidence**: `get_infrastructure_summary`,
  `list_infrastructure_entities` (`asOf`), `get_infrastructure_entity`,
  `get_infrastructure_coverage`, `get_infrastructure_changes`,
  `get_endpoint_infrastructure`.
- **Review Center**: `get_review_digest`, `list_review_items`,
  `get_review_item`, `list_review_questions`, `list_org_annotations` (reads) +
  `propose_review_item`, `revise_review_item`, `ask_review_question`,
  `answer_review_question`, `add_org_annotation`, `record_review_decision`,
  `suppress_review`, `link_review_operation` (writes; command profile +
  `reviewWritesEnabled`).
- **Reporting**: `generate_report`.

Full parameter tables: [TOOLS.md](../TOOLS.md). Security guarantees:
[security-model.md](security-model.md).
