import pg from 'pg';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

// dáta mimo databázy (fotky tímu)
export const dataDir = process.env.DATA_DIR || path.join(import.meta.dirname, 'data');
export const mediaDir = path.join(dataDir, 'media');
mkdirSync(mediaDir, { recursive: true });

export const ICON_KEYS = ['spine', 'sport', 'pulse', 'hand', 'bolt', 'child', 'heart', 'leaf'];

// Pripojenie: DATABASE_URL, inak štandardné premenné PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL || undefined, max: 10 });
pool.on('error', (err) => console.error('Postgres:', err.message));

// SQL v kóde používa ? ako zástupný znak, pre Postgres sa prepíše na $1, $2, …
const toPg = (sql) => {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
};

function wrap(conn) {
  const query = (sql, params) => conn.query(toPg(sql), params);
  return {
    all: async (sql, ...params) => (await query(sql, params)).rows,
    get: async (sql, ...params) => (await query(sql, params)).rows[0],
    // changes = počet zmenených riadkov, id = z INSERT … RETURNING id
    run: async (sql, ...params) => {
      const r = await query(sql, params);
      return { changes: r.rowCount, id: r.rows[0]?.id };
    },
    // viac príkazov naraz, bez parametrov
    exec: (sql) => conn.query(sql),
  };
}

export const db = {
  ...wrap(pool),
  close: () => pool.end(),
  // transakcia: všetky dotazy vo fn idú cez jedno spojenie
  async tx(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(wrap(client));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  },
};

// kontajner s databázou môže pri štarte ešte len nabiehať
for (let attempt = 1; ; attempt++) {
  try {
    await pool.query('SELECT 1');
    break;
  } catch (err) {
    if (attempt === 30) throw err;
    console.warn(`Čakám na Postgres (${err.message})…`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// ---------- nastavenia (v pamäti, aby ich e-maily mohli čítať synchrónne) ----------

let settings = {};

// volá server pri štarte; tabuľky musí najprv vytvoriť migrácia (migrate.js)
export async function loadSettings() {
  try {
    for (const row of await db.all('SELECT key, value FROM settings')) settings[row.key] = JSON.parse(row.value);
  } catch (err) {
    if (err.code === '42P01') throw new Error('Databáza nemá tabuľky – najprv spustite migráciu (npm run migrate).');
    throw err;
  }
}

export const getSettings = () => settings;

export async function saveSettings(values) {
  await db.tx(async (t) => {
    for (const [key, value] of Object.entries(values)) {
      await t.run(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
        key, JSON.stringify(value)
      );
    }
  });
  settings = { ...settings, ...values };
}
