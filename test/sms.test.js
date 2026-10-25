import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toIntl, confirmedText } from '../sms.js';

test('toIntl: slovenské a medzinárodné čísla', () => {
  assert.equal(toIntl('+421 900 123 456'), '+421900123456');
  assert.equal(toIntl('0900 123 456'), '+421900123456');
  assert.equal(toIntl('0900/123-456'), '+421900123456');
  assert.equal(toIntl('00420 601 123 456'), '+420601123456');
  assert.equal(toIntl('421900123456'), '+421900123456');
});

test('toIntl: neplatné čísla', () => {
  assert.equal(toIntl(''), null);
  assert.equal(toIntl('+4219'), null);
  assert.equal(toIntl('abc'), null);
});

test('confirmedText: bez diakritiky sa zmestí do jednej SMS', () => {
  // 2026-11-03 je utorok
  const text = confirmedText(
    { procedure_name: 'Športová rehabilitácia po úraze kolena a členku', date: '2026-11-03', time: '10:00' },
    '+421 915 632 580'
  );
  assert.match(text, /ut 3\.11\. o 10:00 je potvrdený/);
  assert.ok(text.normalize('NFD').replace(/[̀-ͯ]/g, '').length <= 160, text);
});
