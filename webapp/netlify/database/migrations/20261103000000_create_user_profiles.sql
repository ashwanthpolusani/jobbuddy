-- Netlify Database Migration: Create user_profiles table
-- This schema migration is automatically provisioned and run by Netlify Database on deploy.

CREATE TABLE IF NOT EXISTS user_profiles (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL UNIQUE,
    display_name VARCHAR(255) DEFAULT '',
    custom_mongo_uri TEXT DEFAULT '',
    db_mode VARCHAR(20) DEFAULT 'inbuilt',
    saved_jobs JSONB DEFAULT '[]'::jsonb,
    onboarding_done BOOLEAN DEFAULT FALSE,
    deleted_at TIMESTAMPTZ DEFAULT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_profiles_user_id ON user_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_user_profiles_deleted ON user_profiles(deleted_at) WHERE deleted_at IS NULL;

-- Ensure all columns exist on tables created by earlier schema iterations
ALTER TABLE user_profiles
    ADD COLUMN IF NOT EXISTS display_name VARCHAR(255) DEFAULT '',
    ADD COLUMN IF NOT EXISTS custom_mongo_uri TEXT DEFAULT '',
    ADD COLUMN IF NOT EXISTS db_mode VARCHAR(20) DEFAULT 'inbuilt',
    ADD COLUMN IF NOT EXISTS saved_jobs JSONB DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS onboarding_done BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;
