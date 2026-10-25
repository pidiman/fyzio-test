import { ICON_LABELS, icon } from '/js/icons.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const DAYS = ['Nedeľa', 'Pondelok', 'Utorok', 'Streda', 'Štvrtok', 'Piatok', 'Sobota'];
const DAYS_SHORT = ['Ne', 'Po', 'Ut', 'St', 'Št', 'Pi', 'So'];
const STATUS = { new: 'Nová', confirmed: 'Potvrdená', done: 'Dokončená', cancelled: 'Zrušená' };
const ROLE = { admin: 'Admin', solver: 'Terapeut' };
const AVATAR = '<svg viewBox="0 0 100 100"><circle cx="50" cy="40" r="18"/><path d="M16 100c0-22 15-36 34-36s34 14 34 36z"/></svg>';

const eur = (n) => n.toLocaleString('sk-SK', { style: 'currency', currency: 'EUR', minimumFractionDigits: n % 1 ? 2 : 0 });
const fmtDate = (d) => {
  const [y, m, day] = d.split('-').map(Number);
  return `${DAYS_SHORT[new Date(d + 'T00:00:00Z').getUTCDay()]} ${day}. ${m}. ${y}`;
};

async function api(url, opts = {}) {
  if (opts.body !== undefined) {
    opts.body = JSON.stringify(opts.body);
    opts.headers = { 'Content-Type': 'application/json' };
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.endsWith('/login')) {
    showLogin();
    throw new Error('Prihlásenie vypršalo.');
  }
  if (!res.ok) throw new Error(data.error || 'Nastala chyba.');
  return data;
}

let toastTimer;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

// Spustí akciu a chybu zobrazí v toaste namiesto neodchytenej výnimky
const guard = (fn) => async (...args) => {
  try { await fn(...args); } catch (err) { toast(err.message, true); }
};

// ---------- prihlásenie ----------

let me = null;
const isAdmin = () => me?.role === 'admin';

function showLogin() {
  me = null;
  $('#app').hidden = true;
  $('#reset').hidden = true;
  $('#login').hidden = false;
}

// odkaz z e-mailu: /admin/#heslo=<token>
const resetToken = /^#heslo=([\w-]+)$/.exec(location.hash)?.[1];

$('#reset-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  $('#reset-err').textContent = '';
  if (f.password.value !== f.password2.value) {
    $('#reset-err').textContent = 'Heslá sa nezhodujú.';
    return;
  }
  try {
    const { username } = await api('/api/admin/password-reset', { method: 'POST', body: { token: resetToken, password: f.password.value } });
    history.replaceState(null, '', location.pathname);
    showLogin();
    $('#login-form').elements.username.value = username;
    $('#login-form').elements.password.focus();
    toast('Heslo je nastavené, môžete sa prihlásiť');
  } catch (err) {
    $('#reset-err').textContent = err.message;
  }
});

function renderMe() {
  $('#who').textContent = `${me.name || me.username} · ${ROLE[me.role]}`;
  $('#me').innerHTML = me.photo ? `<img src="${esc(me.photo)}" alt="">` : AVATAR;
}

async function showApp() {
  me = await api('/api/admin/me');
  renderMe();
  // terapeut nevidí záložky a filtre určené len adminovi
  document.querySelectorAll('[data-admin]').forEach((el) => { el.hidden = !isAdmin(); });
  $('#login').hidden = true;
  $('#app').hidden = false;
  openTab(location.hash === '#kalendar' ? 'calendar' : 'bookings');
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-err').textContent = '';
  try {
    const f = e.target.elements;
    await api('/api/admin/login', { method: 'POST', body: { username: f.username.value, password: f.password.value } });
    e.target.reset();
    await showApp();
  } catch (err) {
    $('#login-err').textContent = err.message;
  }
});

$('#logout').addEventListener('click', guard(async () => {
  await api('/api/admin/logout', { method: 'POST' });
  showLogin();
}));

// ---------- záložky ----------

const loaders = {
  bookings: () => loadBookings(),
  calendar: () => loadCalendar(),
  procedures: () => loadProcedures(),
  team: () => loadTeam(),
  users: () => loadUsers(),
  settings: () => loadSettings(),
  account: () => loadProfile(),
};

function openTab(name) {
  document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  for (const tab of Object.keys(loaders)) $(`#tab-${tab}`).hidden = tab !== name;
  loaders[name]();
}

document.querySelectorAll('[data-tab]').forEach((btn) => btn.addEventListener('click', () => openTab(btn.dataset.tab)));

// ---------- rezervácie ----------

let teamOptions = [];

const memberSelect = (selected) => `<option value="">— nepriradené —</option>` +
  teamOptions.map((m) => `<option value="${m.id}" ${m.id === selected ? 'selected' : ''}>${esc(m.name)}</option>`).join('');

const loadBookings = guard(async () => {
  if (isAdmin()) {
    teamOptions = await api('/api/admin/team');
    const current = $('#f-member').value;
    $('#f-member').innerHTML = '<option value="">Všetci terapeuti</option><option value="none">Nepriradené</option>' +
      teamOptions.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
    $('#f-member').value = current;
  }
  const params = new URLSearchParams({ range: $('#f-range').value, status: $('#f-status').value });
  if (isAdmin() && $('#f-member').value) params.set('member', $('#f-member').value);
  const [stats, bookings] = await Promise.all([api('/api/admin/stats'), api(`/api/admin/bookings?${params}`)]);

  $('#stats').innerHTML = `
    <div class="stat ${stats.pending ? 'hl' : ''}"><b>${stats.pending}</b><span>Nové na potvrdenie</span></div>
    <div class="stat"><b>${stats.today}</b><span>Dnes</span></div>
    <div class="stat"><b>${stats.upcoming}</b><span>Nadchádzajúce</span></div>`;

  $('#bookings').innerHTML = bookings.map((b) => `
    <article class="bk st-${b.status}">
      <div class="bk-when"><b>${fmtDate(b.date)}</b><span>${b.time} – ${b.end_time}</span></div>
      <div class="bk-main">
        <h4>${esc(b.name)} <span class="badge b-${b.status}">${STATUS[b.status]}</span></h4>
        <p>${esc(b.procedure_name)} · ${eur(b.price)}${b.room_name ? ` · ${esc(b.room_name)}` : ''}</p>
        <p>${[
          b.email && `<a href="mailto:${esc(b.email)}">${esc(b.email)}</a>`,
          b.phone && `<a href="tel:${esc(b.phone.replace(/\s/g, ''))}">${esc(b.phone)}</a>`,
        ].filter(Boolean).join(' · ')}</p>
        ${isAdmin()
          ? `<label class="assign">Terapeut <select data-assign="${b.id}">${memberSelect(b.member_id)}</select></label>`
          : ''}
        ${b.note ? `<p class="note">${esc(b.note)}</p>` : ''}
      </div>
      <div class="bk-actions">
        ${b.status === 'new' ? `<button class="btn btn-primary btn-sm" data-status="confirmed" data-id="${b.id}">Potvrdiť</button>` : ''}
        ${b.status === 'confirmed' ? `<button class="btn btn-ghost btn-sm" data-status="done" data-id="${b.id}">Dokončená</button>` : ''}
        ${b.status !== 'cancelled' && b.status !== 'done' ? `<button class="btn btn-ghost btn-sm" data-status="cancelled" data-id="${b.id}">Zrušiť</button>` : ''}
        ${b.status === 'cancelled' ? `<button class="btn btn-ghost btn-sm" data-status="new" data-id="${b.id}">Obnoviť</button>` : ''}
        ${isAdmin() ? `<button class="btn btn-danger btn-sm" data-delete-booking="${b.id}">Vymazať</button>` : ''}
      </div>
    </article>`).join('') || '<div class="empty">Žiadne rezervácie pre zvolený filter.</div>';
});

$('#f-range').addEventListener('change', loadBookings);
$('#f-status').addEventListener('change', loadBookings);
$('#f-member').addEventListener('change', loadBookings);
$('#refresh').addEventListener('click', loadBookings);

$('#bookings').addEventListener('click', guard(async (e) => {
  const statusBtn = e.target.closest('[data-status]');
  if (statusBtn) {
    await api(`/api/admin/bookings/${statusBtn.dataset.id}`, { method: 'PATCH', body: { status: statusBtn.dataset.status } });
    toast(`Stav zmenený: ${STATUS[statusBtn.dataset.status]}`);
    return loadBookings();
  }
  const del = e.target.closest('[data-delete-booking]');
  if (del && confirm('Naozaj vymazať túto rezerváciu? Akciu nie je možné vrátiť.')) {
    await api(`/api/admin/bookings/${del.dataset.deleteBooking}`, { method: 'DELETE' });
    toast('Rezervácia vymazaná');
    loadBookings();
  }
}));

$('#bookings').addEventListener('change', async (e) => {
  const sel = e.target.closest('[data-assign]');
  if (!sel) return;
  try {
    await api(`/api/admin/bookings/${sel.dataset.assign}`, { method: 'PATCH', body: { member_id: sel.value ? Number(sel.value) : null } });
    toast('Terapeut zmenený');
  } catch (err) {
    toast(err.message, true);
  }
  loadBookings();
});

// ---------- kalendár ----------

const HOUR_PX = 56;
const addDays = (date, n) => {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const dow = (date) => new Date(date + 'T00:00:00Z').getUTCDay();
const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const shortDate = (d) => { const [, m, day] = d.split('-').map(Number); return `${day}. ${m}.`; };
// na úzkej obrazovke deň, inak týždeň od pondelka
const calDays = () => (innerWidth < 760 ? 1 : 7);

const cal = { start: null, days: 0, info: null, bookings: [] };

// prekrývajúce sa rezervácie (rôzne miestnosti/terapeuti) sa zobrazia vedľa seba
function layoutDay(events) {
  const sorted = [...events].sort((a, b) => a.start - b.start || b.end - a.end);
  let cluster = [], clusterEnd = -1;
  const flush = () => {
    const cols = Math.max(...cluster.map((e) => e.col)) + 1;
    cluster.forEach((e) => { e.cols = cols; });
    cluster = [];
  };
  for (const e of sorted) {
    if (cluster.length && e.start >= clusterEnd) flush();
    const ends = [];
    cluster.forEach((c) => { ends[c.col] = Math.max(ends[c.col] ?? 0, c.end); });
    e.col = ends.findIndex((end) => end <= e.start);
    if (e.col < 0) e.col = ends.length;
    cluster.push(e);
    clusterEnd = Math.max(clusterEnd, e.end);
  }
  if (cluster.length) flush();
  return sorted;
}

const loadCalendar = guard(async () => {
  cal.info ??= await api('/api/info');
  const days = calDays();
  cal.start ??= cal.info.today;
  // týždeň vždy od pondelka
  if (days === 7) cal.start = addDays(cal.start, -((dow(cal.start) + 6) % 7));
  cal.days = days;
  const end = addDays(cal.start, days - 1);

  if (isAdmin()) {
    teamOptions = await api('/api/admin/team');
    const current = $('#cal-member').value;
    $('#cal-member').innerHTML = '<option value="">Všetci terapeuti</option><option value="none">Nepriradené</option>' +
      teamOptions.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
    $('#cal-member').value = current;
  }
  const params = new URLSearchParams({ range: 'period', from: cal.start, to: end });
  if (isAdmin() && $('#cal-member').value) params.set('member', $('#cal-member').value);
  cal.bookings = await api(`/api/admin/bookings?${params}`);
  renderCalendar();
});

function renderCalendar() {
  const { info, start, days } = cal;
  const dates = Array.from({ length: days }, (_, i) => addDays(start, i));
  const end = dates.at(-1);
  $('#cal-title').textContent = days === 1
    ? fmtDate(start)
    : `${shortDate(start)} – ${shortDate(end)} ${end.slice(0, 4)}`;

  const bookings = cal.bookings.filter((b) => $('#cal-cancelled').checked || b.status !== 'cancelled');
  // zobrazené hodiny: od najskoršieho otvorenia po najneskoršie zatvorenie (aj s rezerváciami mimo nich)
  const open = dates.map((d) => info.hours[dow(d)]).filter(Boolean);
  let from = Math.min(...open.map((h) => toMin(h[0])), ...bookings.map((b) => toMin(b.time)), 7 * 60);
  let to = Math.max(...open.map((h) => toMin(h[1])), ...bookings.map((b) => toMin(b.end_time)), 18 * 60);
  from = Math.floor(from / 60) * 60;
  to = Math.ceil(to / 60) * 60;
  const px = (min) => ((min - from) / 60) * HOUR_PX;
  const height = px(to);

  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const hours = Array.from({ length: (to - from) / 60 }, (_, i) => from + i * 60);

  const columns = dates.map((d) => {
    const h = info.hours[dow(d)];
    const closed = !h || info.blocked_dates.includes(d);
    const off = closed
      ? `<div class="cal-off" style="top:0;height:${height}px"></div>`
      : `<div class="cal-off" style="top:0;height:${px(toMin(h[0]))}px"></div>` +
        `<div class="cal-off" style="top:${px(toMin(h[1]))}px;height:${height - px(toMin(h[1]))}px"></div>`;
    const events = layoutDay(bookings.filter((b) => b.date === d).map((b) => ({ b, start: toMin(b.time), end: toMin(b.end_time) })));
    return `
      <div class="cal-col" style="height:${height}px">
        ${off}
        ${events.map(({ b, start: s, end: e, col, cols }) => `
          <button class="ev st-${b.status}" data-ev="${b.id}"
            style="top:${px(s)}px;height:${Math.max(px(e) - px(s), 22) - 2}px;left:calc(${(col / cols) * 100}% + 2px);width:calc(${100 / cols}% - 4px)">
            <b>${b.time} ${esc(b.name)}</b>
            <small>${esc(b.procedure_name)}${isAdmin() && b.member_name ? ` · ${esc(b.member_name)}` : ''}</small>
          </button>`).join('')}
        ${d === info.today && nowMin >= from && nowMin <= to ? `<div class="cal-now" style="top:${px(nowMin)}px"></div>` : ''}
      </div>`;
  });

  $('#cal').innerHTML = `
    <div class="cal-grid" style="--days:${days}">
      <div class="cal-head">
        <div></div>
        ${dates.map((d) => `<div class="cal-dh ${d === info.today ? 'today' : ''}"><span>${DAYS_SHORT[dow(d)]}</span><b>${Number(d.slice(8))}</b></div>`).join('')}
      </div>
      <div class="cal-body">
        <div class="cal-times" style="height:${height}px">${hours.map((m) => `<span style="top:${px(m)}px">${String(m / 60).padStart(2, '0')}:00</span>`).join('')}</div>
        ${columns.join('')}
      </div>
    </div>`;
}

function openEvent(b) {
  const dlg = $('#ev-dialog');
  dlg.innerHTML = `
    <div class="ev-head st-${b.status}">
      <span class="badge b-${b.status}">${STATUS[b.status]}</span>
      <button class="ev-close" data-close aria-label="Zavrieť">×</button>
    </div>
    <h3>${esc(b.name)}</h3>
    <dl>
      <dt>Termín</dt><dd>${fmtDate(b.date)}, ${b.time} – ${b.end_time}</dd>
      <dt>Procedúra</dt><dd>${esc(b.procedure_name)} · ${eur(b.price)}</dd>
      ${b.room_name ? `<dt>Miestnosť</dt><dd>${esc(b.room_name)}</dd>` : ''}
      ${!isAdmin() ? '' : `<dt>Terapeut</dt><dd><select data-assign="${b.id}">${memberSelect(b.member_id)}</select></dd>`}
      ${b.email ? `<dt>E-mail</dt><dd><a href="mailto:${esc(b.email)}">${esc(b.email)}</a></dd>` : ''}
      ${b.phone ? `<dt>Telefón</dt><dd><a href="tel:${esc(b.phone.replace(/\s/g, ''))}">${esc(b.phone)}</a></dd>` : ''}
      ${b.note ? `<dt>Poznámka</dt><dd class="note">${esc(b.note)}</dd>` : ''}
    </dl>
    <div class="bk-actions">
      ${b.status === 'new' ? `<button class="btn btn-primary btn-sm" data-status="confirmed" data-id="${b.id}">Potvrdiť</button>` : ''}
      ${b.status === 'confirmed' ? `<button class="btn btn-ghost btn-sm" data-status="done" data-id="${b.id}">Dokončená</button>` : ''}
      ${b.status !== 'cancelled' && b.status !== 'done' ? `<button class="btn btn-ghost btn-sm" data-status="cancelled" data-id="${b.id}">Zrušiť</button>` : ''}
      ${b.status === 'cancelled' ? `<button class="btn btn-ghost btn-sm" data-status="new" data-id="${b.id}">Obnoviť</button>` : ''}
    </div>`;
  dlg.showModal();
}

$('#cal').addEventListener('click', (e) => {
  const ev = e.target.closest('[data-ev]');
  if (ev) openEvent(cal.bookings.find((b) => b.id === Number(ev.dataset.ev)));
});

$('#ev-dialog').addEventListener('click', guard(async (e) => {
  const dlg = $('#ev-dialog');
  // klik na pozadie alebo × zavrie
  if (e.target === dlg || e.target.closest('[data-close]')) return dlg.close();
  const btn = e.target.closest('[data-status]');
  if (!btn) return;
  await api(`/api/admin/bookings/${btn.dataset.id}`, { method: 'PATCH', body: { status: btn.dataset.status } });
  dlg.close();
  toast(`Stav zmenený: ${STATUS[btn.dataset.status]}`);
  loadCalendar();
}));

$('#ev-dialog').addEventListener('change', guard(async (e) => {
  const sel = e.target.closest('[data-assign]');
  if (!sel) return;
  await api(`/api/admin/bookings/${sel.dataset.assign}`, { method: 'PATCH', body: { member_id: sel.value ? Number(sel.value) : null } });
  $('#ev-dialog').close();
  toast('Terapeut zmenený');
  loadCalendar();
}));

const shiftCalendar = (dir) => {
  cal.start = addDays(cal.start, dir * cal.days);
  loadCalendar();
};
$('#cal-prev').addEventListener('click', () => shiftCalendar(-1));
$('#cal-next').addEventListener('click', () => shiftCalendar(1));
$('#cal-today').addEventListener('click', () => { cal.start = cal.info.today; loadCalendar(); });
$('#cal-member').addEventListener('change', loadCalendar);
$('#cal-cancelled').addEventListener('change', renderCalendar);

let resizeTimer;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!$('#tab-calendar').hidden && calDays() !== cal.days) loadCalendar();
  }, 200);
});

// ---------- procedúry a miestnosti ----------

let procedures = [];
let rooms = [];
const procForm = $('#proc-form');

$('#icon-select').innerHTML = Object.entries(ICON_LABELS).map(([k, label]) => `<option value="${k}">${label}</option>`).join('');

const loadProcedures = guard(async () => {
  [procedures, rooms] = await Promise.all([api('/api/admin/procedures'), api('/api/admin/rooms')]);
  $('#rooms').innerHTML = rooms.map((r) => `
    <span class="chip"><button type="button" class="chip-name" data-rename-room="${r.id}">${esc(r.name)}</button>
      <small>${r.procedures} proc.</small><button type="button" data-delete-room="${r.id}" aria-label="Vymazať">×</button></span>`
  ).join('') || '<span class="muted">Žiadne miestnosti – pridajte aspoň jednu.</span>';
  $('#room-select').innerHTML = rooms.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('');

  $('#procedures').innerHTML = procedures.map((p) => `
    <div class="pr ${p.active ? '' : 'off'}">
      <div class="ic">${icon(p.icon, 22)}</div>
      <div><b>${esc(p.name)}</b>${p.active ? '' : ' <span class="badge b-done">skrytá</span>'}<p>${esc(p.description)}</p>
        <p class="tags"><span>${esc(p.room_name || 'bez miestnosti')}</span>${
          p.members.length ? p.members.map((m) => `<span>${esc(m.name)}</span>`).join('') : '<span class="warn">bez terapeuta</span>'}</p></div>
      <div class="price">${eur(p.price)}<small>${p.duration_min} min</small></div>
      <div class="bk-actions pr-actions">
        <button class="btn btn-ghost btn-sm" data-edit="${p.id}">Upraviť</button>
        <button class="btn btn-danger btn-sm" data-delete-proc="${p.id}">Vymazať</button>
      </div>
    </div>`).join('') || '<div class="empty">Zatiaľ žiadne procedúry.</div>';
});

$('#room-form').addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  await api('/api/admin/rooms', { method: 'POST', body: { name: e.target.elements.name.value } });
  e.target.reset();
  toast('Miestnosť pridaná');
  loadProcedures();
}));

$('#rooms').addEventListener('click', guard(async (e) => {
  const rename = e.target.closest('[data-rename-room]');
  if (rename) {
    const room = rooms.find((r) => r.id === Number(rename.dataset.renameRoom));
    const name = prompt('Nový názov miestnosti:', room.name);
    if (!name || name === room.name) return;
    await api(`/api/admin/rooms/${room.id}`, { method: 'PUT', body: { name } });
    toast('Miestnosť premenovaná');
    return loadProcedures();
  }
  const del = e.target.closest('[data-delete-room]');
  if (del && confirm('Vymazať miestnosť?')) {
    await api(`/api/admin/rooms/${del.dataset.deleteRoom}`, { method: 'DELETE' });
    toast('Miestnosť vymazaná');
    loadProcedures();
  }
}));

function openProcForm(p) {
  procForm.reset();
  $('#proc-form-title').textContent = p ? 'Upraviť procedúru' : 'Nová procedúra';
  const f = procForm.elements;
  f.id.value = p?.id ?? '';
  f.name.value = p?.name ?? '';
  f.description.value = p?.description ?? '';
  f.duration_min.value = p?.duration_min ?? 30;
  f.price.value = p?.price ?? '';
  f.room_id.value = p?.room_id ?? rooms[0]?.id ?? '';
  f.icon.value = p?.icon ?? 'hand';
  f.sort.value = p?.sort ?? procedures.length;
  f.active.checked = p ? !!p.active : true;
  procForm.hidden = false;
  procForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
  f.name.focus();
}

$('#proc-new').addEventListener('click', () => openProcForm(null));
$('#proc-cancel').addEventListener('click', () => { procForm.hidden = true; });

procForm.addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  const f = procForm.elements;
  const body = {
    name: f.name.value, description: f.description.value, duration_min: f.duration_min.value,
    price: f.price.value, room_id: f.room_id.value, icon: f.icon.value, sort: f.sort.value, active: f.active.checked,
  };
  const id = f.id.value;
  await api(id ? `/api/admin/procedures/${id}` : '/api/admin/procedures', { method: id ? 'PUT' : 'POST', body });
  procForm.hidden = true;
  toast('Procedúra uložená');
  loadProcedures();
}));

$('#procedures').addEventListener('click', guard(async (e) => {
  const edit = e.target.closest('[data-edit]');
  if (edit) return openProcForm(procedures.find((p) => p.id === Number(edit.dataset.edit)));

  const del = e.target.closest('[data-delete-proc]');
  if (del && confirm('Vymazať procedúru? Existujúce rezervácie ostanú zachované. Ak ju chcete len dočasne skryť, použite „Upraviť“ a odškrtnite zobrazenie.')) {
    await api(`/api/admin/procedures/${del.dataset.deleteProc}`, { method: 'DELETE' });
    toast('Procedúra vymazaná');
    loadProcedures();
  }
}));

// ---------- tím ----------

let team = [];
// photo: undefined = bez zmeny, null = odstrániť, string = nová fotka (data URL)
let photoChange;
const memberForm = $('#member-form');

const loadTeam = guard(async () => {
  [team, procedures] = await Promise.all([api('/api/admin/team'), api('/api/admin/procedures')]);
  const procName = (id) => procedures.find((p) => p.id === id)?.name;
  $('#team').innerHTML = team.map((m) => `
    <div class="pr tm ${m.active ? '' : 'off'}">
      <div class="photo sm">${m.photo ? `<img src="${esc(m.photo)}" alt="">` : AVATAR}</div>
      <div><b>${esc(m.name)}</b>${m.active ? '' : ' <span class="badge b-done">neaktívny</span>'}<p>${esc(m.title)}</p>
        <p class="tags">${m.procedures.map((id) => `<span>${esc(procName(id))}</span>`).join('') || '<span class="warn">bez procedúr</span>'}
        ${m.logins.map((u) => `<span class="login-tag">👤 ${esc(u)}</span>`).join('')}</p></div>
      <div class="bk-actions pr-actions">
        <button class="btn btn-ghost btn-sm" data-edit-member="${m.id}">Upraviť</button>
        <button class="btn btn-danger btn-sm" data-delete-member="${m.id}">Vymazať</button>
      </div>
    </div>`).join('') || '<div class="empty">Zatiaľ žiadni členovia tímu.</div>';
});

function renderPhoto(src) {
  $('#photo-preview').innerHTML = src ? `<img src="${esc(src)}" alt="">` : AVATAR;
  $('#photo-remove').hidden = !src;
}

function openMemberForm(m) {
  memberForm.reset();
  photoChange = undefined;
  $('#member-form-title').textContent = m ? 'Upraviť člena tímu' : 'Nový člen tímu';
  const f = memberForm.elements;
  f.id.value = m?.id ?? '';
  f.name.value = m?.name ?? '';
  f.title.value = m?.title ?? '';
  f.sort.value = m?.sort ?? team.length;
  f.active.checked = m ? !!m.active : true;
  $('#member-procs').innerHTML = procedures.map((p) => `
    <label class="check"><input type="checkbox" value="${p.id}" ${m?.procedures.includes(p.id) ? 'checked' : ''}> ${esc(p.name)}</label>`
  ).join('') || '<span class="muted">Najprv vytvorte procedúry.</span>';
  renderPhoto(m?.photo);
  memberForm.hidden = false;
  memberForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
  f.name.focus();
}

// fotka sa v prehliadači oreže na 3:4 a zmenší, na server ide malý JPEG
function resizePhoto(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const W = 600, H = 800;
      const scale = Math.max(W / img.width, H / img.height);
      const canvas = Object.assign(document.createElement('canvas'), { width: W, height: H });
      canvas.getContext('2d').drawImage(img, (W - img.width * scale) / 2, (H - img.height * scale) / 2, img.width * scale, img.height * scale);
      URL.revokeObjectURL(img.src);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => reject(new Error('Súbor sa nepodarilo načítať ako obrázok.'));
    img.src = URL.createObjectURL(file);
  });
}

$('#photo-input').addEventListener('change', guard(async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  photoChange = await resizePhoto(file);
  renderPhoto(photoChange);
}));

$('#photo-remove').addEventListener('click', () => {
  photoChange = null;
  renderPhoto('');
});

$('#member-new').addEventListener('click', () => openMemberForm(null));
$('#member-cancel').addEventListener('click', () => { memberForm.hidden = true; });

memberForm.addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  const f = memberForm.elements;
  const body = {
    name: f.name.value, title: f.title.value, sort: f.sort.value, active: f.active.checked,
    procedures: [...$('#member-procs').querySelectorAll('input:checked')].map((i) => Number(i.value)),
  };
  if (photoChange !== undefined) body.photo = photoChange;
  const id = f.id.value;
  await api(id ? `/api/admin/team/${id}` : '/api/admin/team', { method: id ? 'PUT' : 'POST', body });
  memberForm.hidden = true;
  toast('Člen tímu uložený');
  loadTeam();
}));

$('#team').addEventListener('click', guard(async (e) => {
  const edit = e.target.closest('[data-edit-member]');
  if (edit) return openMemberForm(team.find((m) => m.id === Number(edit.dataset.editMember)));

  const del = e.target.closest('[data-delete-member]');
  if (del && confirm('Vymazať člena tímu? Jeho rezervácie ostanú, ale budú nepriradené.')) {
    await api(`/api/admin/team/${del.dataset.deleteMember}`, { method: 'DELETE' });
    toast('Člen tímu vymazaný');
    loadTeam();
  }
}));

// ---------- používatelia ----------

let users = [];
const userForm = $('#user-form');

const loadUsers = guard(async () => {
  [users, team, clients] = await Promise.all([api('/api/admin/users'), api('/api/admin/team'), api('/api/admin/clients')]);
  renderClients();
  $('#user-member').innerHTML = '<option value="">— žiadny —</option>' +
    team.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
  $('#users').innerHTML = users.map((u) => `
    <div class="pr us">
      <div class="ic">${u.role === 'admin' ? '★' : '👤'}</div>
      <div><b>${esc(u.username)}</b> <span class="badge ${u.role === 'admin' ? 'b-confirmed' : 'b-done'}">${ROLE[u.role]}</span>
        <p>${[
          u.member_name ? esc(u.member_name) : u.role === 'solver' && '<span class="warn">bez člena tímu</span>',
          u.email ? esc(u.email) : '<span class="warn">bez e-mailu</span>',
          u.id === me.id && 'to ste vy',
        ].filter(Boolean).join(' · ')}</p></div>
      <div class="bk-actions pr-actions">
        ${u.email ? `<button class="btn btn-ghost btn-sm" data-invite-user="${u.id}">Poslať odkaz na heslo</button>` : ''}
        <button class="btn btn-ghost btn-sm" data-edit-user="${u.id}">Upraviť</button>
        ${u.id === me.id ? '' : `<button class="btn btn-danger btn-sm" data-delete-user="${u.id}">Vymazať</button>`}
      </div>
    </div>`).join('');
});

function openUserForm(u) {
  userForm.reset();
  $('#user-form-title').textContent = u ? `Upraviť používateľa ${u.username}` : 'Nový používateľ';
  const f = userForm.elements;
  f.id.value = u?.id ?? '';
  f.username.value = u?.username ?? '';
  f.role.value = u?.role ?? 'solver';
  f.member_id.value = u?.member_id ?? '';
  f.email.value = u?.email ?? '';
  f.password.placeholder = u ? 'nechajte prázdne = bez zmeny' : 'nepovinné, ak zadáte e-mail';
  $('#pw-hint').textContent = u
    ? 'Heslo vyplňte len ak ho chcete zmeniť. Používateľovi s e-mailom môžete poslať odkaz na nastavenie hesla.'
    : 'Ak zadáte e-mail, príde naň uvítací e-mail s odkazom na nastavenie hesla (platí 3 dni). Heslo potom nemusíte vyplniť.';
  userForm.hidden = false;
  userForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
  f.username.focus();
}

$('#user-new').addEventListener('click', () => openUserForm(null));
$('#user-cancel').addEventListener('click', () => { userForm.hidden = true; });

userForm.addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  const f = userForm.elements;
  const body = {
    username: f.username.value, email: f.email.value, role: f.role.value,
    member_id: f.member_id.value || null, password: f.password.value,
  };
  const id = f.id.value;
  const result = await api(id ? `/api/admin/users/${id}` : '/api/admin/users', { method: id ? 'PUT' : 'POST', body });
  userForm.hidden = true;
  if (result.mailError) toast(`Používateľ vytvorený, ale e-mail sa nepodarilo odoslať: ${result.mailError}`, true);
  else toast(result.mailed ? `Používateľ vytvorený, e-mail odoslaný na ${body.email}` : 'Používateľ uložený');
  // zmena vlastnej roly sa prejaví hneď
  if (Number(id) === me.id) return showApp();
  loadUsers();
}));

$('#users').addEventListener('click', guard(async (e) => {
  const edit = e.target.closest('[data-edit-user]');
  if (edit) return openUserForm(users.find((u) => u.id === Number(edit.dataset.editUser)));

  const invite = e.target.closest('[data-invite-user]');
  if (invite) {
    const u = users.find((x) => x.id === Number(invite.dataset.inviteUser));
    if (!confirm(`Poslať ${u.email} odkaz na nastavenie hesla? Súčasné heslo bude platiť, kým si nastaví nové.`)) return;
    await api(`/api/admin/users/${u.id}/invite`, { method: 'POST' });
    return toast(`Odkaz odoslaný na ${u.email}`);
  }

  const del = e.target.closest('[data-delete-user]');
  if (del && confirm('Vymazať používateľa? Prihlásenie mu prestane fungovať.')) {
    await api(`/api/admin/users/${del.dataset.deleteUser}`, { method: 'DELETE' });
    toast('Používateľ vymazaný');
    loadUsers();
  }
}));

// ---------- klienti z webu ----------

let clients = [];
// časy z databázy sú v UTC („YYYY-MM-DD HH:MM:SS“)
const fmtStamp = (s) => new Date(s.replace(' ', 'T') + 'Z').toLocaleString('sk-SK', { dateStyle: 'short', timeStyle: 'short' });

function renderClients() {
  const q = $('#client-search').value.trim().toLowerCase();
  const shown = q
    ? clients.filter((c) => [c.name, c.email, c.phone].some((v) => v.toLowerCase().includes(q)))
    : clients;
  $('#clients-count').textContent = `(${clients.length})`;
  $('#clients').innerHTML = shown.map((c) => `
    <div class="pr us">
      <div class="ic">👤</div>
      <div><b>${esc(c.name)}</b>
        <p>${[esc(c.email), c.phone && esc(c.phone), `rezervácií: ${c.bookings}`].filter(Boolean).join(' · ')}</p>
        <p>Registrácia ${fmtStamp(c.created_at)} · súhlas GDPR ${fmtStamp(c.gdpr_consent_at)}</p></div>
      <div class="bk-actions pr-actions">
        <button class="btn btn-danger btn-sm" data-delete-client="${c.id}">Vymazať</button>
      </div>
    </div>`).join('') ||
    `<p class="muted">${clients.length ? 'Nič sa nenašlo.' : 'Zatiaľ sa nezaregistroval žiadny klient.'}</p>`;
}

$('#client-search').addEventListener('input', renderClients);

$('#clients').addEventListener('click', guard(async (e) => {
  const del = e.target.closest('[data-delete-client]');
  if (!del) return;
  const c = clients.find((x) => x.id === Number(del.dataset.deleteClient));
  if (!confirm(`Vymazať účet klienta ${c.name} (${c.email})? Údaje účtu sa natrvalo odstránia, rezervácie ostanú.`)) return;
  await api(`/api/admin/clients/${c.id}`, { method: 'DELETE' });
  toast('Klient vymazaný');
  loadUsers();
}));

// ---------- môj účet ----------

const profileForm = $('#profile-form');
// fotka profilu: undefined = bez zmeny, null = odstrániť, string = nová fotka (data URL)
let profilePhoto;

function renderProfilePhoto(src) {
  $('#profile-photo').innerHTML = src ? `<img src="${esc(src)}" alt="">` : AVATAR;
  $('#profile-photo-remove').hidden = !src;
}

function loadProfile() {
  const f = profileForm.elements;
  profilePhoto = undefined;
  f.name.value = me.name || '';
  f.username.value = me.username;
  f.email.value = me.email || '';
  f.phone.value = me.phone || '';
  renderProfilePhoto(me.photo);
  $('#profile-hint').textContent = me.member_id
    ? 'Meno a fotka sa zobrazujú na webe v sekcii Tím. E-mail a telefón vidí len administrácia.'
    : 'E-mail slúži na odkaz pri zabudnutom hesle a upozornenia.';
}

$('#me').addEventListener('click', () => openTab('account'));

$('#profile-photo-input').addEventListener('change', guard(async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  profilePhoto = await resizePhoto(file);
  renderProfilePhoto(profilePhoto);
}));

$('#profile-photo-remove').addEventListener('click', () => {
  profilePhoto = null;
  renderProfilePhoto('');
});

profileForm.addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  const f = profileForm.elements;
  const body = { name: f.name.value, email: f.email.value, phone: f.phone.value };
  if (profilePhoto !== undefined) body.photo = profilePhoto;
  me = await api('/api/admin/me/profile', { method: 'PUT', body });
  renderMe();
  loadProfile();
  toast('Profil uložený');
}));

$('#password-form').addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  if (f.password.value !== f.password2.value) throw new Error('Nové heslá sa nezhodujú.');
  await api('/api/admin/me/password', { method: 'PUT', body: { current: f.current.value, password: f.password.value } });
  e.target.reset();
  toast('Heslo zmenené');
}));

// ---------- nastavenia ----------

let blockedDates = [];
const settingsForm = $('#settings-form');

function renderBlocked() {
  $('#blocked').innerHTML = blockedDates.map((d) =>
    `<span class="chip">${fmtDate(d)}<button type="button" data-unblock="${d}" aria-label="Odstrániť">×</button></span>`
  ).join('') || '<span class="muted">Žiadne zatvorené dni.</span>';
}

const loadSettings = guard(async () => {
  const s = await api('/api/admin/settings');
  $('#hours').innerHTML = [1, 2, 3, 4, 5, 6, 0].map((d) => {
    const h = s.hours[d];
    return `
      <div class="hrow ${h ? '' : 'closed'}" data-day="${d}">
        <b>${DAYS[d]}</b>
        <label class="check"><input type="checkbox" ${h ? 'checked' : ''}> Otvorené</label>
        <div class="times">
          <input type="time" value="${h?.[0] ?? '08:00'}"> – <input type="time" value="${h?.[1] ?? '16:00'}">
        </div>
      </div>`;
  }).join('');
  settingsForm.elements.slot_step.value = s.slot_step;
  settingsForm.elements.max_days_ahead.value = s.max_days_ahead;
  settingsForm.elements.contact_phone.value = s.contact_phone ?? '';
  settingsForm.elements.site_url.value = s.site_url ?? '';
  settingsForm.elements.address.value = s.address ?? '';
  blockedDates = s.blocked_dates;
  renderBlocked();

  const mail = await api('/api/admin/mail');
  $('#mail-status').textContent = !mail.configured
    ? 'SMTP nie je nastavené – e-maily sa neodosielajú. Doplňte SMTP_* premenné do .env a reštartujte server.'
    : mail.adminEmail
      ? `Nové rezervácie chodia na ${mail.adminEmail}. Klient dostane e-mail pri prijatí, potvrdení a zrušení termínu.`
      : 'SMTP je nastavené, ale chýba ADMIN_EMAIL – upozornenia na nové rezervácie nechodia.';
  $('#mail-test').hidden = !(mail.configured && mail.adminEmail);
});

$('#mail-test').addEventListener('click', guard(async () => {
  await api('/api/admin/mail/test', { method: 'POST' });
  toast('Testovací e-mail odoslaný');
}));

$('#hours').addEventListener('change', (e) => {
  if (e.target.type === 'checkbox') e.target.closest('.hrow').classList.toggle('closed', !e.target.checked);
});

$('#blocked-add').addEventListener('click', () => {
  const d = $('#blocked-input').value;
  if (d && !blockedDates.includes(d)) {
    blockedDates = [...blockedDates, d].sort();
    renderBlocked();
  }
  $('#blocked-input').value = '';
});

$('#blocked').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-unblock]');
  if (!btn) return;
  blockedDates = blockedDates.filter((d) => d !== btn.dataset.unblock);
  renderBlocked();
});

settingsForm.addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  const hours = {};
  document.querySelectorAll('.hrow').forEach((row) => {
    const [open, close] = row.querySelectorAll('input[type=time]');
    hours[row.dataset.day] = row.querySelector('input[type=checkbox]').checked ? [open.value, close.value] : null;
  });
  await api('/api/admin/settings', {
    method: 'PUT',
    body: {
      hours,
      slot_step: Number(settingsForm.elements.slot_step.value),
      max_days_ahead: Number(settingsForm.elements.max_days_ahead.value),
      blocked_dates: blockedDates,
      contact_phone: settingsForm.elements.contact_phone.value,
      site_url: settingsForm.elements.site_url.value,
      address: settingsForm.elements.address.value,
    },
  });
  toast('Nastavenia uložené');
}));

// ---------- štart ----------

if (resetToken) {
  $('#reset').hidden = false;
} else {
  fetch('/api/admin/me').then((res) => (res.ok ? showApp() : showLogin()), showLogin);
}
