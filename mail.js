import nodemailer from 'nodemailer';
import { getSettings } from './db.js';

const {
  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE,
  MAIL_FROM, ADMIN_EMAIL, SITE_NAME = 'FYZIO Stupava',
} = process.env;

const port = Number(SMTP_PORT) || 587;
const transport = SMTP_HOST
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port,
      secure: SMTP_SECURE ? SMTP_SECURE === 'true' : port === 465,
      auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
      // interný relay (smtp-relay) bez prihlásenia často ponúka STARTTLS so self-signed certifikátom
      tls: SMTP_USER ? undefined : { rejectUnauthorized: false },
    })
  : null;

export const mailStatus = { configured: !!transport, adminEmail: ADMIN_EMAIL || '' };

if (!transport) {
  console.warn('SMTP nie je nastavené – e-maily sa neodosielajú.');
} else {
  transport.verify().then(
    () => console.log(`SMTP pripojené (${SMTP_HOST}:${port})`),
    (err) => console.error(`SMTP chyba (${SMTP_HOST}:${port}):`, err.message)
  );
  if (!MAIL_FROM && !SMTP_USER) console.warn('MAIL_FROM nie je nastavené – relay môže e-maily bez odosielateľa odmietnuť.');
  if (!ADMIN_EMAIL) console.warn('ADMIN_EMAIL nie je nastavené – upozornenia na nové rezervácie sa neodosielajú.');
}

const DAYS = ['nedeľa', 'pondelok', 'utorok', 'streda', 'štvrtok', 'piatok', 'sobota'];
const fmtDate = (d) => {
  const [y, m, day] = d.split('-').map(Number);
  return `${DAYS[new Date(d + 'T00:00:00Z').getUTCDay()]} ${day}. ${m}. ${y}`;
};
const eur = (n) => n.toLocaleString('sk-SK', { style: 'currency', currency: 'EUR' });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// telefón a adresa webu sa nastavujú v administrácii, preto sa čítajú pri každom e-maile
const contact = () => {
  const { contact_phone, site_url } = getSettings();
  return { phone: contact_phone, url: site_url.replace(/\/$/, '') };
};
const signature = () => {
  const { phone, url } = contact();
  return `\n\n${SITE_NAME}${phone ? `\nTel.: ${phone}` : ''}${url ? `\n${url}` : ''}`;
};

const details = (b) => [
  ['Procedúra', b.procedure_name],
  ['Termín', `${fmtDate(b.date)}, ${b.time} – ${b.end_time}`],
  ...(b.member_name ? [['Terapeut', b.member_name]] : []),
  ['Cena', eur(b.price)],
];
const summary = (b) => details(b).map(([k, v]) => `${(k + ':').padEnd(11)}${v}`).join('\n');

// ---------- HTML e-maily pre klientov (farby webu, tabuľky a inline štýly kvôli e-mailovým klientom) ----------

const C = {
  ink: '#2e2a26', text: '#3a3530', muted: '#7d7469', taupe: '#c5b9a8', taupeD: '#8e8172',
  linen: '#ebe5dc', shell: '#f4f0ea', cream: '#faf8f4', brass: '#a8875a',
};
const SERIF = "'Playfair Display',Georgia,'Times New Roman',serif";
const SANS = "Jost,'Helvetica Neue',Helvetica,Arial,sans-serif";

function emailHtml({ preheader, eyebrow, title, name, lines, rows: items, button, footnote }) {
  const rows = items.map(([k, v], i) => `
    <tr>
      <td style="padding:12px 0;${i ? `border-top:1px solid ${C.linen};` : ''}font:500 11px/1.4 ${SANS};letter-spacing:2px;text-transform:uppercase;color:${C.taupeD};width:120px;padding-right:12px;vertical-align:top">${k}</td>
      <td style="padding:12px 0;${i ? `border-top:1px solid ${C.linen};` : ''}font:400 16px/1.4 ${SANS};color:${C.ink}">${esc(v)}</td>
    </tr>`).join('');
  const { phone, url } = contact();
  const links = [
    phone && `<a href="tel:${esc(phone.replace(/\s/g, ''))}" style="color:${C.cream};text-decoration:none">${esc(phone)}</a>`,
    url && `<a href="${esc(url)}" style="color:${C.cream};text-decoration:none">${esc(url.replace(/^https?:\/\//, ''))}</a>`,
  ].filter(Boolean).join(' &nbsp;·&nbsp; ');

  return `<!doctype html>
<html lang="sk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:${C.shell}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.shell}">
<tr><td align="center" style="padding:32px 12px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
    <tr><td align="center" style="padding:8px 0 28px">
      <div style="font:500 26px/1 ${SERIF};letter-spacing:9px;color:${C.ink};padding-left:9px">FYZIO</div>
      <div style="font:600 9px/1 ${SANS};letter-spacing:3px;text-transform:uppercase;color:${C.taupeD};margin-top:8px">Move to health</div>
    </td></tr>
    <tr><td style="background:${C.taupe};border-radius:280px 280px 0 0;padding:56px 40px 36px;text-align:center">
      <div style="font:500 11px/1 ${SANS};letter-spacing:3px;text-transform:uppercase;color:${C.ink};opacity:.75">${esc(eyebrow)}</div>
      <h1 style="margin:14px 0 0;font:500 28px/1.2 ${SERIF};text-transform:uppercase;letter-spacing:.5px;color:${C.ink}">${esc(title)}</h1>
    </td></tr>
    <tr><td style="background:#ffffff;padding:36px 40px 12px">
      <p style="margin:0 0 14px;font:400 16px/1.6 ${SANS};color:${C.text}">Dobrý deň, ${esc(name)},</p>
      ${lines.map((l) => `<p style="margin:0 0 14px;font:300 16px/1.6 ${SANS};color:${C.text}">${l}</p>`).join('')}
    </td></tr>
    <tr><td style="background:#ffffff;padding:8px 40px 28px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.cream};border:1px solid ${C.linen}">
        <tr><td style="padding:10px 24px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
        </td></tr>
      </table>
    </td></tr>
    ${button ? `<tr><td align="center" style="background:#ffffff;padding:4px 40px 40px">
      <a href="${esc(button.href)}" style="display:inline-block;background:${C.ink};color:${C.cream};font:500 12px/1 ${SANS};letter-spacing:2.5px;text-transform:uppercase;text-decoration:none;padding:16px 32px">${esc(button.label)}</a>
    </td></tr>` : '<tr><td style="background:#ffffff;padding:0 0 12px"></td></tr>'}
    <tr><td style="background:${C.ink};padding:28px 40px;text-align:center">
      <div style="font:500 16px/1 ${SERIF};letter-spacing:6px;color:${C.cream};padding-left:6px">FYZIO</div>
      <div style="font:300 13px/1.7 ${SANS};color:#b3a99c;margin-top:12px">${esc(SITE_NAME)}${links ? `<br>${links}` : ''}</div>
    </td></tr>
    <tr><td align="center" style="padding:18px 20px;font:300 12px/1.6 ${SANS};color:${C.muted}">
      ${esc(footnote)}
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;
}

const callButton = () => {
  const { phone } = contact();
  return phone ? { label: 'Zavolať', href: `tel:${phone.replace(/\s/g, '')}` } : null;
};

const BOOKING_FOOTNOTE = 'Tento e-mail bol odoslaný automaticky po rezervácii termínu.';

// e-maily pre klienta: { subject, text, html }
export const clientEmails = {
  received: (b) => ({
    subject: `Prijali sme vašu rezerváciu – ${SITE_NAME}`,
    text: `Dobrý deň, ${b.name},\n\nďakujeme za rezerváciu. Termín vám čoskoro potvrdíme.\n\n${summary(b)}` +
      `\n\nAk potrebujete termín zmeniť alebo zrušiť, ozvite sa nám prosím.${signature()}`,
    html: emailHtml({
      preheader: `${b.procedure_name}, ${fmtDate(b.date)} o ${b.time} – termín vám čoskoro potvrdíme.`,
      eyebrow: 'Rezervácia prijatá', title: 'Ďakujeme za rezerváciu', name: b.name, rows: details(b), footnote: BOOKING_FOOTNOTE,
      lines: ['vašu rezerváciu sme prijali. Termín vám čoskoro potvrdíme ďalším e-mailom.',
        'Ak potrebujete termín zmeniť alebo zrušiť, ozvite sa nám prosím.'],
      button: callButton(),
    }),
  }),
  confirmed: (b) => ({
    subject: `Termín potvrdený – ${fmtDate(b.date)} ${b.time}`,
    text: `Dobrý deň, ${b.name},\n\nváš termín je potvrdený. Tešíme sa na vás.\n\n${summary(b)}` +
      `\n\nPrineste si prosím pohodlné oblečenie a prípadné lekárske správy.${signature()}`,
    html: emailHtml({
      preheader: `Tešíme sa na vás ${fmtDate(b.date)} o ${b.time}.`,
      eyebrow: 'Termín potvrdený', title: 'Tešíme sa na vás', name: b.name, rows: details(b), footnote: BOOKING_FOOTNOTE,
      lines: ['váš termín je potvrdený.',
        'Prineste si prosím pohodlné oblečenie a prípadné lekárske správy. Ak by ste nemohli prísť, dajte nám vedieť čo najskôr.'],
      button: callButton(),
    }),
  }),
  cancelled: (b) => ({
    subject: `Termín zrušený – ${fmtDate(b.date)} ${b.time}`,
    text: `Dobrý deň, ${b.name},\n\nváš termín bol zrušený.\n\n${summary(b)}` +
      `\n\nNový termín si môžete rezervovať online${contact().url ? ` na ${contact().url}` : ''} alebo nám zavolajte.${signature()}`,
    html: emailHtml({
      preheader: `Termín ${fmtDate(b.date)} o ${b.time} bol zrušený.`,
      eyebrow: 'Termín zrušený', title: 'Váš termín bol zrušený', name: b.name, rows: details(b), footnote: BOOKING_FOOTNOTE,
      lines: ['váš termín bol zrušený.', 'Nový termín si môžete rezervovať online alebo nám zavolajte.'],
      button: contact().url ? { label: 'Rezervovať nový termín', href: `${contact().url}/#rezervacia` } : callButton(),
    }),
  }),
};

export async function sendMail(to, subject, text, html) {
  if (!transport) throw new Error('SMTP nie je nastavené.');
  await transport.sendMail({ from: MAIL_FROM || SMTP_USER, to, subject, text, html });
}

const ROLE_NAMES = { admin: 'Admin', solver: 'Terapeut' };

// Pozvánka do administrácie s odkazom na nastavenie hesla; chyba sa vráti volajúcemu
export async function sendAccountInvite(user, link, isNew) {
  const name = user.member_name || user.username;
  const title = isNew ? 'Vitajte v tíme' : 'Nastavenie hesla';
  const intro = isNew
    ? `bol vám vytvorený účet do administrácie ${SITE_NAME}. Heslo si nastavíte cez tlačidlo nižšie.`
    : 'posielame vám odkaz na nastavenie nového hesla do administrácie.';
  const rows = [['Prihlásenie', user.username], ['Rola', ROLE_NAMES[user.role]]];
  const text = `Dobrý deň, ${name},\n\n${intro}\n\nPrihlasovacie meno: ${user.username}\n` +
    `Nastaviť heslo: ${link}\n\nOdkaz platí 3 dni a dá sa použiť len raz.${signature()}`;
  await sendMail(user.email, isNew ? `Váš účet – ${SITE_NAME}` : `Nastavenie hesla – ${SITE_NAME}`, text, emailHtml({
    preheader: `Prihlasovacie meno: ${user.username}. Odkaz na nastavenie hesla platí 3 dni.`,
    eyebrow: 'Administrácia', title, name, rows,
    lines: [esc(intro), 'Odkaz platí 3 dni a dá sa použiť len raz. Ak ste o účet nežiadali, e-mail môžete ignorovať.'],
    button: { label: 'Nastaviť heslo', href: link },
    footnote: 'Tento e-mail bol odoslaný automaticky z administrácie.',
  }));
}

// Odoslanie na pozadí – chyba e-mailu nesmie zhodiť rezerváciu
function sendLater(to, { subject, text, html }, replyTo) {
  if (!transport || !to) return;
  transport
    .sendMail({ from: MAIL_FROM || SMTP_USER, to, subject, text, html, replyTo })
    .catch((err) => console.error(`E-mail pre ${to} sa nepodarilo odoslať:`, err.message));
}

export function notifyPasswordSet(user, isNew, adminEmails) {
  const seen = new Set();
  const to = [...adminEmails, ADMIN_EMAIL].filter((e) => e && !seen.has(e.toLowerCase()) && seen.add(e.toLowerCase()));
  if (!to.length) return;
  const who = user.member_name ? `${user.member_name} (${user.username})` : user.username;
  const { url } = contact();
  sendLater(to.join(', '), {
    subject: isNew ? `Účet aktivovaný: ${who}` : `Zmena hesla: ${who}`,
    text: (isNew
      ? `${who} si nastavil(a) heslo a účet je aktívny. Odteraz sa môže prihlásiť do administrácie.`
      : `${who} si cez odkaz z e-mailu nastavil(a) nové heslo.`) +
      `\n\nPrihlásenie: ${user.username}\nRola:       ${ROLE_NAMES[user.role]}\nE-mail:     ${user.email || '—'}` +
      (url ? `\n\nPoužívatelia v administrácii: ${url}/admin` : ''),
  });
}

// Upozornenie terapeutovi na potvrdený alebo preradený termín (kind: confirmed | assigned)
export function notifyTherapist(b, emails, kind) {
  const { url } = contact();
  const when = `${fmtDate(b.date)}, ${b.time} – ${b.end_time}`;
  const intro = kind === 'assigned'
    ? 'bol vám pridelený potvrdený termín.'
    : 'termín u vás bol potvrdený.';
  const rows = [
    ['Klient', b.name],
    ['Kontakt', [b.email, b.phone].filter(Boolean).join(' · ') || '—'],
    ['Procedúra', b.procedure_name],
    ['Termín', when],
    ...(b.room_name ? [['Miestnosť', b.room_name]] : []),
    ...(b.note ? [['Poznámka', b.note]] : []),
  ];
  sendLater(emails.join(', '), {
    subject: `${kind === 'assigned' ? 'Pridelený termín' : 'Potvrdený termín'}: ${fmtDate(b.date)} ${b.time} – ${b.name}`,
    text: `Dobrý deň, ${b.member_name},\n\n${intro}\n\n` +
      rows.map(([k, v]) => `${(k + ':').padEnd(11)}${v}`).join('\n') +
      (url ? `\n\nKalendár: ${url}/admin/#kalendar` : ''),
    html: emailHtml({
      preheader: `${b.procedure_name}, ${when} – ${b.name}`,
      eyebrow: kind === 'assigned' ? 'Pridelený termín' : 'Potvrdený termín',
      title: b.name, name: b.member_name, rows,
      lines: [esc(intro)],
      button: url ? { label: 'Otvoriť kalendár', href: `${url}/admin/#kalendar` } : null,
      footnote: 'Tento e-mail bol odoslaný automaticky z administrácie.',
    }),
  });
}

export function notifyNewBooking(b) {
  sendLater(
    ADMIN_EMAIL,
    {
      subject: `Nová rezervácia: ${b.procedure_name}, ${fmtDate(b.date)} ${b.time}`,
      text: `${summary(b)}\n\nKlient:    ${b.name}\nE-mail:    ${b.email || '—'}\nTelefón:   ${b.phone || '—'}` +
        (b.note ? `\n\nPoznámka:\n${b.note}` : '') +
        (contact().url ? `\n\nPotvrdiť v administrácii: ${contact().url}/admin` : ''),
    },
    b.email || undefined
  );
  sendLater(b.email, clientEmails.received(b));
}

// Uvítací e-mail po registrácii klienta na webe (zároveň potvrdenie udeleného súhlasu GDPR)
export function notifyClientRegistered(c) {
  const { url } = contact();
  const consent = new Date().toLocaleDateString('sk-SK', { timeZone: process.env.TIMEZONE || 'Europe/Bratislava' });
  const rows = [['Meno', c.name], ['E-mail', c.email], ['Telefón', c.phone || '—'], ['Súhlas GDPR', `udelený ${consent}`]];
  const intro = `ďakujeme za registráciu na webe ${SITE_NAME}. Pri ďalších rezerváciách sa stačí prihlásiť ` +
    'a vaše údaje sa vyplnia automaticky.';
  const gdpr = 'Údaje si môžete kedykoľvek upraviť v časti „Môj účet“. Tam môžete účet aj zrušiť – tým odvoláte súhlas ' +
    'so spracúvaním osobných údajov a údaje účtu vymažeme.';
  sendLater(c.email, {
    subject: `Vitajte – ${SITE_NAME}`,
    text: `Dobrý deň, ${c.name},\n\n${intro}\n\n` +
      rows.map(([k, v]) => `${(k + ':').padEnd(13)}${v}`).join('\n') +
      `\n\n${gdpr}${url ? `\n\nRezervovať termín: ${url}/#rezervacia` : ''}${signature()}`,
    html: emailHtml({
      preheader: 'Váš účet je pripravený – pri rezervácii sa už stačí prihlásiť.',
      eyebrow: 'Registrácia', title: 'Vitajte', name: c.name, rows,
      lines: [esc(intro), esc(gdpr), 'Ak ste sa neregistrovali vy, dajte nám prosím vedieť.'],
      button: url ? { label: 'Rezervovať termín', href: `${url}/#rezervacia` } : callButton(),
      footnote: 'Tento e-mail bol odoslaný automaticky po registrácii na webe.',
    }),
  });
}

export function notifyStatus(b, status) {
  if (clientEmails[status]) sendLater(b.email, clientEmails[status](b));
}
