CREATE TABLE IF NOT EXISTS test_firmware_build_history (
  model text NOT NULL,
  csc text NOT NULL,
  hash_type text NOT NULL,
  hash_value text NOT NULL,
  pda text NOT NULL DEFAULT '',
  csc_build text NOT NULL DEFAULT '',
  cp text NOT NULL DEFAULT '',
  decrypt_status text NOT NULL CHECK (decrypt_status IN ('resolved', 'unresolved')),
  reason text NOT NULL DEFAULT '',
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  notified_at timestamptz NULL,
  admin_warning_at timestamptz NULL,
  source text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (model, csc, hash_type, hash_value)
);

CREATE INDEX IF NOT EXISTS test_firmware_build_history_target_idx
  ON test_firmware_build_history (model, csc, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS test_firmware_target_state (
  model text NOT NULL,
  csc text NOT NULL,
  last_checked_at timestamptz NOT NULL,
  last_status text NOT NULL,
  last_error text NOT NULL DEFAULT '',
  hash_count integer NOT NULL DEFAULT 0,
  new_hash_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (model, csc)
);

CREATE TABLE IF NOT EXISTS test_firmware_scan_runs (
  scan_type text NOT NULL,
  scan_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  started_at timestamptz NOT NULL,
  completed_at timestamptz NULL,
  error text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scan_type, scan_date)
);

CREATE TABLE IF NOT EXISTS test_firmware_daily_cache (
  cache_date date PRIMARY KEY,
  cleanup_completed_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS test_firmware_pipeline_state (
  pipeline_id text PRIMARY KEY,
  startup_scan_id text NOT NULL DEFAULT '',
  koo_confirmed_version text NOT NULL DEFAULT '',
  koo_confirmed_at timestamptz NULL,
  koo_confirmed_by text NOT NULL DEFAULT '',
  eux_enabled boolean NOT NULL DEFAULT false,
  eux_enabled_at timestamptz NULL,
  eux_enabled_by text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO test_firmware_pipeline_state (pipeline_id)
VALUES ('s948n-koo-to-s948b-eux')
ON CONFLICT (pipeline_id) DO NOTHING;

INSERT INTO schema_migrations (version)
VALUES ('002_test_firmware')
ON CONFLICT (version) DO NOTHING;
