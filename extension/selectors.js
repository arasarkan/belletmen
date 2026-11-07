/*
 * belletmen: Google Meet DOM bilgisinin TAMAMI bu dosyadadır.
 *
 * Meet arayüzü değiştiğinde yalnızca burayı güncelle. Sınıf adları (ör.
 * "zWGUib") birkaç haftada bir değiştiği için kullanılmaz; bunun yerine
 * role, aria-label ve data-* niteliklerine dayanılır. Etiketler hem Türkçe
 * hem İngilizce arayüz için yazılmıştır.
 *
 * Debug modunda popup'taki "Teşhis kopyala" bu dosyadaki her seçicinin kaç
 * eleman bulduğunu raporlar; seçici güncellemek için o çıktıyı kullan.
 */
(function (root) {
  'use strict';

  var SEL = {
    // Toplantı kodu: meet.google.com/abc-defg-hij
    meetingCodeFromPath: /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:$|[/?#])/,

    // Görüşmede miyiz? "Görüşmeden ayrıl" düğmesi yalnızca görüşme sırasında var.
    leaveButton: 'button[aria-label]',
    leaveLabel: /(leave call|end call|görüşmeden ayrıl|aramadan ayrıl|toplantıdan ayrıl|görüşmeyi sonlandır|aramayı sonlandır)/i,

    // Katılımcılar paneli
    list: '[role="list"]',
    panelListLabel: /(participant|people|in call|in the call|in the meeting|contributors|katılımcı|kişiler|toplantıda|görüşmede|katkıda bulunanlar)/i,
    listItem: '[role="listitem"]',
    participantId: 'data-participant-id',
    participantIdAttrSelector: '[data-participant-id]',

    // Kendi adın: Meet bazı sürümlerde bunu bir data niteliğinde tutar
    selfName: '[data-self-name]',
    selfNameAttr: 'data-self-name',

    // Ad metninin bulunduğu iç eleman için sırayla denenir
    nameInner: ['[data-self-name]', '[data-participant-name]', '.notranslate'],

    // "Herkesi göster" / "Kişiler" düğmesi: üzerinde katılımcı sayısı yazar
    peopleButton: 'button[aria-label], [role="button"][aria-label]',
    peopleLabel: /(show everyone|people|participants|everyone|herkesi göster|kişiler|katılımcılar|katılımcıları göster)/i,

    // Ad sanılmaması gereken arayüz metinleri
    uiNoise: /^(more options|daha fazla seçenek|mute|sesi kapat|pin|sabitle|remove|kaldır|toplantıda|in the meeting|contributors|katkıda bulunanlar|\d+)$/i
  };

  var MAX_NAME = 80;

  function text(el) {
    return (el && (el.innerText || el.textContent) || '').trim();
  }

  function firstLine(s) {
    return String(s || '').split(/[\r\n]+/).map(function (x) { return x.trim(); }).filter(Boolean)[0] || '';
  }

  function plausibleName(s) {
    s = (s || '').trim();
    return s.length > 0 && s.length <= MAX_NAME && !SEL.uiNoise.test(s);
  }

  /** Bir katılımcı elemanından adı çıkarır. */
  function extractName(el) {
    // 1) Liste öğesinin kendi aria-label'ı çoğu zaman doğrudan addır
    var aria = el.getAttribute && el.getAttribute('aria-label');
    if (plausibleName(aria)) return aria.trim();
    // 2) Bilinen iç elemanlar
    for (var i = 0; i < SEL.nameInner.length; i++) {
      var inner = el.querySelector(SEL.nameInner[i]);
      if (inner) {
        var v = inner.getAttribute(SEL.selfNameAttr) || text(inner);
        v = firstLine(v);
        if (plausibleName(v)) return v;
      }
    }
    // 3) Görünen metnin ilk satırı
    var line = firstLine(text(el));
    return plausibleName(line) ? line : '';
  }

  function participantIdOf(el) {
    var id = el.getAttribute(SEL.participantId);
    if (id) return id;
    var inner = el.querySelector(SEL.participantIdAttrSelector);
    return inner ? inner.getAttribute(SEL.participantId) : '';
  }

  function meetingCode(loc) {
    var m = SEL.meetingCodeFromPath.exec((loc || location).pathname);
    return m ? m[1] : '';
  }

  function isInCall(doc) {
    var btns = doc.querySelectorAll(SEL.leaveButton);
    for (var i = 0; i < btns.length; i++) {
      if (SEL.leaveLabel.test(btns[i].getAttribute('aria-label') || '')) return true;
    }
    return false;
  }

  function selfName(doc) {
    var el = doc.querySelector(SEL.selfName);
    var v = el && el.getAttribute(SEL.selfNameAttr);
    return v && plausibleName(v) ? v.trim() : '';
  }

  function panelLists(doc) {
    var out = [];
    var lists = doc.querySelectorAll(SEL.list);
    for (var i = 0; i < lists.length; i++) {
      var l = lists[i];
      var label = l.getAttribute('aria-label') || '';
      if (SEL.panelListLabel.test(label) || l.querySelector(SEL.listItem + SEL.participantIdAttrSelector) ||
          l.querySelector(SEL.listItem + ' ' + SEL.participantIdAttrSelector)) {
        out.push(l);
      }
    }
    return out;
  }

  /** Strateji 1: Katılımcılar paneli (en güvenilir; kalabalık toplantıda gerekli). */
  function readPanel(doc) {
    var items = [];
    var seen = {};
    panelLists(doc).forEach(function (list) {
      var lis = list.querySelectorAll(SEL.listItem);
      for (var i = 0; i < lis.length; i++) {
        var li = lis[i];
        // İç içe liste öğelerinde (grup başlığı vb.) yalnızca kişi satırlarını al
        if (li.querySelector(SEL.listItem)) continue;
        var name = extractName(li);
        if (!name) continue;
        var id = participantIdOf(li) || ('ad:' + name);
        if (seen[id]) continue;
        seen[id] = true;
        items.push({ id: id, name: name });
      }
    });
    return items;
  }

  /** Strateji 2: Video kutucukları (panel kapalıyken; yalnızca görünenler). */
  function readTiles(doc) {
    var items = [];
    var seen = {};
    var tiles = doc.querySelectorAll(SEL.participantIdAttrSelector);
    for (var i = 0; i < tiles.length; i++) {
      var el = tiles[i];
      if (el.closest(SEL.list)) continue;                    // panel içindekiler değil
      var id = el.getAttribute(SEL.participantId);
      if (!id || seen[id]) continue;
      // İç içe aynı kişiye ait elemanlarda en dıştakini al
      var parent = el.parentElement && el.parentElement.closest(SEL.participantIdAttrSelector);
      if (parent && parent.getAttribute(SEL.participantId) === id) continue;
      var name = extractName(el);
      if (!name) continue;
      seen[id] = true;
      items.push({ id: id, name: name });
    }
    return items;
  }

  /** Meet'in kendi gösterdiği katılımcı sayısı (bulunamazsa null). */
  function expectedCount(doc) {
    var btns = doc.querySelectorAll(SEL.peopleButton);
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      if (!SEL.peopleLabel.test(b.getAttribute('aria-label') || '')) continue;
      var m = /(\d+)/.exec(text(b)) || /(\d+)/.exec(b.getAttribute('aria-label') || '');
      if (m) return parseInt(m[1], 10);
    }
    return null;
  }

  /**
   * @returns {{source: 'panel'|'tiles'|null, items: {id, name}[], expected: number|null,
   *            inCall: boolean, selfName: string, meetingCode: string}}
   */
  function read(doc) {
    var res = {
      source: null, items: [], expected: expectedCount(doc), inCall: isInCall(doc),
      selfName: selfName(doc), meetingCode: meetingCode(doc.location)
    };
    var panel = readPanel(doc);
    if (panel.length) { res.source = 'panel'; res.items = panel; return res; }
    var tiles = readTiles(doc);
    if (tiles.length) { res.source = 'tiles'; res.items = tiles; }
    return res;
  }

  function attrNames(el) {
    var out = [];
    for (var i = 0; i < el.attributes.length; i++) {
      var n = el.attributes[i].name;
      if (n === 'class' || n === 'style' || n === 'jsaction' || n === 'jscontroller' || n === 'jsmodel') continue;
      out.push(n);
    }
    return out;
  }

  /** Debug: hangi seçici ne buldu? mask(name) isimleri gizlemek için. */
  function diagnose(doc, mask) {
    mask = mask || function (s) { return s; };
    var lists = doc.querySelectorAll(SEL.list);
    var ids = doc.querySelectorAll(SEL.participantIdAttrSelector);
    var people = [];
    doc.querySelectorAll(SEL.peopleButton).forEach(function (b) {
      var l = b.getAttribute('aria-label') || '';
      if (SEL.peopleLabel.test(l)) people.push({ ariaLabel: l, text: text(b).slice(0, 20) });
    });
    var leave = [];
    doc.querySelectorAll(SEL.leaveButton).forEach(function (b) {
      var l = b.getAttribute('aria-label') || '';
      if (SEL.leaveLabel.test(l)) leave.push(l);
    });
    return {
      lang: doc.documentElement.getAttribute('lang') || '',
      inCall: isInCall(doc),
      meetingCodeFound: !!meetingCode(doc.location),
      selfNameFound: !!selfName(doc),
      expectedCount: expectedCount(doc),
      counts: {
        roleList: lists.length,
        panelLists: panelLists(doc).length,
        roleListItem: doc.querySelectorAll(SEL.listItem).length,
        dataParticipantId: ids.length
      },
      lists: Array.prototype.slice.call(lists, 0, 10).map(function (l) {
        return {
          ariaLabel: l.getAttribute('aria-label') || '',
          isPanel: panelLists(doc).indexOf(l) >= 0,
          items: l.querySelectorAll(SEL.listItem).length,
          itemsWithId: l.querySelectorAll(SEL.participantIdAttrSelector).length,
          firstItemAttrs: l.querySelector(SEL.listItem) ? attrNames(l.querySelector(SEL.listItem)) : []
        };
      }),
      peopleButtons: people.slice(0, 5),
      leaveButtons: leave.slice(0, 3),
      panel: readPanel(doc).map(function (x) { return mask(x.name); }),
      tiles: readTiles(doc).map(function (x) { return mask(x.name); }),
      tileSamples: Array.prototype.slice.call(ids, 0, 5).map(function (el) {
        return { tag: el.tagName.toLowerCase(), attrs: attrNames(el), ariaLabel: mask(el.getAttribute('aria-label') || ''), firstLine: mask(firstLine(text(el)).slice(0, 40)) };
      })
    };
  }

  root.BelletmenSelectors = {
    SEL: SEL,
    read: read,
    readPanel: readPanel,
    readTiles: readTiles,
    isInCall: isInCall,
    meetingCode: meetingCode,
    expectedCount: expectedCount,
    diagnose: diagnose
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
