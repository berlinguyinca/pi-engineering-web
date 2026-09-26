import { afterEach, describe, expect, it, vi } from "vitest";
import {
  POLL_INTERVAL_MS,
  SnapshotParseError,
  SnapshotReadError,
  SnapshotShapeError,
  UnsupportedSnapshotVersionError,
  readSnapshot,
  statusClass,
} from "./index.ts";
import type { WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";

function fakeCtx(content: string | null | (() => string | null), onRead?: () => void): WorkspacePanelContext {
  return {
    machine: { id: "m", name: "local", kind: "local" },
    workspace: {
      id: "w",
      projectId: "p",
      path: "/repo",
      label: "repo",
      isMain: true,
    },
    files: {
      readFile: async () => {
        onRead?.();
        const value = typeof content === "function" ? content() : content;
        if (value === null) {
          throw Object.assign(new Error("Path does not exist"), { name: "HttpRequestError", status: 400 });
        }
        return { content: value, mediaType: undefined };
      },
      listFiles: async () => ({ entries: [] }),
      writeFile: async () => ({ path: "x", existed: false }),
      deleteFile: async () => ({ existed: false }),
      moveFile: async () => ({ existed: false }),
    },
    host: { requestRender: () => {} },
  } as unknown as WorkspacePanelContext;
}

const V1_SNAPSHOT = {
  contractVersion: 1,
  generatedAt: "2025-01-01T00:00:00Z",
  missions: [
    {
      id: "mission-1",
      title: "Add health endpoint",
      goal: "Add /health",
      workflowClass: "engineering_review",
      status: "EXECUTING",
      riskProfile: "medium",
      constraints: [],
      requiredGates: ["validation", "independent_review"],
      acceptanceCriteria: [{ criterion: "health returns 200", status: "pending" }],
      tasks: [{ id: "t1", kind: "agent", role: "implementer", status: "RUNNING", objective: "Add /health", mutatesRepo: true, isolation: "worktree", dependsOn: [] }],
      findings: [],
    },
  ],
};

const V2_SNAPSHOT = {
  ...V1_SNAPSHOT,
  contractVersion: 2,
  generatedAt: "2026-09-26T12:34:50Z",
  missions: [{
    ...V1_SNAPSHOT.missions[0],
    observability: {
      progress: { approximatePercent: 42, verifiedComplete: false, basis: "weighted_dag" },
      health: "waiting",
      currentObjective: "Make mission progress observable",
      currentActivity: { type: "running_test", summary: "Running browser regression tests", workerId: "worker-1", file: "src/browser/index.test.ts", command: "npm test" },
      workers: { active: 1, waiting: 1, failed: 0 },
      lastHeartbeatAt: "2026-09-26T12:34:49Z",
      lastMeaningfulProgressAt: "2026-09-26T12:34:45Z",
      waitingReason: "integration_tests",
      completionStatus: "validating",
      progressHistory: [{ at: "2026-09-26T12:33:00Z", approximatePercent: 35, label: "Implementation started" }],
      tests: { running: true, completed: 8, total: 12, passed: 7, failed: 1, skipped: 0, failures: ["renders stale snapshots"] },
      review: { status: "running", blockingOpen: 1, findings: [{ id: "f1", severity: "blocking", status: "open", summary: "Polling missing", repaired: false }] },
      workerDetails: [
        { workerId: "worker-1", taskId: "t1", state: "running", model: "gpt", runtime: "codex", host: "local", startedAt: "2026-09-26T12:30:00Z", lastHeartbeatAt: "2026-09-26T12:34:49Z", lastMeaningfulProgressAt: "2026-09-26T12:34:45Z", currentActivity: "Running tests", tokensPerSec: 42.5, repeatedFileReads: 2, repeatedToolCalls: 3, repeatedErrors: 1, repeatedCycles: 4, noProgressSince: "2026-09-26T12:34:20Z" },
        { workerId: "worker-2", state: "waiting", currentActivity: "Waiting for integration tests", repeatedFileReads: 0, repeatedToolCalls: 0, repeatedErrors: 0, repeatedCycles: 0 },
      ],
      activity: [
        { at: "2026-09-26T12:34:40Z", workerId: "worker-1", type: "editing_file", summary: "Updated mission panel", file: "src/browser/index.ts", meaningfulProgress: true },
        { at: "2026-09-26T12:34:48Z", workerId: "worker-1", type: "running_test", summary: "Started browser tests", command: "npm test", meaningfulProgress: true },
      ],
      errors: [{ key: "test", count: 2, firstAt: "2026-09-26T12:30:00Z", lastAt: "2026-09-26T12:34:47Z", example: "One regression failed" }],
      recovery: [{ attempt: 1, action: "retry tests", startedAt: "2026-09-26T12:34:46Z", completedAt: "2026-09-26T12:34:47Z", status: "succeeded", summary: "Retrying failed browser test" }],
      changes: { branch: "fix/mission-live-detail", worktree: "/repo", changedFiles: ["src/browser/index.ts"], commits: ["abc123"], integrationState: "pending" },
      artifacts: ["artifacts/browser-tests.xml"],
    },
  }],
};

async function renderPanel(ctx: WorkspacePanelContext): Promise<HTMLElement> {
  const panel = document.createElement("pi-eng-missions-panel") as HTMLElement & { ctx: WorkspacePanelContext };
  document.body.append(panel);
  panel.ctx = ctx;
  await Promise.resolve();
  await Promise.resolve();
  expect(panel.querySelector("h2")).not.toBeNull();
  return panel;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("pi-engineering missions browser plugin", () => {
  it("accepts both the legacy v1 and current v2 snapshot contracts", async () => {
    await expect(readSnapshot(fakeCtx(JSON.stringify(V1_SNAPSHOT)))).resolves.toMatchObject({ contractVersion: 1 });
    await expect(readSnapshot(fakeCtx(JSON.stringify(V2_SNAPSHOT)))).resolves.toMatchObject({ contractVersion: 2 });
  });

  it("returns null only when the snapshot file is missing", async () => {
    await expect(readSnapshot(fakeCtx(null))).resolves.toBeNull();
    await expect(readSnapshot(fakeCtx(() => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); }))).resolves.toBeNull();
  });

  it("does not misclassify an unrelated HTTP 400 as a missing snapshot", async () => {
    const error = Object.assign(new Error("Workspace path is invalid"), { name: "HttpRequestError", status: 400 });
    await expect(readSnapshot(fakeCtx(() => { throw error; }))).rejects.toBeInstanceOf(SnapshotReadError);
  });

  it.each([
    ["unreadable", () => { throw new Error("permission denied"); }, SnapshotReadError],
    ["malformed", "not json", SnapshotParseError],
    ["invalid shape", JSON.stringify({ contractVersion: 2, generatedAt: "now", missions: {} }), SnapshotShapeError],
  ])("reports an explicit typed error when the snapshot is %s", async (_name, content, errorType) => {
    await expect(readSnapshot(fakeCtx(content))).rejects.toBeInstanceOf(errorType);
  });

  it.each([
    ["acceptance criterion", (mission: any) => { mission.acceptanceCriteria = [null]; }],
    ["task", (mission: any) => { mission.tasks = [null]; }],
    ["finding", (mission: any) => { mission.findings = [{ id: "f", severity: "blocking", status: "open", summary: "bad", taskId: 7 }]; }],
    ["progress boolean", (mission: any) => { mission.observability.progress.verifiedComplete = "false"; }],
    ["test boolean", (mission: any) => { mission.observability.tests.running = 1; }],
    ["worker detail", (mission: any) => { mission.observability.workerDetails = [{}]; }],
    ["activity", (mission: any) => { mission.observability.activity = [{ at: "now", type: "test", summary: "bad", meaningfulProgress: "yes" }]; }],
    ["progress history", (mission: any) => { mission.observability.progressHistory = [null]; }],
    ["error", (mission: any) => { mission.observability.errors = [{ key: "x", count: "2", firstAt: "a", lastAt: "b", example: "bad" }]; }],
    ["recovery", (mission: any) => { mission.observability.recovery = [{ attempt: "1", action: "retry", startedAt: "a", status: "running", summary: "bad" }]; }],
    ["review finding", (mission: any) => { mission.observability.review.findings = [{ id: "f", severity: "blocking", status: "open", summary: "bad", repaired: "false" }]; }],
    ["changes", (mission: any) => { mission.observability.changes.changedFiles = [7]; }],
    ["artifact", (mission: any) => { mission.observability.artifacts = [false]; }],
  ])("rejects an invalid nested %s before rendering", async (_name, mutate) => {
    const invalid = structuredClone(V2_SNAPSHOT) as any;
    mutate(invalid.missions[0]);
    await expect(readSnapshot(fakeCtx(JSON.stringify(invalid)))).rejects.toBeInstanceOf(SnapshotShapeError);
  });

  it.each([
    ["negative progress", (obs: any) => { obs.progress.approximatePercent = -1; }],
    ["progress above 100", (obs: any) => { obs.progress.approximatePercent = 101; }],
    ["history percent above 100", (obs: any) => { obs.progressHistory[0].approximatePercent = 101; }],
    ["negative worker count", (obs: any) => { obs.workers.active = -1; }],
    ["fractional test count", (obs: any) => { obs.tests.completed = 1.5; }],
    ["negative review count", (obs: any) => { obs.review.blockingOpen = -1; }],
    ["fractional loop counter", (obs: any) => { obs.workerDetails[0].repeatedCycles = 0.5; }],
    ["negative throughput", (obs: any) => { obs.workerDetails[0].tokensPerSec = -1; }],
    ["negative error count", (obs: any) => { obs.errors[0].count = -1; }],
    ["fractional recovery attempt", (obs: any) => { obs.recovery[0].attempt = 1.5; }],
  ])("rejects %s instead of normalizing invalid producer data", async (_name, mutate) => {
    const invalid = structuredClone(V2_SNAPSHOT) as any;
    mutate(invalid.missions[0].observability);
    await expect(readSnapshot(fakeCtx(JSON.stringify(invalid)))).rejects.toBeInstanceOf(SnapshotShapeError);
  });

  it("accepts and renders a fractional progress-history percentage within range", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T12:35:00Z"));
    const snapshot = structuredClone(V2_SNAPSHOT) as any;
    snapshot.missions[0].observability.progressHistory[0].approximatePercent = 35.5;

    await expect(readSnapshot(fakeCtx(JSON.stringify(snapshot)))).resolves.toMatchObject({ contractVersion: 2 });
    const panel = await renderPanel(fakeCtx(JSON.stringify(snapshot)));
    expect(panel.textContent).toContain("35.5% · Implementation started");
  });

  it("rejects an unknown newer contract with an explicit compatibility error", async () => {
    await expect(readSnapshot(fakeCtx(JSON.stringify({ ...V2_SNAPSHOT, contractVersion: 3 })))).rejects.toEqual(new UnsupportedSnapshotVersionError(3));
  });

  it("renders v2 current work, workers, activity, tests, waits, errors, recovery, and secondary progress", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T12:35:00Z"));
    const panel = await renderPanel(fakeCtx(JSON.stringify(V2_SNAPSHOT)));

    expect(panel.textContent).toContain("Make mission progress observable");
    expect(panel.textContent).toContain("Running browser regression tests");
    expect(panel.textContent).toContain("1 active · 1 waiting · 0 failed");
    expect(panel.textContent).toContain("worker-1");
    expect(panel.textContent).toContain("Started browser tests");
    expect(panel.textContent).toContain("integration tests");
    expect(panel.textContent).toContain("8/12 complete");
    expect(panel.textContent).toContain("renders stale snapshots");
    expect(panel.textContent).toContain("One regression failed");
    expect(panel.textContent).toContain("Retrying failed browser test");
    expect(panel.querySelector("progress")?.getAttribute("value")).toBe("42");
    expect(panel.querySelector("time[datetime='2026-09-26T12:34:48Z']")).not.toBeNull();
  });

  it("renders mission timing plus worker task, runtime, timing, and activity source detail", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T12:35:00Z"));
    const panel = await renderPanel(fakeCtx(JSON.stringify(V2_SNAPSHOT)));

    expect(panel.textContent).toContain("Last heartbeat");
    expect(panel.querySelector("time[datetime='2026-09-26T12:34:49Z']")).not.toBeNull();
    expect(panel.textContent).toContain("Last meaningful progress");
    expect(panel.textContent).toContain("task t1");
    expect(panel.textContent).toContain("runtime codex");
    expect(panel.querySelector("time[datetime='2026-09-26T12:30:00Z']")).not.toBeNull();
    expect(panel.textContent).toContain("src/browser/index.ts");
    expect(panel.textContent).toContain("npm test");
    expect(panel.textContent).toContain("42.5 tokens/s");
    expect(panel.textContent).toContain("No progress since");
    expect(panel.textContent).toContain("reads 2 · tools 3 · errors 1 · cycles 4");
    expect(panel.textContent).toContain("worker-1 · src/browser/index.test.ts · npm test");
  });

  it("renders review, changes, artifacts, and progress history from v2 observability", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T12:35:00Z"));
    const panel = await renderPanel(fakeCtx(JSON.stringify(V2_SNAPSHOT)));

    expect(panel.textContent).toContain("Review");
    expect(panel.textContent).toContain("1 blocking open");
    expect(panel.textContent).toContain("Polling missing");
    expect(panel.textContent).toContain("fix/mission-live-detail");
    expect(panel.textContent).toContain("/repo");
    expect(panel.textContent).toContain("abc123");
    expect(panel.textContent).toContain("artifacts/browser-tests.xml");
    expect(panel.textContent).toContain("35% · Implementation started");
    expect(panel.querySelector("time[datetime='2026-09-26T12:33:00Z']")).not.toBeNull();
  });

  it("renders stable activity, review, error, and recovery diagnostics", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T12:35:00Z"));
    const panel = await renderPanel(fakeCtx(JSON.stringify(V2_SNAPSHOT)));

    expect(panel.textContent).toContain("meaningful progress");
    expect(panel.textContent).toContain("#f1");
    expect(panel.textContent).toContain("key test");
    expect(panel.textContent).toContain("first");
    expect(panel.querySelector("time[datetime='2026-09-26T12:30:00Z']")).not.toBeNull();
    expect(panel.textContent).toContain("action retry tests");
    expect(panel.textContent).toContain("completed");
    expect(panel.querySelector("time[datetime='2026-09-26T12:34:47Z']")).not.toBeNull();
  });

  it("announces routine stale freshness politely without an assertive alert", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T12:36:00Z"));
    const panel = await renderPanel(fakeCtx(JSON.stringify(V2_SNAPSHOT)));

    expect(panel.querySelector("time[datetime='2026-09-26T12:34:50Z']")).not.toBeNull();
    const freshness = panel.querySelector("[role='status']");
    expect(freshness?.getAttribute("aria-live")).toBe("polite");
    expect(freshness?.textContent).toContain("Snapshot is stale");
    expect(panel.querySelector("[role='alert']")).toBeNull();
  });

  it("renders unknown versions as an explicit error rather than an empty mission state", async () => {
    const panel = document.createElement("pi-eng-missions-panel") as HTMLElement & { ctx: WorkspacePanelContext };
    document.body.append(panel);
    panel.ctx = fakeCtx(JSON.stringify({ ...V2_SNAPSHOT, contractVersion: 9 }));

    await vi.waitFor(() => expect(panel.querySelector("[role='alert']")).not.toBeNull());
    expect(panel.textContent).toContain("snapshot version 9");
    expect(panel.textContent).not.toContain("No orchestration missions yet");
  });

  it("polls only while connected, without duplicate timers, and stops after disconnect", async () => {
    vi.useFakeTimers();
    let reads = 0;
    const ctx = fakeCtx(JSON.stringify(V1_SNAPSHOT), () => { reads += 1; });
    const panel = document.createElement("pi-eng-missions-panel") as HTMLElement & { ctx: WorkspacePanelContext };
    document.body.append(panel);
    panel.ctx = ctx;
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toBe(1);

    panel.ctx = ctx;
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(reads).toBe(3);

    panel.remove();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
    expect(reads).toBe(3);
  });

  it("serializes reads slower than the poll interval and eventually renders their result", async () => {
    vi.useFakeTimers();
    let reads = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const ctx = fakeCtx(asyncSnapshot);
    const panel = document.createElement("pi-eng-missions-panel") as HTMLElement & { ctx: WorkspacePanelContext };

    function asyncSnapshot(): string {
      throw new Error("synchronous content callback should not be used");
    }
    ctx.files.readFile = async () => {
      reads += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS + 1_000));
      inFlight -= 1;
      return { content: JSON.stringify(V1_SNAPSHOT), mediaType: undefined };
    };

    document.body.append(panel);
    panel.ctx = ctx;
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 1_000);

    expect(panel.textContent).toContain("Add health endpoint");
    expect(maxInFlight).toBe(1);
    expect(reads).toBeLessThanOrEqual(2);
    panel.remove();
  });

  it("renders an unreadable snapshot as an alert rather than an empty mission state", async () => {
    const panel = document.createElement("pi-eng-missions-panel") as HTMLElement & { ctx: WorkspacePanelContext };
    document.body.append(panel);
    panel.ctx = fakeCtx(() => { throw new Error("permission denied"); });

    await vi.waitFor(() => expect(panel.querySelector("[role='alert']")).not.toBeNull());
    expect(panel.textContent).toContain("could not be read");
    expect(panel.textContent).not.toContain("No orchestration missions yet");
  });

  it("retains the last good snapshot and shows an alert when a later poll is malformed", async () => {
    vi.useFakeTimers();
    let content = JSON.stringify(V1_SNAPSHOT);
    const panel = await renderPanel(fakeCtx(() => content));
    content = "{ malformed";

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(panel.textContent).toContain("Add health endpoint");
    expect(panel.querySelector("[role='alert']")?.textContent).toContain("Showing the last known snapshot");
    expect(panel.querySelector("[role='alert']")?.textContent).toContain("malformed JSON");
  });

  it("retains the last good snapshot when a later poll contains an invalid nested item", async () => {
    vi.useFakeTimers();
    let content = JSON.stringify(V1_SNAPSHOT);
    const panel = await renderPanel(fakeCtx(() => content));
    const invalid = structuredClone(V1_SNAPSHOT) as any;
    invalid.missions[0].tasks = [null];
    content = JSON.stringify(invalid);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(panel.textContent).toContain("Add health endpoint");
    expect(panel.textContent).toContain("RUNNING implementer: Add /health");
    expect(panel.querySelector("[role='alert']")?.textContent).toContain("invalid shape");
    expect(panel.querySelector("[role='alert']")?.textContent).toContain("Showing the last known snapshot");
  });

  it("never carries a previous workspace snapshot into a newly selected workspace", async () => {
    const workspaceA = {
      ...V1_SNAPSHOT,
      missions: [{ ...V1_SNAPSHOT.missions[0], title: "Workspace A private mission" }],
    };
    const panel = await renderPanel(fakeCtx(JSON.stringify(workspaceA)));
    const workspaceB = fakeCtx(() => { throw new Error("workspace B unavailable"); });
    workspaceB.workspace.id = "w-b";
    workspaceB.workspace.path = "/repo-b";

    (panel as HTMLElement & { ctx: WorkspacePanelContext }).ctx = workspaceB;

    expect(panel.textContent).not.toContain("Workspace A private mission");
    await vi.waitFor(() => expect(panel.querySelector("[role='alert']")).not.toBeNull());
    expect(panel.textContent).toContain("workspace B unavailable");
    expect(panel.textContent).not.toContain("Showing the last known snapshot");
    expect(panel.textContent).not.toContain("Workspace A private mission");
  });

  it("maps statuses to css classes", () => {
    expect(statusClass("COMPLETE")).toBe("pi-eng-ok");
    expect(statusClass("FAILED")).toBe("pi-eng-bad");
    expect(statusClass("EXECUTING")).toBe("pi-eng-run");
    expect(statusClass("PENDING")).toBe("pi-eng-idle");
  });
});
