-- Additive patch if migration_55 ran before `sending` status was added.
DO $$ BEGIN
  ALTER TYPE month_end_package_status ADD VALUE IF NOT EXISTS 'sending' AFTER 'ready_to_send';
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;
