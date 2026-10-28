import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const probe = spawnSync("pi", ["--version"], { encoding: "utf8", timeout: 5000 });
test("task widget leaves the base footer intact across mode changes and archive", { skip: probe.error?.code === "ENOENT" }, () => {
  const fixture = fileURLToPath(new URL("./fixtures/widget-integration.ts", import.meta.url));
  const result = spawnSync("pi", ["--no-extensions", "--no-mcp", "--extension", fixture, "--mode", "rpc", "--no-session", "--offline"],
    { encoding: "utf8", timeout: 15000, env: { ...process.env, PI_SPLIT_CHILD: "0" } });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, /WIDGET_TEST_PASS/);
});
