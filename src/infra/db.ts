import Database from "better-sqlite3";

export function initDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS watchlists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      filters_json TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      message_template TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS processed_events (
      event_id TEXT NOT NULL,
      watchlist_id TEXT NOT NULL,
      event_timestamp INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      ai_output_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (event_id, watchlist_id),
      FOREIGN KEY (watchlist_id) REFERENCES watchlists(id)
    );

    CREATE TABLE IF NOT EXISTS insights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      watchlist_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      event_pubkey TEXT NOT NULL,
      event_created_at INTEGER NOT NULL,
      content TEXT NOT NULL,
      message TEXT,
      actionable_link TEXT,
      recommended_actions_json TEXT,
      match_score REAL,
      ai_decision_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (watchlist_id) REFERENCES watchlists(id)
    );

    CREATE INDEX IF NOT EXISTS idx_insights_watchlist_created
      ON insights (watchlist_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_processed_events_watchlist_created
      ON processed_events (watchlist_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // migration: add message_template column if it doesn't exist yet
  try {
    db.exec(`ALTER TABLE watchlists ADD COLUMN message_template TEXT;`);
  } catch {
    // column already exists
  }

  return db;
}
