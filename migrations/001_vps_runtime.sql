CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_kv (
  key text PRIMARY KEY,
  value text NOT NULL,
  expires_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS app_kv_expires_at_idx ON app_kv (expires_at)
  WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS runtime_state (
  namespace text NOT NULL,
  key text NOT NULL,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (namespace, key)
);

CREATE INDEX IF NOT EXISTS runtime_state_namespace_key_idx
  ON runtime_state (namespace, key);

CREATE TABLE IF NOT EXISTS runtime_alarms (
  namespace text PRIMARY KEY,
  alarm_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (version)
VALUES ('001_vps_runtime')
ON CONFLICT (version) DO NOTHING;
