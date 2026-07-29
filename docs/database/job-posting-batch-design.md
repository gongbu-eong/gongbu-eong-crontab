# 채용공고 배치 및 조회 DB 설계

## 결론

공고를 “운영 테이블/새 테이블” 두 벌로 만들어 교체하지 않는다. 기존
`job_postings`의 UUID를 계속 유지하면서 외부 API의
`(source, source_posting_id)`를 기준으로 `UPSERT`한다.

테이블 역할은 다음처럼 나눈다.

| 역할 | 테이블 | 처리 |
| --- | --- | --- |
| 목록/검색에 필요한 공통 필드 | `job_postings` | 기존 테이블 유지 및 보강 |
| 긴 상세 설명 | `job_posting_details` | 기존 1:1 테이블 유지 |
| 첨부파일/채용 단계 | `job_posting_files`, `job_posting_stages` | 기존 1:N 테이블 유지 |
| 로그인 사용자 찜 | `user_job_bookmarks` | 기존 테이블 그대로 사용 |
| 진단별 추천 | `diagnosis_recommended_job_postings` | 기존 테이블 그대로 사용, 인덱스 추가 |
| 조회 원장 | `job_posting_view_events` | 새로 생성 |
| Hot 공고 집계 | `job_posting_daily_stats` | 새로 생성 |
| 수집 성공/실패 이력 | `job_posting_sync_runs` | 새로 생성 |

이 구조에서는 배치가 실행되는 동안 조회 쿼리가 기존 행을 계속 읽을 수 있다.
공고를 전체 `DELETE`하거나 `TRUNCATE`한 뒤 다시 넣으면 안 된다. 그렇게 하면
화면이 잠시 비고, 찜·지원·추천의 외래키도 깨질 수 있다.

PostgreSQL의 일반 `SELECT`는 이 `UPSERT`의 행 잠금 때문에 멈추지 않는다.
트랜잭션 커밋 전에는 이전 데이터를, 커밋 후에는 새 데이터를 보게 된다.
단, 최초 `ALTER TABLE` 마이그레이션은 짧은 스키마 잠금이 필요하므로 접속이
적은 시간에 적용한다. 제공된 마이그레이션은 DBeaver의 스크립트/pipeline
실행과 호환되도록 일반 `CREATE INDEX`를 사용한다. 이때 조회는 가능하지만
인덱스 대상 테이블의 쓰기가 잠시 대기할 수 있다.

데이터가 많은 운영 DB에서 쓰기까지 계속 허용해야 한다면 해당 문장을
`CREATE INDEX CONCURRENTLY`로 바꾼 다음, DBeaver 자동 커밋 상태에서 각각의
인덱스 문장만 선택하여 한 문장씩 실행한다. `CONCURRENTLY` 문장을 스크립트
전체 실행, pipeline 또는 명시적 트랜잭션으로 보내면 PostgreSQL 오류가 난다.

## 자정 수집 순서

1. DB 연결 하나를 배치 종료까지 전용으로 확보한다.
2. `pg_try_advisory_lock`으로 같은 source의 중복 배치를 막는다.
3. `job_posting_sync_runs`에 `running` 실행을 기록한다.
4. 외부 API의 모든 페이지를 받아 검증한다.
5. 같은 연결에 임시 스테이징 테이블을 만들고 받아온 전체 데이터를 적재한다.
6. 짧은 트랜잭션 안에서 기관 → 공고 목록 → 상세/파일/단계를 `UPSERT`한다.
7. 외부 API 전체 수집이 성공한 경우에만 스테이징에 없는 기존 공고를
   `is_active = false`, `closed_at = now()`로 변경한다.
8. 실행 이력을 `succeeded`로 바꾸고 커밋한 뒤 advisory lock을 해제한다.

API 오류, 페이지 일부 누락, 비정상적으로 적은 수집 건수에서는 7번을 실행하면
안 된다. 기존 공고를 그대로 노출하고 실행 이력만 `failed`로 남긴다.

### 동시 실행 잠금

```sql
SELECT pg_try_advisory_lock(hashtext('job-postings:alio'));
-- false이면 다른 인스턴스가 실행 중이므로 이번 실행은 skipped 처리

-- 배치 종료 시 같은 DB 연결에서 실행
SELECT pg_advisory_unlock(hashtext('job-postings:alio'));
```

`node-cron`의 `noOverlap`은 한 Node 프로세스 안의 중복만 막는다. 서버가 두 대면
각 서버에서 한 번씩 실행되므로 DB advisory lock도 반드시 사용한다.

## 무중단 공고 병합 예시

외부 API를 모두 받은 뒤 같은 DB 연결에서 아래와 같은 임시 테이블을 만든다.
실제 컬럼은 API 매핑에 맞게 확장한다.

```sql
CREATE TEMP TABLE job_postings_stage (
    source public.job_source NOT NULL,
    source_posting_id varchar(120) NOT NULL,
    institution_id uuid NULL,
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
    email_apply_address text NULL,
    raw_payload jsonb NULL,
    content_hash varchar(64) NOT NULL,
    source_updated_at timestamptz NULL,
    PRIMARY KEY (source, source_posting_id)
) ON COMMIT DROP;
```

전체 페이지 수집 및 최소 건수 검증이 끝난 뒤에만 다음 트랜잭션을 실행한다.

```sql
BEGIN;

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
    email_apply_address,
    raw_payload,
    content_hash,
    source_updated_at,
    is_active,
    closed_at
)
SELECT
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
    email_apply_address,
    raw_payload,
    content_hash,
    source_updated_at,
    true,
    NULL
FROM job_postings_stage
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
    email_apply_address = EXCLUDED.email_apply_address,
    raw_payload = EXCLUDED.raw_payload,
    content_hash = EXCLUDED.content_hash,
    source_updated_at = EXCLUDED.source_updated_at,
    is_active = true,
    closed_at = NULL
WHERE public.job_postings.content_hash IS DISTINCT FROM EXCLUDED.content_hash
   OR public.job_postings.is_active = false;

UPDATE public.job_postings AS p
SET
    is_active = false,
    closed_at = COALESCE(p.closed_at, now())
WHERE p.source = 'alio'::public.job_source
  AND p.is_active = true
  AND NOT EXISTS (
      SELECT 1
      FROM job_postings_stage AS s
      WHERE s.source = p.source
        AND s.source_posting_id = p.source_posting_id
  );

COMMIT;
```

`content_hash`에는 조회수처럼 서비스 내부에서 바뀌는 값이나 API 호출 시각을
넣지 않는다. 외부 공고의 실제 내용 필드만 키 순서를 고정해 직렬화한 뒤
SHA-256을 계산해야 매일 불필요한 UPDATE가 발생하지 않는다.

## 화면별 쿼리

### 활성 채용공고 목록

```sql
SELECT p.*, i.name AS institution_name
FROM public.job_postings AS p
LEFT JOIN public.public_institutions AS i ON i.id = p.institution_id
WHERE p.is_active = true
  AND (p.application_end_at IS NULL OR p.application_end_at >= now())
ORDER BY p.application_end_at ASC NULLS LAST, p.created_at DESC
LIMIT $1 OFFSET $2;
```

### 찜 추가/해제 및 목록

```sql
-- 추가: 중복 클릭에도 안전
INSERT INTO public.user_job_bookmarks (user_id, job_posting_id, entry_source)
VALUES ($1, $2, $3::public.entry_source)
ON CONFLICT (user_id, job_posting_id) DO NOTHING;

-- 해제
DELETE FROM public.user_job_bookmarks
WHERE user_id = $1 AND job_posting_id = $2;

-- 목록: 마감 공고도 사용자의 기록이므로 삭제하지 않고 상태와 함께 보여준다.
SELECT b.created_at AS bookmarked_at, p.*
FROM public.user_job_bookmarks AS b
JOIN public.job_postings AS p ON p.id = b.job_posting_id
WHERE b.user_id = $1
ORDER BY b.created_at DESC;
```

### 조회 이벤트 기록

상세 화면이 정상 응답한 뒤 한 번 기록한다. 개발 모드의 중복 렌더링이나
프리패치 요청은 조회수에 포함하지 않는다.

```sql
INSERT INTO public.job_posting_view_events (
    job_posting_id, user_id, anonymous_id, entry_source
) VALUES ($1, $2, $3, $4);
```

### 일별 조회수 재집계

오늘 데이터는 5~10분마다 다시 집계하고, 전날 데이터는 자정 이후 한 번
확정하면 Hot 목록이 최신 상태에 가깝게 유지된다.

```sql
INSERT INTO public.job_posting_daily_stats (
    stat_date, job_posting_id, view_count, unique_view_count, updated_at
)
SELECT
    (e.viewed_at AT TIME ZONE 'Asia/Seoul')::date AS stat_date,
    e.job_posting_id,
    count(*)::bigint AS view_count,
    count(DISTINCT COALESCE(
        'u:' || e.user_id::text,
        'a:' || e.anonymous_id::text,
        'e:' || e.id::text
    ))::bigint AS unique_view_count,
    now()
FROM public.job_posting_view_events AS e
WHERE e.viewed_at >= $1::date AT TIME ZONE 'Asia/Seoul'
  AND e.viewed_at < ($1::date + 1) AT TIME ZONE 'Asia/Seoul'
GROUP BY 1, 2
ON CONFLICT (stat_date, job_posting_id)
DO UPDATE SET
    view_count = EXCLUDED.view_count,
    unique_view_count = EXCLUDED.unique_view_count,
    updated_at = now();
```

### 로그인 메인의 Hot 공고 10개

```sql
SELECT
    p.*,
    h.view_count,
    h.unique_view_count
FROM public.job_posting_hot_7d AS h
JOIN public.job_postings AS p ON p.id = h.job_posting_id
WHERE p.is_active = true
  AND (p.application_end_at IS NULL OR p.application_end_at >= now())
ORDER BY h.view_count DESC, h.unique_view_count DESC, p.created_at DESC
LIMIT 10;
```

### 사용자의 최신 진단 결과 추천 공고

```sql
WITH latest_result AS (
    SELECT r.id
    FROM public.diagnosis_results AS r
    WHERE r.user_id = $1
    ORDER BY r.created_at DESC
    LIMIT 1
)
SELECT
    p.*,
    rec.match_score,
    rec.reason
FROM latest_result AS lr
JOIN public.diagnosis_recommended_job_postings AS rec
  ON rec.diagnosis_result_id = lr.id
JOIN public.job_postings AS p ON p.id = rec.job_posting_id
WHERE p.is_active = true
  AND (p.application_end_at IS NULL OR p.application_end_at >= now())
ORDER BY rec.match_score DESC NULLS LAST, p.created_at DESC
LIMIT $2;
```

## 크론 프로세스 배치 방식

이 프로젝트처럼 배치를 별도로 운영한다면 웹 서버와 크론 프로세스를 분리하는
것이 가장 단순하다.

```text
웹/API 프로세스 ── 읽기·찜·조회 이벤트 ── PostgreSQL
배치 프로세스   ── 외부 API 수집·UPSERT ─┘
```

권장 스케줄은 다음과 같다.

- 공고 전체 동기화: `0 0 * * *`, timezone `Asia/Seoul`
- 오늘 조회 통계 갱신: `*/5 * * * *`, timezone `Asia/Seoul`
- 오래된 조회 이벤트 정리/보관: 월 1회, 운영 보존 정책에 따라 수행

```ts
import cron from "node-cron";

cron.schedule("0 0 * * *", syncAllJobPostings, {
  name: "sync-alio-job-postings",
  timezone: "Asia/Seoul",
  noOverlap: true,
});

cron.schedule("*/5 * * * *", refreshTodayJobStats, {
  name: "refresh-today-job-stats",
  timezone: "Asia/Seoul",
  noOverlap: true,
});
```

추천 코드 경계는 다음과 같다.

```text
src/
  cron.ts                    # 스케줄 등록만 담당
  jobs/
    sync-job-postings.ts     # 한 번의 전체 공고 동기화
    refresh-job-stats.ts     # 오늘 조회 통계 재집계
  db/
    pool.ts                  # PostgreSQL 연결 풀
    job-posting-repository.ts
  clients/
    alio-client.ts           # 페이지네이션/재시도/타임아웃
```

Next.js 서버 시작 훅에서 크론을 등록하면 영속적인 단일 Node 서버에서는
동작할 수 있지만, 서버리스는 인스턴스가 계속 살아 있다는 보장이 없고 다중
인스턴스에서는 중복 등록된다. 배치 전용 프로세스/컨테이너를 한 개 실행하고,
DB advisory lock으로 최종 중복 방지를 하는 구성이 안전하다.
