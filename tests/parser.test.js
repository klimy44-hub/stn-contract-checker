'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildRegistry, deliveriesBefore, analyzeDocument } = require('../src/parser.js');

const CHECK = '2026-03-10';
const load = (dir) => fs.readdirSync(dir).filter((n) => n.endsWith('.txt'))
  .map((name) => ({ name, text: fs.readFileSync(path.join(dir, name), 'utf8') }));
const DOCS = load(path.join(__dirname, '..', 'documents'));
const ALT = load(path.join(__dirname, 'fixtures', 'alt_format'));
const row = (reg, num) => reg.rows.find((r) => r.number === num);
const replaceIn = (files, name, from, to) => files.map((f) => (f.name === name ? { ...f, text: f.text.replace(from, to) } : f));

test('builds a row for each of the three contracts', () => {
  const reg = buildRegistry(DOCS, CHECK);
  assert.deepEqual(reg.rows.map((r) => r.number), ['STN-101', 'STN-102', 'STN-103']);
  assert.equal(reg.unlinked.length, 0);
  assert.equal(row(reg, 'STN-102').supplier.value, 'ООО «Контур Электро»');
});

test('Q1: STN-101 delivery is taken from the signed, effective amendment', () => {
  const r = row(buildRegistry(DOCS, CHECK), 'STN-101');
  assert.equal(r.delivery.value, '2026-04-30');
  assert.equal(r.delivery.changedBy, '02_amendment_signed.txt');
  assert.match(r.delivery.source.quote, /30\.04\.2026/);
  assert.equal(r.delivery.history[0].value, '2026-04-15');
});

test('draft amendment is shown as pending and never applied', () => {
  const r = row(buildRegistry(DOCS, CHECK), 'STN-101');
  assert.equal(r.amount.value, 1380000);
  const draft = r.pending.find((p) => p.fileName === '06_amendment_draft.txt');
  assert.equal(draft.status.code, 'draft');
  assert.deepEqual(draft.proposed.map((x) => x.value), [1450000, '2026-05-10']);
});

test('Q2: STN-102 amount is the total, not the advance payment', () => {
  const r = row(buildRegistry(DOCS, CHECK), 'STN-102');
  assert.equal(r.amount.value, 840000);
  assert.equal(r.amount.source.file, '03_contract.txt');
  assert.equal(r.amount.source.paragraph, 6);
});

test('Q3: STN-103 amount is "no data" — budget limit is not used', () => {
  const r = row(buildRegistry(DOCS, CHECK), 'STN-103');
  assert.equal(r.amount.value, null);
  assert.match(r.amount.source.quote, /спецификацией/);
  assert.ok(r.issues.some((i) => /нет данных/.test(i)));
});

test('payment date is not mistaken for delivery date', () => {
  assert.equal(row(buildRegistry(DOCS, CHECK), 'STN-102').delivery.value, '2026-03-20');
});

test('Q4: deliveries before 2026-04-01 with unagreed delivery changes', () => {
  const hits = deliveriesBefore(buildRegistry(DOCS, CHECK), '2026-04-01');
  assert.deepEqual(hits.map((h) => h.row.number), ['STN-102']);
  assert.deepEqual(hits[0].unagreed.map((u) => [u.value, u.status.code, u.source.file]),
    [['2026-03-27', 'proposal', '05_supplier_email.txt']]);
});

test('signed amendment that enters into force after the check date is not applied', () => {
  const files = replaceIn(DOCS, '02_amendment_signed.txt', 'вступает в силу 01.03.2026', 'вступает в силу 15.03.2026');
  const r = row(buildRegistry(files, CHECK), 'STN-101');
  assert.equal(r.delivery.value, '2026-04-15');
  assert.equal(r.pending.find((p) => p.fileName === '02_amendment_signed.txt').status.code, 'not_effective');
});

test('the same amendment applies when the check date moves past its effective date', () => {
  const files = replaceIn(DOCS, '02_amendment_signed.txt', 'вступает в силу 01.03.2026', 'вступает в силу 15.03.2026');
  assert.equal(row(buildRegistry(files, '2026-03-20'), 'STN-101').delivery.value, '2026-04-30');
});

test('amendment with unclear signature status is flagged for review, not applied', () => {
  const files = replaceIn(DOCS, '02_amendment_signed.txt', /Статус:.*\n/, '');
  const r = row(buildRegistry(files, CHECK), 'STN-101');
  assert.equal(r.amount.value, 1200000);
  assert.ok(r.issues.some((i) => /требуется проверка/.test(i)));
});

test('a changed field in a contract is reflected (no hardcoded values)', () => {
  const files = replaceIn(DOCS, '03_contract.txt', '840 000 (восемьсот сорок тысяч)', '910 500 (девятьсот десять тысяч пятьсот)');
  assert.equal(row(buildRegistry(files, CHECK), 'STN-102').amount.value, 910500);
});

test('a new contract of the same format is parsed', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'documents', '03_contract.txt'), 'utf8')
    .replace('STN-102', 'STN-104').replace('Контур Электро', 'Новый Поставщик')
    .replace('840 000', '99 000').replace('20.03.2026', '05.06.2026');
  const reg = buildRegistry([...DOCS, { name: 'new.txt', text }], CHECK);
  const r = row(reg, 'STN-104');
  assert.deepEqual([r.supplier.value, r.amount.value, r.delivery.value], ['ООО «Новый Поставщик»', 99000, '2026-06-05']);
  // The supplier letter still belongs to STN-102 only.
  assert.equal(r.pending.length, 0);
});

test('document referring to an unknown contract is listed as unlinked', () => {
  const reg = buildRegistry(DOCS.filter((f) => f.name !== '03_contract.txt'), CHECK);
  assert.deepEqual(reg.unlinked.map((u) => u.fileName), ['05_supplier_email.txt']);
});

test('file names and upload order do not affect priority', () => {
  const renamed = [...DOCS].reverse().map((f, i) => ({ ...f, name: `z${i}.txt` }));
  const r = row(buildRegistry(renamed, CHECK), 'STN-101');
  assert.equal(r.delivery.value, '2026-04-30');
  assert.equal(r.amount.value, 1380000);
});

test('document types and statuses are detected from text', () => {
  const byName = Object.fromEntries(DOCS.map((f) => [f.name, analyzeDocument(f.name, f.text)]));
  assert.equal(byName['05_supplier_email.txt'].type, 'letter');
  assert.equal(byName['06_amendment_draft.txt'].signature, 'draft');
  assert.equal(byName['02_amendment_signed.txt'].signature, 'signed');
});

test('alternate wording/format (Russian month names, «№», VAT clause, «вместо»-style edits)', () => {
  const reg = buildRegistry(ALT, CHECK);
  assert.equal(row(reg, 'STN-101').amount.value, 1250000);
  assert.equal(row(reg, 'STN-101').delivery.value, '2026-04-10');
  assert.equal(row(reg, 'STN-102').pending[0].status.code, 'draft');
  assert.equal(row(reg, 'STN-103').amount.value, null);
  assert.match(row(reg, 'STN-103').amount.source.quote, /Спецификаций/);
});
