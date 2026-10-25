import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export const dataDir = process.env.DATA_DIR || path.join(import.meta.dirname, 'data');
export const mediaDir = path.join(dataDir, 'media');
mkdirSync(mediaDir, { recursive: true });

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

  -- procedúry v jednej miestnosti sa nesmú časovo prekrývať
  CREATE TABLE IF NOT EXISTS rooms (
    id   INTEGER PRIMARY KEY,
    name TEXT    NOT NULL
  );

  -- členovia tímu: zobrazujú sa na webe a majú vlastný kalendár rezervácií
  CREATE TABLE IF NOT EXISTS team_members (
    id     INTEGER PRIMARY KEY,
    name   TEXT    NOT NULL,
    title  TEXT    NOT NULL DEFAULT '',
    photo  TEXT    NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    sort   INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS procedure_members (
    procedure_id INTEGER NOT NULL REFERENCES procedures(id) ON DELETE CASCADE,
    member_id    INTEGER NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
    PRIMARY KEY (procedure_id, member_id)
  );

  -- role: admin vidí všetko, solver len rezervácie svojho člena tímu
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT    NOT NULL,
    role          TEXT    NOT NULL CHECK (role IN ('admin', 'solver')),
    member_id     INTEGER REFERENCES team_members(id) ON DELETE SET NULL,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

db.exec(`
  -- jednorazové odkazy na nastavenie hesla (ukladá sa len hash tokenu)
  CREATE TABLE IF NOT EXISTS password_tokens (
    token_hash TEXT    PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
`);

const hasColumn = (table, column) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
if (!hasColumn('users', 'email')) {
  db.exec("ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT ''");
}
if (!hasColumn('procedures', 'room_id')) {
  db.exec('ALTER TABLE procedures ADD COLUMN room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL');
}
if (!hasColumn('bookings', 'room_id')) {
  db.exec(`
    ALTER TABLE bookings ADD COLUMN room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL;
    ALTER TABLE bookings ADD COLUMN member_id INTEGER REFERENCES team_members(id) ON DELETE SET NULL;
    ALTER TABLE bookings ADD COLUMN member_name TEXT NOT NULL DEFAULT '';
    CREATE INDEX IF NOT EXISTS bookings_member ON bookings(member_id, date);
  `);
}

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
  // kontakt do e-mailov a na web; prvé hodnoty sa prevezmú z .env, potom sa menia v administrácii
  contact_phone: process.env.CONTACT_PHONE || '',
  site_url: process.env.SITE_URL || '',
  address: '',
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

// Prvé spustenie s miestnosťami: doterajšia prevádzka mala jeden spoločný kalendár,
// preto všetko dostane jednu miestnosť a správanie webu sa nezmení.
if (db.prepare('PRAGMA user_version').get().user_version < 1) {
  db.exec('BEGIN');
  try {
    const roomId = Number(db.prepare("INSERT INTO rooms (name) VALUES ('Miestnosť 1')").run().lastInsertRowid);
    db.prepare('UPDATE procedures SET room_id = ? WHERE room_id IS NULL').run(roomId);
    db.prepare('UPDATE bookings SET room_id = ? WHERE room_id IS NULL').run(roomId);
    if (db.prepare('SELECT COUNT(*) AS n FROM team_members').get().n === 0) {
      const insert = db.prepare('INSERT INTO team_members (name, title, sort) VALUES (?, ?, ?)');
      [
        ['Mgr. Peter Novák', 'Vedúci fyzioterapeut'],
        ['Mgr. Jana Kováčová', 'Športová fyzioterapia'],
        ['Bc. Martin Horák', 'Manuálna terapia'],
        ['Mgr. Lucia Malá', 'Detská fyzioterapia'],
      ].forEach((m, i) => insert.run(...m, i));
    }
    db.exec('PRAGMA user_version = 1');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
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
