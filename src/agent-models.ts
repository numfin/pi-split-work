export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ModelChoice = { model: string; think: typeof thinkingLevels[number] };

/** Validate exact configured combinations. Legacy single-model agents remain valid. */
export function parseAgentModels(frontmatter: Record<string, unknown>): ModelChoice[] {
  const raw = frontmatter.models === undefined
    ? [{ model: frontmatter.model, think: frontmatter.think }]
    : frontmatter.models;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 32) throw new Error("models must contain 1–32 model/reasoning combinations");
  const result = raw.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Each model must be an object");
    const value = item as Record<string, unknown>;
    if (typeof value.model !== "string" || !/^[^\s/]+\/[^\s]+$/.test(value.model)) throw new Error("Expected exact provider/model");
    if (typeof value.think !== "string" || !thinkingLevels.includes(value.think as ModelChoice["think"])) throw new Error("Invalid reasoning level");
    return { model: value.model, think: value.think as ModelChoice["think"] };
  });
  if (new Set(result.map(item => JSON.stringify(item))).size !== result.length) throw new Error("Duplicate model/reasoning combination");
  return result;
}

export function selectAgentModel(choices: ModelChoice[], model?: string, think?: string): ModelChoice {
  if (model === undefined && think === undefined) return choices[0];
  if (!model || !think) throw new Error("Specify both provider/model and reasoning");
  const selected = choices.find(choice => choice.model === model && choice.think === think);
  if (!selected) throw new Error("Model/reasoning combination is not allowed for this agent");
  return selected;
}
