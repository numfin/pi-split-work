import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { randomBytes } from "node:crypto";
import { sessionHash, type BaseVersion } from "./base-registry.ts";

/** Clone a pinned base in a separate, idle Pi process. Never write to the base. */
export async function cloneBase(cwd: string, base: BaseVersion, signal?: AbortSignal): Promise<{ session: string; sessionFile: string }> {
  if (signal?.aborted) throw new Error("Clone cancelled");
  if (!fs.existsSync(base.sessionFile) || sessionHash(base.sessionFile) !== base.sha256) throw new Error("Base session missing or modified; publish a new version");
  const proc = spawn("pi", ["--mode", "rpc", "--no-extensions", "--no-mcp", "--session", base.sessionFile], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  proc.stdout.setEncoding("utf8"); proc.stderr.setEncoding("utf8");
  let buffer = "", stderr = "", closed = false;
  const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const fail = (error: Error) => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); };
  proc.stdout.on("data", chunk => {
    buffer += chunk; const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
    for (const line of lines) {
      let event: any; try { event = JSON.parse(line); } catch { continue; }
      if (event.type !== "response") continue;
      const p = pending.get(event.id); if (!p) continue;
      pending.delete(event.id); clearTimeout(p.timer);
      if (event.success) p.resolve(event.data); else p.reject(new Error(event.error || "Clone RPC failed"));
    }
  });
  proc.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-2000); });
  proc.on("error", error => fail(error));
  proc.stdin.on("error", error => fail(error));
  proc.on("close", code => { closed = true; fail(new Error(`Clone process exited (${code}): ${stderr}`)); });
  const abort = () => { fail(new Error("Clone cancelled")); proc.kill("SIGTERM"); };
  signal?.addEventListener("abort", abort, { once: true });
  const command = (type: string) => new Promise<any>((resolve, reject) => {
    if (closed || signal?.aborted) { reject(new Error("Clone process unavailable")); return; }
    const id = randomBytes(8).toString("hex");
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Clone RPC ${type} timed out`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    proc.stdin.write(JSON.stringify({ id, type }) + "\n", error => {
      if (!error) return; const p = pending.get(id); if (p) { clearTimeout(p.timer); pending.delete(id); p.reject(error); }
    });
  });
  try {
    const source = await command("get_state");
    if (source?.sessionId !== base.session || source?.sessionFile !== base.sessionFile) throw new Error("Pi opened a different base session");
    const result = await command("clone");
    if (result?.cancelled !== false) throw new Error("Clone cancelled or not confirmed");
    const cloned = await command("get_state");
    if (!cloned?.sessionId || !cloned?.sessionFile || cloned.sessionId === base.session || cloned.sessionFile === base.sessionFile)
      throw new Error("Pi did not create an independent session");
    if (sessionHash(base.sessionFile) !== base.sha256) throw new Error("Base session changed during cloning; clone rejected");
    return { session: cloned.sessionId, sessionFile: cloned.sessionFile };
  } finally {
    signal?.removeEventListener("abort", abort);
    proc.stdin.end();
    if (!closed) {
      proc.kill("SIGTERM");
      const timer = setTimeout(() => { if (!closed) proc.kill("SIGKILL"); }, 5000); timer.unref?.();
      proc.once("close", () => clearTimeout(timer));
    }
  }
}
