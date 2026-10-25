import { icon } from './icons.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const DAYS = ['Ne', 'Po', 'Ut', 'St', 'Št', 'Pi', 'So'];
const DAYS_LONG = ['nedeľa', 'pondelok', 'utorok', 'streda', 'štvrtok', 'piatok', 'sobota'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'máj', 'jún', 'júl', 'aug', 'sep', 'okt', 'nov', 'dec'];

const eur = (n) => n.toLocaleString('sk-SK', { style: 'currency', currency: 'EUR', minimumFractionDigits: n % 1 ? 2 : 0 });
const dow = (d) => new Date(d + 'T00:00:00Z').getUTCDay();
const addDays = (date, n) => {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const fmtDate = (d) => { const [y, m, day] = d.split('-').map(Number); return `${DAYS_LONG[dow(d)]} ${day}. ${m}. ${y}`; };

async function api(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Nastala chyba, skúste to znova.'), { status: res.status });
  return data;
}

const PHONE_PREFIX = '+4219';

const state = { procedures: [], team: [], info: null, proc: null, member: null, date: null, time: null, client: null };

function renderServices() {
  $('#services').innerHTML = state.procedures.map((p) => `
    <div class="card">
      <div class="icon">${icon(p.icon)}</div>
      <h3>${esc(p.name)}</h3>
      <p>${esc(p.description)}</p>
      <div class="card-foot">
        <span class="meta"><b>${eur(p.price)}</b>${p.duration_min} min</span>
        <button data-book="${p.id}">Objednať →</button>
      </div>
    </div>`).join('') || '<p class="loading">Momentálne nie sú dostupné žiadne procedúry.</p>';
}

const AVATAR = '<svg viewBox="0 0 100 100"><circle cx="50" cy="40" r="18"/><path d="M16 100c0-22 15-36 34-36s34 14 34 36z"/></svg>';

// člen tímu s vyplneným bio je tlačidlo, ktoré otvorí jeho profil
function renderTeam() {
  $('#tim').hidden = $('#menu-tim').hidden = !state.team.length;
  $('#team').innerHTML = state.team.map((m) => {
    const inner = `
      <div class="avatar">${m.photo ? `<img src="${esc(m.photo)}" alt="${esc(m.name)}" loading="lazy">` : AVATAR}</div>
      <h4>${esc(m.name)}</h4><span>${esc(m.title)}</span>`;
    return m.bio
      ? `<button type="button" class="member has-bio" data-profile="${m.id}">${inner}<em>Viac o mne →</em></button>`
      : `<div class="member">${inner}</div>`;
  }).join('');
}

// odseky oddelené prázdnym riadkom, jednotlivé riadky zalomené
const paragraphs = (text) => text.split(/\n\s*\n/).map((p) => `<p>${esc(p.trim()).replace(/\n/g, '<br>')}</p>`).join('');

// procedúry člena tímu, ktoré sú na webe aktívne
const memberProcedures = (m) => state.procedures.filter((p) => m.procedures.includes(p.id));

function openProfileCard(m) {
  const procs = memberProcedures(m);
  $('#therapist-body').innerHTML = `
    <div class="tp-photo">${m.photo ? `<img src="${esc(m.photo)}" alt="${esc(m.name)}">` : AVATAR}</div>
    <div class="tp-text">
      <span class="eyebrow">${esc(m.title)}</span>
      <h3 id="therapist-title">${esc(m.name)}</h3>
      <div class="tp-bio">${paragraphs(m.bio)}</div>
      ${procs.length ? `<h5>Procedúry</h5><ul class="tp-procs">${procs.map((p) => `<li>${esc(p.name)}</li>`).join('')}</ul>` : ''}
      ${procs.length ? `<button type="button" class="btn btn-primary" data-book-with="${m.id}">Objednať sa</button>` : ''}
    </div>`;
  $('#therapist').showModal();
}

// rezervácia u vybraného terapeuta: ak aktuálna procedúra nesedí, vyberie sa jeho prvá
function bookWith(m) {
  $('#therapist').close();
  state.member = m;
  if (state.proc && m.procedures.includes(state.proc.id)) {
    renderMembers();
    loadSlots();
  } else {
    selectProc(memberProcedures(m)[0].id);
  }
  $('#rezervacia').scrollIntoView({ behavior: 'smooth' });
}

$('#team').addEventListener('click', (e) => {
  const card = e.target.closest('[data-profile]');
  if (card) openProfileCard(state.team.find((m) => m.id === Number(card.dataset.profile)));
});
$('#therapist').addEventListener('click', (e) => {
  const book = e.target.closest('[data-book-with]');
  if (book) bookWith(state.team.find((m) => m.id === Number(book.dataset.bookWith)));
});

// terapeuti, ktorí robia vybranú procedúru; „Ktokoľvek“ nechá výber na serveri
function renderMembers() {
  if (!state.proc) {
    $('#members').innerHTML = '<p class="hint">Najprv vyberte procedúru.</p>';
    return;
  }
  const members = state.team.filter((m) => m.procedures.includes(state.proc.id));
  if (!members.some((m) => m.id === state.member?.id)) state.member = null;
  $('#members').innerHTML = [{ id: 0, name: 'Ktokoľvek', title: 'prvý voľný termín' }, ...members].map((m) => `
    <button class="person ${(state.member?.id ?? 0) === m.id ? 'sel' : ''}" data-member="${m.id}">
      <span class="ph ${m.id ? '' : 'any'}">${m.photo ? `<img src="${esc(m.photo)}" alt="">` : m.id ? AVATAR : '✦'}</span>
      <span><b>${esc(m.name)}</b><small>${esc(m.title)}</small></span>
    </button>`).join('');
}

// kontaktný telefón sa nastavuje v administrácii; bez neho sa sekcia „Radšej telefonicky?“ skryje
function renderContact() {
  const phone = state.info.contact_phone;
  $('#zavolat').hidden = !phone;
  document.querySelectorAll('[data-phone-item]').forEach((el) => { el.hidden = !phone; });
  document.querySelectorAll('[data-phone]').forEach((el) => { el.textContent = phone; });
  document.querySelectorAll('[data-phone-link]').forEach((el) => { el.href = `tel:${phone.replace(/\s/g, '')}`; });

  // mapa a navigácia podľa adresy z administrácie
  const { address } = state.info;
  $('#map').hidden = !address;
  if (!address) return;
  const q = encodeURIComponent(address);
  $('#address').textContent = address;
  $('#map iframe').src = `https://www.google.com/maps?q=${q}&z=15&output=embed`;
  $('#navigate').href = `https://www.google.com/maps/dir/?api=1&destination=${q}`;
}

function renderProcList() {
  $('#proc-list').innerHTML = state.procedures.map((p) => `
    <button class="proc ${state.proc?.id === p.id ? 'sel' : ''}" data-proc="${p.id}">
      <span class="pi">${icon(p.icon, 24)}</span>
      <span><b>${esc(p.name)}</b><small>${p.duration_min} min · ${eur(p.price)}</small></span>
    </button>`).join('');
}

function isClosed(d) {
  return !state.info.hours[dow(d)] || state.info.blocked_dates.includes(d);
}

function renderDays() {
  const { today, max_days_ahead } = state.info;
  let html = '';
  for (let i = 0; i <= max_days_ahead; i++) {
    const d = addDays(today, i);
    const [, m, day] = d.split('-').map(Number);
    html += `<button class="day ${state.date === d ? 'sel' : ''}" data-date="${d}" ${isClosed(d) ? 'disabled' : ''}>
      <small>${DAYS[dow(d)]}</small><b>${day}</b><small>${MONTHS[m - 1]}</small></button>`;
  }
  $('#days').innerHTML = html;
}

async function loadSlots() {
  const box = $('#slots');
  if (!state.proc || !state.date) {
    box.innerHTML = `<p class="hint">Najprv vyberte ${state.proc ? 'deň' : 'procedúru'}.</p>`;
    return;
  }
  box.innerHTML = '<p class="hint">Hľadám voľné termíny…</p>';
  try {
    const member = state.member ? `&member=${state.member.id}` : '';
    const slots = await api(`/api/slots?date=${state.date}&procedure=${state.proc.id}${member}`);
    if (!slots.includes(state.time)) state.time = null;
    box.innerHTML = slots.length
      ? slots.map((t) => `<button class="slot ${state.time === t ? 'sel' : ''}" data-time="${t}">${t}</button>`).join('')
      : '<p class="hint">Na tento deň už nie sú voľné termíny. Skúste iný deň.</p>';
  } catch (err) {
    box.innerHTML = `<p class="hint">${esc(err.message)}</p>`;
  }
  updateSummary();
}

function updateSummary() {
  const p = state.proc;
  $('#summary').innerHTML = `
    <dt>Procedúra</dt><dd>${p ? esc(p.name) : '—'}</dd>
    <dt>Terapeut</dt><dd>${state.member ? esc(state.member.name) : 'ktokoľvek'}</dd>
    <dt>Deň</dt><dd>${state.date ? fmtDate(state.date) : '—'}</dd>
    <dt>Čas</dt><dd>${state.time || '—'}</dd>
    <dt>Trvanie</dt><dd>${p ? p.duration_min + ' min' : '—'}</dd>
    <dt class="total">Cena</dt><dd class="total">${p ? eur(p.price) : '—'}</dd>`;
  $('#submit').disabled = !(p && state.date && state.time);
}

function selectProc(id) {
  state.proc = state.procedures.find((p) => p.id === id) || null;
  renderProcList();
  renderMembers();
  loadSlots();
}

function renderHours() {
  const order = [1, 2, 3, 4, 5, 6, 0];
  $('#hours').innerHTML = order.map((d) => {
    const h = state.info.hours[d];
    return `<li><span>${DAYS[d]}</span><span>${h ? `${h[0]}–${h[1]}` : 'zatvorené'}</span></li>`;
  }).join('');
}

document.addEventListener('click', (e) => {
  const book = e.target.closest('[data-book]');
  if (book) {
    selectProc(Number(book.dataset.book));
    $('#rezervacia').scrollIntoView({ behavior: 'smooth' });
    return;
  }
  const proc = e.target.closest('[data-proc]');
  if (proc) return selectProc(Number(proc.dataset.proc));

  const member = e.target.closest('[data-member]');
  if (member) {
    state.member = state.team.find((m) => m.id === Number(member.dataset.member)) || null;
    renderMembers();
    return loadSlots();
  }

  const day = e.target.closest('[data-date]');
  if (day) {
    state.date = day.dataset.date;
    document.querySelectorAll('.day').forEach((el) => el.classList.toggle('sel', el === day));
    return loadSlots();
  }
  const slot = e.target.closest('[data-time]');
  if (slot) {
    state.time = slot.dataset.time;
    document.querySelectorAll('.slot').forEach((el) => el.classList.toggle('sel', el === slot));
    updateSummary();
  }
});

$('#submit').addEventListener('click', async () => {
  const form = $('#contact');
  $('#err').textContent = '';
  // predvyplnená predvoľba bez ďalších číslic znamená, že telefón nie je zadaný
  const phone = form.elements.phone;
  if (phone.value.trim() === PHONE_PREFIX) phone.value = '';
  const valid = form.reportValidity();
  if (!phone.value) phone.value = PHONE_PREFIX;
  if (!valid) return;

  const btn = $('#submit');
  btn.disabled = true;
  btn.textContent = 'Odosielam…';
  try {
    const booking = await api('/api/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        procedure_id: state.proc.id, member_id: state.member?.id, date: state.date, time: state.time,
        ...Object.fromEntries(new FormData(form)),
        phone: phone.value.trim() === PHONE_PREFIX ? '' : phone.value,
      }),
    });
    $('#done-text').textContent =
      `${state.proc.name}${booking.member_name ? ` (${booking.member_name})` : ''}, ${fmtDate(state.date)} o ${state.time}. ` +
      'Čoskoro sa vám ozveme s potvrdením termínu.';
    $('#done').showModal();
    form.reset();
    fillContact();
    loadMyBookings();
  } catch (err) {
    $('#err').textContent = err.message;
    if (err.status === 409) loadSlots();
  } finally {
    btn.textContent = 'Potvrdiť rezerváciu';
    updateSummary();
  }
});

// potvrdenie sa zatvára len tlačidlom OK, nie klávesom Esc
$('#done').addEventListener('cancel', (e) => e.preventDefault());
$('#done-ok').addEventListener('click', () => $('#done').close());
$('#done').addEventListener('close', () => {
  state.time = null;
  loadSlots();
});

// ---------- klientsky účet ----------

const send = (url, method, body) =>
  api(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function renderAccount() {
  const c = state.client;
  $('#account').textContent = c ? 'Môj účet' : 'Prihlásiť sa';
  $('#account-hint').innerHTML = c
    ? `Ste prihlásení ako <b>${esc(c.name)}</b> – údaje sme vyplnili z vášho účtu.`
    : 'Máte účet? <button type="button" class="link" data-auth="login">Prihláste sa</button> alebo sa ' +
      '<button type="button" class="link" data-auth="register">zaregistrujte</button> a údaje sa vyplnia samé.';
}

// údaje z účtu do formulára rezervácie
function fillContact() {
  const c = state.client;
  if (!c) return;
  const f = $('#contact').elements;
  f.name.value = c.name;
  f.email.value = c.email;
  f.phone.value = c.phone || PHONE_PREFIX;
}

function setClient(client) {
  state.client = client;
  renderAccount();
  fillContact();
  loadMyBookings();
}

// ---------- moje rezervácie (kalendár prihláseného klienta) ----------

const MONTHS_LONG = ['január', 'február', 'marec', 'apríl', 'máj', 'jún', 'júl', 'august', 'september', 'október', 'november', 'december'];
const STATUS = { new: 'Čaká na potvrdenie', confirmed: 'Potvrdená', done: 'Absolvovaná', cancelled: 'Zrušená' };
// month = zobrazený mesiac (YYYY-MM), day = vybraný deň alebo null = celý mesiac
const cal = { month: null, day: null };
let myBookings = [];

async function loadMyBookings() {
  $('#moje-rezervacie').hidden = $('#menu-moje').hidden = !state.client;
  if (!state.client) return;
  try {
    myBookings = await api('/api/client/bookings');
  } catch {
    myBookings = [];
  }
  renderMyCalendar();
}

function renderMyCalendar() {
  const today = state.info?.today ?? new Date().toISOString().slice(0, 10);
  cal.month ??= today.slice(0, 7);
  const [y, m] = cal.month.split('-').map(Number);
  $('#cal-title').textContent = `${MONTHS_LONG[m - 1]} ${y}`;

  const byDate = new Map();
  for (const b of myBookings) byDate.set(b.date, [...(byDate.get(b.date) || []), b]);

  // 6 týždňov od pondelka pred prvým dňom mesiaca
  const first = `${cal.month}-01`;
  const start = addDays(first, -((dow(first) + 6) % 7));
  let html = [1, 2, 3, 4, 5, 6, 0].map((d) => `<span class="wd">${DAYS[d]}</span>`).join('');
  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);
    const list = byDate.get(d) || [];
    const cls = [d.slice(0, 7) !== cal.month && 'out', d === today && 'today', d === cal.day && 'sel', list.length && 'has']
      .filter(Boolean).join(' ');
    html += `<button type="button" class="cd ${cls}" data-cal-day="${d}" ${list.length ? '' : 'disabled'}>
      <span>${Number(d.slice(8))}</span>${list.length ? `<i>${list.map((b) => `<em class="st-${b.status}"></em>`).join('')}</i>` : ''}</button>`;
  }
  $('#cal-grid').innerHTML = html;

  const shown = cal.day ? byDate.get(cal.day) || [] : myBookings.filter((b) => b.date.startsWith(cal.month));
  const title = cal.day ? fmtDate(cal.day) : `${MONTHS_LONG[m - 1]} ${y}`;
  const empty = myBookings.length
    ? 'V tomto mesiaci nemáte žiadne rezervácie.'
    : 'Zatiaľ nemáte žiadne rezervácie. <a href="#rezervacia">Objednajte sa online.</a>';
  $('#my-list').innerHTML = `
    <h3>${esc(title)}${cal.day ? ' <button type="button" class="link" data-cal-all>celý mesiac</button>' : ''}</h3>
    ${shown.map((b) => {
      const [, bm, bd] = b.date.split('-').map(Number);
      // dnešný termín, ktorý už začal, odmietne server
      const cancellable = ['new', 'confirmed'].includes(b.status) && b.date >= today;
      return `
      <div class="mb ${b.date < today || b.status === 'cancelled' ? 'past' : ''}">
        <div class="when"><small>${DAYS[dow(b.date)]}</small><b>${bd}</b><small>${MONTHS[bm - 1]}</small></div>
        <div>
          <h4>${esc(b.procedure_name)}</h4>
          <p>${b.time} – ${b.end_time}${b.member_name ? ` · ${esc(b.member_name)}` : ''} · ${eur(b.price)}</p>
          ${b.cancel_reason ? `<p class="reason">Dôvod zrušenia: ${esc(b.cancel_reason)}</p>` : ''}
        </div>
        <div class="mb-side">
          <span class="badge st-${b.status}">${STATUS[b.status] ?? esc(b.status)}</span>
          ${cancellable ? `<button type="button" class="link" data-cancel="${b.id}">Zrušiť termín</button>` : ''}
        </div>
      </div>`;
    }).join('') || `<p class="hint">${empty}</p>`}`;
}

$('#cal-prev').addEventListener('click', () => shiftMonth(-1));
$('#cal-next').addEventListener('click', () => shiftMonth(1));

function shiftMonth(n) {
  const [y, m] = cal.month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  cal.month = d.toISOString().slice(0, 7);
  cal.day = null;
  renderMyCalendar();
}

let cancelId = null;

function openCancel(b) {
  cancelId = b.id;
  $('#cancel-what').textContent = `${b.procedure_name}, ${fmtDate(b.date)} o ${b.time}${b.member_name ? ` (${b.member_name})` : ''}`;
  $('#cancel-form').reset();
  $('#cancel-form .form-err').textContent = '';
  $('#cancel').showModal();
}

onSubmit($('#cancel-form'), async (data) => {
  await send(`/api/client/bookings/${cancelId}/cancel`, 'POST', data);
  $('#cancel').close();
  await loadMyBookings();
  // zrušený termín sa uvoľnil – ak je otvorený rovnaký deň, obnoví sa ponuka časov
  loadSlots();
  notice('Rezervácia je zrušená', 'Termín sme zrušili a vašu správu sme odoslali recepcii aj terapeutovi. Potvrdenie vám príde e-mailom.');
});

$('#moje-rezervacie').addEventListener('click', (e) => {
  const cancel = e.target.closest('[data-cancel]');
  if (cancel) return openCancel(myBookings.find((b) => b.id === Number(cancel.dataset.cancel)));
  if (e.target.closest('[data-cal-all]')) {
    cal.day = null;
    return renderMyCalendar();
  }
  const day = e.target.closest('[data-cal-day]');
  if (!day) return;
  const d = day.dataset.calDay;
  cal.day = cal.day === d ? null : d;
  cal.month = d.slice(0, 7);
  renderMyCalendar();
});

// tab: login | register | forgot (zabudnuté heslo nemá vlastnú záložku)
function showTab(tab) {
  document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('sel', b.dataset.tab === tab));
  $('#login-form').hidden = tab !== 'login';
  $('#register-form').hidden = tab !== 'register';
  $('#forgot-form').hidden = tab !== 'forgot';
  // e-mail z prihlásenia sa prenesie do formulára zabudnutého hesla
  if (tab === 'forgot') $('#forgot-form').elements.email.value ||= $('#login-form').elements.email.value;
}

function openAuth(tab) {
  showTab(tab);
  $('#auth').querySelectorAll('.form-err').forEach((el) => { el.textContent = ''; });
  // prepnutie na zabudnuté heslo prebieha v už otvorenom okne
  if (!$('#auth').open) $('#auth').showModal();
}

function openProfile() {
  const f = $('#profile-form');
  f.elements.name.value = state.client.name;
  f.elements.email.value = state.client.email;
  f.elements.phone.value = state.client.phone;
  $('#profile').querySelectorAll('.form-err').forEach((el) => { el.textContent = ''; });
  $('#delete-form').reset();
  $('.delete-account').open = false;
  $('#profile').showModal();
}

// spoločné odoslanie formulárov účtu: kontrola polí, zablokovanie tlačidla, chyba pod formulárom
function onSubmit(form, handler) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = form.querySelector('.form-err');
    err.textContent = '';
    if (!form.reportValidity()) return;
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      await handler(Object.fromEntries(new FormData(form)));
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      btn.disabled = false;
      // formulár mohol byť medzitým vyprázdnený – nech si stav tlačidla prepočíta (súhlas pri registrácii)
      form.dispatchEvent(new Event('change'));
    }
  });
}

onSubmit($('#login-form'), async (data) => {
  setClient(await send('/api/client/login', 'POST', data));
  $('#login-form').reset();
  $('#auth').close();
});

// bez potvrdenia súhlasu GDPR sa registrácia nedá odoslať (overuje aj server)
const registerForm = $('#register-form');
const gdpr = registerForm.elements.gdpr;
registerForm.addEventListener('change', () => { registerForm.querySelector('button').disabled = !gdpr.checked; });

function notice(title, text, ok = true) {
  $('#notice-icon').textContent = ok ? '✓' : '!';
  $('#notice-title').textContent = title;
  $('#notice-text').textContent = text;
  $('#notice').showModal();
}

// po registrácii sa klient neprihlási – najprv musí potvrdiť e-mail odkazom
// zopakované heslo sa musí zhodovať – prehliadač chybu ukáže pri odoslaní (reportValidity)
function matchPasswords(form) {
  const { password, password2 } = form.elements;
  const check = () => {
    password2.setCustomValidity(password2.value && password2.value !== password.value ? 'Heslá sa nezhodujú.' : '');
  };
  password.addEventListener('input', check);
  password2.addEventListener('input', check);
}
matchPasswords(registerForm);
matchPasswords($('#reset-form'));

onSubmit($('#forgot-form'), async (data) => {
  await send('/api/client/forgot', 'POST', data);
  $('#forgot-form').reset();
  $('#auth').close();
  notice('Skontrolujte e-mail',
    `Ak u nás existuje účet s adresou ${data.email}, poslali sme naň odkaz na nastavenie nového hesla. ` +
    'Odkaz platí 2 hodiny – ak e-mail nevidíte, pozrite aj priečinok so spamom.');
});

// token z odkazu #nove-heslo=… (nastaví sa pri načítaní stránky)
let resetToken = null;

onSubmit($('#reset-form'), async (data) => {
  setClient(await send('/api/client/reset', 'POST', { ...data, token: resetToken }));
  $('#reset-form').reset();
  $('#reset').close();
  notice('Heslo je zmenené', `Vitajte späť, ${state.client.name}! Ste prihlásení s novým heslom.`);
});

onSubmit(registerForm, async (data) => {
  if (!gdpr.checked) throw new Error('Pre registráciu musíte súhlasiť so spracúvaním osobných údajov.');
  const { email } = await send('/api/client/register', 'POST', { ...data, gdpr: true });
  registerForm.reset();
  $('#auth').close();
  notice('Registrácia prebehla úspešne',
    `Na adresu ${email} sme poslali e-mail s odkazom na potvrdenie účtu. Po kliknutí na odkaz budete prihlásení. ` +
    'Odkaz platí 3 dni – ak e-mail nevidíte, pozrite aj priečinok so spamom.');
});

onSubmit($('#profile-form'), async (data) => {
  setClient(await send('/api/client/me', 'PUT', data));
  $('#profile').close();
});

onSubmit($('#delete-form'), async (data) => {
  if (!confirm('Naozaj chcete natrvalo zrušiť účet?')) return;
  await send('/api/client/me', 'DELETE', data);
  setClient(null);
  $('#contact').reset();
  $('#profile').close();
});

$('#logout').addEventListener('click', async () => {
  await send('/api/client/logout', 'POST', {}).catch(() => {});
  setClient(null);
  $('#contact').reset();
  $('#profile').close();
});

$('#account').addEventListener('click', () => (state.client ? openProfile() : openAuth('login')));

document.addEventListener('click', (e) => {
  const auth = e.target.closest('[data-auth]');
  if (auth) return openAuth(auth.dataset.auth);
  const tab = e.target.closest('[data-tab]');
  if (tab) return showTab(tab.dataset.tab);
  if (e.target.closest('[data-privacy]')) {
    e.preventDefault();
    return $('#privacy').showModal();
  }
  const close = e.target.closest('[data-close]');
  if (close) close.closest('dialog').close();
});

renderAccount();
// odkaz z e-mailu: /#overenie=<token>
const verifyToken = /^#overenie=([\w-]+)$/.exec(location.hash)?.[1];
if (verifyToken) {
  history.replaceState(null, '', location.pathname + location.search);
  send('/api/client/verify', 'POST', { token: verifyToken }).then(
    ({ client }) => {
      if (!client) return notice('Účet je už potvrdený', 'Prihláste sa e-mailom a heslom, ktoré ste zadali pri registrácii.');
      setClient(client);
      notice('Účet je potvrdený', `Vitajte, ${client.name}! Ste prihlásení a pri rezervácii sa vaše údaje vyplnia automaticky.`);
    },
    (err) => notice('Účet sa nepodarilo potvrdiť', err.message, false)
  );
} else {
  api('/api/client/me').then(setClient).catch(() => {});
  // odkaz zo zabudnutého hesla: /#nove-heslo=<token>
  resetToken = /^#nove-heslo=([\w-]+)$/.exec(location.hash)?.[1] ?? null;
  if (resetToken) {
    history.replaceState(null, '', location.pathname + location.search);
    $('#reset').showModal();
  }
}

const burger = $('#burger'), menu = $('#menu');
burger.addEventListener('click', () => { burger.classList.toggle('open'); menu.classList.toggle('open'); });
menu.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => {
  burger.classList.remove('open');
  menu.classList.remove('open');
}));

try {
  [state.procedures, state.info, state.team] = await Promise.all([api('/api/procedures'), api('/api/info'), api('/api/team')]);
  renderServices();
  renderTeam();
  renderContact();
  renderProcList();
  renderDays();
  renderHours();
  updateSummary();
} catch {
  $('#services').innerHTML = '<p class="loading">Procedúry sa nepodarilo načítať. Obnovte stránku.</p>';
}
