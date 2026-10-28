import type { ModelChoice } from "./agent-models.ts";

/** Configure an idle RPC child and verify Pi did not clamp its requested settings. */
export async function configureChildModel(command: (type: string, fields?: Record<string, unknown>) => Promise<any>, choice: ModelChoice): Promise<{ sessionId: string; sessionFile: string }> {
  const slash = choice.model.indexOf("/");
  const provider = choice.model.slice(0, slash), modelId = choice.model.slice(slash + 1);
  await command("set_model", { provider, modelId });
  await command("set_thinking_level", { level: choice.think });
  const state = await command("get_state");
  if (state?.model?.provider !== provider || state?.model?.id !== modelId || state?.thinkingLevel !== choice.think)
    throw new Error(`Requested ${choice.model} reasoning ${choice.think}; child reported ${state?.model?.provider}/${state?.model?.id} reasoning ${state?.thinkingLevel}`);
  if (!state?.sessionId || !state?.sessionFile) throw new Error("Child did not report a persistent session");
  return { sessionId: state.sessionId, sessionFile: state.sessionFile };
}
