import { env } from "./config";
import { closePool, pool } from "./db/pool";

async function main(): Promise<void> {
  if (!env.alioServiceKey) {
    throw new Error("필수 환경변수 ALIO_SERVICE_KEY가 없습니다.");
  }

  const database = await pool.query<{
    database: string;
    job_postings: string | null;
    sync_runs: string | null;
  }>(`
    SELECT
      current_database() AS database,
      to_regclass('public.job_postings')::text AS job_postings,
      to_regclass('public.job_posting_sync_runs')::text AS sync_runs
  `);

  const url = new URL(
    `${env.alioApiBaseUrl.replace(/\/$/, "")}/list.do`,
  );
  url.searchParams.set("serviceKey", env.alioServiceKey);
  url.searchParams.set("resultType", "json");
  url.searchParams.set("ongoingYn", "Y");
  url.searchParams.set("pageNo", "1");
  url.searchParams.set("numOfRows", "1");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      swaggerType: "Y",
    },
    signal: AbortSignal.timeout(env.requestTimeoutMs),
  });
  const bodyText = await response.text();
  let apiBody: Record<string, unknown> = {};

  try {
    apiBody = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    // 인증 실패처럼 JSON이 아닌 응답은 상태와 짧은 메시지만 출력한다.
  }

  console.log(
    JSON.stringify(
      {
        database: database.rows[0],
        alioApi: {
          httpStatus: response.status,
          resultCode: apiBody.resultCode ?? null,
          resultMsg: apiBody.resultMsg ?? bodyText.slice(0, 100),
          totalCount: apiBody.totalCount ?? null,
        },
      },
      null,
      2,
    ),
  );

  if (
    !response.ok ||
    !["0", "00", "200"].includes(String(apiBody.resultCode))
  ) {
    process.exitCode = 1;
  }
}

void main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(closePool);
