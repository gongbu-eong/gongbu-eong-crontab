import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { runCommunitySeed, type SeedClient } from "./seed";
import type { GenerateJson } from "./ai";
import { summarizeSeedError } from "./errors";
import { assertNoStoredDuplicate } from "./continuity";

test("daily seeding is atomic, resumable, time ordered and idempotent", async (t) => {
  const database = new PGlite();
  await database.exec(`
    CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text, status text);
    CREATE TABLE community_posts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES users,
      category text, title text, content text, created_at timestamptz, updated_at timestamptz);
    CREATE TABLE community_comments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), post_id uuid REFERENCES community_posts,
      user_id uuid REFERENCES users, parent_comment_id uuid REFERENCES community_comments,
      content text, created_at timestamptz, updated_at timestamptz);
    INSERT INTO users (email, status) VALUES ('one@example.local', 'active'), ('two@EXAMPLE.LOCAL', 'active'),
      ('three@example.local', 'active'), ('four@example.local', 'active'), ('real@real.test', 'active'),
      ('inactive@example.local', 'suspended'), ('spoof@example.local.evil', 'active');
  `);
  await database.exec(await readFile(new URL("../../docs/database/20260923_community_daily_seed.sql", import.meta.url), "utf8"));
  const migration = await readFile(new URL("../../docs/database/20260928_community_identity_memory.sql", import.meta.url), "utf8");
  await database.exec(migration);
  await database.exec(migration);
  let clock = new Date("2026-09-22T00:01:00+09:00");
  let locked = false;
  let failInsert = false;
  let failGeneration = false;
  let failErrorRecording = false;
  let slowPublication = false;
  let generated = 0;
  let personaCalls = 0;
  let identityCalls = 0;
  let rejectReview = false;
  let rejectNextReview = false;
  let reviewCalls = 0;
  let released = 0;
  let destroyed = false;
  const client: SeedClient = {
    async query(sql, values) {
      if (sql.includes("pg_try_advisory_lock")) {
        const acquired = !locked;
        locked = true;
        return { rows: [{ locked: acquired }] } as never;
      }
      if (sql.includes("pg_advisory_unlock")) { locked = false; return { rows: [] }; }
      if (sql === "SELECT clock_timestamp() AS current_time") return { rows: [{ current_time: clock }] } as never;
      if (failInsert && sql.includes("INSERT INTO public.community_comments")) {
        throw Object.assign(new Error("private row content must not be logged"), {
          code: "23503", table: "community_comments", constraint: "community_comments_user_id_fkey",
          detail: "private account data",
        });
      }
      if (failErrorRecording && sql.includes("SET status = 'failed'")) throw new Error("connection terminated");
      if (slowPublication && sql.includes("INSERT INTO public.community_posts")) clock = new Date("2026-09-25T23:59:59+09:00");
      return database.query(sql, values);
    },
    release(destroy) { released++; destroyed = Boolean(destroy); if (destroy) locked = false; },
  };
  const generate: GenerateJson = async (name, _schema, input, validate) => {
    const args = input as {
      task: string; keys: string[]; count: number; postAuthor: string; participants: { key: string }[];
      actors: { key: string; identity: { birthYear: number }; history: { posts: unknown[]; comments: unknown[] } }[];
      thread: { author: string; title: string; comments: { author: string }[] };
    };
    if (name === "community_personas") {
      personaCalls++;
      assert.doesNotMatch(args.task, /300자/);
      return validate({ personas: args.keys.map((key) => ({ key, ageGroup: "20s", background: "fictional student", tone: "t".repeat(302) })) });
    }
    if (name === "community_fixed_identities") {
      identityCalls++;
      return validate({ profiles: args.actors.map((actor) => ({ key: actor.key, identity: {
        birthYear: 2000, employmentStatus: "unemployed", currentRole: "취업 준비생", targetRole: "행정직", preparationStage: "필기 준비",
      }, conflicts: [] })) });
    }
    if (name === "community_day_plan") {
      assert.ok(args.actors.every((actor) => actor.identity.birthYear === 2000));
      if (clock.getDate() !== 22 && generated > 0) assert.ok(args.actors.some((actor) => actor.history.posts.length > 0));
      return validate({ topics: Array.from({ length: args.count }, (_, index) => ({ author: args.actors[index % args.actors.length].key, category: "자유·잡담", scenario: `topic ${index}` })) });
    }
    if (name === "community_continuity_review") {
      reviewCalls++;
      const reject = rejectReview || rejectNextReview;
      rejectNextReview = false;
      return validate({
        checks: [...new Set([args.thread.author, ...args.thread.comments.map((comment) => comment.author)])].map((author) => ({ author, consistent: !reject, reason: reject ? "Unapproved employment change" : "Consistent" })),
        duplicatePost: false, duplicateReason: "New situation", topicKey: args.thread.title, summary: args.thread.title,
      });
    }
    assert.match(args.task, /제목 120자, 본문 5000자, 각 댓글 및 대댓글 500자 이하/);
    if (failGeneration && generated === 1) throw new Error("simulated AI failure");
    generated++;
    return validate({ author: args.postAuthor, title: `generated ${clock.toISOString()} ${generated}`, content: `fixture ${clock.toISOString()} ${generated}`, comments: [
      { author: args.participants[1].key, content: "first response", parent: null },
      { author: args.postAuthor, content: "author reply", parent: 0 },
      { author: args.participants[2].key, content: "other response", parent: null },
    ] });
  };
  const run = () => runCommunitySeed({ connect: async () => client, generate, model: "test-model", now: () => clock });

  try {
    await t.test("saves no public records on AI failure and resumes saved drafts", async () => {
      failGeneration = true;
      await assert.rejects(run(), /AI failure/);
      const state = await database.query<{ status: string; count: number }>("SELECT status, jsonb_array_length(drafts) AS count FROM community_seed_runs");
      assert.deepEqual(state.rows[0], { status: "failed", count: 1 });
      const failure = await database.query<{ error_message: string }>("SELECT error_message FROM community_seed_runs");
      assert.match(failure.rows[0].error_message, /stage=generate_thread:2\/\d+.*simulated AI failure/);
      assert.equal((await database.query("SELECT * FROM community_posts")).rows.length, 0);
      failGeneration = false;
      const result = await run();
      assert.equal(result.status, "completed");
      assert.ok(result.posts! >= 3 && result.posts! <= 20);
      assert.equal(generated, result.posts);
      assert.equal(result.comments, result.posts! * 3);
      assert.equal(personaCalls, 1);
      assert.equal(identityCalls, 1);
      const personas = await database.query<{ length: number }>("SELECT length(persona->>'tone') AS length FROM community_seed_personas");
      assert.ok(personas.rows.every((row) => row.length === 302));
      assert.equal((await database.query<{ error_message: string | null }>("SELECT error_message FROM community_seed_runs")).rows[0].error_message, null);
      assert.equal((await database.query("SELECT * FROM community_seed_memories")).rows.length, result.posts);
      const invalid = await database.query(`SELECT comments.id FROM community_comments comments
        JOIN community_posts posts ON posts.id = comments.post_id
        LEFT JOIN community_comments parent ON parent.id = comments.parent_comment_id
        WHERE comments.created_at <= posts.created_at OR comments.created_at <= parent.created_at
          OR comments.created_at >= '2026-09-23T00:00:00+09:00'::timestamptz
          OR comments.updated_at <> comments.created_at OR posts.updated_at <> posts.created_at`);
      assert.equal(invalid.rows.length, 0);
      const badAuthors = await database.query(`SELECT posts.id FROM community_posts posts JOIN users ON users.id = posts.user_id
        WHERE users.email NOT ILIKE '%@example.local' OR users.status <> 'active'`);
      assert.equal(badAuthors.rows.length, 0);
    });
    await t.test("completed day skips AI and writes, concurrent lock skips execution", async () => {
      const before = generated;
      assert.equal((await run()).status, "already_completed");
      assert.equal(generated, before);
      locked = true;
      assert.equal((await run()).status, "skipped_locked");
      locked = false;
    });
    await t.test("insert failure rolls back all posts; retry publishes saved AI drafts without regenerating", async () => {
      clock = new Date("2026-09-23T00:01:00+09:00");
      const previousCount = (await database.query("SELECT * FROM community_posts")).rows.length;
      const previousMemories = (await database.query("SELECT * FROM community_seed_memories")).rows.length;
      failInsert = true;
      await assert.rejects(run(), /PostgreSQL 23503/);
      const failure = await database.query<{ error_message: string }>("SELECT error_message FROM community_seed_runs WHERE seed_date = '2026-09-23'");
      assert.match(failure.rows[0].error_message, /stage=publish_comment:post=1\/\d+,comment=1/);
      assert.match(failure.rows[0].error_message, /foreign key violation; table=community_comments; constraint=community_comments_user_id_fkey/);
      assert.doesNotMatch(failure.rows[0].error_message, /private/);
      assert.equal((await database.query("SELECT * FROM community_posts")).rows.length, previousCount);
      assert.equal((await database.query("SELECT * FROM community_seed_memories")).rows.length, previousMemories);
      const before = generated;
      failInsert = false;
      assert.equal((await run()).status, "completed");
      assert.equal(generated, before);
      assert.equal(personaCalls, 1);
      assert.equal(identityCalls, 1);
    });
    await t.test("disabled authors abort a resumed run, and a late run does not backdate", async () => {
      clock = new Date("2026-09-24T00:01:00+09:00");
      failInsert = true;
      await assert.rejects(run());
      failInsert = false;
      await database.exec("UPDATE users SET status = 'suspended' WHERE email = 'one@example.local'");
      const before = generated;
      await assert.rejects(run(), /no longer eligible/);
      assert.equal(generated, before);
      clock = new Date("2026-09-25T23:59:00+09:00");
      await assert.rejects(run(), /Insufficient time/);
      assert.equal(generated, before);
    });
    await t.test("a transaction that outlives its earliest publication time rolls back", async () => {
      await database.exec("UPDATE users SET status = 'active' WHERE email = 'one@example.local'");
      clock = new Date("2026-09-25T00:01:00+09:00");
      const previousCount = (await database.query("SELECT * FROM community_posts")).rows.length;
      slowPublication = true;
      await assert.rejects(run(), /exceeded the first scheduled time/);
      slowPublication = false;
      assert.equal((await database.query("SELECT * FROM community_posts")).rows.length, previousCount);
    });
    await t.test("resume preflight failures replace stale generic errors without losing drafts", async () => {
      clock = new Date("2026-09-25T00:01:00+09:00");
      const before = generated;
      await assert.rejects(runCommunitySeed({ connect: async () => client, generate, model: "changed-model", now: () => clock }), /original OPENAI_MODEL/);
      const failure = await database.query<{ error_message: string }>("SELECT error_message FROM community_seed_runs WHERE seed_date = '2026-09-25'");
      assert.match(failure.rows[0].error_message, /stage=check_schedule_and_model.*original OPENAI_MODEL/);
      assert.equal(generated, before);
      assert.equal((await run()).status, "completed");
      assert.equal(generated, before);
    });
    await t.test("a failed error-record update preserves the original failure in job logs and discards the connection", async () => {
      clock = new Date("2026-09-26T00:01:00+09:00");
      const before = (await database.query("SELECT * FROM community_posts")).rows.length;
      failInsert = true;
      failErrorRecording = true;
      await assert.rejects(run(), (error: Error) => {
        assert.match(error.message, /stage=publish_comment:.*PostgreSQL 23503/);
        assert.match(error.message, /failure could not be saved/);
        assert.doesNotMatch(error.message, /private/);
        return true;
      });
      assert.equal(destroyed, true);
      assert.equal(locked, false);
      assert.equal((await database.query("SELECT * FROM community_posts")).rows.length, before);
      failInsert = false;
      failErrorRecording = false;
      assert.equal((await run()).status, "completed");
    });
    await t.test("a rejected draft is regenerated, while repeated inconsistency never publishes", async () => {
      clock = new Date("2026-09-27T00:01:00+09:00");
      const before = generated;
      rejectNextReview = true;
      const result = await run();
      assert.equal(result.status, "completed");
      assert.equal(generated - before, result.posts! + 1);
      clock = new Date("2026-09-28T00:01:00+09:00");
      const postCount = (await database.query("SELECT * FROM community_posts")).rows.length;
      const reviews = reviewCalls;
      rejectReview = true;
      await assert.rejects(run(), /review failed after 3 content attempts/);
      assert.equal(reviewCalls - reviews, 3);
      assert.equal((await database.query("SELECT * FROM community_posts")).rows.length, postCount);
      rejectReview = false;
      assert.equal((await run()).status, "completed");
      assert.equal(identityCalls, 1);
    });
    await t.test("unfinished legacy drafts are archived and completed legacy runs remain untouched", async () => {
      await database.query(`INSERT INTO community_seed_runs(seed_date,status,post_count,model,plan,drafts)
        VALUES ('2026-09-29','failed',3,'test-model','[{"category":"legacy"}]','[{"thread":"legacy"}]')`);
      clock = new Date("2026-09-29T00:01:00+09:00");
      assert.equal((await run()).status, "completed");
      const archived = await database.query<{ continuity_version: number; legacy_snapshot: { drafts: unknown[] } }>("SELECT continuity_version,legacy_snapshot FROM community_seed_runs WHERE seed_date='2026-09-29'");
      assert.equal(archived.rows[0].continuity_version, 2);
      assert.deepEqual(archived.rows[0].legacy_snapshot.drafts, [{ thread: "legacy" }]);
      await database.query("INSERT INTO community_seed_runs(seed_date,status,post_count,model) VALUES ('2026-09-30','completed',3,'test-model')");
      clock = new Date("2026-09-30T00:01:00+09:00");
      assert.equal((await run()).status, "already_completed");
      const unchanged = await database.query<{ continuity_version: number; legacy_snapshot: unknown }>("SELECT continuity_version,legacy_snapshot FROM community_seed_runs WHERE seed_date='2026-09-30'");
      assert.equal(unchanged.rows[0].continuity_version, 1);
      assert.equal(unchanged.rows[0].legacy_snapshot, null);
    });
    await t.test("database checks reject old exact bodies and remembered topics outside recent AI history", async () => {
      const old = (await database.query<{ user_id: string; content: string; topic_key: string }>(`SELECT p.user_id,p.content,m.topic_key
        FROM community_posts p JOIN community_seed_memories m ON m.post_id=p.id ORDER BY p.created_at LIMIT 1`)).rows[0];
      const candidate = { author: "a0", title: "completely new title", content: old.content, comments: [] };
      await assert.rejects(assertNoStoredDuplicate(client, old.user_id, candidate), /duplicate_post/);
      await assert.rejects(assertNoStoredDuplicate(client, old.user_id, { ...candidate, content: "different body" }, old.topic_key), /duplicate_post/);
      await assert.rejects(database.query(`INSERT INTO community_seed_memories
        (user_id,seed_date,topic_key,topic_hash,content_hash,summary,review,published_at)
        SELECT user_id,seed_date,topic_key,topic_hash,'different-hash',summary,review,published_at FROM community_seed_memories LIMIT 1`), (error: Error & { code: string }) => error.code === "23505");
    });
    assert.ok(released >= 8);
    assert.equal(locked, false);
  } finally {
    await database.close();
  }
});

test("failure summaries remove credentials and do not copy PostgreSQL row values", () => {
  const summary = summarizeSeedError(new Error("GPT_API_KEY=secret\nBearer private-token postgres://user:password@db.test/database sk-private-key"));
  assert.doesNotMatch(summary, /secret|private-token|user:password|sk-private-key|\n/);
  assert.match(summary, /redacted/);
  assert.equal(summarizeSeedError(Object.assign(new Error("private user values"), { code: "23514", constraint: "status_check" })), "PostgreSQL 23514; check constraint violation; constraint=status_check");
});
