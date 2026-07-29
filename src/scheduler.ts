import cron, { type ScheduledTask } from "node-cron";

import { logger } from "./logger";

export interface ScheduledJob {
  name: string;
  enabled: boolean;
  schedule: string | null;
  timezone: string;
  runOnStart: boolean;
  execute: () => Promise<unknown>;
}

export type RunNowResult = "started" | "already-running" | "not-found";

export interface JobScheduler {
  start: () => void;
  stop: () => Promise<void>;
  runNow: (jobName: string) => RunNowResult;
}

export function validateJobs(jobs: readonly ScheduledJob[]): void {
  const names = new Set<string>();

  for (const job of jobs) {
    if (!job.name.trim()) {
      throw new Error("크론 작업 이름은 비어 있을 수 없습니다.");
    }

    if (names.has(job.name)) {
      throw new Error(`중복된 크론 작업 이름입니다: ${job.name}`);
    }
    names.add(job.name);

    if (job.schedule !== null && !cron.validate(job.schedule)) {
      throw new Error(
        `크론 작업 ${job.name}의 스케줄이 올바르지 않습니다: ${job.schedule}`,
      );
    }

    try {
      new Intl.DateTimeFormat("ko-KR", { timeZone: job.timezone }).format();
    } catch {
      throw new Error(
        `크론 작업 ${job.name}의 타임존이 올바르지 않습니다: ${job.timezone}`,
      );
    }
  }
}

export function createScheduler(
  jobs: readonly ScheduledJob[],
): JobScheduler {
  validateJobs(jobs);

  const tasks: ScheduledTask[] = [];
  const running = new Set<Promise<void>>();
  const runningJobNames = new Set<string>();
  let started = false;

  function run(
    job: ScheduledJob,
  ): { started: boolean; completion: Promise<void> } {
    if (runningJobNames.has(job.name)) {
      logger.warn("이미 실행 중인 크론 작업 건너뜀", { job: job.name });
      return { started: false, completion: Promise.resolve() };
    }

    runningJobNames.add(job.name);
    const promise = job
      .execute()
      .then(() => {
        logger.info("크론 작업 실행 완료", { job: job.name });
      })
      .catch((error) => {
        logger.error("크론 작업 실행 실패", {
          job: job.name,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        running.delete(promise);
        runningJobNames.delete(job.name);
      });

    running.add(promise);
    return { started: true, completion: promise };
  }

  return {
    start(): void {
      if (started) {
        return;
      }
      started = true;

      for (const job of jobs) {
        if (!job.enabled || job.schedule === null) {
          logger.info("자동 실행하지 않는 크론 작업 건너뜀", {
            job: job.name,
            manualOnly: job.schedule === null,
          });
          continue;
        }

        const task = cron.schedule(
          job.schedule,
          () => run(job).completion,
          {
            name: job.name,
            timezone: job.timezone,
            noOverlap: true,
          },
        );
        tasks.push(task);

        logger.info("크론 작업 등록", {
          job: job.name,
          schedule: job.schedule,
          timezone: job.timezone,
          nextRun: task.getNextRun()?.toISOString() ?? null,
        });

        if (job.runOnStart) {
          void run(job).completion;
        }
      }
    },

    runNow(jobName: string): RunNowResult {
      const job = jobs.find(({ name }) => name === jobName);
      if (!job) {
        return "not-found";
      }

      return run(job).started ? "started" : "already-running";
    },

    async stop(): Promise<void> {
      for (const task of tasks) {
        task.stop();
      }
      await Promise.allSettled(running);
    },
  };
}
