import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { artifactName } from "./tracker.ts";
import { parseAgentModels } from "./agent-models.ts";

export type AgentEdit = { description?: string; body?: string; model?: string; think?: string; models?: { model: string; think: string }[]; artifact?: string; clearArtifact?: boolean };
export const agentRevision = (text: string) => createHash("sha256").update(text).digest("hex");

/** Update known YAML top-level fields, retaining unknown fields and the original body. */
export function renderAgentEdit(raw: string, patch: AgentEdit): string {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(raw);
  if (!match) throw new Error("Agent file must have YAML frontmatter");
  const updates = new Map<string, string | undefined>();
  if (patch.description !== undefined) {
    if (!patch.description.trim() || /[\r\n]/.test(patch.description)) throw new Error("Description must be nonempty and single-line");
    updates.set("description", `description: ${JSON.stringify(patch.description.trim())}`);
  }
  if (patch.body !== undefined && !patch.body.trim()) throw new Error("Agent body must be nonempty");
  if (patch.models !== undefined && (patch.model !== undefined || patch.think !== undefined)) throw new Error("Specify models or model/think, not both");
  if (patch.models !== undefined || patch.model !== undefined || patch.think !== undefined) {
    const choices = parseAgentModels(patch.models !== undefined ? { models: patch.models } : { model: patch.model, think: patch.think });
    updates.set("model", undefined); updates.set("think", undefined); updates.set("models", undefined);
    if (patch.models !== undefined) updates.set("models", `models: ${JSON.stringify(choices)}`);
    else { updates.set("model", `model: ${JSON.stringify(choices[0].model)}`); updates.set("think", `think: ${choices[0].think}`); }
  }
  if (patch.artifact !== undefined && patch.clearArtifact) throw new Error("Specify artifact or clearArtifact, not both");
  if (patch.artifact !== undefined) updates.set("artifact", `artifact: ${artifactName(patch.artifact)}`);
  if (patch.clearArtifact) updates.set("artifact", undefined);
  if (!updates.size && patch.body === undefined) throw new Error("No changes supplied");
  const lines = match[1].split(/\r?\n/), retained: string[] = [];
  const seen = new Set<string>();
  let skipping = false;
  for (const line of lines) {
    const key = /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s|$)/.exec(line)?.[1];
    if (key) {
      if (seen.has(key)) throw new Error(`Duplicate frontmatter key: ${key}`);
      seen.add(key); skipping = updates.has(key);
    } else if (line && !/^\s/.test(line) && !line.startsWith("#")) {
      throw new Error("Unsupported frontmatter layout; edit agent manually in normal mode");
    }
    if (!skipping || /^\s*(?:#.*)?$/.test(line)) retained.push(line);
  }
  for (const line of updates.values()) if (line !== undefined) retained.push(line);
  const body = patch.body === undefined ? match[2] : patch.body.trim() + "\n";
  return `---\n${retained.join("\n")}\n---\n${body}`;
}

export function editAgentFile(file: string, expectedRevision: string, patch: AgentEdit, validate: (text: string) => void): { revision: string; changed: boolean } {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Agent definition must be a regular file");
  if (stat.size > 128 * 1024) throw new Error("Agent definition exceeds 128 KB");
  const original = fs.readFileSync(file, "utf8");
  if (agentRevision(original) !== expectedRevision) throw new Error("Agent changed since inspection; inspect again before editing");
  const updated = renderAgentEdit(original, patch);
  validate(updated);
  if (updated === original) return { revision: expectedRevision, changed: false };
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(8).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(temp, updated, { flag: "wx", mode: stat.mode & 0o777 });
    if (agentRevision(fs.readFileSync(file, "utf8")) !== expectedRevision) throw new Error("Agent changed during edit; inspect again");
    fs.renameSync(temp, file);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  return { revision: agentRevision(updated), changed: true };
}
