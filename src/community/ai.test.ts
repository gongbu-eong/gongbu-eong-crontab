import assert from "node:assert/strict";
import test from "node:test";
import { createGenerator } from "./ai";

const config = { apiKey: "test-only-key", model: "test-model", timeoutMs: 1000, retries: 2, sleep: async () => {} };
const completed = () => Response.json({ status: "completed", output: [{ content: [{ type: "output_text", text: '{"ok":true}' }] }] });

test("structured response request uses a timeout, no storage, schema and system instructions", async () => {
  const generate = createGenerator({ ...config, fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "test-model");
    assert.equal(body.store, false);
    assert.equal(body.text.format.strict, true);
    assert.ok(body.instructions.includes("직접 창작"));
    assert.ok(init?.signal);
    return completed();
  } });
  assert.deepEqual(await generate("test", {}, {}, (value) => value), { ok: true });
});

test("transient and validation failures retry but never fall back to template text", async () => {
  let calls = 0;
  const generate = createGenerator({ ...config, fetch: async () => ++calls === 1 ? new Response("busy", { status: 429 }) : completed() });
  assert.deepEqual(await generate("test", {}, {}, (value) => { if (calls === 2) throw new Error("invalid"); return value; }), { ok: true });
  assert.equal(calls, 3);
  calls = 0;
  const broken = createGenerator({ ...config, fetch: async () => { calls++; return Response.json({ status: "incomplete" }); } });
  await assert.rejects(broken("test", {}, {}, (value) => value), /generation failed/);
  assert.equal(calls, 3);
});

test("authentication errors and refusals fail without retrying or leaking response bodies", async () => {
  for (const response of [new Response("secret provider body", { status: 401 }), Response.json({ status: "completed", output: [{ content: [{ type: "refusal" }] }] })]) {
    let calls = 0;
    const generate = createGenerator({ ...config, fetch: async () => { calls++; return response; } });
    await assert.rejects(generate("test", {}, {}, (value) => value), (error: Error) => !error.message.includes("secret"));
    assert.equal(calls, 1);
  }
});
