import type { PoolClient } from "pg";

import { env } from "../config";
import { pool } from "../db/pool";
import { logger } from "../logger";

const JOB_NAME = "user-withdrawal-private-data-purge";
const MAX_BATCHES_PER_RUN = 10;

type WithdrawalRequestRow = {
  id: string;
  user_id: string | null;
};

export type PurgeWithdrawnUserPrivateDataResult = {
  status: "succeeded";
  candidateCount: number;
  purgedCount: number;
  failedCount: number;
};

export async function purgeWithdrawnUserPrivateData(): Promise<PurgeWithdrawnUserPrivateDataResult> {
  const client = await pool.connect();

  try {
    const attemptedRequestIds: string[] = [];
    let candidateCount = 0;
    let purgedCount = 0;
    let failedCount = 0;

    for (let batchNo = 1; batchNo <= MAX_BATCHES_PER_RUN; batchNo += 1) {
      const candidates = await findPurgeCandidates(client, attemptedRequestIds);
      if (candidates.length === 0) {
        break;
      }

      candidateCount += candidates.length;

      for (const row of candidates) {
        attemptedRequestIds.push(row.id);

        try {
          await purgeOneWithdrawalRequest(client, row);
          purgedCount += 1;
        } catch (error) {
          failedCount += 1;
          await markPurgeFailed(client, row.id, error);
          logger.error("탈퇴 개인정보 정리 실패", {
            job: JOB_NAME,
            withdrawalRequestId: row.id,
            userId: row.user_id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (candidates.length < env.userWithdrawalPurgeBatchSize) {
        break;
      }
    }

    logger.info("탈퇴 개인정보 정리 완료", {
      job: JOB_NAME,
      candidateCount,
      purgedCount,
      failedCount,
      maxCandidatesPerRun:
        env.userWithdrawalPurgeBatchSize * MAX_BATCHES_PER_RUN,
    });

    return {
      status: "succeeded",
      candidateCount,
      purgedCount,
      failedCount,
    };
  } finally {
    client.release();
  }
}

async function findPurgeCandidates(
  client: PoolClient,
  attemptedRequestIds: string[],
): Promise<WithdrawalRequestRow[]> {
  const result = await client.query<WithdrawalRequestRow>(
    `
      SELECT id, user_id
      FROM public.user_withdrawal_requests
      WHERE private_data_purged_at IS NULL
        AND private_data_purge_after <= NOW()
        AND NOT (id = ANY($2::uuid[]))
      ORDER BY private_data_purge_after ASC, created_at ASC
      LIMIT $1
    `,
    [env.userWithdrawalPurgeBatchSize, attemptedRequestIds],
  );

  return result.rows;
}

async function purgeOneWithdrawalRequest(
  client: PoolClient,
  row: WithdrawalRequestRow,
): Promise<void> {
  await client.query("BEGIN");

  try {
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SET LOCAL statement_timeout = '120s'");

    const locked = await client.query<WithdrawalRequestRow>(
      `
        SELECT id, user_id
        FROM public.user_withdrawal_requests
        WHERE id = $1
          AND private_data_purged_at IS NULL
          AND private_data_purge_after <= NOW()
        FOR UPDATE SKIP LOCKED
      `,
      [row.id],
    );

    const request = locked.rows[0];
    if (!request) {
      await client.query("COMMIT");
      return;
    }

    if (request.user_id) {
      await purgeUserScopedPrivateData(client, request.user_id);
    }

    await client.query(
      `
        UPDATE public.withdrawn_oauth_identities
        SET
          provider_email_hash = NULL,
          updated_at = NOW()
        WHERE last_withdrawal_request_id = $1
      `,
      [request.id],
    );

    await client.query(
      `
        DELETE FROM public.user_withdrawal_retained_profiles
        WHERE withdrawal_request_id = $1
      `,
      [request.id],
    );

    await client.query(
      `
        UPDATE public.user_withdrawal_requests
        SET
          reason_detail = NULL,
          oauth_unlink_results = '[]'::jsonb,
          ip_address = NULL,
          user_agent = NULL,
          private_data_purged_at = NOW(),
          private_data_purge_error = NULL
        WHERE id = $1
      `,
      [request.id],
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function purgeUserScopedPrivateData(
  client: PoolClient,
  userId: string,
): Promise<void> {
  await client.query(
    `
      CREATE TEMP TABLE _withdrawal_target_runs ON COMMIT DROP AS
      SELECT runs.id
      FROM public.diagnosis_runs runs
      WHERE runs.user_id = $1
      UNION
      SELECT conversions.diagnosis_run_id
      FROM public.diagnosis_login_conversions conversions
      WHERE conversions.user_id = $1
    `,
    [userId],
  );

  await client.query(
    `
      CREATE TEMP TABLE _withdrawal_target_diagnosis_results ON COMMIT DROP AS
      SELECT results.id
      FROM public.diagnosis_results results
      LEFT JOIN public.diagnosis_runs runs ON runs.id = results.diagnosis_run_id
      LEFT JOIN public.diagnosis_login_conversions conversions
        ON conversions.diagnosis_result_id = results.id
      WHERE results.user_id = $1
         OR runs.user_id = $1
         OR conversions.user_id = $1
    `,
    [userId],
  );

  await client.query(
    `
      CREATE TEMP TABLE _withdrawal_target_resumes ON COMMIT DROP AS
      SELECT resumes.id
      FROM public.user_resumes resumes
      WHERE resumes.user_id = $1
    `,
    [userId],
  );

  await client.query(
    `
      CREATE TEMP TABLE _withdrawal_target_files ON COMMIT DROP AS
      SELECT files.id
      FROM public.user_files files
      WHERE files.user_id = $1
    `,
    [userId],
  );

  await client.query(
    `
      CREATE TEMP TABLE _withdrawal_target_applications ON COMMIT DROP AS
      SELECT applications.id
      FROM public.user_job_applications applications
      WHERE applications.user_id = $1
    `,
    [userId],
  );

  await client.query(
    `
      CREATE TEMP TABLE _withdrawal_target_coaching_requests ON COMMIT DROP AS
      SELECT requests.id
      FROM public.resume_coaching_requests requests
      LEFT JOIN _withdrawal_target_resumes resumes ON resumes.id = requests.resume_id
      WHERE requests.user_id = $1
         OR resumes.id IS NOT NULL
    `,
    [userId],
  );

  await client.query(
    `
      CREATE TEMP TABLE _withdrawal_target_interview_sessions ON COMMIT DROP AS
      SELECT sessions.id
      FROM public.interview_coaching_sessions sessions
      LEFT JOIN _withdrawal_target_resumes resumes ON resumes.id = sessions.resume_id
      WHERE sessions.user_id = $1
         OR resumes.id IS NOT NULL
    `,
    [userId],
  );

  await client.query(
    `
      CREATE TEMP TABLE _withdrawal_target_rejection_requests ON COMMIT DROP AS
      SELECT requests.id
      FROM public.rejection_analysis_requests requests
      LEFT JOIN _withdrawal_target_applications applications
        ON applications.id = requests.application_id
      WHERE requests.user_id = $1
         OR applications.id IS NOT NULL
    `,
    [userId],
  );

  await client.query(
    `
      UPDATE public.users
      SET
        email = NULL,
        phone = NULL,
        avatar_url = NULL,
        profile_status_message = NULL,
        profile_avatar_key = 'fox',
        profile_background_color = '#c4c6ca',
        gender = NULL,
        age_group = NULL,
        selected_diagnosis_result_id = NULL,
        selected_resume_id = NULL,
        updated_at = NOW()
      WHERE id = $1
    `,
    [userId],
  );

  await client.query(
    `DELETE FROM public.rejection_analysis_results WHERE request_id IN (SELECT id FROM _withdrawal_target_rejection_requests)`,
  );
  await client.query(
    `DELETE FROM public.rejection_analysis_requests WHERE id IN (SELECT id FROM _withdrawal_target_rejection_requests)`,
  );
  await client.query(`DELETE FROM public.user_job_bookmarks WHERE user_id = $1`, [
    userId,
  ]);
  await client.query(
    `DELETE FROM public.user_job_applications WHERE id IN (SELECT id FROM _withdrawal_target_applications)`,
  );
  await client.query(`DELETE FROM public.user_calendar_items WHERE user_id = $1`, [
    userId,
  ]);
  await client.query(
    `UPDATE public.job_posting_view_events SET user_id = NULL WHERE user_id = $1`,
    [userId],
  );
  await client.query(
    `UPDATE public.product_events SET user_id = NULL WHERE user_id = $1`,
    [userId],
  );
  await client.query(
    `UPDATE public.ai_usage_events SET user_id = NULL WHERE user_id = $1`,
    [userId],
  );
  await client.query(`UPDATE public.access_logs SET user_id = NULL WHERE user_id = $1`, [
    userId,
  ]);
  await client.query(
    `UPDATE public.user_entry_events SET user_id = NULL WHERE user_id = $1`,
    [userId],
  );
  await client.query(
    `UPDATE public.auth_login_events SET user_id = NULL WHERE user_id = $1`,
    [userId],
  );
  await client.query(
    `UPDATE public.support_inquiries SET user_id = NULL, email = NULL WHERE user_id = $1`,
    [userId],
  );
  await client.query(
    `UPDATE public.community_reports SET reviewed_by = NULL WHERE reviewed_by = $1`,
    [userId],
  );
  await client.query(`DELETE FROM public.community_reports WHERE user_id = $1`, [
    userId,
  ]);
  await client.query(
    `DELETE FROM public.community_search_logs WHERE user_id = $1`,
    [userId],
  );
  await client.query(
    `DELETE FROM public.community_post_reactions WHERE user_id = $1`,
    [userId],
  );
  await client.query(
    `DELETE FROM public.community_comment_reactions WHERE user_id = $1`,
    [userId],
  );
  await client.query(
    `DELETE FROM public.notification_dispatch_queue WHERE user_id = $1`,
    [userId],
  );
  await client.query(`DELETE FROM public.notifications WHERE user_id = $1`, [
    userId,
  ]);
  await client.query(
    `DELETE FROM public.notification_preferences WHERE user_id = $1`,
    [userId],
  );
  await client.query(
    `DELETE FROM public.resume_coaching_results WHERE request_id IN (SELECT id FROM _withdrawal_target_coaching_requests)`,
  );
  await client.query(
    `DELETE FROM public.resume_coaching_requests WHERE id IN (SELECT id FROM _withdrawal_target_coaching_requests)`,
  );
  await client.query(
    `DELETE FROM public.interview_coaching_messages WHERE session_id IN (SELECT id FROM _withdrawal_target_interview_sessions)`,
  );
  await client.query(
    `DELETE FROM public.interview_coaching_sessions WHERE id IN (SELECT id FROM _withdrawal_target_interview_sessions)`,
  );
  await client.query(
    `DELETE FROM public.user_resumes WHERE id IN (SELECT id FROM _withdrawal_target_resumes)`,
  );
  await client.query(`DELETE FROM public.resume_parse_jobs WHERE user_id = $1`, [
    userId,
  ]);
  await client.query(
    `DELETE FROM public.user_files WHERE id IN (SELECT id FROM _withdrawal_target_files)`,
  );
  await client.query(
    `DELETE FROM public.diagnosis_recommended_job_postings WHERE diagnosis_result_id IN (SELECT id FROM _withdrawal_target_diagnosis_results)`,
  );
  await client.query(
    `
      DELETE FROM public.diagnosis_login_conversions
      WHERE user_id = $1
         OR diagnosis_run_id IN (SELECT id FROM _withdrawal_target_runs)
         OR diagnosis_result_id IN (SELECT id FROM _withdrawal_target_diagnosis_results)
    `,
    [userId],
  );
  await client.query(
    `DELETE FROM public.diagnosis_results WHERE id IN (SELECT id FROM _withdrawal_target_diagnosis_results)`,
  );
  await client.query(
    `DELETE FROM public.diagnosis_answers WHERE diagnosis_run_id IN (SELECT id FROM _withdrawal_target_runs)`,
  );
  await client.query(
    `DELETE FROM public.diagnosis_runs WHERE id IN (SELECT id FROM _withdrawal_target_runs)`,
  );
  await client.query(`DELETE FROM public.user_profiles WHERE user_id = $1`, [
    userId,
  ]);
  await client.query(`DELETE FROM public.user_consents WHERE user_id = $1`, [
    userId,
  ]);
  await client.query(`DELETE FROM public.user_attributions WHERE user_id = $1`, [
    userId,
  ]);
  await client.query(`DELETE FROM public.attribution_events WHERE user_id = $1`, [
    userId,
  ]);
  await client.query(`DELETE FROM public.user_oauth_accounts WHERE user_id = $1`, [
    userId,
  ]);
  await client.query(`DELETE FROM public.user_sessions WHERE user_id = $1`, [
    userId,
  ]);
}

async function markPurgeFailed(
  client: PoolClient,
  withdrawalRequestId: string,
  error: unknown,
): Promise<void> {
  await client.query(
    `
      UPDATE public.user_withdrawal_requests
      SET private_data_purge_error = $2
      WHERE id = $1
    `,
    [
      withdrawalRequestId,
      error instanceof Error ? error.message.slice(0, 4_000) : String(error),
    ],
  );
}
