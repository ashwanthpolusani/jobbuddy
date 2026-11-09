-- Netlify Database Migration: Add user_profiles columns
-- This migration extends user_profiles with display name, connection mode, onboarding flag, and soft delete.

ALTER TABLE user_profiles
    ADD COLUMN IF NOT EXISTS display_name VARCHAR(255) DEFAULT '',
    ADD COLUMN IF NOT EXISTS custom_mongo_uri TEXT DEFAULT '',
    ADD COLUMN IF NOT EXISTS db_mode VARCHAR(20) DEFAULT 'inbuilt',
    ADD COLUMN IF NOT EXISTS saved_jobs JSONB DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS onboarding_done BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_user_profiles_deleted ON user_profiles(deleted_at) WHERE deleted_at IS NULL;

