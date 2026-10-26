import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  appendArtifact, appendTaskNote, artifactName, createTask, listTasks,
  loadTask, pauseRunningTasks, resetTracker, saveTask, taskContext,
} from "../src/tracker.ts";

function fixture(t) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "numfin-split-work-"));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const root = path.join(project, ".pi/tracker");
  const task = createTask(root, "Small task", "Change only the assigned file.", "Targeted tests pass.");
  return { project, root, task };
}

test("creates bounded task context and appends requirements without rewriting instructions", t => {
  const { root, task } = fixture(t);
  const instructions = fs.readFileSync(path.join(root, task.id, "instructions.md"), "utf8");
  appendTaskNote(root, task.id, "Preserve existing API.");
  appendTaskNote(root, task.id, "Add one regression test.");
  assert.equal(loadTask(root, task.id).revision, 2);
  assert.equal(loadTask(root, task.id).status, "stale");
  assert.equal(fs.readFileSync(path.join(root, task.id, "instructions.md"), "utf8"), instructions);
  assert.match(taskContext(root, task.id), /requirements\/0001\.md/);
  assert.match(taskContext(root, task.id), /requirements\/0002\.md/);
});

test("numbers custom artifacts and excludes them from child context", t => {
  const { root, task } = fixture(t);
  assert.equal(appendArtifact(root, task.id, "reviews", "One blocker."), "reviews/0001.md");
  assert.equal(appendArtifact(root, task.id, "reviews", "Approved."), "reviews/0002.md");
  assert.match(taskContext(root, task.id), /One blocker/);
  assert.doesNotMatch(taskContext(root, task.id, false), /One blocker/);
  assert.throws(() => artifactName("../escape"));
  assert.throws(() => artifactName("requirements"));
});

test("recovers interrupted runs and flags undelivered steering", t => {
  const { root, task } = fixture(t);
  task.status = "running";
  task.runs.push({
    id: "run-1", session: "persistent-session", agent: "coder", revision: 0,
    status: "running", startedAt: Date.now(),
    lastSteering: { id: "steer-1", content: "Focus.", revision: 0, sentAt: Date.now(), status: "queued" },
  });
  saveTask(root, task);
  assert.equal(pauseRunningTasks(root).length, 1);
  const recovered = loadTask(root, task.id);
  assert.equal(recovered.status, "paused");
  assert.equal(recovered.runs[0].session, "persistent-session");
  assert.equal(recovered.runs[0].lastSteering.status, "unconfirmed");
  assert.equal(pauseRunningTasks(root).length, 0);
});

test("archived tasks reject notes and artifacts", t => {
  const { root, task } = fixture(t);
  task.status = "archived";
  saveTask(root, task);
  assert.throws(() => appendTaskNote(root, task.id, "Late change."), /immutable/);
  assert.throws(() => appendArtifact(root, task.id, "reviews", "Late review."), /immutable/);
  assert.throws(() => loadTask(root, "../escape"), /Invalid task ID/);
});

test("reset deletes tracker but preserves sibling agent definitions", t => {
  const { project, root } = fixture(t);
  const agents = path.join(project, ".pi/my-agents");
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, "coder.md"), "Agent fixture.");
  assert.equal(listTasks(root).length, 1);
  resetTracker(root);
  assert.deepEqual(listTasks(root), []);
  assert.equal(fs.readFileSync(path.join(agents, "coder.md"), "utf8"), "Agent fixture.");
});
