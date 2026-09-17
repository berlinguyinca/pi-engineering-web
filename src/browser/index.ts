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
const CONTRACT_VERSION = 1;

/** Read + validate the versioned snapshot from the workspace files API. */
export async function readSnapshot(ctx: WorkspacePanelContext): Promise<MissionSnapshotFile | null> {
  try {
    const res = await ctx.files.readFile(SNAPSHOT_PATH);
    if (typeof res.content !== "string") return null;
    const parsed = JSON.parse(res.content) as MissionSnapshotFile;
    if (parsed.contractVersion !== CONTRACT_VERSION) return null;
    return parsed;
  } catch {
    return null; // no snapshot yet, or unreadable
  }
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
            void readSnapshot(ctx).then((snap) => {
              if (snap) ctx.host.requestRender();
            });
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

  set ctx(value: WorkspacePanelContext) {
    this._ctx = value;
    void this.load();
  }

  private async load() {
    const ctx = this._ctx;
    if (!ctx) return;
    const snap = await readSnapshot(ctx);
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
    const strong = document.createElement("strong");
    strong.textContent = `Pi Engineering Missions (${snap.missions.length})`;
    heading.append(strong);
    this.append(heading);
    for (const mission of snap.missions) {
      this.append(renderMissionNode(mission));
    }
  }
}

function renderMissionNode(mission: MissionSnapshotMission): HTMLElement {
  const section = document.createElement("section");
  section.className = "viewer";
  section.style.borderTop = "1px solid var(--color-border, #ddd)";
  section.style.padding = "8px 0";

  const head = document.createElement("p");
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

if (typeof customElements !== "undefined" && !customElements.get("pi-eng-missions-panel")) {
  customElements.define("pi-eng-missions-panel", MissionsPanel);
}
