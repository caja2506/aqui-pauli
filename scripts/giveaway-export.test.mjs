import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGiveawayCsv, giveawayCsvCell, giveawayEntryDate } from '../src/utils/giveawayExport.js';

test('CSV conserva tildes, comas, comillas y saltos de línea sin romper columnas', () => {
  assert.equal(giveawayCsvCell('Jiménez, "Ana"\nArias'), '"Jiménez, ""Ana""\nArias"');
  const csv = buildGiveawayCsv([{ number: 1, fullName: 'Ana Jiménez', phone: '88887777',
    email: 'ana@example.test', prizeLabel: 'Acqua di Giò EDT 100 ml',
    createdAt: '2026-10-30T01:05:09Z', promotionsConsent: false }]);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.endsWith('\r\n'));
  assert.match(csv, /"88887777","ana@example.test","Acqua di Giò EDT 100 ml"/);
  assert.match(csv, /29\/10\/2026, 19:05:09/);
  assert.match(csv, /"No"\r\n$/);
});

test('CSV neutraliza fórmulas y prefijos ocultos en cualquier campo', () => {
  for (const value of ['=HYPERLINK("https://example.test")', '+SUM(1,2)', '-1+2', '@SUM(1,2)',
    '  =1+2', '\t=1+2', '\n+1', '\rnormal', '\u0001@cmd', '\uFEFF=1']) {
    assert.ok(giveawayCsvCell(value).startsWith('"\''), JSON.stringify(value));
  }
  assert.equal(giveawayCsvCell('Ana María'), '"Ana María"');
});

test('CSV ordena por número sin mutar datos y distingue opt-in explícito', () => {
  const entries = [{ number: 3, fullName: 'Tres', promotionsConsent: 'true' },
    { number: 1, fullName: 'Uno', promotionsConsent: true }, { number: 2, fullName: 'Dos' }];
  const rows = buildGiveawayCsv(entries).trimEnd().split('\r\n');
  assert.match(rows[1], /^"1","Uno".*,"Sí"$/);
  assert.match(rows[2], /^"2","Dos".*,"No"$/);
  assert.match(rows[3], /^"3","Tres".*,"No"$/);
  assert.deepEqual(entries.map((entry) => entry.number), [3, 1, 2]);
});

test('fechas Timestamp e ISO se muestran en Costa Rica; valores ausentes no inventan una fecha', () => {
  const iso = '2026-11-06T02:00:00Z';
  const expected = '05/11/2026, 20:00:00';
  assert.equal(giveawayEntryDate(iso), expected);
  assert.equal(giveawayEntryDate({ toDate: () => new Date(iso) }), expected);
  assert.equal(giveawayEntryDate({ seconds: Date.parse(iso) / 1000 }), expected);
  for (const value of [null, undefined, 'no es fecha']) assert.equal(giveawayEntryDate(value), '—');
});
