import express from 'express';
import crypto from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { db, getSettings, saveSettings, ICON_KEYS, mediaDir } from './db.js';
import { mailStatus, sendMail, sendAccountInvite, notifyNewBooking, notifyStatus } from './mail.js';

const PORT = Number(process.env.PORT) || 3000;
const TIMEZONE = process.env.TIMEZONE || 'Europe/Bratislava';
const SESSION_MS = 12 * 3600e3;
const STATUSES = ['new', 'confirmed', 'done', 'cancelled'];
// rola „solver“ sa v rozhraní volá Terapeut
const ROLES = ['admin', 'solver'];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (message) => new HttpError(400, message);

// ---------- heslá ----------

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

function verifyPassword(password, stored) {
  const [, salt, key] = stored.split('$');
  const expected = Buffer.from(key, 'base64url');
  return crypto.timingSafeEqual(crypto.scryptSync(password, Buffer.from(salt, 'base64url'), expected.length), expected);
}

// pri neznámom mene sa overuje voči tomuto hashu, aby odpoveď trvala rovnako dlho
const DUMMY_HASH = hashPassword(crypto.randomBytes(9).toString('base64url'));

// Prvý účet: admin s heslom z ADMIN_PASSWORD (ďalšie účty sa zakladajú v administrácii)
if (!db.prepare('SELECT 1 FROM users').get()) {
  let password = process.env.ADMIN_PASSWORD;
  if (!password) {
    password = crypto.randomBytes(9).toString('base64url');
    console.warn(`ADMIN_PASSWORD nie je nastavené – dočasné heslo pre účet „admin“: ${password}`);
  }
  db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('admin', ?, 'admin')").run(hashPassword(password));
  console.log('Vytvorený účet „admin“ (heslo z ADMIN_PASSWORD).');
}

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
const ids = (v) => (Array.isArray(v) ? [...new Set(v.map(Number).filter(Number.isInteger))] : []);

function localNow() {
  const s = new Intl.DateTimeFormat('sv-SE', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date());
  const [date, time] = s.split(' ');
  return { date, min: toMin(time) };
}

// ---------- voľné termíny ----------

const overlaps = (ranges, start, end) => ranges.some(([s, e]) => start < e && s < end);

// column je vždy pevný názov stĺpca z kódu, nikdy vstup od používateľa
const busy = (date, column, id) => db
  .prepare(`SELECT time, end_time FROM bookings WHERE date = ? AND ${column} = ? AND status != 'cancelled'`)
  .all(date, id)
  .map((b) => [toMin(b.time), toMin(b.end_time)]);

const procedureMembers = (procedureId) => db.prepare(`
  SELECT m.id FROM procedure_members pm JOIN team_members m ON m.id = pm.member_id
  WHERE pm.procedure_id = ? AND m.active = 1 ORDER BY m.sort, m.name
`).all(procedureId).map((r) => r.id);

// Vráti mapu voľný čas → členovia tímu, ktorí vtedy môžu procedúru robiť.
// Termín je voľný, ak je voľná miestnosť procedúry a aspoň jeden jej terapeut
// (procedúra bez priradených terapeutov sa riadi len miestnosťou).
function availability(date, proc, memberId) {
  const result = new Map();
  if (!isDate(date)) return result;
  const settings = getSettings();
  const now = localNow();
  if (date < now.date || date > addDays(now.date, settings.max_days_ahead)) return result;
  if (settings.blocked_dates.includes(date)) return result;

  const hours = settings.hours[new Date(date + 'T00:00:00Z').getUTCDay()];
  if (!hours) return result;

  let members = procedureMembers(proc.id);
  if (memberId) {
    if (!members.includes(memberId)) return result;
    members = [memberId];
  }
  const roomBusy = proc.room_id ? busy(date, 'room_id', proc.room_id) : [];
  const memberBusy = members.map((id) => [id, busy(date, 'member_id', id)]);

  for (let t = toMin(hours[0]); t + proc.duration_min <= toMin(hours[1]); t += settings.slot_step) {
    if (date === now.date && t <= now.min) continue;
    const end = t + proc.duration_min;
    if (overlaps(roomBusy, t, end)) continue;
    const free = memberBusy.filter(([, ranges]) => !overlaps(ranges, t, end)).map(([id]) => id);
    if (members.length && !free.length) continue;
    result.set(toTime(t), free);
  }
  return result;
}

// prekrytie rezervácie s inou v rovnakej miestnosti alebo u rovnakého terapeuta
function hasClash(b, memberId) {
  const check = (column, id) => id != null && db.prepare(`
    SELECT 1 FROM bookings WHERE date = ? AND id != ? AND status != 'cancelled' AND ${column} = ? AND time < ? AND end_time > ?
  `).get(b.date, b.id, id, b.end_time, b.time);
  return !!(check('room_id', b.room_id) || check('member_id', memberId));
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
// fotky členov tímu idú ako data URL, preto väčší limit len pre túto cestu
app.use('/api/admin/team', express.json({ limit: '2mb' }));
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(import.meta.dirname, 'public')));
// názvy súborov sú náhodné, obsah sa pod rovnakým menom nemení
app.use('/media', express.static(mediaDir, { maxAge: '365d', immutable: true }));

// ---------- verejné API ----------

app.get('/api/info', (req, res) => {
  const { hours, blocked_dates, max_days_ahead, contact_phone, address } = getSettings();
  res.json({ hours, blocked_dates, max_days_ahead, contact_phone, address, today: localNow().date });
});

app.get('/api/procedures', (req, res) => {
  res.json(
    db.prepare('SELECT id, name, description, duration_min, price, icon FROM procedures WHERE active = 1 ORDER BY sort, name').all()
  );
});

app.get('/api/team', (req, res) => {
  const links = db.prepare('SELECT procedure_id, member_id FROM procedure_members').all();
  res.json(
    db.prepare('SELECT id, name, title, photo FROM team_members WHERE active = 1 ORDER BY sort, name').all().map((m) => ({
      ...m,
      photo: m.photo ? `/media/${m.photo}` : '',
      procedures: links.filter((l) => l.member_id === m.id).map((l) => l.procedure_id),
    }))
  );
});

app.get('/api/slots', (req, res) => {
  const proc = db.prepare('SELECT id, duration_min, room_id FROM procedures WHERE id = ? AND active = 1').get(Number(req.query.procedure));
  if (!proc) throw bad('Neznáma procedúra.');
  res.json([...availability(req.query.date, proc, Number(req.query.member) || null).keys()]);
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
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Zadajte platný e-mail.');
  if (phone && !/^\+?[\d\s/-]{6,}$/.test(phone)) throw bad('Zadajte platné telefónne číslo.');

  // node:sqlite je synchrónne, takže kontrola a zápis prebehnú bez súbehu s inou rezerváciou
  const free = availability(b.date, proc, Number(b.member_id) || null).get(b.time);
  if (!free) throw new HttpError(409, 'Tento termín už nie je voľný, vyberte prosím iný.');

  // pri „ktokoľvek“ dostane rezerváciu terapeut s najmenej termínmi v daný deň
  const load = db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE date = ? AND member_id = ? AND status != 'cancelled'");
  const memberId = free.length
    ? free.map((id) => [id, load.get(b.date, id).n]).sort((x, y) => x[1] - y[1])[0][0]
    : null;
  const memberName = memberId ? db.prepare('SELECT name FROM team_members WHERE id = ?').get(memberId).name : '';

  const result = db.prepare(`
    INSERT INTO bookings (procedure_id, procedure_name, duration_min, price, date, time, end_time, name, phone, email, note,
                          room_id, member_id, member_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    proc.id, proc.name, proc.duration_min, proc.price, b.date, b.time,
    toTime(toMin(b.time) + proc.duration_min), name, phone, email, note,
    proc.room_id, memberId, memberName
  );
  const id = Number(result.lastInsertRowid);
  notifyNewBooking(db.prepare('SELECT * FROM bookings WHERE id = ?').get(id));
  res.status(201).json({ id, member_name: memberName });
});

// ---------- prihlásenie ----------

const sessions = new Map();
const sessionToken = (req) => /(?:^|;\s*)sid=([\w-]+)/.exec(req.headers.cookie || '')?.[1];
const endSessions = (userId) => {
  for (const [token, s] of sessions) if (s.userId === userId) sessions.delete(token);
};

app.post('/api/admin/login', rateLimit(10, 15 * 60e3), (req, res) => {
  const user = db.prepare('SELECT id, password_hash FROM users WHERE username = ?').get(str(req.body?.username, 64));
  const ok = verifyPassword(String(req.body?.password ?? ''), user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok) throw new HttpError(401, 'Nesprávne meno alebo heslo.');
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { userId: user.id, expires: Date.now() + SESSION_MS });
  res.cookie('sid', token, { httpOnly: true, sameSite: 'strict', secure: req.secure, maxAge: SESSION_MS, path: '/' });
  res.json({ ok: true });
});

// ---------- nastavenie hesla cez odkaz z e-mailu ----------

const INVITE_MS = 3 * 24 * 3600e3;
const tokenHash = (token) => crypto.createHash('sha256').update(token).digest('hex');
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

// adresa pre odkaz v e-maile: nastavená adresa webu, inak adresa, na ktorej beží administrácia
const baseUrl = (req) => getSettings().site_url || `${req.protocol}://${req.get('host')}`;

async function sendInvite(req, userId, isNew) {
  const user = db.prepare(`
    SELECT u.id, u.username, u.role, u.email, m.name AS member_name FROM users u LEFT JOIN team_members m ON m.id = u.member_id WHERE u.id = ?
  `).get(userId);
  if (!user?.email) throw bad('Používateľ nemá zadaný e-mail.');
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('DELETE FROM password_tokens WHERE user_id = ? OR expires_at < ?').run(user.id, Date.now());
  db.prepare('INSERT INTO password_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(tokenHash(token), user.id, Date.now() + INVITE_MS);
  // token je za # – prehliadač ho neposiela na server ani v hlavičke Referer
  await sendAccountInvite(user, `${baseUrl(req)}/admin/#heslo=${token}`, isNew);
}

app.post('/api/admin/password-reset', rateLimit(10, 15 * 60e3), (req, res) => {
  const { token, password } = req.body ?? {};
  const row = typeof token === 'string' &&
    db.prepare('SELECT user_id FROM password_tokens WHERE token_hash = ? AND expires_at > ?').get(tokenHash(token), Date.now());
  if (!row) throw bad('Odkaz je neplatný alebo vypršal. Požiadajte admina o nový.');
  if (typeof password !== 'string' || password.length < 8) throw bad('Heslo musí mať aspoň 8 znakov.');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), row.user_id);
  db.prepare('DELETE FROM password_tokens WHERE user_id = ?').run(row.user_id);
  endSessions(row.user_id);
  const { username } = db.prepare('SELECT username FROM users WHERE id = ?').get(row.user_id);
  res.json({ username });
});

app.use('/api/admin', (req, res, next) => {
  const token = sessionToken(req);
  const session = token && sessions.get(token);
  const user = session && session.expires > Date.now() && db.prepare(`
    SELECT u.id, u.username, u.role, u.member_id, m.name AS member_name
    FROM users u LEFT JOIN team_members m ON m.id = u.member_id WHERE u.id = ?
  `).get(session.userId);
  if (!user) {
    if (token) sessions.delete(token);
    throw new HttpError(401, 'Neprihlásený.');
  }
  req.user = user;
  next();
});

const isAdmin = (req) => req.user.role === 'admin';
app.use(
  ['/api/admin/procedures', '/api/admin/rooms', '/api/admin/team', '/api/admin/users', '/api/admin/settings', '/api/admin/mail'],
  (req, res, next) => {
    if (!isAdmin(req)) throw new HttpError(403, 'Na túto akciu nemáte oprávnenie.');
    next();
  }
);

app.get('/api/admin/me', (req, res) => res.json(req.user));

app.post('/api/admin/logout', (req, res) => {
  sessions.delete(sessionToken(req));
  res.clearCookie('sid', { path: '/' });
  res.json({ ok: true });
});

app.put('/api/admin/me/password', (req, res) => {
  const { current, password } = req.body ?? {};
  const { password_hash } = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(String(current ?? ''), password_hash)) throw bad('Súčasné heslo nie je správne.');
  if (typeof password !== 'string' || password.length < 8) throw bad('Nové heslo musí mať aspoň 8 znakov.');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), req.user.id);
  res.json({ ok: true });
});

// ---------- rezervácie (terapeut vidí len svoje) ----------

// podmienka, ktorá obmedzí rezervácie na prihláseného terapeuta
const ownScope = (req) => (isAdmin(req) ? ['1 = 1', []] : ['b.member_id = ?', [req.user.member_id ?? -1]]);

app.get('/api/admin/stats', (req, res) => {
  const today = localNow().date;
  const [scope, scopeParams] = ownScope(req);
  const count = (sql, ...params) =>
    db.prepare(`SELECT COUNT(*) AS n FROM bookings b WHERE ${scope} AND ${sql}`).get(...scopeParams, ...params).n;
  res.json({
    today: count("date = ? AND status != 'cancelled'", today),
    upcoming: count("date >= ? AND status IN ('new', 'confirmed')", today),
    pending: count("date >= ? AND status = 'new'", today),
  });
});

app.get('/api/admin/bookings', (req, res) => {
  const today = localNow().date;
  const [scope, scopeParams] = ownScope(req);
  const where = [scope];
  const params = [...scopeParams];
  switch (req.query.range) {
    case 'today': where.push('b.date = ?'); params.push(today); break;
    case 'past': where.push('b.date < ?'); params.push(today); break;
    case 'all': break;
    default: where.push('b.date >= ?'); params.push(today);
  }
  if (STATUSES.includes(req.query.status)) {
    where.push('b.status = ?');
    params.push(req.query.status);
  }
  if (isAdmin(req) && req.query.member) {
    if (req.query.member === 'none') where.push('b.member_id IS NULL');
    else { where.push('b.member_id = ?'); params.push(Number(req.query.member)); }
  }
  const order = req.query.range === 'past' ? 'DESC' : 'ASC';
  res.json(
    db.prepare(`
      SELECT b.*, r.name AS room_name FROM bookings b LEFT JOIN rooms r ON r.id = b.room_id
      WHERE ${where.join(' AND ')}
      ORDER BY b.date ${order}, b.time ${order} LIMIT 500
    `).all(...params)
  );
});

app.patch('/api/admin/bookings/:id', (req, res) => {
  const body = req.body ?? {};
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(Number(req.params.id));
  if (!booking || (!isAdmin(req) && booking.member_id !== req.user.member_id)) {
    throw new HttpError(404, 'Rezervácia neexistuje.');
  }

  if ('member_id' in body) {
    if (!isAdmin(req)) throw new HttpError(403, 'Preradiť rezerváciu môže len admin.');
    const member = body.member_id == null ? null : db.prepare('SELECT id, name FROM team_members WHERE id = ?').get(Number(body.member_id));
    if (body.member_id != null && !member) throw bad('Neznámy člen tímu.');
    if (member && booking.status !== 'cancelled' && hasClash(booking, member.id)) {
      throw new HttpError(409, `${member.name} má v tomto čase inú rezerváciu.`);
    }
    db.prepare('UPDATE bookings SET member_id = ?, member_name = ? WHERE id = ?').run(member?.id ?? null, member?.name ?? '', booking.id);
    return res.json({ ok: true });
  }

  const { status } = body;
  if (!STATUSES.includes(status)) throw bad('Neplatný stav.');
  // obnovenie zrušenej rezervácie nesmie prekryť iný termín
  if (booking.status === 'cancelled' && status !== 'cancelled' && hasClash(booking, booking.member_id)) {
    throw new HttpError(409, 'Termín je medzitým obsadený inou rezerváciou.');
  }
  db.prepare('UPDATE bookings SET status = ? WHERE id = ?').run(status, booking.id);
  if (booking.status !== status) notifyStatus(booking, status);
  res.json({ ok: true });
});

app.delete('/api/admin/bookings/:id', (req, res) => {
  if (!isAdmin(req)) throw new HttpError(403, 'Vymazať rezerváciu môže len admin.');
  db.prepare('DELETE FROM bookings WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ---------- procedúry a miestnosti (len admin) ----------

app.get('/api/admin/procedures', (req, res) => {
  const links = db.prepare(`
    SELECT pm.procedure_id, m.id, m.name FROM procedure_members pm JOIN team_members m ON m.id = pm.member_id ORDER BY m.sort, m.name
  `).all();
  res.json(
    db.prepare('SELECT p.*, r.name AS room_name FROM procedures p LEFT JOIN rooms r ON r.id = p.room_id ORDER BY p.sort, p.name')
      .all()
      .map((p) => ({ ...p, members: links.filter((l) => l.procedure_id === p.id).map(({ id, name }) => ({ id, name })) }))
  );
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
    room_id: Number(body.room_id),
  };
  if (!p.name) throw bad('Zadajte názov procedúry.');
  if (!(p.duration_min >= 5 && p.duration_min <= 480)) throw bad('Trvanie musí byť 5 – 480 minút.');
  if (!(p.price >= 0)) throw bad('Zadajte platnú cenu.');
  if (!db.prepare('SELECT 1 FROM rooms WHERE id = ?').get(p.room_id)) throw bad('Vyberte miestnosť.');
  return p;
}

app.post('/api/admin/procedures', (req, res) => {
  const p = procedureInput(req.body);
  const result = db.prepare(`
    INSERT INTO procedures (name, description, duration_min, price, icon, active, sort, room_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(p.name, p.description, p.duration_min, p.price, p.icon, p.active, p.sort, p.room_id);
  res.status(201).json({ id: Number(result.lastInsertRowid) });
});

app.put('/api/admin/procedures/:id', (req, res) => {
  const p = procedureInput(req.body);
  const result = db.prepare(`
    UPDATE procedures SET name = ?, description = ?, duration_min = ?, price = ?, icon = ?, active = ?, sort = ?, room_id = ? WHERE id = ?
  `).run(p.name, p.description, p.duration_min, p.price, p.icon, p.active, p.sort, p.room_id, Number(req.params.id));
  if (!result.changes) throw new HttpError(404, 'Procedúra neexistuje.');
  res.json({ ok: true });
});

app.delete('/api/admin/procedures/:id', (req, res) => {
  db.prepare('DELETE FROM procedures WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

app.get('/api/admin/rooms', (req, res) => {
  res.json(db.prepare(`
    SELECT r.id, r.name, (SELECT COUNT(*) FROM procedures p WHERE p.room_id = r.id) AS procedures FROM rooms r ORDER BY r.name
  `).all());
});

const roomName = (body) => {
  const name = str(body?.name, 60);
  if (!name) throw bad('Zadajte názov miestnosti.');
  return name;
};

app.post('/api/admin/rooms', (req, res) => {
  const result = db.prepare('INSERT INTO rooms (name) VALUES (?)').run(roomName(req.body));
  res.status(201).json({ id: Number(result.lastInsertRowid) });
});

app.put('/api/admin/rooms/:id', (req, res) => {
  if (!db.prepare('UPDATE rooms SET name = ? WHERE id = ?').run(roomName(req.body), Number(req.params.id)).changes) {
    throw new HttpError(404, 'Miestnosť neexistuje.');
  }
  res.json({ ok: true });
});

app.delete('/api/admin/rooms/:id', (req, res) => {
  if (db.prepare('SELECT 1 FROM procedures WHERE room_id = ?').get(Number(req.params.id))) {
    throw new HttpError(409, 'Miestnosť používajú procedúry – najprv im nastavte inú.');
  }
  db.prepare('DELETE FROM rooms WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ---------- tím (len admin) ----------

app.get('/api/admin/team', (req, res) => {
  const links = db.prepare('SELECT procedure_id, member_id FROM procedure_members').all();
  const logins = db.prepare('SELECT username, member_id FROM users WHERE member_id IS NOT NULL').all();
  res.json(
    db.prepare('SELECT * FROM team_members ORDER BY sort, name').all().map((m) => ({
      ...m,
      photo: m.photo ? `/media/${m.photo}` : '',
      procedures: links.filter((l) => l.member_id === m.id).map((l) => l.procedure_id),
      logins: logins.filter((u) => u.member_id === m.id).map((u) => u.username),
    }))
  );
});

// fotku orezáva a zmenšuje prehliadač, server prijme len JPEG
function savePhoto(dataUrl) {
  const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+=*)$/.exec(dataUrl);
  const buf = match && Buffer.from(match[1], 'base64');
  if (!buf || buf.length > 1.5e6 || buf[0] !== 0xff || buf[1] !== 0xd8) throw bad('Fotka musí byť obrázok JPEG do 1,5 MB.');
  const file = `team-${crypto.randomBytes(8).toString('hex')}.jpg`;
  writeFileSync(path.join(mediaDir, file), buf);
  return file;
}
const isNewPhoto = (v) => typeof v === 'string' && v.startsWith('data:');
const removePhoto = (file) => file && rmSync(path.join(mediaDir, file), { force: true });

function memberInput(body = {}) {
  const m = {
    name: str(body.name, 100),
    title: str(body.title, 100),
    active: body.active ? 1 : 0,
    sort: Math.round(Number(body.sort)) || 0,
    procedures: ids(body.procedures),
  };
  if (m.name.length < 2) throw bad('Zadajte meno.');
  return m;
}

function saveMember(id, m, photo) {
  db.exec('BEGIN');
  try {
    if (id) {
      db.prepare('UPDATE team_members SET name = ?, title = ?, active = ?, sort = ?, photo = ? WHERE id = ?')
        .run(m.name, m.title, m.active, m.sort, photo, id);
    } else {
      id = Number(db.prepare('INSERT INTO team_members (name, title, active, sort, photo) VALUES (?, ?, ?, ?, ?)')
        .run(m.name, m.title, m.active, m.sort, photo).lastInsertRowid);
    }
    db.prepare('DELETE FROM procedure_members WHERE member_id = ?').run(id);
    const link = db.prepare('INSERT INTO procedure_members (procedure_id, member_id) SELECT id, ? FROM procedures WHERE id = ?');
    for (const procedureId of m.procedures) link.run(id, procedureId);
    db.exec('COMMIT');
    return id;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

app.post('/api/admin/team', (req, res) => {
  const m = memberInput(req.body);
  const photo = isNewPhoto(req.body.photo) ? savePhoto(req.body.photo) : '';
  res.status(201).json({ id: saveMember(null, m, photo) });
});

// photo: data URL = nová fotka, null = odstrániť, čokoľvek iné = ponechať
app.put('/api/admin/team/:id', (req, res) => {
  const current = db.prepare('SELECT * FROM team_members WHERE id = ?').get(Number(req.params.id));
  if (!current) throw new HttpError(404, 'Člen tímu neexistuje.');
  const m = memberInput(req.body);
  let photo = current.photo;
  if (isNewPhoto(req.body.photo)) photo = savePhoto(req.body.photo);
  else if (req.body.photo === null) photo = '';
  saveMember(current.id, m, photo);
  if (photo !== current.photo) removePhoto(current.photo);
  res.json({ ok: true });
});

app.delete('/api/admin/team/:id', (req, res) => {
  const member = db.prepare('SELECT * FROM team_members WHERE id = ?').get(Number(req.params.id));
  if (!member) return res.json({ ok: true });
  if (db.prepare("SELECT 1 FROM users WHERE member_id = ? AND role = 'solver'").get(member.id)) {
    throw new HttpError(409, 'Člen tímu má prihlasovací účet terapeuta – najprv ho vymažte v Používateľoch.');
  }
  db.prepare('DELETE FROM team_members WHERE id = ?').run(member.id);
  removePhoto(member.photo);
  res.json({ ok: true });
});

// ---------- používatelia (len admin) ----------

app.get('/api/admin/users', (req, res) => {
  res.json(db.prepare(`
    SELECT u.id, u.username, u.email, u.role, u.member_id, m.name AS member_name, u.created_at
    FROM users u LEFT JOIN team_members m ON m.id = u.member_id ORDER BY u.role, u.username
  `).all());
});

function userInput(body = {}, isNew) {
  const u = {
    username: str(body.username, 32),
    role: body.role,
    member_id: body.member_id ? Number(body.member_id) : null,
    email: str(body.email, 120),
    password: typeof body.password === 'string' ? body.password : '',
  };
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(u.username)) throw bad('Prihlasovacie meno: 3 – 32 znakov (písmená bez diakritiky, čísla, . _ -).');
  if (!ROLES.includes(u.role)) throw bad('Neplatná rola.');
  if (u.member_id && !db.prepare('SELECT 1 FROM team_members WHERE id = ?').get(u.member_id)) throw bad('Neznámy člen tímu.');
  if (u.role === 'solver' && !u.member_id) throw bad('Terapeut musí byť priradený k členovi tímu.');
  if (u.email && !isEmail(u.email)) throw bad('Zadajte platný e-mail.');
  if (isNew && !u.password && !u.email) throw bad('Zadajte heslo alebo e-mail, na ktorý príde odkaz na nastavenie hesla.');
  if (u.password && u.password.length < 8) throw bad('Heslo musí mať aspoň 8 znakov.');
  return u;
}

const usernameTaken = (username, exceptId = 0) =>
  !!db.prepare('SELECT 1 FROM users WHERE username = ? AND id != ?').get(username, exceptId);
const adminCount = () => db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;

// Účet s e-mailom dostane uvítací e-mail s odkazom na nastavenie hesla.
// Bez zadaného hesla sa dá prihlásiť až po jeho nastavení cez odkaz.
app.post('/api/admin/users', async (req, res) => {
  const u = userInput(req.body, true);
  if (usernameTaken(u.username)) throw new HttpError(409, 'Toto prihlasovacie meno už existuje.');
  const id = Number(db.prepare('INSERT INTO users (username, password_hash, role, member_id, email) VALUES (?, ?, ?, ?, ?)')
    .run(u.username, hashPassword(u.password || crypto.randomBytes(24).toString('base64url')), u.role, u.member_id, u.email)
    .lastInsertRowid);
  let mailError = null;
  if (u.email) {
    try {
      await sendInvite(req, id, true);
    } catch (err) {
      mailError = err.message;
    }
  }
  res.status(201).json({ id, mailed: !!u.email && !mailError, mailError });
});

app.post('/api/admin/users/:id/invite', async (req, res) => {
  try {
    await sendInvite(req, Number(req.params.id), false);
  } catch (err) {
    throw err instanceof HttpError ? err : bad(`E-mail sa nepodarilo odoslať: ${err.message}`);
  }
  res.json({ ok: true });
});

app.put('/api/admin/users/:id', (req, res) => {
  const current = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!current) throw new HttpError(404, 'Používateľ neexistuje.');
  const u = userInput(req.body, false);
  if (usernameTaken(u.username, current.id)) throw new HttpError(409, 'Toto prihlasovacie meno už existuje.');
  if (current.role === 'admin' && u.role !== 'admin' && adminCount() === 1) throw bad('Musí zostať aspoň jeden admin.');

  db.prepare('UPDATE users SET username = ?, role = ?, member_id = ?, email = ? WHERE id = ?')
    .run(u.username, u.role, u.member_id, u.email, current.id);
  if (u.password) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(u.password), current.id);
  // zmena hesla alebo roly odhlási používateľa na ostatných zariadeniach
  if ((u.password || u.role !== current.role) && current.id !== req.user.id) endSessions(current.id);
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) throw bad('Nemôžete vymazať vlastný účet.');
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  endSessions(id);
  res.json({ ok: true });
});

// ---------- nastavenia (len admin) ----------

app.get('/api/admin/settings', (req, res) => res.json(getSettings()));

app.get('/api/admin/mail', (req, res) => res.json(mailStatus));

app.post('/api/admin/mail/test', async (req, res) => {
  if (!mailStatus.adminEmail) throw bad('ADMIN_EMAIL nie je nastavené.');
  try {
    await sendMail(mailStatus.adminEmail, 'Testovací e-mail', 'Odosielanie e-mailov z rezervačného systému funguje.');
  } catch (err) {
    throw bad(`Odoslanie zlyhalo: ${err.message}`);
  }
  res.json({ ok: true });
});

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
  const contact_phone = str(body.contact_phone, 30);
  if (contact_phone && !/^\+?[\d\s/-]{6,}$/.test(contact_phone)) throw bad('Zadajte platné kontaktné telefónne číslo.');
  const site_url = str(body.site_url, 200).replace(/\/+$/, '');
  if (site_url && !/^https?:\/\/[^\s/]+\.[^\s]+$/.test(site_url)) throw bad('Adresa webu musí začínať https:// (napr. https://fyzio.pidiman.sk).');

  const address = str(body.address, 200).replace(/\s+/g, ' ');

  saveSettings({ hours, slot_step, max_days_ahead, blocked_dates, contact_phone, site_url, address });
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
