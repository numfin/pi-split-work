import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { agentRevision, editAgentFile, renderAgentEdit } from "../src/agent-editor.ts";

const source = `---
description: Old role
model: provider/old
think: low
custom:
  nested: keep
artifact: reviews
---
Original body.\n`;

test("edits models without losing unknown metadata or body", () => {
  const updated = renderAgentEdit(source, { models: [{ model: "provider/new", think: "high" }, { model: "other/x", think: "low" }] });
  assert.match(updated, /custom:\n  nested: keep/);
  assert.match(updated, /models: \[{"model":"provider\/new","think":"high"}/);
  assert.doesNotMatch(updated, /^model:|^think:/m);
  assert.match(updated, /artifact: reviews/);
  assert.ok(updated.endsWith("Original body.\n"));
});

test("single model conversion, artifact removal and body replacement", () => {
  const multi = renderAgentEdit(source, { models: [{ model: "provider/new", think: "high" }] });
  const updated = renderAgentEdit(multi, { model: "provider/one", think: "low", clearArtifact: true, body: "New instructions." });
  assert.match(updated, /model: "provider\/one"\nthink: low/);
  assert.doesNotMatch(updated, /^models:|^artifact:/m);
  assert.ok(updated.endsWith("New instructions.\n"));
});

test("rejects invalid, ambiguous or empty changes", () => {
  for (const patch of [{}, { model: "provider/x" }, { models: [] }, { description: "a\nb" }, { body: "  " },
    { artifact: "../escape" }, { artifact: "reviews", clearArtifact: true }, { models: [{ model: "p/m", think: "low" }], model: "p/m" }])
    assert.throws(() => renderAgentEdit(source, patch));
  assert.throws(() => renderAgentEdit("no frontmatter", { body: "yes" }), /frontmatter/);
  assert.throws(() => renderAgentEdit(source.replace("think: low", "think: low\nthink: high"), { body: "yes" }), /Duplicate/);
});

test("requires current revision, validates before atomic replacement and rejects symlinks", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-edit-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "coder.md"); fs.writeFileSync(file, source, { mode: 0o600 });
  const revision = agentRevision(source);
  assert.throws(() => editAgentFile(file, "stale", { body: "bad" }, () => {}), /changed since/);
  assert.throws(() => editAgentFile(file, revision, { body: "bad" }, () => { throw new Error("invalid"); }), /invalid/);
  assert.equal(fs.readFileSync(file, "utf8"), source);
  const result = editAgentFile(file, revision, { description: "New role" }, () => {});
  assert.equal(result.changed, true);
  assert.notEqual(result.revision, revision);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.throws(() => editAgentFile(file, revision, { body: "stale" }, () => {}), /changed since/);
  const symlink = path.join(dir, "link.md"); fs.symlinkSync(file, symlink);
  assert.throws(() => editAgentFile(symlink, result.revision, { body: "bad" }, () => {}), /regular file/);
});
