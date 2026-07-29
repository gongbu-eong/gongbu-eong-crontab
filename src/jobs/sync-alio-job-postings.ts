import { setTimeout as delay } from "node:timers/promises";

import type { PoolClient } from "pg";

import { AlioClient } from "../alio/client";
import {
  historyMonthRanges,
  recentHistoryRange,
} from "../alio/date-range";
import { normalizePosting, postingContentHash } from "../alio/mapper";
import type {
  AlioListFilters,
  AlioPosting,
  NormalizedAlioPosting,
} from "../alio/types";
import { env } from "../config";
import { pool } from "../db/pool";
import { logger } from "../logger";

const LOCK_NAME = "job-postings:alio";

type SyncMode = "active" | "recent-history" | "history-backfill";

interface SyncOptions {
  mode: SyncMode;
  filters: AlioListFilters;
  fetchDetails: boolean;
  deactivateMissingActivePostings: boolean;
  minimumExpectedRows: number;
}

interface ExistingPosting {
  contentHash: string | null;
  isActive: boolean;
  detailFetched: boolean;
}

export interface SyncResult {
  status: "succeeded" | "skipped";
  mode: SyncMode;
  fetchedCount: number;
  insertedCount: number;
  updatedCount: number;
  deactivatedCount: number;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(values[index]);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, values.length) },
      async () => worker(),
    ),
  );

  return results;
}

function needsUpdate(
  item: AlioPosting,
  saved: ExistingPosting | undefined,
  fetchDetails: boolean,
): boolean {
  if (!saved) {
    return true;
  }

  return (
    saved.contentHash !== postingContentHash(item) ||
    saved.isActive !==
      (String(item.ongoingYn ?? "").toUpperCase() === "Y") ||
    (fetchDetails && (!saved.detailFetched || env.refreshDetails))
  );
}

function needsDetailFetch(
  item: AlioPosting,
  saved: ExistingPosting | undefined,
): boolean {
  return (
    !saved ||
    !saved.detailFetched ||
    env.refreshDetails ||
    saved.contentHash !== postingContentHash(item)
  );
}

async function loadExisting(
  client: PoolClient,
  sourcePostingIds: string[],
  includeAllActive: boolean,
): Promise<Map<string, ExistingPosting>> {
  const result = await client.query<{
    source_posting_id: string;
    content_hash: string | null;
    is_active: boolean;
    detail_fetched: boolean;
  }>(`
    SELECT
      source_posting_id,
      content_hash,
      is_active,
      COALESCE(jsonb_typeof(raw_payload -> 'detail') = 'object', false)
        AS detail_fetched
    FROM public.job_postings
    WHERE source = 'alio'::public.job_source
      AND source_posting_id IS NOT NULL
      AND (
        source_posting_id = ANY($1::text[])
        OR ($2::boolean AND is_active = true)
      )
  `, [sourcePostingIds, includeAllActive]);

  return new Map(
    result.rows.map((row) => [
      row.source_posting_id,
      {
        contentHash: row.content_hash,
        isActive: row.is_active,
        detailFetched: row.detail_fetched,
      },
    ]),
  );
}

async function enrichChangedItems(
  api: AlioClient,
  items: AlioPosting[],
  existing: Map<string, ExistingPosting>,
  fetchDetails: boolean,
): Promise<Map<string, AlioPosting>> {
  if (!fetchDetails) {
    return new Map();
  }

  const changedItems = items.filter((item) => {
    const id = String(item.recrutPblntSn);
    return needsDetailFetch(item, existing.get(id));
  });

  logger.info("알리오 상세 조회 대상 계산", {
    changedCount: changedItems.length,
    concurrency: env.detailConcurrency,
    refreshAllDetails: env.refreshDetails,
  });

  const details = await mapWithConcurrency(
    changedItems,
    env.detailConcurrency,
    async (item) => {
      const id = String(item.recrutPblntSn);
      return [id, await api.fetchDetail(id)] as const;
    },
  );

  return new Map(details);
}

async function createSyncRun(
  client: PoolClient,
  options: SyncOptions,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `
      INSERT INTO public.job_posting_sync_runs (source, status, metadata)
      VALUES (
        'alio'::public.job_source,
        'running',
        jsonb_build_object('mode', $1::text, 'filters', $2::jsonb)
      )
      RETURNING id
    `,
    [options.mode, JSON.stringify(options.filters)],
  );

  return result.rows[0].id;
}

async function markSkipped(
  client: PoolClient,
  options: SyncOptions,
): Promise<void> {
  await client.query(
    `
      INSERT INTO public.job_posting_sync_runs (
        source, status, completed_at, metadata
      )
      VALUES (
        'alio'::public.job_source,
        'skipped',
        now(),
        jsonb_build_object(
          'reason', 'advisory_lock_wait_timeout',
          'mode', $1::text,
          'filters', $2::jsonb
        )
      )
    `,
    [options.mode, JSON.stringify(options.filters)],
  );
}

async function acquireSharedLock(
  client: PoolClient,
  mode: SyncMode,
): Promise<boolean> {
  const startedAt = Date.now();
  let waitingLogged = false;

  while (true) {
    const elapsedBeforeAttempt = Date.now() - startedAt;
    if (
      waitingLogged &&
      elapsedBeforeAttempt >= env.alioSyncLockWaitMs
    ) {
      return false;
    }

    const lockResult = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [LOCK_NAME],
    );

    if (lockResult.rows[0].locked) {
      if (waitingLogged) {
        logger.info("대기 후 ALIO 공통 잠금 획득", {
          mode,
          waitedMs: Date.now() - startedAt,
        });
      }
      return true;
    }

    const waitedMs = Date.now() - startedAt;
    if (waitedMs >= env.alioSyncLockWaitMs) {
      return false;
    }

    if (!waitingLogged) {
      waitingLogged = true;
      logger.info("다른 ALIO 작업이 실행 중이어서 순서 대기", {
        mode,
        maxWaitMs: env.alioSyncLockWaitMs,
      });
    }

    await delay(Math.min(5_000, env.alioSyncLockWaitMs - waitedMs));
  }
}

async function markFailed(
  client: PoolClient,
  runId: string,
  error: unknown,
): Promise<void> {
  const message =
    error instanceof Error ? error.message.slice(0, 4_000) : String(error);

  await client.query(
    `
      UPDATE public.job_posting_sync_runs
      SET
        status = 'failed',
        completed_at = now(),
        heartbeat_at = now(),
        error_message = $2
      WHERE id = $1
    `,
    [runId, message],
  );
}

async function mergePostings(
  client: PoolClient,
  runId: string,
  options: SyncOptions,
  postings: NormalizedAlioPosting[],
  detailWriteIds: Set<string>,
  expectedCount: number,
  insertedCount: number,
  updatedCount: number,
): Promise<number> {
  await client.query("BEGIN");

  try {
    // 웹 요청과 잠금이 경합하면 사용자를 기다리게 하지 않고 배치가 실패하도록
    // 제한한다. 다음 시간 실행에서 다시 시도한다.
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query(
      "SELECT set_config('statement_timeout', $1, true)",
      [options.mode === "history-backfill" ? "180s" : "60s"],
    );

    await client.query(`
      CREATE TEMP TABLE alio_job_postings_stage (
        source_posting_id varchar(120) PRIMARY KEY,
        institution_code varchar(120) NOT NULL,
        institution_name varchar(255) NOT NULL,
        title text NOT NULL,
        ncs_category varchar(150) NULL,
        job_category varchar(150) NULL,
        work_region varchar(100) NULL,
        employment_type varchar(100) NULL,
        hiring_count int4 NULL,
        education_requirement varchar(100) NULL,
        career_requirement varchar(100) NULL,
        application_start_at timestamptz NULL,
        application_end_at timestamptz NULL,
        announcement_at timestamptz NULL,
        apply_url text NULL,
        qualification text NULL,
        disqualification text NULL,
        preference text NULL,
        screening_process text NULL,
        application_method text NULL,
        additional_notice text NULL,
        content_hash varchar(64) NOT NULL,
        raw_payload jsonb NOT NULL,
        is_active boolean NOT NULL,
        write_details boolean NOT NULL,
        detail_fetched boolean NOT NULL,
        files jsonb NOT NULL,
        steps jsonb NOT NULL
      ) ON COMMIT DROP
    `);

    await client.query(
      `
        INSERT INTO alio_job_postings_stage
        SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS x(
          source_posting_id varchar(120),
          institution_code varchar(120),
          institution_name varchar(255),
          title text,
          ncs_category varchar(150),
          job_category varchar(150),
          work_region varchar(100),
          employment_type varchar(100),
          hiring_count int4,
          education_requirement varchar(100),
          career_requirement varchar(100),
          application_start_at timestamptz,
          application_end_at timestamptz,
          announcement_at timestamptz,
          apply_url text,
          qualification text,
          disqualification text,
          preference text,
          screening_process text,
          application_method text,
          additional_notice text,
          content_hash varchar(64),
          raw_payload jsonb,
          is_active boolean,
          write_details boolean,
          detail_fetched boolean,
          files jsonb,
          steps jsonb
        )
      `,
      [
        JSON.stringify(
          postings.map((posting) => ({
            source_posting_id: posting.sourcePostingId,
            institution_code: posting.institutionCode,
            institution_name: posting.institutionName,
            title: posting.title,
            ncs_category: posting.ncsCategory,
            job_category: posting.jobCategory,
            work_region: posting.workRegion,
            employment_type: posting.employmentType,
            hiring_count: posting.hiringCount,
            education_requirement: posting.educationRequirement,
            career_requirement: posting.careerRequirement,
            application_start_at: posting.applicationStartAt,
            application_end_at: posting.applicationEndAt,
            announcement_at: posting.announcementAt,
            apply_url: posting.applyUrl,
            qualification: posting.qualification,
            disqualification: posting.disqualification,
            preference: posting.preference,
            screening_process: posting.screeningProcess,
            application_method: posting.applicationMethod,
            additional_notice: posting.additionalNotice,
            content_hash: posting.contentHash,
            raw_payload: posting.rawPayload,
            is_active: posting.isActive,
            write_details: detailWriteIds.has(posting.sourcePostingId),
            detail_fetched: posting.detailFetched,
            files: posting.files,
            steps: posting.steps,
          })),
        ),
      ],
    );

    await client.query(`
      INSERT INTO public.public_institutions (
        alio_institution_id, name
      )
      SELECT DISTINCT ON (institution_code)
        institution_code,
        institution_name
      FROM alio_job_postings_stage
      ORDER BY institution_code, institution_name
      ON CONFLICT (alio_institution_id)
      DO UPDATE SET name = EXCLUDED.name
      WHERE public.public_institutions.name IS DISTINCT FROM EXCLUDED.name
    `);

    await client.query(`
      INSERT INTO public.job_postings (
        source,
        source_posting_id,
        institution_id,
        title,
        ncs_category,
        job_category,
        work_region,
        employment_type,
        hiring_count,
        education_requirement,
        career_requirement,
        application_start_at,
        application_end_at,
        announcement_at,
        apply_url,
        raw_payload,
        content_hash,
        is_active,
        closed_at
      )
      SELECT
        'alio'::public.job_source,
        s.source_posting_id,
        i.id,
        s.title,
        s.ncs_category,
        s.job_category,
        s.work_region,
        s.employment_type,
        s.hiring_count,
        s.education_requirement,
        s.career_requirement,
        s.application_start_at,
        s.application_end_at,
        s.announcement_at,
        s.apply_url,
        s.raw_payload,
        s.content_hash,
        s.is_active,
        CASE
          WHEN s.is_active THEN NULL
          ELSE COALESCE(s.application_end_at, now())
        END
      FROM alio_job_postings_stage AS s
      JOIN public.public_institutions AS i
        ON i.alio_institution_id = s.institution_code
      ON CONFLICT (source, source_posting_id)
      DO UPDATE SET
        institution_id = EXCLUDED.institution_id,
        title = EXCLUDED.title,
        ncs_category = EXCLUDED.ncs_category,
        job_category = EXCLUDED.job_category,
        work_region = EXCLUDED.work_region,
        employment_type = EXCLUDED.employment_type,
        hiring_count = EXCLUDED.hiring_count,
        education_requirement = EXCLUDED.education_requirement,
        career_requirement = EXCLUDED.career_requirement,
        application_start_at = EXCLUDED.application_start_at,
        application_end_at = EXCLUDED.application_end_at,
        announcement_at = EXCLUDED.announcement_at,
        apply_url = EXCLUDED.apply_url,
        raw_payload = CASE
          WHEN jsonb_typeof(EXCLUDED.raw_payload -> 'detail') = 'object'
            THEN EXCLUDED.raw_payload
          ELSE jsonb_set(
            EXCLUDED.raw_payload,
            '{detail}',
            COALESCE(
              public.job_postings.raw_payload -> 'detail',
              'null'::jsonb
            ),
            true
          )
        END,
        content_hash = EXCLUDED.content_hash,
        is_active = EXCLUDED.is_active,
        closed_at = CASE
          WHEN EXCLUDED.is_active THEN NULL
          ELSE COALESCE(
            public.job_postings.closed_at,
            EXCLUDED.application_end_at,
            now()
          )
        END
      WHERE public.job_postings.content_hash IS DISTINCT FROM EXCLUDED.content_hash
         OR public.job_postings.is_active IS DISTINCT FROM EXCLUDED.is_active
         OR (
           jsonb_typeof(EXCLUDED.raw_payload -> 'detail') = 'object'
           AND public.job_postings.raw_payload -> 'detail'
                 IS DISTINCT FROM EXCLUDED.raw_payload -> 'detail'
         )
    `);

    await client.query(`
      INSERT INTO public.job_posting_details (
        job_posting_id,
        qualification,
        disqualification,
        preference,
        screening_process,
        application_method,
        additional_notice
      )
      SELECT
        p.id,
        s.qualification,
        s.disqualification,
        s.preference,
        s.screening_process,
        s.application_method,
        s.additional_notice
      FROM alio_job_postings_stage AS s
      JOIN public.job_postings AS p
        ON p.source = 'alio'::public.job_source
       AND p.source_posting_id = s.source_posting_id
      WHERE s.write_details = true
      ON CONFLICT (job_posting_id)
      DO UPDATE SET
        qualification = EXCLUDED.qualification,
        disqualification = EXCLUDED.disqualification,
        preference = EXCLUDED.preference,
        screening_process = EXCLUDED.screening_process,
        application_method = EXCLUDED.application_method,
        additional_notice = EXCLUDED.additional_notice
    `);

    await client.query(`
      DELETE FROM public.job_posting_files AS f
      USING public.job_postings AS p, alio_job_postings_stage AS s
      WHERE f.job_posting_id = p.id
        AND p.source = 'alio'::public.job_source
        AND p.source_posting_id = s.source_posting_id
        AND s.detail_fetched = true
    `);

    await client.query(`
      INSERT INTO public.job_posting_files (
        job_posting_id, file_name, file_type, file_url, sort_order
      )
      SELECT
        p.id,
        COALESCE(file_row."atchFileNm", '첨부파일'),
        file_row."atchFileType",
        file_row.url,
        COALESCE(NULLIF(file_row."sortNo", '')::int, 0)
      FROM alio_job_postings_stage AS s
      JOIN public.job_postings AS p
        ON p.source = 'alio'::public.job_source
       AND p.source_posting_id = s.source_posting_id
      CROSS JOIN LATERAL jsonb_to_recordset(s.files) AS file_row(
        "atchFileNm" text,
        "atchFileType" text,
        "recrutAtchFileNo" text,
        "sortNo" text,
        url text
      )
      WHERE s.detail_fetched = true
        AND NULLIF(file_row.url, '') IS NOT NULL
    `);

    await client.query(`
      DELETE FROM public.job_posting_stages AS stage
      USING public.job_postings AS p, alio_job_postings_stage AS s
      WHERE stage.job_posting_id = p.id
        AND p.source = 'alio'::public.job_source
        AND p.source_posting_id = s.source_posting_id
        AND s.detail_fetched = true
    `);

    await client.query(`
      INSERT INTO public.job_posting_stages (
        job_posting_id, stage_name, stage_order
      )
      SELECT
        p.id,
        COALESCE(step_row."recrutPbancTtl", '채용 단계'),
        row_number() OVER (
          PARTITION BY p.id
          ORDER BY
            COALESCE(NULLIF(step_row."sortNo", '')::int, 2147483647),
            COALESCE(NULLIF(step_row."recrutStepSn", '')::int, 2147483647)
        )::int
      FROM alio_job_postings_stage AS s
      JOIN public.job_postings AS p
        ON p.source = 'alio'::public.job_source
       AND p.source_posting_id = s.source_posting_id
      CROSS JOIN LATERAL jsonb_to_recordset(s.steps) AS step_row(
        "recrutStepSn" text,
        "recrutPbancTtl" text,
        "sortNo" text,
        "rsnOcrnYmd" text
      )
      WHERE s.detail_fetched = true
    `);

    let deactivatedCount = 0;
    if (options.deactivateMissingActivePostings) {
      const deactivated = await client.query(`
        UPDATE public.job_postings AS p
        SET
          is_active = false,
          closed_at = COALESCE(p.closed_at, now())
        WHERE p.source = 'alio'::public.job_source
          AND p.is_active = true
          AND NOT EXISTS (
            SELECT 1
            FROM alio_job_postings_stage AS s
            WHERE s.source_posting_id = p.source_posting_id
          )
        RETURNING p.id
      `);
      deactivatedCount = deactivated.rowCount ?? 0;
    }

    await client.query(
      `
        UPDATE public.job_posting_sync_runs
        SET
          status = 'succeeded',
          completed_at = now(),
          heartbeat_at = now(),
          fetched_count = $2,
          inserted_count = $3,
          updated_count = $4,
          deactivated_count = $5,
          metadata = jsonb_build_object(
            'apiTotalCount', $6::int,
            'detailsEnabled', $7::boolean,
            'detailsRefreshed', $8::boolean,
            'mode', $9::text,
            'filters', $10::jsonb
          )
        WHERE id = $1
      `,
      [
        runId,
        postings.length,
        insertedCount,
        updatedCount,
        deactivatedCount,
        expectedCount,
        options.fetchDetails,
        env.refreshDetails,
        options.mode,
        JSON.stringify(options.filters),
      ],
    );

    await client.query("COMMIT");
    return deactivatedCount;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function syncAlioPostings(
  options: SyncOptions,
): Promise<SyncResult> {
  const client = await pool.connect();
  let lockAcquired = false;
  let runId: string | null = null;

  try {
    lockAcquired = await acquireSharedLock(client, options.mode);

    if (!lockAcquired) {
      await markSkipped(client, options);
      logger.warn("ALIO 공통 잠금 대기 시간이 초과되어 건너뜁니다.", {
        mode: options.mode,
        maxWaitMs: env.alioSyncLockWaitMs,
      });
      return {
        status: "skipped",
        mode: options.mode,
        fetchedCount: 0,
        insertedCount: 0,
        updatedCount: 0,
        deactivatedCount: 0,
      };
    }

    runId = await createSyncRun(client, options);
    logger.info("알리오 채용공고 동기화 시작", {
      runId,
      mode: options.mode,
      filters: options.filters,
      fetchDetails: options.fetchDetails,
    });

    const api = new AlioClient();
    const listResult = await api.fetchPostings(options.filters);
    const sourcePostingIds = listResult.items.map((item) =>
      String(item.recrutPblntSn),
    );
    const existing = await loadExisting(
      client,
      sourcePostingIds,
      options.deactivateMissingActivePostings,
    );

    if (listResult.items.length < options.minimumExpectedRows) {
      throw new Error(
        `안전 기준보다 수집 건수가 적어 반영하지 않습니다. fetched=${listResult.items.length}, minimum=${options.minimumExpectedRows}`,
      );
    }

    const details = await enrichChangedItems(
      api,
      listResult.items,
      existing,
      options.fetchDetails,
    );
    const postings = listResult.items.map((item) => {
      const id = String(item.recrutPblntSn);
      return normalizePosting(item, details.get(id) ?? null);
    });
    const changedIds = new Set(
      listResult.items
        .filter((item) => {
          const id = String(item.recrutPblntSn);
          return needsUpdate(
            item,
            existing.get(id),
            options.fetchDetails,
          );
        })
        .map((item) => String(item.recrutPblntSn)),
    );
    const detailWriteIds = new Set(
      listResult.items
        .filter((item) => {
          const id = String(item.recrutPblntSn);
          const saved = existing.get(id);
          return (
            changedIds.has(id) &&
            (details.has(id) || !saved?.detailFetched)
          );
        })
        .map((item) => String(item.recrutPblntSn)),
    );
    const insertedCount = postings.filter(
      (posting) => !existing.has(posting.sourcePostingId),
    ).length;
    const updatedCount = postings.filter(
      (posting) =>
        existing.has(posting.sourcePostingId) &&
        changedIds.has(posting.sourcePostingId),
    ).length;
    const deactivatedCount = await mergePostings(
      client,
      runId,
      options,
      postings,
      detailWriteIds,
      listResult.totalCount,
      insertedCount,
      updatedCount,
    );

    logger.info("알리오 채용공고 동기화 완료", {
      runId,
      mode: options.mode,
      fetchedCount: postings.length,
      insertedCount,
      updatedCount,
      deactivatedCount,
    });

    return {
      status: "succeeded",
      mode: options.mode,
      fetchedCount: postings.length,
      insertedCount,
      updatedCount,
      deactivatedCount,
    };
  } catch (error) {
    if (runId) {
      try {
        await markFailed(client, runId, error);
      } catch (markError) {
        logger.error("배치 실패 이력 기록도 실패했습니다.", {
          error:
            markError instanceof Error ? markError.message : String(markError),
        });
      }
    }

    logger.error("알리오 채용공고 동기화 실패", {
      runId,
      mode: options.mode,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    if (lockAcquired) {
      try {
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [
          LOCK_NAME,
        ]);
      } catch (error) {
        logger.error("알리오 동기화 잠금 해제 실패", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    client.release();
  }
}

export function syncAlioActivePostings(): Promise<SyncResult> {
  return syncAlioPostings({
    mode: "active",
    filters: { ongoingYn: "Y" },
    fetchDetails: env.fetchDetails,
    deactivateMissingActivePostings: true,
    minimumExpectedRows: env.minimumExpectedRows,
  });
}

export function syncAlioRecentHistory(
  now = new Date(),
): Promise<SyncResult> {
  const range = recentHistoryRange(
    now,
    env.alioRecentHistoryDays,
    env.alioRecentHistorySyncTimezone,
  );

  return syncAlioPostings({
    mode: "recent-history",
    filters: {
      pbancBgngYmd: range.startDate,
      pbancEndYmd: range.endDate,
    },
    fetchDetails: false,
    deactivateMissingActivePostings: false,
    minimumExpectedRows: 0,
  });
}

export async function backfillAlioHistory(
  now = new Date(),
): Promise<SyncResult> {
  const ranges = historyMonthRanges(
    now,
    env.alioRecentHistorySyncTimezone,
    env.alioHistoryMonths,
  );
  const aggregate: SyncResult = {
    status: "succeeded",
    mode: "history-backfill",
    fetchedCount: 0,
    insertedCount: 0,
    updatedCount: 0,
    deactivatedCount: 0,
  };

  for (const [index, range] of ranges.entries()) {
    logger.info("ALIO 최근 이력 월별 backfill 시작", {
      batch: index + 1,
      totalBatches: ranges.length,
      historyMonths: env.alioHistoryMonths,
      range,
    });

    const result = await syncAlioPostings({
      mode: "history-backfill",
      filters: {
        pbancBgngYmd: range.startDate,
        pbancEndYmd: range.endDate,
      },
      fetchDetails: false,
      deactivateMissingActivePostings: false,
      minimumExpectedRows: 0,
    });

    aggregate.fetchedCount += result.fetchedCount;
    aggregate.insertedCount += result.insertedCount;
    aggregate.updatedCount += result.updatedCount;
    aggregate.deactivatedCount += result.deactivatedCount;

    if (result.status === "skipped") {
      aggregate.status = "skipped";
      break;
    }
  }

  return aggregate;
}

// 기존 호출부와의 호환을 위해 active 동기화 별칭을 유지한다.
export const syncAlioJobPostings = syncAlioActivePostings;
