-- Ensure user_profiles table exists before applying alterations
CREATE TABLE IF NOT EXISTS user_profiles (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL UNIQUE,
    custom_mongo_uri TEXT DEFAULT '',
    saved_jobs JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_profiles_user_id ON user_profiles(user_id);

-- Extend user_profiles with new fields needed for onboarding, profile management, and GDPR
ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS display_name    VARCHAR(255) DEFAULT '',
  ADD COLUMN IF NOT EXISTS db_mode         VARCHAR(20)  DEFAULT 'inbuilt',
  ADD COLUMN IF NOT EXISTS onboarding_done BOOLEAN      DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS deleted_at      TIMESTAMPTZ  DEFAULT NULL;

-- Note: user_id is stored as-is (email or sub from Netlify Identity JWT)
-- custom_mongo_uri is encrypted at rest by Netlify DB infrastructure
-- custom_mongo_uri is NEVER returned in public API responses
CREATE INDEX IF NOT EXISTS idx_user_profiles_deleted ON user_profiles(deleted_at) WHERE deleted_at IS NULL;
