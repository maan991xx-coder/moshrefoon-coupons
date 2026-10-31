import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvUrl, parseCsv, rowsToCoupons, normStatus, codeFromScan } from '../site/js/sheet.js';

test('published and shared sheet links become CSV URLs', () => {
  assert.equal(
    csvUrl('https://docs.google.com/spreadsheets/d/e/2PACX-abc/pubhtml?gid=7&single=true'),
    'https://docs.google.com/spreadsheets/d/e/2PACX-abc/pub?output=csv&gid=7&single=true');
  assert.equal(
    csvUrl('https://docs.google.com/spreadsheets/d/e/2PACX-abc/pub?output=csv'),
    'https://docs.google.com/spreadsheets/d/e/2PACX-abc/pub?output=csv');
  assert.equal(
    csvUrl('https://docs.google.com/spreadsheets/d/1AbC_d/edit#gid=42'),
    'https://docs.google.com/spreadsheets/d/1AbC_d/gviz/tq?tqx=out%3Acsv&gid=42');
  assert.equal(csvUrl('not a url'), '');
});

test('CSV parser handles quotes, commas and newlines inside cells', () => {
  const rows = parseCsv('﻿الكود,ملاحظة\r\n"A-1","جدة, ""المعرض"""\r\nB-2,"سطر\nثان"\n\n');
  assert.deepEqual(rows, [['الكود', 'ملاحظة'], ['A-1', 'جدة, "المعرض"'], ['B-2', 'سطر\nثان']]);
});

test('rows map to coupons by Arabic headers, with defaults and dedupe', () => {
  const coupons = rowsToCoupons([
    ['ملاحظة', 'الكود', 'القيمة', 'الحالة', 'تاريخ الإستخدام'],
    ['جدة', 'MSH-1', '', '', ''],
    ['', 'MSH-2', '25', 'مستخدم', '2026-10-30'],
    ['', 'msh-1', '', '', ''],
    ['', '', '', '', ''],
    ['', 'MSH-3', '', 'ملغى', ''],
  ], '10');
  assert.equal(coupons.length, 3);
  assert.deepEqual(coupons[0], { code: 'MSH-1', amount: '10', status: 'active', usedAt: '', note: 'جدة', row: 2 });
  assert.equal(coupons[1].status, 'used');
  assert.equal(coupons[1].amount, '25');
  assert.equal(coupons[1].usedAt, '2026-10-30');
  assert.equal(coupons[2].status, 'void');
});

test('a sheet without a header row uses column A as the code', () => {
  const coupons = rowsToCoupons([['X1'], ['X2']]);
  assert.deepEqual(coupons.map((c) => c.code), ['X1', 'X2']);
});

test('status words and scanned QR text', () => {
  assert.equal(normStatus(''), 'active');
  assert.equal(normStatus('تم الاستخدام'), 'used');
  assert.equal(normStatus('Used'), 'used');
  assert.equal(normStatus('ملغي'), 'void');
  assert.equal(codeFromScan('https://x.github.io/repo/verify.html?c=MSH-AB12-CD34'), 'MSH-AB12-CD34');
  assert.equal(codeFromScan('  MSH-AB12-CD34 '), 'MSH-AB12-CD34');
});
