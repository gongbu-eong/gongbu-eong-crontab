import { env } from "../config";
import { pool } from "../db/pool";
import { logger } from "../logger";
import { createGenerator } from "../community/ai";
import { runCommunitySeed } from "../community/seed";

export async function seedCommunity() {
  if (!env.communitySeedApiKey) throw new Error("Community seeding requires COMMUNITY_SEED_API_KEY, GPT_API_KEY or OPENAI_API_KEY");
  const databaseUrl = new URL(env.databaseUrl);
  if (databaseUrl.port === "6543" || databaseUrl.searchParams.get("pgbouncer") === "true") {
    throw new Error("Community seeding requires a direct or session-mode database connection, not transaction pooling");
  }
  return runCommunitySeed({
    connect: () => pool.connect(),
    model: env.communitySeedModel,
    generate: createGenerator({
      apiKey: env.communitySeedApiKey,
      model: env.communitySeedModel,
      timeoutMs: env.communitySeedRequestTimeoutMs,
      retries: env.communitySeedRequestRetries,
    }),
    progress: (message, context) => logger.info(message, context),
  });
}
