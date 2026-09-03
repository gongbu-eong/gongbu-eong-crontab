import { env } from "../config";
import { pool } from "../db/pool";
import { sendAlimtalk } from "../lib/alimtalk";
import { logger } from "../logger";

const JOB_NAME = "job-deadline-notification";

type CandidateRow = {
  user_id: string;
  job_posting_id: string;
  recipient: string;
  user_name: string | null;
  institution_name: string | null;
  title: string;
  application_end_at: Date | string;
  offset_days: number;
};

export type SendJobDeadlineNotificationsResult = {
  targetDate: string;
  candidateCount: number;
  queuedCount: number;
  skippedCount: number;
};

export async function sendJobDeadlineNotifications(
  now = new Date(),
): Promise<SendJobDeadlineNotificationsResult> {
  const targetDate = toTimezoneDateString(
    now,
    env.jobDeadlineNotificationTimezone,
  );
  const client = await pool.connect();
  let runId: string | null = null;

  try {
    const run = await client.query<{ id: string }>(
      `
        INSERT INTO public.notification_dispatch_runs (
          job_name,
          status,
          target_date,
          started_at
        )
        VALUES ($1, 'running', $2::date, NOW())
        RETURNING id
      `,
      [JOB_NAME, targetDate],
    );
    runId = run.rows[0].id;

    const candidates = await client.query<CandidateRow>(
      `
        SELECT
          users.id AS user_id,
          postings.id AS job_posting_id,
          users.phone AS recipient,
          COALESCE(users.display_name, users.nickname, users.community_nickname, '회원') AS user_name,
          institutions.name AS institution_name,
          postings.title,
          postings.application_end_at,
          offsets.offset_days
        FROM public.notification_preferences preferences
        JOIN public.users users
          ON users.id = preferences.user_id
         AND users.status = 'active'
        JOIN public.user_job_bookmarks bookmarks
          ON bookmarks.user_id = users.id
        JOIN public.job_postings postings
          ON postings.id = bookmarks.job_posting_id
         AND postings.is_active = true
         AND postings.application_end_at IS NOT NULL
        LEFT JOIN public.public_institutions institutions
          ON institutions.id = postings.institution_id
        CROSS JOIN LATERAL unnest(
          COALESCE(
            preferences.application_deadline_days_before_list,
            ARRAY[preferences.application_deadline_days_before]
          )
        ) AS offsets(offset_days)
        WHERE preferences.application_deadline_enabled = true
          AND users.phone IS NOT NULL
          AND users.phone <> ''
          AND offsets.offset_days IN (0, 3, 7)
          AND (postings.application_end_at AT TIME ZONE $2)::date
                = ($1::date + offsets.offset_days)
      `,
      [targetDate, env.jobDeadlineNotificationTimezone],
    );

    let queuedCount = 0;

    for (const row of candidates.rows) {
      const targetPath = `/jobs/${row.job_posting_id}`;
      const sourceId = `job_deadline:${row.job_posting_id}:${targetDate}:${row.offset_days}`;
      const message = buildDeadlineAlimtalkMessage(row);
      const body = buildDeadlineNotificationBody(row);
      const payload = {
        offsetDays: row.offset_days,
        institutionName: row.institution_name,
        jobTitle: row.title,
        applicationEndAt:
          row.application_end_at instanceof Date
            ? row.application_end_at.toISOString()
            : row.application_end_at,
        sourceId,
        smsFallback: true,
      };
      const queued = await client.query<{ id: string }>(
        `
          INSERT INTO public.notification_dispatch_queue (
            user_id,
            job_posting_id,
            channel,
            purpose,
            recipient,
            template_code,
            title,
            body,
            message,
            target_path,
            source_key,
            payload,
            status,
            scheduled_at
          )
          VALUES (
            $1,
            $2,
            'kakao_alimtalk',
            'job_deadline',
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9,
            $10::jsonb,
            'pending',
            NOW()
          )
          ON CONFLICT (source_key) DO NOTHING
          RETURNING id
        `,
        [
          row.user_id,
          row.job_posting_id,
          row.recipient,
          env.jobDeadlineNotificationTemplateCode || null,
          "찜한 공고 접수 마감 임박",
          body,
          message,
          targetPath,
          sourceId,
          JSON.stringify(payload),
        ],
      );

      const queueId = queued.rows[0]?.id;
      if (!queueId) {
        continue;
      }

      try {
        const alimtalk = await sendAlimtalk({
          recipientPhone: row.recipient,
          templateCode: env.jobDeadlineNotificationTemplateCode,
          title: "찜한 공고 접수 마감 임박",
          message,
          targetPath,
          buttonName: "공고 확인",
        });

        if (!alimtalk.sent) {
          throw new Error(alimtalk.reason);
        }

        await client.query(
          `
            UPDATE public.notification_dispatch_queue
            SET status = 'sent',
                sent_at = NOW(),
                attempt_count = attempt_count + 1,
                updated_at = NOW()
            WHERE id = $1
          `,
          [queueId],
        );

        await client.query(
          `
            INSERT INTO public.notifications (
              user_id,
              channel,
              category,
              kind,
              title,
              body,
              target_path,
              metadata,
              source_type,
              source_id,
              sent_at
            )
            VALUES (
              $1,
              'kakao_alimtalk'::public.notification_channel,
              'job_deadline',
              'job_deadline',
              $2,
              $3,
              $4,
              $5::jsonb,
              'job_deadline',
              $6,
              NOW()
            )
            ON CONFLICT (user_id, source_type, source_id)
            WHERE source_type IS NOT NULL AND source_id IS NOT NULL
            DO UPDATE SET
              body = EXCLUDED.body,
              target_path = EXCLUDED.target_path,
              metadata = EXCLUDED.metadata,
              sent_at = COALESCE(public.notifications.sent_at, EXCLUDED.sent_at)
          `,
          [
            row.user_id,
            "찜한 공고 접수 마감 임박",
            body,
            targetPath,
            JSON.stringify(payload),
            sourceId,
          ],
        );

        queuedCount += 1;
      } catch (error) {
        await client.query(
          `
            UPDATE public.notification_dispatch_queue
            SET status = 'failed',
                failed_at = NOW(),
                failure_reason = $2,
                attempt_count = attempt_count + 1,
                updated_at = NOW()
            WHERE id = $1
          `,
          [
            queueId,
            error instanceof Error ? error.message.slice(0, 4_000) : String(error),
          ],
        );
        logger.error("마감 임박 알림톡 발송 실패", {
          userId: row.user_id,
          jobPostingId: row.job_posting_id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const candidateCount = candidates.rowCount ?? candidates.rows.length;
    const skippedCount = candidateCount - queuedCount;

    await client.query(
      `
        UPDATE public.notification_dispatch_runs
        SET
          status = 'succeeded',
          queued_count = $2,
          skipped_count = $3,
          completed_at = NOW()
        WHERE id = $1
      `,
      [runId, queuedCount, skippedCount],
    );

    logger.info("마감 임박 알림 큐 적재 완료", {
      targetDate,
      candidateCount,
      queuedCount,
      skippedCount,
    });

    return {
      targetDate,
      candidateCount,
      queuedCount,
      skippedCount,
    };
  } catch (error) {
    if (runId) {
      await client.query(
        `
          UPDATE public.notification_dispatch_runs
          SET
            status = 'failed',
            error_message = $2,
            completed_at = NOW()
          WHERE id = $1
        `,
        [
          runId,
          error instanceof Error ? error.message.slice(0, 4_000) : String(error),
        ],
      ).catch(() => undefined);
    }

    logger.error("마감 임박 알림 큐 적재 실패", {
      targetDate,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    client.release();
  }
}

function buildDeadlineNotificationBody(row: CandidateRow) {
  const jobTitle = buildJobTitle(row);
  const deadlineLabel =
    row.offset_days === 0 ? "오늘" : `${row.offset_days}일 후`;

  return `찜한 ${jobTitle} 지원 마감이 ${deadlineLabel}이에요.`;
}

function buildDeadlineAlimtalkMessage(row: CandidateRow) {
  const offsetLabel =
    row.offset_days === 0 ? "오늘" : `${row.offset_days}일 후`;

  return [
    "[공고 마감 임박 안내]",
    "",
    `${row.user_name || "회원"}님, 안녕하세요.`,
    "",
    `찜한 공고의 지원 마감이 ${offsetLabel}입니다.`,
    "",
    `공고: ${buildJobTitle(row)}`,
    `마감: ${formatKoreanDeadline(row.application_end_at)}`,
    "",
    "아래 버튼을 눌러 내용을 확인해 주세요.",
  ].join("\n");
}

function buildJobTitle(row: CandidateRow) {
  return [row.institution_name, row.title].filter(Boolean).join(" ");
}

function formatKoreanDeadline(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: env.jobDeadlineNotificationTimezone,
    month: "long",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function toTimezoneDateString(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );

  return `${values.year}-${values.month}-${values.day}`;
}
