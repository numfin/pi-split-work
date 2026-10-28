import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import split from "../../src/index.ts";
import { createTask, saveTask } from "../../src/tracker.ts";

export default function (real: any) {
  real.on("session_start", async (_event: any, realCtx: any) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "split-widget-test-"));
    const handlers = new Map(), commands = new Map(), tools = new Map();
    let active = ["read", "bash"], widget: any, footerCalls = 0, removals = 0, renders = 0;
    const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
    const dir = path.join(cwd, ".pi/tracker");
    const task = createTask(dir, "Unicode 文档 task", "Test.", "Test.");
    task.status = "paused";
    task.runs.push({ session: "session-test", agent: "coder", revision: 0, status: "paused" });
    saveTask(dir, task);
    const ctx: any = { cwd, mode: "tui", sessionManager: { getBranch: () => [] },
      modelRegistry: { getAvailable: () => [] },
      ui: {
        setStatus() {}, notify() {},
        setFooter() { footerCalls++; throw new Error("Base footer was replaced"); },
        setWidget(key: string, factory: any, options: any) {
          assert(key === "split-work-tasks" && options?.placement === "belowEditor", "Incorrect widget slot");
          widget?.dispose?.(); widget = undefined;
          if (factory) widget = factory({ requestRender() { renders++; } }, { fg: (_c: string, text: string) => text });
          else removals++;
        },
      },
    };
    let started = false;
    try {
      split({ on: (name: string, handler: any) => handlers.set(name, handler),
        registerTool: (tool: any) => tools.set(tool.name, tool),
        registerCommand: (name: string, command: any) => commands.set(name, command),
        getActiveTools: () => active, setActiveTools: (names: string[]) => active = names, appendEntry() {} } as any);
      handlers.get("session_start")({}, ctx); started = true;
      assert(widget?.render(80).some((line: string) => line.includes("[coder]: Unicode 文档 task [paused]")), "Missing paused task");
      for (const width of [1, 8, 20, 80])
        assert(widget.render(width).every((line: string) => visibleWidth(line) <= width), `Line exceeds ${width}`);
      await commands.get("split").handler("on", ctx);
      await commands.get("split").handler("off", ctx);
      assert(widget && footerCalls === 0, "Toggle replaced footer or hid task");
      await commands.get("split").handler("on", ctx);
      await tools.get("split_work").execute("test", { action: "archive", id: task.id }, undefined, undefined, ctx);
      assert(!widget && removals === 1, "Widget not removed when last task archived");
      assert(footerCalls === 0 && renders > 0, "Footer touched or render not requested");
      console.log("WIDGET_TEST_PASS");
    } catch (error) { console.error("WIDGET_TEST_FAIL", error); process.exitCode = 1; }
    finally {
      if (started) handlers.get("session_shutdown")({}, ctx);
      fs.rmSync(cwd, { recursive: true, force: true });
      realCtx.shutdown();
    }
  });
}
