import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { db, getSettings, saveSettings, ICON_KEYS } from './db.js';

const PORT = Number(process.env.PORT) || 3000;
const TIMEZONE = process.env.TIMEZONE || 'Europe/Bratislava';
const SESSION_MS = 12 * 3600e3;
const STATUSES = ['new', 'confirmed', 'done', 'cancelled'];

let adminPassword = process.env.ADMIN_PASSWORD;
if (!adminPassword) {
  adminPassword = crypto.randomBytes(9).toString('base64url');
  console.warn(`ADMIN_PASSWORD nie je nastavené – dočasné heslo do adminu: ${adminPassword}`);
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (message) => new HttpError(400, message);

// ---------- pomocné funkcie (dátumy a časy sú v lokálnom čase prevádzky) ----------

const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const toTime = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const isTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const isDate = (s) =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const addDays = (date, n) => {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function localNow() {
  const s = new Intl.DateTimeFormat('sv-SE', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date());
  const [date, time] = s.split(' ');
  return { date, min: toMin(time) };
}

function freeSlots(date, duration) {
  if (!isDate(date)) return [];
  const settings = getSettings();
  const now = localNow();
  if (date < now.date || date > addDays(now.date, settings.max_days_ahead)) return [];
  if (settings.blocked_dates.includes(date)) return [];

  const hours = settings.hours[new Date(date + 'T00:00:00Z').getUTCDay()];
  if (!hours) return [];

  const busy = db
    .prepare("SELECT time, end_time FROM bookings WHERE date = ? AND status != 'cancelled'")
    .all(date)
    .map((b) => [toMin(b.time), toMin(b.end_time)]);

  const slots = [];
  for (let t = toMin(hours[0]); t + duration <= toMin(hours[1]); t += settings.slot_step) {
    if (date === now.date && t <= now.min) continue;
    if (busy.some(([start, end]) => t < end && start < t + duration)) continue;
    slots.push(toTime(t));
  }
  return slots;
}

function rateLimit(max, windowMs) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const recent = (hits.get(req.ip) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) throw new HttpError(429, 'Príliš veľa pokusov, skúste to neskôr.');
    recent.push(now);
    hits.set(req.ip, recent);
    next();
  };
}

// ---------- aplikácia ----------

const app = express();
// Caddy beží v Docker sieti, takže okrem loopback dôverujeme aj privátnym adresám
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback, uniquelocal');
app.disable('x-powered-by');
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(import.meta.dirname, 'public')));

// ---------- verejné API ----------

app.get('/api/info', (req, res) => {
  const { hours, blocked_dates, max_days_ahead } = getSettings();
  res.json({ hours, blocked_dates, max_days_ahead, today: localNow().date });
});

app.get('/api/procedures', (req, res) => {
  res.json(
    db.prepare('SELECT id, name, description, duration_min, price, icon FROM procedures WHERE active = 1 ORDER BY sort, name').all()
  );
});

app.get('/api/slots', (req, res) => {
  const proc = db.prepare('SELECT duration_min FROM procedures WHERE id = ? AND active = 1').get(Number(req.query.procedure));
  if (!proc) throw bad('Neznáma procedúra.');
  res.json(freeSlots(req.query.date, proc.duration_min));
});

app.post('/api/bookings', rateLimit(10, 3600e3), (req, res) => {
  const b = req.body ?? {};
  const proc = db.prepare('SELECT * FROM procedures WHERE id = ? AND active = 1').get(Number(b.procedure_id));
  if (!proc) throw bad('Vyberte procedúru.');
  if (!isDate(b.date) || !isTime(b.time)) throw bad('Vyberte deň a čas.');

  const name = str(b.name, 100);
  const phone = str(b.phone, 30);
  const email = str(b.email, 120);
  const note = str(b.note, 1000);
  if (name.length < 3) throw bad('Zadajte meno a priezvisko.');
  if (!/^\+?[\d\s/-]{6,}$/.test(phone)) throw bad('Zadajte platné telefónne číslo.');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Zadajte platný e-mail.');

  // node:sqlite je synchrónne, takže kontrola a zápis prebehnú bez súbehu s inou rezerváciou
  if (!freeSlots(b.date, proc.duration_min).includes(b.time)) {
    throw new HttpError(409, 'Tento termín už nie je voľný, vyberte prosím iný.');
  }

  const result = db.prepare(`
    INSERT INTO bookings (procedure_id, procedure_name, duration_min, price, date, time, end_time, name, phone, email, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    proc.id, proc.name, proc.duration_min, proc.price, b.date, b.time,
    toTime(toMin(b.time) + proc.duration_min), name, phone, email, note
  );
  res.status(201).json({ id: Number(result.lastInsertRowid) });
});

// ---------- admin ----------

const sessions = new Map();
const sessionToken = (req) => /(?:^|;\s*)sid=([\w-]+)/.exec(req.headers.cookie || '')?.[1];
const sha = (s) => crypto.createHash('sha256').update(s).digest();

app.post('/api/admin/login', rateLimit(10, 15 * 60e3), (req, res) => {
  if (!crypto.timingSafeEqual(sha(String(req.body?.password ?? '')), sha(adminPassword))) {
    throw new HttpError(401, 'Nesprávne heslo.');
  }
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, Date.now() + SESSION_MS);
  res.cookie('sid', token, { httpOnly: true, sameSite: 'strict', secure: req.secure, maxAge: SESSION_MS, path: '/' });
  res.json({ ok: true });
});

app.use('/api/admin', (req, res, next) => {
  const token = sessionToken(req);
  const expires = token && sessions.get(token);
  if (!expires || expires < Date.now()) {
    if (token) sessions.delete(token);
    throw new HttpError(401, 'Neprihlásený.');
  }
  next();
});

app.get('/api/admin/me', (req, res) => res.json({ ok: true }));

app.post('/api/admin/logout', (req, res) => {
  sessions.delete(sessionToken(req));
  res.clearCookie('sid', { path: '/' });
  res.json({ ok: true });
});

app.get('/api/admin/stats', (req, res) => {
  const today = localNow().date;
  const count = (sql, ...params) => db.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE ${sql}`).get(...params).n;
  res.json({
    today: count("date = ? AND status != 'cancelled'", today),
    upcoming: count("date >= ? AND status IN ('new', 'confirmed')", today),
    pending: count("date >= ? AND status = 'new'", today),
  });
});

app.get('/api/admin/bookings', (req, res) => {
  const today = localNow().date;
  const where = [];
  const params = [];
  switch (req.query.range) {
    case 'today': where.push('date = ?'); params.push(today); break;
    case 'past': where.push('date < ?'); params.push(today); break;
    case 'all': break;
    default: where.push('date >= ?'); params.push(today);
  }
  if (STATUSES.includes(req.query.status)) {
    where.push('status = ?');
    params.push(req.query.status);
  }
  const order = req.query.range === 'past' ? 'DESC' : 'ASC';
  res.json(
    db.prepare(`
      SELECT * FROM bookings ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY date ${order}, time ${order} LIMIT 500
    `).all(...params)
  );
});

app.patch('/api/admin/bookings/:id', (req, res) => {
  const { status } = req.body ?? {};
  if (!STATUSES.includes(status)) throw bad('Neplatný stav.');
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(Number(req.params.id));
  if (!booking) throw new HttpError(404, 'Rezervácia neexistuje.');

  // obnovenie zrušenej rezervácie nesmie prekryť iný termín
  if (booking.status === 'cancelled' && status !== 'cancelled') {
    const clash = db.prepare(`
      SELECT 1 FROM bookings WHERE date = ? AND id != ? AND status != 'cancelled' AND time < ? AND end_time > ?
    `).get(booking.date, booking.id, booking.end_time, booking.time);
    if (clash) throw new HttpError(409, 'Termín je medzitým obsadený inou rezerváciou.');
  }
  db.prepare('UPDATE bookings SET status = ? WHERE id = ?').run(status, booking.id);
  res.json({ ok: true });
});

app.delete('/api/admin/bookings/:id', (req, res) => {
  db.prepare('DELETE FROM bookings WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

app.get('/api/admin/procedures', (req, res) => {
  res.json(db.prepare('SELECT * FROM procedures ORDER BY sort, name').all());
});

function procedureInput(body = {}) {
  const p = {
    name: str(body.name, 100),
    description: str(body.description, 500),
    duration_min: Math.round(Number(body.duration_min)),
    price: Math.round(Number(body.price) * 100) / 100,
    icon: ICON_KEYS.includes(body.icon) ? body.icon : 'hand',
    active: body.active ? 1 : 0,
    sort: Math.round(Number(body.sort)) || 0,
  };
  if (!p.name) throw bad('Zadajte názov procedúry.');
  if (!(p.duration_min >= 5 && p.duration_min <= 480)) throw bad('Trvanie musí byť 5 – 480 minút.');
  if (!(p.price >= 0)) throw bad('Zadajte platnú cenu.');
  return p;
}

app.post('/api/admin/procedures', (req, res) => {
  const p = procedureInput(req.body);
  const result = db.prepare(`
    INSERT INTO procedures (name, description, duration_min, price, icon, active, sort) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(p.name, p.description, p.duration_min, p.price, p.icon, p.active, p.sort);
  res.status(201).json({ id: Number(result.lastInsertRowid) });
});

app.put('/api/admin/procedures/:id', (req, res) => {
  const p = procedureInput(req.body);
  const result = db.prepare(`
    UPDATE procedures SET name = ?, description = ?, duration_min = ?, price = ?, icon = ?, active = ?, sort = ? WHERE id = ?
  `).run(p.name, p.description, p.duration_min, p.price, p.icon, p.active, p.sort, Number(req.params.id));
  if (!result.changes) throw new HttpError(404, 'Procedúra neexistuje.');
  res.json({ ok: true });
});

app.delete('/api/admin/procedures/:id', (req, res) => {
  db.prepare('DELETE FROM procedures WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

app.get('/api/admin/settings', (req, res) => res.json(getSettings()));

app.put('/api/admin/settings', (req, res) => {
  const body = req.body ?? {};
  const hours = {};
  for (let d = 0; d < 7; d++) {
    const h = body.hours?.[d];
    if (h == null) { hours[d] = null; continue; }
    if (!Array.isArray(h) || !isTime(h[0]) || !isTime(h[1]) || h[0] >= h[1]) throw bad('Skontrolujte otváracie hodiny.');
    hours[d] = [h[0], h[1]];
  }
  const slot_step = Number(body.slot_step);
  if (![10, 15, 20, 30, 45, 60].includes(slot_step)) throw bad('Neplatný krok termínov.');
  const max_days_ahead = Math.round(Number(body.max_days_ahead));
  if (!(max_days_ahead >= 1 && max_days_ahead <= 365)) throw bad('Rezervácie dopredu: 1 – 365 dní.');
  const blocked_dates = Array.isArray(body.blocked_dates) ? [...new Set(body.blocked_dates.filter(isDate))].sort() : [];

  saveSettings({ hours, slot_step, max_days_ahead, blocked_dates });
  res.json({ ok: true });
});

// ---------- chyby ----------

app.use('/api', (req, res) => res.status(404).json({ error: 'Nenájdené.' }));

app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.status && err.status < 500) return res.status(err.status).json({ error: 'Neplatná požiadavka.' });
  console.error(err);
  res.status(500).json({ error: 'Chyba servera.' });
});

app.listen(PORT, () => console.log(`Fyzio beží na http://localhost:${PORT}  (admin: /admin)`));
