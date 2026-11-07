/* belletmen popup */
(function () {
  'use strict';
  var T = globalThis.BelletmenTracker;
  var Core = globalThis.BelletmenCore;

  var $ = function (id) { return document.getElementById(id); };
  var tabId = null;
  var tabUrl = '';
  var meet = null;        // content script durumu
  var ov = null;          // background özeti
  var busy = false;
  var titleTouched = false;
  var stopArmed = 0;      // "Bitir"e ilk basışın zamanı (iki adımlı onay)
  var flash = null;       // geçici bildirim { kind, text, until }

  var SHEET_URL = /^https:\/\/docs\.google\.com\/spreadsheets\//;

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fmtDate(t) { var d = new Date(t); return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear(); }
  function fmtTime(t) { var d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function fmtDur(ms) {
    var m = Math.floor(ms / 60000);
    return m >= 60 ? Math.floor(m / 60) + ' sa ' + (m % 60) + ' dk' : m + ' dk';
  }
  function defaultTitle() { return fmtDate(Date.now()) + ' Haftalık toplantı'; }

  function el(tag, opts, children) {
    var e = document.createElement(tag);
    if (opts) Object.keys(opts).forEach(function (k) {
      if (k === 'text') e.textContent = opts[k];
      else if (k === 'class') e.className = opts[k];
      else e.setAttribute(k, opts[k]);
    });
    (children || []).forEach(function (c) { if (c) e.appendChild(c); });
    return e;
  }

  function toTab(msg) {
    if (tabId == null) return Promise.resolve(null);
    return chrome.tabs.sendMessage(tabId, msg).catch(function () { return null; });
  }
  function toBg(msg) { return chrome.runtime.sendMessage(msg).catch(function (e) { return { ok: false, error: String(e) }; }); }

  function showFlash(kind, text) {
    flash = { kind: kind, text: text, until: Date.now() + 5000 };
    render();
  }

  // ---------------------------------------------------------------------------
  // Bildirimler
  // ---------------------------------------------------------------------------

  var DOT = { error: 'red', warn: 'orange', info: '', ok: 'green' };

  function notice(kind, text, action) {
    var body = el('div', { class: 'body' }, [el('div', { text: text })]);
    if (action) {
      var b = el('button', { class: 'btn small', text: action.label });
      b.onclick = function () { b.disabled = true; action.run(b); };
      body.appendChild(b);
    }
    return el('div', { class: 'notice' }, [el('span', { class: 'dot ' + (DOT[kind] || '') }), body]);
  }

  function renderNotices() {
    var box = $('notices');
    box.textContent = '';
    if (flash && flash.until > Date.now()) box.appendChild(notice(flash.kind, flash.text));

    if (ov && !ov.configured) {
      box.appendChild(notice('warn', 'Kurulum tamamlanmadı. Yoklama alınır, kurulumdan sonra gönderilir.',
        { label: 'Kuruluma git', run: function () { chrome.runtime.openOptionsPage(); } }));
    } else if (ov && ov.needsAuth) {
      box.appendChild(notice('warn', 'Google oturumu yenilenmeli.',
        { label: 'Yeniden bağlan', run: function () { toBg({ type: 'flush' }).then(refresh); } }));
    }

    if (ov && ov.active && !(meet && meet.session && meet.session.id === ov.active.id)) {
      if (ov.active.stale) {
        box.appendChild(notice('warn', 'Yarım kalmış bir yoklama var: ' + (ov.active.title || 'adsız') + ', ' +
          ov.active.people + ' kişi. Aynı toplantıya dönersen kaldığı yerden sürer.',
          { label: 'Bitir ve gönder', run: function () { toBg({ type: 'finalizeOrphan' }).then(refresh); } }));
      } else {
        box.appendChild(notice('info', 'Yoklama başka bir sekmede sürüyor.'));
      }
    }

    if (meet && meet.health && meet.health.text && meet.health.level !== 'ok' && meet.health.level !== 'idle') {
      box.appendChild(notice(meet.health.level, meet.health.text));
    }
  }

  // ---------------------------------------------------------------------------
  // Görünüm
  // ---------------------------------------------------------------------------

  function setState(text, dot) {
    $('state').hidden = !text;
    $('state-text').textContent = text || '';
    $('state-dot').className = 'dot ' + (dot || '');
  }

  function render() {
    $('version').textContent = Core.VERSION;
    $('diag').hidden = !(ov && ov.debug && meet);
    $('sheet-tools').hidden = !(ov && ov.configured);
    renderNotices();

    var onMeet = /^https:\/\/meet\.google\.com\//.test(tabUrl);
    $('meet').hidden = !meet;
    $('not-meet').hidden = !!meet;

    if (!meet) {
      $('not-meet').textContent = onMeet
        ? 'Bu sekmeye bağlanılamadı. Sayfayı yenile.'
        : 'Yoklama almak için bir Meet toplantısında aç.';
      setState('', '');
      $('live-details').hidden = true;
    } else {
      $('idle-view').hidden = meet.tracking;
      $('tracking-view').hidden = !meet.tracking;
      if (meet.tracking) {
        setState('Yoklama sürüyor', 'green');
        $('count').textContent = String(meet.count);
        $('tracking-title').textContent = meet.session.title;
        $('tracking-title').title = meet.session.title;
        $('elapsed').textContent = fmtTime(meet.session.startedAt) + ' · ' + fmtDur(Date.now() - meet.session.startedAt);
      } else {
        setState(meet.inCall ? meet.count + ' kişi' : 'Görüşmede değil', meet.inCall ? 'accent' : '');
        if (!titleTouched && !$('title').value) $('title').value = defaultTitle();
        $('start').disabled = busy;
      }
      var stop = $('stop');
      var armed = stopArmed && Date.now() - stopArmed < 4000;
      if (!armed) stopArmed = 0;
      stop.disabled = busy;
      stop.textContent = busy ? 'Gönderiliyor' : armed ? 'Onaylamak için tekrar bas' : 'Bitir ve gönder';
      stop.classList.toggle('confirm', !!armed);
      renderLive();
    }
    renderSessions();
  }

  function renderLive() {
    var live = (meet.live || []).slice().sort(function (a, b) { return (b.present - a.present) || a.name.localeCompare(b.name, 'tr'); });
    $('live-details').hidden = !live.length;
    $('live-count').textContent = String(live.filter(function (x) { return x.present; }).length);
    var list = $('live');
    list.textContent = '';
    live.forEach(function (p) {
      var right = meet.tracking ? fmtDur(p.totalMs) + (p.joins > 1 ? ' · ' + p.joins + ' giriş' : '') : '';
      list.appendChild(el('li', null, [
        el('span', { class: 'dot' + (p.present ? ' green' : '') }),
        el('span', { class: 'ellipsis', text: p.name, title: p.name }),
        el('span', { class: 'spacer' }),
        right ? el('span', { class: 'st num-tab', text: right }) : null
      ]));
    });
  }

  var STATUS = {
    gonderildi: ['Gönderildi', 'green'],
    bekliyor: ['Bekliyor', ''],
    hata: ['Gönderilemedi', 'red'],
    yetki: ['Giriş gerekli', 'orange'],
    suruyor: ['Sürüyor', 'accent']
  };

  function renderSessions() {
    var ul = $('sessions');
    ul.textContent = '';
    var sessions = (ov && ov.sessions) || [];
    $('no-sessions').hidden = sessions.length > 0;
    ul.hidden = !sessions.length;
    $('retry').hidden = !(ov && ov.outboxCount);

    sessions.forEach(function (s) {
      var st = STATUS[s.status] || ['', ''];
      var detail = fmtDate(s.startedAt) + ' ' + fmtTime(s.startedAt);
      if (s.result && s.status === 'gonderildi') {
        detail += ' · ' + (s.result.members || 0) + ' üye' + (s.result.review ? ' · ' + s.result.review + ' inceleme' : '');
      }
      var csv = null;
      if (s.status !== 'suruyor') {
        csv = el('button', { class: 'btn text small', text: 'CSV', title: 'CSV olarak indir' });
        csv.onclick = function () { downloadCsv(s.id); };
      }
      ul.appendChild(el('li', null, [
        el('div', { class: 'meta' }, [
          el('div', { class: 'ellipsis', text: s.title || 'Adsız toplantı', title: s.title || '' }),
          el('div', { class: 'sub ellipsis num-tab', text: detail }),
          s.error && s.status !== 'gonderildi' ? el('div', { class: 'err', text: s.error }) : null
        ]),
        el('div', { class: 'side' }, [st[0] ? el('span', { class: 'st ' + st[1], text: st[0] }) : null, csv])
      ]));
    });
  }

  function downloadCsv(id) {
    chrome.storage.local.get('s:' + id).then(function (g) {
      var s = g['s:' + id];
      if (!s) return;
      var url = URL.createObjectURL(new Blob([T.toCsv(s)], { type: 'text/csv;charset=utf-8' }));
      var safe = (s.title || 'yoklama').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 60);
      var a = el('a', { href: url, download: 'belletmen-' + safe + '.csv' });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    });
  }

  // ---------------------------------------------------------------------------
  // Olaylar
  // ---------------------------------------------------------------------------

  function refresh() {
    return Promise.all([toTab({ type: 'status' }), toBg({ type: 'overview' })]).then(function (r) {
      meet = r[0] && r[0].ok ? r[0] : null;
      ov = r[1] && r[1].ok !== false ? r[1] : ov;
      render();
    });
  }

  $('title').addEventListener('input', function () { titleTouched = true; });
  $('title').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('start').click(); });

  $('start').onclick = function () {
    busy = true; render();
    var title = $('title').value.trim() || defaultTitle();
    toTab({ type: 'start', title: title }).then(function (res) {
      busy = false;
      if (!res || !res.ok) showFlash('error', (res && res.error) || 'Başlatılamadı. Sayfayı yenileyip tekrar dene.');
      return refresh();
    });
  };

  $('stop').onclick = function () {
    if (!stopArmed || Date.now() - stopArmed > 4000) { stopArmed = Date.now(); render(); return; }
    stopArmed = 0;
    busy = true; render();
    toTab({ type: 'stop' }).then(function (res) {
      busy = false;
      if (!res || !res.ok) showFlash('error', (res && res.error) || 'Bitirilemedi.');
      return refresh();
    });
  };

  $('retry').onclick = function () {
    $('retry').disabled = true;
    toBg({ type: 'flush' }).then(function () { $('retry').disabled = false; return refresh(); });
  };

  function sheetMsg(text) {
    $('sheet-msg').hidden = !text;
    $('sheet-msg').textContent = text || '';
  }

  $('open-sheet').onclick = function () {
    if (ov && SHEET_URL.test(ov.spreadsheetUrl)) chrome.tabs.create({ url: ov.spreadsheetUrl });
  };

  $('apply-review').onclick = function () {
    var b = $('apply-review');
    b.disabled = true;
    sheetMsg('Uygulanıyor…');
    toBg({ type: 'sheetAction', action: 'applyReview' }).then(function (r) {
      b.disabled = false;
      if (!r || !r.ok) { sheetMsg((r && r.error) || 'Uygulanamadı.'); return; }
      var x = r.result;
      var parts = [x.applied ? x.applied + ' seçim uygulandı.' : 'Uygulanacak seçim yok.'];
      if (x.counts && x.counts.open) parts.push(x.counts.open + ' ad hâlâ seçim bekliyor.');
      if (x.errors.length) parts.push(x.errors.join(' '));
      sheetMsg(parts.join(' '));
    });
  };

  $('refresh-summary').onclick = function () {
    var b = $('refresh-summary');
    b.disabled = true;
    sheetMsg('Yenileniyor…');
    toBg({ type: 'sheetAction', action: 'refreshSummary' }).then(function (r) {
      b.disabled = false;
      sheetMsg(r && r.ok ? 'Özet güncellendi.' : (r && r.error) || 'Yenilenemedi.');
    });
  };

  $('diag').onclick = function () {
    toTab({ type: 'diag' }).then(function (d) {
      return navigator.clipboard.writeText(JSON.stringify(d, null, 2)).then(function () {
        $('diag').textContent = 'Kopyalandı';
        setTimeout(function () { $('diag').textContent = 'Teşhis kopyala'; }, 2000);
      });
    }).catch(function () { showFlash('error', 'Kopyalanamadı.'); });
  };

  Array.prototype.forEach.call(document.querySelectorAll('[data-open-options]'), function (b) {
    b.onclick = function () { chrome.runtime.openOptionsPage(); };
  });

  chrome.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
    var t = tabs && tabs[0];
    if (t) { tabId = t.id; tabUrl = t.url || ''; }
    return refresh();
  }).then(function () {
    setInterval(refresh, 2000);
  });
})();
