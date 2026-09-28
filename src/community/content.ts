import { randomInt } from "node:crypto";

export const CATEGORIES = [
  "자유·잡담", "공시 정보", "공부·스터디", "질문·답변", "합격·면접 후기", "유머·짤",
] as const;

// Matches CommunityWritePage/CommunityDetailPage and community.service.ts.
export const COMMUNITY_TEXT_LIMITS = { title: 120, content: 5000, comment: 500 } as const;

export type Persona = { ageGroup: string; background: string; tone: string };
export type Actor = { key: string; userId: string; persona: Persona };
export type Topic = { category: string; scenario: string; author?: string };
export type Thread = {
  author: string;
  title: string;
  content: string;
  comments: { author: string; content: string; parent: number | null }[];
};
export type Draft = { topic: Topic; thread: Thread };

export function objectSchema(properties: Record<string, unknown>) {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}
const stringSchema = { type: "string", minLength: 1 };
function boundedStringSchema(maxLength: number) {
  return {
    ...stringSchema, maxLength,
    description: `Use at most ${maxLength} UTF-16 code units (JavaScript string.length), including spaces and newlines. Leave room for emoji that use multiple code units.`,
  };
}
export const personasSchema = objectSchema({
  personas: {
    type: "array", items: objectSchema({
      key: stringSchema, ageGroup: stringSchema, background: stringSchema, tone: stringSchema,
    }),
  },
});
export const planSchema = objectSchema({
  topics: { type: "array", items: objectSchema({ author: stringSchema, category: { type: "string", enum: CATEGORIES }, scenario: stringSchema }) },
});
export const threadSchema = objectSchema({
  author: stringSchema,
  title: boundedStringSchema(COMMUNITY_TEXT_LIMITS.title),
  content: boundedStringSchema(COMMUNITY_TEXT_LIMITS.content),
  comments: { type: "array", items: objectSchema({
    author: stringSchema, content: boundedStringSchema(COMMUNITY_TEXT_LIMITS.comment), parent: { type: ["integer", "null"] },
  }) },
});

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
  return value as Record<string, unknown>;
}

function string(value: unknown, max: number, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`Invalid generated text length: ${field} must be non-empty and <= ${max} characters (received ${typeof value === "string" ? value.length : typeof value})`);
  }
  return value.trim();
}

// Internal planning text is not a public post field. The AI response size cap still applies.
function internalText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid generated text: ${field} must be a non-empty string`);
  return value.trim();
}

export function validatePersonas(value: unknown, keys: string[]) {
  const items = record(value).personas;
  if (!Array.isArray(items) || items.length !== keys.length) throw new Error("Incorrect persona count");
  const seen = new Set<string>();
  return items.map((item): Persona & { key: string } => {
    const row = record(item);
    const key = string(row.key, 30, "persona.key");
    if (!keys.includes(key) || seen.has(key)) throw new Error("Unknown or duplicate persona author");
    seen.add(key);
    return {
      key,
      ageGroup: internalText(row.ageGroup, "persona.ageGroup"),
      background: internalText(row.background, "persona.background"),
      tone: internalText(row.tone, "persona.tone"),
    };
  });
}

export function validatePlan(value: unknown, count: number, authors?: string[]): Topic[] {
  const items = record(value).topics;
  if (!Array.isArray(items) || items.length !== count) throw new Error("Incorrect topic count");
  const seen = new Set<string>();
  return items.map((item) => {
    const row = record(item);
    const category = string(row.category, 40, "topic.category");
    const scenario = internalText(row.scenario, "topic.scenario");
    if (!(CATEGORIES as readonly string[]).includes(category) || seen.has(scenario)) throw new Error("Invalid or duplicate topic");
    seen.add(scenario);
    if (authors && (typeof row.author !== "string" || !authors.includes(row.author))) throw new Error("A planned topic must belong to an eligible author");
    return { category, scenario, ...(authors ? { author: row.author as string } : {}) };
  });
}

export function validateThread(value: unknown, actors: Actor[], author: string, previousTitles: string[]): Thread {
  const row = record(value);
  const keys = new Set(actors.map((actor) => actor.key));
  if (row.author !== author || !keys.has(author)) throw new Error("Invalid post author");
  const title = string(row.title, COMMUNITY_TEXT_LIMITS.title, "thread.title");
  const normalizedTitle = title.replace(/\s/g, "").toLowerCase();
  if (previousTitles.some((previous) => previous.replace(/\s/g, "").toLowerCase() === normalizedTitle)) {
    throw new Error("Duplicate generated title");
  }
  const content = string(row.content, COMMUNITY_TEXT_LIMITS.content, "thread.content");
  if (!Array.isArray(row.comments) || row.comments.length < 3 || row.comments.length > 10) throw new Error("Expected 3-10 comments including replies");
  const comments: Thread["comments"] = [];
  const texts = new Set<string>();
  for (const [index, item] of row.comments.entries()) {
    const comment = record(item);
    const commentAuthor = string(comment.author, 30, `comments[${index}].author`);
    if (!keys.has(commentAuthor)) throw new Error("Invalid comment author");
    const parent = comment.parent;
    if (parent !== null && (typeof parent !== "number" || !Number.isInteger(parent) || parent < 0 || parent >= index || comments[parent].parent !== null)) {
      throw new Error("Reply must reference an earlier top-level comment in this thread");
    }
    const text = string(comment.content, COMMUNITY_TEXT_LIMITS.comment, `comments[${index}].content`);
    if (texts.has(text)) throw new Error("Duplicate comment content");
    texts.add(text);
    comments.push({ author: commentAuthor, content: text, parent: parent as number | null });
  }
  if (!comments.some((comment) => comment.parent !== null) || !comments.some((comment) => comment.author !== author)) {
    throw new Error("Thread must contain a reply and another author");
  }
  return { author, title, content, comments };
}

export type RandomInt = (min: number, exclusiveMax: number) => number;
export function sample<T>(items: readonly T[], count: number, random: RandomInt = randomInt): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) {
    const other = random(0, index + 1);
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy.slice(0, count);
}

export function seoulDay(now: Date): string {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// Allocate publication times only after generation finishes; never backdate a late run.
export function scheduleDrafts(drafts: Draft[], day: string, now: Date, random: RandomInt = randomInt) {
  const end = Math.floor(new Date(`${day}T00:00:00+09:00`).getTime() / 1000) + 86400;
  const start = Math.ceil(now.getTime() / 1000) + 60;
  const lastPost = end - 45 * 60;
  if (seoulDay(now) !== day || lastPost - start < drafts.length * 60) throw new Error("Insufficient time left in the target Seoul day");
  return drafts.map((draft, index) => {
    const lower = start + Math.floor((lastPost - start) * index / drafts.length);
    const upper = start + Math.floor((lastPost - start) * (index + 1) / drafts.length);
    let second = random(lower, upper);
    const postAt = new Date(second * 1000);
    const commentTimes = draft.thread.comments.map((_, commentIndex) => {
      const remaining = draft.thread.comments.length - commentIndex - 1;
      const maxGap = Math.min(30 * 60, end - second - remaining * 30 - 1);
      second += random(30, maxGap + 1);
      return new Date(second * 1000);
    });
    return { ...draft, postAt, commentTimes };
  });
}
