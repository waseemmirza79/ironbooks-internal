-- Migration 93: client_email_log — per-client outbound email audit trail
--
-- Backs the "Email History" tab on the client profile and the delivery-status
-- column. One row per recipient per send. Internal/bookkeeper-only (RLS allows
-- authenticated read; writes are service-role from the send routes + the Resend
-- webhook). Idempotent. Apply via the Supabase SQL editor.
--
-- Status lifecycle: 'sent' (accepted by Resend, message id stored) ->
-- 'delivered' | 'bounced' | 'complained' (set by the Resend webhook), or
-- 'failed' (Resend rejected the send / no provider id).

CREATE TABLE IF NOT EXISTS client_email_log (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_link_id      uuid NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  to_address          text NOT NULL,
  email_type          text NOT NULL,          -- 'stripe_connect' | 'bs_statements' | ...
  subject             text,
  status              text NOT NULL DEFAULT 'sent'
                        CHECK (status IN ('pending','sent','delivered','bounced','complained','failed')),
  provider_message_id text,                    -- Resend email id (for webhook matching)
  error               text,
  created_by          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_client_email_log_client_created
  ON client_email_log (client_link_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_client_email_log_provider_msg
  ON client_email_log (provider_message_id);

ALTER TABLE client_email_log ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "client_email_log_read" ON client_email_log
    FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Verify
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'client_email_log'
ORDER BY ordinal_position;
