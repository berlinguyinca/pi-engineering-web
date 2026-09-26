/**
 * Pi Engineering missions — PI WEB browser plugin entry (browser API v2).
 *
 * Renders orchestration mission state read from the versioned snapshot file the
 * pi-engineering runtime publishes at `<repoRoot>/.pi-eng/orchestration-snapshot.json`.
 * The plugin is a read-only operator surface: Pi Engineering remains the
 * orchestration authority.
 *
 * No PI WEB core is modified; this is a local/bundled plugin discovered by PI WEB.
 */

import type { PiWebPlugin, WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";

export interface MissionSnapshotFile {
  contractVersion: number;
  generatedAt: string;
  missions: MissionSnapshotMission[];
}

export interface MissionSnapshotMission {
  id: string;
  title: string;
  goal: string;
  workflowClass: string;
  status: string;
  riskProfile: string;
  constraints: string[];
  requiredGates: string[];
  acceptanceCriteria: Array<{ criterion: string; status: string }>;
  tasks: MissionSnapshotTask[];
  findings: MissionSnapshotFinding[];
  observability?: MissionObservabilitySnapshot;
}

export interface MissionObservabilitySnapshot {
  progress: { approximatePercent: number; verifiedComplete: boolean; basis: string };
  health: string;
  currentObjective?: string;
  currentActivity?: { type: string; summary: string; workerId?: string; file?: string; command?: string } | null;
  workers: { active: number; waiting: number; failed: number };
  lastHeartbeatAt?: string;
  lastMeaningfulProgressAt?: string;
  waitingReason?: string;
  completionStatus: string;
  progressHistory: Array<{ at: string; approximatePercent: number; label?: string }>;
  tests: { running: boolean; completed: number; total: number; passed: number; failed: number; skipped: number; failures: string[] };
  review: { status: string; blockingOpen: number; findings: Array<{ id: string; severity: string; status: string; summary: string; repaired: boolean }> };
  workerDetails: Array<{
    workerId: string;
    taskId?: string;
    state: string;
    model?: string;
    runtime?: string;
    host?: string;
    startedAt?: string;
    endedAt?: string;
    lastHeartbeatAt?: string;
    lastMeaningfulProgressAt?: string;
    currentActivity?: string;
    tokensPerSec?: number;
    repeatedFileReads: number;
    repeatedToolCalls: number;
    repeatedErrors: number;
    repeatedCycles: number;
    noProgressSince?: string;
  }>;
  activity: Array<{ at: string; workerId?: string; type: string; summary: string; file?: string; command?: string; meaningfulProgress: boolean }>;
  errors: Array<{ key: string; count: number; lastAt: string; firstAt: string; example: string }>;
  recovery: Array<{ attempt: number; action: string; startedAt: string; completedAt?: string; status: string; summary: string }>;
  changes: { branch?: string; worktree?: string; changedFiles: string[]; commits: string[]; integrationState: string };
  artifacts: string[];
}

export interface MissionSnapshotTask {
  id: string;
  kind: string;
  role: string;
  status: string;
  objective: string;
  mutatesRepo: boolean;
  isolation: string;
  dependsOn: string[];
}

export interface MissionSnapshotFinding {
  id: string;
  severity: string;
  status: string;
  summary: string;
  taskId: string | null;
}

const SNAPSHOT_PATH = ".pi-eng/orchestration-snapshot.json";
const SUPPORTED_CONTRACT_VERSIONS = new Set([1, 2]);
export const POLL_INTERVAL_MS = 5_000;
export const STALE_AFTER_MS = 30_000;

export class UnsupportedSnapshotVersionError extends Error {
  constructor(readonly version: number) {
    super(`Unsupported Pi Engineering snapshot version ${version}; this plugin supports versions 1 and 2.`);
    this.name = "UnsupportedSnapshotVersionError";
  }
}

export class SnapshotReadError extends Error {
  constructor(cause: unknown) {
    super(`Pi Engineering snapshot could not be read: ${errorMessage(cause)}`, { cause });
    this.name = "SnapshotReadError";
  }
}

export class SnapshotParseError extends Error {
  constructor(cause: unknown) {
    super("Pi Engineering snapshot contains malformed JSON.", { cause });
    this.name = "SnapshotParseError";
  }
}

export class SnapshotShapeError extends Error {
  constructor(detail: string) {
    super(`Pi Engineering snapshot has an invalid shape: ${detail}`);
    this.name = "SnapshotShapeError";
  }
}

/** Read + validate the versioned snapshot from the workspace files API. */
export async function readSnapshot(ctx: WorkspacePanelContext): Promise<MissionSnapshotFile | null> {
  let content: string;
  try {
    const res = await ctx.files.readFile(SNAPSHOT_PATH);
    if (typeof res.content !== "string") throw new SnapshotShapeError("file content must be text");
    content = res.content;
  } catch (error) {
    if (error instanceof SnapshotShapeError) throw error;
    if (isMissingFile(error)) return null;
    throw new SnapshotReadError(error);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch (error) {
    throw new SnapshotParseError(error);
  }
  if (!isRecord(parsed) || typeof parsed.contractVersion !== "number") {
    throw new SnapshotShapeError("contractVersion must be a number");
  }
  if (!SUPPORTED_CONTRACT_VERSIONS.has(parsed.contractVersion)) {
    throw new UnsupportedSnapshotVersionError(parsed.contractVersion);
  }
  assertSnapshotShape(parsed);
  return parsed;
}

function isMissingFile(error: unknown): boolean {
  if (!isRecord(error)) return false;
  if (Reflect.get(error, "code") === "ENOENT") return true;
  return error instanceof Error
    && error.message === "Path does not exist"
    && Reflect.get(error, "status") === 400;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new SnapshotShapeError(`${path} must be an object`);
}

function requireString(record: Record<string, unknown>, key: string, path: string): void {
  if (typeof record[key] !== "string") throw new SnapshotShapeError(`${path}.${key} must be a string`);
}

function requireNumber(record: Record<string, unknown>, key: string, path: string): void {
  if (typeof record[key] !== "number" || !Number.isFinite(record[key])) {
    throw new SnapshotShapeError(`${path}.${key} must be a finite number`);
  }
}

function requireNonNegativeNumber(record: Record<string, unknown>, key: string, path: string): void {
  requireNumber(record, key, path);
  if ((record[key] as number) < 0) throw new SnapshotShapeError(`${path}.${key} must be non-negative`);
}

function requireNonNegativeInteger(record: Record<string, unknown>, key: string, path: string): void {
  requireNonNegativeNumber(record, key, path);
  if (!Number.isInteger(record[key])) throw new SnapshotShapeError(`${path}.${key} must be an integer`);
}

function requirePositiveInteger(record: Record<string, unknown>, key: string, path: string): void {
  requireNonNegativeInteger(record, key, path);
  if ((record[key] as number) === 0) throw new SnapshotShapeError(`${path}.${key} must be positive`);
}

function requirePercent(record: Record<string, unknown>, key: string, path: string): void {
  requireNumber(record, key, path);
  const value = record[key] as number;
  if (value < 0 || value > 100) throw new SnapshotShapeError(`${path}.${key} must be between 0 and 100`);
}

function requireBoolean(record: Record<string, unknown>, key: string, path: string): void {
  if (typeof record[key] !== "boolean") throw new SnapshotShapeError(`${path}.${key} must be a boolean`);
}

function requireOptionalString(record: Record<string, unknown>, key: string, path: string): void {
  if (record[key] !== undefined && typeof record[key] !== "string") {
    throw new SnapshotShapeError(`${path}.${key} must be a string when present`);
  }
}

function requireOptionalNumber(record: Record<string, unknown>, key: string, path: string): void {
  if (record[key] !== undefined && (typeof record[key] !== "number" || !Number.isFinite(record[key]))) {
    throw new SnapshotShapeError(`${path}.${key} must be a finite number when present`);
  }
}

function requireOptionalNonNegativeNumber(record: Record<string, unknown>, key: string, path: string): void {
  requireOptionalNumber(record, key, path);
  if (typeof record[key] === "number" && record[key] < 0) {
    throw new SnapshotShapeError(`${path}.${key} must be non-negative when present`);
  }
}

function requireArray(record: Record<string, unknown>, key: string, path: string): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) throw new SnapshotShapeError(`${path}.${key} must be an array`);
  return value;
}

function requireStringArray(record: Record<string, unknown>, key: string, path: string): string[] {
  const values = requireArray(record, key, path);
  values.forEach((value, index) => {
    if (typeof value !== "string") throw new SnapshotShapeError(`${path}.${key}[${index}] must be a string`);
  });
  return values as string[];
}

function assertSnapshotShape(value: unknown): asserts value is MissionSnapshotFile {
  requireRecord(value, "snapshot");
  requireString(value, "generatedAt", "snapshot");
  const missions = requireArray(value, "missions", "snapshot");
  missions.forEach((mission, index) => assertMissionShape(mission, `snapshot.missions[${index}]`));
}

function assertMissionShape(value: unknown, path: string): void {
  requireRecord(value, path);
  for (const key of ["id", "title", "goal", "workflowClass", "status", "riskProfile"] as const) {
    requireString(value, key, path);
  }
  requireStringArray(value, "constraints", path);
  requireStringArray(value, "requiredGates", path);
  requireArray(value, "acceptanceCriteria", path).forEach((item, index) => {
    const itemPath = `${path}.acceptanceCriteria[${index}]`;
    requireRecord(item, itemPath);
    requireString(item, "criterion", itemPath);
    requireString(item, "status", itemPath);
  });
  requireArray(value, "tasks", path).forEach((item, index) => assertTaskShape(item, `${path}.tasks[${index}]`));
  requireArray(value, "findings", path).forEach((item, index) => assertFindingShape(item, `${path}.findings[${index}]`));
  if (value.observability !== undefined) assertObservabilityShape(value.observability, `${path}.observability`);
}

function assertTaskShape(value: unknown, path: string): void {
  requireRecord(value, path);
  for (const key of ["id", "kind", "role", "status", "objective", "isolation"] as const) requireString(value, key, path);
  requireBoolean(value, "mutatesRepo", path);
  requireStringArray(value, "dependsOn", path);
}

function assertFindingShape(value: unknown, path: string): void {
  requireRecord(value, path);
  for (const key of ["id", "severity", "status", "summary"] as const) requireString(value, key, path);
  if (value.taskId !== null && typeof value.taskId !== "string") {
    throw new SnapshotShapeError(`${path}.taskId must be a string or null`);
  }
}

function assertObservabilityShape(value: unknown, path: string): void {
  requireRecord(value, path);
  requireRecord(value.progress, `${path}.progress`);
  requirePercent(value.progress, "approximatePercent", `${path}.progress`);
  requireBoolean(value.progress, "verifiedComplete", `${path}.progress`);
  requireString(value.progress, "basis", `${path}.progress`);
  requireString(value, "health", path);
  requireOptionalString(value, "currentObjective", path);
  if (value.currentActivity !== undefined && value.currentActivity !== null) {
    const activityPath = `${path}.currentActivity`;
    requireRecord(value.currentActivity, activityPath);
    requireString(value.currentActivity, "type", activityPath);
    requireString(value.currentActivity, "summary", activityPath);
    for (const key of ["workerId", "file", "command"] as const) requireOptionalString(value.currentActivity, key, activityPath);
  }
  requireRecord(value.workers, `${path}.workers`);
  for (const key of ["active", "waiting", "failed"] as const) requireNonNegativeInteger(value.workers, key, `${path}.workers`);
  for (const key of ["lastHeartbeatAt", "lastMeaningfulProgressAt", "waitingReason"] as const) {
    requireOptionalString(value, key, path);
  }
  requireString(value, "completionStatus", path);
  requireArray(value, "progressHistory", path).forEach((item, index) => {
    const itemPath = `${path}.progressHistory[${index}]`;
    requireRecord(item, itemPath);
    requireString(item, "at", itemPath);
    requirePercent(item, "approximatePercent", itemPath);
    requireOptionalString(item, "label", itemPath);
  });
  requireRecord(value.tests, `${path}.tests`);
  requireBoolean(value.tests, "running", `${path}.tests`);
  for (const key of ["completed", "total", "passed", "failed", "skipped"] as const) {
    requireNonNegativeInteger(value.tests, key, `${path}.tests`);
  }
  requireStringArray(value.tests, "failures", `${path}.tests`);
  requireRecord(value.review, `${path}.review`);
  requireString(value.review, "status", `${path}.review`);
  requireNonNegativeInteger(value.review, "blockingOpen", `${path}.review`);
  requireArray(value.review, "findings", `${path}.review`).forEach((item, index) => {
    const itemPath = `${path}.review.findings[${index}]`;
    requireRecord(item, itemPath);
    for (const key of ["id", "severity", "status", "summary"] as const) requireString(item, key, itemPath);
    requireBoolean(item, "repaired", itemPath);
  });
  requireArray(value, "workerDetails", path).forEach((item, index) => {
    const itemPath = `${path}.workerDetails[${index}]`;
    requireRecord(item, itemPath);
    requireString(item, "workerId", itemPath);
    requireString(item, "state", itemPath);
    for (const key of ["taskId", "model", "runtime", "host", "startedAt", "endedAt", "lastHeartbeatAt", "lastMeaningfulProgressAt", "currentActivity", "noProgressSince"] as const) {
      requireOptionalString(item, key, itemPath);
    }
    requireOptionalNonNegativeNumber(item, "tokensPerSec", itemPath);
    for (const key of ["repeatedFileReads", "repeatedToolCalls", "repeatedErrors", "repeatedCycles"] as const) {
      requireNonNegativeInteger(item, key, itemPath);
    }
  });
  requireArray(value, "activity", path).forEach((item, index) => {
    const itemPath = `${path}.activity[${index}]`;
    requireRecord(item, itemPath);
    for (const key of ["at", "type", "summary"] as const) requireString(item, key, itemPath);
    for (const key of ["workerId", "file", "command"] as const) requireOptionalString(item, key, itemPath);
    requireBoolean(item, "meaningfulProgress", itemPath);
  });
  requireArray(value, "errors", path).forEach((item, index) => {
    const itemPath = `${path}.errors[${index}]`;
    requireRecord(item, itemPath);
    for (const key of ["key", "lastAt", "firstAt", "example"] as const) requireString(item, key, itemPath);
    requireNonNegativeInteger(item, "count", itemPath);
  });
  requireArray(value, "recovery", path).forEach((item, index) => {
    const itemPath = `${path}.recovery[${index}]`;
    requireRecord(item, itemPath);
    requirePositiveInteger(item, "attempt", itemPath);
    for (const key of ["action", "startedAt", "status", "summary"] as const) requireString(item, key, itemPath);
    requireOptionalString(item, "completedAt", itemPath);
  });
  requireRecord(value.changes, `${path}.changes`);
  requireOptionalString(value.changes, "branch", `${path}.changes`);
  requireOptionalString(value.changes, "worktree", `${path}.changes`);
  requireString(value.changes, "integrationState", `${path}.changes`);
  requireStringArray(value.changes, "changedFiles", `${path}.changes`);
  requireStringArray(value.changes, "commits", `${path}.changes`);
  requireStringArray(value, "artifacts", path);
}

/** Status → css class. */
export function statusClass(status: string): string {
  switch (status) {
    case "COMPLETE":
      return "pi-eng-ok";
    case "FAILED":
    case "CANCELED":
      return "pi-eng-bad";
    case "RUNNING":
    case "EXECUTING":
      return "pi-eng-run";
    default:
      return "pi-eng-idle";
  }
}

const plugin: PiWebPlugin = {
  apiVersion: 2,
  name: "Pi Engineering Missions",
  activate: ({ pluginId, html, svg }) => ({
    contributions: {
      actions: [
        {
          id: "open-missions",
          title: "Open Pi Engineering Missions",
          description: "Show orchestration mission status for this workspace",
          group: "Pi Engineering",
          run: ({ selectWorkspaceTool }) => {
            selectWorkspaceTool(`${pluginId}:workspace.missions`);
          },
        },
      ],
      workspacePanels: [
        {
          id: "workspace.missions",
          title: "Missions",
          icon: svg`
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M9 18h6"></path>
              <path d="M10 22h4"></path>
              <path d="M12 2a7 7 0 0 0-7 7c0 2.4 1.2 4.5 3 5.7V17h8v-2.3c1.8-1.2 3-3.3 3-5.7a7 7 0 0 0-7-7z"></path>
            </svg>
          `,
          invalidationResources: ["workspace.files"],
          onInvalidate: (ctx) => {
            void readSnapshot(ctx).then(() => ctx.host.requestRender(), () => ctx.host.requestRender());
          },
          render: (ctx) => html`<pi-eng-missions-panel .ctx=${ctx}></pi-eng-missions-panel>`,
        },
      ],
    },
  }),
};

export default plugin;

// Custom element that owns async snapshot loading + re-render.
class MissionsPanel extends HTMLElement {
  private _ctx: WorkspacePanelContext | null = null;
  private contextKey: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private loadGeneration = 0;
  private loadInFlight = false;
  private reloadRequested = false;
  private lastSnapshot: MissionSnapshotFile | null = null;

  set ctx(value: WorkspacePanelContext) {
    const nextKey = workspaceContextKey(value);
    const workspaceChanged = this.contextKey !== null && this.contextKey !== nextKey;
    if (workspaceChanged) {
      this.loadGeneration += 1;
      this.lastSnapshot = null;
      this.reloadRequested = false;
      this.replaceChildren(renderLoading());
    }
    this.contextKey = nextKey;
    this._ctx = value;
    void this.load();
    this.startPolling();
  }

  connectedCallback() {
    this.startPolling();
    if (this._ctx) void this.load();
  }

  disconnectedCallback() {
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.reloadRequested = false;
    this.loadGeneration += 1;
  }

  private startPolling() {
    if (!this.isConnected || this.pollTimer !== null) return;
    this.pollTimer = setInterval(() => void this.load(), POLL_INTERVAL_MS);
  }

  private async load() {
    if (this.loadInFlight) {
      this.reloadRequested = true;
      return;
    }
    const ctx = this._ctx;
    if (!ctx) return;
    const generation = this.loadGeneration;
    this.loadInFlight = true;
    try {
      const snap = await readSnapshot(ctx);
      if (generation !== this.loadGeneration || ctx !== this._ctx || !this.isConnected) return;
      this.renderSnapshot(snap);
      this.lastSnapshot = snap;
    } catch (error) {
      if (generation !== this.loadGeneration || ctx !== this._ctx || !this.isConnected) return;
      if (this.lastSnapshot) {
        this.renderSnapshot(this.lastSnapshot);
        this.prepend(renderError(error, true));
      } else {
        this.replaceChildren(renderError(error, false));
      }
    } finally {
      this.loadInFlight = false;
      if (this.reloadRequested) {
        this.reloadRequested = false;
        if (this.isConnected) void this.load();
      }
    }
  }

  private renderSnapshot(snap: MissionSnapshotFile | null) {
    this.textContent = "";
    if (!snap || snap.missions.length === 0) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "No orchestration missions yet. Run a mission in the pi-engineering runtime.";
      this.append(empty);
      return;
    }
    const heading = document.createElement("section");
    heading.className = "toolbar";
    const title = document.createElement("h2");
    title.textContent = `Pi Engineering Missions (${snap.missions.length})`;
    heading.append(title, renderFreshness(snap.generatedAt));
    this.append(heading);
    for (const mission of snap.missions) {
      this.append(renderMissionNode(mission));
    }
  }
}

function workspaceContextKey(ctx: WorkspacePanelContext): string {
  return JSON.stringify([
    ctx.machine.id,
    ctx.workspace.projectId,
    ctx.workspace.id,
    ctx.workspace.path,
  ]);
}

function renderLoading(): HTMLElement {
  const message = document.createElement("p");
  message.setAttribute("role", "status");
  message.setAttribute("aria-live", "polite");
  message.textContent = "Loading Pi Engineering missions…";
  return message;
}

function renderError(error: unknown, retained: boolean): HTMLElement {
  const message = document.createElement("p");
  message.setAttribute("role", "alert");
  message.className = "pi-eng-bad";
  const detail = error instanceof Error ? error.message : "The Pi Engineering mission snapshot could not be read.";
  message.textContent = retained ? `${detail} Showing the last known snapshot.` : detail;
  return message;
}

function renderFreshness(generatedAt: string): HTMLElement {
  const status = document.createElement("div");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.setAttribute("aria-atomic", "true");
  const age = Date.now() - Date.parse(generatedAt);
  const p = document.createElement("p");
  p.className = "muted";
  p.append("Snapshot updated ", renderTime(generatedAt));
  status.append(p);
  if (Number.isFinite(age) && age > STALE_AFTER_MS) {
    const stale = document.createElement("p");
    stale.className = "pi-eng-idle";
    stale.textContent = `Snapshot is stale (${formatDuration(age)} old). Live mission state may be delayed.`;
    status.append(stale);
  }
  return status;
}

function renderTime(value: string): HTMLTimeElement {
  const time = document.createElement("time");
  time.dateTime = value;
  const date = new Date(value);
  time.textContent = Number.isNaN(date.getTime()) ? value : date.toLocaleString();
  return time;
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function readable(value: string): string {
  return value.replaceAll("_", " ");
}

function renderMissionNode(mission: MissionSnapshotMission): HTMLElement {
  const section = document.createElement("section");
  section.className = "viewer";
  section.style.borderTop = "1px solid var(--color-border, #ddd)";
  section.style.padding = "8px 0";

  const head = document.createElement("h3");
  const status = document.createElement("span");
  status.className = statusClass(mission.status);
  status.textContent = mission.status;
  head.append(`${mission.title} `, status);
  section.append(head);

  const meta = document.createElement("p");
  meta.className = "muted";
  meta.textContent = `${mission.workflowClass} · risk ${mission.riskProfile} · gates: ${mission.requiredGates.join(", ") || "none"}`;
  section.append(meta);

  const goal = document.createElement("p");
  goal.textContent = mission.goal;
  section.append(goal);

  if (mission.observability) {
    section.append(renderObservability(mission.observability));
  }

  const done = mission.tasks.filter((t) => t.status === "SUCCEEDED").length;
  const tasks = document.createElement("p");
  tasks.textContent = `Tasks: ${done}/${mission.tasks.length} succeeded`;
  section.append(tasks);

  for (const f of mission.findings.filter((f) => f.severity === "blocking" && f.status === "open")) {
    const li = document.createElement("p");
    li.style.color = "var(--color-error, #c0392b)";
    li.textContent = `⛔ ${f.summary}`;
    section.append(li);
  }

  const list = document.createElement("ul");
  for (const t of mission.tasks) {
    const item = document.createElement("li");
    const s = document.createElement("span");
    s.className = statusClass(t.status);
    s.textContent = t.status;
    item.append(s, ` ${t.role}: ${t.objective}`);
    list.append(item);
  }
  section.append(list);
  return section;
}

function renderObservability(obs: MissionObservabilitySnapshot): HTMLElement {
  const container = document.createElement("div");

  const currentHeading = document.createElement("h4");
  currentHeading.textContent = "Current work";
  const objective = document.createElement("p");
  objective.append(label("Objective: "), obs.currentObjective ?? "Not reported");
  const activity = document.createElement("p");
  activity.append(label("Activity: "));
  if (obs.currentActivity) {
    activity.append(`${readable(obs.currentActivity.type)} — ${obs.currentActivity.summary}`);
    if (obs.currentActivity.workerId) activity.append(` · ${obs.currentActivity.workerId}`);
    if (obs.currentActivity.file) activity.append(` · ${obs.currentActivity.file}`);
    if (obs.currentActivity.command) activity.append(` · ${obs.currentActivity.command}`);
  } else {
    activity.append("Not reported");
  }
  container.append(currentHeading, objective, activity);

  const health = document.createElement("p");
  health.append(
    label("State: "),
    `${readable(obs.health)} · ${readable(obs.completionStatus)}`,
  );
  health.className = statusClass(obs.health.toUpperCase());
  container.append(health);

  if (obs.lastHeartbeatAt || obs.lastMeaningfulProgressAt) {
    const timing = document.createElement("p");
    timing.className = "muted";
    if (obs.lastHeartbeatAt) timing.append(label("Last heartbeat: "), renderTime(obs.lastHeartbeatAt));
    if (obs.lastHeartbeatAt && obs.lastMeaningfulProgressAt) timing.append(" · ");
    if (obs.lastMeaningfulProgressAt) {
      timing.append(label("Last meaningful progress: "), renderTime(obs.lastMeaningfulProgressAt));
    }
    container.append(timing);
  }

  if (obs.waitingReason) {
    const waiting = document.createElement("p");
    waiting.append(label("Waiting: "), readable(obs.waitingReason));
    container.append(waiting);
  }

  const workersHeading = document.createElement("h4");
  workersHeading.textContent = "Workers";
  const counts = document.createElement("p");
  counts.textContent = `${obs.workers.active} active · ${obs.workers.waiting} waiting · ${obs.workers.failed} failed`;
  const workers = document.createElement("ul");
  for (const worker of obs.workerDetails) {
    const item = document.createElement("li");
    const state = document.createElement("span");
    state.className = statusClass(worker.state.toUpperCase());
    state.textContent = readable(worker.state);
    item.append(
      label(worker.workerId),
      " — ",
      state,
      worker.currentActivity ? ` · ${worker.currentActivity}` : "",
      worker.taskId ? ` · task ${worker.taskId}` : "",
      worker.runtime ? ` · runtime ${worker.runtime}` : "",
      worker.model ? ` · model ${worker.model}` : "",
      worker.host ? ` @ ${worker.host}` : "",
    );
    if (worker.startedAt) item.append(" · started ", renderTime(worker.startedAt));
    if (worker.endedAt) item.append(" · ended ", renderTime(worker.endedAt));
    if (worker.lastHeartbeatAt) item.append(" · heartbeat ", renderTime(worker.lastHeartbeatAt));
    if (worker.lastMeaningfulProgressAt) item.append(" · progress ", renderTime(worker.lastMeaningfulProgressAt));
    if (worker.tokensPerSec !== undefined) item.append(` · ${worker.tokensPerSec} tokens/s`);
    if (worker.noProgressSince) item.append(" · No progress since ", renderTime(worker.noProgressSince));
    const loopSignals = [
      `reads ${worker.repeatedFileReads}`,
      `tools ${worker.repeatedToolCalls}`,
      `errors ${worker.repeatedErrors}`,
      `cycles ${worker.repeatedCycles}`,
    ];
    if (worker.repeatedFileReads + worker.repeatedToolCalls + worker.repeatedErrors + worker.repeatedCycles > 0) {
      item.append(` · ${loopSignals.join(" · ")}`);
    }
    workers.append(item);
  }
  if (obs.workerDetails.length === 0) workers.append(emptyItem("No worker details reported"));
  container.append(workersHeading, counts, workers);

  const activityHeading = document.createElement("h4");
  activityHeading.textContent = "Recent activity";
  const activityList = document.createElement("ol");
  for (const record of obs.activity.slice(-10).reverse()) {
    const item = document.createElement("li");
    item.append(renderTime(record.at), ` · ${readable(record.type)} · ${record.summary}`);
    item.append(record.meaningfulProgress ? " · meaningful progress" : " · no meaningful progress");
    if (record.workerId) item.append(` (${record.workerId})`);
    if (record.file) item.append(` · ${record.file}`);
    if (record.command) item.append(` · ${record.command}`);
    activityList.append(item);
  }
  if (obs.activity.length === 0) activityList.append(emptyItem("No recent activity reported"));
  container.append(activityHeading, activityList);

  container.append(renderTests(obs.tests));
  container.append(renderReview(obs.review));
  container.append(renderErrorsAndRecovery(obs));
  container.append(renderChanges(obs.changes));
  container.append(renderArtifacts(obs.artifacts));

  const progressHeading = document.createElement("h4");
  progressHeading.textContent = "Approximate progress";
  const progress = document.createElement("progress");
  progress.max = 100;
  progress.value = obs.progress.approximatePercent;
  progress.setAttribute("aria-label", "Approximate mission progress");
  const progressText = document.createElement("span");
  progressText.textContent = ` ${progress.value}% · ${readable(obs.progress.basis)}${obs.progress.verifiedComplete ? " · verified complete" : ""}`;
  container.append(progressHeading, progress, progressText);
  const history = document.createElement("ol");
  history.setAttribute("aria-label", "Progress history");
  for (const point of obs.progressHistory.slice(-10).reverse()) {
    const item = document.createElement("li");
    item.append(renderTime(point.at), ` · ${point.approximatePercent}%${point.label ? ` · ${point.label}` : ""}`);
    history.append(item);
  }
  if (obs.progressHistory.length === 0) history.append(emptyItem("No progress history reported"));
  container.append(history);

  return container;
}

function renderReview(review: MissionObservabilitySnapshot["review"]): HTMLElement {
  const section = document.createElement("section");
  const heading = document.createElement("h4");
  heading.textContent = "Review";
  const summary = document.createElement("p");
  summary.textContent = `${readable(review.status)} · ${review.blockingOpen} blocking open`;
  const list = document.createElement("ul");
  for (const finding of review.findings) {
    const item = document.createElement("li");
    item.className = finding.severity === "blocking" && finding.status === "open" ? "pi-eng-bad" : "";
    item.textContent = `#${finding.id} · ${readable(finding.severity)} · ${readable(finding.status)} · ${finding.summary}${finding.repaired ? " · repaired" : ""}`;
    list.append(item);
  }
  if (review.findings.length === 0) list.append(emptyItem("No review findings reported"));
  section.append(heading, summary, list);
  return section;
}

function renderChanges(changes: MissionObservabilitySnapshot["changes"]): HTMLElement {
  const section = document.createElement("section");
  const heading = document.createElement("h4");
  heading.textContent = "Changes";
  const summary = document.createElement("p");
  summary.append(label("Integration: "), readable(changes.integrationState));
  if (changes.branch) summary.append(" · ", label("Branch: "), changes.branch);
  if (changes.worktree) summary.append(" · ", label("Worktree: "), changes.worktree);
  const list = document.createElement("ul");
  for (const file of changes.changedFiles) {
    const item = document.createElement("li");
    item.textContent = `Changed file · ${file}`;
    list.append(item);
  }
  for (const commit of changes.commits) {
    const item = document.createElement("li");
    item.textContent = `Commit · ${commit}`;
    list.append(item);
  }
  if (changes.changedFiles.length === 0 && changes.commits.length === 0) list.append(emptyItem("No changes reported"));
  section.append(heading, summary, list);
  return section;
}

function renderArtifacts(artifacts: string[]): HTMLElement {
  const section = document.createElement("section");
  const heading = document.createElement("h4");
  heading.textContent = "Artifacts";
  const list = document.createElement("ul");
  for (const artifact of artifacts) {
    const item = document.createElement("li");
    item.textContent = artifact;
    list.append(item);
  }
  if (artifacts.length === 0) list.append(emptyItem("No artifacts reported"));
  section.append(heading, list);
  return section;
}

function renderTests(tests: MissionObservabilitySnapshot["tests"]): HTMLElement {
  const section = document.createElement("section");
  const heading = document.createElement("h4");
  heading.textContent = "Tests";
  const summary = document.createElement("p");
  summary.textContent = `${tests.running ? "Running · " : ""}${tests.completed}/${tests.total} complete · ${tests.passed} passed · ${tests.failed} failed · ${tests.skipped} skipped`;
  section.append(heading, summary);
  if (tests.failures.length > 0) {
    const list = document.createElement("ul");
    for (const failure of tests.failures) {
      const item = document.createElement("li");
      item.className = "pi-eng-bad";
      item.textContent = failure;
      list.append(item);
    }
    section.append(list);
  }
  return section;
}

function renderErrorsAndRecovery(obs: MissionObservabilitySnapshot): HTMLElement {
  const section = document.createElement("section");
  const heading = document.createElement("h4");
  heading.textContent = "Errors and recovery";
  section.append(heading);

  const list = document.createElement("ul");
  for (const error of obs.errors) {
    const item = document.createElement("li");
    item.className = "pi-eng-bad";
    item.append(
      `key ${error.key} · first `,
      renderTime(error.firstAt),
      " · last ",
      renderTime(error.lastAt),
      ` · ${error.example} (${error.count} occurrences)`,
    );
    list.append(item);
  }
  for (const recovery of obs.recovery) {
    const item = document.createElement("li");
    item.append(
      `recovery ${recovery.attempt} · action ${recovery.action} · started `,
      renderTime(recovery.startedAt),
    );
    if (recovery.completedAt) item.append(" · completed ", renderTime(recovery.completedAt));
    item.append(` · ${recovery.summary} · ${readable(recovery.status)}`);
    list.append(item);
  }
  if (obs.errors.length === 0 && obs.recovery.length === 0) list.append(emptyItem("No errors or recovery attempts reported"));
  section.append(list);
  return section;
}

function label(text: string): HTMLElement {
  const strong = document.createElement("strong");
  strong.textContent = text;
  return strong;
}

function emptyItem(text: string): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "muted";
  item.textContent = text;
  return item;
}

if (typeof customElements !== "undefined" && !customElements.get("pi-eng-missions-panel")) {
  customElements.define("pi-eng-missions-panel", MissionsPanel);
}
