-- 공부엉이 채용공고 배치/조회 통계 확장안
-- 대상: PostgreSQL
--
-- 주의:
-- 1. 기존 job_postings, job_posting_details, user_job_bookmarks,
--    diagnosis_recommended_job_postings 테이블은 유지한다.
-- 2. 이 파일은 DBeaver/JDBC의 "스크립트 실행"과 pipeline 실행을 지원하도록
--    일반 CREATE INDEX를 사용한다. 인덱스 생성 중 SELECT는 가능하지만 해당
--    테이블의 INSERT/UPDATE/DELETE가 잠시 대기할 수 있으므로 사용량이 적을
--    때 실행한다.
-- 3. 대용량 운영 테이블에서 쓰기도 막지 않아야 한다면 각 CREATE INDEX를
--    CREATE INDEX CONCURRENTLY로 바꾸고, 자동 커밋 상태에서 문장별로 하나씩
--    실행해야 한다. 스크립트 전체 실행/pipeline/트랜잭션으로 실행하면 안 된다.
-- 4. 운영 DB에는 먼저 백업하고 스테이징 환경에서 실행한다.

-- ---------------------------------------------------------------------------
-- 1) 배치 실행 이력
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.job_posting_sync_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source public.job_source NOT NULL,
    status varchar(20) DEFAULT 'running' NOT NULL,
    started_at timestamptz DEFAULT now() NOT NULL,
    completed_at timestamptz NULL,
    heartbeat_at timestamptz DEFAULT now() NOT NULL,
    fetched_count int4 DEFAULT 0 NOT NULL,
    inserted_count int4 DEFAULT 0 NOT NULL,
    updated_count int4 DEFAULT 0 NOT NULL,
    deactivated_count int4 DEFAULT 0 NOT NULL,
    error_message text NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT job_posting_sync_runs_pkey PRIMARY KEY (id),
    CONSTRAINT job_posting_sync_runs_status_check
        CHECK (status IN ('running', 'succeeded', 'failed', 'skipped')),
    CONSTRAINT job_posting_sync_runs_counts_check
        CHECK (
            fetched_count >= 0
            AND inserted_count >= 0
            AND updated_count >= 0
            AND deactivated_count >= 0
        )
);

CREATE INDEX IF NOT EXISTS idx_job_posting_sync_runs_source_started
    ON public.job_posting_sync_runs (source, started_at DESC);

-- ---------------------------------------------------------------------------
-- 2) 기존 공고 테이블 보강
-- ---------------------------------------------------------------------------

-- content_hash는 API 응답 중 실제 공고 내용만 정규화한 뒤 SHA-256으로 만든다.
-- 같은 데이터면 UPDATE를 생략하여 테이블 부하와 updated_at 변경을 줄인다.
ALTER TABLE public.job_postings
    ADD COLUMN IF NOT EXISTS content_hash varchar(64) NULL,
    ADD COLUMN IF NOT EXISTS source_updated_at timestamptz NULL,
    ADD COLUMN IF NOT EXISTS closed_at timestamptz NULL;

-- 공고 목록: 활성 공고 중 마감일/최신순 조회에 사용한다.
CREATE INDEX IF NOT EXISTS idx_job_postings_active_end_created
    ON public.job_postings (application_end_at ASC, created_at DESC)
    WHERE is_active = true;

-- 배치가 source 단위로 누락 공고를 비활성화할 때 사용한다.
CREATE INDEX IF NOT EXISTS idx_job_postings_active_source_external_id
    ON public.job_postings (source, source_posting_id)
    WHERE is_active = true;

-- 진행/마감 공고를 함께 표시하는 캘린더 기간 조회에 사용한다.
CREATE INDEX IF NOT EXISTS idx_job_postings_calendar_start_end
    ON public.job_postings (application_start_at, application_end_at);

-- ---------------------------------------------------------------------------
-- 3) 공고 조회 이벤트
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.job_posting_view_events (
    id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
    job_posting_id uuid NOT NULL,
    user_id uuid NULL,
    anonymous_id uuid NULL,
    entry_source varchar(50) DEFAULT 'unknown' NOT NULL,
    viewed_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT job_posting_view_events_pkey PRIMARY KEY (id),
    CONSTRAINT job_posting_view_events_job_posting_id_fkey
        FOREIGN KEY (job_posting_id) REFERENCES public.job_postings(id),
    CONSTRAINT job_posting_view_events_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES public.users(id)
);

CREATE INDEX IF NOT EXISTS idx_job_view_events_posting_viewed
    ON public.job_posting_view_events (job_posting_id, viewed_at DESC);

CREATE INDEX IF NOT EXISTS idx_job_view_events_viewed_brin
    ON public.job_posting_view_events USING brin (viewed_at);

CREATE INDEX IF NOT EXISTS idx_job_view_events_user_viewed
    ON public.job_posting_view_events (user_id, viewed_at DESC)
    WHERE user_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4) Hot 공고용 일별 집계
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.job_posting_daily_stats (
    stat_date date NOT NULL,
    job_posting_id uuid NOT NULL,
    view_count bigint DEFAULT 0 NOT NULL,
    unique_view_count bigint DEFAULT 0 NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT job_posting_daily_stats_pkey
        PRIMARY KEY (stat_date, job_posting_id),
    CONSTRAINT job_posting_daily_stats_job_posting_id_fkey
        FOREIGN KEY (job_posting_id) REFERENCES public.job_postings(id),
    CONSTRAINT job_posting_daily_stats_counts_check
        CHECK (view_count >= 0 AND unique_view_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_job_daily_stats_posting_date
    ON public.job_posting_daily_stats (job_posting_id, stat_date DESC);

-- 최근 7일 집계 뷰. 화면에서는 아래 뷰를 view_count DESC로 LIMIT 10 한다.
CREATE OR REPLACE VIEW public.job_posting_hot_7d AS
SELECT
    s.job_posting_id,
    sum(s.view_count)::bigint AS view_count,
    sum(s.unique_view_count)::bigint AS unique_view_count
FROM public.job_posting_daily_stats AS s
WHERE s.stat_date >= (now() AT TIME ZONE 'Asia/Seoul')::date - 6
GROUP BY s.job_posting_id;

-- ---------------------------------------------------------------------------
-- 5) 이미 존재하는 찜/진단 추천 테이블의 조회 인덱스 보강
-- ---------------------------------------------------------------------------

-- user_job_bookmarks에는 이미 UNIQUE (user_id, job_posting_id)와
-- (user_id, created_at DESC) 인덱스가 있으므로 테이블 추가가 필요 없다.

CREATE INDEX IF NOT EXISTS idx_diagnosis_recommended_result_score
    ON public.diagnosis_recommended_job_postings
       (diagnosis_result_id, match_score DESC, job_posting_id);

-- ---------------------------------------------------------------------------
-- 6) 공고 마감 알림톡 발송/알림 이력
-- ---------------------------------------------------------------------------

-- job-deadline-notification은 테이블명이 아니라 crontab 작업명이다.
-- 아래 테이블들은 해당 작업의 실행 이력, 중복 방지, 화면 알림 저장에 사용된다.

DO $$
BEGIN
    CREATE TYPE public.notification_channel AS ENUM
        ('in_app', 'kakao', 'kakao_alimtalk', 'email', 'sms', 'push');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TYPE public.notification_channel ADD VALUE IF NOT EXISTS 'kakao_alimtalk';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS public.notification_preferences (
    user_id uuid PRIMARY KEY REFERENCES public.users(id),
    application_deadline_enabled boolean DEFAULT true NOT NULL,
    application_deadline_days_before int4 DEFAULT 3 NOT NULL,
    application_deadline_days_before_list int4[] DEFAULT ARRAY[3]::int4[] NOT NULL,
    tailored_job_enabled boolean DEFAULT true NOT NULL,
    marketing_enabled boolean DEFAULT false NOT NULL,
    marketing_agreed_at timestamptz NULL,
    marketing_revoked_at timestamptz NULL,
    kakao_enabled boolean DEFAULT false NOT NULL,
    kakao_connected_at timestamptz NULL,
    email_enabled boolean DEFAULT false NOT NULL,
    push_enabled boolean DEFAULT true NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL
);

ALTER TABLE public.notification_preferences
    ADD COLUMN IF NOT EXISTS application_deadline_enabled boolean DEFAULT true NOT NULL,
    ADD COLUMN IF NOT EXISTS application_deadline_days_before int4 DEFAULT 3 NOT NULL,
    ADD COLUMN IF NOT EXISTS application_deadline_days_before_list int4[] DEFAULT ARRAY[3]::int4[] NOT NULL,
    ADD COLUMN IF NOT EXISTS marketing_agreed_at timestamptz NULL,
    ADD COLUMN IF NOT EXISTS marketing_revoked_at timestamptz NULL,
    ADD COLUMN IF NOT EXISTS kakao_connected_at timestamptz NULL,
    ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now() NOT NULL;

CREATE TABLE IF NOT EXISTS public.notification_dispatch_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_name varchar(120) NOT NULL,
    status varchar(20) DEFAULT 'running' NOT NULL,
    target_date date NULL,
    started_at timestamptz DEFAULT now() NOT NULL,
    completed_at timestamptz NULL,
    queued_count int4 DEFAULT 0 NOT NULL,
    skipped_count int4 DEFAULT 0 NOT NULL,
    error_message text NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT notification_dispatch_runs_pkey PRIMARY KEY (id),
    CONSTRAINT notification_dispatch_runs_status_check
        CHECK (status IN ('running', 'succeeded', 'failed', 'skipped')),
    CONSTRAINT notification_dispatch_runs_counts_check
        CHECK (queued_count >= 0 AND skipped_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_notification_dispatch_runs_job_started
    ON public.notification_dispatch_runs (job_name, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_notification_dispatch_runs_target
    ON public.notification_dispatch_runs (job_name, target_date DESC);

CREATE TABLE IF NOT EXISTS public.notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL REFERENCES public.users(id),
    channel public.notification_channel DEFAULT 'in_app' NOT NULL,
    category varchar(40) DEFAULT 'notice' NOT NULL,
    kind varchar(80) NULL,
    title varchar(255) NOT NULL,
    body text NOT NULL,
    target_path text NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    source_type varchar(80) NULL,
    source_id text NULL,
    read_at timestamptz NULL,
    sent_at timestamptz NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT notifications_pkey PRIMARY KEY (id)
);

ALTER TABLE public.notifications
    ADD COLUMN IF NOT EXISTS category varchar(40) DEFAULT 'notice' NOT NULL,
    ADD COLUMN IF NOT EXISTS kind varchar(80) NULL,
    ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    ADD COLUMN IF NOT EXISTS source_type varchar(80) NULL,
    ADD COLUMN IF NOT EXISTS source_id text NULL,
    ADD COLUMN IF NOT EXISTS sent_at timestamptz NULL;

CREATE TABLE IF NOT EXISTS public.notification_dispatch_queue (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
    job_posting_id uuid REFERENCES public.job_postings(id) ON DELETE CASCADE,
    channel public.notification_channel NOT NULL,
    purpose varchar(80) NULL,
    recipient varchar(30) NULL,
    template_code varchar(80) NULL,
    title varchar(255) NOT NULL,
    body text NOT NULL,
    message text NULL,
    target_path text NULL,
    source_key varchar(255) NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    status varchar(30) DEFAULT 'pending' NOT NULL,
    scheduled_at timestamptz DEFAULT now() NOT NULL,
    locked_at timestamptz NULL,
    sent_at timestamptz NULL,
    failed_at timestamptz NULL,
    failure_reason text NULL,
    attempt_count int4 DEFAULT 0 NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT notification_dispatch_queue_pkey PRIMARY KEY (id),
    CONSTRAINT notification_dispatch_queue_status_check
        CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'cancelled')),
    CONSTRAINT notification_dispatch_queue_attempt_count_check
        CHECK (attempt_count >= 0)
);

ALTER TABLE public.notification_dispatch_queue
    ADD COLUMN IF NOT EXISTS job_posting_id uuid REFERENCES public.job_postings(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS purpose varchar(80) NULL,
    ADD COLUMN IF NOT EXISTS recipient varchar(30) NULL,
    ADD COLUMN IF NOT EXISTS template_code varchar(80) NULL,
    ADD COLUMN IF NOT EXISTS message text NULL,
    ADD COLUMN IF NOT EXISTS source_key varchar(255) NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_user_created
    ON public.notifications (user_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS notifications_user_source_unique_idx
    ON public.notifications (user_id, source_type, source_id)
    WHERE source_type IS NOT NULL AND source_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_user_category_created
    ON public.notifications (user_id, category, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notification_dispatch_queue_pending
    ON public.notification_dispatch_queue (scheduled_at, created_at)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_notification_dispatch_queue_user_created
    ON public.notification_dispatch_queue (user_id, created_at DESC)
    WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_notification_dispatch_queue_status_created
    ON public.notification_dispatch_queue (status, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS notification_dispatch_queue_source_key_unique_idx
    ON public.notification_dispatch_queue (source_key)
    WHERE source_key IS NOT NULL;
