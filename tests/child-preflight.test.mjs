import { test } from "node:test";
import assert from "node:assert/strict";
import { configureChildModel } from "../src/child-preflight.ts";
const choice = { model: "provider/family/model", think: "high" };

test("configures idle child before returning with exact model and reasoning", async () => {
  const calls = [];
  await configureChildModel(async (type, fields) => {
    calls.push({ type, fields });
    if (type === "get_state") return { model: { provider: "provider", id: "family/model" }, thinkingLevel: "high", sessionId: "s1", sessionFile: "/tmp/s1.jsonl" };
  }, choice);
  assert.deepEqual(calls, [
    { type: "set_model", fields: { provider: "provider", modelId: "family/model" } },
    { type: "set_thinking_level", fields: { level: "high" } },
    { type: "get_state", fields: undefined },
  ]);
});

test("rejects silently clamped reasoning or wrong model", async () => {
  for (const state of [
    { model: { provider: "provider", id: "family/model" }, thinkingLevel: "low" },
    { model: { provider: "other", id: "family/model" }, thinkingLevel: "high" },
    {},
  ]) await assert.rejects(configureChildModel(async type => type === "get_state" ? state : undefined, choice), /Requested/);
});

test("rejects failed model selection without changing reasoning", async () => {
  const calls = [];
  await assert.rejects(configureChildModel(async type => { calls.push(type); throw new Error("not found"); }, choice), /not found/);
  assert.deepEqual(calls, ["set_model"]);
});
