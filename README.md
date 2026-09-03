# 공부엉이 ALIO 채용공고 배치

ALIO의 공공기관 채용정보 API를 매시간 수집하여
PostgreSQL에 신규 공고를 추가하고 변경 공고를 갱신하는 배치 프로젝트입니다.

## 준비

1. [DB 마이그레이션](docs/database/001_job_posting_batch.sql)을 먼저 실행합니다.
2. `.env`에 `DATABASE_URL`과 발급받은 `ALIO_SERVICE_KEY`를 입력합니다.

로컬 상태 확인 서버는 다음 주소를 사용합니다.

```dotenv
CRON_SERVER_HOST=localhost
CRON_SERVER_PORT=4001
CRON_MANUAL_RUN_TOKEN=
```

장시간 실행되는 배치 서버는 Supabase shared pooler의 session mode(포트 5432)를
사용합니다. 포트 6543 transaction mode에서는 세션 advisory lock을 사용하면
안 됩니다.

PowerShell:

```powershell
notepad .env
```

인증키는 Git에 커밋하지 않습니다. `.env`는 `.gitignore`에 의해
제외됩니다.

## 작업별 수동 실행

진행 공고와 상세를 즉시 동기화합니다.

```powershell
npm run sync:active
```

최근 30일 마감·수정 공고를 보정합니다.

```powershell
npm run sync:recent-history
```

실행일 기준 13개월 전부터 오늘까지의 이력을 월 단위로 적재합니다. 자동
스케줄에는 등록되지 않습니다.

```powershell
npm run sync:history-backfill
```

탈퇴 후 30일이 지난 회원의 개인정보를 정리합니다.

```powershell
npm run purge:withdrawals
```

ALIO 동기화 작업이 성공하면 다음과 같은 집계가 출력되고
`job_posting_sync_runs`에도 실행 결과가 남습니다.

```json
{
  "status": "succeeded",
  "fetchedCount": 1000,
  "insertedCount": 1000,
  "updatedCount": 0,
  "deactivatedCount": 0
}
```

## 로컬에서 크론 실행

```powershell
npm start
```

프로세스를 계속 켜 두면 `Asia/Seoul` 기준 매시간 정각에 실행됩니다.
종료는 `Ctrl+C`입니다.

페이지는 제공하지 않으며, 프로세스 상태와 등록된 작업은 다음 주소에서 확인할
수 있습니다.

```text
http://localhost:4001/health
```

등록된 작업 목록과 각 작업의 자동 실행 시간은 다음 요청으로 확인합니다.

```http
GET http://localhost:4001/jobs
```

각 작업은 서로 다른 URL로 즉시 실행할 수 있습니다.

```http
POST http://localhost:4001/jobs/alio-active-sync/run
POST http://localhost:4001/jobs/alio-recent-history-sync/run
POST http://localhost:4001/jobs/alio-history-backfill/run
POST http://localhost:4001/jobs/job-deadline-notification/run
POST http://localhost:4001/jobs/user-withdrawal-private-data-purge/run
```

쿼리 파라미터와 요청 본문은 필요하지 않습니다. 요청 접수 시 `202`, 동일 작업이
이미 실행 중이면 `409`, 등록되지 않은 작업명이면 `404`를 반환합니다.

로컬 기본 설정에서는 인증 헤더가 필요 없습니다. `CRON_MANUAL_RUN_TOKEN`을
설정했다면 다음 헤더를 추가합니다.

```http
Authorization: Bearer {CRON_MANUAL_RUN_TOKEN}
```

서버 배포 시 외부 헬스 체크를 받아야 한다면 `CRON_SERVER_HOST=0.0.0.0`으로
변경합니다. 외부 주소에서는 수동 실행 API 보호를 위해
`CRON_MANUAL_RUN_TOKEN` 설정이 필수입니다.

기본 스케줄과 범위는 아래와 같습니다.

```dotenv
ALIO_ACTIVE_SYNC_ENABLED=true
ALIO_ACTIVE_SYNC_SCHEDULE=0 * * * *
ALIO_ACTIVE_SYNC_TIMEZONE=Asia/Seoul
ALIO_ACTIVE_SYNC_RUN_ON_START=false

ALIO_RECENT_HISTORY_SYNC_ENABLED=true
ALIO_RECENT_HISTORY_SYNC_SCHEDULE=20 0 * * *
ALIO_RECENT_HISTORY_SYNC_TIMEZONE=Asia/Seoul
ALIO_RECENT_HISTORY_DAYS=30

ALIO_HISTORY_MONTHS=13
ALIO_SYNC_LOCK_WAIT_MS=600000
ALIO_PAGE_SIZE=1000

JOB_DEADLINE_NOTIFICATION_ENABLED=true
JOB_DEADLINE_NOTIFICATION_SCHEDULE=0 9 * * *
JOB_DEADLINE_NOTIFICATION_TIMEZONE=Asia/Seoul
JOB_DEADLINE_NOTIFICATION_RUN_ON_START=false
JOB_DEADLINE_NOTIFICATION_TEMPLATE_CODE=

USER_WITHDRAWAL_PURGE_ENABLED=true
USER_WITHDRAWAL_PURGE_SCHEDULE=0 * * * *
USER_WITHDRAWAL_PURGE_TIMEZONE=Asia/Seoul
USER_WITHDRAWAL_PURGE_RUN_ON_START=false
USER_WITHDRAWAL_PURGE_BATCH_SIZE=100
```

`alio-active-sync`는 매시간 정각, `alio-recent-history-sync`는 매일
자정 20분에 실행됩니다. `job-deadline-notification`은 매일 오전 9시에
찜한 공고의 마감 임박 알림 대상을 `notification_dispatch_queue`에 적재합니다.
`user-withdrawal-private-data-purge`는 매시간 정각에 탈퇴 후 30일이 지난
회원의 개인정보를 정리합니다. 한 번 실행할 때 배치 크기만큼 여러 번 이어서
처리하므로 대량 탈퇴 데이터가 쌓여도 다음 실행까지 불필요하게 밀리지 않습니다.
`alio-history-backfill`은 수동 전용입니다.

두 ALIO 작업이 지연이나 수동 호출로 겹치면 PostgreSQL 공통 advisory lock으로
한 작업만 실행하고 다른 작업은 최대 10분간 순서를 기다립니다. 먼저 실행한
작업이 끝나면 대기 작업이 이어서 실행됩니다. 10분을 초과하면 해당 실행은
`skipped`로 기록되며 수동으로 다시 실행할 수 있습니다. advisory lock은 공고
테이블의 행 잠금이 아니므로 사용자 조회를 막지 않습니다.

로컬에서 active 작업을 바로 실행하고 싶으면 다음 값을 잠시 사용할 수 있습니다.

```dotenv
ALIO_ACTIVE_SYNC_SCHEDULE=*/1 * * * *
ALIO_ACTIVE_SYNC_RUN_ON_START=true
```

검증 후에는 반드시 아래 값으로 되돌립니다.

```dotenv
ALIO_ACTIVE_SYNC_SCHEDULE=0 * * * *
ALIO_ACTIVE_SYNC_RUN_ON_START=false
```

특정 작업을 잠시 중지하려면 프로세스를 수정하지 않고 작업별 설정을 끌 수
있습니다.

```dotenv
ALIO_ACTIVE_SYNC_ENABLED=false
ALIO_RECENT_HISTORY_SYNC_ENABLED=false
```

## 여러 크론 작업 추가

스케줄러와 실제 API 작업은 분리되어 있습니다.

- `src/scheduler.ts`: 공통 등록, 스케줄 검증, 중복 실행 방지, 안전 종료
- `src/jobs/registry.ts`: 실행할 작업과 작업별 스케줄을 모아 두는 등록부
- `src/jobs/*.ts`: API별 수집·동기화 로직

다른 API를 추가할 때는 `src/jobs`에 실행 함수를 만들고
`src/jobs/registry.ts` 배열에 다음과 같은 항목을 추가합니다.

```typescript
{
  name: "another-api",
  enabled: env.anotherCronEnabled,
  schedule: env.anotherCronSchedule,
  timezone: env.anotherCronTimezone,
  runOnStart: env.anotherCronRunOnStart,
  execute: syncAnotherApi,
}
```

`src/config.ts`에는 해당 작업 전용 환경변수를 추가합니다.

```dotenv
ANOTHER_CRON_ENABLED=true
ANOTHER_CRON_SCHEDULE=30 2 * * *
ANOTHER_CRON_TIMEZONE=Asia/Seoul
ANOTHER_CRON_RUN_ON_START=false
```

위 예시는 매일 오전 2시 30분에 실행됩니다. 작업별로 `noOverlap`이 적용되므로
같은 작업의 이전 실행이 끝나지 않았다면 다음 실행은 겹쳐서 시작되지 않습니다.
ALIO 작업끼리는 별도의 공통 잠금도 공유합니다.

등록한 작업 하나만 수동 실행할 수도 있습니다.

```powershell
npm run cron:once -- another-api
```

## 동기화 방식

- `alio-active-sync`: `ongoingYn=Y` 전체 페이지를 매시간 수집하고 상세는
  신규·변경·상세 미수집 공고만 호출합니다.
- `alio-recent-history-sync`: 최근 30일을 매일 목록 조회하고 API의
  `ongoingYn` 값에 따라 진행/마감 상태를 보정합니다. 상세 API는 호출하지
  않습니다.
- `alio-history-backfill`: 한국시간 실행일 기준 13개월 전부터 오늘까지의 목록을
  월 단위로 한 번 적재합니다. 상세 API는 호출하지 않으며 각 월을 별도
  트랜잭션으로 반영해 대용량 DB 잠금과 실패 범위를 줄입니다.
- `recrutPblntSn`을 `source_posting_id`로 사용합니다.
- 공고 내용에서 SHA-256 해시를 만들어 기존 `content_hash`와 비교합니다.
- 신규 공고는 `INSERT`, 내용이나 진행 상태가 바뀐 공고만 `UPDATE`합니다.
- active 전체 페이지를 정상적으로 받은 경우에만 목록에서 사라진 진행 공고를
  비활성화합니다. 이력 작업은 범위 밖 공고를 비활성화하지 않습니다.
- 수집 건수가 `ALIO_MIN_EXPECTED_ROWS`보다 작으면 잘못된 대량 비활성화를
  막기 위해 DB 반영을 취소합니다.
- PostgreSQL 공통 advisory lock과 `node-cron`의 `noOverlap`으로 ALIO 작업의
  동시 실행을 방지합니다.
- DB 반영 중 3초 이상 잠금 대기가 발생하면 사용자 요청을 기다리게 하지 않고
  배치를 실패시킨 뒤 다음 시간에 재시도합니다.

## 상세 API

목록 API에 포함된 공고·자격·우대·전형 설명과 상세 API의 첨부파일·전형 단계를
함께 저장하도록 다음 값을 사용합니다.

```dotenv
ALIO_FETCH_DETAILS=true
```

상세 API는 신규·변경 공고 또는 상세가 아직 없는 공고에만 호출합니다. 매시간
전체 공고의 상세를 다시 호출하지 않으므로 API 호출량을 제한합니다. 최초 상세
적재 때에는 활성 공고 수만큼 상세 API가 호출됩니다.

13개월 이력 backfill은 과거 공고의 상세 API까지 일괄 호출하지 않습니다.
과거 목록에도 화면과 캘린더에 필요한 제목, 기관, 기간, 자격, 우대 조건이
포함되며, 상세 첨부파일과 전형 단계는 진행 공고 및 이후 신규·변경 공고에 대해
저장합니다.

기존 상세 데이터까지 강제로 다시 확인하려면 아래 값을 일시적으로 사용합니다.
호출량이 크게 증가하므로 상시 활성화하지 않습니다.

```dotenv
ALIO_REFRESH_DETAILS=true
```

ALIO API:

- 목록: `POST /new/v1/recruit/list.do`
- 상세: `POST /new/v1/recruit/detail.do`
- 공통 헤더: `accept: application/json`, `swaggerType: Y`
