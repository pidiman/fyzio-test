import crypto from 'node:crypto';

// SMSfarm.sk – SOAP rozhranie https://app.smsfarm.sk/doc/integration/
// Prístupové údaje (integračné ID, integračné heslo, odosielateľ) zadáva admin v Nastaveniach,
// funkcie ich dostávajú ako cfg = { id, code, sender }.
const API = 'https://app.smsfarm.sk/api/';

export const smsConfigured = (cfg) => !!(cfg.id && cfg.code && cfg.sender);

// podpis požiadavky podľa dokumentácie: substr(md5(heslo . hodnota), 10, 11)
const sign = (cfg, value) => crypto.createHash('md5').update(cfg.code + value).digest('hex').slice(10, 21);

const xml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);

// prvky idú v poradí podľa WSDL (xs:sequence): parametre operácie, potom integration_id a signature;
// signed = hodnota, z ktorej sa počíta podpis
async function call(cfg, action, params, signed) {
  if (!smsConfigured(cfg)) throw new Error('SMSfarm nie je nastavené.');
  const body = Object.entries({ ...params, integration_id: cfg.id, signature: sign(cfg, signed) })
    .map(([k, v]) => `<s:${k}>${xml(v)}</s:${k}>`).join('');
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `"${action}"` },
    body: '<?xml version="1.0" encoding="UTF-8"?>' +
      '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:s="smsfarm.soap">' +
      `<soapenv:Body><s:${action}>${body}</s:${action}></soapenv:Body></soapenv:Envelope>`,
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  const fault = /<faultstring>([^<]*)<\/faultstring>/.exec(text);
  if (fault) throw new Error(fault[1]);
  const result = new RegExp(`<(?:\\w+:)?${action}Result>([^<]*)<`).exec(text);
  if (!res.ok || !result) throw new Error(`neočakávaná odpoveď (HTTP ${res.status})`);
  return result[1];
}

// telefón z formulára → medzinárodný formát (+421…); slovenské čísla môžu byť zadané aj ako 09xx
export function toIntl(phone) {
  let p = String(phone ?? '').replace(/[\s/-]/g, '');
  if (p.startsWith('00')) p = `+${p.slice(2)}`;
  else if (p.startsWith('0')) p = `+421${p.slice(1)}`;
  else if (/^421\d/.test(p)) p = `+${p}`;
  return /^\+\d{9,15}$/.test(p) ? p : null;
}

// bez diakritiky sa SMS zmestí do 160 znakov (s diakritikou len 70)
export const plain = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

// vráti id požiadavky v SMSfarm (na zistenie stavu doručenia)
export const sendSms = (cfg, recipient, message) =>
  call(cfg, 'SendMessage', { sender: cfg.sender, recipient, message }, recipient);

// zostatok kreditu – zároveň overí, že prístupové údaje sú správne
export const smsCredit = async (cfg) => Number(await call(cfg, 'GetCreditAmount', {}, cfg.id));

// stav doručenia: QUEUED, SENT, DELIVERED, INVALID-NUMBER, MESSAGE-UNDELIVERED…
export const smsDelivery = (cfg, requestId, recipient) =>
  call(cfg, 'GetMessageStatus', { request_id: requestId, number: recipient }, requestId);

const DAYS = ['ne', 'po', 'ut', 'st', 'št', 'pi', 'so'];

// text SMS klientovi po potvrdení termínu
export function confirmedText(b, contactPhone) {
  const [, m, d] = b.date.split('-').map(Number);
  const day = DAYS[new Date(`${b.date}T00:00:00Z`).getUTCDay()];
  return `${process.env.SITE_NAME || 'FYZIO Stupava'}: termín ${b.procedure_name.slice(0, 40)}, ` +
    `${day} ${d}.${m}. o ${b.time} je potvrdený. Tešíme sa na vás!` +
    (contactPhone ? ` Zmena alebo zrušenie: ${contactPhone}` : '');
}
