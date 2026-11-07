'use strict';
/* Oturum izleme testleri: giriş/çıkış, kısa kopmalar, sayfa yenileme, kapanış. */
const assert = require('assert');
const T = require('../extension/tracker.js');

const S = 1000;
const MIN = 60 * S;

function session() {
  return T.createSession({ id: 'test', title: 'Deneme', startedAt: 0 });
}
function tick(st, names, t) { return T.update(st, names, t); }
function person(st, name) { return T.toPayload(st).participants.find((p) => p.name === name); }

test('baştan sona kalan kişi', () => {
  const st = session();
  for (let t = 0; t <= 60 * MIN; t += 5 * S) tick(st, ['Aras Aksoy'], t);
  T.finalize(st, 60 * MIN);
  const p = person(st, 'Aras Aksoy');
  assert.strictEqual(p.totalMs, 60 * MIN);
  assert.strictEqual(p.joins, 1);
  assert.strictEqual(p.firstJoin, 0);
});

test('çıkıp girerse süreler toplanır, bağlanma sayısı artar', () => {
  const st = session();
  for (let t = 0; t <= 20 * MIN; t += 5 * S) tick(st, ['Şeyma'], t);
  for (let t = 20 * MIN + 5 * S; t < 30 * MIN; t += 5 * S) tick(st, [], t);
  for (let t = 30 * MIN; t <= 60 * MIN; t += 5 * S) tick(st, ['Şeyma'], t);
  T.finalize(st, 60 * MIN);
  const p = person(st, 'Şeyma');
  assert.strictEqual(p.joins, 2);
  // 0-20dk + 30-60dk; çıkış ilk "görülmedi" anında kaydedilir (+5 sn)
  assert.ok(Math.abs(p.totalMs - 50 * MIN) <= 5 * S, String(p.totalMs / MIN));
});

test('kısa titreme (grace altında) çıkış sayılmaz', () => {
  const st = session();
  tick(st, ['Ali'], 0);
  tick(st, [], 10 * S);      // panel yeniden çizildi, bir an yok
  tick(st, ['Ali'], 15 * S);
  tick(st, ['Ali'], 60 * S);
  T.finalize(st, 60 * S);
  const p = person(st, 'Ali');
  assert.strictEqual(p.joins, 1);
  assert.strictEqual(p.totalMs, 60 * S);
});

test('çıkış, ilk görülmediği anda kaydedilir', () => {
  const st = session();
  tick(st, ['Ali'], 0);
  tick(st, [], 100 * S);
  tick(st, [], 130 * S); // grace (20 sn) doldu
  const p = person(st, 'Ali');
  assert.strictEqual(p.lastLeave, 100 * S);
  assert.strictEqual(T.presentCount(st), 0);
});

test('sekme kapanırsa: son görülme anında kapanır', () => {
  const st = session();
  for (let t = 0; t <= 30 * MIN; t += 5 * S) tick(st, ['Ali', 'Ece'], t);
  // sekme kapandı, veri storage'da kaldı; popup "Bitir ve gönder" der
  const restored = JSON.parse(JSON.stringify(st));
  T.finalize(restored); // endAt yok => lastSeenAt
  assert.strictEqual(restored.endedAt, 30 * MIN);
  assert.strictEqual(person(restored, 'Ali').totalMs, 30 * MIN);
});

test('sayfa yenileme: tolerans içinde dönen kişi kesintisiz sayılır', () => {
  const st = session();
  for (let t = 0; t <= 10 * MIN; t += 5 * S) tick(st, ['Ali', 'Ece'], t);
  T.pause(st, 10 * MIN + 30 * S); // yenileme
  // 60 sn sonra yeniden okunabildi; Ece yok
  tick(st, ['Ali'], 11 * MIN);
  tick(st, ['Ali'], 12 * MIN + 30 * S);
  T.finalize(st, 20 * MIN);
  const ali = person(st, 'Ali');
  const ece = person(st, 'Ece');
  assert.strictEqual(ali.joins, 1);
  assert.strictEqual(ali.totalMs, 20 * MIN);
  assert.strictEqual(ece.lastLeave, 10 * MIN); // son görüldüğü an
});

test('uzun kesinti sonrası dönen kişi yeniden bağlanmış sayılır', () => {
  const st = session();
  tick(st, ['Ali'], 0);
  tick(st, ['Ali'], 10 * MIN);
  T.pause(st, 10 * MIN); // görüşmeden çıkıldı
  tick(st, ['Ali'], 25 * MIN); // 15 dk sonra yeniden
  T.finalize(st, 30 * MIN);
  const ali = person(st, 'Ali');
  assert.strictEqual(ali.joins, 2);
  assert.strictEqual(ali.totalMs, 15 * MIN);
});

test('bitirirken askıdaki kişi askıya alındığı anda kapanır', () => {
  const st = session();
  tick(st, ['Ali'], 0);
  tick(st, [], 50 * S);
  T.finalize(st, 55 * S);
  assert.strictEqual(person(st, 'Ali').lastLeave, 50 * S);
});

test('JSON gidiş-dönüşte durum korunur (storage)', () => {
  let st = session();
  tick(st, ['Ali'], 0);
  st = JSON.parse(JSON.stringify(st));
  tick(st, ['Ali'], 30 * S);
  T.finalize(st, 30 * S);
  assert.strictEqual(person(st, 'Ali').totalMs, 30 * S);
});

test('canlı görünüm açık aralığı şimdiye kadar sayar', () => {
  const st = session();
  tick(st, ['Ali', 'Ece'], 0);
  tick(st, ['Ali'], 30 * S);
  const v = T.liveView(st, 60 * S);
  const ali = v.find((x) => x.name === 'Ali');
  const ece = v.find((x) => x.name === 'Ece');
  assert.strictEqual(ali.present, true);
  assert.strictEqual(ali.totalMs, 60 * S);
  assert.strictEqual(ece.present, false);
  assert.strictEqual(ece.totalMs, 30 * S);
  assert.strictEqual(T.presentCount(st), 1);
});

test('CSV: BOM, ; ayraç, formül enjeksiyonu engellenir', () => {
  const st = session();
  tick(st, ['=HYPERLINK("x")', 'Ali; Veli'], 0);
  T.finalize(st, 10 * MIN);
  const csv = T.toCsv(st);
  assert.ok(csv.startsWith('﻿Meet adı;'));
  assert.ok(csv.includes('"\'=HYPERLINK(""x"")"'), csv);
  assert.ok(csv.includes('"Ali; Veli"'), csv);
  assert.ok(csv.includes(';10;1'), csv);
});

test('gönderim verisi yalnızca ad ve zaman içerir', () => {
  const st = session();
  tick(st, ['Ali'], 0);
  T.finalize(st, MIN);
  const p = T.toPayload(st);
  assert.deepStrictEqual(Object.keys(p).sort(), ['endedAt', 'id', 'participants', 'startedAt', 'title']);
  assert.deepStrictEqual(Object.keys(p.participants[0]).sort(), ['firstJoin', 'intervals', 'joins', 'lastLeave', 'name', 'totalMs']);
});
