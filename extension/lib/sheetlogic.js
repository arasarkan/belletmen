/*
 * belletmen: Google Sheets tablosunun şeması ve tüm tablo mantığı.
 *
 * Ağ yok, DOM yok. Tablonun okunmuş hali (model) bir Workbook'a sarılır;
 * mantık fonksiyonları Workbook'u bellekte değiştirir ve bunu Sheets API
 * batchUpdate isteklerine çevirir. Tek bir batchUpdate atomiktir: ya hepsi
 * yazılır ya hiçbiri. Bu yüzden yarım kalmış yazım olmaz.
 *
 * Model: {
 *   timeZone: 'Europe/Istanbul',
 *   sheets: [{ sheetId, title, rowCount, colCount, values: [[...], ...] }]
 * }
 * values, valueRenderOption=UNFORMATTED_VALUE ve
 * dateTimeRenderOption=SERIAL_NUMBER ile okunur (tarihler seri sayı).
 */
(function (root, factory) {
  var core = root && root.BelletmenCore;
  if (!core && typeof require === 'function') core = require('./core.js');
  var api = factory(core);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.BelletmenSheetLogic = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Core) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Şema
  // ---------------------------------------------------------------------------

  var KEYS = ['members', 'meetings', 'attendance', 'review', 'summary', 'settings'];

  var TITLES = {
    members: 'Üyeler',
    meetings: 'Toplantılar',
    attendance: 'Yoklama',
    review: 'İnceleme',
    summary: 'Özet',
    settings: 'Ayarlar'
  };

  // Yeni oluşturulan sayfalara verilen sabit kimlikler
  var SHEET_IDS = { members: 101, meetings: 102, attendance: 103, review: 104, summary: 105, settings: 106 };

  var HEADERS = {
    members: ['Üye ID', 'Ad Soyad', 'Alt takım', 'Durum', 'Takma adlar'],
    meetings: ['Toplantı ID', 'Tarih', 'Ad', 'Başlangıç', 'Bitiş', 'Süre (dk)', 'Gelen üye', 'İncelenecek', 'Kaydedildi'],
    attendance: ['Toplantı ID', 'Tarih', 'Toplantı', 'Üye ID', 'Ad Soyad', 'Alt takım', 'Durum', 'Süre (dk)', 'İlk giriş', 'Bağlanma', 'Meet adları', 'Not', '_aralıklar'],
    review: ['Toplantı ID', 'Tarih', 'Meet adı', 'Önerilen üye', 'Skor', 'Süre (dk)', 'Seçim', 'İşlendi', '_aralıklar', '_bağlanma'],
    settings: ['Ayar', 'Değer', 'Açıklama']
  };

  // [etiket, varsayılan, açıklama, iç anahtar]
  var SETTINGS_DEF = [
    ['Minimum katılım (%)', 50, 'Toplantının bu yüzdesinden az kalan "kısmi" sayılır.', 'minPct'],
    ['Geç kalma eşiği (dk)', 10, 'Yoklama başladıktan bu kadar dakika sonra giren "geç" sayılır.', 'lateMin'],
    ['Kısmi katılım ağırlığı', 0.5, 'Katılım %\'de bir "kısmi" kaç "geldi" sayılır (0-1).', 'partialWeight'],
    ['Geç katılım ağırlığı', 1, 'Katılım %\'de bir "geç" kaç "geldi" sayılır (0-1).', 'lateWeight'],
    ['Kesin eşleşme eşiği', 0.92, 'Bu skorun üstündeki eşleşmeler sormadan kaydedilir (0-1).', 'exact'],
    ['Öneri eşiği', 0.75, 'Bu skorun üstü İnceleme\'ye öneri olarak düşer, altı misafir sayılır (0-1).', 'suggest'],
    ['Yok sayılacak kelimeler', '', 'Meet adlarından atılacak ek kelimeler, virgülle (ör. takım adınız: "incredibal").', 'stopwords'],
    ['Uyarı: üst üste kaçırma', 2, 'Özet\'te bu kadar üst üste kaçıran kırmızıyla işaretlenir.', 'streakWarn']
  ];

  var STATUS_LIST = ['geldi', 'geç', 'kısmi', 'gelmedi', 'mazeretli'];
  var STATUS_COLORS = { 'geldi': '#e6f4ea', 'geç': '#fef7e0', 'kısmi': '#fde7cf', 'gelmedi': '#fce8e6', 'mazeretli': '#e8eaed' };
  var MEMBER_STATE = ['aktif', 'pasif'];
  var GUEST_CHOICE = 'Misafir';
  var HEADER_BG = '#e8eaf6';
  var CELL_FIELDS = 'userEnteredValue,userEnteredFormat(numberFormat,backgroundColor,textFormat)';

  var FMT = {
    DATE: { type: 'DATE', pattern: 'dd.mm.yyyy' },
    TIME: { type: 'TIME', pattern: 'hh:mm' },
    DATETIME: { type: 'DATE_TIME', pattern: 'dd.mm.yyyy hh:mm' },
    PCT: { type: 'PERCENT', pattern: '0%' }
  };

  var DEFAULT_ROWS = 1000;

  // ---------------------------------------------------------------------------
  // Saat dilimi ve seri tarih
  // ---------------------------------------------------------------------------

  function tzOffsetMs(tz, ms) {
    try {
      var dtf = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
      var p = {};
      dtf.formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
      var asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
      return asUtc - Math.floor(ms / 1000) * 1000;
    } catch (e) {
      return -new Date(ms).getTimezoneOffset() * 60000;
    }
  }

  function hexToColor(hex) {
    var n = parseInt(hex.slice(1), 16);
    return { red: ((n >> 16) & 255) / 255, green: ((n >> 8) & 255) / 255, blue: (n & 255) / 255 };
  }

  // ---------------------------------------------------------------------------
  // Workbook: bellekteki tablo + bekleyen istekler
  // ---------------------------------------------------------------------------

  function Workbook(model) {
    var self = this;
    this.timeZone = model.timeZone || 'Europe/Istanbul';
    this.sheets = {};          // başlık -> Sheet
    this.pre = [];             // hücre yazımlarından önce: addSheet, appendDimension, temizleme
    this.post = [];            // sonra: notlar, doğrulama, biçim
    this.cells = {};           // sheetId -> { satır -> { sütun -> hücre } }
    (model.sheets || []).forEach(function (s) { self.sheets[s.title] = new Sheet(self, s); });
  }

  Workbook.prototype.sheet = function (key) { return this.sheets[TITLES[key]] || null; };

  Workbook.prototype.addSheet = function (key) {
    var used = {};
    var self = this;
    Object.keys(this.sheets).forEach(function (t) { used[self.sheets[t].sheetId] = true; });
    var id = SHEET_IDS[key];
    while (used[id]) id += 100;
    var cols = Math.max(HEADERS[key] ? HEADERS[key].length : 12, 12);
    this.pre.push({ addSheet: { properties: {
      sheetId: id, title: TITLES[key], index: KEYS.indexOf(key),
      gridProperties: { rowCount: DEFAULT_ROWS, columnCount: cols, frozenRowCount: key === 'summary' ? 2 : 1 }
    } } });
    var sh = new Sheet(this, { sheetId: id, title: TITLES[key], rowCount: DEFAULT_ROWS, colCount: cols, values: [] });
    this.sheets[TITLES[key]] = sh;
    return sh;
  };

  Workbook.prototype.toSerial = function (ms) {
    return (ms + tzOffsetMs(this.timeZone, ms)) / 86400000 + 25569;
  };

  Workbook.prototype.toMs = function (v) {
    if (typeof v !== 'number' || !isFinite(v)) return NaN;
    var guess = (v - 25569) * 86400000;
    return Math.round(guess - tzOffsetMs(this.timeZone, guess - tzOffsetMs(this.timeZone, guess)));
  };

  /** Tarih hücresi: { v: seri sayı, fmt } */
  Workbook.prototype.date = function (ms, fmt) { return { v: this.toSerial(ms), fmt: fmt || FMT.DATE }; };

  Workbook.prototype._cell = function (sheetId, r, c, cell) {
    var s = this.cells[sheetId] = this.cells[sheetId] || {};
    var row = s[r] = s[r] || {};
    row[c] = cell;
  };

  /** Bekleyen her şeyi batchUpdate istek listesine çevirir. */
  Workbook.prototype.toRequests = function () {
    var reqs = this.pre.slice();
    var self = this;
    Object.keys(this.cells).forEach(function (sid) {
      var rows = self.cells[sid];
      Object.keys(rows).map(Number).sort(function (a, b) { return a - b; }).forEach(function (r) {
        var cols = Object.keys(rows[r]).map(Number).sort(function (a, b) { return a - b; });
        var run = [];
        var flush = function () {
          if (!run.length) return;
          reqs.push({ updateCells: {
            start: { sheetId: Number(sid), rowIndex: r - 1, columnIndex: run[0] - 1 },
            rows: [{ values: run.map(function (c) { return cellData(rows[r][c]); }) }],
            fields: CELL_FIELDS
          } });
          run = [];
        };
        cols.forEach(function (c) {
          if (run.length && c !== run[run.length - 1] + 1) flush();
          run.push(c);
        });
        flush();
      });
    });
    return reqs.concat(this.post);
  };

  function cellData(cell) {
    var o = cell !== null && typeof cell === 'object' ? cell : { v: cell };
    var d = {};
    var v = o.v;
    if (typeof v === 'number' && isFinite(v)) d.userEnteredValue = { numberValue: v };
    else if (typeof v === 'boolean') d.userEnteredValue = { boolValue: v };
    else if (v != null && v !== '') d.userEnteredValue = { stringValue: String(v) }; // stringValue asla formül olarak yorumlanmaz
    var f = {};
    if (o.fmt) f.numberFormat = o.fmt;
    if (o.bg) f.backgroundColor = hexToColor(o.bg);
    if (o.bold) f.textFormat = { bold: true };
    if (Object.keys(f).length) d.userEnteredFormat = f;
    return d;
  }

  // ---------------------------------------------------------------------------
  // Sheet
  // ---------------------------------------------------------------------------

  function Sheet(wb, s) {
    this.wb = wb;
    this.sheetId = s.sheetId;
    this.title = s.title;
    this.rowCount = s.rowCount || DEFAULT_ROWS;
    this.colCount = s.colCount || 26;
    this.values = (s.values || []).map(function (r) { return (r || []).slice(); });
  }

  Sheet.prototype.get = function (r, c) {
    var row = this.values[r - 1];
    var v = row ? row[c - 1] : undefined;
    return v == null ? '' : v;
  };

  Sheet.prototype.set = function (r, c, cell) {
    this.ensureRows(r);
    if (c > this.colCount) {
      this.wb.pre.push({ appendDimension: { sheetId: this.sheetId, dimension: 'COLUMNS', length: c - this.colCount + 5 } });
      this.colCount = c + 5;
    }
    while (this.values.length < r) this.values.push([]);
    var v = cell !== null && typeof cell === 'object' ? cell.v : cell;
    this.values[r - 1][c - 1] = v == null ? '' : v;
    this.wb._cell(this.sheetId, r, c, cell);
  };

  Sheet.prototype.ensureRows = function (n) {
    if (n <= this.rowCount) return;
    var add = n - this.rowCount + 500;
    this.wb.pre.push({ appendDimension: { sheetId: this.sheetId, dimension: 'ROWS', length: add } });
    this.rowCount += add;
  };

  Sheet.prototype.headers = function () {
    return (this.values[0] || []).map(function (h) { return String(h == null ? '' : h).trim(); });
  };

  Sheet.prototype.col = function (header) {
    var i = this.headers().indexOf(header);
    return i < 0 ? 0 : i + 1;
  };

  Sheet.prototype.lastRow = function () {
    for (var r = this.values.length; r >= 1; r--) {
      var row = this.values[r - 1];
      if (row && row.some(function (v) { return v !== '' && v != null; })) return r;
    }
    return 0;
  };

  /** Başlık → değer nesneleri; her birinde _row (1 tabanlı). */
  Sheet.prototype.rows = function () {
    var h = this.headers();
    var out = [];
    for (var r = 2; r <= this.lastRow(); r++) {
      var o = { _row: r }, empty = true;
      for (var c = 0; c < h.length; c++) {
        if (!h[c]) continue;
        var v = this.get(r, c + 1);
        o[h[c]] = v;
        if (v !== '') empty = false;
      }
      if (!empty) out.push(o);
    }
    return out;
  };

  /** Nesneyi başlıklara göre yazar (yalnızca nesnede olan sütunlar). */
  Sheet.prototype.writeObject = function (r, obj) {
    var self = this;
    this.headers().forEach(function (h, i) {
      if (h && Object.prototype.hasOwnProperty.call(obj, h)) self.set(r, i + 1, obj[h]);
    });
  };

  Sheet.prototype.appendObjects = function (objs) {
    var first = this.lastRow() + 1;
    var self = this;
    objs.forEach(function (o, i) {
      var r = first + i;
      self.headers().forEach(function (h, c) { if (h) self.set(r, c + 1, Object.prototype.hasOwnProperty.call(o, h) ? o[h] : ''); });
    });
    return first;
  };

  Sheet.prototype.note = function (r, c, text) {
    this.wb.post.push({ updateCells: {
      start: { sheetId: this.sheetId, rowIndex: r - 1, columnIndex: c - 1 },
      rows: [{ values: [{ note: text }] }],
      fields: 'note'
    } });
  };

  Sheet.prototype.colRange = function (c, fromRow) {
    return { sheetId: this.sheetId, startRowIndex: (fromRow || 2) - 1, startColumnIndex: c - 1, endColumnIndex: c };
  };

  Sheet.prototype.listValidation = function (c, values, strict) {
    if (!c) return;
    this.wb.post.push({ setDataValidation: {
      range: this.colRange(c),
      rule: {
        condition: { type: 'ONE_OF_LIST', values: values.slice(0, 500).map(function (v) { return { userEnteredValue: v }; }) },
        showCustomUi: true,
        strict: !!strict
      }
    } });
  };

  Sheet.prototype.width = function (c, px) {
    if (!c) return;
    this.wb.post.push({ updateDimensionProperties: {
      range: { sheetId: this.sheetId, dimension: 'COLUMNS', startIndex: c - 1, endIndex: c },
      properties: { pixelSize: px }, fields: 'pixelSize'
    } });
  };

  Sheet.prototype.hide = function (c) {
    if (!c) return;
    this.wb.post.push({ updateDimensionProperties: {
      range: { sheetId: this.sheetId, dimension: 'COLUMNS', startIndex: c - 1, endIndex: c },
      properties: { hiddenByUser: true }, fields: 'hiddenByUser'
    } });
  };

  Sheet.prototype.clear = function () {
    this.wb.pre.push({ updateCells: { range: { sheetId: this.sheetId }, fields: 'userEnteredValue,userEnteredFormat' } });
    this.values = [];
    delete this.wb.cells[this.sheetId];
  };

  // ---------------------------------------------------------------------------
  // Kurulum / onarım
  // ---------------------------------------------------------------------------

  /** Eksik sayfaları, başlıkları ve ayarları tamamlar. Yeni sayfaları biçimlendirir. */
  function ensureStructure(wb) {
    var changed = false;
    KEYS.forEach(function (key) {
      var sh = wb.sheet(key);
      var isNew = false;
      if (!sh) { sh = wb.addSheet(key); isNew = true; changed = true; }
      var want = HEADERS[key];
      if (want) {
        var have = sh.headers();
        var nonEmpty = have.filter(Boolean).length;
        var missing = want.filter(function (h) { return have.indexOf(h) < 0; });
        if (missing.length) {
          changed = true;
          var start = nonEmpty ? nonEmpty + 1 : 1;
          var list = nonEmpty ? missing : want;
          list.forEach(function (h, i) { sh.set(1, start + i, { v: h, bold: true, bg: HEADER_BG }); });
          isNew = isNew || !nonEmpty;
        }
      }
      if (isNew) formatSheet(wb, key, sh);
    });
    if (ensureSettings(wb)) changed = true;
    return changed;
  }

  function ensureSettings(wb) {
    var sh = wb.sheet('settings');
    var have = {};
    sh.rows().forEach(function (r) { have[String(r['Ayar']).trim()] = true; });
    var add = SETTINGS_DEF.filter(function (d) { return !have[d[0]]; }).map(function (d) {
      return { 'Ayar': d[0], 'Değer': d[1], 'Açıklama': d[2] };
    });
    if (add.length) sh.appendObjects(add);
    return add.length > 0;
  }

  function formatSheet(wb, key, sh) {
    if (key === 'members') {
      sh.listValidation(sh.col('Durum'), MEMBER_STATE, true);
      sh.note(1, sh.col('Üye ID'), 'Boş bırak; belletmen otomatik doldurur (U001, U002…). Sonradan değiştirme.');
      sh.note(1, sh.col('Alt takım'), 'Birden fazla alt takım için virgülle ayır: "yazılım, medya"');
      sh.note(1, sh.col('Durum'), 'Boş bırakılırsa "aktif" sayılır. Pasif üyeler "gelmedi" olarak işaretlenmez.');
      sh.note(1, sh.col('Takma adlar'), 'Meet\'te göründüğü adlar, virgülle. İnceleme uygulandıkça otomatik eklenir.');
      sh.width(sh.col('Ad Soyad'), 200);
      sh.width(sh.col('Alt takım'), 160);
      sh.width(sh.col('Takma adlar'), 320);
    } else if (key === 'attendance') {
      var c = sh.col('Durum');
      sh.listValidation(c, STATUS_LIST, true);
      sh.note(1, c, 'Mazeret için "mazeretli" seç. belletmen elle girilen "mazeretli"yi değiştirmez.');
      STATUS_LIST.forEach(function (st, i) {
        wb.post.push({ addConditionalFormatRule: { index: i, rule: {
          ranges: [sh.colRange(c)],
          booleanRule: { condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: st }] }, format: { backgroundColor: hexToColor(STATUS_COLORS[st]) } }
        } } });
      });
      sh.hide(sh.col('_aralıklar'));
      sh.width(sh.col('Ad Soyad'), 180);
      sh.width(sh.col('Meet adları'), 220);
    } else if (key === 'review') {
      sh.note(1, sh.col('Seçim'), 'Bu kişinin kim olduğunu seç ("' + GUEST_CHOICE + '" = takımdan değil), sonra eklentide "İncelemeyi uygula"ya bas.');
      sh.hide(sh.col('_aralıklar'));
      sh.hide(sh.col('_bağlanma'));
      sh.width(sh.col('Meet adı'), 200);
      sh.width(sh.col('Önerilen üye'), 220);
      sh.width(sh.col('Seçim'), 220);
    } else if (key === 'meetings') {
      sh.note(1, sh.col('Toplantı ID'), 'Eklentinin verdiği benzersiz kimlik; aynı yoklamanın iki kez yazılmasını önler.');
      sh.width(sh.col('Ad'), 220);
    } else if (key === 'settings') {
      sh.width(1, 200);
      sh.width(2, 120);
      sh.width(3, 520);
    }
  }

  // ---------------------------------------------------------------------------
  // Okuma
  // ---------------------------------------------------------------------------

  function memberLabel(m) { return m.name + ' [' + m.id + ']'; }

  function parseMemberLabel(s) {
    var m = /\[([^\]]+)\]\s*$/.exec(String(s || ''));
    return m ? m[1].trim() : '';
  }

  /** Üyeleri okur; boş Üye ID'lerini doldurur. */
  function readMembers(wb) {
    var sh = wb.sheet('members');
    if (!sh) return [];
    var rows = sh.rows();
    var maxN = 0;
    rows.forEach(function (r) {
      var m = /^U(\d+)$/.exec(String(r['Üye ID'] || '').trim());
      if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
    });
    var idCol = sh.col('Üye ID');
    var out = [];
    rows.forEach(function (r) {
      var name = String(r['Ad Soyad'] || '').trim();
      if (!name) return;
      var id = String(r['Üye ID'] || '').trim();
      if (!id) {
        maxN++;
        id = 'U' + ('00' + maxN).slice(-Math.max(3, String(maxN).length));
        sh.set(r._row, idCol, id);
      }
      out.push({
        id: id,
        name: name,
        subteam: String(r['Alt takım'] || '').trim(),
        active: Core.normalizeName(r['Durum']) !== 'pasif',
        aliases: Core.splitList(r['Takma adlar']),
        _row: r._row
      });
    });
    return out;
  }

  function readSettings(wb) {
    var sh = wb.sheet('settings');
    var byLabel = {};
    if (sh) sh.rows().forEach(function (r) { byLabel[String(r['Ayar']).trim()] = r['Değer']; });
    var s = {};
    SETTINGS_DEF.forEach(function (d) {
      var v = Object.prototype.hasOwnProperty.call(byLabel, d[0]) ? byLabel[d[0]] : d[1];
      if (d[3] === 'stopwords') { s.stopwords = Core.splitList(v); return; }
      var n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
      s[d[3]] = isFinite(n) ? n : d[1];
    });
    return {
      rules: { minPct: s.minPct, lateMin: s.lateMin, partialWeight: s.partialWeight, lateWeight: s.lateWeight, streakWarn: s.streakWarn },
      match: { exact: s.exact, suggest: s.suggest, stopwords: s.stopwords }
    };
  }

  function minutes(ms) { return Math.round(ms / 60000); }

  function parseIntervals(s) {
    try {
      var v = JSON.parse(String(s || '[]'));
      return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
  }

  /** İnceleme → Seçim açılır listesini günceller. */
  function refreshReviewChoices(wb, members) {
    var sh = wb.sheet('review');
    if (!sh) return;
    // Doğrulama listesindeki "=" ile başlayan değerler formül olarak yorumlanabilir;
    // başına görünmez bir boşluk koy (seçim yine sondaki [Üye ID]'den çözülür).
    var labels = members.map(memberLabel).map(function (l) { return /^[=+\-@]/.test(l) ? '\u200B' + l : l; });
    sh.listValidation(sh.col('Seçim'), [GUEST_CHOICE].concat(labels), false);
  }

  // ---------------------------------------------------------------------------
  // Yoklama işleme
  // ---------------------------------------------------------------------------

  function computeEntry(intervals, meeting, rules) {
    var ivs = Core.clampIntervals(intervals, meeting.start, meeting.end);
    if (!ivs.length) return null;
    var entry = { intervals: ivs, totalMs: Core.totalDuration(ivs), firstJoin: ivs[0][0] };
    entry.status = Core.attendanceStatus(entry, meeting, rules);
    return entry;
  }

  function attendanceObject(wb, meetingId, title, member, group, meeting, rules) {
    var entry = group ? computeEntry(group.intervals, meeting, rules) : null;
    return {
      'Toplantı ID': meetingId,
      'Tarih': wb.date(meeting.start, FMT.DATE),
      'Toplantı': title,
      'Üye ID': member.id,
      'Ad Soyad': member.name,
      'Alt takım': member.subteam,
      'Durum': entry ? entry.status : Core.STATUS.GELMEDI,
      'Süre (dk)': entry ? minutes(entry.totalMs) : 0,
      'İlk giriş': entry ? wb.date(entry.firstJoin, FMT.TIME) : '',
      'Bağlanma': group ? group.joins : 0,
      'Meet adları': group ? group.names.join(', ') : '',
      'Not': '',
      '_aralıklar': entry ? JSON.stringify(entry.intervals) : '[]'
    };
  }

  /** Gelen oturumu doğrular ve sadeleştirir. */
  function validateSession(s) {
    if (!s || typeof s !== 'object') throw new Error('Oturum verisi yok.');
    if (typeof s.id !== 'string' || !/^[\w-]{1,64}$/.test(s.id)) throw new Error('Geçersiz oturum kimliği.');
    var start = Number(s.startedAt), end = Number(s.endedAt);
    if (!isFinite(start) || !isFinite(end) || end < start) throw new Error('Geçersiz toplantı zamanı.');
    var participants = (s.participants || []).map(function (p) {
      var ivs = (p.intervals || []).map(function (iv) { return [Number(iv[0]), Number(iv[1])]; })
        .filter(function (iv) { return isFinite(iv[0]) && isFinite(iv[1]) && iv[1] >= iv[0]; });
      return { name: String(p.name || '').slice(0, 100).trim(), intervals: ivs, joins: Number(p.joins) || ivs.length };
    }).filter(function (p) { return p.name && p.intervals.length; });
    return { id: s.id, title: String(s.title || '').slice(0, 120), startedAt: start, endedAt: end, participants: participants };
  }

  /**
   * Bir yoklamayı tabloya işler.
   * @returns {{duplicate?: boolean, meetingId: string, members?: number, review?: number}}
   */
  function processAttendance(wb, session, nowMs) {
    var s = validateSession(session);
    var mt = wb.sheet('meetings'), att = wb.sheet('attendance'), rev = wb.sheet('review');

    var dup = mt.rows().some(function (r) { return String(r['Toplantı ID']) === s.id; });
    if (dup) return { duplicate: true, meetingId: s.id };

    var settings = readSettings(wb);
    var members = readMembers(wb);
    var byId = {};
    members.forEach(function (m) { byId[m.id] = m; });
    var meeting = { start: s.startedAt, end: s.endedAt };

    var groups = {};
    var review = [];
    s.participants.forEach(function (p) {
      var r = Core.matchName(p.name, members, settings.match);
      if (r.status === 'kesin') {
        var g = groups[r.memberId] = groups[r.memberId] || { intervals: [], joins: 0, names: [] };
        g.intervals = g.intervals.concat(p.intervals);
        g.joins += p.joins;
        g.names.push(p.name);
      } else {
        review.push({ p: p, r: r });
      }
    });

    var present = 0;
    var attRows = [];
    members.forEach(function (m) {
      var g = groups[m.id];
      if (!g && !m.active) return;
      var o = attendanceObject(wb, s.id, s.title, m, g, meeting, settings.rules);
      if (o['Durum'] !== Core.STATUS.GELMEDI) present++;
      attRows.push(o);
    });
    att.appendObjects(attRows);

    if (review.length) {
      var first = rev.appendObjects(review.map(function (x) {
        return {
          'Toplantı ID': s.id,
          'Tarih': wb.date(meeting.start, FMT.DATE),
          'Meet adı': x.p.name,
          'Önerilen üye': x.r.status === 'öneri' && byId[x.r.memberId] ? memberLabel(byId[x.r.memberId]) : '',
          'Skor': x.r.score,
          'Süre (dk)': minutes(Core.totalDuration(Core.clampIntervals(x.p.intervals, meeting.start, meeting.end))),
          'Seçim': '',
          'İşlendi': '',
          '_aralıklar': JSON.stringify(x.p.intervals),
          '_bağlanma': x.p.joins
        };
      }));
      var sugCol = rev.col('Önerilen üye');
      review.forEach(function (x, i) {
        var others = x.r.candidates.filter(function (c) { return byId[c.id]; }).map(function (c) {
          return memberLabel(byId[c.id]) + ' (' + c.score + ')';
        });
        rev.note(first + i, sugCol, 'Neden: ' + (x.r.reason || '-') + (others.length ? '\nAdaylar:\n' + others.join('\n') : ''));
      });
    }
    refreshReviewChoices(wb, members);

    mt.appendObjects([{
      'Toplantı ID': s.id,
      'Tarih': wb.date(s.startedAt, FMT.DATE),
      'Ad': s.title,
      'Başlangıç': wb.date(s.startedAt, FMT.TIME),
      'Bitiş': wb.date(s.endedAt, FMT.TIME),
      'Süre (dk)': minutes(s.endedAt - s.startedAt),
      'Gelen üye': present,
      'İncelenecek': review.length,
      'Kaydedildi': wb.date(nowMs || Date.now(), FMT.DATETIME)
    }]);

    return { meetingId: s.id, members: present, review: review.length };
  }

  // ---------------------------------------------------------------------------
  // İncelemeyi uygula
  // ---------------------------------------------------------------------------

  /** İnceleme'de "Seçim"i doldurulmuş ve işlenmemiş satırları uygular. */
  function applyReview(wb, nowMs) {
    var rev = wb.sheet('review'), att = wb.sheet('attendance'), mem = wb.sheet('members');
    var settings = readSettings(wb);
    var members = readMembers(wb);
    var byId = {};
    members.forEach(function (m) { byId[m.id] = m; });

    var meetings = {};
    wb.sheet('meetings').rows().forEach(function (r) {
      var start = wb.toMs(r['Başlangıç']), end = wb.toMs(r['Bitiş']);
      meetings[String(r['Toplantı ID'])] = { start: start, end: end, title: String(r['Ad'] || '') };
    });

    var res = { applied: 0, autoApplied: 0, aliasesAdded: 0, pending: 0, errors: [] };
    var pending = rev.rows().filter(function (r) { return r['İşlendi'] === '' && String(r['Meet adı']) !== ''; });
    var choiceCol = rev.col('Seçim'), doneCol = rev.col('İşlendi'), aliasCol = mem.col('Takma adlar');

    function targetOf(choice) { return choice === GUEST_CHOICE ? GUEST_CHOICE : parseMemberLabel(choice); }

    // Aynı Meet adıyla bekleyen diğer satırlar için öğrenilenler
    var learned = {};
    pending.forEach(function (r) {
      var choice = String(r['Seçim'] || '').trim();
      if (!choice) return;
      var t = targetOf(choice);
      if (t !== GUEST_CHOICE && !byId[t]) {
        res.errors.push('İnceleme satır ' + r._row + ': "' + choice + '" üye listesinde yok.');
        return;
      }
      learned[Core.aliasKey(r['Meet adı'])] = t;
    });

    pending.forEach(function (r) {
      var own = String(r['Seçim'] || '').trim();
      var auto = !own;
      var target = auto ? learned[Core.aliasKey(r['Meet adı'])] : targetOf(own);
      if (!target || (target !== GUEST_CHOICE && !byId[target])) { if (auto) res.pending++; return; }
      var meetName = String(r['Meet adı']);
      if (target !== GUEST_CHOICE) {
        var m = byId[target];
        var meeting = meetings[String(r['Toplantı ID'])];
        if (!meeting || !isFinite(meeting.start) || !isFinite(meeting.end)) {
          res.errors.push('İnceleme satır ' + r._row + ': toplantı "' + r['Toplantı ID'] + '" bulunamadı.');
          return;
        }
        if (addAlias(m, meetName)) {
          mem.set(m._row, aliasCol, m.aliases.join(', '));
          res.aliasesAdded++;
        }
        mergeIntoAttendance(wb, att, String(r['Toplantı ID']), meeting, m,
          parseIntervals(r['_aralıklar']), Number(r['_bağlanma']) || 1, meetName, settings.rules);
      }
      if (auto) {
        rev.set(r._row, choiceCol, target === GUEST_CHOICE ? GUEST_CHOICE : memberLabel(byId[target]));
        res.autoApplied++;
      }
      rev.set(r._row, doneCol, wb.date(nowMs || Date.now(), FMT.DATETIME));
      res.applied++;
    });
    if (res.aliasesAdded) refreshReviewChoices(wb, members);
    return res;
  }

  function addAlias(member, meetName) {
    var key = Core.aliasKey(meetName);
    if (!key || Core.aliasKey(member.name) === key) return false;
    for (var i = 0; i < member.aliases.length; i++) {
      if (Core.aliasKey(member.aliases[i]) === key) return false;
    }
    member.aliases.push(meetName.replace(/,/g, ' '));
    return true;
  }

  function mergeIntoAttendance(wb, att, meetingId, meeting, member, ivs, joins, meetName, rules) {
    var row = att.rows().filter(function (r) {
      return String(r['Toplantı ID']) === meetingId && String(r['Üye ID']) === member.id;
    })[0];
    if (!row) {
      att.appendObjects([attendanceObject(wb, meetingId, meeting.title, member,
        { intervals: ivs, joins: joins, names: [meetName] }, meeting, rules)]);
      return;
    }
    var entry = computeEntry(parseIntervals(row['_aralıklar']).concat(ivs), meeting, rules);
    if (!entry) return;
    var names = Core.splitList(row['Meet adları']);
    if (names.indexOf(meetName) < 0) names.push(meetName);
    var keep = Core.parseStatus(row['Durum']) === Core.STATUS.MAZERETLI;
    att.writeObject(row._row, {
      'Durum': keep ? Core.STATUS.MAZERETLI : entry.status,
      'Süre (dk)': minutes(entry.totalMs),
      'İlk giriş': wb.date(entry.firstJoin, FMT.TIME),
      'Bağlanma': (Number(row['Bağlanma']) || 0) + joins,
      'Meet adları': names.join(', '),
      '_aralıklar': JSON.stringify(entry.intervals)
    });
  }

  /** İnceleme'de kaç satır seçim bekliyor / uygulanmayı bekliyor? */
  function reviewCounts(wb) {
    var rev = wb.sheet('review');
    var out = { open: 0, chosen: 0 };
    if (!rev) return out;
    rev.rows().forEach(function (r) {
      if (r['İşlendi'] !== '' || String(r['Meet adı']) === '') return;
      out.open++;
      if (String(r['Seçim'] || '').trim()) out.chosen++;
    });
    return out;
  }

  // ---------------------------------------------------------------------------
  // Özet
  // ---------------------------------------------------------------------------

  function refreshSummary(wb, nowMs) {
    var settings = readSettings(wb);
    var members = readMembers(wb);
    var meetingRows = wb.sheet('meetings').rows()
      .filter(function (r) { return r['Toplantı ID'] !== ''; })
      .sort(function (a, b) { return (Number(a['Başlangıç']) || 0) - (Number(b['Başlangıç']) || 0); });
    var order = meetingRows.map(function (r) { return String(r['Toplantı ID']); });
    var dateById = {};
    meetingRows.forEach(function (r) { dateById[String(r['Toplantı ID'])] = r['Tarih']; });

    var rows = wb.sheet('attendance').rows().map(function (r) {
      return { memberId: String(r['Üye ID']), meetingId: String(r['Toplantı ID']), status: String(r['Durum']) };
    });
    var sum = Core.summarize(members, rows, order, settings.rules);

    var sh = wb.sheet('summary');
    sh.clear();
    var S = Core.STATUS;
    var header = ['Ad Soyad', 'Alt takım', 'Durum', 'Toplantı', 'Geldi', 'Geç', 'Kısmi', 'Gelmedi', 'Mazeretli', 'Katılım %', 'Üst üste kaçırma', 'Son katıldığı'];
    var minPct = (settings.rules.minPct || 50) / 100;
    var warn = settings.rules.streakWarn;

    sh.set(1, 1, { v: 'Kişi bazlı katılım', bold: true });
    sh.set(1, 4, 'Son güncelleme:');
    sh.set(1, 5, wb.date(nowMs || Date.now(), FMT.DATETIME));
    header.forEach(function (h, i) { sh.set(2, i + 1, { v: h, bold: true, bg: HEADER_BG }); });

    var people = sum.members.slice().sort(function (a, b) {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return a.subteams.join(', ').localeCompare(b.subteams.join(', '), 'tr') || a.name.localeCompare(b.name, 'tr');
    });
    people.forEach(function (m, i) {
      var r = 3 + i;
      var rowBg = m.active ? null : '#f1f3f4';
      var vals = [m.name, m.subteams.join(', '), m.active ? 'aktif' : 'pasif', m.total,
        m.counts[S.GELDI], m.counts[S.GEC], m.counts[S.KISMI], m.counts[S.GELMEDI], m.counts[S.MAZERETLI]];
      vals.forEach(function (v, c) { sh.set(r, c + 1, { v: v, bg: rowBg }); });
      sh.set(r, 10, { v: m.pct == null ? '' : m.pct, fmt: FMT.PCT, bg: m.pct != null && m.pct < minPct ? '#fde7cf' : rowBg });
      sh.set(r, 11, { v: m.streak, bg: m.streak >= warn ? '#f4c7c3' : rowBg });
      var last = m.lastAttended ? dateById[m.lastAttended] : '';
      sh.set(r, 12, { v: last === undefined ? '' : last, fmt: FMT.DATE, bg: rowBg });
    });

    var start = 3 + Math.max(people.length, 1) + 2;
    sh.set(start, 1, { v: 'Alt takım özeti', bold: true });
    ['Alt takım', 'Aktif üye', 'Ortalama katılım %', 'Son toplantıda gelen', 'Üst üste ' + warn + '+ kaçıran'].forEach(function (h, i) {
      sh.set(start + 1, i + 1, { v: h, bold: true, bg: HEADER_BG });
    });
    sum.subteams.forEach(function (t, i) {
      var r = start + 2 + i;
      sh.set(r, 1, t.name);
      sh.set(r, 2, t.activeCount);
      sh.set(r, 3, { v: t.avgPct == null ? '' : t.avgPct, fmt: FMT.PCT });
      sh.set(r, 4, t.lastMeetingPresent + ' / ' + t.activeCount);
      sh.set(r, 5, t.atRisk);
    });
    return sum;
  }

  /** Yeni tablo oluşturma isteğinin gövdesi (spreadsheets.create). */
  function createBody(title, timeZone) {
    return {
      properties: { title: title || 'belletmen yoklama', locale: 'tr_TR', timeZone: timeZone || 'Europe/Istanbul' },
      sheets: KEYS.map(function (key, i) {
        return { properties: {
          sheetId: SHEET_IDS[key], title: TITLES[key], index: i,
          gridProperties: { rowCount: DEFAULT_ROWS, columnCount: Math.max(HEADERS[key] ? HEADERS[key].length : 12, 12), frozenRowCount: key === 'summary' ? 2 : 1 }
        } };
      })
    };
  }

  return {
    KEYS: KEYS,
    TITLES: TITLES,
    HEADERS: HEADERS,
    SETTINGS_DEF: SETTINGS_DEF,
    GUEST_CHOICE: GUEST_CHOICE,
    FMT: FMT,
    Workbook: Workbook,
    tzOffsetMs: tzOffsetMs,
    createBody: createBody,
    ensureStructure: ensureStructure,
    readMembers: readMembers,
    readSettings: readSettings,
    validateSession: validateSession,
    processAttendance: processAttendance,
    applyReview: applyReview,
    reviewCounts: reviewCounts,
    refreshSummary: refreshSummary,
    memberLabel: memberLabel
  };
});
