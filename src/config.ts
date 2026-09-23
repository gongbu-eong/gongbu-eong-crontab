import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env", quiet: true });

function required(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`필수 환경변수 ${name}가 없습니다.`);
  }

  return value;
}

function serviceKey(): string {
  const value = process.env.ALIO_SERVICE_KEY?.trim();

  // ALIO 작업이 비활성화된 상태에서 다른 작업만 실행할 수 있도록 키 존재
  // 여부는 AlioClient가 실제 호출될 때 검사한다.
  if (!value) {
    return "";
  }

  if (!/%[0-9a-f]{2}/i.test(value)) {
    return value;
  }

  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error("ALIO_SERVICE_KEY의 URL 인코딩 형식이 올바르지 않습니다.");
  }
}

function booleanValue(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();

  if (!value) {
    return fallback;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  throw new Error(`${name}은 true 또는 false여야 합니다.`);
}

function integerValue(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name]?.trim();
  const value = raw ? Number.parseInt(raw, 10) : fallback;

  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name}은 ${minimum} 이상 ${maximum} 이하의 정수여야 합니다.`,
    );
  }

  return value;
}

export const env = Object.freeze({
  communitySeedEnabled: booleanValue("COMMUNITY_SEED_ENABLED", false),
  communitySeedApiKey: process.env.COMMUNITY_SEED_API_KEY?.trim() || process.env.GPT_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || "",
  communitySeedModel: process.env.COMMUNITY_SEED_MODEL?.trim() || "gpt-5.1",
  communitySeedRequestTimeoutMs: integerValue("COMMUNITY_SEED_REQUEST_TIMEOUT_MS", 120_000, 1000, 300_000),
  communitySeedRequestRetries: integerValue("COMMUNITY_SEED_REQUEST_RETRIES", 2, 0, 5),
  databaseUrl: required("DATABASE_URL"),
  databaseSsl: booleanValue("DATABASE_SSL", false),
  serverHost: process.env.CRON_SERVER_HOST?.trim() || "localhost",
  serverPort: integerValue("CRON_SERVER_PORT", 4001, 1, 65_535),
  manualRunToken: process.env.CRON_MANUAL_RUN_TOKEN?.trim() || "",
  alioServiceKey: serviceKey(),
  alioApiBaseUrl:
    process.env.ALIO_API_BASE_URL?.trim() ??
    "https://opendata.alio.go.kr/new/v1/recruit",
  alioActiveSyncEnabled: booleanValue("ALIO_ACTIVE_SYNC_ENABLED", true),
  alioActiveSyncSchedule:
    process.env.ALIO_ACTIVE_SYNC_SCHEDULE?.trim() ?? "0 * * * *",
  alioActiveSyncTimezone:
    process.env.ALIO_ACTIVE_SYNC_TIMEZONE?.trim() ?? "Asia/Seoul",
  alioActiveSyncRunOnStart: booleanValue(
    "ALIO_ACTIVE_SYNC_RUN_ON_START",
    false,
  ),
  alioRecentHistorySyncEnabled: booleanValue(
    "ALIO_RECENT_HISTORY_SYNC_ENABLED",
    true,
  ),
  alioRecentHistorySyncSchedule:
    process.env.ALIO_RECENT_HISTORY_SYNC_SCHEDULE?.trim() ??
    "20 0 * * *",
  alioRecentHistorySyncTimezone:
    process.env.ALIO_RECENT_HISTORY_SYNC_TIMEZONE?.trim() ??
    "Asia/Seoul",
  alioRecentHistoryDays: integerValue(
    "ALIO_RECENT_HISTORY_DAYS",
    30,
    1,
    366,
  ),
  alioHistoryMonths: integerValue(
    "ALIO_HISTORY_MONTHS",
    13,
    1,
    120,
  ),
  alioSyncLockWaitMs: integerValue(
    "ALIO_SYNC_LOCK_WAIT_MS",
    600_000,
    0,
    3_600_000,
  ),
  pageSize: integerValue("ALIO_PAGE_SIZE", 1000, 1, 1000),
  minimumExpectedRows: integerValue(
    "ALIO_MIN_EXPECTED_ROWS",
    100,
    1,
    1_000_000,
  ),
  fetchDetails: booleanValue("ALIO_FETCH_DETAILS", false),
  refreshDetails: booleanValue("ALIO_REFRESH_DETAILS", false),
  detailConcurrency: integerValue("ALIO_DETAIL_CONCURRENCY", 3, 1, 10),
  requestTimeoutMs: integerValue(
    "ALIO_REQUEST_TIMEOUT_MS",
    20_000,
    1_000,
    120_000,
  ),
  requestRetries: integerValue("ALIO_REQUEST_RETRIES", 3, 0, 10),
  jobDeadlineNotificationEnabled: booleanValue(
    "JOB_DEADLINE_NOTIFICATION_ENABLED",
    true,
  ),
  jobDeadlineNotificationSchedule:
    process.env.JOB_DEADLINE_NOTIFICATION_SCHEDULE?.trim() ?? "0 9 * * *",
  jobDeadlineNotificationTimezone:
    process.env.JOB_DEADLINE_NOTIFICATION_TIMEZONE?.trim() ?? "Asia/Seoul",
  jobDeadlineNotificationRunOnStart: booleanValue(
    "JOB_DEADLINE_NOTIFICATION_RUN_ON_START",
    false,
  ),
  jobDeadlineNotificationTemplateCode:
    process.env.NEXT_PRIVATE_GONGBUEONG_JOB_DEADLINE_TEMPLATE_KEY?.trim() ||
    process.env.JOB_DEADLINE_NOTIFICATION_TEMPLATE_CODE?.trim() ||
    "",
  alimtalkSenderKey:
    process.env.NEXT_PRIVATE_GONGBUEONG_ALIMTALK_KEY?.trim() || "",
  alimtalkSmsSenderNumber:
    process.env.NEXT_PRIVATE_GONGBUEONG_ALIMTALK_SMS_SENDER_NUMBER?.trim() ||
    "02-1577-9577",
  mainUrl:
    process.env.NEXT_PUBLIC_SHARE_BASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_FRONTEND_URL?.trim() ||
    process.env.FRONTEND_URL?.trim() ||
    process.env.GONGBUEONG_MAIN_URL?.trim() ||
    "https://gongbueong.career.co.kr",
  userWithdrawalPurgeEnabled: booleanValue(
    "USER_WITHDRAWAL_PURGE_ENABLED",
    true,
  ),
  userWithdrawalPurgeSchedule:
    process.env.USER_WITHDRAWAL_PURGE_SCHEDULE?.trim() ?? "0 * * * *",
  userWithdrawalPurgeTimezone:
    process.env.USER_WITHDRAWAL_PURGE_TIMEZONE?.trim() ?? "Asia/Seoul",
  userWithdrawalPurgeRunOnStart: booleanValue(
    "USER_WITHDRAWAL_PURGE_RUN_ON_START",
    false,
  ),
  userWithdrawalPurgeBatchSize: integerValue(
    "USER_WITHDRAWAL_PURGE_BATCH_SIZE",
    100,
    1,
    1000,
  ),
});
