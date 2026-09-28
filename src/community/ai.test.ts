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
  const invalid = createGenerator({ ...config, fetch: async () => completed() });
  await assert.rejects(invalid("test", {}, {}, () => { throw new Error("bad parent"); }), /validation: bad parent/);
});

test("authentication errors and refusals fail without retrying or leaking response bodies", async () => {
  for (const response of [new Response("secret provider body", { status: 401 }), Response.json({ status: "completed", output: [{ content: [{ type: "refusal" }] }] })]) {
    let calls = 0;
    const generate = createGenerator({ ...config, fetch: async () => { calls++; return response; } });
    await assert.rejects(generate("test", {}, {}, (value) => value), (error: Error) => !error.message.includes("secret"));
    assert.equal(calls, 1);
  }
});

test("provider failures retain safe error codes and request IDs, not messages or keys", async () => {
  let calls = 0;
  const generate = createGenerator({ ...config, fetch: async () => {
    calls++;
    return Response.json({ error: {
      code: "invalid_api_key", type: "invalid_request_error", param: "text.format",
      message: "secret provider body sk-do-not-log-this",
    } }, { status: 401, headers: { "x-request-id": "req_test123" } });
  } });
  await assert.rejects(generate("community_personas", {}, {}, (value) => value), (error: Error) => {
    assert.match(error.message, /HTTP 401; code=invalid_api_key; type=invalid_request_error; param=text.format/);
    assert.match(error.message, /model=test-model, attempts=1/);
    assert.match(error.message, /request_id=req_test123/);
    assert.doesNotMatch(error.message, /secret|sk-do-not-log-this/);
    return true;
  });
  assert.equal(calls, 1);
});

test("quota failures do not retry, while transient throttling respects Retry-After", async () => {
  for (const code of ["insufficient_quota", "credit_balance_exhausted", "project_spend_limit_exceeded"]) {
    let calls = 0;
    const generate = createGenerator({ ...config, fetch: async () => {
      calls++;
      return Response.json({ error: { code } }, { status: 429 });
    } });
    await assert.rejects(generate("test", {}, {}, (value) => value), new RegExp(code));
    assert.equal(calls, 1);
  }
  let calls = 0;
  const waits: number[] = [];
  const throttled = createGenerator({ ...config, timeoutMs: 10000, sleep: async (ms) => { waits.push(ms); }, fetch: async () => {
    calls++;
    return calls === 1
      ? Response.json({ error: { code: "rate_limit_exceeded" } }, { status: 429, headers: { "retry-after": "3" } })
      : completed();
  } });
  await throttled("test", {}, {}, (value) => value);
  assert.deepEqual(waits, [3000]);
  assert.equal(calls, 2);
});

test("validation retries include the failed condition while retaining the original input", async () => {
  const requests: { instructions: string; input: string }[] = [];
  const generate = createGenerator({ ...config, fetch: async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return completed();
  } });
  await generate("test", {}, { postAuthor: "a0" }, (value) => {
    if (requests.length === 1) throw new Error("Reply must reference an earlier top-level comment in this thread");
    return value;
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].input, requests[1].input);
  assert.doesNotMatch(requests[0].instructions, /\[재시도 검증 오류\]/);
  assert.match(requests[1].instructions, /Reply must reference an earlier top-level comment/);
});

test("long Retry-After delays fail clearly instead of immediately retrying", async () => {
  let calls = 0;
  const generate = createGenerator({ ...config, sleep: async () => { assert.fail("must not retry before the server permits it"); }, fetch: async () => {
    calls++;
    return new Response("busy", { status: 503, headers: { "retry-after": "120" } });
  } });
  await assert.rejects(generate("test", {}, {}, (value) => value), /HTTP 503; Retry-After=120s exceeds request timeout/);
  assert.equal(calls, 1);
});

test("incomplete responses and network timeouts identify their actual failure category", async () => {
  const incomplete = createGenerator({ ...config, retries: 0, fetch: async () => Response.json({
    status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
  }) });
  await assert.rejects(incomplete("test", {}, {}, (value) => value), /incomplete response; status=incomplete; code=max_output_tokens/);
  const timedOut = createGenerator({ ...config, retries: 0, fetch: async () => { throw new DOMException("secret", "TimeoutError"); } });
  await assert.rejects(timedOut("test", {}, {}, (value) => value), /request timeout; model=test-model, attempts=1, timeout_ms=1000/);
  const network = createGenerator({ ...config, retries: 0, fetch: async () => { throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }); } });
  await assert.rejects(network("test", {}, {}, (value) => value), /network: TypeError; code=ECONNRESET/);
});
