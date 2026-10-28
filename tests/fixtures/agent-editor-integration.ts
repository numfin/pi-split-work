import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import split from "../../src/index.ts";
import { createTask, saveTask } from "../../src/tracker.ts";

export default function (real: any) {
  real.on("session_start", async (_event: any, realCtx: any) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "split-agent-edit-test-"));
    const handlers = new Map(), commands = new Map(), tools = new Map();
    let active = ["read", "bash"], started = false;
    const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
    try {
      const agentDir = path.join(cwd, ".pi/my-agents"); fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, "coder.md"), `---\ndescription: Coder\nmodels:\n  - model: provider/old\n    think: low\nextra: keep\nartifact: notes\n---\nOriginal role.\n`);
      const dir = path.join(cwd, ".pi/tracker");
      const task = createTask(dir, "Running task", "Test.", "Test.");
      task.status = "running"; task.runs.push({ session: "active", agent: "coder", revision: 0, status: "running" }); saveTask(dir, task);
      const ctx: any = { cwd, mode: "json", sessionManager: { getBranch: () => [] }, ui: { setStatus() {}, notify() {} } };
      split({ on: (name: string, handler: any) => handlers.set(name, handler),
        registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: (name: string, command: any) => commands.set(name, command),
        getActiveTools: () => active, setActiveTools: (names: string[]) => active = names, appendEntry() {} } as any);
      handlers.get("session_start")({}, ctx); started = true;
      // Simulate an agent running after session_start recovery.
      task.status = "running"; task.runs[0].status = "running"; saveTask(dir, task);
      await commands.get("split").handler("on", ctx);
      const call = async (params: any) => JSON.parse((await tools.get("split_work").execute("test", params, undefined, undefined, ctx)).content[0].text);
      const before = await call({ action: "inspect_agent", name: "coder" });
      assert(before.runningTasks.includes(task.id), "Running task not reported");
      const changed = await call({ action: "edit_agent", name: "coder", expectedRevision: before.revision,
        models: [{ model: "provider/new", think: "high" }], body: "Updated role.", clearArtifact: true });
      assert(changed.changed && changed.runningTasks.includes(task.id), "Change not reported");
      const after = await call({ action: "inspect_agent", name: "coder" });
      assert(after.frontmatter.extra === "keep" && after.frontmatter.models[0].model === "provider/new", "YAML fields not preserved");
      assert(after.frontmatter.artifact === undefined && after.body.trim() === "Updated role.", "Changes not applied");
      assert((await call({ action: "agents" }))[0].model === "provider/new", "Agent discovery broke");
      let stale = false;
      try { await call({ action: "edit_agent", name: "coder", expectedRevision: before.revision, body: "Stale." }); } catch { stale = true; }
      assert(stale, "Stale edit accepted");
      console.log("AGENT_EDIT_TEST_PASS");
    } catch (error) { console.error("AGENT_EDIT_TEST_FAIL", error); process.exitCode = 1; }
    finally {
      if (started) handlers.get("session_shutdown")({}, { cwd, mode: "json", ui: { setStatus() {} } });
      fs.rmSync(cwd, { recursive: true, force: true }); realCtx.shutdown();
    }
  });
}
