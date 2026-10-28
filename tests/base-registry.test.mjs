import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { baseName, listBases, publishBase, resolveBase, sessionHash } from "../src/base-registry.ts";

test("publishes immutable numbered versions and resolves latest or pinned", t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "split-bases-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const sessionFile = path.join(cwd, "session.jsonl");
  fs.writeFileSync(sessionFile, "base v1\n");
  const data = { name: "docs", agent: "coder", task: "task-1", session: "s1", sessionFile };
  const first = publishBase(cwd, data);
  fs.writeFileSync(sessionFile, "base v2\n");
  const second = publishBase(cwd, { ...data, task: "task-2", session: "s2" });
  assert.equal(first.version, 1); assert.equal(second.version, 2);
  assert.notEqual(first.sha256, second.sha256);
  assert.equal(resolveBase(cwd, "docs").version, 2);
  assert.deepEqual(resolveBase(cwd, "docs", 1), first);
  assert.equal(listBases(cwd).length, 2);
  assert.equal(sessionHash(sessionFile), second.sha256);
  assert.throws(() => resolveBase(cwd, "docs", 3), /No published base/);
  assert.throws(() => baseName("../escape"));
  assert.throws(() => publishBase(cwd, { ...data, sessionFile: "relative" }), /unavailable/);
});
