import assert from "node:assert/strict";
import test from "node:test";

import {
  createScheduler,
  validateJobs,
  type ScheduledJob,
} from "./scheduler";

function job(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    name: "test-job",
    enabled: true,
    schedule: "0 * * * *",
    timezone: "Asia/Seoul",
    runOnStart: false,
    execute: async () => undefined,
    ...overrides,
  };
}

test("작업마다 서로 다른 스케줄과 타임존을 등록할 수 있다", () => {
  assert.doesNotThrow(() =>
    validateJobs([
      job(),
      job({
        name: "another-job",
        schedule: "30 2 * * *",
        timezone: "UTC",
      }),
    ]),
  );
});

test("수동 전용 작업은 스케줄 없이 등록할 수 있다", () => {
  assert.doesNotThrow(() =>
    validateJobs([
      job({
        name: "manual-backfill",
        enabled: false,
        schedule: null,
      }),
    ]),
  );
});

test("중복 작업 이름을 거부한다", () => {
  assert.throws(
    () => validateJobs([job(), job()]),
    /중복된 크론 작업 이름/,
  );
});

test("잘못된 스케줄과 타임존을 거부한다", () => {
  assert.throws(
    () => validateJobs([job({ schedule: "not-a-cron" })]),
    /스케줄이 올바르지 않습니다/,
  );
  assert.throws(
    () => validateJobs([job({ timezone: "Not/A-Timezone" })]),
    /타임존이 올바르지 않습니다/,
  );
});

test("각 작업을 이름으로 따로 실행하고 동일 작업의 중복 실행을 막는다", async () => {
  let finish: (() => void) | undefined;
  const scheduler = createScheduler([
    job({
      execute: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    }),
  ]);

  assert.equal(scheduler.runNow("test-job"), "started");
  assert.equal(scheduler.runNow("test-job"), "already-running");
  assert.equal(scheduler.runNow("missing-job"), "not-found");

  finish?.();
  await scheduler.stop();
});
