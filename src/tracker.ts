import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

export type Run = { id?: string; session: string; agent: string; revision: number; status: "running" | "paused" | "done" | "failed"; guidance?: string; overview?: string; tokens?: number; model?: string; think?: string; sessionFile?: string; base?: { name: string; version: number };
  startedAt?: number; endedAt?: number; updatedAt?: number; activity?: string; activitySince?: number; question?: string;
  progress?: string; footerSummary?: string; footerSummaryAt?: number; recent?: { activity: string; durationMs: number }[];
  lastSteering?: { id: string; content: string; revision: number; sentAt: number; status: "sending" | "queued" | "delivered" | "unconfirmed"; deliveredAt?: number } };
export type Task = { id: string; title: string; status: "open" | "running" | "paused" | "review" | "stale" | "blocked" | "archived"; revision: number; runs: Run[]; basePreparation?: { name: string; agent: string } };
export const artifactName = (name: string) => {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(name) || name === "requirements") throw new Error("Invalid artifact folder");
  return name;
};

const text = (value: string) => {
  if (!value?.trim() || value.length > 64_000) throw new Error("Text must be nonempty and at most 64 KB");
  return value.trim() + "\n";
};
const taskDir = (root: string, id: string) => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error("Invalid task ID");
  return path.join(root, id);
};
export const loadTask = (root: string, id: string): Task => JSON.parse(fs.readFileSync(path.join(taskDir(root, id), "state.json"), "utf8"));
export function saveTask(root: string, task: Task) {
  const target = path.join(taskDir(root, task.id), "state.json");
  const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(task, null, 2) + "\n", { flag: "wx" });
    fs.renameSync(tmp, target);
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
export function createTask(root: string, title: string, instructions: string, acceptance: string): Task {
  const slug = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "task";
  if (!title.trim() || title.length > 120) throw new Error("Title must be 1–120 characters");
  const instructionsText = text(instructions), acceptanceText = text(acceptance);
  const id = `${new Date().toISOString().replace(/[-:]/g, "").replace(".", "").slice(0, 18)}Z-${slug}-${randomBytes(3).toString("hex")}`;
  const task: Task = { id, title: title.trim(), status: "open", revision: 0, runs: [] };
  const dir = taskDir(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "instructions.md"), instructionsText, { flag: "wx" });
  fs.writeFileSync(path.join(dir, "acceptance.md"), acceptanceText, { flag: "wx" });
  saveTask(root, task);
  return task;
}
export function appendTaskNote(root: string, id: string, body: string): Task {
  const task = loadTask(root, id);
  if (task.status === "archived") throw new Error("Archived task is immutable");
  const dir = path.join(taskDir(root, id), "requirements");
  const note = text(body);
  fs.mkdirSync(dir, { recursive: true });
  for (let n = 1; ; n++) {
    try {
      fs.writeFileSync(path.join(dir, `${String(n).padStart(4, "0")}.md`), note, { flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  task.revision++;
  if (task.status !== "running") task.status = "stale";
  saveTask(root, task);
  return task;
}
export function appendArtifact(root: string, id: string, folder: string, body: string): string {
  const task = loadTask(root, id);
  if (task.status === "archived") throw new Error("Archived task is immutable");
  const dir = path.join(taskDir(root, id), artifactName(folder));
  const note = text(body);
  fs.mkdirSync(dir, { recursive: true });
  for (let n = 1; ; n++) {
    const filename = `${String(n).padStart(4, "0")}.md`;
    try { fs.writeFileSync(path.join(dir, filename), note, { flag: "wx" }); return `${folder}/${filename}`; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
}
export function pauseRunningTasks(root: string): Task[] {
  const paused: Task[] = [];
  for (const task of listTasks(root)) {
    if (task.status !== "running") continue;
    task.status = "paused";
    const run = task.runs.at(-1);
    if (run?.status === "running") {
      run.status = "paused"; run.endedAt = Date.now();
      if (run.lastSteering && run.lastSteering.status !== "delivered") run.lastSteering.status = "unconfirmed";
    }
    saveTask(root, task);
    paused.push(task);
  }
  return paused;
}
export function taskContext(root: string, id: string, includeArtifacts = true): string {
  const dir = taskDir(root, id);
  const folders = fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && (entry.name === "requirements" || (includeArtifacts && /^[a-z][a-z0-9-]{0,39}$/.test(entry.name))))
    .map(entry => entry.name).sort((a, b) => a === "requirements" ? -1 : b === "requirements" ? 1 : a.localeCompare(b));
  const parts = ["instructions.md", "acceptance.md", ...folders.flatMap(folder =>
    fs.readdirSync(path.join(dir, folder)).filter(name => /^\d+\.md$/.test(name)).sort().map(name => `${folder}/${name}`))];
  const result = parts.map(name => `# ${name}\n${fs.readFileSync(path.join(dir, name), "utf8")}`).join("\n");
  if (result.length > 32_000) throw new Error("Task context exceeds 32 KB; archive or split task");
  return result;
}
export function resetTracker(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}
export function listTasks(root: string): Task[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory())
    .flatMap(entry => { try { return [loadTask(root, entry.name)]; } catch { return []; } })
    .sort((a, b) => b.id.localeCompare(a.id));
}
