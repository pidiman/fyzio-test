import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDate, isTime, addDays, overlaps, freeSlots } from '../slots.js';

// 2026-10-25 je nedeľa, 2026-10-26 pondelok
const settings = {
  hours: { 0: null, 1: ['08:00', '12:00'], 2: ['08:00', '12:00'], 3: ['08:00', '12:00'], 4: ['08:00', '12:00'], 5: ['08:00', '12:00'], 6: null },
  slot_step: 30,
  max_days_ahead: 30,
  blocked_dates: [],
};
const now = { date: '2026-10-25', min: 10 * 60 };
const slots = (opts) => freeSlots({ date: '2026-10-26', now, settings, duration: 60, roomBusy: [], memberBusy: [], ...opts });
const range = (from, to) => [toM(from), toM(to)];
const toM = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

test('isDate a isTime odmietnu neplatné hodnoty', () => {
  assert.ok(isDate('2026-02-28'));
  assert.ok(!isDate('2026-02-30'));
  assert.ok(!isDate('26-2-1'));
  assert.ok(!isDate(undefined));
  assert.ok(isTime('09:30'));
  assert.ok(!isTime('24:00'));
  assert.ok(!isTime('9:30'));
});

test('addDays prechádza cez koniec mesiaca a roka', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

test('overlaps: susediace termíny sa neprekrývajú', () => {
  assert.ok(!overlaps([range('09:00', '10:00')], toM('10:00'), toM('11:00')));
  assert.ok(overlaps([range('09:00', '10:00')], toM('09:30'), toM('10:30')));
});

test('voľný deň: všetky termíny, ktoré sa zmestia do otváracích hodín', () => {
  assert.deepEqual([...slots().keys()], ['08:00', '08:30', '09:00', '09:30', '10:00', '10:30', '11:00']);
});

test('zatvorené, zablokované, minulé a príliš vzdialené dni nemajú termíny', () => {
  assert.equal(slots({ date: '2026-10-31' }).size, 0); // sobota
  assert.equal(slots({ settings: { ...settings, blocked_dates: ['2026-10-26'] } }).size, 0);
  assert.equal(slots({ date: '2026-10-20' }).size, 0);
  assert.equal(slots({ date: addDays(now.date, 31) }).size, 0);
  assert.equal(slots({ date: 'zajtra' }).size, 0);
});

test('dnes sa ponúkajú len termíny po aktuálnom čase', () => {
  const today = { date: '2026-10-26', min: toM('09:00') };
  assert.deepEqual([...slots({ now: today }).keys()], ['09:30', '10:00', '10:30', '11:00']);
});

test('obsadená miestnosť blokuje termíny, ktoré sa s ňou prekrývajú', () => {
  const free = slots({ roomBusy: [range('09:00', '10:00')] });
  assert.deepEqual([...free.keys()], ['08:00', '10:00', '10:30', '11:00']);
});

test('termín je voľný, kým má čas aspoň jeden terapeut procedúry', () => {
  const free = slots({ memberBusy: [[1, [range('08:00', '10:00')]], [2, [range('09:00', '11:00')]]] });
  assert.deepEqual(free.get('08:00'), [2]);
  assert.equal(free.has('09:00'), false);
  assert.deepEqual(free.get('10:00'), [1]);
  assert.deepEqual(free.get('11:00'), [1, 2]);
});

test('procedúra bez terapeutov sa riadi len miestnosťou', () => {
  assert.deepEqual(slots().get('08:00'), []);
});
