import { test } from "node:test";
import assert from "node:assert/strict";
import { FooterSummarizer, cleanSummary } from "../src/footer-summary.ts";

const config = { enabled: true, provider: "test", model: "small", intervalSeconds: 3600, reasoning: "off" };
const snapshot = () => ({ task: "task-1", run: "run-1", title: "Fix checkout", agent: "coder", activity: "bash: npm test" });
function fixture(t, extra = {}) {
  const state = { snapshots: [snapshot()], requests: [], applied: [], errors: [] };
  const summarizer = new FooterSummarizer({
    snapshot: () => state.snapshots,
    complete: async (settings, prompt) => {
      state.requests.push({ settings, prompt });
      return '{"0":"Проверяет исправления оформления заказа."}';
    },
    apply: (s, text) => state.applied.push({ s, text }),
    error: e => state.errors.push(e),
    ...extra,
  });
  t.after(() => summarizer.stop());
  return { state, summarizer };
}

test("summary is disabled by default and skips idle/unchanged work", async t => {
  const { state, summarizer } = fixture(t);
  await summarizer.tick();
  assert.equal(state.requests.length, 0);
  summarizer.configure(config);
  state.snapshots = [];
  await summarizer.tick();
  assert.equal(state.requests.length, 0);
  state.snapshots = [snapshot()];
  await summarizer.tick();
  await summarizer.tick();
  assert.equal(state.requests.length, 1);
  assert.equal(state.applied[0].text, "Проверяет исправления оформления заказа.");
  state.snapshots[0].activity = "read: src/checkout.ts";
  await summarizer.tick();
  assert.equal(state.requests.length, 2);
});

test("one isolated request batches agents without private reasoning or tracker context", async t => {
  const { state, summarizer } = fixture(t);
  state.snapshots.push({ ...snapshot(), run: "run-2", task: "task-2", agent: "reviewer" });
  summarizer.configure({ ...config, reasoning: "low" });
  await summarizer.tick();
  const request = state.requests[0];
  assert.equal(request.settings.reasoning, "low");
  assert.equal(Object.keys(JSON.parse(request.prompt)).length, 2);
  assert.doesNotMatch(request.prompt, /run-1|task-1|instructions\.md/);
});

test("disable aborts in-flight request and discards late results without overlap", async t => {
  let resolve, calls = 0, signal;
  const { state, summarizer } = fixture(t, {
    complete: async (_settings, _prompt, s) => {
      calls++; signal = s;
      return new Promise(r => resolve = r);
    },
  });
  summarizer.configure(config);
  const pending = summarizer.tick();
  await summarizer.tick();
  assert.equal(calls, 1);
  summarizer.configure({ ...config, enabled: false });
  assert.ok(signal.aborted);
  summarizer.configure({ ...config, model: "other" });
  await summarizer.tick();
  assert.equal(calls, 1);
  resolve('{"0":"Поздний результат."}');
  await pending;
  assert.equal(state.applied.length, 0);
});

test("invalid JSON does not replace footer titles; errors are reported", async t => {
  const { state, summarizer } = fixture(t, { complete: async () => "not JSON" });
  summarizer.configure(config);
  await summarizer.tick();
  assert.equal(state.applied.length, 0);
  assert.equal(state.errors.length, 1);
});

test("summary length and sentence count are not validated or truncated", async t => {
  const text = "One two three four five six seven eight nine ten eleven. " + "x".repeat(161);
  const { state, summarizer } = fixture(t, { complete: async () => JSON.stringify({ 0: text }) });
  summarizer.configure(config);
  await summarizer.tick();
  await summarizer.tick();
  assert.equal(state.applied[0].text, text);
  assert.equal(state.applied.length, 1);
  assert.equal(state.errors.length, 0);
  assert.equal(cleanSummary("Checking tests"), "Checking tests");
});

test("summary text is sanitized for the terminal; missing text is ignored", async t => {
  assert.equal(cleanSummary("\u001bПроверяет\n тесты."), "Проверяет тесты.");
  assert.equal(cleanSummary(" \n "), undefined);
  assert.equal(cleanSummary(null), undefined);
  assert.equal(cleanSummary(42), undefined);
  const { state, summarizer } = fixture(t, { complete: async () => '{"0":null}' });
  summarizer.configure(config);
  await summarizer.tick();
  assert.equal(state.applied.length, 0);
  assert.equal(state.errors.length, 0);
});
