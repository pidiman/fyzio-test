import nodemailer from 'nodemailer';

const {
  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE,
  MAIL_FROM, ADMIN_EMAIL, SITE_NAME = 'FyzioPlus', SITE_URL = '', CONTACT_PHONE = '',
} = process.env;

const port = Number(SMTP_PORT) || 587;
const transport = SMTP_HOST
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port,
      secure: SMTP_SECURE ? SMTP_SECURE === 'true' : port === 465,
      auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
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
  if (!ADMIN_EMAIL) console.warn('ADMIN_EMAIL nie je nastavené – upozornenia na nové rezervácie sa neodosielajú.');
}

const DAYS = ['nedeľa', 'pondelok', 'utorok', 'streda', 'štvrtok', 'piatok', 'sobota'];
const fmtDate = (d) => {
  const [y, m, day] = d.split('-').map(Number);
  return `${DAYS[new Date(d + 'T00:00:00Z').getUTCDay()]} ${day}. ${m}. ${y}`;
};
const eur = (n) => n.toLocaleString('sk-SK', { style: 'currency', currency: 'EUR' });
const signature = `\n\n${SITE_NAME}${CONTACT_PHONE ? `\nTel.: ${CONTACT_PHONE}` : ''}${SITE_URL ? `\n${SITE_URL}` : ''}`;

const summary = (b) => [
  `Procedúra: ${b.procedure_name}`,
  `Termín:    ${fmtDate(b.date)}, ${b.time} – ${b.end_time}`,
  `Cena:      ${eur(b.price)}`,
].join('\n');

export async function sendMail(to, subject, text) {
  if (!transport) throw new Error('SMTP nie je nastavené.');
  await transport.sendMail({ from: MAIL_FROM || SMTP_USER, to, subject, text });
}

// Odoslanie na pozadí – chyba e-mailu nesmie zhodiť rezerváciu
function sendLater(to, subject, text, replyTo) {
  if (!transport || !to) return;
  transport
    .sendMail({ from: MAIL_FROM || SMTP_USER, to, subject, text, replyTo })
    .catch((err) => console.error(`E-mail pre ${to} sa nepodarilo odoslať:`, err.message));
}

export function notifyNewBooking(b) {
  sendLater(
    ADMIN_EMAIL,
    `Nová rezervácia: ${b.procedure_name}, ${fmtDate(b.date)} ${b.time}`,
    `${summary(b)}\n\nKlient:    ${b.name}\nTelefón:   ${b.phone}\nE-mail:    ${b.email || '—'}` +
      (b.note ? `\n\nPoznámka:\n${b.note}` : '') +
      (SITE_URL ? `\n\nPotvrdiť v administrácii: ${SITE_URL.replace(/\/$/, '')}/admin` : ''),
    b.email || undefined
  );
  sendLater(
    b.email,
    `Prijali sme vašu rezerváciu – ${SITE_NAME}`,
    `Dobrý deň, ${b.name},\n\nďakujeme za rezerváciu. Termín vám čoskoro potvrdíme.\n\n${summary(b)}` +
      `\n\nAk potrebujete termín zmeniť alebo zrušiť, ozvite sa nám prosím.${signature}`
  );
}

export function notifyStatus(b, status) {
  if (status === 'confirmed') {
    sendLater(
      b.email,
      `Termín potvrdený – ${fmtDate(b.date)} ${b.time}`,
      `Dobrý deň, ${b.name},\n\nváš termín je potvrdený. Tešíme sa na vás.\n\n${summary(b)}` +
        `\n\nPrineste si prosím pohodlné oblečenie a prípadné lekárske správy.${signature}`
    );
  } else if (status === 'cancelled') {
    sendLater(
      b.email,
      `Termín zrušený – ${fmtDate(b.date)} ${b.time}`,
      `Dobrý deň, ${b.name},\n\nváš termín bol zrušený.\n\n${summary(b)}` +
        `\n\nNový termín si môžete rezervovať online${SITE_URL ? ` na ${SITE_URL}` : ''} alebo nám zavolajte.${signature}`
    );
  }
}
