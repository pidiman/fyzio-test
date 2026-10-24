import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const dataDir = process.env.DATA_DIR || path.join(import.meta.dirname, 'data');
mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(dataDir, 'fyzio.db'));

export const ICON_KEYS = ['spine', 'sport', 'pulse', 'hand', 'bolt', 'child', 'heart', 'leaf'];

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS procedures (
    id           INTEGER PRIMARY KEY,
    name         TEXT    NOT NULL,
    description  TEXT    NOT NULL DEFAULT '',
    duration_min INTEGER NOT NULL,
    price        REAL    NOT NULL,
    icon         TEXT    NOT NULL DEFAULT 'hand',
    active       INTEGER NOT NULL DEFAULT 1,
    sort         INTEGER NOT NULL DEFAULT 0
  );

  -- názov, trvanie a cena procedúry sa kopírujú, aby rezervácia ostala správna aj po úprave cenníka
  CREATE TABLE IF NOT EXISTS bookings (
    id             INTEGER PRIMARY KEY,
    procedure_id   INTEGER REFERENCES procedures(id) ON DELETE SET NULL,
    procedure_name TEXT    NOT NULL,
    duration_min   INTEGER NOT NULL,
    price          REAL    NOT NULL,
    date           TEXT    NOT NULL,
    time           TEXT    NOT NULL,
    end_time       TEXT    NOT NULL,
    name           TEXT    NOT NULL,
    phone          TEXT    NOT NULL,
    email          TEXT    NOT NULL DEFAULT '',
    note           TEXT    NOT NULL DEFAULT '',
    status         TEXT    NOT NULL DEFAULT 'new',
    created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS bookings_date ON bookings(date, time);

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// kľúče hodín: 0 = nedeľa … 6 = sobota, null = zatvorené
const DEFAULT_SETTINGS = {
  hours: {
    0: null,
    1: ['07:00', '20:00'],
    2: ['07:00', '20:00'],
    3: ['07:00', '20:00'],
    4: ['07:00', '20:00'],
    5: ['07:00', '20:00'],
    6: ['08:00', '13:00'],
  },
  slot_step: 30,
  max_days_ahead: 60,
  blocked_dates: [],
};

const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(key, JSON.stringify(value));

if (db.prepare('SELECT COUNT(*) AS n FROM procedures').get().n === 0) {
  const insert = db.prepare(
    'INSERT INTO procedures (name, description, duration_min, price, icon, sort) VALUES (?, ?, ?, ?, ?, ?)'
  );
  [
    ['Vstupné vyšetrenie', 'Kineziologický rozbor, diagnostika pohybového aparátu a návrh terapie.', 60, 45, 'pulse'],
    ['Terapia chrbtice', 'Krčná, hrudná aj drieková chrbtica, hernie disku a blokády.', 50, 45, 'spine'],
    ['Športová rehabilitácia', 'Bezpečný návrat k výkonu po zraneniach väzov, svalov a šliach.', 50, 50, 'sport'],
    ['Manuálna terapia', 'Mäkké techniky, mobilizácie a uvoľnenie spúšťových bodov.', 30, 30, 'hand'],
    ['Rázová vlna', 'Pätová ostroha, tenisový lakeť, kalcifikáty a chronické bolesti šliach.', 20, 35, 'bolt'],
    ['Detská fyzioterapia', 'Vojtova metóda, skolióza a správne držanie tela u detí.', 45, 40, 'child'],
  ].forEach((p, i) => insert.run(...p, i));
}

export function getSettings() {
  const settings = {};
  for (const row of db.prepare('SELECT key, value FROM settings').all()) settings[row.key] = JSON.parse(row.value);
  return settings;
}

export function saveSettings(settings) {
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  db.exec('BEGIN');
  try {
    for (const [key, value] of Object.entries(settings)) upsert.run(key, JSON.stringify(value));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
