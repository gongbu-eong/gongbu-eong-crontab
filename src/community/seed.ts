import { randomInt } from "node:crypto";
import type { QueryResultRow } from "pg";
import type { GenerateJson } from "./ai";
import { summarizeSeedError } from "./errors";
import {
  CATEGORIES, COMMUNITY_TEXT_LIMITS, personasSchema, planSchema, threadSchema, sample, seoulDay, scheduleDrafts,
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
  let stage = "load_run";
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
    runStarted = Boolean(run);
    stage = "check_schedule_and_model";
    scheduleDrafts([], day, now());
    if (run && run.model !== options.model) throw new Error("Resume with the original OPENAI_MODEL");
    stage = "start_run";
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
    stage = "load_authors";
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
        stage = "generate_personas";
        const generated = await options.generate("community_personas", personasSchema, {
          task: "각 key에 대해 가상 취업 준비생의 성인 나이대, 상황, 일관된 말투를 창작하세요. 존댓말/반말 및 연령대를 다양하게 분산하세요. 인물 설정은 게시글이 아닌 내부 참고 자료이므로 핵심만 짧고 간결하게 작성하세요.", keys,
        }, (value) => validatePersonas(value, keys));
        stage = "save_personas";
        for (const candidate of missing) {
          const { key: _key, ...persona } = generated.find((item) => item.key === candidate.key)!;
          await client.query(`INSERT INTO public.community_seed_personas (user_id, persona, model)
            VALUES ($1, $2::jsonb, $3) ON CONFLICT (user_id) DO NOTHING`, [candidate.userId, JSON.stringify(persona), options.model]);
          candidate.persona = persona;
        }
      }
      actors = candidates as Actor[];
      stage = "save_authors";
      await client.query("UPDATE public.community_seed_runs SET actors = $2::jsonb, updated_at = NOW() WHERE seed_date = $1::date", [day, JSON.stringify(actors)]);
    }
    stage = "check_authors";
    await assertEligibleAuthors(client, actors, false);
    stage = "load_recent_titles";
    const recent = await client.query<{ title: string }>(`
      SELECT posts.title FROM public.community_posts posts
      JOIN public.community_seed_runs runs ON posts.id = ANY(runs.post_ids)
      WHERE runs.status = 'completed' ORDER BY posts.created_at DESC LIMIT 100
    `);
    const previousTitles = recent.rows.map((row) => row.title);
    let plan = run.plan;
    if (!plan.length) {
      stage = "generate_plan";
      plan = await options.generate("community_day_plan", planSchema, {
        task: `서로 다른 주제 ${run.post_count}개를 기획하세요. 각 scenario는 내부 기획용으로 핵심만 짧고 간결하게 작성하세요. 특정 주제나 말다툼에 편중하지 말고 다양한 카테고리와 대화 상황을 섞으세요. 과거 제목과 중복하지 마세요.`,
        date: day, count: run.post_count, categories: CATEGORIES, previousTitles,
      }, (value) => validatePlan(value, run.post_count));
      stage = "save_plan";
      await client.query("UPDATE public.community_seed_runs SET plan = $2::jsonb, updated_at = NOW() WHERE seed_date = $1::date", [day, JSON.stringify(plan)]);
    }
    const drafts = [...run.drafts];
    for (let index = drafts.length; index < plan.length; index++) {
      stage = `check_schedule:${index + 1}/${run.post_count}`;
      scheduleDrafts([], day, now());
      const participants = sample(actors, randomInt(3, Math.min(actors.length, 6) + 1));
      const author = participants[0].key;
      options.progress?.("Community AI draft generation started", {
        day,
        generating: index + 1,
        total: run.post_count,
        category: plan[index].category,
      });
      stage = `generate_thread:${index + 1}/${run.post_count}`;
      const thread = await options.generate("community_thread", threadSchema, {
        task: `게시글 1개와 그에 자연스럽게 이어지는 댓글/대댓글 합계 3~10개를 창작하세요. 실제 커뮤니티 입력 제한과 동일하게 제목 ${COMMUNITY_TEXT_LIMITS.title}자, 본문 ${COMMUNITY_TEXT_LIMITS.content}자, 각 댓글 및 대댓글 ${COMMUNITY_TEXT_LIMITS.comment}자 이하로 작성하세요. 공백과 줄바꿈을 포함하며 JavaScript string.length 기준입니다. 이모지는 여러 글자로 셀 수 있으니 상한보다 여유 있게 작성하세요. parent는 이 배열의 앞선 원댓글 인덱스(0부터), 원댓글은 null. 최소 1개 대댓글과 다른 사람의 댓글이 있어야 합니다. 짧은 반응과 구체적 답변을 섞고 대화 길이를 매번 달리하세요.`,
        date: day, topic: plan[index], postAuthor: author,
        participants: participants.map(({ key, persona }) => ({ key, ...persona })),
        previousTitles: [...previousTitles, ...drafts.map((draft) => draft.thread.title)],
      }, (value) => validateThread(value, participants, author, [...previousTitles, ...drafts.map((draft) => draft.thread.title)]));
      drafts.push({ topic: plan[index], thread });
      stage = `save_draft:${index + 1}/${run.post_count}`;
      await client.query("UPDATE public.community_seed_runs SET drafts = $2::jsonb, updated_at = NOW() WHERE seed_date = $1::date", [day, JSON.stringify(drafts)]);
      options.progress?.("Community AI draft saved", { day, generated: drafts.length, total: run.post_count });
    }
    // Revalidate resumable JSON before any public data is written.
    stage = "validate_saved_drafts";
    validatePlan({ topics: plan }, run.post_count);
    if (drafts.length !== run.post_count) throw new Error("Incorrect saved draft count");
    drafts.forEach((draft, index) => {
      if (draft.topic.category !== plan[index].category || draft.topic.scenario !== plan[index].scenario) throw new Error("Saved draft topic mismatch");
      validateThread(draft.thread, actors, draft.thread.author, [...previousTitles, ...drafts.slice(0, index).map((item) => item.thread.title)]);
    });

    stage = "begin_publication";
    await client.query("BEGIN");
    inTransaction = true;
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL lock_timeout = '10s'");
    stage = "lock_authors";
    await assertEligibleAuthors(client, actors, true);
    stage = "schedule_publication";
    const publishClock = await client.query<{ current_time: Date | string }>("SELECT clock_timestamp() AS current_time");
    const scheduled = scheduleDrafts(drafts, day, new Date(publishClock.rows[0].current_time));
    const userIds = new Map(actors.map((actor) => [actor.key, actor.userId]));
    const postIds: string[] = [];
    let commentCount = 0;
    for (const item of scheduled) {
      stage = `publish_post:${postIds.length + 1}/${run.post_count}`;
      const post = await client.query<{ id: string }>(`
        INSERT INTO public.community_posts (user_id, category, title, content, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $5) RETURNING id
      `, [userIds.get(item.thread.author), item.topic.category, item.thread.title, item.thread.content, item.postAt]);
      const postId = post.rows[0].id;
      postIds.push(postId);
      const commentIds: string[] = [];
      for (const [index, comment] of item.thread.comments.entries()) {
        stage = `publish_comment:post=${postIds.length}/${run.post_count},comment=${index + 1}`;
        const result = await client.query<{ id: string }>(`
          INSERT INTO public.community_comments (post_id, user_id, parent_comment_id, content, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $5) RETURNING id
        `, [postId, userIds.get(comment.author), comment.parent === null ? null : commentIds[comment.parent], comment.content, item.commentTimes[index]]);
        commentIds.push(result.rows[0].id);
        commentCount++;
      }
    }
    stage = "complete_publication";
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
    const message = `Community seed failed [day=${day}, stage=${stage}]: ${summarizeSeedError(error)}`;
    let errorRecorded = false;
    if (inTransaction) await client.query("ROLLBACK").catch(() => { destroy = true; });
    if (runStarted && !destroy) {
      await client.query(`UPDATE public.community_seed_runs SET status = 'failed', error_message = $2, updated_at = NOW()
        WHERE seed_date = $1::date AND status <> 'completed'`, [day, message])
        .then(() => { errorRecorded = true; }).catch(() => { destroy = true; });
    }
    throw new Error(errorRecorded ? message : `${message} (failure could not be saved to community_seed_runs)`);
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
