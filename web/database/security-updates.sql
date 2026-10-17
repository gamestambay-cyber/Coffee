-- Maple's Bean security update. Back up the database before applying.
ALTER TABLE users ADD COLUMN active_session_id VARCHAR(128) NULL;
-- Keep exactly one superadmin. Review duplicates before running this migration.
SELECT id,email FROM users WHERE role='superadmin';
-- If multiple superadmins exist, manually demote all but the chosen account before continuing.
