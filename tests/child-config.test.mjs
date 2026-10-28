import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { childExtensionArgs, childPackages, childToolBlock, childTools } from "../src/child-config.ts";

test("children load only split-work and the two installed extension packages", t => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "split-child-packages-"));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  assert.deepEqual(childPackages, [
    "npm:@xynogen/pix-optimizer", "npm:pi-gpt-search",
  ]);
  const installed = childPackages.map(source => path.join(agentDir, "npm", "node_modules", source.slice(4)));
  for (const dir of installed) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
  }
  assert.deepEqual(childExtensionArgs("/package/src/index.ts", agentDir), [
    "--no-extensions", "--no-mcp", "--extension", "/package/src/index.ts",
    "--extension", installed[0], "--extension", installed[1],
  ]);
  fs.rmSync(installed[0], { recursive: true });
  assert.throws(() => childExtensionArgs("/package/src/index.ts", agentDir), /pi install npm:@xynogen\/pix-optimizer/);
});

test("additive tool selection preserves extension tools and scopes artifact publishing", () => {
  const tools = childTools(false).split(",");
  assert.ok(tools.every(tool => tool.startsWith("+")));
  assert.ok(tools.includes("+split_report"));
  assert.ok(!tools.includes("+split_artifact"));
  assert.ok(childTools(true).split(",").includes("+split_artifact"));
});

test("native and Codex tools keep tracker/documentation guards", () => {
  const cwd = "/project";
  for (const tool of ["read", "edit", "write"])
    assert.ok(childToolBlock(cwd, tool, { path: ".pi/tracker/task/instructions.md" }));
  for (const tool of ["bash", "exec_command", "shell_command"])
    assert.ok(childToolBlock(cwd, tool, { cmd: "cat .pi/tracker/task/state.json" }));
  assert.ok(childToolBlock(cwd, "write_stdin", { chars: "cat .pi/my-agents/coder.md\n" }));
  for (const patch of [
    "*** Begin Patch\n*** Update File: README.md\n@@\n-old\n+new\n*** End Patch",
    "*** Begin Patch\n*** Add File: .pi/tracker/task/result.txt\n+bad\n*** End Patch",
    "*** Begin Patch\n*** Update File: src/ok.ts\n*** Move to: docs/notes.md\n*** End Patch",
  ]) assert.ok(childToolBlock(cwd, "apply_patch", { patch }));
  assert.equal(childToolBlock(cwd, "apply_patch", { patch: "*** Begin Patch\n*** Update File: src/ok.ts\n@@\n-old\n+new\n*** End Patch" }), undefined);
  assert.equal(childToolBlock(cwd, "read", { path: "README.md" }), undefined);
  assert.equal(childToolBlock(cwd, "codex-search", { query: "TypeScript docs" }), undefined);
});
