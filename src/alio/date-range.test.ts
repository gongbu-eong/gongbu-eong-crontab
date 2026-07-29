import assert from "node:assert/strict";
import test from "node:test";

import {
  historyMonthRanges,
  recentHistoryRange,
} from "./date-range";

test("최근 이력 범위를 한국 날짜 기준으로 계산한다", () => {
  assert.deepEqual(
    recentHistoryRange(
      new Date("2026-07-29T01:00:00.000Z"),
      30,
      "Asia/Seoul",
    ),
    {
      startDate: "2026-06-30",
      endDate: "2026-07-29",
    },
  );
});

test("13개월 이력 backfill을 한국 날짜 기준 월 단위 범위로 나눈다", () => {
  assert.deepEqual(
    historyMonthRanges(
      new Date("2026-07-29T01:00:00.000Z"),
      "Asia/Seoul",
      13,
    ),
    [
      { startDate: "2025-06-29", endDate: "2025-06-30" },
      { startDate: "2025-07-01", endDate: "2025-07-31" },
      { startDate: "2025-08-01", endDate: "2025-08-31" },
      { startDate: "2025-09-01", endDate: "2025-09-30" },
      { startDate: "2025-10-01", endDate: "2025-10-31" },
      { startDate: "2025-11-01", endDate: "2025-11-30" },
      { startDate: "2025-12-01", endDate: "2025-12-31" },
      { startDate: "2026-01-01", endDate: "2026-01-31" },
      { startDate: "2026-02-01", endDate: "2026-02-28" },
      { startDate: "2026-03-01", endDate: "2026-03-31" },
      { startDate: "2026-04-01", endDate: "2026-04-30" },
      { startDate: "2026-05-01", endDate: "2026-05-31" },
      { startDate: "2026-06-01", endDate: "2026-06-30" },
      { startDate: "2026-07-01", endDate: "2026-07-29" },
    ],
  );
});

test("월말에서 13개월 전을 계산할 때 해당 월의 마지막 날로 보정한다", () => {
  const ranges = historyMonthRanges(
    new Date("2026-03-31T01:00:00.000Z"),
    "Asia/Seoul",
    13,
  );

  assert.deepEqual(ranges[0], {
    startDate: "2025-02-28",
    endDate: "2025-02-28",
  });
  assert.deepEqual(ranges.at(-1), {
    startDate: "2026-03-01",
    endDate: "2026-03-31",
  });
});
