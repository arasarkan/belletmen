/*
 * belletmen content script: meet.google.com üzerinde katılımcıları izler.
 * DOM ayrıntıları selectors.js'de, zaman mantığı tracker.js'dedir.
 */
(function () {
  'use strict';
  if (globalThis.__belletmenContent) return;
  globalThis.__belletmenContent = true;

  var Core = globalThis.BelletmenCore;
  var Dom = globalThis.BelletmenSelectors;
  var T = globalThis.BelletmenTracker;

  var READ_EVERY_MS = 5000;        // MutationObserver kaçırsa bile bu sıklıkta oku
  var PERSIST_EVERY_MS = 15000;    // değişiklik olmasa da bu sıklıkta kaydet (kalp atışı)
  var DEBOUNCE_MS = 800;
  var MAX_WAIT_MS = 3000;

  var settings = { debug: false, maskNames: true };
  var state = null;               // izlenen oturum (yoksa null)
  var last = { source: null, names: [], expected: null, inCall: false, meetingCode: Dom.meetingCode(location) };
  var health = { level: 'idle', text: '' };
  var lastHealthKey = '';
  var lastPersist = 0;
  var dirty = false;
  var wasObservable = false;

  // ---------------------------------------------------------------------------
  // Yardımcılar
  // ---------------------------------------------------------------------------

  function alive() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  }

  function send(msg) {
    if (!alive()) return Promise.resolve(null);
    try {
      return chrome.runtime.sendMessage(msg).catch(function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  }

  function mask(name) {
    if (!settings.maskNames) return name;
    var s = String(name || '');
    return s ? s.charAt(0) + '•••(' + s.length + ')' : '';
  }

  function log() {
    if (!settings.debug) return;
    var args = Array.prototype.slice.call(arguments);
    args.unshift('%c[belletmen]', 'color:#8e8e93;font-weight:600');
    console.log.apply(console, args);
  }

  function persist(force) {
    if (!state || !alive()) return Promise.resolve();
    var now = Date.now();
    if (!force && !dirty && now - lastPersist < PERSIST_EVERY_MS) return Promise.resolve();
    state.heartbeatAt = now;
    lastPersist = now;
    dirty = false;
    var o = {};
    o['s:' + state.id] = state;
    try { return chrome.storage.local.set(o).catch(function () {}); } catch (e) { return Promise.resolve(); }
  }

  // ---------------------------------------------------------------------------
  // Okuma
  // ---------------------------------------------------------------------------

  function readNames() {
    var r = Dom.read(document);
    var names = [];
    var seen = {};
    r.items.forEach(function (it) {
      if (Core.isPresentationLabel(it.name)) return;
      var n = Core.isSelfOnlyLabel(it.name) ? r.selfName : Core.cleanDisplayName(it.name);
      if (!n || seen[n]) return;
      seen[n] = true;
      names.push(n);
    });
    return { source: r.source, names: names, expected: r.expected, inCall: r.inCall, meetingCode: r.meetingCode, raw: r.items.length };
  }

  function computeHealth(r) {
    if (!r.inCall) {
      return state
        ? { level: 'warn', text: 'Görüşmede değilsin. Yoklama duraklatıldı.' }
        : { level: 'idle', text: 'Görüşmeye katılınca yoklamayı başlatabilirsin.' };
    }
    if (!r.names.length) {
      return { level: 'error', text: 'Katılımcılar okunamıyor. Katılımcılar panelini aç. Sorun sürerse ayarlardan hata ayıklama modunu aç.' };
    }
    if (r.source === 'tiles') {
      if (r.expected == null || r.expected > r.names.length) {
        return { level: 'warn', text: 'Katılımcılar paneli kapalı. Doğru sayım için paneli aç.' };
      }
    } else if (r.expected != null && r.expected > r.names.length + 1) {
      return { level: 'warn', text: 'Meet ' + r.expected + ' kişi gösteriyor, ' + r.names.length + ' kişi okundu. Listeyi aşağı kaydır.' };
    }
    return { level: 'ok', text: '' };
  }

  function reportHealth() {
    var count = state ? T.presentCount(state) : last.names.length;
    var key = health.level + '|' + health.text + '|' + count + '|' + !!state;
    if (key === lastHealthKey) return;
    lastHealthKey = key;
    send({ type: 'health', level: health.level, text: health.text, count: count, tracking: !!state });
  }

  function tick() {
    var now = Date.now();
    var r;
    try { r = readNames(); } catch (e) {
      r = { source: null, names: [], expected: null, inCall: true, meetingCode: last.meetingCode, raw: 0 };
      log('okuma hatası', e);
    }
    last = r;
    health = computeHealth(r);

    var observable = r.inCall && r.names.length > 0;
    if (state) {
      if (observable) {
        var ch = T.update(state, r.names, now);
        if (ch.changed) {
          dirty = true;
          log('değişim', { girdi: ch.joined.map(mask), cikti: ch.left.map(mask) });
        }
      } else if (wasObservable) {
        T.pause(state, now);
        dirty = true;
        log('izlenemiyor, duraklatıldı');
      }
      persist(false);
    }
    wasObservable = observable;

    log('okuma', { kaynak: r.source, okunan: r.names.length, meet: r.expected, gorusmede: r.inCall, adlar: r.names.map(mask) });
    reportHealth();
  }

  // MutationObserver + debounce
  var timer = null;
  var firstPending = 0;
  function schedule() {
    var now = Date.now();
    if (!firstPending) firstPending = now;
    clearTimeout(timer);
    var wait = Math.min(DEBOUNCE_MS, Math.max(0, MAX_WAIT_MS - (now - firstPending)));
    timer = setTimeout(function () { firstPending = 0; tick(); }, wait);
  }

  function startObserving() {
    var obs = new MutationObserver(schedule);
    obs.observe(document.body || document.documentElement, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['aria-label', 'data-participant-id', 'data-self-name']
    });
    setInterval(tick, READ_EVERY_MS);
    setInterval(function () { persist(false); }, PERSIST_EVERY_MS);
  }

  // ---------------------------------------------------------------------------
  // Başlat / bitir
  // ---------------------------------------------------------------------------

  function start(title) {
    if (state) return Promise.resolve({ ok: false, error: 'Bu sekmede zaten bir yoklama sürüyor.' });
    var now = Date.now();
    state = T.createSession({ id: T.newId(now), title: title, meetingCode: last.meetingCode, startedAt: now });
    wasObservable = false;
    tick();
    dirty = true;
    return persist(true).then(function () {
      return chrome.storage.local.set({ active: { id: state.id, meetingCode: state.meetingCode, startedAt: now } });
    }).then(function () {
      return send({ type: 'register', id: state.id, title: state.title, startedAt: now });
    }).then(function () {
      log('yoklama başladı', state.id);
      lastHealthKey = '';
      reportHealth();
      return { ok: true, id: state.id };
    });
  }

  function stop() {
    if (!state) return Promise.resolve({ ok: false, error: 'Bu sekmede süren bir yoklama yok.' });
    tick();
    var now = Date.now();
    T.finalize(state, now);
    var id = state.id;
    dirty = true;
    return persist(true).then(function () {
      state = null;
      return chrome.storage.local.remove('active');
    }).then(function () {
      return send({ type: 'submit', id: id });
    }).then(function (res) {
      log('yoklama bitti', id, res);
      lastHealthKey = '';
      tick();
      return { ok: true, id: id, delivery: res };
    });
  }

  function status() {
    var now = Date.now();
    return {
      ok: true,
      version: Core.VERSION,
      meetingCode: last.meetingCode,
      inCall: last.inCall,
      source: last.source,
      expected: last.expected,
      health: health,
      tracking: !!state,
      session: state ? { id: state.id, title: state.title, startedAt: state.startedAt } : null,
      count: state ? T.presentCount(state) : last.names.length,
      live: state ? T.liveView(state, now) : last.names.map(function (n) { return { name: n, present: true, totalMs: 0, joins: 0 }; })
    };
  }

  // ---------------------------------------------------------------------------
  // Mesajlar
  // ---------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return false;
    switch (msg.type) {
      case 'status':
        sendResponse(status());
        return false;
      case 'start':
        start(msg.title).then(sendResponse, function (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); });
        return true;
      case 'stop':
        stop().then(sendResponse, function (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); });
        return true;
      case 'diag':
        var d = Dom.diagnose(document, mask);
        d.version = Core.VERSION;
        d.tracking = !!state;
        d.health = health;
        d.maskedNames = !!settings.maskNames;
        sendResponse(d);
        return false;
    }
    return false;
  });

  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === 'local' && changes.settings) applySettings(changes.settings.newValue);
    });
  } catch (e) { /* eklenti yeniden yüklendi */ }

  function applySettings(s) {
    s = s || {};
    settings.debug = !!s.debug;
    settings.maskNames = s.maskNames !== false;
  }

  // Sekme kapanırken / gizlenirken son durumu yaz
  window.addEventListener('pagehide', function () { dirty = true; persist(true); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') { dirty = true; persist(true); }
  });

  // ---------------------------------------------------------------------------
  // Açılış: yarım kalan oturumu sürdür (sayfa yenilendiyse)
  // ---------------------------------------------------------------------------

  chrome.storage.local.get(['settings', 'active']).then(function (got) {
    applySettings(got.settings);
    var a = got.active;
    if (a && a.id && a.meetingCode && a.meetingCode === last.meetingCode) {
      return chrome.storage.local.get('s:' + a.id).then(function (g) {
        var s = g['s:' + a.id];
        if (s && !s.endedAt) {
          state = s;
          T.pause(state, Date.now());
          log('yarım kalan yoklama sürdürülüyor', s.id);
        }
      });
    }
  }).catch(function () {}).then(function () {
    startObserving();
    tick();
  });
})();
