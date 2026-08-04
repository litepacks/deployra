import fs from 'node:fs';
import path from 'node:path';
import Database, { type Database as SQLiteDatabase } from 'better-sqlite3';

let dbInstance: SQLiteDatabase | null = null;

export function getDatabasePath(): string {
  const customPath = process.env.DEPLOYRA_DB_PATH;
  if (customPath) {
    if (customPath === ':memory:') {
      return ':memory:';
    }
    return path.resolve(customPath);
  }
  const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';
  const dir = path.join(homeDir, '.deployra');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, 'deployra.db');
}

export function getDatabase(): SQLiteDatabase {
  if (dbInstance) {
    return dbInstance;
  }

  const dbPath = getDatabasePath();
  dbInstance = new Database(dbPath);
  dbInstance.pragma('journal_mode = WAL');

  initDatabaseSchema(dbInstance);
  return dbInstance;
}

export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

export function resetDatabase(): void {
  closeDatabase();
  getDatabase();
}

function initDatabaseSchema(db: SQLiteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      name TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      remote TEXT NOT NULL DEFAULT 'origin',
      branch TEXT NOT NULL DEFAULT 'main',
      last_seen_sha TEXT,
      last_successful_sha TEXT,
      config_json TEXT NOT NULL,
      config_hash TEXT,
      config_version INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS deployments (
      id TEXT PRIMARY KEY,
      project_name TEXT NOT NULL,
      previous_sha TEXT,
      target_sha TEXT NOT NULL,
      status TEXT NOT NULL,
      trigger_type TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      ready_check_json TEXT,
      error TEXT,
      FOREIGN KEY(project_name) REFERENCES projects(name) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS deployment_steps (
      id TEXT PRIMARY KEY,
      deployment_id TEXT NOT NULL,
      step_name TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      duration INTEGER,
      exit_code INTEGER,
      error TEXT,
      FOREIGN KEY(deployment_id) REFERENCES deployments(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS project_locks (
      project_name TEXT PRIMARY KEY,
      locked_by TEXT NOT NULL,
      locked_at INTEGER NOT NULL
    );
  `);

  try {
    db.exec(`ALTER TABLE projects ADD COLUMN config_hash TEXT;`);
  } catch {
    // Column already exists
  }

  try {
    db.exec(`ALTER TABLE projects ADD COLUMN config_version INTEGER NOT NULL DEFAULT 1;`);
  } catch {
    // Column already exists
  }
}
