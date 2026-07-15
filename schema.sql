-- D1 schema for traffic dashboard
CREATE TABLE IF NOT EXISTS machines (
  machine_id TEXT PRIMARY KEY,
  hostname   TEXT,
  interface  TEXT,
  last_ts    INTEGER,
  today_rx   INTEGER,
  today_tx   INTEGER,
  month_rx   INTEGER,
  month_tx   INTEGER,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS snapshots (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  today_rx   INTEGER,
  today_tx   INTEGER,
  month_rx   INTEGER,
  month_tx   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_snap_mid_ts ON snapshots(machine_id, ts);
