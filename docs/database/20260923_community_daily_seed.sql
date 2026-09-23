-- Apply to the same database as gongbu-eong-backend before enabling the job.
-- No existing users, posts or comments are modified.
BEGIN;

CREATE TABLE IF NOT EXISTS public.community_seed_personas (
  user_id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  persona JSONB NOT NULL CHECK (jsonb_typeof(persona) = 'object'),
  model TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.community_seed_runs (
  seed_date DATE PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('running', 'failed', 'completed')),
  post_count INTEGER NOT NULL CHECK (post_count BETWEEN 3 AND 20),
  model TEXT NOT NULL,
  actors JSONB NOT NULL DEFAULT '[]'::jsonb,
  plan JSONB NOT NULL DEFAULT '[]'::jsonb,
  drafts JSONB NOT NULL DEFAULT '[]'::jsonb,
  post_ids UUID[] NOT NULL DEFAULT '{}',
  comment_count INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 1,
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

COMMENT ON TABLE public.community_seed_runs IS
  'AI-generated community content provenance and resumable daily runs (Asia/Seoul).';

-- Internal drafts must not be exposed by a public PostgREST/Supabase API.
-- The batch connection must use the table owner or a BYPASSRLS role.
ALTER TABLE public.community_seed_personas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.community_seed_runs ENABLE ROW LEVEL SECURITY;

COMMIT;
