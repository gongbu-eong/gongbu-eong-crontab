import assert from "node:assert/strict";
import test from "node:test";
import type { GenerateJson } from "./ai";
import type { SeedClient } from "./seed";
import { actorContexts, assertFreshPost, ensureIdentities, fingerprint, lockIdentities, reviewDraft, reviewPassed, validateIdentity, type History, type ProfiledActor } from "./continuity";

const identity = { birthYear: 2000, employmentStatus: "unemployed", currentRole: "취준생", targetRole: "행정직", preparationStage: "필기 준비" };
const actors: ProfiledActor[] = ["a0", "a1", "a2"].map((key) => ({ key, userId: `private-${key}`, persona: { ageGroup: "20s", background: "student", tone: "casual" }, identity, identityVersion: 1 }));
const emptyHistory = (): History => ({ posts: [], comments: [], memories: [] });
const histories = new Map(actors.map((actor) => [actor.key, emptyHistory()]));
const thread = { author: "a0", title: "new topic", content: "new content", comments: [
  { author: "a1", content: "response", parent: null }, { author: "a2", content: "reply", parent: 0 },
] };

test("fixed identity age changes with the year, never with each generation; no user IDs reach AI", () => {
  assert.equal(actorContexts(actors, histories, [], "2026-09-28")[0].ageByBirthYear, 26);
  assert.equal(actorContexts(actors, histories, [], "2026-09-29")[0].ageByBirthYear, 26);
  assert.equal(actorContexts(actors, histories, [], "2027-01-01")[0].ageByBirthYear, 27);
  assert.doesNotMatch(JSON.stringify(actorContexts(actors, histories, [], "2026-09-28")), /private-/);
  assert.throws(() => validateIdentity({ ...identity, birthYear: 2020 }, "2026-09-28"), /adult birth year/);
});

test("rephrased formatting and near-identical bodies by the same author are blocked", () => {
  const history = emptyHistory();
  history.posts.push({ title: "new topic!", content: "old content", at: "2026-09-27" });
  assert.throws(() => assertFreshPost(thread, history, []), /duplicate_post/);
  const content = "오늘 행정직 준비를 하면서 독서실에서 오전 공부 루틴을 세우고 점심에는 기출문제를 풀어 보았습니다. 시간을 효율적으로 배분하고 싶습니다.";
  history.posts = [{ title: "original", content, at: "2026-09-27" }];
  assert.throws(() => assertFreshPost({ ...thread, content: content.replace("오늘", "어제") }, history, []), /duplicate_post/);
  assert.doesNotThrow(() => assertFreshPost(thread, emptyHistory(), [{ topic: { category: "자유·잡담", scenario: "test" }, thread: { ...thread, author: "a1" } }]));
  assert.equal(fingerprint("새로운 주제!"), fingerprint("새로운\n주제"));
});

test("review checks every comment/reply author and negative reviews are not retried into approval", async () => {
  let calls = 0;
  const generate: GenerateJson = async (_name, _schema, input, validate) => {
    calls++;
    const args = input as { actors: { key: string }[] };
    assert.equal(args.actors.length, 3);
    return validate({ checks: actors.map((actor) => ({ author: actor.key, consistent: actor.key !== "a2", reason: "role conflict" })), duplicatePost: false, duplicateReason: "none", topicKey: "topic", summary: "summary" });
  };
  const review = await reviewDraft(generate, thread, actors, histories, [], "2026-09-28");
  assert.equal(reviewPassed(review), false);
  assert.equal(calls, 1);
  const incomplete: GenerateJson = async (_name, _schema, _input, validate) => validate({ ...review, checks: review.checks.slice(1) });
  await assert.rejects(reviewDraft(incomplete, thread, actors, histories, [], "2026-09-28"), /Incomplete continuity review/);
});

test("an existing identity is reused, and changed or quarantined identities cannot be silently overwritten", async () => {
  let status = "active";
  let version = 1;
  const client: SeedClient = { async query() { return { rows: actors.map((actor) => ({ user_id: actor.userId, canonical_identity: identity, identity_status: status, identity_version: version })) } as never; }, release() {} };
  const neverGenerate: GenerateJson = async () => { throw new Error("must not regenerate a locked identity"); };
  assert.deepEqual(await ensureIdentities(client, actors, histories, neverGenerate, "2026-09-28"), actors);
  version = 2;
  await assert.rejects(ensureIdentities(client, actors, histories, neverGenerate, "2026-09-28"), /identity changed/);
  status = "needs_review";
  await assert.rejects(ensureIdentities(client, actors, histories, neverGenerate, "2026-09-28"), /operator review/);
  const changed: SeedClient = { async query() { return { rows: [] }; }, release() {} };
  await assert.rejects(lockIdentities(changed, actors), /changed before publication/);
});

test("conflicting legacy statements quarantine a first-time identity instead of overwriting history", async () => {
  let stored: { user_id: string; canonical_identity: unknown; identity_status: string; identity_version: number } = {
    user_id: actors[0].userId, canonical_identity: null, identity_status: "uninitialized", identity_version: 0,
  };
  const client: SeedClient = {
    async query(sql, values) {
      if (sql.startsWith("UPDATE")) {
        stored = { ...stored, canonical_identity: JSON.parse(String(values![1])), identity_status: String(values![2]), identity_version: 1 };
        assert.deepEqual(JSON.parse(String(values![3])), ["Conflicting ages in existing posts"]);
        return { rows: [{ user_id: stored.user_id }] } as never;
      }
      return { rows: [stored] } as never;
    }, release() {},
  };
  let calls = 0;
  const generate: GenerateJson = async (_name, _schema, _input, validate) => {
    calls++;
    return validate({ profiles: [{ key: "a0", identity, conflicts: ["Conflicting ages in existing posts"] }] });
  };
  await assert.rejects(ensureIdentities(client, [actors[0]], histories, generate, "2026-09-28"), /operator review/);
  assert.equal(stored.identity_status, "needs_review");
  await assert.rejects(ensureIdentities(client, [actors[0]], histories, generate, "2026-09-28"), /operator review/);
  assert.equal(calls, 1);
});

test("a passing review may omit explanations but a rejected check must explain the conflict", async () => {
  const result = { checks: actors.map((actor) => ({ author: actor.key, consistent: true, reason: "" })), duplicatePost: false, duplicateReason: "", topicKey: "new topic", summary: "new event" };
  const generate: GenerateJson = async (_name, _schema, _input, validate) => validate(result);
  assert.equal(reviewPassed(await reviewDraft(generate, thread, actors, histories, [], "2026-09-28")), true);
  result.checks[0].consistent = false;
  await assert.rejects(reviewDraft(generate, thread, actors, histories, [], "2026-09-28"), /Missing continuity text/);
});
