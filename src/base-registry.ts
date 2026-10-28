import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes, createHash } from "node:crypto";

export type BaseVersion = { name: string; version: number; task: string; agent: string; session: string; sessionFile: string; sha256: string; createdAt: string; model?: string; think?: string };
export function baseName(value: string): string {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(value)) throw new Error("Base name must be lowercase letters, digits or hyphens, starting with a letter");
  return value;
}
const folder = (cwd: string, name: string) => path.join(cwd, ".pi", "split-bases", baseName(name));
export const sessionHash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
export function listBases(cwd: string): BaseVersion[] {
  const root = path.join(cwd, ".pi", "split-bases");
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && /^[a-z][a-z0-9-]{0,39}$/.test(e.name)).flatMap(e => {
    const dir = path.join(root, e.name);
    return fs.readdirSync(dir).filter(n => /^\d{6}\.json$/.test(n)).flatMap(n => {
      try {
        const value = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
        if (value.name !== e.name || value.version !== Number(n.slice(0, -5)) || typeof value.sessionFile !== "string" || typeof value.sha256 !== "string") return [];
        return [value as BaseVersion];
      } catch { return []; }
    });
  }).sort((a, b) => a.name.localeCompare(b.name) || b.version - a.version);
}
export function resolveBase(cwd: string, name: string, version?: number): BaseVersion {
  baseName(name);
  const found = listBases(cwd).find(b => b.name === name && (version === undefined || b.version === version));
  if (!found) throw new Error(`No published base ${name}${version ? ` version ${version}` : ""}`);
  return found;
}
export function publishBase(cwd: string, data: Omit<BaseVersion, "version" | "createdAt" | "sha256">): BaseVersion {
  const dir = folder(cwd, data.name);
  if (!path.isAbsolute(data.sessionFile) || !fs.statSync(data.sessionFile).isFile()) throw new Error("Base session file unavailable");
  const sha256 = sessionHash(data.sessionFile);
  fs.mkdirSync(dir, { recursive: true });
  for (let version = 1; version <= 999999; version++) {
    const target = path.join(dir, `${String(version).padStart(6, "0")}.json`);
    const value = { ...data, version, sha256, createdAt: new Date().toISOString() };
    const tmp = path.join(dir, `.${randomBytes(8).toString("hex")}.tmp`);
    try {
      fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      fs.linkSync(tmp, target);
      return value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  }
  throw new Error("Too many base versions");
}
