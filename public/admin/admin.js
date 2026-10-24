import { ICON_LABELS, icon } from '/js/icons.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const DAYS = ['Nedeľa', 'Pondelok', 'Utorok', 'Streda', 'Štvrtok', 'Piatok', 'Sobota'];
const DAYS_SHORT = ['Ne', 'Po', 'Ut', 'St', 'Št', 'Pi', 'So'];
const STATUS = { new: 'Nová', confirmed: 'Potvrdená', done: 'Dokončená', cancelled: 'Zrušená' };

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

function showLogin() {
  $('#app').hidden = true;
  $('#login').hidden = false;
}

function showApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  loadBookings();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-err').textContent = '';
  try {
    await api('/api/admin/login', { method: 'POST', body: { password: e.target.password.value } });
    e.target.reset();
    showApp();
  } catch (err) {
    $('#login-err').textContent = err.message;
  }
});

$('#logout').addEventListener('click', guard(async () => {
  await api('/api/admin/logout', { method: 'POST' });
  showLogin();
}));

// ---------- záložky ----------

const loaders = { bookings: () => loadBookings(), procedures: () => loadProcedures(), settings: () => loadSettings() };

document.querySelectorAll('[data-tab]').forEach((btn) => btn.addEventListener('click', () => {
  document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b === btn));
  for (const name of Object.keys(loaders)) $(`#tab-${name}`).hidden = name !== btn.dataset.tab;
  loaders[btn.dataset.tab]();
}));

// ---------- rezervácie ----------

const loadBookings = guard(async () => {
  const params = new URLSearchParams({ range: $('#f-range').value, status: $('#f-status').value });
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
        <p>${esc(b.procedure_name)} · ${eur(b.price)}</p>
        <p><a href="tel:${esc(b.phone.replace(/\s/g, ''))}">${esc(b.phone)}</a>${b.email ? ` · <a href="mailto:${esc(b.email)}">${esc(b.email)}</a>` : ''}</p>
        ${b.note ? `<p class="note">${esc(b.note)}</p>` : ''}
      </div>
      <div class="bk-actions">
        ${b.status === 'new' ? `<button class="btn btn-primary btn-sm" data-status="confirmed" data-id="${b.id}">Potvrdiť</button>` : ''}
        ${b.status === 'confirmed' ? `<button class="btn btn-ghost btn-sm" data-status="done" data-id="${b.id}">Dokončená</button>` : ''}
        ${b.status !== 'cancelled' && b.status !== 'done' ? `<button class="btn btn-ghost btn-sm" data-status="cancelled" data-id="${b.id}">Zrušiť</button>` : ''}
        ${b.status === 'cancelled' ? `<button class="btn btn-ghost btn-sm" data-status="new" data-id="${b.id}">Obnoviť</button>` : ''}
        <button class="btn btn-danger btn-sm" data-delete-booking="${b.id}">Vymazať</button>
      </div>
    </article>`).join('') || '<div class="empty">Žiadne rezervácie pre zvolený filter.</div>';
});

$('#f-range').addEventListener('change', loadBookings);
$('#f-status').addEventListener('change', loadBookings);
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

// ---------- procedúry ----------

let procedures = [];
const procForm = $('#proc-form');

$('#icon-select').innerHTML = Object.entries(ICON_LABELS).map(([k, label]) => `<option value="${k}">${label}</option>`).join('');

const loadProcedures = guard(async () => {
  procedures = await api('/api/admin/procedures');
  $('#procedures').innerHTML = procedures.map((p) => `
    <div class="pr ${p.active ? '' : 'off'}">
      <div class="ic">${icon(p.icon, 22)}</div>
      <div><b>${esc(p.name)}</b>${p.active ? '' : ' <span class="badge b-done">skrytá</span>'}<p>${esc(p.description)}</p></div>
      <div class="price">${eur(p.price)}<small>${p.duration_min} min</small></div>
      <div class="bk-actions pr-actions">
        <button class="btn btn-ghost btn-sm" data-edit="${p.id}">Upraviť</button>
        <button class="btn btn-danger btn-sm" data-delete-proc="${p.id}">Vymazať</button>
      </div>
    </div>`).join('') || '<div class="empty">Zatiaľ žiadne procedúry.</div>';
});

function openProcForm(p) {
  procForm.reset();
  $('#proc-form-title').textContent = p ? 'Upraviť procedúru' : 'Nová procedúra';
  const f = procForm.elements;
  f.id.value = p?.id ?? '';
  f.name.value = p?.name ?? '';
  f.description.value = p?.description ?? '';
  f.duration_min.value = p?.duration_min ?? 30;
  f.price.value = p?.price ?? '';
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
    price: f.price.value, icon: f.icon.value, sort: f.sort.value, active: f.active.checked,
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
    },
  });
  toast('Nastavenia uložené');
}));

// ---------- štart ----------

fetch('/api/admin/me').then((res) => (res.ok ? showApp() : showLogin()), showLogin);
