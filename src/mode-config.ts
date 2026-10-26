import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

export const reasoningLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type SummaryConfig = {
  enabled: boolean; provider?: string; model?: string; intervalSeconds?: number;
  reasoning: typeof reasoningLevels[number];
};
export const splitConfigPath = (cwd: string) => path.join(cwd, ".pi", "split-mode.json");

export function readSplitConfig(cwd: string): Record<string, unknown> {
  try {
    const config = JSON.parse(fs.readFileSync(splitConfigPath(cwd), "utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Expected a JSON object");
    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Cannot read .pi/split-mode.json: ${String(error)}`);
  }
}

export function updateSplitConfig(cwd: string, patch: Record<string, unknown>) {
  const config = { ...readSplitConfig(cwd), ...patch };
  const target = splitConfigPath(cwd), temp = `${target}.${randomBytes(4).toString("hex")}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try { fs.writeFileSync(temp, JSON.stringify(config, null, 2) + "\n", { flag: "wx" }); fs.renameSync(temp, target); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

export function summaryConfig(raw: unknown): SummaryConfig {
  if (raw === undefined) return { enabled: false, reasoning: "off" };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("summary must be an object");
  const c = raw as Record<string, unknown>;
  const reasoning = c.reasoning ?? "off";
  if (!reasoningLevels.includes(reasoning as SummaryConfig["reasoning"])) throw new Error("Invalid summary reasoning level");
  if (c.enabled !== undefined && typeof c.enabled !== "boolean") throw new Error("summary.enabled must be boolean");
  if (c.provider !== undefined && (typeof c.provider !== "string" || !/^[^\s/]+$/.test(c.provider))) throw new Error("Invalid summary provider");
  if (c.model !== undefined && (typeof c.model !== "string" || !/^\S+$/.test(c.model))) throw new Error("Invalid summary model");
  if (c.intervalSeconds !== undefined && (!Number.isInteger(c.intervalSeconds) || Number(c.intervalSeconds) < 1 || Number(c.intervalSeconds) > 86400))
    throw new Error("summary.intervalSeconds must be an integer from 1 to 86400");
  if (c.enabled && (!c.provider || !c.model || c.intervalSeconds === undefined))
    throw new Error("Summary needs provider, model and intervalSeconds");
  return { enabled: c.enabled === true, provider: c.provider as string | undefined, model: c.model as string | undefined,
    intervalSeconds: c.intervalSeconds as number | undefined, reasoning: reasoning as SummaryConfig["reasoning"] };
}
