import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAgentModels, selectAgentModel } from "../src/agent-models.ts";

test("legacy model and reasoning remain supported", () => {
  assert.deepEqual(parseAgentModels({ model: "provider/model", think: "low" }), [{ model: "provider/model", think: "low" }]);
});

test("multiple combinations require exact allowed model and reasoning", () => {
  const choices = parseAgentModels({ models: [{ model: "one/a", think: "low" }, { model: "two/b", think: "high" }] });
  assert.deepEqual(selectAgentModel(choices), choices[0]);
  assert.deepEqual(selectAgentModel(choices, "two/b", "high"), choices[1]);
  assert.throws(() => selectAgentModel(choices, "two/b", "low"), /not allowed/);
  assert.throws(() => selectAgentModel(choices, "one/a"), /both/);
});

test("malformed and duplicate configurations are rejected", () => {
  for (const models of [[], [{}], [{ model: "no-provider", think: "low" }], [{ model: "a/b", think: "bad" }], [{ model: "a/b", think: "low" }, { model: "a/b", think: "low" }]])
    assert.throws(() => parseAgentModels({ models }));
});
