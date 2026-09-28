import assert from "node:assert/strict";
import test from "node:test";
import { COMMUNITY_TEXT_LIMITS, sample, scheduleDrafts, seoulDay, validateThread, validatePersonas, validatePlan, type Actor, type Draft } from "./content";

const actors: Actor[] = ["a0", "a1", "a2"].map((key) => ({ key, userId: key, persona: { ageGroup: "20s", background: "student", tone: "casual" } }));
const thread = { author: "a0", title: "title", content: "content", comments: [
  { author: "a1", content: "first", parent: null },
  { author: "a0", content: "reply", parent: 0 },
  { author: "a2", content: "second", parent: null },
] };

test("Seoul day boundaries do not depend on the server timezone", () => {
  assert.equal(seoulDay(new Date("2026-09-22T14:59:59Z")), "2026-09-22");
  assert.equal(seoulDay(new Date("2026-09-22T15:00:00Z")), "2026-09-23");
});

test("publication timestamps stay ordered and in the target day for both random extremes", () => {
  const drafts: Draft[] = Array.from({ length: 20 }, () => ({ topic: { category: "자유·잡담", scenario: "scenario" }, thread: {
    ...thread, comments: Array.from({ length: 10 }, (_, index) => ({ author: "a1", content: String(index), parent: index ? 0 : null })),
  } }));
  for (const now of ["2026-09-22T00:01:00+09:00", "2026-09-22T22:00:00+09:00"]) {
    for (const random of [(min: number) => min, (_min: number, max: number) => max - 1]) {
      const scheduled = scheduleDrafts(drafts, "2026-09-22", new Date(now), random);
      for (const item of scheduled) {
        let previous = item.postAt.getTime();
        assert.ok(previous > new Date(now).getTime());
        for (const time of item.commentTimes) {
          assert.ok(time.getTime() > previous);
          assert.equal(seoulDay(time), "2026-09-22");
          previous = time.getTime();
        }
      }
      assert.equal(new Set(scheduled.map((item) => item.postAt.getTime())).size, 20);
    }
  }
  assert.throws(() => scheduleDrafts(drafts, "2026-09-22", new Date("2026-09-23T00:00:00+09:00")));
  assert.throws(() => scheduleDrafts(drafts, "2026-09-22", new Date("2026-09-22T23:59:00+09:00")));
});

test("generated content validates author whitelist, reply references, text bounds and duplicates", () => {
  assert.deepEqual(validateThread(thread, actors, "a0", []), thread);
  assert.throws(() => validateThread({ ...thread, author: "unknown" }, actors, "a0", []));
  assert.throws(() => validateThread(thread, actors, "a0", [" t i t l e "]));
  assert.throws(() => validateThread({ ...thread, title: "x".repeat(121) }, actors, "a0", []));
  for (const parent of [0, -1, 10, 1.5, "0", undefined]) {
    assert.throws(() => validateThread({ ...thread, comments: [{ ...thread.comments[0], parent }, ...thread.comments.slice(1)] }, actors, "a0", []));
  }
  assert.throws(() => validateThread({ ...thread, comments: thread.comments.map((comment) => ({ ...comment, parent: null })) }, actors, "a0", []));
  assert.throws(() => validateThread({ ...thread, comments: thread.comments.map((comment) => ({ ...comment, content: "same" })) }, actors, "a0", []));
  assert.throws(() => validateThread({ ...thread, comments: [...thread.comments.slice(0, 2), { author: "a2", content: "nested", parent: 1 }] }, actors, "a0", []));
  assert.throws(() => validateThread({ ...thread, comments: [{ ...thread.comments[0], content: "x".repeat(501) }, ...thread.comments.slice(1)] }, actors, "a0", []));
});

test("personas and daily plans must exactly match requested authors and counts", () => {
  assert.throws(() => validatePersonas({ personas: [] }, ["a0"]));
  assert.throws(() => validatePersonas({ personas: [{ key: "a1", ...actors[0].persona }] }, ["a0"]));
  assert.equal(validatePersonas({ personas: [{ key: "a0", ...actors[0].persona }] }, ["a0"]).length, 1);
  assert.throws(() => validatePlan({ topics: [{ category: "not a board", scenario: "s" }] }, 1));
  assert.throws(() => validatePlan({ topics: [] }, 3));
  assert.equal(sample(actors, 3).length, new Set(sample(actors, 3)).size);
});

test("text validation identifies the failing field and limit without including generated text", () => {
  assert.throws(() => validateThread({ ...thread, title: "private".repeat(18) }, actors, "a0", []), (error: Error) => {
    assert.match(error.message, /thread.title must be non-empty and <= 120 characters \(received 126\)/);
    assert.doesNotMatch(error.message, /private/);
    return true;
  });
  assert.throws(() => validateThread({ ...thread, comments: [{ ...thread.comments[0], content: "x".repeat(501) }, ...thread.comments.slice(1)] }, actors, "a0", []), /comments\[0\].content.*<= 500/);
});

test("internal personas and plans do not inherit arbitrary public-content length limits", () => {
  const persona = { key: "a0", ageGroup: "a".repeat(81), background: "b".repeat(401), tone: "t".repeat(302) };
  assert.deepEqual(validatePersonas({ personas: [persona] }, ["a0"]), [persona]);
  const topic = { category: "자유·잡담", scenario: "s".repeat(601) };
  assert.deepEqual(validatePlan({ topics: [topic] }, 1), [topic]);
  for (const field of ["ageGroup", "background", "tone"]) {
    for (const invalid of ["", " \n ", null, 123]) {
      assert.throws(() => validatePersonas({ personas: [{ ...persona, [field]: invalid }] }, ["a0"]), /must be a non-empty string/);
    }
  }
  assert.throws(() => validatePlan({ topics: [{ ...topic, scenario: " " }] }, 1), /topic.scenario must be a non-empty string/);
});

test("public text boundaries match the community form and API for posts, comments and replies", () => {
  assert.deepEqual(COMMUNITY_TEXT_LIMITS, { title: 120, content: 5000, comment: 500 });
  const boundary = {
    ...thread, title: "가".repeat(120), content: "나".repeat(5000),
    comments: thread.comments.map((comment, index) => ({ ...comment, content: String(index).repeat(500) })),
  };
  assert.deepEqual(validateThread(boundary, actors, "a0", []), boundary);
  assert.throws(() => validateThread({ ...boundary, title: `${boundary.title}x` }, actors, "a0", []), /thread.title.*<= 120/);
  assert.throws(() => validateThread({ ...boundary, content: `${boundary.content}x` }, actors, "a0", []), /thread.content.*<= 5000/);
  for (const index of [0, 1]) {
    assert.throws(() => validateThread({ ...boundary, comments: boundary.comments.map((comment, i) => ({
      ...comment, content: i === index ? `${comment.content}x` : comment.content,
    })) }, actors, "a0", []), new RegExp(`comments\\[${index}\\].content.*<= 500`));
  }
});

test("public text still counts emoji as UTF-16 code units like HTML maxLength and the API", () => {
  const title = "\u{1F642}".repeat(60);
  assert.equal(title.length, 120);
  assert.equal(validateThread({ ...thread, title }, actors, "a0", []).title, title);
  assert.throws(() => validateThread({ ...thread, title: `${title}x` }, actors, "a0", []), /thread.title.*received 121/);
});
