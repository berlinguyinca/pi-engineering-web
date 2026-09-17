# pi-engineering-web

PI WEB operator surface for **Pi Engineering** orchestration missions. This is a
standalone PI WEB plugin (browser plugin API v2) that renders mission/task/execution
state. **Pi Engineering remains the orchestration authority** — the plugin is a
read-only observation surface and never modifies PI WEB core or the runtime.

## Why a separate package, not a fork

PI WEB has a first-class plugin system (see `docs/plugins.md` in the pi-web repo).
Building this as a plugin keeps PI WEB upstream untouched, follows the integration
spec's "prefer a contribution that could be upstreamed" clause, and lets the plugin
version independently of the runtime. It reads a stable JSON contract — the
runtime's mission snapshot — rather than importing runtime internals.

## Data contract

The pi-engineering runtime publishes a versioned snapshot file the plugin reads
through the PI WEB workspace-files API:

```
<repoRoot>/.pi-eng/orchestration-snapshot.json
```

Shape (`contractVersion: 1`):

```json
{
  "contractVersion": 1,
  "generatedAt": "…",
  "missions": [{
    "id": "…",
    "title": "…",
    "goal": "…",
    "workflowClass": "engineering_review",
    "status": "EXECUTING",
    "riskProfile": "medium",
    "constraints": [],
    "requiredGates": ["validation", "independent_review"],
    "acceptanceCriteria": [{ "criterion": "…", "status": "pending" }],
    "tasks": [{ "id": "…", "kind": "agent", "role": "implementer", "status": "RUNNING", "objective": "…", "mutatesRepo": true, "isolation": "worktree", "dependsOn": [] }],
    "findings": [{ "id": "…", "severity": "blocking", "status": "open", "summary": "…", "taskId": null }]
  }]
}
```

The plugin rejects snapshots whose `contractVersion` does not match, so a runtime
upgrade never renders the wrong shape.

## What the plugin contributes

- **`workspace.missions` panel** — a **Missions** tab next to Files/Terminal that
  lists each mission: status, workflow/risk, gates, task progress, and blocking
  review findings.
- **`open-missions` action** — opens the Missions panel from the action palette.
- Auto-refreshes via `workspace.files` invalidation when the snapshot changes.

## Install (local plugin, no PI WEB rebuild)

```bash
npm install
npm run build            # emits dist/browser/index.js
npm run validate:manifest

mkdir -p ~/.pi-web/plugins
ln -s "$PWD" ~/.pi-web/plugins/pi-engineering.missions
```

If `PI_WEB_DATA_DIR` is set, link into `$PI_WEB_DATA_DIR/plugins` instead. This
plugin is browser-only, so **reload the PI WEB tab** after building/installing —
no session-daemon restart is required.

The plugin id `pi-engineering.missions` follows the allowed `^[a-z][a-z0-9.-]*$`
pattern and is not in a PI WEB-reserved namespace.

## Usage

1. Run a mission in a pi-engineering session, e.g. `/mission Add a health endpoint`.
2. Open the repo in PI WEB.
3. Choose the **Missions** tab (or run the **Open Pi Engineering Missions** action).

## Development

```bash
npm run typecheck
npm test                 # vitest: readSnapshot + statusClass over a fake panel context
npm run build
```

## Tests

`src/browser/index.test.ts` covers: snapshot read + validation, missing-file /
version-mismatch / malformed-JSON handling, and status→css mapping. It runs under
jsdom and needs no live PI WEB.
