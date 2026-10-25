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

const state = { procedures: [], team: [], info: null, proc: null, member: null, date: null, time: null };

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

function renderTeam() {
  $('#tim').hidden = $('#menu-tim').hidden = !state.team.length;
  $('#team').innerHTML = state.team.map((m) => `
    <div class="member">
      <div class="avatar">${m.photo ? `<img src="${esc(m.photo)}" alt="${esc(m.name)}" loading="lazy">` : AVATAR}</div>
      <h4>${esc(m.name)}</h4><span>${esc(m.title)}</span>
    </div>`).join('');
}

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
  if (!form.reportValidity()) return;

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
      }),
    });
    $('#done-text').textContent =
      `${state.proc.name}${booking.member_name ? ` (${booking.member_name})` : ''}, ${fmtDate(state.date)} o ${state.time}. ` +
      'Čoskoro sa vám ozveme s potvrdením termínu.';
    $('#done').showModal();
    form.reset();
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
  renderProcList();
  renderDays();
  renderHours();
  updateSummary();
} catch {
  $('#services').innerHTML = '<p class="loading">Procedúry sa nepodarilo načítať. Obnovte stránku.</p>';
}
