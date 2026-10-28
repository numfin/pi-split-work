import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getAgentDir, parseFrontmatter, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendArtifact, appendTaskNote, artifactName, createTask, listTasks, loadTask, pauseRunningTasks, resetTracker, saveTask, taskContext, type Task } from "./tracker.ts";
import { childExtensionArgs, childToolBlock, childTools } from "./child-config.ts";
import { parseAgentModels, selectAgentModel, type ModelChoice } from "./agent-models.ts";
import { configureChildModel } from "./child-preflight.ts";
import { agentRevision, editAgentFile } from "./agent-editor.ts";
import { baseName, listBases, publishBase, resolveBase, type BaseVersion } from "./base-registry.ts";
import { cloneBase } from "./clone-base.ts";
import { readSplitConfig, splitConfigPath, summaryConfig, updateSplitConfig, type SummaryConfig } from "./mode-config.ts";
import { FooterSummarizer, summarySystem } from "./footer-summary.ts";

const child = process.env.PI_SPLIT_CHILD === "1";
const agentName = (name: string) => { if (!/^[a-z][a-z0-9-]{0,39}$/.test(name)) throw new Error("Agent name must start with a lowercase letter and contain only letters, digits or hyphens"); return name; };
const root = (cwd: string) => path.join(cwd, ".pi");
const agentsDir = (cwd: string) => path.join(root(cwd), "my-agents");
const trackerDir = (cwd: string) => path.join(root(cwd), "tracker");
function readMode(cwd: string): boolean {
  try { return readSplitConfig(cwd).enabled === true; }
  catch { return false; }
}
function writeMode(cwd: string, enabled: boolean) {
  updateSplitConfig(cwd, { enabled });
}
type Agent = { name: string; description: string; model: string; think: string; models: ModelChoice[]; body: string; artifact?: string };
const summary = (task: Task) => ({ id: task.id, title: task.title, status: task.status, revision: task.revision,
  runs: task.runs.length, agent: task.runs.at(-1)?.agent, session: task.runs.at(-1)?.session,
  ...runStatus(task) });
function runStatus(task: Task) {
  const run = task.runs.at(-1), now = Date.now();
  if (!run) return {};
  return { elapsedSeconds: run.startedAt ? Math.round(((run.endedAt ?? now) - run.startedAt) / 1000) : undefined,
    activity: run.activity, activitySeconds: run.activitySince ? Math.round(((run.endedAt ?? now) - run.activitySince) / 1000) : undefined,
    secondsSinceUpdate: run.updatedAt ? Math.round((now - run.updatedAt) / 1000) : undefined,
    question: run.question, progress: run.progress, footerSummary: run.footerSummary, model: run.model, think: run.think, base: run.base,
    recent: run.recent, lastSteering: run.lastSteering };
}
type ChildActivity = { activity: string; question?: string; toolId?: string; finished?: boolean; steeringId?: string; progress?: string; reportOnly?: boolean; sessionFile?: string };
type Steer = (message: string) => Promise<void>;
class ChildPreflightError extends Error {}

function agents(cwd: string): Agent[] {
  const dir = agentsDir(cwd);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => /^[a-z][a-z0-9-]*\.md$/.test(name)).flatMap(name => {
    try {
      const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(fs.readFileSync(path.join(dir, name), "utf8"));
      if (typeof frontmatter.description !== "string" || !body.trim()) return [];
      const models = parseAgentModels(frontmatter);
      const { model, think } = models[0];
      const configuredArtifact = frontmatter.artifact;
      if (configuredArtifact !== undefined && typeof configuredArtifact !== "string") return [];
      const artifact = configuredArtifact === undefined ? undefined : artifactName(configuredArtifact);
      return [{ name: name.slice(0, -3), description: frontmatter.description, model,
        think, models, body, artifact }];
    } catch { return []; }
  });
}

async function runChild(cwd: string, task: Task, agent: Agent, session: string, guidance: string,
  signal: AbortSignal | undefined, onProcess: (proc?: ChildProcess, steer?: Steer) => void,
  onActivity: (activity: ChildActivity) => void): Promise<{ overview: string; tokens: number }> {
  // Artifacts are routed through the controller, not automatically read by other agents.
  let prompt: string, extensionArgs: string[], temp: string;
  try {
    prompt = taskContext(trackerDir(cwd), task.id, false);
    extensionArgs = childExtensionArgs(fileURLToPath(import.meta.url), getAgentDir());
    temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-split-"));
  } catch (error) { throw new ChildPreflightError(String(error)); }
  const system = path.join(temp, "agent.txt");
  const artifactRule = agent.artifact
    ? `Publish your findings through split_artifact (content); it writes a new ${agent.artifact}/<number>.md for the controller. Do not write artifact files with shell or file tools. `
    : "Do not create or edit Markdown files. ";
  try { fs.writeFileSync(system, `${agent.body}\n\nYou are one subagent assigned one bounded task. Keep task notes, acceptance criteria, artifacts, and overviews as short as possible: include only relevant, useful information needed for the next step. No prompt restatement, filler, generic summaries, or redundant checks. Prefer concise bullets and exact paths/results; preserve critical context. ${artifactRule}Never edit existing documentation or read .pi/tracker or .pi/my-agents directly. If blocked or needing clarification, call split_report kind=question with the specific question, then stop and return. Controller will resume this persistent session with an answer. Use split_report kind=progress only for meaningful milestones or a known delay reason; routine tool activity is tracked automatically. Return a minimal overview of changes and checks.\n`, { mode: 0o600 }); }
  catch (error) { fs.rmSync(temp, { recursive: true, force: true }); throw new ChildPreflightError(String(error)); }
  const args = ["--mode", "rpc", ...extensionArgs,
    "--session-id", session, "--model", agent.model, "--thinking", agent.think,
    "--tools", childTools(Boolean(agent.artifact)),
    "--append-system-prompt", system];
  const initialPrompt = `Task ${task.id} (revision ${task.revision}). Continue from your session if previous work exists.\n${prompt}\nController guidance: ${guidance || "Carry out the assigned work; report blockers."}`;
  let overview = "", tokens = 0, errorMessage = "", stderr = "", buffer = "", aborted = false, promptStarted = false;
  try {
    const code = await new Promise<number>((resolve, reject) => {
      const proc = spawn("pi", args, { cwd, env: { ...process.env, PI_SPLIT_CHILD: "1", PI_SPLIT_TASK: task.id, PI_SPLIT_ARTIFACT: agent.artifact || "" }, stdio: ["pipe", "pipe", "pipe"] });
      proc.stdout?.setEncoding("utf8");
      proc.stderr?.setEncoding("utf8");
      let accepting = true;
      const pending = new Map<string, { resolve: (data: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
      const rejectPending = (reason: string) => {
        for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error(reason)); }
        pending.clear();
      };
      const command = (type: string, fields: Record<string, unknown> = {}): Promise<any> => {
        if (!accepting || signal?.aborted || !proc.stdin?.writable) return Promise.reject(new Error("Subagent is stopping or finished; dispatch guidance in its next run."));
        const id = randomBytes(8).toString("hex");
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error("Subagent acknowledgment timed out; delivery is unconfirmed. Check status before retrying."));
          }, 15000);
          pending.set(id, { resolve, reject, timer });
          proc.stdin!.write(JSON.stringify({ id, type, ...fields }) + "\n", error => {
            if (!error) return;
            const request = pending.get(id);
            if (request) { clearTimeout(request.timer); pending.delete(id); request.reject(error); }
          });
        });
      };
      onProcess(proc, async message => { await command("steer", { message }); });
      proc.stdin?.on("error", error => {
        accepting = false; errorMessage = error.message; rejectPending(error.message); proc.kill("SIGTERM");
      });
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => { aborted = true; proc.kill("SIGTERM"); killTimer = setTimeout(() => { if (proc.exitCode === null) proc.kill("SIGKILL"); }, 5000); };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      const line = (s: string) => {
        try {
          const event = JSON.parse(s);
          if (event.type === "response") {
            const request = pending.get(event.id);
            if (request) {
              clearTimeout(request.timer); pending.delete(event.id);
              if (event.success) request.resolve(event.data);
              else request.reject(new Error(event.error || "Subagent rejected command"));
            }
          }
          if (event.type === "agent_settled") {
            accepting = false;
            rejectPending("Subagent finished before acknowledgment; delivery is unconfirmed. Check its report before retrying.");
            proc.stdin?.end();
          }
          if (event.type === "message_end" && event.message?.role === "user") {
            const content = event.message.content;
            const text = typeof content === "string" ? content : content?.filter((part: { type: string }) => part.type === "text").map((part: { text: string }) => part.text).join("\n");
            const match = /^\[Controller steering ([a-f0-9]+)\]/.exec(text ?? "");
            if (match) onActivity({ activity: "Controller steering delivered", steeringId: match[1] });
          }
          if (event.type === "tool_execution_start") {
            const input = event.args ?? {};
            const detail = input.command ?? input.cmd ?? input.path ?? input.content ??
              (input.session_id !== undefined ? `session ${input.session_id}` : "");
            if (event.toolName === "split_report" && input.kind === "question")
              overview = String(input.content).slice(0, 1200);
            onActivity({ activity: event.toolName === "split_report" ? String(input.content).slice(0, 240) : `${event.toolName}: ${String(detail).replace(/\s+/g, " ").slice(0, 180)}`,
              toolId: event.toolCallId,
              progress: event.toolName === "split_report" ? String(input.content).slice(0, 300) : undefined,
              question: event.toolName === "split_report" && input.kind === "question" ? String(input.content).slice(0, 1200) : undefined });
          }
          if (event.type === "tool_execution_end")
            onActivity({ activity: `Waiting for model after ${event.toolName}${event.isError ? " (tool error)" : ""}`, toolId: event.toolCallId, finished: true });
          if (event.type === "message_start" && event.message?.role === "assistant")
            onActivity({ activity: "Model responding" });
          if (event.type !== "message_end" || event.message?.role !== "assistant") return;
          const msg = event.message;
          const latest = msg.content?.filter((p: { type: string }) => p.type === "text").map((p: { text: string }) => p.text).join("\n");
          if (latest) overview = latest;
          if (latest) onActivity({ activity: "", progress: latest.slice(0, 300), reportOnly: true });
          tokens += (msg.usage?.input ?? 0) + (msg.usage?.output ?? 0);
          errorMessage = msg.stopReason === "error" || msg.stopReason === "aborted" ? (msg.errorMessage || msg.stopReason) : "";
        } catch { /* skip diagnostics that are not JSONL */ }
      };
      proc.stdout?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
        for (const item of lines) line(item);
      });
      proc.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-3000); });
      proc.on("error", reject);
      proc.on("close", code => {
        accepting = false;
        rejectPending("Subagent exited before acknowledgment; delivery is unconfirmed.");
        onProcess();
        if (killTimer) clearTimeout(killTimer);
        signal?.removeEventListener("abort", abort);
        if (buffer.trim()) line(buffer);
        resolve(code ?? 1);
      });
      void (async () => {
        const state = await configureChildModel(command, { model: agent.model, think: agent.think as ModelChoice["think"] });
        if (state.sessionId !== session) throw new Error("Child opened a different session");
        onActivity({ activity: "", sessionFile: state.sessionFile, reportOnly: true });
        promptStarted = true;
        await command("prompt", { message: initialPrompt });
      })().catch(error => {
        errorMessage = String(error);
        proc.stdin?.end();
        proc.kill("SIGTERM");
      });
    });
    if (aborted || signal?.aborted || code !== 0 || errorMessage || !overview.trim()) {
      const message = (aborted || signal?.aborted ? "Subagent paused by interruption" : errorMessage || stderr || "Subagent returned no overview").slice(0, 2000);
      if (!promptStarted) throw new ChildPreflightError(message);
      throw new Error(message);
    }
    return { overview: overview.slice(0, 4000), tokens };
  } catch (error) {
    if (!promptStarted && !(error instanceof ChildPreflightError)) throw new ChildPreflightError(String(error));
    throw error;
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

export default function (pi: ExtensionAPI) {
  if (child) {
    pi.registerTool({
      name: "split_report", label: "Report to controller",
      description: "Report a concise milestone or blocker. Use kind=question when controller input is required, then end this turn without further work. Your persistent session can resume after an answer. Avoid routine progress chatter.",
      parameters: Type.Object({ kind: Type.Union([Type.Literal("progress"), Type.Literal("question")]), content: Type.String({ maxLength: 1200 }) }),
      async execute(_id, p) {
        return { content: [{ type: "text", text: p.kind === "question" ? "Question recorded. Stop work now; controller will resume your session with an answer." : "Progress recorded." }], details: undefined,
          ...(p.kind === "question" ? { terminate: true } : {}) };
      },
    });
    const id = process.env.PI_SPLIT_TASK;
    const artifact = process.env.PI_SPLIT_ARTIFACT;
    if (id && artifact) {
      pi.registerTool({
        name: "split_artifact", label: "Publish artifact", description: `Publish one append-only ${artifact}/<number>.md for your controller. Keep it minimal: only relevant findings, evidence, and actionable next step. Do not repeat task instructions or add filler.`,
        parameters: Type.Object({ content: Type.String({ description: "Concise artifact with only useful information; no task restatement or filler" }) }),
        async execute(_callId, p, _signal, _onUpdate, ctx) {
          const file = appendArtifact(trackerDir(ctx.cwd), id, artifact, p.content);
          return { content: [{ type: "text", text: `Published ${file} for controller` }], details: undefined };
        },
      });
    }
    pi.on("tool_call", event => {
      const reason = childToolBlock(process.cwd(), event.toolName, event.input as Record<string, unknown>);
      if (reason) return { block: true, reason };
    });
    return;
  }

  let enabled = false;
  let previousTools: string[] | undefined;
  let toolsBeforeAgentCreation: string[] | undefined;
  let agentCreationPending = false;
  let footerTasks: Task[] = [];
  let taskWidgetInstalled = false;
  let taskWidgetTimer: ReturnType<typeof setInterval> | undefined;
  let renderFooter = () => {};
  const processes = new Map<string, ChildProcess>();
  const jobs = new Map<string, AbortController>();
  const cloningTasks = new Set<string>();
  const steerers = new Map<string, Steer>();
  let shuttingDown = false;
  let summarySettings: SummaryConfig = { enabled: false, reasoning: "off" };
  let summarizer: FooterSummarizer | undefined;
  let watchedConfig: string | undefined;
  let configListener: (() => void) | undefined;
  let summarySignature = "";
  let summaryErrorAt = 0;
  const removeTaskWidget = (ctx: ExtensionContext) => {
    if (!taskWidgetInstalled || ctx.mode !== "tui") return;
    if (taskWidgetTimer) clearInterval(taskWidgetTimer);
    taskWidgetTimer = undefined;
    ctx.ui.setWidget("split-work-tasks", undefined, { placement: "belowEditor" });
    taskWidgetInstalled = false;
    renderFooter = () => {};
  };
  const installTaskWidget = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    if (footerTasks.length === 0) { removeTaskWidget(ctx); return; }
    if (taskWidgetInstalled) return;
    taskWidgetInstalled = true;
    ctx.ui.setWidget("split-work-tasks", (tui, theme) => {
      let frame = 0;
      if (taskWidgetTimer) clearInterval(taskWidgetTimer);
      const tick = setInterval(() => {
        if (footerTasks.some(t => t.status === "running")) { frame++; tui.requestRender(); }
      }, 350);
      taskWidgetTimer = tick;
      renderFooter = () => tui.requestRender();
      return {
        dispose() {
          clearInterval(tick);
          if (taskWidgetTimer === tick) { taskWidgetTimer = undefined; taskWidgetInstalled = false; renderFooter = () => {}; }
        },
        invalidate() {},
        render(width: number): string[] {
          const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
          const lines = footerTasks.slice(0, 8).map(task => {
            const last = task.runs.at(-1)!;
            const elapsed = last.startedAt ? ` ${Math.floor(((last.endedAt ?? Date.now()) - last.startedAt) / 60000)}m` : "";
            const state = task.status === "running" ? `working${elapsed} ${frames[frame % frames.length]}` : last.question ? "question" : task.status;
            const prefix = theme.fg("accent", `[${last.agent}]`) + ": ";
            const suffix = theme.fg(task.status === "running" ? "success" : "muted", `[${state}]`);
            const titleWidth = Math.max(0, width - visibleWidth(prefix) - visibleWidth(suffix) - 1);
            const title = summarySettings.enabled ? last.footerSummary || task.title : task.title;
            return truncateToWidth(prefix + truncateToWidth(title, titleWidth) + " " + suffix, width);
          });
          if (footerTasks.length > 8) lines.push(truncateToWidth(theme.fg("muted", `+${footerTasks.length - 8} more sessions`), width));
          return lines;
        },
      };
    }, { placement: "belowEditor" });
  };
  const refreshFooter = (ctx: ExtensionContext) => {
    footerTasks = listTasks(trackerDir(ctx.cwd)).filter(t => t.status !== "archived" && t.runs.length > 0);
    installTaskWidget(ctx);
    renderFooter();
  };
  const loadSummarySettings = (ctx: ExtensionContext) => {
    try {
      const settings = summaryConfig(readSplitConfig(ctx.cwd).summary);
      const signature = JSON.stringify(settings);
      if (signature === summarySignature) return;
      if (settings.enabled && !ctx.modelRegistry.getAvailable().some(m => m.provider === settings.provider && m.id === settings.model))
        throw new Error(`Summary model unavailable: ${settings.provider}/${settings.model}`);
      summarySettings = settings; summarySignature = signature;
      summarizer?.configure(settings);
      refreshFooter(ctx);
    } catch (error) {
      summarySettings = { enabled: false, reasoning: "off" }; summarySignature = "";
      summarizer?.configure(summarySettings);
      refreshFooter(ctx);
      ctx.ui.notify(String(error).slice(0, 300), "warning");
    }
  };
  const setMode = (value: boolean, ctx: ExtensionContext) => {
    enabled = value;
    if (value) {
      previousTools ??= (toolsBeforeAgentCreation ?? pi.getActiveTools()).filter(name => name !== "split_work");
      pi.setActiveTools(["split_work"]);
    } else {
      pi.setActiveTools(previousTools ?? pi.getActiveTools().filter(name => name !== "split_work"));
      previousTools = undefined;
    }
    ctx.ui.setStatus("split", value ? "split: controller" : undefined);
    refreshFooter(ctx);
  };
  pi.registerCommand("split-agent", {
    description: "Create a project-local agent; optionally append --instructions guide.md",
    handler: async (args, ctx) => {
      const guideArg = /(?:^|\s)--(?:instructions|from)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/.exec(args);
      const description = (guideArg ? args.slice(0, guideArg.index).trim() : args.trim());
      if (!description) { ctx.ui.notify("Usage: /split-agent <agent purpose> [--instructions <guide.md>]", "warning"); return; }
      let creationGuide = "";
      if (guideArg) {
        const guidePath = guideArg[1] || guideArg[2] || guideArg[3];
        if (!guidePath.toLowerCase().endsWith(".md")) { ctx.ui.notify("Creation guide must be a .md file", "warning"); return; }
        try {
          const resolved = path.resolve(ctx.cwd, guidePath);
          const stat = fs.statSync(resolved);
          if (!stat.isFile() || stat.size > 16 * 1024) throw new Error("Guide must be a file no larger than 16 KB");
          creationGuide = fs.readFileSync(resolved, "utf8").trim();
          if (!creationGuide) throw new Error("Guide is empty");
        } catch (error) {
          ctx.ui.notify(`Cannot read agent guide: ${String(error).slice(0, 240)}`, "warning");
          return;
        }
      }
      if (!ctx.isIdle()) { ctx.ui.notify("Wait for current run to finish, then create agent", "warning"); return; }
      if (!enabled) {
        toolsBeforeAgentCreation = pi.getActiveTools();
        agentCreationPending = true;
        pi.setActiveTools([...new Set([...toolsBeforeAgentCreation, "split_work"])]);
      }
      const modelHints = description.toLowerCase().match(/\b(gpt|sol|luna|terra|astra|claude|sonnet|opus|haiku|gemini|deepseek|grok|qwen|mistral|llama|glm|axon|openai-codex|openai|openrouter|anthropic|google|typesafe|fireworks|together|groq)\b/g) ?? [];
      const requestsModel = /\b(model|family|provider)\b/i.test(description) || modelHints.length > 0;
      const modelCandidates = requestsModel
        ? ctx.modelRegistry.getAvailable()
            .filter(model => modelHints.length > 0 && modelHints.every(hint => `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(hint)))
            .slice(0, 12)
            .map(model => `${model.provider}/${model.id}`)
        : [];
      const modelPolicy = requestsModel
        ? modelCandidates.length
          ? `Honor the requested model preference over the active model. Choose only from these exact available provider/model IDs: ${modelCandidates.join(", ")}. For "smarter/best" requests, choose strongest/latest suitable match. If none fit, ask before creating; never silently fall back.`
          : "A model/provider/family preference was requested but no matching available models were found. Ask before creating; do not silently use the active model."
        : `No model preference was specified; use active model ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "already selected in this session"}.`;
      const guideText = creationGuide ? `\n\nAdditional user-provided creation guide (follow unless it conflicts with required extension format, project-local scope, no-mode-change rule, or brevity policy):\n${creationGuide}` : "";
      const prompt = `Create one project-local subagent for this purpose: ${description}${guideText}\n\nDo not enable or change split mode; creating an agent is separate from migrating this project to controller mode. Use the split-work extension, not manual file editing. First call split_work action=agents to avoid duplicating an existing agent. Then call action=create_agent with a short lowercase unique name, one-line description, provider/model, think level, concise body, and optional artifact folder only if the agent must publish findings for another agent. Agent format: YAML frontmatter fields description (why/scope), model (provider/model), think (level), optional artifact (folder name); if user requests multiple models, provide models array of {model, think} entries instead, with default first; markdown body contains behavior. Extension discovers only .pi/my-agents/<name>.md in this project. Its dispatch tool passes task and acceptance context, provides split_artifact only when artifact is configured, stores a persistent child session, and returns a short overview. Every agent must keep task notes and artifacts as small as possible: only relevant, useful facts, no restatement or filler. Include one bounded responsibility, no unrelated duties. ${modelPolicy} Set think=low unless task clearly needs more. Confirm created agent name and model briefly.`;
      try {
        pi.sendUserMessage(prompt);
        ctx.ui.notify(`Creating project-local agent for: ${description}`, "info");
      } catch (error) {
        finishAgentCreation();
        throw error;
      }
    },
  });
  pi.registerCommand("split", {
    description: "Controller: /split on|off|status|reset; footer summaries: /split summary on <provider/model> <seconds> [reasoning], off, status",
    handler: async (args, ctx) => {
      const words = args.trim().split(/\s+/);
      if (words[0]?.toLowerCase() === "summary") {
        const action = words[1]?.toLowerCase() || "status";
        try {
          if (action === "status") {
            loadSummarySettings(ctx);
            ctx.ui.notify(`Footer summary: ${JSON.stringify(summarySettings)}`, "info"); return;
          }
          const rawSummary = readSplitConfig(ctx.cwd).summary;
          if (action === "off" && words.length === 2) {
            let disabled: SummaryConfig;
            try {
              disabled = summaryConfig({ ...(rawSummary && typeof rawSummary === "object" ? rawSummary : {}), enabled: false });
            } catch { disabled = { enabled: false, reasoning: "off" }; }
            updateSplitConfig(ctx.cwd, { summary: disabled });
          } else if (action === "on") {
            const saved = summaryConfig(rawSummary);
            let next: SummaryConfig;
            if (words.length === 2) next = summaryConfig({ ...saved, enabled: true });
            else {
              if (words.length < 4 || words.length > 5) throw new Error("Usage: /split summary on <provider/model> <seconds> [reasoning]");
              const slash = words[2].indexOf("/");
              if (slash < 1) throw new Error("Use an exact provider/model ID");
              next = summaryConfig({ enabled: true, provider: words[2].slice(0, slash), model: words[2].slice(slash + 1),
                intervalSeconds: Number(words[3]), reasoning: words[4] ?? "off" });
            }
            if (!ctx.modelRegistry.getAvailable().some(m => m.provider === next.provider && m.id === next.model))
              throw new Error(`Summary model unavailable: ${next.provider}/${next.model}`);
            updateSplitConfig(ctx.cwd, { summary: next });
          } else throw new Error("Use /split summary on <provider/model> <seconds> [reasoning], /split summary off or /split summary status");
          loadSummarySettings(ctx);
          ctx.ui.notify(`Footer summary ${summarySettings.enabled ? "ON" : "OFF"}`, "info");
        } catch (error) { ctx.ui.notify(`${String(error).slice(0, 240)}. First enable: /split summary on <provider/model> <seconds> [reasoning]`, "warning"); }
        return;
      }
      const option = args.trim().toLowerCase();
      if (option === "status" || !option) {
        ctx.ui.notify(`Split mode ${enabled ? "ON" : "OFF"} · footer summary ${summarySettings.enabled ? "ON" : "OFF"}`, "info"); return;
      }
      if (option === "reset") {
        const tasks = listTasks(trackerDir(ctx.cwd));
        if (processes.size || tasks.some(task => task.status === "running")) {
          ctx.ui.notify("Stop or pause running agents before resetting tracker", "warning");
          return;
        }
        if (!ctx.hasUI) {
          ctx.ui.notify("Reset requires UI confirmation; run /split reset in an interactive session", "warning");
          return;
        }
        const confirmed = await ctx.ui.confirm("Reset split tracker?",
          `Delete ${tasks.length} tracked tasks and artifacts? Agent definitions and saved child Pi sessions will remain.`);
        if (!confirmed) { ctx.ui.notify("Tracker reset cancelled", "info"); return; }
        resetTracker(trackerDir(ctx.cwd));
        refreshFooter(ctx);
        ctx.ui.notify(`Tracker reset. ${agents(ctx.cwd).length} agent definitions kept.`, "info");
        return;
      }
      if (option !== "on" && option !== "off") { ctx.ui.notify("Use /split on, /split off, /split status or /split reset", "warning"); return; }
      setMode(option === "on", ctx);
      writeMode(ctx.cwd, enabled);
      pi.appendEntry("split-mode", { enabled, previousTools });
      ctx.ui.notify(`Split mode ${enabled ? "ON" : "OFF"}`, "info");
    },
  });
  function finishAgentCreation() {
    if (!agentCreationPending) return;
    agentCreationPending = false;
    if (!enabled && toolsBeforeAgentCreation) pi.setActiveTools(toolsBeforeAgentCreation);
    toolsBeforeAgentCreation = undefined;
  }
  pi.on("agent_settled", () => finishAgentCreation());
  pi.on("session_start", (_event, ctx) => {
    shuttingDown = false;
    // With one controller per project, interrupted children can be resumed from their stored Pi session IDs.
    pauseRunningTasks(trackerDir(ctx.cwd));
    const last = ctx.sessionManager.getBranch().filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "split-mode").at(-1) as { data?: { enabled: boolean; previousTools?: string[] } } | undefined;
    previousTools = last?.data?.previousTools;
    setMode(last?.data?.enabled ?? readMode(ctx.cwd), ctx);
    summarizer = new FooterSummarizer({
      snapshot: () => listTasks(trackerDir(ctx.cwd)).filter(task => task.status === "running").flatMap(task => {
        const run = task.runs.at(-1);
        return run?.id ? [{ task: task.id, run: run.id, agent: run.agent, title: task.title,
          activity: run.activity, progress: run.progress, question: run.question,
          elapsedSeconds: run.startedAt ? Math.round((Date.now() - run.startedAt) / 1000) : undefined,
          activitySeconds: run.activitySince ? Math.round((Date.now() - run.activitySince) / 1000) : undefined }] : [];
      }),
      complete: async (settings, prompt, signal) => {
        const model = ctx.modelRegistry.find(settings.provider!, settings.model!);
        if (!model) throw new Error("Summary model is no longer available");
        const stream = ctx.modelRegistry.streamSimple(model, {
          systemPrompt: summarySystem, messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
        }, { signal, reasoning: settings.reasoning === "off" ? undefined : settings.reasoning, maxTokens: 2048 });
        const response = await stream.result();
        if (response.stopReason === "error" || response.stopReason === "aborted")
          throw new Error(response.errorMessage || response.stopReason);
        return response.content.filter(part => part.type === "text").map(part => part.text).join("");
      },
      apply: (snapshot, text) => {
        if (shuttingDown) return;
        let task: Task;
        try { task = loadTask(trackerDir(ctx.cwd), snapshot.task); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
        const run = task.runs.at(-1);
        if (task.status !== "running" || run?.id !== snapshot.run) return;
        run.footerSummary = text; run.footerSummaryAt = Date.now();
        saveTask(trackerDir(ctx.cwd), task); refreshFooter(ctx);
      },
      error: error => {
        if (Date.now() - summaryErrorAt < 60000) return;
        summaryErrorAt = Date.now(); ctx.ui.notify(`Footer summary: ${String(error).slice(0, 240)}`, "warning");
      },
    });
    summarySignature = "";
    loadSummarySettings(ctx);
    watchedConfig = splitConfigPath(ctx.cwd);
    configListener = () => { if (!shuttingDown) loadSummarySettings(ctx); };
    fs.watchFile(watchedConfig, { interval: 1000, persistent: false }, configListener);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    shuttingDown = true;
    summarizer?.stop();
    if (watchedConfig && configListener) fs.unwatchFile(watchedConfig, configListener);
    watchedConfig = undefined; configListener = undefined;
    for (const controller of jobs.values()) controller.abort();
    pauseRunningTasks(trackerDir(ctx.cwd));
    removeTaskWidget(ctx);
  });
  pi.on("context", event => {
    const messages = event.messages;
    const last = messages.findLastIndex(m => (m as { customType?: string }).customType === "split-controller");
    const lastAgentCreation = messages.findLastIndex(m => (m as { customType?: string }).customType === "split-agent-creation");
    return { messages: messages.filter((m, i) => {
      const type = (m as { customType?: string }).customType;
      if (type === "split-controller") return enabled && i === last;
      if (type === "split-agent-creation") return agentCreationPending && i === lastAgentCreation;
      return true;
    }) };
  });
  pi.on("before_agent_start", (event, ctx) => {
    if (event.messageType === "user") refreshFooter(ctx);
    if (agentCreationPending && event.messageType === "user") return { message: {
      customType: "split-agent-creation", display: false,
      content: "ONE-SHOT AGENT CREATION: Create only the project-local .pi/my-agents definition requested by user. Use split_work actions agents then create_agent. Do not use other tools, implement project work, change split-mode.json, or enable controller mode. Split mode is a separate user decision. Keep definition concise and use current project scope."
    } };
    if (!enabled) return;
    return { message: { customType: "split-controller", display: false,
      content: [
        "CONTROLLER MODE: Never implement tasks yourself. Dispatch/continue launch background jobs. Route ready work, then end your turn; never poll or loop waiting. Completion/question/failure events wake you. To edit a project agent, call inspect_agent for its definition and revision, then edit_agent with expectedRevision and only the fields user wants changed. Running sessions keep their current configuration until the next run.",
        "Answer user messages while children work. Use steer(id,content) for live guidance without restarting a running subagent. Save changed user requirements with requirement FIRST; steer automatically includes unseen requirements. Queued means accepted, not delivered; status.lastSteering tracks delivery into child context, not compliance. Steering waits for the current turn/tools to finish, never interrupts shell commands. If job ended, use dispatch guidance. Use pause only when interruption is needed; do not auto-resume paused jobs without user request.",
        "Use tasks/status for activity, elapsed time, last-update age and recent tool durations; context for reports. Explain delays only from evidence or explicit blockers, never invent reasons or expose private reasoning. Missing updates do not prove a hang. Answer questions with same-task dispatch guidance after its run stops.",
        "For a reusable knowledge worker use base_prepare with base name, agent and study scope. On completion inspect context and report; publish via base_publish only after study succeeds, then complete the preparation task. Do not dispatch the published preparation session again. To use a published base, create a separate feature task and dispatch with base and optional baseVersion; each feature gets an isolated clone. Never claim sessions isolate working files. Base context may incur token costs and may be stale; verify project sources. Existing task/agent sessions cannot be reseeded. Refresh with another base_prepare and publish new version; old clones stay pinned.",
        "Create one small task per independent deliverable; parallelize separate IDs and wait for dependencies. Keep coder/reviewer/fix cycles within the SAME task ID using sequential dispatches. Inspect reports, route concise guidance, repeat fixes/re-review as needed.",
        "After acceptance passes and required review approves, call complete to archive immediately and clear its footer row. Never leave accepted tasks unarchived or complete a coder run before required review. Other unfinished tasks stay visible.",
        "Only user changes go to requirement; findings go to configured artifacts via split_artifact. Keep all tasks, artifacts and overviews minimal: useful next-step information only, no restatement or filler. Never read tracker/agent markdown directly.",
        "On continue resume paused sessions (all without an ID); reuse persistent agent sessions. For a requested model change, pause the running task first, then continue that task with an allowed model and think from agents; never claim the change worked until preflight succeeds. If no suitable agent exists, offer to create one. For tracker reset ask user to run /split reset; it confirms and keeps agents.",
      ].join("\n") } };
  });
  pi.on("tool_call", event => {
    if ((enabled || agentCreationPending) && event.toolName !== "split_work")
      return { block: true, reason: agentCreationPending ? "Agent creation is one-shot; use only split_work agents/create_agent." : "Controller cannot do task work. Use split_work or /split off." };
  });

  pi.registerTool({
    name: "split_work", label: "Split work", description: "Controller routing. inspect_agent(name) returns definition and revision; edit_agent(name,expectedRevision, changed fields) updates existing agent atomically. Supply models OR model+think; clearArtifact=true removes artifact. Running subagents are not reconfigured. bases lists published knowledge bases; base_prepare(base,name,instructions) starts a study-only agent task, then after inspecting its report base_publish(id) publishes its session as a new immutable version. To use it, create a feature task then dispatch(id,name,base, optional baseVersion), creating an isolated Pi clone. Continue/fix runs reuse that task's clone. Existing sessions cannot be reseeded. Do not run a preparation session again after publishing. agents lists allowed models; dispatch and per-task continue optionally accept model and think together. continue without them reuses the previous model. dispatch/continue launch background jobs; completion/questions wake controller. End turn after routing; never poll. steer(id,content) sends concise guidance to a RUNNING subagent without restart, at its next safe boundary; does NOT interrupt active shell commands. Save user requirement changes with requirement first, then steer. Queued is not yet delivered: status.lastSteering tracks delivery to child context, not proof of compliance. If job ended use dispatch guidance instead. tasks/status show current activity and durations. pause interrupts a job. Reuse SAME task ID for code/review/fixes. complete archives accepted tasks.",

    parameters: Type.Object({
      action: Type.Union(["agents", "inspect_agent", "edit_agent", "create_agent", "create_task", "requirement", "context", "tasks", "status", "steer", "pause", "dispatch", "continue", "complete", "archive", "bases", "base_prepare", "base_publish"].map(Type.Literal)),
      id: Type.Optional(Type.String({ description: "Task ID for dispatch, context, requirement, complete, archive or per-task continue" })),
      name: Type.Optional(Type.String({ description: "Agent name; REQUIRED for dispatch and create_agent" })), title: Type.Optional(Type.String()),
      instructions: Type.Optional(Type.String()), acceptance: Type.Optional(Type.String()),
      content: Type.Optional(Type.String({ description: "Requirement text or concise live steering (steer: at most 2000 characters)" })), guidance: Type.Optional(Type.String()), artifact: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()), model: Type.Optional(Type.String({ description: "Exact provider/model for dispatch or per-task continue" })), think: Type.Optional(Type.String({ description: "Reasoning level for dispatch or per-task continue" })), body: Type.Optional(Type.String()),
      models: Type.Optional(Type.Array(Type.Object({ model: Type.String(), think: Type.String() }), { minItems: 1, maxItems: 32 })),
      expectedRevision: Type.Optional(Type.String({ description: "Revision returned by inspect_agent; required for edit_agent" })),
      clearArtifact: Type.Optional(Type.Boolean({ description: "Remove existing artifact folder from agent definition" })),
      base: Type.Optional(Type.String({ description: "Published base name for dispatch or base_prepare" })),
      baseVersion: Type.Optional(Type.Integer({ minimum: 1, description: "Pinned version; omit to use latest" })),
    }),
    async execute(_callId, p, signal, _onUpdate, ctx) {
      if (!enabled && !["agents", "create_agent"].includes(p.action))
        throw new Error("This action needs controller mode. /split-agent only creates agent definitions; use /split on to delegate tasks.");
      const dir = trackerDir(ctx.cwd);
      const required = (s: string | undefined, name: string) => { if (!s?.trim()) throw new Error(`Missing ${name}`); return s; };
      async function dispatch(id: string, agentNameToUse: string, guidance: string, resumeOnly = false, model?: string, think?: string, base?: BaseVersion) {
        const task = loadTask(dir, id);
        const agent = agents(ctx.cwd).find(item => item.name === agentNameToUse);
        if (!agent) throw new Error(`No agent named ${agentNameToUse}. Available: ${agents(ctx.cwd).map(a => a.name).join(", ") || "none"}; offer to create one.`);
        if (cloningTasks.has(id)) throw new Error("Task is being cloned");
        if (task.status === "archived" || task.status === "running") throw new Error(`Task status ${task.status}; cannot dispatch`);
        if (resumeOnly && task.status !== "paused") throw new Error(`Task status ${task.status}; only paused tasks can continue`);
        const prior = [...task.runs].reverse().find(run => run.agent === agent.name);
        if (prior && listBases(ctx.cwd).some(base => base.task === task.id && base.session === prior.session))
          throw new Error("Published base session is immutable; prepare a new base version instead");
        const selected = resumeOnly && model === undefined && think === undefined && prior?.model && prior.think
          ? selectAgentModel(agent.models, prior.model, prior.think)
          : selectAgentModel(agent.models, model, think);
        const selectedAgent = { ...agent, ...selected };
        if (resumeOnly && prior !== task.runs.at(-1)) throw new Error("Paused session belongs to another agent");
        if (base && prior) throw new Error("A base can only seed an agent's first run in this task");
        if (!resumeOnly && task.status === "review" && prior && prior === task.runs.at(-1) && prior.status === "done" && prior.revision === task.revision && prior.guidance === guidance && (prior.model ?? agent.model) === selected.model && (prior.think ?? agent.think) === selected.think)
          return { task: task.id, status: task.status, session: prior.session, agent: agent.name, artifact: agent.artifact,
            tokens: 0, overview: prior.overview, alreadyCompleted: true };
        if (base && base.agent !== agent.name) throw new Error("Base belongs to a different agent");
        let cloned: { session: string; sessionFile: string } | undefined;
        if (base) {
          cloningTasks.add(id);
          try { cloned = await cloneBase(ctx.cwd, base, signal); }
          finally { cloningTasks.delete(id); }
          const current = loadTask(dir, id);
          if (current.status !== task.status || current.revision !== task.revision || current.runs.length !== task.runs.length)
            throw new Error("Task changed during cloning; retry dispatch");
        }
        const session = prior?.session ?? cloned?.session ?? `split-${randomBytes(12).toString("hex")}`;
        const attempt = randomBytes(8).toString("hex");
        const now = Date.now(), controller = new AbortController();
        task.runs.push({ id: attempt, session, sessionFile: cloned?.sessionFile, base: base ? { name: base.name, version: base.version } : undefined, agent: agent.name, model: selected.model, think: selected.think, revision: task.revision, guidance, status: "running",
          startedAt: now, updatedAt: now, activitySince: now, activity: "Starting subagent" });
        task.status = "running"; saveTask(dir, task); refreshFooter(ctx);
        jobs.set(task.id, controller);
        const notify = (result: unknown) => {
          if (shuttingDown) return;
          pi.sendMessage({ customType: "split-event", content: JSON.stringify(result), display: true },
            { triggerTurn: enabled, deliverAs: "followUp" });
        };
        const background = async () => {
        try {
          const activeTools = new Map<string, { activity: string; since: number }>();
          const result = await runChild(ctx.cwd, task, selectedAgent, session, guidance, controller.signal, (proc, steer) => {
            if (proc) {
              processes.set(task.id, proc);
              if (steer) steerers.set(task.id, steer);
            } else { processes.delete(task.id); steerers.delete(task.id); }
          }, event => {
            if (shuttingDown) return;
            const latest = loadTask(dir, task.id), run = latest.runs.find(item => item.id === attempt)!;
            const time = Date.now();
            if (event.sessionFile) run.sessionFile = event.sessionFile;
            if (event.progress) run.progress = event.progress;
            if (event.reportOnly) { run.updatedAt = time; saveTask(dir, latest); return; }
            if (event.steeringId) {
              if (run.lastSteering?.id === event.steeringId) {
                run.lastSteering.status = "delivered"; run.lastSteering.deliveredAt = time;
                run.revision = run.lastSteering.revision;
                saveTask(dir, latest); refreshFooter(ctx);
              }
              return;
            }
            if (event.toolId && event.finished) {
              const started = activeTools.get(event.toolId);
              if (started) {
                run.recent = [...(run.recent ?? []), { activity: started.activity, durationMs: time - started.since }].slice(-5);
                activeTools.delete(event.toolId);
              }
            } else if (event.toolId) activeTools.set(event.toolId, { activity: event.activity, since: time });
            const active = [...activeTools.values()].at(-1);
            run.activity = active?.activity ?? event.activity;
            run.activitySince = active?.since ?? time; run.updatedAt = time;
            if (event.question) run.question = event.question;
            saveTask(dir, latest); refreshFooter(ctx);
          });
          if (shuttingDown) return;
          const latest = loadTask(dir, task.id), run = latest.runs.find(item => item.id === attempt)!;
          run.endedAt = Date.now(); run.updatedAt = run.endedAt;
          if (run.lastSteering && run.lastSteering.status !== "delivered") run.lastSteering.status = "unconfirmed";
          run.status = controller.signal.aborted ? "paused" : "done"; run.overview = result.overview; run.tokens = result.tokens;
          latest.status = controller.signal.aborted ? "paused" : latest.revision !== run.revision ? "stale" : run.question ? "blocked" : "review";
          saveTask(dir, latest); refreshFooter(ctx);
          notify({ event: run.question ? "question" : "completed", task: task.id, status: latest.status, agent: agent.name,
            question: run.question, overview: result.overview, lastSteering: run.lastSteering });
        } catch (error) {
          if (shuttingDown) return;
          const latest = loadTask(dir, task.id), run = latest.runs.find(item => item.id === attempt)!;
          const paused = latest.status === "paused" || controller.signal.aborted || error instanceof ChildPreflightError;
          run.endedAt = Date.now(); run.updatedAt = run.endedAt;
          if (run.lastSteering && run.lastSteering.status !== "delivered") run.lastSteering.status = "unconfirmed";
          run.status = paused ? "paused" : "failed"; run.overview = String(error).slice(0, 2000);
          latest.status = paused ? "paused" : latest.revision === run.revision ? "blocked" : "stale";
          saveTask(dir, latest); refreshFooter(ctx);
          notify({ event: paused ? "paused" : "failed", task: task.id, agent: agent.name, overview: run.overview, lastSteering: run.lastSteering });
        } finally {
          jobs.delete(task.id);
          steerers.delete(task.id);
        }
        };
        void background().catch(error => { if (!shuttingDown) ctx.ui.notify(`Subagent tracking error: ${String(error).slice(0, 240)}`, "error"); });
        return { task: task.id, status: "running", session, agent: agent.name, model: selected.model, think: selected.think, base: base ? { name: base.name, version: base.version } : undefined, background: true };
      }
      let output: unknown;
      switch (p.action) {
        case "bases": output = listBases(ctx.cwd).map(({ sessionFile: _file, sha256: _hash, ...base }) => base); break;
        case "base_prepare": {
          const name = baseName(required(p.base, "base")), agent = required(p.name, "agent name");
          const definition = agents(ctx.cwd).find(item => item.name === agent);
          if (!definition) throw new Error(`No agent named ${agent}`);
          selectAgentModel(definition.models, p.model, p.think);
          const scope = required(p.instructions, "documentation scope");
          const task = createTask(dir, `Prepare base ${name}`, `Study documentation and project context. Do not implement features or modify files.\nScope: ${scope}`,
            "Read the requested sources, retain useful context in the session, and return a concise report of sources, versions, limitations and open questions.");
          task.basePreparation = { name, agent }; saveTask(dir, task);
          output = { preparation: summary(task), ...await dispatch(task.id, agent, "Study only. Do not write or modify files.", false, p.model, p.think) };
          break;
        }
        case "base_publish": {
          const task = loadTask(dir, required(p.id, "preparation task id")), prep = task.basePreparation, run = task.runs.at(-1);
          if (!prep || !run || run.agent !== prep.agent || task.status !== "review" || run.status !== "done" || !run.sessionFile)
            throw new Error("Publish requires a successful, reviewed base preparation with a persistent session");
          const existing = listBases(ctx.cwd).find(base => base.task === task.id);
          if (existing) { output = { ...existing, alreadyPublished: true }; break; }
          const base = publishBase(ctx.cwd, { name: prep.name, task: task.id, agent: prep.agent, session: run.session,
            sessionFile: run.sessionFile, model: run.model, think: run.think });
          output = { ...base, message: "Base published. Original task can now be completed; future tasks clone this immutable session." };
          break;
        }
        case "agents": output = agents(ctx.cwd).map(({ name, description, model, think, models, artifact }) => ({ name, description, model, think, models, artifact })); break;
        case "inspect_agent": {
          const name = agentName(required(p.name, "name"));
          const file = path.join(agentsDir(ctx.cwd), `${name}.md`);
          const stat = fs.lstatSync(file);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) throw new Error("Agent definition must be a regular file at most 128 KB");
          const raw = fs.readFileSync(file, "utf8"), parsed = parseFrontmatter<Record<string, unknown>>(raw);
          output = { name, revision: agentRevision(raw), frontmatter: parsed.frontmatter, body: parsed.body,
            runningTasks: listTasks(dir).filter(task => task.status === "running" && task.runs.at(-1)?.agent === name).map(task => task.id) };
          break;
        }
        case "edit_agent": {
          const name = agentName(required(p.name, "name"));
          const revision = required(p.expectedRevision, "expectedRevision");
          const file = path.join(agentsDir(ctx.cwd), `${name}.md`);
          const result = editAgentFile(file, revision, { description: p.description, body: p.body, model: p.model,
            think: p.think, models: p.models, artifact: p.artifact, clearArtifact: p.clearArtifact }, text => {
              const parsed = parseFrontmatter<Record<string, unknown>>(text);
              if (typeof parsed.frontmatter.description !== "string" || !parsed.frontmatter.description.trim() || /[\r\n]/.test(parsed.frontmatter.description) || !parsed.body.trim())
                throw new Error("Agent requires a single-line description and nonempty body");
              parseAgentModels(parsed.frontmatter);
              if (parsed.frontmatter.artifact !== undefined) {
                if (typeof parsed.frontmatter.artifact !== "string") throw new Error("Invalid artifact");
                artifactName(parsed.frontmatter.artifact);
              }
            });
          output = { name, ...result, runningTasks: listTasks(dir).filter(task => task.status === "running" && task.runs.at(-1)?.agent === name).map(task => task.id),
            note: "Existing processes and published base sessions are unchanged. New definition applies on the next run; choose an allowed model when resuming if necessary." };
          break;
        }
        case "create_agent": {
          const name = agentName(required(p.name, "name"));
          const description = required(p.description, "description"), body = required(p.body, "body");
          const models = parseAgentModels(p.models ? { models: p.models } : { model: p.model, think: p.think });
          if (/\n/.test(description)) throw new Error("Expected single-line description");
          const artifact = p.artifact === undefined ? undefined : artifactName(p.artifact);
          fs.mkdirSync(agentsDir(ctx.cwd), { recursive: true });
          const modelFields = p.models ? `models: ${JSON.stringify(models)}\n` : `model: ${JSON.stringify(models[0].model)}\nthink: ${models[0].think}\n`;
          fs.writeFileSync(path.join(agentsDir(ctx.cwd), `${name}.md`), `---\ndescription: ${JSON.stringify(description)}\n${modelFields}${artifact ? `artifact: ${artifact}\n` : ""}---\n${body.trim()}\n`, { flag: "wx" });
          output = { created: name, models, artifact }; break;
        }
        case "create_task": output = summary(createTask(dir, required(p.title, "title"), required(p.instructions, "instructions"), required(p.acceptance, "acceptance"))); break;
        case "requirement": output = summary(appendTaskNote(dir, required(p.id, "id"), required(p.content, "content"))); break;
        case "context": {
          const task = loadTask(dir, required(p.id, "id"));
          output = { task: summary(task), latest: task.runs.at(-1), context: taskContext(dir, task.id) }; break;
        }
        case "tasks": output = listTasks(dir).filter(task => task.status !== "archived").slice(0, 40).map(summary); break;
        case "status": output = p.id ? summary(loadTask(dir, p.id)) : listTasks(dir).filter(task => task.status !== "archived").slice(0, 40).map(summary); break;
        case "steer": {
          const id = required(p.id, "id"), content = required(p.content ?? p.guidance, "content").trim();
          if (content.length > 2000) throw new Error("Keep live steering at most 2000 characters");
          const task = loadTask(dir, id), run = task.runs.at(-1), steer = steerers.get(id);
          if (task.status !== "running" || !run || !steer || jobs.get(id)?.signal.aborted)
            throw new Error("No running subagent to steer; use dispatch/continue with guidance instead.");
          const steeringId = randomBytes(8).toString("hex");
          // Send only unseen append-only requirements, never repeat the whole task.
          const requirementsDir = path.join(dir, id, "requirements");
          const delta = task.revision > run.revision && fs.existsSync(requirementsDir)
            ? fs.readdirSync(requirementsDir).filter(file => /^\d+\.md$/.test(file) && Number(file.slice(0, -3)) > run.revision).sort()
              .map(file => fs.readFileSync(path.join(requirementsDir, file), "utf8").trim()).join("\n")
            : "";
          if (delta.length > 32000) throw new Error("New requirements exceed 32 KB; split the task");
          run.lastSteering = { id: steeringId, content, revision: task.revision, sentAt: Date.now(), status: "sending" };
          saveTask(dir, task);
          try {
            await steer(`[Controller steering ${steeringId}]\n${content}${delta ? `\nNew user requirements (revision ${task.revision}):\n${delta}` : ""}`);
            const latest = loadTask(dir, id), target = latest.runs.find(item => item.id === run.id)!;
            if (target.lastSteering?.id === steeringId && target.lastSteering.status === "sending") {
              target.lastSteering.status = "queued"; saveTask(dir, latest);
            }
            output = { task: id, agent: run.agent, session: run.session, steering: target.lastSteering,
              note: "Accepted at next safe boundary; does not interrupt a running tool. Delivered means added to child context, not proof of compliance." };
          } catch (error) {
            const latest = loadTask(dir, id), target = latest.runs.find(item => item.id === run.id)!;
            if (target.lastSteering?.id === steeringId && target.lastSteering.status !== "delivered") {
              target.lastSteering.status = "unconfirmed"; saveTask(dir, latest);
            }
            throw error;
          }
          break;
        }
        case "pause": {
          const id = required(p.id, "id"), controller = jobs.get(id);
          if (!controller) throw new Error("No live job for this task");
          controller.abort(); output = { task: id, status: "pausing" }; break;
        }
        case "complete": {
          const task = loadTask(dir, required(p.id, "id"));
          if (task.status === "archived") { output = { ...summary(task), alreadyCompleted: true }; break; }
          if (task.status !== "review" || task.runs.at(-1)?.status !== "done")
            throw new Error("Complete only after the latest subagent run succeeds and acceptance/review are satisfied");
          task.status = "archived"; saveTask(dir, task); refreshFooter(ctx);
          output = { ...summary(task), completed: true }; break;
        }
        case "archive": {
          const task = loadTask(dir, required(p.id, "id"));
          if (task.status === "running") throw new Error("Wait for running subagent before archiving");
          task.status = "archived"; saveTask(dir, task); refreshFooter(ctx); output = summary(task); break;
        }
        case "dispatch": {
          if (p.baseVersion !== undefined && !p.base) throw new Error("baseVersion requires base");
          const base = p.base ? resolveBase(ctx.cwd, p.base, p.baseVersion) : undefined;
          output = await dispatch(required(p.id, "id"), required(p.name, "name"), p.guidance || "", false, p.model, p.think, base); break;
        }
        case "continue": {
          if (p.id) {
            const task = loadTask(dir, p.id);
            output = await dispatch(p.id, required(task.runs.at(-1)?.agent, "paused agent"), p.guidance || "Continue interrupted work.", true, p.model, p.think);
          } else {
            if (p.guidance || p.model || p.think) throw new Error("Use a task ID when sending specific guidance or selecting a model");
            const paused = listTasks(dir).filter(t => t.status === "paused" && t.runs.length);
            if (!paused.length) { output = { message: "No paused subagents" }; break; }
            output = await Promise.all(paused.map(async task => {
              try { return await dispatch(task.id, task.runs.at(-1)!.agent, "Continue interrupted work.", true); }
              catch (error) { return { task: task.id, error: String(error) }; }
            }));
          }
          break;
        }
      }
      return { content: [{ type: "text", text: JSON.stringify(output) }], details: undefined };
    },
  });
}
