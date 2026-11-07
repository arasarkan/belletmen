/*
 * belletmen: yoklama oturumu durum mantığı (saf JS, DOM yok).
 * Content script, service worker ve Node testleri aynı dosyayı kullanır.
 *
 * Bir oturum (session) şöyle görünür:
 * {
 *   v: 1, id, title, meetingCode, startedAt, endedAt, lastSeenAt, heartbeatAt,
 *   people: {
 *     "Aras Aksoy": { name, iv: [[giriş, çıkış|null], ...], joins, miss: null | {since, tol} }
 *   }
 * }
 * Anahtar, Meet'teki görünen addır ("(Sen)" gibi işaretler temizlenmiş halde).
 * Aynı adla iki cihazdan girilirse tek aralık olarak sayılır.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.BelletmenTracker = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DEFAULTS = {
    graceMs: 20000,   // bu süreden kısa kaybolmalar (DOM titremesi, kısa kopma) çıkış sayılmaz
    pauseTolMs: 120000 // izleyemediğimiz anlar (sayfa yenileme, panel okunamadı) için tolerans
  };

  function opt(o, k) { return o && o[k] != null ? o[k] : DEFAULTS[k]; }

  function createSession(o) {
    var now = o.startedAt != null ? o.startedAt : Date.now();
    return {
      v: 1,
      id: o.id,
      title: o.title || '',
      meetingCode: o.meetingCode || '',
      startedAt: now,
      endedAt: null,
      lastSeenAt: now,
      heartbeatAt: now,
      people: {}
    };
  }

  function isOpen(p) {
    var last = p.iv[p.iv.length - 1];
    return !!last && last[1] == null;
  }

  function closeAt(p, t) {
    var last = p.iv[p.iv.length - 1];
    if (last && last[1] == null) last[1] = Math.max(last[0], t);
  }

  function openAt(p, t) {
    p.iv.push([t, null]);
    p.joins++;
  }

  /**
   * Yeni bir okuma sonucunu işler. YALNIZCA okuma başarılıysa çağır:
   * boş liste "herkes çıktı" demektir.
   * @param {object} state
   * @param {string[]} names  şu an toplantıda görünen (temizlenmiş) adlar
   * @param {number} now
   * @returns {{joined: string[], left: string[], changed: boolean}}
   */
  function update(state, names, now, o) {
    var grace = opt(o, 'graceMs');
    var present = {};
    var joined = [], left = [];
    (names || []).forEach(function (n) { if (n) present[n] = true; });

    Object.keys(state.people).forEach(function (name) {
      var p = state.people[name];
      if (!isOpen(p)) return;
      if (present[name]) {
        if (p.miss) {
          if (now - p.miss.since > p.miss.tol) {
            // Uzun süre yoktu: o anda çıkmış, şimdi yeniden girmiş say.
            closeAt(p, p.miss.since);
            openAt(p, now);
            joined.push(name);
          }
          p.miss = null;
        }
      } else if (!p.miss) {
        p.miss = { since: now, tol: grace };
      } else if (now - p.miss.since >= p.miss.tol) {
        closeAt(p, p.miss.since);
        p.miss = null;
        left.push(name);
      }
    });

    Object.keys(present).forEach(function (name) {
      var p = state.people[name];
      if (!p) p = state.people[name] = { name: name, iv: [], joins: 0, miss: null };
      if (!isOpen(p)) { openAt(p, now); p.miss = null; joined.push(name); }
    });

    state.lastSeenAt = now;
    return { joined: joined, left: left, changed: joined.length > 0 || left.length > 0 };
  }

  /**
   * Toplantıyı izleyemediğimiz bir an başladı (sayfa yenilendi, görüşmeden
   * çıkıldı, panel okunamadı). Açık aralıklar son görülme anında askıya alınır;
   * kişi tolerans içinde yeniden görünürse kesintisiz sayılır.
   */
  function pause(state, now, o) {
    var tol = opt(o, 'pauseTolMs');
    var since = state.lastSeenAt || now;
    Object.keys(state.people).forEach(function (name) {
      var p = state.people[name];
      if (isOpen(p) && !p.miss) p.miss = { since: since, tol: tol };
    });
  }

  /** Oturumu kapatır. endAt verilmezse son görülme anı kullanılır. */
  function finalize(state, endAt) {
    var end = endAt != null ? endAt : state.lastSeenAt;
    end = Math.max(end, state.startedAt);
    Object.keys(state.people).forEach(function (name) {
      var p = state.people[name];
      if (isOpen(p)) closeAt(p, p.miss ? Math.min(p.miss.since, end) : end);
      p.miss = null;
    });
    state.endedAt = end;
    return state;
  }

  function mergedTotal(ivs) {
    var arr = ivs.slice().sort(function (a, b) { return a[0] - b[0]; });
    var total = 0, curS = null, curE = null;
    arr.forEach(function (iv) {
      if (iv[1] <= iv[0]) return;
      if (curE == null || iv[0] > curE) {
        if (curE != null) total += curE - curS;
        curS = iv[0]; curE = iv[1];
      } else if (iv[1] > curE) curE = iv[1];
    });
    if (curE != null) total += curE - curS;
    return total;
  }

  /** Bir kişinin aralıklarını, açık olanı `upTo` anında kapatılmış gibi döndürür. */
  function closedIntervals(p, upTo) {
    return p.iv.map(function (iv) {
      var e = iv[1] == null ? (p.miss ? Math.min(p.miss.since, upTo) : upTo) : iv[1];
      return [iv[0], Math.max(iv[0], e)];
    });
  }

  function sortedPeople(state) {
    return Object.keys(state.people).map(function (k) { return state.people[k]; })
      .sort(function (a, b) { return a.name.localeCompare(b.name, 'tr'); });
  }

  /** Tabloya yazılacak veri. Yalnızca görünen ad ve zamanlar. */
  function toPayload(state) {
    var upTo = state.endedAt || state.lastSeenAt;
    return {
      id: state.id,
      title: state.title,
      startedAt: state.startedAt,
      endedAt: upTo,
      participants: sortedPeople(state).filter(function (p) { return p.iv.length; }).map(function (p) {
        var ivs = closedIntervals(p, upTo);
        return {
          name: p.name,
          firstJoin: ivs[0][0],
          lastLeave: ivs[ivs.length - 1][1],
          totalMs: mergedTotal(ivs),
          joins: p.joins,
          intervals: ivs
        };
      })
    };
  }

  /** Popup'taki canlı liste. */
  function liveView(state, now) {
    return sortedPeople(state).map(function (p) {
      var present = isOpen(p) && !p.miss;
      return { name: p.name, present: present, totalMs: mergedTotal(closedIntervals(p, now)), joins: p.joins };
    });
  }

  function presentCount(state) {
    return Object.keys(state.people).filter(function (k) {
      var p = state.people[k];
      return isOpen(p) && !p.miss;
    }).length;
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function hhmm(t) { var d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }

  function csvCell(v) {
    var s = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;             // tablo formülü enjeksiyonuna karşı
    if (/[";\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  /** Yedek CSV (Excel/Sheets Türkçe yerel ayarı için ';' ayraçlı). */
  function toCsv(state) {
    var p = toPayload(state);
    var lines = [['Meet adı', 'İlk giriş', 'Son çıkış', 'Toplam süre (dk)', 'Bağlanma sayısı'].join(';')];
    p.participants.forEach(function (x) {
      lines.push([csvCell(x.name), hhmm(x.firstJoin), hhmm(x.lastLeave), Math.round(x.totalMs / 60000), x.joins].join(';'));
    });
    lines.push('');
    lines.push([csvCell('Toplantı: ' + (p.title || '')), hhmm(p.startedAt), hhmm(p.endedAt), Math.round((p.endedAt - p.startedAt) / 60000), ''].join(';'));
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  function newId(now) {
    var r = Math.random().toString(36).slice(2, 8);
    return (now || Date.now()).toString(36) + '-' + r;
  }

  return {
    DEFAULTS: DEFAULTS,
    createSession: createSession,
    update: update,
    pause: pause,
    finalize: finalize,
    toPayload: toPayload,
    liveView: liveView,
    presentCount: presentCount,
    toCsv: toCsv,
    newId: newId
  };
});
