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

The plugin supports both the legacy `contractVersion: 1` shape and the current
`contractVersion: 2` shape. Version 2 is additive: each mission may include an
`observability` object. Consumers feature-detect that object so v1 snapshots and
v2 snapshots for missions without observability still render the base mission,
task, and finding data.

Base shape (v1 and v2):

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

Version 2 adds:

```json
{
  "contractVersion": 2,
  "generatedAt": "…",
  "missions": [{
    "…": "base mission fields above",
    "observability": {
      "progress": { "approximatePercent": 42, "verifiedComplete": false, "basis": "weighted_dag" },
      "health": "active",
      "currentObjective": "…",
      "currentActivity": { "type": "editing_file", "summary": "…", "workerId": "…" },
      "workers": { "active": 1, "waiting": 0, "failed": 0 },
      "lastHeartbeatAt": "…",
      "lastMeaningfulProgressAt": "…",
      "waitingReason": "integration_tests",
      "completionStatus": "validating",
      "progressHistory": [],
      "tests": { "running": true, "completed": 8, "total": 12, "passed": 8, "failed": 0, "skipped": 0, "failures": [] },
      "review": { "status": "running", "blockingOpen": 0, "findings": [] },
      "workerDetails": [],
      "activity": [],
      "errors": [],
      "recovery": [],
      "changes": { "changedFiles": [], "commits": [], "integrationState": "pending" },
      "artifacts": []
    }
  }]
}
```

Unknown contract versions are rejected with an explicit compatibility error in
the panel. Unreadable files, malformed JSON, and invalid contract shapes also
render explicit errors. The initial empty state is limited to a reliable
`ENOENT` response or PI WEB's exact missing-path transport response (`400` with
`Path does not exist`); unrelated HTTP 400 failures remain visible errors. The
reader validates nested base and observability records before rendering. After a
successful read and render, a later refresh error retains the last known mission
detail underneath an alert instead of blanking the panel.
Validation also rejects progress outside 0–100 and invalid negative or
fractional counters/attempts instead of silently clamping corrupt producer data.
Retention is scoped to the machine/project/workspace/path identity: switching
workspaces immediately clears the prior workspace's mission data and invalidates
any read still in flight.

## What the plugin contributes

- **`workspace.missions` panel** — a **Missions** tab next to Files/Terminal that
  lists each mission's current objective/activity, worker counts and details,
  heartbeat and meaningful-progress timing, recent timestamped activity with
  meaningful-progress and file/command provenance, waits, test state/failures,
  review finding IDs, grouped error keys/first-seen timing, recovery actions and
  completion timing, changed files/commits, artifacts, progress history, and
  task state.
  Worker detail includes task/runtime/model placement, throughput, no-progress
  timing, and repeated-operation counters when published. Approximate progress
  is supporting context rather than the primary signal.
- **`open-missions` action** — opens the Missions panel from the action palette.
- Shows the snapshot generation time and reports routine fresh/stale changes in
  a polite status region; assertive alerts are reserved for read, parse, shape,
  and compatibility failures.
- Refreshes every five seconds while the panel is connected, in addition to
  `workspace.files` invalidation. The panel owns one timer, permits only one
  read in flight, queues at most one follow-up refresh, and clears its timer when
  disconnected.

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
npm test                 # vitest: snapshot boundary + panel rendering/lifecycle under jsdom
npm run build
```

## Tests

`src/browser/index.test.ts` covers: v1/v2 snapshot compatibility, explicit
unknown-version errors, missing/malformed snapshots, detailed v2 rendering,
freshness/staleness, accessible timestamps, serialized slow polling, retained
last-good data after refresh failures, full operator-detail coverage, polite
freshness semantics, adversarial nested-contract validation, upstream missing
transport compatibility, polling lifecycle, and status→css mapping. It runs
under jsdom and needs no live PI WEB.
