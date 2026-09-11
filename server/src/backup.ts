import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { SCHEMA_VERSION } from "./db";
import { foldLedger, getEventState } from "./ledger";

export interface BackupInfo {
  name: string;
  label: string;
  bytes: number;
  created_at: number;
}

export interface BackupManager {
  dir: string | null;
  snapshot(label: string): BackupInfo;
  list(): BackupInfo[];
  path(name: string): string;
  restore(name: string): { pre_restore: BackupInfo; restored: BackupInfo };
  start(): void;
  stop(): void;
}

/** Tables that describe the event and its money. Accounts, sessions, and audit stay as they are. */
const RESTORED_TABLES = ["ledger", "held_donations", "active_card", "event_state", "milestone", "ask_tier", "fundraising_sync", "fundraising_receipt", "team_note"];
const AUTO_INTERVAL_MS = 5 * 60 * 1000;
const AUTO_KEEP = 96;
const NAME_PATTERN = /^givebar-([a-z-]+)-(\d{8}T\d{9})\.sqlite$/;

function describe(dir: string, name: string): BackupInfo | null {
  const match = NAME_PATTERN.exec(name);
  if (!match) return null;
  const s = match[2];
  const created = Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11), +s.slice(11, 13), +s.slice(13, 15), +s.slice(15, 18));
  return { name, label: match[1], bytes: statSync(join(dir, name)).size, created_at: created };
}

/**
 * Snapshots use `VACUUM INTO`, which reads through the WAL and writes a
 * complete, consistent database file while the server keeps running. Copying
 * `givebar.sqlite` by hand would miss every commit still sitting in the WAL.
 */
export function createBackupManager(db: Database, dbPath: string, backupDir?: string): BackupManager {
  const dir = backupDir ?? (dbPath === ":memory:" ? null : join(dirname(dbPath), "backups"));
  let timer: Timer | undefined;
  let lastFingerprint = "";

  const fingerprint = () => {
    const seq = db.query<{ seq: number | null }, []>(`SELECT MAX(seq) AS seq FROM ledger`).get()!.seq || 0;
    const state = db.query<{ settings_seq: number; updated_at: number }, []>(`SELECT settings_seq, updated_at FROM event_state WHERE id = 1`).get()!;
    const notes = db.query<{ id: number | null }, []>(`SELECT MAX(id) AS id FROM team_note`).get()!.id || 0;
    return `${seq}:${state.settings_seq}:${state.updated_at}:${notes}`;
  };

  const manager: BackupManager = {
    dir,
    path(name) {
      if (!dir || !NAME_PATTERN.test(name)) throw new Error("Unknown backup.");
      const full = join(dir, name);
      if (!existsSync(full)) throw new Error("Unknown backup.");
      return full;
    },
    snapshot(label) {
      if (!dir) throw new Error("Backups are unavailable for an in-memory database.");
      if (!/^[a-z-]+$/.test(label)) throw new Error("Backup label must be lowercase letters.");
      mkdirSync(dir, { recursive: true });
      const name = `givebar-${label}-${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 18)}.sqlite`;
      if (existsSync(join(dir, name))) throw new Error("A backup was taken this same millisecond; try again.");
      db.exec(`VACUUM INTO '${join(dir, name).replace(/'/g, "''")}'`);
      lastFingerprint = fingerprint();
      if (label === "auto") {
        const autos = manager.list().filter(info => info.label === "auto").sort((a, b) => b.created_at - a.created_at);
        for (const stale of autos.slice(AUTO_KEEP)) unlinkSync(join(dir, stale.name));
      }
      return describe(dir, name)!;
    },
    list() {
      if (!dir || !existsSync(dir)) return [];
      return readdirSync(dir).map(name => describe(dir, name)).filter((info): info is BackupInfo => info !== null).sort((a, b) => b.created_at - a.created_at);
    },
    restore(name) {
      const source = manager.path(name);
      const preRestore = manager.snapshot("pre-restore");
      db.exec(`ATTACH DATABASE '${source.replace(/'/g, "''")}' AS restore_src`);
      try {
        const version = db.query<{ user_version: number }, []>(`PRAGMA restore_src.user_version`).get()!.user_version;
        if (version !== SCHEMA_VERSION) throw new Error(`That backup uses schema version ${version}; this server needs ${SCHEMA_VERSION}.`);
        const current = getEventState(db);
        db.transaction(() => {
          for (const table of RESTORED_TABLES) {
            db.exec(`DELETE FROM main.${table}`);
            db.exec(`INSERT INTO main.${table} SELECT * FROM restore_src.${table}`);
          }
          // The room screens must re-sync to the restored figures rather than ratchet from the old ones.
          const restoredTotal = foldLedger(db).total_raised_cents;
          db.query(`UPDATE event_state SET stage_reset_seq = ?, odometer_floor_cents = ?, settings_seq = ?, updated_at = ? WHERE id = 1`)
            .run(current.stage_reset_seq + 1, restoredTotal, current.settings_seq + 1, Date.now());
        })();
      } finally {
        db.exec(`DETACH DATABASE restore_src`);
      }
      lastFingerprint = "";
      return { pre_restore: preRestore, restored: describe(dir!, name)! };
    },
    start() {
      if (!dir || timer) return;
      const tick = () => {
        try {
          if (fingerprint() !== lastFingerprint) manager.snapshot("auto");
        } catch (error) {
          console.error("[Givebar] Automatic backup failed:", error);
        }
      };
      tick();
      timer = setInterval(tick, AUTO_INTERVAL_MS);
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
    }
  };
  return manager;
}
