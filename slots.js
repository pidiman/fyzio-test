// Výpočet voľných termínov bez prístupu k databáze (aby sa dal testovať samostatne).
// Dátumy a časy sú v lokálnom čase prevádzky.

export const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
export const toTime = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
export const isTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
export const isDate = (s) =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
export const addDays = (date, n) => {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export const overlaps = (ranges, start, end) => ranges.some(([s, e]) => start < e && s < end);

// Vráti mapu voľný čas → členovia tímu, ktorí vtedy môžu procedúru robiť.
// Termín je voľný, ak je voľná miestnosť procedúry a aspoň jeden jej terapeut
// (procedúra bez priradených terapeutov sa riadi len miestnosťou).
//   now        – { date, min } aktuálny lokálny čas
//   roomBusy   – obsadené úseky miestnosti [[začiatok, koniec] v minútach]
//   memberBusy – [[id terapeuta, obsadené úseky]] pre terapeutov, ktorí procedúru robia
export function freeSlots({ date, now, settings, duration, roomBusy, memberBusy }) {
  const result = new Map();
  if (!isDate(date)) return result;
  if (date < now.date || date > addDays(now.date, settings.max_days_ahead)) return result;
  if (settings.blocked_dates.includes(date)) return result;

  const hours = settings.hours[new Date(date + 'T00:00:00Z').getUTCDay()];
  if (!hours) return result;

  for (let t = toMin(hours[0]); t + duration <= toMin(hours[1]); t += settings.slot_step) {
    if (date === now.date && t <= now.min) continue;
    const end = t + duration;
    if (overlaps(roomBusy, t, end)) continue;
    const free = memberBusy.filter(([, ranges]) => !overlaps(ranges, t, end)).map(([id]) => id);
    if (memberBusy.length && !free.length) continue;
    result.set(toTime(t), free);
  }
  return result;
}
