import { randomInt } from "node:crypto";
import type { QueryResultRow } from "pg";
import type { GenerateJson } from "./ai";
import {
  CATEGORIES, personasSchema, planSchema, threadSchema, sample, seoulDay, scheduleDrafts,
  validatePersonas, validatePlan, validateThread,
  type Actor, type Draft, type Persona, type Topic,
} from "./content";

export interface SeedClient {
  query<T extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
  release(destroy?: boolean): void;
}
type Run = {
  status: string; post_count: number; model: string; actors: Actor[];
  plan: Topic[]; drafts: Draft[]; post_ids: string[]; comment_count: number;
};
const LOCK_ID = 2026092301;

export async function runCommunitySeed(options: {
  connect: () => Promise<SeedClient>; generate: GenerateJson; model: string; now?: () => Date;
  progress?: (message: string, context: Record<string, unknown>) => void;
}) {
  const now = options.now ?? (() => new Date());
  const client = await options.connect();
  let locked = false;
  let inTransaction = false;
  let runStarted = false;
  let destroy = false;
  let day = seoulDay(now());
  try {
    // Session lock also protects personas across instances and across midnight.
    const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [LOCK_ID]);
    locked = lock.rows[0]?.locked === true;
    if (!locked) return { status: "skipped_locked" };
    const clock = await client.query<{ current_time: Date | string }>("SELECT clock_timestamp() AS current_time");
    day = seoulDay(new Date(clock.rows[0].current_time));
    const existing = await client.query<Run>("SELECT * FROM public.community_seed_runs WHERE seed_date = $1::date", [day]);
    let run = existing.rows[0];
    if (run?.status === "completed") return { status: "already_completed", day, posts: run.post_ids.length, comments: run.comment_count };
    scheduleDrafts([], day, now());
    if (run && run.model !== options.model) throw new Error("Resume with the original COMMUNITY_SEED_MODEL");
    if (!run) {
      const result = await client.query<Run>(`
        INSERT INTO public.community_seed_runs (seed_date, status, post_count, model)
        VALUES ($1::date, 'running', $2, $3) RETURNING *
      `, [day, randomInt(3, 21), options.model]);
      run = result.rows[0];
    } else {
      await client.query(`UPDATE public.community_seed_runs SET status = 'running', attempts = attempts + 1,
        error_message = NULL, updated_at = NOW() WHERE seed_date = $1::date`, [day]);
    }
    runStarted = true;

    let actors = run.actors;
    if (!actors.length) {
      const eligible = await client.query<{ id: string; persona: Persona | null }>(`
        SELECT users.id, personas.persona FROM public.users users
        LEFT JOIN public.community_seed_personas personas ON personas.user_id = users.id
        WHERE users.status = 'active' AND users.email::text ILIKE '%@example.local'
        ORDER BY random() LIMIT 12
      `);
      if (eligible.rows.length < 3) throw new Error("At least three active @example.local accounts are required");
      const candidates = eligible.rows.map((row, index) => ({ key: `a${index}`, userId: row.id, persona: row.persona }));
      const missing = candidates.filter((actor) => !actor.persona);
      if (missing.length) {
        const keys = missing.map((actor) => actor.key);
        const generated = await options.generate("community_personas", personasSchema, {
          task: "각 key에 대해 가상 취업 준비생의 성인 나이대, 상황, 일관된 말투를 창작하세요. 존댓말/반말 및 연령대를 다양하게 분산하세요.", keys,
        }, (value) => validatePersonas(value, keys));
        for (const candidate of missing) {
          const { key: _key, ...persona } = generated.find((item) => item.key === candidate.key)!;
          await client.query(`INSERT INTO public.community_seed_personas (user_id, persona, model)
            VALUES ($1, $2::jsonb, $3) ON CONFLICT (user_id) DO NOTHING`, [candidate.userId, JSON.stringify(persona), options.model]);
          candidate.persona = persona;
        }
      }
      actors = candidates as Actor[];
      await client.query("UPDATE public.community_seed_runs SET actors = $2::jsonb, updated_at = NOW() WHERE seed_date = $1::date", [day, JSON.stringify(actors)]);
    }
    await assertEligibleAuthors(client, actors, false);
    const recent = await client.query<{ title: string }>(`
      SELECT posts.title FROM public.community_posts posts
      JOIN public.community_seed_runs runs ON posts.id = ANY(runs.post_ids)
      WHERE runs.status = 'completed' ORDER BY posts.created_at DESC LIMIT 100
    `);
    const previousTitles = recent.rows.map((row) => row.title);
    let plan = run.plan;
    if (!plan.length) {
      plan = await options.generate("community_day_plan", planSchema, {
        task: `서로 다른 주제 ${run.post_count}개를 기획하세요. 특정 주제나 말다툼에 편중하지 말고 다양한 카테고리와 대화 상황을 섞으세요. 과거 제목과 중복하지 마세요.`,
        date: day, count: run.post_count, categories: CATEGORIES, previousTitles,
      }, (value) => validatePlan(value, run.post_count));
      await client.query("UPDATE public.community_seed_runs SET plan = $2::jsonb, updated_at = NOW() WHERE seed_date = $1::date", [day, JSON.stringify(plan)]);
    }
    const drafts = [...run.drafts];
    for (let index = drafts.length; index < plan.length; index++) {
      scheduleDrafts([], day, now());
      const participants = sample(actors, randomInt(3, Math.min(actors.length, 6) + 1));
      const author = participants[0].key;
      const thread = await options.generate("community_thread", threadSchema, {
        task: "게시글 1개와 그에 자연스럽게 이어지는 댓글/대댓글 합계 3~10개를 창작하세요. 제목 120자, 본문 5000자, 각 댓글 500자 이하. parent는 이 배열의 앞선 원댓글 인덱스(0부터), 원댓글은 null. 최소 1개 대댓글과 다른 사람의 댓글이 있어야 합니다. 짧은 반응과 구체적 답변을 섞고 대화 길이를 매번 달리하세요.",
        date: day, topic: plan[index], postAuthor: author,
        participants: participants.map(({ key, persona }) => ({ key, ...persona })),
        previousTitles: [...previousTitles, ...drafts.map((draft) => draft.thread.title)],
      }, (value) => validateThread(value, participants, author, [...previousTitles, ...drafts.map((draft) => draft.thread.title)]));
      drafts.push({ topic: plan[index], thread });
      await client.query("UPDATE public.community_seed_runs SET drafts = $2::jsonb, updated_at = NOW() WHERE seed_date = $1::date", [day, JSON.stringify(drafts)]);
      options.progress?.("Community AI draft saved", { day, generated: drafts.length, total: run.post_count });
    }
    // Revalidate resumable JSON before any public data is written.
    validatePlan({ topics: plan }, run.post_count);
    if (drafts.length !== run.post_count) throw new Error("Incorrect saved draft count");
    drafts.forEach((draft, index) => {
      if (draft.topic.category !== plan[index].category || draft.topic.scenario !== plan[index].scenario) throw new Error("Saved draft topic mismatch");
      validateThread(draft.thread, actors, draft.thread.author, [...previousTitles, ...drafts.slice(0, index).map((item) => item.thread.title)]);
    });

    await client.query("BEGIN");
    inTransaction = true;
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL lock_timeout = '10s'");
    await assertEligibleAuthors(client, actors, true);
    const publishClock = await client.query<{ current_time: Date | string }>("SELECT clock_timestamp() AS current_time");
    const scheduled = scheduleDrafts(drafts, day, new Date(publishClock.rows[0].current_time));
    const userIds = new Map(actors.map((actor) => [actor.key, actor.userId]));
    const postIds: string[] = [];
    let commentCount = 0;
    for (const item of scheduled) {
      const post = await client.query<{ id: string }>(`
        INSERT INTO public.community_posts (user_id, category, title, content, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $5) RETURNING id
      `, [userIds.get(item.thread.author), item.topic.category, item.thread.title, item.thread.content, item.postAt]);
      const postId = post.rows[0].id;
      postIds.push(postId);
      const commentIds: string[] = [];
      for (const [index, comment] of item.thread.comments.entries()) {
        const result = await client.query<{ id: string }>(`
          INSERT INTO public.community_comments (post_id, user_id, parent_comment_id, content, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $5) RETURNING id
        `, [postId, userIds.get(comment.author), comment.parent === null ? null : commentIds[comment.parent], comment.content, item.commentTimes[index]]);
        commentIds.push(result.rows[0].id);
        commentCount++;
      }
    }
    const finishClock = await client.query<{ current_time: Date | string }>("SELECT clock_timestamp() AS current_time");
    if (new Date(finishClock.rows[0].current_time).getTime() >= scheduled[0].postAt.getTime()) {
      throw new Error("Publication transaction exceeded the first scheduled time; retry to reschedule saved drafts");
    }
    await client.query(`UPDATE public.community_seed_runs SET status = 'completed', post_ids = $2::uuid[],
      comment_count = $3, completed_at = NOW(), updated_at = NOW(), error_message = NULL
      WHERE seed_date = $1::date`, [day, postIds, commentCount]);
    await client.query("COMMIT");
    inTransaction = false;
    return { status: "completed", day, posts: postIds.length, comments: commentCount };
  } catch (error) {
    if (inTransaction) await client.query("ROLLBACK").catch(() => { destroy = true; });
    if (runStarted && !destroy) {
      await client.query(`UPDATE public.community_seed_runs SET status = 'failed', error_message = $2, updated_at = NOW()
        WHERE seed_date = $1::date AND status <> 'completed'`, [day, "Generation or publication failed; inspect job logs and retry the same day."]).catch(() => { destroy = true; });
    }
    throw error;
  } finally {
    if (locked && !destroy) await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]).catch(() => { destroy = true; });
    client.release(destroy);
  }
}

async function assertEligibleAuthors(client: SeedClient, actors: Actor[], lock: boolean) {
  const result = await client.query<{ id: string }>(`SELECT id FROM public.users
    WHERE id = ANY($1::uuid[]) AND status = 'active' AND email::text ILIKE '%@example.local'
    ${lock ? "FOR SHARE" : ""}`, [actors.map((actor) => actor.userId)]);
  if (new Set(result.rows.map((row) => row.id)).size !== actors.length) throw new Error("A seed author is no longer eligible; no content was published");
}
