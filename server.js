import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { db, loadSettings, getSettings, saveSettings, ICON_KEYS } from './db.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { toMin, toTime, isTime, isDate, freeSlots } from './slots.js';
import {
  mailStatus, sendMail, sendAccountInvite, notifyPasswordSet, notifyNewBooking, notifyStatus, notifyTherapist,
  notifyClientVerify, notifyClientCancelled, notifyClientPasswordReset,
} from './mail.js';
import { smsConfigured, sendSms, smsCredit, smsDelivery, toIntl, plain, confirmedText } from './sms.js';

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

await loadSettings();

// ---------- heslá ----------

// pri neznámom mene sa overuje voči tomuto hashu, aby odpoveď trvala rovnako dlho
const DUMMY_HASH = hashPassword(crypto.randomBytes(9).toString('base64url'));

// ---------- pomocné funkcie (dátumy a časy sú v lokálnom čase prevádzky) ----------

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
// id zo vstupu; neplatné číslo (aj mimo rozsahu integer v Postgrese) = -1, teda nič sa nenájde
const num = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && Math.abs(n) < 2 ** 31 ? n : -1;
};
const ids = (v) => (Array.isArray(v) ? [...new Set(v.map(num).filter((n) => n > 0))] : []);

function localNow() {
  const s = new Intl.DateTimeFormat('sv-SE', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date());
  const [date, time] = s.split(' ');
  return { date, min: toMin(time) };
}

// Zmeny rezervácií (kontrola voľného termínu a zápis) prebiehajú jedna po druhej,
// aby dve súbežné požiadavky nedostali ten istý termín. Aplikácia beží v jednej inštancii.
let bookingQueue = Promise.resolve();
function serialized(fn) {
  const run = bookingQueue.then(fn, fn);
  bookingQueue = run.catch(() => {});
  return run;
}

// ---------- voľné termíny ----------

// column je vždy pevný názov stĺpca z kódu, nikdy vstup od používateľa
const busy = async (date, column, id) =>
  (await db.all(`SELECT time, end_time FROM bookings WHERE date = ? AND ${column} = ? AND status != 'cancelled'`, date, id))
    .map((b) => [toMin(b.time), toMin(b.end_time)]);

const procedureMembers = async (procedureId) => (await db.all(`
  SELECT m.id FROM procedure_members pm JOIN team_members m ON m.id = pm.member_id
  WHERE pm.procedure_id = ? AND m.active = 1 ORDER BY m.sort, m.name
`, procedureId)).map((r) => r.id);

// voľné termíny procedúry v daný deň (pozri freeSlots), memberId obmedzí výber na jedného terapeuta
async function availability(date, proc, memberId) {
  if (!isDate(date)) return new Map();
  let members = await procedureMembers(proc.id);
  if (memberId) {
    if (!members.includes(memberId)) return new Map();
    members = [memberId];
  }
  return freeSlots({
    date,
    now: localNow(),
    settings: getSettings(),
    duration: proc.duration_min,
    roomBusy: proc.room_id ? await busy(date, 'room_id', proc.room_id) : [],
    memberBusy: await Promise.all(members.map(async (id) => [id, await busy(date, 'member_id', id)])),
  });
}

// prekrytie rezervácie s inou v rovnakej miestnosti alebo u rovnakého terapeuta
async function hasClash(b, memberId) {
  const check = (column, id) => id != null && db.get(`
    SELECT 1 FROM bookings WHERE date = ? AND id != ? AND status != 'cancelled' AND ${column} = ? AND time < ? AND end_time > ?
  `, b.date, b.id, id, b.end_time, b.time);
  return !!((await check('room_id', b.room_id)) || (await check('member_id', memberId)));
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
app.use(['/api/admin/team', '/api/admin/me/profile'], express.json({ limit: '2mb' }));
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(import.meta.dirname, 'public')));
// fotky sú v databáze; názvy sú náhodné, obsah sa pod rovnakým menom nemení
app.get('/media/:name', async (req, res) => {
  const row = await db.get('SELECT data FROM media WHERE name = ?', req.params.name);
  if (!row) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=31536000, immutable').type('jpeg').send(row.data);
});

// ---------- verejné API ----------

app.get('/api/info', (req, res) => {
  const { hours, blocked_dates, max_days_ahead, contact_phone, address } = getSettings();
  res.json({ hours, blocked_dates, max_days_ahead, contact_phone, address, today: localNow().date });
});

app.get('/api/procedures', async (req, res) => {
  res.json(
    await db.all('SELECT id, name, description, duration_min, price, icon FROM procedures WHERE active = 1 ORDER BY sort, name')
  );
});

app.get('/api/team', async (req, res) => {
  const links = await db.all('SELECT procedure_id, member_id FROM procedure_members');
  res.json(
    (await db.all('SELECT id, name, title, photo, bio FROM team_members WHERE active = 1 ORDER BY sort, name')).map((m) => ({
      ...m,
      photo: m.photo ? `/media/${m.photo}` : '',
      procedures: links.filter((l) => l.member_id === m.id).map((l) => l.procedure_id),
    }))
  );
});

app.get('/api/slots', async (req, res) => {
  const proc = await db.get('SELECT id, duration_min, room_id FROM procedures WHERE id = ? AND active = 1', num(req.query.procedure));
  if (!proc) throw bad('Neznáma procedúra.');
  res.json([...(await availability(req.query.date, proc, Number(req.query.member) || null)).keys()]);
});

app.post('/api/bookings', rateLimit(10, 3600e3), async (req, res) => {
  const b = req.body ?? {};
  const proc = await db.get('SELECT * FROM procedures WHERE id = ? AND active = 1', num(b.procedure_id));
  if (!proc) throw bad('Vyberte procedúru.');
  if (!isDate(b.date) || !isTime(b.time)) throw bad('Vyberte deň a čas.');

  const name = str(b.name, 100);
  const phone = str(b.phone, 30);
  const email = str(b.email, 120);
  const note = str(b.note, 1000);
  if (name.length < 3) throw bad('Zadajte meno a priezvisko.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Zadajte platný e-mail.');
  if (phone && !/^\+?[\d\s/-]{6,}$/.test(phone)) throw bad('Zadajte platné telefónne číslo.');
  const clientId = (await currentClient(req))?.id ?? null;

  const booking = await serialized(async () => {
    const free = (await availability(b.date, proc, Number(b.member_id) || null)).get(b.time);
    if (!free) throw new HttpError(409, 'Tento termín už nie je voľný, vyberte prosím iný.');

    // pri „ktokoľvek“ dostane rezerváciu terapeut s najmenej termínmi v daný deň
    const load = await Promise.all(free.map(async (id) => [id, (await db.get(
      "SELECT COUNT(*)::int AS n FROM bookings WHERE date = ? AND member_id = ? AND status != 'cancelled'", b.date, id
    )).n]));
    const memberId = load.length ? load.sort((x, y) => x[1] - y[1])[0][0] : null;
    const memberName = memberId ? (await db.get('SELECT name FROM team_members WHERE id = ?', memberId)).name : '';

    return db.get(`
      INSERT INTO bookings (procedure_id, procedure_name, duration_min, price, date, time, end_time, name, phone, email, note,
                            room_id, member_id, member_name, client_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
    `,
    proc.id, proc.name, proc.duration_min, proc.price, b.date, b.time,
    toTime(toMin(b.time) + proc.duration_min), name, phone, email, note,
    proc.room_id, memberId, memberName, clientId);
  });
  const room = booking.room_id && await db.get('SELECT name FROM rooms WHERE id = ?', booking.room_id);
  const therapists = booking.member_id
    ? (await db.all("SELECT email FROM users WHERE member_id = ? AND email != ''", booking.member_id)).map((u) => u.email)
    : [];
  notifyNewBooking({ ...booking, room_name: room?.name ?? '' }, await notifyEmails(), therapists);
  res.status(201).json({ id: booking.id, member_name: booking.member_name });
});

// ---------- prihlásenie ----------

const tokenHash = (token) => crypto.createHash('sha256').update(token).digest('hex');
const sessionToken = (req) => /(?:^|;\s*)sid=([\w-]+)/.exec(req.headers.cookie || '')?.[1];
const endSession = (token) => token && db.run('DELETE FROM sessions WHERE token_hash = ?', tokenHash(token));
const endSessions = (userId) => db.run('DELETE FROM sessions WHERE user_id = ?', userId);

app.post('/api/admin/login', rateLimit(10, 15 * 60e3), async (req, res) => {
  const user = await db.get('SELECT id, password_hash FROM users WHERE lower(username) = lower(?)', str(req.body?.username, 64));
  const ok = verifyPassword(String(req.body?.password ?? ''), user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok) throw new HttpError(401, 'Nesprávne meno alebo heslo.');
  const token = crypto.randomBytes(32).toString('base64url');
  await db.run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
  await db.run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
    tokenHash(token), user.id, Date.now() + SESSION_MS);
  res.cookie('sid', token, { httpOnly: true, sameSite: 'strict', secure: req.secure, maxAge: SESSION_MS, path: '/' });
  res.json({ ok: true });
});

// ---------- adresáti e-mailových notifikácií ----------

// e-maily z profilov používateľov vybraných v Nastaveniach; kým nie je vybraný nikto s e-mailom, ADMIN_EMAIL z .env
async function notifyEmails(exceptUserId = 0) {
  const rows = await db.all("SELECT email FROM users WHERE id = ANY(?) AND email != '' AND id != ?",
    getSettings().notify_user_ids ?? [], exceptUserId);
  return rows.length ? rows.map((u) => u.email) : [mailStatus.fallbackEmail].filter(Boolean);
}

// ---------- nastavenie hesla cez odkaz z e-mailu ----------

const INVITE_MS = 3 * 24 * 3600e3;
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

// adresa pre odkaz v e-maile: nastavená adresa webu, inak adresa, na ktorej beží administrácia
const baseUrl = (req) => getSettings().site_url || `${req.protocol}://${req.get('host')}`;

const accountUser = (userId) => db.get(`
  SELECT u.id, u.username, u.role, u.email, COALESCE(m.name, NULLIF(u.name, '')) AS member_name
  FROM users u LEFT JOIN team_members m ON m.id = u.member_id WHERE u.id = ?
`, userId);

async function sendInvite(req, userId, isNew) {
  const user = await accountUser(userId);
  if (!user?.email) throw bad('Používateľ nemá zadaný e-mail.');
  const token = crypto.randomBytes(32).toString('base64url');
  await db.run('DELETE FROM password_tokens WHERE user_id = ? OR expires_at < ?', user.id, Date.now());
  await db.run('INSERT INTO password_tokens (token_hash, user_id, expires_at, kind) VALUES (?, ?, ?, ?)',
    tokenHash(token), user.id, Date.now() + INVITE_MS, isNew ? 'invite' : 'reset');
  // token je za # – prehliadač ho neposiela na server ani v hlavičke Referer
  await sendAccountInvite(user, `${baseUrl(req)}/admin/#heslo=${token}`, isNew);
}

app.post('/api/admin/password-reset', rateLimit(10, 15 * 60e3), async (req, res) => {
  const { token, password } = req.body ?? {};
  const row = typeof token === 'string' &&
    await db.get('SELECT user_id, kind FROM password_tokens WHERE token_hash = ? AND expires_at > ?', tokenHash(token), Date.now());
  if (!row) throw bad('Odkaz je neplatný alebo vypršal. Požiadajte admina o nový.');
  if (typeof password !== 'string' || password.length < 8) throw bad('Heslo musí mať aspoň 8 znakov.');
  await db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), row.user_id);
  await db.run('DELETE FROM password_tokens WHERE user_id = ?', row.user_id);
  await endSessions(row.user_id);
  const user = await accountUser(row.user_id);
  // upozornenie pre adresátov notifikácií (okrem samotného používateľa)
  notifyPasswordSet(user, row.kind === 'invite', await notifyEmails(user.id));
  res.json({ username: user.username });
});

// ---------- klientske účty (verejný web) ----------

const CLIENT_SESSION_MS = 30 * 24 * 3600e3;
const clientToken = (req) => /(?:^|;\s*)csid=([\w-]+)/.exec(req.headers.cookie || '')?.[1];
const clientProfile = (id) => db.get('SELECT id, name, email, phone FROM clients WHERE id = ?', id);

async function currentClient(req) {
  const token = clientToken(req);
  return token && db.get(`
    SELECT c.id, c.name, c.email, c.phone FROM client_sessions s JOIN clients c ON c.id = s.client_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `, tokenHash(token), Date.now());
}

async function requireClient(req) {
  const client = await currentClient(req);
  if (!client) throw new HttpError(401, 'Prihláste sa, prosím.');
  return client;
}

async function startClientSession(req, res, clientId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await db.run('DELETE FROM client_sessions WHERE expires_at < ?', Date.now());
  await db.run('INSERT INTO client_sessions (token_hash, client_id, expires_at) VALUES (?, ?, ?)',
    tokenHash(token), clientId, Date.now() + CLIENT_SESSION_MS);
  res.cookie('csid', token, { httpOnly: true, sameSite: 'strict', secure: req.secure, maxAge: CLIENT_SESSION_MS, path: '/' });
}

function clientInput(body = {}) {
  const c = { name: str(body.name, 100), email: str(body.email, 120), phone: str(body.phone, 30) };
  if (c.name.length < 3) throw bad('Zadajte meno a priezvisko.');
  if (!isEmail(c.email)) throw bad('Zadajte platný e-mail.');
  if (c.phone && !/^\+?[\d\s/-]{6,}$/.test(c.phone)) throw bad('Zadajte platné telefónne číslo.');
  return c;
}

const clientEmailTaken = async (email, exceptId = 0) =>
  !!(await db.get('SELECT 1 FROM clients WHERE lower(email) = lower(?) AND id != ?', email, exceptId));

// registrácia je možná len so súhlasom so spracúvaním osobných údajov (GDPR, zákon č. 18/2018 Z. z.)
app.post('/api/client/register', rateLimit(5, 3600e3), async (req, res) => {
  const body = req.body ?? {};
  if (body.gdpr !== true) throw bad('Bez súhlasu so spracúvaním osobných údajov sa nie je možné zaregistrovať.');
  const c = clientInput(body);
  if (typeof body.password !== 'string' || body.password.length < 8) throw bad('Heslo musí mať aspoň 8 znakov.');
  if (body.password2 !== body.password) throw bad('Heslá sa nezhodujú.');
  const existing = await db.get('SELECT id, verified_at FROM clients WHERE lower(email) = lower(?)', c.email);
  if (existing?.verified_at) throw new HttpError(409, 'Účet s týmto e-mailom už existuje – prihláste sa.');
  let id = existing?.id;
  // nepotvrdený účet s rovnakým e-mailom (napr. stratený e-mail s odkazom) sa prepíše novými údajmi
  if (id) {
    await db.run('UPDATE clients SET password_hash = ?, name = ?, phone = ?, gdpr_consent_at = now() WHERE id = ?',
      hashPassword(body.password), c.name, c.phone, id);
  } else {
    ({ id } = await db.run(`
      INSERT INTO clients (email, password_hash, name, phone, gdpr_consent_at) VALUES (?, ?, ?, ?, now()) RETURNING id
    `, c.email, hashPassword(body.password), c.name, c.phone));
  }
  await sendClientVerification(req, id);
  res.status(201).json({ email: c.email });
});

const VERIFY_MS = 3 * 24 * 3600e3;

async function sendClientVerification(req, clientId) {
  const token = crypto.randomBytes(32).toString('base64url');
  // staršie odkazy ostávajú platné – klient môže kliknúť na ktorýkoľvek z prijatých e-mailov
  await db.run('DELETE FROM client_tokens WHERE expires_at < ?', Date.now());
  await db.run('INSERT INTO client_tokens (token_hash, client_id, expires_at) VALUES (?, ?, ?)',
    tokenHash(token), clientId, Date.now() + VERIFY_MS);
  // token je za # – prehliadač ho neposiela na server ani v hlavičke Referer
  notifyClientVerify(await clientProfile(clientId), `${baseUrl(req)}/#overenie=${token}`);
}

// Potvrdenie e-mailu odkazom z registračného e-mailu; pri prvom použití sa klient zároveň prihlási.
// Odkaz platí až do vypršania: otvorí ho aj skener odkazov v e-maile alebo druhý prehliadač,
// opakované otvorenie preto len oznámi, že účet je už potvrdený (bez prihlásenia).
app.post('/api/client/verify', rateLimit(20, 15 * 60e3), async (req, res) => {
  const { token } = req.body ?? {};
  const row = typeof token === 'string' && await db.get(`
    SELECT t.client_id, c.verified_at FROM client_tokens t JOIN clients c ON c.id = t.client_id
    WHERE t.token_hash = ? AND t.expires_at > ?
  `, tokenHash(token), Date.now());
  if (!row) throw bad('Odkaz je neplatný alebo vypršal. Prihláste sa e-mailom a heslom a pošleme vám nový.');
  if (row.verified_at) return res.json({ already: true });
  await db.run('UPDATE clients SET verified_at = now() WHERE id = ?', row.client_id);
  await startClientSession(req, res, row.client_id);
  res.json({ client: await clientProfile(row.client_id) });
});

app.post('/api/client/login', rateLimit(10, 15 * 60e3), async (req, res) => {
  const client = await db.get('SELECT id, password_hash, verified_at FROM clients WHERE lower(email) = lower(?)',
    str(req.body?.email, 120));
  const ok = verifyPassword(String(req.body?.password ?? ''), client?.password_hash ?? DUMMY_HASH);
  if (!client || !ok) throw new HttpError(401, 'Nesprávny e-mail alebo heslo.');
  // nepotvrdený účet: pošle sa nový odkaz (starý mohol vypršať alebo sa stratiť)
  if (!client.verified_at) {
    await sendClientVerification(req, client.id);
    throw new HttpError(403, 'Účet ešte nie je potvrdený. Poslali sme vám nový e-mail s odkazom na potvrdenie.');
  }
  await startClientSession(req, res, client.id);
  res.json(await clientProfile(client.id));
});

// ---------- zabudnuté heslo klienta ----------

const RESET_MS = 2 * 3600e3;

// odpoveď je vždy rovnaká, aby sa nedalo zistiť, či účet s daným e-mailom existuje
app.post('/api/client/forgot', rateLimit(5, 3600e3), async (req, res) => {
  const email = str(req.body?.email, 120);
  if (!isEmail(email)) throw bad('Zadajte platný e-mail.');
  const client = await db.get('SELECT id FROM clients WHERE lower(email) = lower(?)', email);
  if (client) {
    const token = crypto.randomBytes(32).toString('base64url');
    await db.run('DELETE FROM client_password_tokens WHERE client_id = ? OR expires_at < ?', client.id, Date.now());
    await db.run('INSERT INTO client_password_tokens (token_hash, client_id, expires_at) VALUES (?, ?, ?)',
      tokenHash(token), client.id, Date.now() + RESET_MS);
    // token je za # – prehliadač ho neposiela na server ani v hlavičke Referer
    notifyClientPasswordReset(await clientProfile(client.id), `${baseUrl(req)}/#nove-heslo=${token}`);
  }
  res.json({ ok: true });
});

// nové heslo cez odkaz z e-mailu: odhlási ostatné zariadenia a klienta prihlási;
// odkaz prišiel na jeho e-mail, preto sa nepotvrdený účet zároveň potvrdí
app.post('/api/client/reset', rateLimit(10, 15 * 60e3), async (req, res) => {
  const { token, password, password2 } = req.body ?? {};
  const row = typeof token === 'string' && await db.get(
    'SELECT client_id FROM client_password_tokens WHERE token_hash = ? AND expires_at > ?', tokenHash(token), Date.now()
  );
  if (!row) throw bad('Odkaz je neplatný alebo vypršal. Požiadajte o nový cez „Zabudnuté heslo“.');
  if (typeof password !== 'string' || password.length < 8) throw bad('Heslo musí mať aspoň 8 znakov.');
  if (password2 !== password) throw bad('Heslá sa nezhodujú.');
  await db.tx(async (t) => {
    await t.run('UPDATE clients SET password_hash = ?, verified_at = COALESCE(verified_at, now()) WHERE id = ?',
      hashPassword(password), row.client_id);
    await t.run('DELETE FROM client_password_tokens WHERE client_id = ?', row.client_id);
    await t.run('DELETE FROM client_sessions WHERE client_id = ?', row.client_id);
  });
  await startClientSession(req, res, row.client_id);
  res.json(await clientProfile(row.client_id));
});

app.post('/api/client/logout', async (req, res) => {
  const token = clientToken(req);
  if (token) await db.run('DELETE FROM client_sessions WHERE token_hash = ?', tokenHash(token));
  res.clearCookie('csid', { path: '/' });
  res.json({ ok: true });
});

// neprihlásený návštevník dostane null, nie chybu
app.get('/api/client/me', async (req, res) => res.json((await currentClient(req)) || null));

app.put('/api/client/me', async (req, res) => {
  const { id } = await requireClient(req);
  const c = clientInput(req.body);
  if (await clientEmailTaken(c.email, id)) throw new HttpError(409, 'Tento e-mail už používa iný účet.');
  await db.run('UPDATE clients SET name = ?, email = ?, phone = ? WHERE id = ?', c.name, c.email, c.phone, id);
  res.json(await clientProfile(id));
});

// rezervácie klienta: urobené z účtu a aj staršie bez účtu na jeho (potvrdený) e-mail
const OWN_BOOKING = '(client_id = ? OR (client_id IS NULL AND lower(email) = lower(?)))';

app.get('/api/client/bookings', async (req, res) => {
  const { id, email } = await requireClient(req);
  res.json(await db.all(`
    SELECT id, procedure_name, date, time, end_time, duration_min, price, status, member_name, note, cancel_reason FROM bookings
    WHERE ${OWN_BOOKING} ORDER BY date, time LIMIT 1000
  `, id, email));
});

// zrušenie termínu klientom: povinný dôvod, ktorý dostane admin a priradený terapeut
app.post('/api/client/bookings/:id/cancel', rateLimit(20, 3600e3), async (req, res) => {
  const client = await requireClient(req);
  const booking = await db.get(`SELECT * FROM bookings WHERE id = ? AND ${OWN_BOOKING}`, num(req.params.id), client.id, client.email);
  if (!booking) throw new HttpError(404, 'Rezervácia neexistuje.');
  if (!['new', 'confirmed'].includes(booking.status)) throw bad('Túto rezerváciu už nie je možné zrušiť.');
  const now = localNow();
  if (booking.date < now.date || (booking.date === now.date && toMin(booking.time) <= now.min)) {
    throw bad('Termín už začal alebo prebehol – zrušiť sa nedá.');
  }
  const reason = str(req.body?.reason, 1000);
  if (reason.length < 5) throw bad('Napíšte prosím, prečo termín rušíte (aspoň pár slov).');

  // podmienka na stav chráni pred súbežnou zmenou (napr. admin práve termín dokončil)
  const { changes } = await db.run(
    "UPDATE bookings SET status = 'cancelled', cancel_reason = ? WHERE id = ? AND status IN ('new', 'confirmed')", reason, booking.id
  );
  if (!changes) throw bad('Túto rezerváciu už nie je možné zrušiť.');
  const cancelled = { ...booking, status: 'cancelled', cancel_reason: reason };
  const therapists = booking.member_id
    ? (await db.all("SELECT email FROM users WHERE member_id = ? AND email != ''", booking.member_id)).map((u) => u.email)
    : [];
  notifyClientCancelled(cancelled, [...await notifyEmails(), ...therapists]);
  notifyStatus(cancelled, 'cancelled');
  res.json({ ok: true });
});

// zrušenie účtu = odvolanie súhlasu; údaje účtu sa vymažú, rezervácie ostanú bez väzby na účet
app.delete('/api/client/me', rateLimit(10, 15 * 60e3), async (req, res) => {
  const { id } = await requireClient(req);
  const { password_hash } = await db.get('SELECT password_hash FROM clients WHERE id = ?', id);
  if (!verifyPassword(String(req.body?.password ?? ''), password_hash)) throw bad('Heslo nie je správne.');
  await db.run('DELETE FROM clients WHERE id = ?', id);
  res.clearCookie('csid', { path: '/' });
  res.json({ ok: true });
});

app.use('/api/admin', async (req, res, next) => {
  const token = sessionToken(req);
  const user = token && await db.get(`
    SELECT u.id, u.username, u.role, u.member_id, m.name AS member_name
    FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN team_members m ON m.id = u.member_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `, tokenHash(token), Date.now());
  if (!user) {
    await endSession(token);
    throw new HttpError(401, 'Neprihlásený.');
  }
  req.user = user;
  next();
});

const isAdmin = (req) => req.user.role === 'admin';
app.use(
  ['/api/admin/procedures', '/api/admin/rooms', '/api/admin/team', '/api/admin/users', '/api/admin/clients', '/api/admin/settings', '/api/admin/mail', '/api/admin/sms'],
  (req, res, next) => {
    if (!isAdmin(req)) throw new HttpError(403, 'Na túto akciu nemáte oprávnenie.');
    next();
  }
);

// Profil: meno a fotka člena tímu (zobrazujú sa na webe), inak vlastné z účtu
async function profile(userId) {
  const p = await db.get(`
    SELECT u.id, u.username, u.role, u.member_id, u.email, u.phone, m.name AS member_name,
           COALESCE(m.name, u.name) AS name, COALESCE(m.photo, u.photo) AS photo, COALESCE(m.bio, '') AS bio
    FROM users u LEFT JOIN team_members m ON m.id = u.member_id WHERE u.id = ?
  `, userId);
  return { ...p, photo: p.photo ? `/media/${p.photo}` : '' };
}

app.get('/api/admin/me', async (req, res) => res.json(await profile(req.user.id)));

// photo: data URL = nová fotka, null = odstrániť, čokoľvek iné = ponechať
app.put('/api/admin/me/profile', async (req, res) => {
  const body = req.body ?? {};
  const name = str(body.name, 100);
  const email = str(body.email, 120);
  const phone = str(body.phone, 30);
  if (name.length < 2) throw bad('Zadajte meno.');
  if (email && !isEmail(email)) throw bad('Zadajte platný e-mail.');
  if (phone && !/^\+?[\d\s/-]{6,}$/.test(phone)) throw bad('Zadajte platné telefónne číslo.');

  const user = await db.get(`
    SELECT u.photo, m.id AS member_id, m.photo AS member_photo FROM users u LEFT JOIN team_members m ON m.id = u.member_id WHERE u.id = ?
  `, req.user.id);
  const linked = user.member_id != null;
  const current = linked ? user.member_photo : user.photo;
  let photo = current;
  if (isNewPhoto(body.photo)) photo = await savePhoto(body.photo);
  else if (body.photo === null) photo = '';

  await db.tx(async (t) => {
    // bio patrí členovi tímu – účet bez napojenia na tím ho nemá
    if (linked) {
      await t.run('UPDATE team_members SET name = ?, photo = ?, bio = ? WHERE id = ?', name, photo, str(body.bio, 2000), user.member_id);
    }
    await t.run('UPDATE users SET name = ?, email = ?, phone = ?, photo = ? WHERE id = ?',
      name, email, phone, linked ? user.photo : photo, req.user.id);
  });
  if (photo !== current) await removePhoto(current);
  res.json(await profile(req.user.id));
});

app.post('/api/admin/logout', async (req, res) => {
  await endSession(sessionToken(req));
  res.clearCookie('sid', { path: '/' });
  res.json({ ok: true });
});

app.put('/api/admin/me/password', async (req, res) => {
  const { current, password } = req.body ?? {};
  const { password_hash } = await db.get('SELECT password_hash FROM users WHERE id = ?', req.user.id);
  if (!verifyPassword(String(current ?? ''), password_hash)) throw bad('Súčasné heslo nie je správne.');
  if (typeof password !== 'string' || password.length < 8) throw bad('Nové heslo musí mať aspoň 8 znakov.');
  await db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), req.user.id);
  res.json({ ok: true });
});

// ---------- rezervácie (terapeut vidí len svoje) ----------

// podmienka, ktorá obmedzí rezervácie na prihláseného terapeuta
const ownScope = (req) => (isAdmin(req) ? ['1 = 1', []] : ['b.member_id = ?', [req.user.member_id ?? -1]]);

app.get('/api/admin/stats', async (req, res) => {
  const today = localNow().date;
  const [scope, scopeParams] = ownScope(req);
  const count = async (sql, ...params) =>
    (await db.get(`SELECT COUNT(*)::int AS n FROM bookings b WHERE ${scope} AND ${sql}`, ...scopeParams, ...params)).n;
  res.json({
    today: await count("date = ? AND status != 'cancelled'", today),
    upcoming: await count("date >= ? AND status IN ('new', 'confirmed')", today),
    pending: await count("date >= ? AND status = 'new'", today),
  });
});

app.get('/api/admin/bookings', async (req, res) => {
  const today = localNow().date;
  const [scope, scopeParams] = ownScope(req);
  const where = [scope];
  const params = [...scopeParams];
  switch (req.query.range) {
    // kalendár: konkrétne obdobie (from – to vrátane)
    case 'period':
      if (!isDate(req.query.from) || !isDate(req.query.to)) throw bad('Neplatné obdobie.');
      where.push('b.date BETWEEN ? AND ?');
      params.push(req.query.from, req.query.to);
      break;
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
    else { where.push('b.member_id = ?'); params.push(num(req.query.member)); }
  }
  const order = req.query.range === 'past' ? 'DESC' : 'ASC';
  res.json(await db.all(`
    SELECT b.*, r.name AS room_name FROM bookings b LEFT JOIN rooms r ON r.id = b.room_id
    WHERE ${where.join(' AND ')}
    ORDER BY b.date ${order}, b.time ${order} LIMIT 500
  `, ...params));
});

app.patch('/api/admin/bookings/:id', async (req, res) => {
  const body = req.body ?? {};
  await serialized(async () => {
    const booking = await db.get('SELECT * FROM bookings WHERE id = ?', num(req.params.id));
    if (!booking || (!isAdmin(req) && booking.member_id !== req.user.member_id)) {
      throw new HttpError(404, 'Rezervácia neexistuje.');
    }

    if ('member_id' in body) {
      if (!isAdmin(req)) throw new HttpError(403, 'Preradiť rezerváciu môže len admin.');
      const member = body.member_id == null ? null : await db.get('SELECT id, name FROM team_members WHERE id = ?', num(body.member_id));
      if (body.member_id != null && !member) throw bad('Neznámy člen tímu.');
      if (member && booking.status !== 'cancelled' && await hasClash(booking, member.id)) {
        throw new HttpError(409, `${member.name} má v tomto čase inú rezerváciu.`);
      }
      await db.run('UPDATE bookings SET member_id = ?, member_name = ? WHERE id = ?', member?.id ?? null, member?.name ?? '', booking.id);
      // potvrdený termín preradený inému terapeutovi – nový terapeut dostane upozornenie
      if (member && member.id !== booking.member_id && booking.status === 'confirmed') {
        await notifyMember({ ...booking, member_id: member.id, member_name: member.name }, 'assigned');
      }
      return;
    }

    const { status } = body;
    if (!STATUSES.includes(status)) throw bad('Neplatný stav.');
    // obnovenie zrušenej rezervácie nesmie prekryť iný termín
    if (booking.status === 'cancelled' && status !== 'cancelled' && await hasClash(booking, booking.member_id)) {
      throw new HttpError(409, 'Termín je medzitým obsadený inou rezerváciou.');
    }
    // dôvod zrušenia od klienta platí len kým je rezervácia zrušená
    await db.run("UPDATE bookings SET status = ?, cancel_reason = CASE WHEN ?::text = 'cancelled' THEN cancel_reason ELSE '' END WHERE id = ?",
      status, status, booking.id);
    if (booking.status !== status) notifyStatus(booking, status);
    // SMS len pri potvrdení a len klientovi s vyplneným telefónom
    if (status === 'confirmed' && booking.status !== 'confirmed' && booking.phone && smsEnabled()) {
      sendLoggedSms('confirmed', booking.phone, confirmedText(booking, getSettings().contact_phone), booking.id)
        .catch((err) => console.error('SMS log:', err.message));
    }
    // terapeut dostane upozornenie, keď mu rezerváciu potvrdí niekto iný (admin)
    if (status === 'confirmed' && booking.status !== 'confirmed' && booking.member_id && booking.member_id !== req.user.member_id) {
      await notifyMember(booking, 'confirmed');
    }
  });
  res.json({ ok: true });
});

// e-mail terapeutovi: na všetky účty napojené na člena tímu, ktoré majú vyplnený e-mail
async function notifyMember(booking, kind) {
  const emails = (await db.all("SELECT email FROM users WHERE member_id = ? AND email != ''", booking.member_id)).map((u) => u.email);
  if (!emails.length) return;
  const room = booking.room_id && await db.get('SELECT name FROM rooms WHERE id = ?', booking.room_id);
  notifyTherapist({ ...booking, room_name: room?.name ?? '' }, emails, kind);
}

app.delete('/api/admin/bookings/:id', async (req, res) => {
  if (!isAdmin(req)) throw new HttpError(403, 'Vymazať rezerváciu môže len admin.');
  await db.run('DELETE FROM bookings WHERE id = ?', num(req.params.id));
  res.json({ ok: true });
});

// ---------- procedúry a miestnosti (len admin) ----------

app.get('/api/admin/procedures', async (req, res) => {
  const links = await db.all(`
    SELECT pm.procedure_id, m.id, m.name FROM procedure_members pm JOIN team_members m ON m.id = pm.member_id ORDER BY m.sort, m.name
  `);
  res.json(
    (await db.all('SELECT p.*, r.name AS room_name FROM procedures p LEFT JOIN rooms r ON r.id = p.room_id ORDER BY p.sort, p.name'))
      .map((p) => ({ ...p, members: links.filter((l) => l.procedure_id === p.id).map(({ id, name }) => ({ id, name })) }))
  );
});

async function procedureInput(body = {}) {
  const p = {
    name: str(body.name, 100),
    description: str(body.description, 500),
    duration_min: Math.round(Number(body.duration_min)),
    price: Math.round(Number(body.price) * 100) / 100,
    icon: ICON_KEYS.includes(body.icon) ? body.icon : 'hand',
    active: body.active ? 1 : 0,
    sort: num(Math.round(Number(body.sort)) || 0),
    room_id: num(body.room_id),
  };
  if (!p.name) throw bad('Zadajte názov procedúry.');
  if (!(p.duration_min >= 5 && p.duration_min <= 480)) throw bad('Trvanie musí byť 5 – 480 minút.');
  if (!(p.price >= 0 && p.price < 1e6)) throw bad('Zadajte platnú cenu.');
  if (!(await db.get('SELECT 1 FROM rooms WHERE id = ?', p.room_id))) throw bad('Vyberte miestnosť.');
  return p;
}

app.post('/api/admin/procedures', async (req, res) => {
  const p = await procedureInput(req.body);
  const { id } = await db.run(`
    INSERT INTO procedures (name, description, duration_min, price, icon, active, sort, room_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
  `, p.name, p.description, p.duration_min, p.price, p.icon, p.active, p.sort, p.room_id);
  res.status(201).json({ id });
});

app.put('/api/admin/procedures/:id', async (req, res) => {
  const p = await procedureInput(req.body);
  const result = await db.run(`
    UPDATE procedures SET name = ?, description = ?, duration_min = ?, price = ?, icon = ?, active = ?, sort = ?, room_id = ? WHERE id = ?
  `, p.name, p.description, p.duration_min, p.price, p.icon, p.active, p.sort, p.room_id, num(req.params.id));
  if (!result.changes) throw new HttpError(404, 'Procedúra neexistuje.');
  res.json({ ok: true });
});

app.delete('/api/admin/procedures/:id', async (req, res) => {
  await db.run('DELETE FROM procedures WHERE id = ?', num(req.params.id));
  res.json({ ok: true });
});

app.get('/api/admin/rooms', async (req, res) => {
  res.json(await db.all(`
    SELECT r.id, r.name, (SELECT COUNT(*)::int FROM procedures p WHERE p.room_id = r.id) AS procedures FROM rooms r ORDER BY r.name
  `));
});

const roomName = (body) => {
  const name = str(body?.name, 60);
  if (!name) throw bad('Zadajte názov miestnosti.');
  return name;
};

app.post('/api/admin/rooms', async (req, res) => {
  const { id } = await db.run('INSERT INTO rooms (name) VALUES (?) RETURNING id', roomName(req.body));
  res.status(201).json({ id });
});

app.put('/api/admin/rooms/:id', async (req, res) => {
  if (!(await db.run('UPDATE rooms SET name = ? WHERE id = ?', roomName(req.body), num(req.params.id))).changes) {
    throw new HttpError(404, 'Miestnosť neexistuje.');
  }
  res.json({ ok: true });
});

app.delete('/api/admin/rooms/:id', async (req, res) => {
  if (await db.get('SELECT 1 FROM procedures WHERE room_id = ?', num(req.params.id))) {
    throw new HttpError(409, 'Miestnosť používajú procedúry – najprv im nastavte inú.');
  }
  await db.run('DELETE FROM rooms WHERE id = ?', num(req.params.id));
  res.json({ ok: true });
});

// ---------- tím (len admin) ----------

app.get('/api/admin/team', async (req, res) => {
  const links = await db.all('SELECT procedure_id, member_id FROM procedure_members');
  const logins = await db.all('SELECT username, member_id FROM users WHERE member_id IS NOT NULL');
  res.json(
    (await db.all('SELECT * FROM team_members ORDER BY sort, name')).map((m) => ({
      ...m,
      photo: m.photo ? `/media/${m.photo}` : '',
      procedures: links.filter((l) => l.member_id === m.id).map((l) => l.procedure_id),
      logins: logins.filter((u) => u.member_id === m.id).map((u) => u.username),
    }))
  );
});

// fotku orezáva a zmenšuje prehliadač, server prijme len JPEG
async function savePhoto(dataUrl) {
  const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+=*)$/.exec(dataUrl);
  const buf = match && Buffer.from(match[1], 'base64');
  if (!buf || buf.length > 1.5e6 || buf[0] !== 0xff || buf[1] !== 0xd8) throw bad('Fotka musí byť obrázok JPEG do 1,5 MB.');
  const file = `team-${crypto.randomBytes(8).toString('hex')}.jpg`;
  await db.run('INSERT INTO media (name, data) VALUES (?, ?)', file, buf);
  return file;
}
const isNewPhoto = (v) => typeof v === 'string' && v.startsWith('data:');
const removePhoto = async (file) => file && db.run('DELETE FROM media WHERE name = ?', file);

function memberInput(body = {}) {
  const m = {
    name: str(body.name, 100),
    title: str(body.title, 100),
    bio: str(body.bio, 2000),
    active: body.active ? 1 : 0,
    sort: num(Math.round(Number(body.sort)) || 0),
    procedures: ids(body.procedures),
  };
  if (m.name.length < 2) throw bad('Zadajte meno.');
  return m;
}

const saveMember = (id, m, photo) => db.tx(async (t) => {
  if (id) {
    await t.run('UPDATE team_members SET name = ?, title = ?, bio = ?, active = ?, sort = ?, photo = ? WHERE id = ?',
      m.name, m.title, m.bio, m.active, m.sort, photo, id);
  } else {
    ({ id } = await t.run('INSERT INTO team_members (name, title, bio, active, sort, photo) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
      m.name, m.title, m.bio, m.active, m.sort, photo));
  }
  await t.run('DELETE FROM procedure_members WHERE member_id = ?', id);
  for (const procedureId of m.procedures) {
    await t.run('INSERT INTO procedure_members (procedure_id, member_id) SELECT id, ?::int FROM procedures WHERE id = ?', id, procedureId);
  }
  return id;
});

app.post('/api/admin/team', async (req, res) => {
  const m = memberInput(req.body);
  const photo = isNewPhoto(req.body.photo) ? await savePhoto(req.body.photo) : '';
  res.status(201).json({ id: await saveMember(null, m, photo) });
});

// photo: data URL = nová fotka, null = odstrániť, čokoľvek iné = ponechať
app.put('/api/admin/team/:id', async (req, res) => {
  const current = await db.get('SELECT * FROM team_members WHERE id = ?', num(req.params.id));
  if (!current) throw new HttpError(404, 'Člen tímu neexistuje.');
  const m = memberInput(req.body);
  let photo = current.photo;
  if (isNewPhoto(req.body.photo)) photo = await savePhoto(req.body.photo);
  else if (req.body.photo === null) photo = '';
  await saveMember(current.id, m, photo);
  if (photo !== current.photo) await removePhoto(current.photo);
  res.json({ ok: true });
});

app.delete('/api/admin/team/:id', async (req, res) => {
  const member = await db.get('SELECT * FROM team_members WHERE id = ?', num(req.params.id));
  if (!member) return res.json({ ok: true });
  if (await db.get("SELECT 1 FROM users WHERE member_id = ? AND role = 'solver'", member.id)) {
    throw new HttpError(409, 'Člen tímu má prihlasovací účet terapeuta – najprv ho vymažte v Používateľoch.');
  }
  await db.run('DELETE FROM team_members WHERE id = ?', member.id);
  await removePhoto(member.photo);
  res.json({ ok: true });
});

// ---------- používatelia (len admin) ----------

app.get('/api/admin/users', async (req, res) => {
  res.json(await db.all(`
    SELECT u.id, u.username, u.email, u.phone, u.role, u.member_id, COALESCE(m.name, NULLIF(u.name, '')) AS member_name, u.created_at
    FROM users u LEFT JOIN team_members m ON m.id = u.member_id ORDER BY u.role, u.username
  `));
});

async function userInput(body = {}, isNew) {
  const u = {
    username: str(body.username, 32),
    role: body.role,
    member_id: body.member_id ? num(body.member_id) : null,
    email: str(body.email, 120),
    phone: str(body.phone, 30),
    password: typeof body.password === 'string' ? body.password : '',
  };
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(u.username)) throw bad('Prihlasovacie meno: 3 – 32 znakov (písmená bez diakritiky, čísla, . _ -).');
  if (!ROLES.includes(u.role)) throw bad('Neplatná rola.');
  if (u.member_id && !(await db.get('SELECT 1 FROM team_members WHERE id = ?', u.member_id))) throw bad('Neznámy člen tímu.');
  if (u.role === 'solver' && !u.member_id) throw bad('Terapeut musí byť priradený k členovi tímu.');
  if (u.email && !isEmail(u.email)) throw bad('Zadajte platný e-mail.');
  if (u.phone && !/^\+?[\d\s/-]{6,}$/.test(u.phone)) throw bad('Zadajte platné telefónne číslo.');
  if (isNew && !u.password && !u.email) throw bad('Zadajte heslo alebo e-mail, na ktorý príde odkaz na nastavenie hesla.');
  if (u.password && u.password.length < 8) throw bad('Heslo musí mať aspoň 8 znakov.');
  return u;
}

const usernameTaken = async (username, exceptId = 0) =>
  !!(await db.get('SELECT 1 FROM users WHERE lower(username) = lower(?) AND id != ?', username, exceptId));
const adminCount = async () => (await db.get("SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin'")).n;

// Účet s e-mailom dostane uvítací e-mail s odkazom na nastavenie hesla.
// Bez zadaného hesla sa dá prihlásiť až po jeho nastavení cez odkaz.
app.post('/api/admin/users', async (req, res) => {
  const u = await userInput(req.body, true);
  if (await usernameTaken(u.username)) throw new HttpError(409, 'Toto prihlasovacie meno už existuje.');
  const { id } = await db.run('INSERT INTO users (username, password_hash, role, member_id, email, phone) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
    u.username, hashPassword(u.password || crypto.randomBytes(24).toString('base64url')), u.role, u.member_id, u.email, u.phone);
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
    await sendInvite(req, num(req.params.id), false);
  } catch (err) {
    throw err instanceof HttpError ? err : bad(`E-mail sa nepodarilo odoslať: ${err.message}`);
  }
  res.json({ ok: true });
});

app.put('/api/admin/users/:id', async (req, res) => {
  const current = await db.get('SELECT * FROM users WHERE id = ?', num(req.params.id));
  if (!current) throw new HttpError(404, 'Používateľ neexistuje.');
  const u = await userInput(req.body, false);
  if (await usernameTaken(u.username, current.id)) throw new HttpError(409, 'Toto prihlasovacie meno už existuje.');
  if (current.role === 'admin' && u.role !== 'admin' && (await adminCount()) === 1) throw bad('Musí zostať aspoň jeden admin.');

  await db.run('UPDATE users SET username = ?, role = ?, member_id = ?, email = ?, phone = ? WHERE id = ?',
    u.username, u.role, u.member_id, u.email, u.phone, current.id);
  if (u.password) await db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(u.password), current.id);
  // zmena hesla alebo roly odhlási používateľa na ostatných zariadeniach
  if ((u.password || u.role !== current.role) && current.id !== req.user.id) await endSessions(current.id);
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', async (req, res) => {
  const id = num(req.params.id);
  if (id === req.user.id) throw bad('Nemôžete vymazať vlastný účet.');
  await db.run('DELETE FROM users WHERE id = ?', id);
  res.json({ ok: true });
});

// ---------- klienti registrovaní na webe (len admin) ----------

app.get('/api/admin/clients', async (req, res) => {
  res.json(await db.all(`
    SELECT c.id, c.name, c.email, c.phone, c.gdpr_consent_at, c.created_at, c.verified_at,
           (SELECT COUNT(*)::int FROM bookings b WHERE b.client_id = c.id) AS bookings
    FROM clients c ORDER BY c.created_at DESC
  `));
});

// vymazanie na žiadosť klienta (GDPR); rezervácie ostanú bez väzby na účet
app.delete('/api/admin/clients/:id', async (req, res) => {
  await db.run('DELETE FROM clients WHERE id = ?', num(req.params.id));
  res.json({ ok: true });
});

// ---------- nastavenia (len admin) ----------

// prístupové údaje SMS majú vlastnú časť (/api/admin/sms), heslo sa do prehliadača neposiela
app.get('/api/admin/settings', (req, res) => {
  const { sms_integration_id, sms_integration_code, sms_sender, sms_enabled, ...settings } = getSettings();
  res.json(settings);
});

app.get('/api/admin/mail', async (req, res) => {
  res.json({ ...mailStatus, user_ids: getSettings().notify_user_ids ?? [], recipients: await notifyEmails() });
});

// výber používateľov, na ktorých e-maily chodia notifikácie (nové rezervácie, zrušenia, aktivácie účtov)
app.put('/api/admin/mail', async (req, res) => {
  const known = (await db.all('SELECT id FROM users WHERE id = ANY(?) ORDER BY id', ids(req.body?.user_ids))).map((u) => u.id);
  await saveSettings({ notify_user_ids: known });
  res.json({ ok: true });
});

// ---------- SMS cez SMSfarm.sk (len admin) ----------

// SMS notifikácie sa posielajú, len ak ich admin nevypol a SMSfarm je nastavené
const smsEnabled = () => getSettings().sms_enabled !== false && smsConfigured(smsCfg());

const smsCfg = () => {
  const s = getSettings();
  return { id: s.sms_integration_id, code: s.sms_integration_code, sender: s.sms_sender };
};

// Odošle SMS a zapíše ju do logu (aj neúspešný pokus). Vráti záznam z logu.
async function sendLoggedSms(kind, phone, message, bookingId = null) {
  const recipient = toIntl(phone);
  const text = plain(message);
  let requestId = '';
  let error = '';
  try {
    if (!recipient) throw new Error('neplatné telefónne číslo');
    requestId = await sendSms(smsCfg(), recipient, text);
  } catch (err) {
    error = err.message;
    console.error(`SMS pre ${phone} sa nepodarilo odoslať:`, error);
  }
  // záznamy staršie ako rok sa mažú (telefónne čísla klientov sa neuchovávajú zbytočne dlho)
  await db.run("DELETE FROM sms_log WHERE created_at < now() - interval '1 year'");
  return db.get(`
    INSERT INTO sms_log (kind, booking_id, phone, recipient, message, status, request_id, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
  `, kind, bookingId, phone, recipient ?? '', text, error ? 'error' : 'sent', String(requestId ?? ''), error);
}

const smsLog = () => db.all(`
  SELECT l.*, b.name AS client_name, b.date AS booking_date, b.time AS booking_time
  FROM sms_log l LEFT JOIN bookings b ON b.id = l.booking_id
  ORDER BY l.created_at DESC LIMIT 200
`);

// heslo sa do prehliadača neposiela, len informácia, či je uložené
app.get('/api/admin/sms', async (req, res) => {
  const s = getSettings();
  res.json({
    integration_id: s.sms_integration_id, sender: s.sms_sender, code_set: !!s.sms_integration_code,
    configured: smsConfigured(smsCfg()), enabled: s.sms_enabled !== false, log: await smsLog(),
  });
});

// prázdne heslo = ponechať uložené
app.put('/api/admin/sms', async (req, res) => {
  const body = req.body ?? {};
  const values = { sms_integration_id: str(body.integration_id, 100), sms_sender: str(body.sender, 20) };
  if (str(body.code, 200)) values.sms_integration_code = str(body.code, 200);
  if (values.sms_sender && !/^(\+?\d{6,15}|[A-Za-z0-9 .-]{1,11})$/.test(values.sms_sender)) {
    throw bad('Odosielateľ: alias do 11 znakov (písmená bez diakritiky, čísla) alebo telefónne číslo.');
  }
  await saveSettings(values);
  res.json({ ok: true });
});

app.put('/api/admin/sms/enabled', async (req, res) => {
  await saveSettings({ sms_enabled: req.body?.enabled !== false });
  res.json({ ok: true });
});

// overenie pripojenia (zostatok kreditu, nič sa neposiela)
app.post('/api/admin/sms/check', async (req, res) => {
  try {
    res.json({ credit: await smsCredit(smsCfg()) });
  } catch (err) {
    throw bad(`SMSfarm: ${err.message}`);
  }
});

app.post('/api/admin/sms/test', rateLimit(10, 3600e3), async (req, res) => {
  if (!smsConfigured(smsCfg())) throw bad('Najprv vyplňte a uložte prístupové údaje SMSfarm.');
  const phone = str(req.body?.phone, 30);
  if (!toIntl(phone)) throw bad('Zadajte platné telefónne číslo.');
  const entry = await sendLoggedSms('test', phone, `${process.env.SITE_NAME || 'FYZIO Stupava'}: testovacia SMS z rezervačného systému.`);
  if (entry.status === 'error') throw bad(`SMS sa nepodarilo odoslať: ${entry.error}`);
  res.json({ ok: true });
});

// stav doručenia jednej SMS zo SMSfarm (uloží sa do logu)
app.post('/api/admin/sms/log/:id/delivery', async (req, res) => {
  const entry = await db.get("SELECT * FROM sms_log WHERE id = ? AND status = 'sent'", num(req.params.id));
  if (!entry?.request_id) throw new HttpError(404, 'Záznam neexistuje.');
  let delivery;
  try {
    delivery = await smsDelivery(smsCfg(), entry.request_id, entry.recipient);
  } catch (err) {
    throw bad(`SMSfarm: ${err.message}`);
  }
  await db.run('UPDATE sms_log SET delivery = ? WHERE id = ?', delivery, entry.id);
  res.json({ delivery });
});

app.post('/api/admin/mail/test', async (req, res) => {
  const to = await notifyEmails();
  if (!to.length) throw bad('Nie je vybraný žiadny adresát notifikácií s e-mailom.');
  try {
    await sendMail(to.join(', '), 'Testovací e-mail', 'Odosielanie e-mailov z rezervačného systému funguje.');
  } catch (err) {
    throw bad(`Odoslanie zlyhalo: ${err.message}`);
  }
  res.json({ ok: true });
});

app.put('/api/admin/settings', async (req, res) => {
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

  await saveSettings({ hours, slot_step, max_days_ahead, blocked_dates, contact_phone, site_url, address });
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

const server = app.listen(PORT, () => console.log(`Fyzio beží na http://localhost:${PORT}  (admin: /admin)`));

// docker compose stop / deploy posiela SIGTERM: nové spojenia sa neprijímajú, rozbehnuté požiadavky dobehnú,
// potom sa zavrie Postgres a proces skončí sám, keď dobehnú aj e-maily a SMS odosielané na pozadí
function shutdown(signal) {
  console.log(`${signal} – ukončujem…`);
  server.close(() => db.close().catch((err) => console.error('Postgres:', err.message)));
  // Docker po 10 s posiela SIGKILL, radšej skončiť skôr sami
  setTimeout(() => {
    console.error('Ukončenie trvá príliš dlho, končím násilne.');
    process.exit(1);
  }, 8000).unref();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
