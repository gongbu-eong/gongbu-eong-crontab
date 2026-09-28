-- Stop the old community worker first. Apply after 20260923_community_daily_seed.sql.
-- No public posts, comments or real user profile fields are changed.
BEGIN;

ALTER TABLE public.community_seed_personas
  ADD COLUMN IF NOT EXISTS canonical_identity JSONB,
  ADD COLUMN IF NOT EXISTS identity_status TEXT NOT NULL DEFAULT 'uninitialized',
  ADD COLUMN IF NOT EXISTS identity_version INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS identity_locked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS identity_review_notes JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.community_seed_personas'::regclass AND conname = 'seed_identity_valid') THEN
    ALTER TABLE public.community_seed_personas ADD CONSTRAINT seed_identity_valid CHECK (
      identity_status IN ('uninitialized', 'active', 'needs_review')
      AND identity_version >= 0
      AND jsonb_typeof(identity_review_notes) = 'array'
      AND (canonical_identity IS NULL OR jsonb_typeof(canonical_identity) = 'object')
      AND (identity_status <> 'active' OR (
        canonical_identity IS NOT NULL AND identity_version > 0 AND identity_locked_at IS NOT NULL
        AND canonical_identity ?& ARRAY['birthYear', 'employmentStatus', 'currentRole', 'targetRole', 'preparationStage']
      ))
    );
  END IF;
END $$;

ALTER TABLE public.community_seed_runs
  ADD COLUMN IF NOT EXISTS continuity_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS legacy_snapshot JSONB;

CREATE TABLE IF NOT EXISTS public.community_seed_memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  post_id UUID UNIQUE REFERENCES public.community_posts(id) ON DELETE SET NULL,
  seed_date DATE NOT NULL REFERENCES public.community_seed_runs(seed_date),
  topic_key TEXT NOT NULL,
  topic_hash TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  summary TEXT NOT NULL,
  review JSONB NOT NULL CHECK (jsonb_typeof(review) = 'object'),
  published_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, topic_hash),
  UNIQUE (user_id, content_hash)
);
CREATE INDEX IF NOT EXISTS community_seed_memories_user_time_idx
  ON public.community_seed_memories(user_id, published_at DESC);
CREATE INDEX IF NOT EXISTS community_seed_posts_user_time_idx
  ON public.community_posts(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS community_seed_comments_user_time_idx
  ON public.community_comments(user_id, created_at DESC);

ALTER TABLE public.community_seed_memories ENABLE ROW LEVEL SECURITY;
COMMENT ON COLUMN public.community_seed_personas.canonical_identity IS
  'Fixed fictional identity for @example.local authors; initialized once, changed only by operator review.';
COMMENT ON TABLE public.community_seed_memories IS
  'Internal AI-content provenance, per-author topic deduplication and continuity review. Not a public API.';

COMMIT;
