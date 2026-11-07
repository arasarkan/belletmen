'use strict';
/* Çekirdek testleri: normalizasyon, eşleştirme, aralıklar, durum, özet.
 * Buradaki isimler uydurmadır. */
const assert = require('assert');
const C = require('../extension/lib/core.js');

// Örnek kadro
const MEMBERS = [
  { id: 'U001', name: 'Aras Aksoy', aliases: [] },
  { id: 'U002', name: 'Şeyma Yıldız', aliases: [] },
  { id: 'U003', name: 'Mehmet Demir', aliases: [] },
  { id: 'U004', name: 'Mehmet Kaya', aliases: [] },
  { id: 'U005', name: 'Ali Kemal Öztürk', aliases: [] },
  { id: 'U006', name: 'Çağla Güneş', aliases: [] },
  { id: 'U007', name: 'Ilgın Işık', aliases: [] },
  { id: 'U008', name: 'Ece Doğan', aliases: ['Ecem'] },
  { id: 'U009', name: 'Mahmut Demirci', aliases: [] },
  { id: 'U010', name: 'Zeynep Çelik', aliases: [] },
  { id: 'U011', name: 'İbrahim Halil Ünal', aliases: [] },
  { id: 'U012', name: 'Göksu Erdoğan', aliases: [] }
];

function m(name, members) { return C.matchName(name, members || MEMBERS); }
function expectMatch(name, status, id, members) {
  const r = m(name, members);
  assert.strictEqual(r.status, status, `"${name}": durum ${r.status} (beklenen ${status}), skor ${r.score}, ${r.reason}, adaylar ${JSON.stringify(r.candidates)}`);
  if (id !== undefined) assert.strictEqual(r.memberId, id, `"${name}": üye ${r.memberId} (beklenen ${id}), adaylar ${JSON.stringify(r.candidates)}`);
  return r;
}

// --- Normalizasyon -----------------------------------------------------------

test('Türkçe karakterler ve büyük harf', () => {
  assert.strictEqual(C.normalizeName('ŞEYMA YILDIZ'), 'seyma yildiz');
  assert.strictEqual(C.normalizeName('Çağla Güneş'), 'cagla gunes');
  assert.strictEqual(C.normalizeName('Ilgın Işık'), 'ilgin isik');
  assert.strictEqual(C.normalizeName('İbrahim ÜNAL'), 'ibrahim unal');
  assert.strictEqual(C.normalizeName('Göksu ERDOĞAN'), 'goksu erdogan');
});

test('emoji, rakam, alt çizgi ve noktalama temizlenir', () => {
  assert.strictEqual(C.normalizeName('aras_9021'), 'aras');
  assert.strictEqual(C.normalizeName('🤖 Zeynep Çelik 🔧'), 'zeynep celik');
  assert.strictEqual(C.normalizeName('Aras A.'), 'aras a');
  assert.strictEqual(C.normalizeName('  ali-kemal   öztürk '), 'ali kemal ozturk');
});

test('cihaz adları ve iyelik ekleri atılır', () => {
  assert.strictEqual(C.normalizeName("Mehmet'in iPad'i"), 'mehmet');
  assert.strictEqual(C.normalizeName('Mehmet’s iPhone'), 'mehmet');
  assert.strictEqual(C.normalizeName("Şeyma'nın telefonu"), 'seyma');
  assert.strictEqual(C.normalizeName('Ali Kemal - Samsung Galaxy A52'), 'ali kemal');
  assert.strictEqual(C.normalizeName('iPad'), '');
});

test('Meet işaretleri: (Sen), (You), (Sunum)', () => {
  assert.strictEqual(C.cleanDisplayName('Aras Aksoy (Sen)'), 'Aras Aksoy');
  assert.strictEqual(C.cleanDisplayName('Aras Aksoy (You)'), 'Aras Aksoy');
  assert.strictEqual(C.cleanDisplayName('Ece Doğan\nToplantı sahibi'), 'Ece Doğan');
  assert.ok(C.isPresentationLabel('Mehmet Kaya (Sunum)'));
  assert.ok(C.isPresentationLabel('Mehmet Kaya (Presentation)'));
  assert.ok(!C.isPresentationLabel('Mehmet Kaya'));
  assert.ok(C.isSelfOnlyLabel('Sen'));
  assert.ok(C.isSelfOnlyLabel('You'));
  assert.ok(!C.isSelfOnlyLabel('Sena Kara'));
});

test('ekip kelimeleri ve ek yok sayılanlar', () => {
  assert.strictEqual(C.normalizeName('FRC 9021 Aras Aksoy'), 'aras aksoy');
  assert.strictEqual(C.normalizeName('Aras incrediBAL', ['incredibal']), 'aras');
});

// --- Benzerlik ---------------------------------------------------------------

test('Jaro-Winkler ve Levenshtein temel değerler', () => {
  assert.strictEqual(C.jaroWinkler('seyma', 'seyma'), 1);
  assert.ok(C.jaroWinkler('zeynap', 'zeynep') > 0.9);
  assert.ok(C.jaroWinkler('mehmet', 'ahmet') < 0.9);
  assert.strictEqual(C.levenshtein('kitten', 'sitting'), 3);
  assert.strictEqual(C.jaroWinkler('', 'a'), 0);
});

// --- Eşleştirme: kesin -------------------------------------------------------

test('ad birebir (Türkçe karakter farkı)', () => {
  expectMatch('Seyma Yildiz', 'kesin', 'U002');
  expectMatch('ŞEYMA YILDIZ 🤖', 'kesin', 'U002');
  expectMatch('Ilgin Isik', 'kesin', 'U007');
  expectMatch('Cagla Gunes (Sen)', 'kesin', 'U006');
});

test('takma ad birebir', () => {
  expectMatch('Ecem', 'kesin', 'U008');
  expectMatch('ecem', 'kesin', 'U008');
});

test('ad + soyadın baş harfi: "Aras A."', () => {
  expectMatch('Aras A.', 'kesin', 'U001');
});

test('baş harf + soyad: "A. Aksoy"', () => {
  expectMatch('A. Aksoy', 'kesin', 'U001');
});

test('küçük yazım hatası', () => {
  expectMatch('Zeynap Çelik', 'kesin', 'U010');
  expectMatch('Mehmet Demır', 'kesin', 'U003');
  expectMatch('Goksu Erdogn', 'kesin', 'U012');
});

test('ikinci ad eksik: "Ali Öztürk", "İbrahim Ünal"', () => {
  expectMatch('Ali Öztürk', 'kesin', 'U005');
  expectMatch('Ibrahim Unal', 'kesin', 'U011');
});

test('cihaz ekli tam ad: "Mehmet Demir\'in iPhone\'u"', () => {
  expectMatch("Mehmet Demir'in iPhone'u", 'kesin', 'U003');
  expectMatch('Zeynep Celik iPad', 'kesin', 'U010');
});

test('bitişik yazım: "arasaksoy", "SeymaYildiz"', () => {
  expectMatch('arasaksoy', 'kesin', 'U001');
  expectMatch('SeymaYildiz', 'kesin', 'U002');
});

test('ekip etiketi: "Aras Aksoy | FRC 9021"', () => {
  expectMatch('Aras Aksoy | FRC 9021', 'kesin', 'U001');
});

// --- Eşleştirme: öneri -------------------------------------------------------

test('yalnızca ad: "Seyma", "aras_9021" => öneri', () => {
  expectMatch('Seyma', 'öneri', 'U002');
  expectMatch('aras_9021', 'öneri', 'U001');
});

test('aynı adlı iki üye: "Mehmet\'in iPad\'i" => öneri, iki aday', () => {
  const r = expectMatch("Mehmet'in iPad'i", 'öneri');
  const ids = r.candidates.map((c) => c.id);
  assert.ok(ids.includes('U003') && ids.includes('U004'), JSON.stringify(r.candidates));
  assert.strictEqual(r.reason, 'adaylar çok yakın');
});

test('kesme işaretsiz iyelik: "Mehmetin telefonu" => öneri', () => {
  const r = expectMatch('Mehmetin telefonu', 'öneri');
  assert.ok(['U003', 'U004'].includes(r.memberId));
});

test('yalnızca soyad, benzer soyadlar: "Demir" => öneri', () => {
  expectMatch('Demir', 'öneri');
});

test('aynı tam ada sahip iki üye => öneri', () => {
  const twins = MEMBERS.concat([{ id: 'U099', name: 'Ece Doğan', aliases: [] }]);
  const r = expectMatch('Ece Dogan', 'öneri', undefined, twins);
  assert.strictEqual(r.candidates.length, 2);
});

// --- Eşleştirme: misafir -----------------------------------------------------

test('kadroda olmayan kişi => misafir', () => {
  expectMatch('Ahmet Yılmaz', 'misafir', null);
  expectMatch('Hakan Öğretmen', 'misafir', null);
  expectMatch('Burak Şahin', 'misafir', null);
});

test('tek başına cihaz adı ya da boş => misafir', () => {
  expectMatch('iPad', 'misafir', null);
  expectMatch('Galaxy Tab', 'misafir', null);
  expectMatch('   ', 'misafir', null);
  expectMatch('🤖', 'misafir', null);
});

test('benzer ama farklı kişi: "Mehmet Demirci" Mahmut Demirci değil', () => {
  const r = m('Mehmet Demirci');
  assert.notStrictEqual(r.status, 'kesin', JSON.stringify(r));
});

test('fazladan bilinmeyen soyad kesin sayılmaz: "Mehmet Arslan"', () => {
  const r = m('Mehmet Arslan');
  assert.notStrictEqual(r.status, 'kesin', JSON.stringify(r));
});

// --- Takma ad öğrenme --------------------------------------------------------

test('onaylanan takma ad bir daha sorulmaz', () => {
  const learned = MEMBERS.map((x) => (x.id === 'U003' ? { ...x, aliases: ["Mehmet'in iPad'i"] } : x));
  expectMatch("Mehmet'in iPad'i", 'kesin', 'U003', learned);
  expectMatch("mehmet'in ipad'i", 'kesin', 'U003', learned);
});

test('cihazlı takma ad başka "Mehmet"leri yutmaz', () => {
  const learned = MEMBERS.map((x) => (x.id === 'U003' ? { ...x, aliases: ["Mehmet'in iPad'i"] } : x));
  const r = m('Mehmet', learned);
  assert.strictEqual(r.status, 'öneri', JSON.stringify(r));
});

test('rakamlı takma ad yalnızca kendisiyle eşleşir', () => {
  const learned = MEMBERS.map((x) => (x.id === 'U001' ? { ...x, aliases: ['aras_9021'] } : x));
  expectMatch('aras_9021', 'kesin', 'U001', learned);
  expectMatch('Aras', 'öneri', 'U001', learned);
});

test('eşikler ayarlanabilir', () => {
  const r = C.matchName('Seyma', MEMBERS, { exact: 0.8 });
  assert.strictEqual(r.status, 'kesin');
  const r2 = C.matchName('Seyma', MEMBERS, { suggest: 0.9 });
  assert.strictEqual(r2.status, 'misafir');
});

// --- Aralıklar ---------------------------------------------------------------

test('çakışan aralıklar birleşir (iki cihaz)', () => {
  const ivs = [[0, 60], [30, 90], [120, 150]];
  assert.deepStrictEqual(C.mergeIntervals(ivs), [[0, 90], [120, 150]]);
  assert.strictEqual(C.totalDuration(ivs), 120);
});

test('çıkıp girme: süreler toplanır', () => {
  assert.strictEqual(C.totalDuration([[0, 10], [20, 30], [40, 45]]), 25);
});

test('aralıklar toplantı sınırına kırpılır, bozuk aralıklar atılır', () => {
  assert.deepStrictEqual(C.clampIntervals([[-10, 20], [50, 200]], 0, 100), [[0, 20], [50, 100]]);
  assert.deepStrictEqual(C.mergeIntervals([[5, 5], [10, 2], null, [1, 3]]), [[1, 3]]);
});

// --- Durum -------------------------------------------------------------------

const MIN = 60000;
const MEETING = { start: 0, end: 60 * MIN };

test('durum: geldi / geç / kısmi', () => {
  assert.strictEqual(C.attendanceStatus({ totalMs: 58 * MIN, firstJoin: 2 * MIN }, MEETING), 'geldi');
  assert.strictEqual(C.attendanceStatus({ totalMs: 45 * MIN, firstJoin: 15 * MIN }, MEETING), 'geç');
  assert.strictEqual(C.attendanceStatus({ totalMs: 20 * MIN, firstJoin: 0 }, MEETING), 'kısmi');
  // geç ve kısa: kısmi öncelikli
  assert.strictEqual(C.attendanceStatus({ totalMs: 10 * MIN, firstJoin: 50 * MIN }, MEETING), 'kısmi');
});

test('durum: eşikler ayarlanabilir, tam eşik değerleri', () => {
  assert.strictEqual(C.attendanceStatus({ totalMs: 30 * MIN, firstJoin: 10 * MIN }, MEETING), 'geldi');
  assert.strictEqual(C.attendanceStatus({ totalMs: 30 * MIN, firstJoin: 0 }, MEETING, { minPct: 75 }), 'kısmi');
  assert.strictEqual(C.attendanceStatus({ totalMs: 59 * MIN, firstJoin: 6 * MIN }, MEETING, { lateMin: 5 }), 'geç');
});

test('elle yazılan durum tanınır', () => {
  assert.strictEqual(C.parseStatus('Gec'), 'geç');
  assert.strictEqual(C.parseStatus('KISMI'), 'kısmi');
  assert.strictEqual(C.parseStatus('mazeret'), 'mazeretli');
  assert.strictEqual(C.parseStatus('???'), '');
});

// --- Özet --------------------------------------------------------------------

test('özet: katılım yüzdesi, üst üste kaçırma, mazeretli', () => {
  const members = [
    { id: 'A', name: 'A', subteam: 'yazılım', active: true },
    { id: 'B', name: 'B', subteam: 'mekanik, medya', active: true },
    { id: 'C', name: 'C', subteam: 'mekanik', active: false }
  ];
  const order = ['m1', 'm2', 'm3', 'm4'];
  const rows = [
    { memberId: 'A', meetingId: 'm1', status: 'geldi' },
    { memberId: 'A', meetingId: 'm2', status: 'kısmi' },
    { memberId: 'A', meetingId: 'm3', status: 'gelmedi' },
    { memberId: 'A', meetingId: 'm4', status: 'gelmedi' },
    { memberId: 'B', meetingId: 'm1', status: 'gelmedi' },
    { memberId: 'B', meetingId: 'm2', status: 'gelmedi' },
    { memberId: 'B', meetingId: 'm3', status: 'mazeretli' },
    { memberId: 'B', meetingId: 'm4', status: 'gelmedi' },
    { memberId: 'C', meetingId: 'm1', status: 'geldi' }
  ];
  const s = C.summarize(members, rows, order);
  const a = s.members.find((x) => x.id === 'A');
  const b = s.members.find((x) => x.id === 'B');
  assert.strictEqual(a.pct, 0.375); // (1 + 0.5) / 4
  assert.strictEqual(a.streak, 2);
  assert.strictEqual(a.lastAttended, 'm2');
  assert.strictEqual(b.pct, 0); // 0 / 3 (mazeretli sayılmaz)
  assert.strictEqual(b.streak, 3); // mazeretli seriyi bozmaz
  assert.deepStrictEqual(b.subteams, ['mekanik', 'medya']);

  const mek = s.subteams.find((t) => t.name === 'mekanik');
  assert.strictEqual(mek.activeCount, 1); // C pasif
  assert.strictEqual(mek.atRisk, 1);
  const yaz = s.subteams.find((t) => t.name === 'yazılım');
  assert.strictEqual(yaz.avgPct, 0.375);
});

test('özet: hiç toplantısı olmayan üye için yüzde boş', () => {
  const s = C.summarize([{ id: 'N', name: 'Yeni', subteam: '', active: true }], [], ['m1']);
  assert.strictEqual(s.members[0].pct, null);
  assert.strictEqual(s.members[0].streak, 0);
  assert.strictEqual(s.subteams[0].name, '(alt takım yok)');
});
