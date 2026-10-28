import * as path from "node:path";
import * as fs from "node:fs";

// Explicit allowlist: never inherit every controller extension.
export const childPackages = [
  "npm:@xynogen/pix-optimizer",
  "npm:pi-gpt-search",
] as const;

export function childExtensionArgs(extensionPath: string, agentDir: string): string[] {
  // With --no-extensions, npm: CLI sources are not loaded by Pi 1.4.
  // Explicit installed package directories still load, without enabling discovery.
  const packages = childPackages.map(source => {
    const installed = path.join(agentDir, "npm", "node_modules", source.slice(4));
    if (!fs.existsSync(path.join(installed, "package.json")))
      throw new Error(`Required subagent extension missing: ${source}. Install it with: pi install ${source}`);
    return installed;
  });
  return ["--no-extensions", "--no-mcp", "--extension", extensionPath,
    ...packages.flatMap(installed => ["--extension", installed])];
}

export function childTools(withArtifacts: boolean): string {
  // Additive selection preserves tools registered by the allowed packages.
  return ["read", "bash", "edit", "write", "split_report", ...(withArtifacts ? ["split_artifact"] : [])]
    .map(name => `+${name}`).join(",");
}

function protectedPath(cwd: string, file: string, writing: boolean): boolean {
  const target = path.resolve(cwd, file), root = path.join(cwd, ".pi");
  return target === path.join(root, "split-mode.json") ||
    ["tracker", "my-agents"].some(folder =>
      target === path.join(root, folder) || target.startsWith(path.join(root, folder) + path.sep)) ||
    (writing && /\.md$/i.test(target));
}

export function childToolBlock(cwd: string, tool: string, input: Record<string, unknown>): string | undefined {
  // File guards are not an OS/shell sandbox. Only run trusted agents.
  const reason = "Use split_artifact for artifacts; ask controller for task context. No direct tracker or documentation edits.";
  if (["read", "edit", "write"].includes(tool) && typeof input.path === "string" &&
      protectedPath(cwd, input.path, tool !== "read")) return reason;
  if (tool === "apply_patch") {
    const patch = String(input.patch ?? input.input ?? "");
    for (const match of patch.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)\r?$/gm))
      if (protectedPath(cwd, match[1].trim(), true)) return reason;
  }
  if (["bash", "exec_command", "shell_command", "write_stdin"].includes(tool) &&
      /\.pi[\\/](?:tracker|my-agents)/.test(String(input.command ?? input.cmd ?? input.chars ?? "")))
    return "Ask controller for task context; do not access tracker files.";
  return undefined;
}
