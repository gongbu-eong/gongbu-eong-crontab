import { env } from "../config";
import type { ScheduledJob } from "../scheduler";
import {
  backfillAlioHistory,
  syncAlioActivePostings,
  syncAlioRecentHistory,
} from "./sync-alio-job-postings";
import { sendJobDeadlineNotifications } from "./send-job-deadline-notifications";
import { purgeWithdrawnUserPrivateData } from "./purge-withdrawn-user-private-data";
import { seedCommunity } from "./seed-community";

/**
 * 모든 정기 작업의 등록 지점입니다.
 *
 * 다른 API 작업을 추가할 때는 실행 함수를 만든 뒤 이 배열에 작업별
 * enabled, schedule, timezone, runOnStart 설정과 함께 한 항목만 추가합니다.
 */
export const scheduledJobs: readonly ScheduledJob[] = [
  {
    name: "community-daily-seed",
    enabled: env.communitySeedEnabled,
    schedule: "1 0 * * *",
    timezone: "Asia/Seoul",
    runOnStart: false,
    execute: seedCommunity,
  },
  {
    name: "alio-active-sync",
    enabled: env.alioActiveSyncEnabled,
    schedule: env.alioActiveSyncSchedule,
    timezone: env.alioActiveSyncTimezone,
    runOnStart: env.alioActiveSyncRunOnStart,
    execute: syncAlioActivePostings,
  },
  {
    name: "alio-recent-history-sync",
    enabled: env.alioRecentHistorySyncEnabled,
    schedule: env.alioRecentHistorySyncSchedule,
    timezone: env.alioRecentHistorySyncTimezone,
    runOnStart: false,
    execute: syncAlioRecentHistory,
  },
  {
    name: "alio-history-backfill",
    enabled: false,
    schedule: null,
    timezone: env.alioRecentHistorySyncTimezone,
    runOnStart: false,
    execute: backfillAlioHistory,
  },
  {
    name: "job-deadline-notification",
    enabled: env.jobDeadlineNotificationEnabled,
    schedule: env.jobDeadlineNotificationSchedule,
    timezone: env.jobDeadlineNotificationTimezone,
    runOnStart: env.jobDeadlineNotificationRunOnStart,
    execute: sendJobDeadlineNotifications,
  },
  {
    name: "user-withdrawal-private-data-purge",
    enabled: env.userWithdrawalPurgeEnabled,
    schedule: env.userWithdrawalPurgeSchedule,
    timezone: env.userWithdrawalPurgeTimezone,
    runOnStart: env.userWithdrawalPurgeRunOnStart,
    execute: purgeWithdrawnUserPrivateData,
  },
];
