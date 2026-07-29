import type { Server } from "node:http";

import { closePool } from "./db/pool";
import { startHealthServer, stopHealthServer } from "./health-server";
import { scheduledJobs } from "./jobs/registry";
import { logger } from "./logger";
import { createScheduler } from "./scheduler";

let shuttingDown = false;
let healthServer: Server | null = null;

const scheduler = createScheduler(scheduledJobs);

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  logger.info("크론 프로세스 종료 시작", { signal });
  await scheduler.stop();
  if (healthServer) {
    await stopHealthServer(healthServer);
  }
  await closePool();
  logger.info("크론 프로세스 종료 완료", { signal });
}

process.once("SIGINT", () => {
  void shutdown("SIGINT").finally(() => process.exit(0));
});

process.once("SIGTERM", () => {
  void shutdown("SIGTERM").finally(() => process.exit(0));
});

async function main(): Promise<void> {
  scheduler.start();
  healthServer = await startHealthServer(scheduler);
}

void main().catch(async (error) => {
  logger.error("크론 프로세스 시작 실패", {
    error: error instanceof Error ? error.message : String(error),
  });
  await scheduler.stop();
  await closePool();
  process.exitCode = 1;
});
