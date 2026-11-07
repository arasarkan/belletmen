/*
 * belletmen çekirdeği: isim normalizasyonu, bulanık eşleştirme, süre ve
 * katılım kuralları, özet hesabı.
 *
 * Saf JavaScript, bağımlılık yok. Aynı dosya iki yerde çalışır:
 *   - Node (testler):     require('./extension/lib/core.js')
 *   - Chrome eklentisi:   globalThis.BelletmenCore
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.BelletmenCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = '2.0.0';

  // ---------------------------------------------------------------------------
  // Sabitler
  // ---------------------------------------------------------------------------

  var STATUS = {
    GELDI: 'geldi',
    GEC: 'geç',
    KISMI: 'kısmi',
    GELMEDI: 'gelmedi',
    MAZERETLI: 'mazeretli'
  };

  var DEFAULT_RULES = {
    minPct: 50,          // toplantının en az %50'si, altı "kısmi"
    lateMin: 10,         // ilk girişten sonra 10 dk'yı geçen "geç"
    partialWeight: 0.5,  // katılım %'de kısmi kaç "geldi" sayılır
    lateWeight: 1,       // katılım %'de geç kaç "geldi" sayılır
    streakWarn: 2        // alt takım özetinde "üst üste N+ kaçıran"
  };

  var DEFAULT_MATCH = {
    exact: 0.92,     // bu skorun üstü (ve rakipten belirgin şekilde iyi) => kesin
    suggest: 0.75,   // bu skorun üstü => öneri (İnceleme'ye düşer)
    margin: 0.05,    // en iyi iki aday bu kadar yakınsa kesin sayma
    stopwords: []    // ek yok sayılacak kelimeler (normalize edilmiş halde)
  };

  var TR_MAP = {
    'ı': 'i', 'İ': 'i', // ı İ
    'ş': 's', 'Ş': 's', // ş Ş
    'ğ': 'g', 'Ğ': 'g', // ğ Ğ
    'ü': 'u', 'Ü': 'u', // ü Ü
    'ö': 'o', 'Ö': 'o', // ö Ö
    'ç': 'c', 'Ç': 'c'  // ç Ç
  };
  var TR_RE = /[ıİşŞğĞüÜöÖçÇ]/g;

  // Cihaz kelimeleri ve Türkçe ekli halleri: "telefonu", "ipadi", "bilgisayarım"
  var DEVICE_ROOTS = [
    'ipad', 'iphone', 'ipod', 'telefon', 'tablet', 'android', 'samsung', 'galaxy',
    'xiaomi', 'redmi', 'huawei', 'oppo', 'laptop', 'notebook', 'bilgisayar', 'pc',
    'macbook', 'imac', 'chromebook', 'cihaz', 'phone', 'mobil', 'mobile', 'tel'
  ];
  var DEVICE_RE = new RegExp(
    '^(' + DEVICE_ROOTS.join('|') + ')(s|i|u|im|um|in|un|si|su|nin|nun|imiz|umuz|leri|lari|da|de|dan|den)?$'
  );

  var BASE_STOPWORDS = {
    frc: 1, team: 1, takim: 1, takimi: 1, robotics: 1, robotik: 1, the: 1,
    misafir: 1, guest: 1
  };

  // Görünen addaki Meet işaretleri: "(Sen)", "(You)", "(Sunum)" vb.
  var MARKER_RE = /\s*[(\[]\s*(sen|siz|you|me|ben|sunum|sunuyor|sunucu|presentation|presenting|host|organizer|organizatör|toplantı sahibi|ortak organizatör|co-host)\s*[)\]]\s*/gi;
  var PRESENTATION_RE = /[(\[]\s*(sunum|presentation)\s*[)\]]|\bsunuyor\b|\bis presenting\b|\bpresenting\b|sunumu$/i;
  var SELF_WORDS = { sen: 1, siz: 1, you: 1, ben: 1, me: 1 };

  // ---------------------------------------------------------------------------
  // Görünen ad temizliği (büyük/küçük harf korunur; anahtar olarak kullanılır)
  // ---------------------------------------------------------------------------

  /** Meet'ten okunan ham adı tek satıra indirir ve "(Sen)" gibi işaretleri atar. */
  function cleanDisplayName(raw) {
    var s = String(raw == null ? '' : raw);
    s = s.split(/[\r\n]+/)[0] || '';
    s = s.replace(MARKER_RE, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    return s.slice(0, 100);
  }

  /** "Ali Kaya (Sunum)" gibi ekran paylaşımı kutucukları ayrı kişi değildir. */
  function isPresentationLabel(raw) {
    return PRESENTATION_RE.test(String(raw == null ? '' : raw));
  }

  /** Görünen ad yalnızca "Sen"/"You" ise true (kendi kutucuğun). */
  function isSelfOnlyLabel(raw) {
    var n = normalizeName(raw);
    return !!SELF_WORDS[n] || /^\(?\s*(sen|you)\s*\)?$/i.test(String(raw || '').trim());
  }

  // ---------------------------------------------------------------------------
  // Normalizasyon
  // ---------------------------------------------------------------------------

  function toAsciiLower(s) {
    s = String(s == null ? '' : s).replace(TR_RE, function (c) { return TR_MAP[c]; });
    s = s.toLowerCase();
    if (typeof s.normalize === 'function') s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
    return s;
  }

  function stopwordSet(extra) {
    var set = {};
    var k;
    for (k in BASE_STOPWORDS) if (Object.prototype.hasOwnProperty.call(BASE_STOPWORDS, k)) set[k] = 1;
    (extra || []).forEach(function (w) {
      toAsciiLower(w).split(/[^a-z]+/).forEach(function (t) { if (t) set[t] = 1; });
    });
    return set;
  }

  /**
   * Adı ayrıştırır.
   * @returns {{normalized: string, tokens: string[], hadDevice: boolean}}
   */
  function analyzeName(raw, extraStopwords) {
    var s = String(raw == null ? '' : raw);
    s = s.replace(/[(\[{][^)\]}]*[)\]}]/g, ' ');              // parantez içini at
    s = toAsciiLower(s);
    s = s.replace(/['’‘`´ʼ][^\s]*/g, ' '); // kesme işaretinden sonrası: mehmet'in -> mehmet
    s = s.replace(/[^a-z0-9]+/g, ' ');                          // emoji, _, ., - ...
    var stop = stopwordSet(extraStopwords);
    var hadDevice = false;
    var tokens = [];
    s.split(' ').forEach(function (t) {
      if (/^[a-z]{0,2}[0-9]/.test(t)) return;                   // "9021", "a52", "s21" (model/numara)
      t = t.replace(/[0-9]+/g, '');                              // "aras9021" -> "aras"
      if (!t) return;
      if (DEVICE_RE.test(t)) { hadDevice = true; return; }
      if (stop[t]) return;
      tokens.push(t);
    });
    return { normalized: tokens.join(' '), tokens: tokens, hadDevice: hadDevice };
  }

  /** "Şeyma YILDIZ" (emoji, rakam ve noktalama dahil) -> "seyma yildiz" */
  function normalizeName(raw, extraStopwords) {
    return analyzeName(raw, extraStopwords).normalized;
  }

  /** Takma ad karşılaştırma anahtarı: harf/rakam korunur, cihaz kelimeleri atılmaz. */
  function aliasKey(raw) {
    return toAsciiLower(cleanDisplayName(raw)).replace(/[^a-z0-9]+/g, ' ').trim();
  }

  /** Normalizasyonla bilgi kaybetmeyen takma ad mı? ("Ecem" evet, "aras_9021" hayır) */
  function isCleanAlias(raw, extraStopwords) {
    var n = normalizeName(raw, extraStopwords);
    return !!n && n === aliasKey(raw);
  }

  /** Kesme işaretsiz iyelik eki: "mehmetin" -> "mehmet", "aysenin" -> "ayse" */
  function stripPossessive(t) {
    var m = /^(.{3,}?)(n?[iu]n)$/.exec(t);
    return m ? m[1] : t;
  }

  // ---------------------------------------------------------------------------
  // Benzerlik ölçüleri
  // ---------------------------------------------------------------------------

  function jaroWinkler(a, b) {
    if (a === b) return 1;
    var la = a.length, lb = b.length;
    if (!la || !lb) return 0;
    var range = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
    var aM = new Array(la), bM = new Array(lb);
    var matches = 0, i, j;
    for (i = 0; i < la; i++) {
      var lo = Math.max(0, i - range), hi = Math.min(lb - 1, i + range);
      for (j = lo; j <= hi; j++) {
        if (!bM[j] && a.charAt(i) === b.charAt(j)) { aM[i] = bM[j] = true; matches++; break; }
      }
    }
    if (!matches) return 0;
    var t = 0, k = 0;
    for (i = 0; i < la; i++) {
      if (!aM[i]) continue;
      while (!bM[k]) k++;
      if (a.charAt(i) !== b.charAt(k)) t++;
      k++;
    }
    t /= 2;
    var jaro = (matches / la + matches / lb + (matches - t) / matches) / 3;
    var prefix = 0;
    for (i = 0; i < Math.min(4, la, lb); i++) { if (a.charAt(i) === b.charAt(i)) prefix++; else break; }
    return jaro + prefix * 0.1 * (1 - jaro);
  }

  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    var prev = [], cur = [], i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur = [i];
      for (j = 1; j <= b.length; j++) {
        var cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      prev = cur;
    }
    return prev[b.length];
  }

  function levenshteinRatio(a, b) {
    var m = Math.max(a.length, b.length);
    return m ? 1 - levenshtein(a, b) / m : 1;
  }

  // ---------------------------------------------------------------------------
  // Skorlama
  // ---------------------------------------------------------------------------

  var TOKEN_MIN = 0.8;         // bu benzerliğin altındaki kelimeler eşleşmiş sayılmaz
  var INITIAL_SIM = 0.86;      // "a" ~ "arkan"
  var PARTIAL_FACTOR = 0.86;   // yalnızca ad ya da yalnızca soyad eşleşti
  var EXTRA_TOKEN_PENALTY = 0.15;

  function tokenSim(d, m, hadDevice) {
    if (d.length === 1 || m.length === 1) return d.charAt(0) === m.charAt(0) ? INITIAL_SIM : 0;
    var s = wordSim(d, m);
    if (hadDevice) {
      var st = stripPossessive(d);
      if (st !== d) s = Math.max(s, wordSim(st, m));
    }
    return s;
  }

  // Jaro-Winkler ortak öneki fazla ödüllendirir ("demirci" ~ "demir" = 0.94).
  // Levenshtein oranıyla ortalamak uzunluk farkını da hesaba katar.
  function wordSim(a, b) {
    if (a === b) return 1;
    return (jaroWinkler(a, b) + levenshteinRatio(a, b)) / 2;
  }

  /** Görünen adın kelimelerini bir hedef adın kelimeleriyle karşılaştırır (0..1). */
  function scoreTokens(dTokens, mTokens, hadDevice) {
    if (!dTokens.length || !mTokens.length) return 0;
    if (dTokens.join(' ') === mTokens.join(' ')) return 1;

    var pairs = [], i, j;
    for (i = 0; i < dTokens.length; i++) {
      for (j = 0; j < mTokens.length; j++) {
        var s = tokenSim(dTokens[i], mTokens[j], hadDevice);
        if (s >= TOKEN_MIN) pairs.push({ i: i, j: j, s: s });
      }
    }
    pairs.sort(function (x, y) { return y.s - x.s; });
    var usedD = {}, usedM = {}, sum = 0, matched = 0, allInitials = true;
    pairs.forEach(function (p) {
      if (usedD[p.i] || usedM[p.j]) return;
      usedD[p.i] = usedM[p.j] = true;
      sum += p.s; matched++;
      if (p.s !== INITIAL_SIM) allInitials = false;
    });

    var score = 0;
    if (matched && !allInitials) {
      var avg = sum / matched;
      var last = mTokens.length - 1;
      var givenMatched = false;
      for (j = 0; j < last; j++) if (usedM[j]) givenMatched = true;
      var full = matched === mTokens.length || (usedM[last] && givenMatched);
      score = (full ? avg : avg * PARTIAL_FACTOR) - EXTRA_TOKEN_PENALTY * (dTokens.length - matched);
    }

    // Bitişik yazım: "arasaksoy" ~ "aras aksoy"
    if (dTokens.length === 1 && dTokens[0].length >= 6 && mTokens.length >= 2) {
      var r = levenshteinRatio(dTokens[0], mTokens.join(''));
      if (r >= 0.85) score = Math.max(score, r);
    }
    return Math.max(0, Math.min(1, score));
  }

  function round3(x) { return Math.round(x * 1000) / 1000; }

  function mergeOpts(base, extra) {
    var out = {}, k;
    for (k in base) if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
    if (extra) for (k in extra) if (Object.prototype.hasOwnProperty.call(extra, k) && extra[k] != null) out[k] = extra[k];
    return out;
  }

  /**
   * Meet'teki görünen adı üye listesiyle eşleştirir.
   * @param {string} displayName
   * @param {{id: string, name: string, aliases?: string[]}[]} members
   * @param {object} [opts] {exact, suggest, margin, stopwords}
   * @returns {{status: 'kesin'|'öneri'|'misafir', memberId: string|null, score: number,
   *            candidates: {id: string, score: number}[], normalized: string, reason: string}}
   */
  function matchName(displayName, members, opts) {
    opts = mergeOpts(DEFAULT_MATCH, opts);
    var info = analyzeName(cleanDisplayName(displayName), opts.stopwords);
    var result = { status: 'misafir', memberId: null, score: 0, candidates: [], normalized: info.normalized, reason: '' };
    if (!info.tokens.length) { result.reason = 'boş ad'; return result; }

    // 1) Birebir eşleşme:
    //    a) kayıtlı takma adın kendisi ("aras_9021" yalnızca "aras_9021" ile eşleşir),
    //    b) üyenin adı, normalize edilmiş halde ("ŞEYMA YILDIZ" = "Şeyma Yıldız"),
    //    c) normalizasyonla bir şey kaybetmeyen takma ad ("Ecem").
    //    "Mehmet'in iPad'i" gibi bir takma ad normalize edilince "mehmet"e indiği
    //    için (b/c) ile eşleştirilmez; yoksa her "Mehmet" o üyeye giderdi.
    var key = aliasKey(displayName);
    var exactHits = [];
    (members || []).forEach(function (m) {
      if (normalizeName(m.name, opts.stopwords) === info.normalized) {
        exactHits.push({ id: m.id, via: 'ad' });
        return;
      }
      var aliases = m.aliases || [];
      for (var i = 0; i < aliases.length; i++) {
        var a = aliases[i];
        if (!a) continue;
        var ak = aliasKey(a);
        if (ak === key || (isCleanAlias(a, opts.stopwords) && normalizeName(a, opts.stopwords) === info.normalized)) {
          exactHits.push({ id: m.id, via: 'takma ad' });
          return;
        }
      }
    });
    if (exactHits.length === 1) {
      result.status = 'kesin';
      result.memberId = exactHits[0].id;
      result.score = 1;
      result.candidates = [{ id: exactHits[0].id, score: 1 }];
      result.reason = exactHits[0].via === 'ad' ? 'ad birebir' : 'takma ad';
      return result;
    }
    if (exactHits.length > 1) {
      result.status = 'öneri';
      result.memberId = exactHits[0].id;
      result.score = 1;
      result.candidates = exactHits.map(function (h) { return { id: h.id, score: 1 }; });
      result.reason = 'birden fazla üyeyle aynı';
      return result;
    }

    // 2) Bulanık eşleştirme (ad ve takma adlar üzerinden en iyi skor)
    var scored = (members || []).map(function (m) {
      var best = 0;
      var targets = [m.name].concat((m.aliases || []).filter(function (a) { return a && isCleanAlias(a, opts.stopwords); }));
      targets.forEach(function (n) {
        if (!n) return;
        var t = analyzeName(n, opts.stopwords).tokens;
        best = Math.max(best, scoreTokens(info.tokens, t, info.hadDevice));
      });
      return { id: m.id, score: round3(best) };
    }).filter(function (c) { return c.score > 0; });
    scored.sort(function (a, b) { return b.score - a.score; });

    result.candidates = scored.slice(0, 3);
    if (!scored.length) { result.reason = 'aday yok'; return result; }
    var best = scored[0], second = scored[1];
    result.score = best.score;

    if (best.score >= opts.exact && (!second || second.score < best.score - opts.margin)) {
      result.status = 'kesin';
      result.memberId = best.id;
      result.reason = 'bulanık';
    } else if (best.score >= opts.suggest) {
      result.status = 'öneri';
      result.memberId = best.id;
      result.reason = second && second.score >= best.score - opts.margin ? 'adaylar çok yakın' : 'düşük güven';
    } else {
      result.reason = 'eşik altı';
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Zaman aralıkları ([başlangıçMs, bitişMs])
  // ---------------------------------------------------------------------------

  /** Çakışan/bitişik aralıkları birleştirir (iki cihazdan girişte süre iki kez sayılmaz). */
  function mergeIntervals(list) {
    var arr = (list || []).filter(function (iv) {
      return iv && isFinite(iv[0]) && isFinite(iv[1]) && iv[1] > iv[0];
    }).map(function (iv) { return [Number(iv[0]), Number(iv[1])]; });
    arr.sort(function (a, b) { return a[0] - b[0]; });
    var out = [];
    arr.forEach(function (iv) {
      var last = out[out.length - 1];
      if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
      else out.push(iv);
    });
    return out;
  }

  function clampIntervals(list, start, end) {
    return mergeIntervals((list || []).map(function (iv) {
      return [Math.max(iv[0], start), Math.min(iv[1], end)];
    }));
  }

  function totalDuration(list) {
    return mergeIntervals(list).reduce(function (s, iv) { return s + iv[1] - iv[0]; }, 0);
  }

  // ---------------------------------------------------------------------------
  // Katılım kuralları
  // ---------------------------------------------------------------------------

  /**
   * @param {{totalMs: number, firstJoin: number}} entry
   * @param {{start: number, end: number}} meeting
   * @param {{minPct?: number, lateMin?: number}} [rules]
   * @returns {string} geldi | geç | kısmi
   */
  function attendanceStatus(entry, meeting, rules) {
    rules = mergeOpts(DEFAULT_RULES, rules);
    var meetingMs = meeting.end - meeting.start;
    if (meetingMs > 0 && entry.totalMs < meetingMs * rules.minPct / 100) return STATUS.KISMI;
    if (entry.firstJoin - meeting.start > rules.lateMin * 60000) return STATUS.GEC;
    return STATUS.GELDI;
  }

  /** Elle yazılmış durumu (ör. "gec", "Kismi") resmi değere çevirir. */
  function parseStatus(s) {
    var n = toAsciiLower(s).replace(/[^a-z]/g, '');
    var map = { geldi: STATUS.GELDI, gec: STATUS.GEC, kismi: STATUS.KISMI, gelmedi: STATUS.GELMEDI, mazeretli: STATUS.MAZERETLI, mazeret: STATUS.MAZERETLI };
    return map[n] || '';
  }

  // ---------------------------------------------------------------------------
  // Özet
  // ---------------------------------------------------------------------------

  function splitList(s) {
    return String(s == null ? '' : s).split(',').map(function (x) { return x.trim(); }).filter(Boolean);
  }

  /**
   * @param {{id, name, subteam, active}[]} members
   * @param {{memberId, meetingId, status}[]} rows  Yoklama satırları
   * @param {string[]} meetingOrder  toplantı ID'leri, eskiden yeniye
   * @param {object} [rules] {partialWeight, lateWeight}
   */
  function summarize(members, rows, meetingOrder, rules) {
    rules = mergeOpts(DEFAULT_RULES, rules);
    var orderIdx = {};
    (meetingOrder || []).forEach(function (id, i) { orderIdx[id] = i; });
    var byMember = {};
    (rows || []).forEach(function (r) {
      if (!(r.meetingId in orderIdx)) return;
      (byMember[r.memberId] = byMember[r.memberId] || []).push(r);
    });
    var lastMeeting = meetingOrder && meetingOrder.length ? meetingOrder[meetingOrder.length - 1] : null;
    var present = {}; present[STATUS.GELDI] = 1; present[STATUS.GEC] = 1; present[STATUS.KISMI] = 1;

    var out = (members || []).map(function (m) {
      var list = (byMember[m.id] || []).slice().sort(function (a, b) { return orderIdx[a.meetingId] - orderIdx[b.meetingId]; });
      var c = {}; c[STATUS.GELDI] = 0; c[STATUS.GEC] = 0; c[STATUS.KISMI] = 0; c[STATUS.GELMEDI] = 0; c[STATUS.MAZERETLI] = 0;
      var lastAttended = null, lastStatus = null;
      list.forEach(function (r) {
        var st = parseStatus(r.status) || STATUS.GELMEDI;
        c[st]++;
        if (present[st]) lastAttended = r.meetingId;
        if (r.meetingId === lastMeeting) lastStatus = st;
      });
      var considered = list.length - c[STATUS.MAZERETLI];
      var pct = considered > 0
        ? (c[STATUS.GELDI] + c[STATUS.GEC] * rules.lateWeight + c[STATUS.KISMI] * rules.partialWeight) / considered
        : null;
      var streak = 0;
      for (var i = list.length - 1; i >= 0; i--) {
        var s = parseStatus(list[i].status) || STATUS.GELMEDI;
        if (s === STATUS.MAZERETLI) continue;
        if (s === STATUS.GELMEDI) streak++; else break;
      }
      return {
        id: m.id, name: m.name, subteams: splitList(m.subteam), active: m.active !== false,
        total: list.length, counts: c, pct: pct == null ? null : round3(pct), streak: streak,
        lastAttended: lastAttended, lastStatus: lastStatus
      };
    });

    var teams = {};
    out.forEach(function (m) {
      if (!m.active) return;
      (m.subteams.length ? m.subteams : ['(alt takım yok)']).forEach(function (t) {
        var g = teams[t] = teams[t] || { name: t, activeCount: 0, pctSum: 0, pctN: 0, lastMeetingPresent: 0, atRisk: 0 };
        g.activeCount++;
        if (m.pct != null) { g.pctSum += m.pct; g.pctN++; }
        if (m.lastStatus && present[m.lastStatus]) g.lastMeetingPresent++;
        if (m.streak >= rules.streakWarn) g.atRisk++;
      });
    });
    var subteams = Object.keys(teams).sort(function (a, b) { return a.localeCompare(b, 'tr'); }).map(function (k) {
      var g = teams[k];
      return { name: g.name, activeCount: g.activeCount, avgPct: g.pctN ? round3(g.pctSum / g.pctN) : null, lastMeetingPresent: g.lastMeetingPresent, atRisk: g.atRisk };
    });
    return { members: out, subteams: subteams, lastMeetingId: lastMeeting };
  }

  return {
    VERSION: VERSION,
    STATUS: STATUS,
    DEFAULT_RULES: DEFAULT_RULES,
    DEFAULT_MATCH: DEFAULT_MATCH,
    cleanDisplayName: cleanDisplayName,
    isPresentationLabel: isPresentationLabel,
    isSelfOnlyLabel: isSelfOnlyLabel,
    analyzeName: analyzeName,
    normalizeName: normalizeName,
    aliasKey: aliasKey,
    isCleanAlias: isCleanAlias,
    jaroWinkler: jaroWinkler,
    levenshtein: levenshtein,
    levenshteinRatio: levenshteinRatio,
    scoreTokens: scoreTokens,
    matchName: matchName,
    mergeIntervals: mergeIntervals,
    clampIntervals: clampIntervals,
    totalDuration: totalDuration,
    attendanceStatus: attendanceStatus,
    parseStatus: parseStatus,
    splitList: splitList,
    summarize: summarize
  };
});
