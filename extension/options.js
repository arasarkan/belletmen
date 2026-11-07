/* belletmen kurulum sayfası */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var SHEET_URL = /^https:\/\/docs\.google\.com\/spreadsheets\//;
  var st = null;

  function bg(msg) {
    return chrome.runtime.sendMessage(msg).catch(function (e) { return { ok: false, error: String(e) }; });
  }

  function show(kind, text) {
    $('result').hidden = !text;
    $('result-dot').className = 'dot ' + ({ error: 'red', ok: 'green' }[kind] || '');
    $('result-text').textContent = text || '';
  }

  function busy(btn, on, label) {
    if (on) { btn.dataset.label = btn.textContent; btn.textContent = label; btn.disabled = true; }
    else { btn.textContent = btn.dataset.label || btn.textContent; btn.disabled = false; }
  }

  function openSheet() {
    if (st && SHEET_URL.test(st.spreadsheetUrl)) chrome.tabs.create({ url: st.spreadsheetUrl });
  }

  function render() {
    $('no-client').hidden = st.clientConfigured;
    $('redirect').textContent = st.redirectUri;

    var connected = !!st.email;
    var hasSheet = !!st.spreadsheetId;
    $('acc-none').hidden = connected;
    $('acc-some').hidden = !connected;
    $('email').textContent = st.email;
    $('step1').className = 'step' + (connected ? ' done' : '') + (st.clientConfigured ? '' : ' locked');

    $('step2').className = 'step' + (hasSheet ? ' done' : '') + (connected ? '' : ' locked');
    $('sheet-none').hidden = hasSheet;
    $('sheet-some').hidden = !hasSheet;
    $('sheet-title').textContent = st.spreadsheetTitle || 'belletmen yoklama';

    $('step3').className = 'step' + (hasSheet && connected ? '' : ' locked');
  }

  function refresh() {
    return bg({ type: 'status' }).then(function (s) { st = s; render(); });
  }

  $('connect').onclick = $('switch').onclick = function (ev) {
    var b = ev.currentTarget;
    busy(b, true, 'Google penceresi açık');
    show('', '');
    bg({ type: 'connect' }).then(function (r) {
      busy(b, false);
      if (!r || !r.ok) show('error', (r && r.error) || 'Bağlanılamadı.');
      return refresh();
    });
  };

  $('disconnect').onclick = function () {
    var b = $('disconnect');
    if (b.dataset.armed !== '1') {
      b.dataset.armed = '1';
      b.textContent = 'Onaylamak için tekrar bas';
      setTimeout(function () { b.dataset.armed = ''; b.textContent = 'Bağlantıyı kes'; }, 4000);
      return;
    }
    bg({ type: 'disconnect' }).then(function () {
      show('', 'Bağlantı kesildi. Bekleyen yoklamalar yeniden bağlanınca gönderilir.');
      return refresh();
    });
  };

  $('create').onclick = function () {
    var b = $('create');
    busy(b, true, 'Oluşturuluyor');
    bg({ type: 'createSheet' }).then(function (r) {
      busy(b, false);
      if (r && r.ok) show('ok', 'Tablo hazır. Şimdi takım listesini gir.');
      else show('error', (r && r.error) || 'Tablo oluşturulamadı.');
      return refresh();
    });
  };

  $('link').onclick = function () {
    var b = $('link');
    busy(b, true, 'Bağlanıyor');
    bg({ type: 'linkSheet', url: $('link-url').value }).then(function (r) {
      busy(b, false);
      if (r && r.ok) show('ok', 'Tablo bağlandı.');
      else show('error', (r && r.error) || 'Tablo bağlanamadı.');
      return refresh();
    });
  };

  $('unlink').onclick = function () {
    chrome.storage.local.get('settings').then(function (g) {
      var s = Object.assign({}, g.settings, { spreadsheetId: '', spreadsheetUrl: '', spreadsheetTitle: '' });
      return chrome.storage.local.set({ settings: s });
    }).then(function () {
      show('', 'Tablo bağlantısı kaldırıldı. Tablo Drive\'ında duruyor.');
      return refresh();
    });
  };

  $('open-sheet').onclick = openSheet;
  $('open-members').onclick = openSheet;

  function saveFlags() {
    chrome.storage.local.get('settings').then(function (g) {
      var s = Object.assign({}, g.settings, { debug: $('debug').checked, maskNames: $('mask').checked });
      return chrome.storage.local.set({ settings: s });
    });
  }
  $('debug').onchange = saveFlags;
  $('mask').onchange = saveFlags;

  chrome.storage.local.get('settings').then(function (g) {
    var s = g.settings || {};
    $('debug').checked = !!s.debug;
    $('mask').checked = s.maskNames !== false;
  });

  refresh();
})();
