import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import { readSplitConfig, splitConfigPath, summaryConfig, updateSplitConfig } from "../src/mode-config.ts";

test("legacy mode files default to summary off; toggling mode preserves summary settings", t => {
  const cwd = fs.mkdtempSync(os.tmpdir() + "/split-config-");
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  assert.deepEqual(summaryConfig(readSplitConfig(cwd).summary), { enabled: false, reasoning: "off" });
  const summary = { enabled: true, provider: "test", model: "small", intervalSeconds: 30, reasoning: "low" };
  updateSplitConfig(cwd, { enabled: true, summary, extra: "preserved" });
  updateSplitConfig(cwd, { enabled: false });
  assert.deepEqual(readSplitConfig(cwd), { enabled: false, summary, extra: "preserved" });
  updateSplitConfig(cwd, { summary: { ...summary, enabled: false } });
  assert.equal(readSplitConfig(cwd).enabled, false);
  fs.writeFileSync(splitConfigPath(cwd), "{invalid");
  assert.throws(() => updateSplitConfig(cwd, { enabled: true }), /Cannot read/);
  assert.equal(fs.readFileSync(splitConfigPath(cwd), "utf8"), "{invalid");
});

test("enabling requires exact model and bounded period, with configurable reasoning", () => {
  assert.throws(() => summaryConfig({ enabled: true }), /needs provider/);
  const valid = { enabled: true, provider: "test", model: "family/model", intervalSeconds: 30, reasoning: "low" };
  assert.deepEqual(summaryConfig(valid), valid);
  for (const intervalSeconds of [0, -1, 0.5, "30", 86401])
    assert.throws(() => summaryConfig({ ...valid, intervalSeconds }), /integer/);
  assert.throws(() => summaryConfig({ ...valid, reasoning: "invalid" }), /reasoning/);
  assert.throws(() => summaryConfig({ ...valid, provider: "provider/model" }), /provider/);
  assert.throws(() => summaryConfig({ ...valid, enabled: "true" }), /boolean/);
});
