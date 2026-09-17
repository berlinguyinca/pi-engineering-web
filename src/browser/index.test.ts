import { describe, expect, it } from "vitest";
import { readSnapshot, statusClass } from "./index.ts";
import type { WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";

function fakeCtx(content: string | null): WorkspacePanelContext {
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
        if (content === null) throw new Error("ENOENT");
        return { content, mediaType: undefined };
      },
      listFiles: async () => ({ entries: [] }),
      writeFile: async () => ({ path: "x", existed: false }),
      deleteFile: async () => ({ existed: false }),
      moveFile: async () => ({ existed: false }),
    },
    host: { requestRender: () => {} },
  } as unknown as WorkspacePanelContext;
}

const SNAPSHOT = {
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

describe("pi-engineering missions browser plugin", () => {
  it("reads and validates the versioned snapshot from the workspace", async () => {
    const ctx = fakeCtx(JSON.stringify(SNAPSHOT));
    const snap = await readSnapshot(ctx);
    expect(snap).not.toBeNull();
    expect(snap!.missions[0]!.title).toBe("Add health endpoint");
    expect(snap!.missions[0]!.requiredGates).toContain("validation");
  });

  it("returns null when the snapshot file is missing", async () => {
    const snap = await readSnapshot(fakeCtx(null));
    expect(snap).toBeNull();
  });

  it("returns null on a contract version mismatch", async () => {
    const ctx = fakeCtx(JSON.stringify({ ...SNAPSHOT, contractVersion: 2 }));
    const snap = await readSnapshot(ctx);
    expect(snap).toBeNull();
  });

  it("returns null on malformed JSON", async () => {
    const snap = await readSnapshot(fakeCtx("not json"));
    expect(snap).toBeNull();
  });

  it("maps statuses to css classes", () => {
    expect(statusClass("COMPLETE")).toBe("pi-eng-ok");
    expect(statusClass("FAILED")).toBe("pi-eng-bad");
    expect(statusClass("EXECUTING")).toBe("pi-eng-run");
    expect(statusClass("PENDING")).toBe("pi-eng-idle");
  });
});
