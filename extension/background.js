/*
 * belletmen service worker: Google bağlantısı, tabloya yazma, gönderim kuyruğu,
 * tekrar deneme ve ikon uyarıları.
 *
 * Depolama (chrome.storage.local):
 *   settings   { spreadsheetId, spreadsheetUrl, spreadsheetTitle, debug, maskNames }
 *   account    { email }                         bağlı Google hesabı (auth.js)
 *   active     { id, meetingCode, startedAt }    süren yoklama (content script)
 *   s:<id>     oturum durumu (tracker.js)        (content script)
 *   sessions   [{ id, title, startedAt }]        son oturumlar
 *   delivery   { <id>: { status, error, attempts, sentAt, result } }
 *   outbox     [id, ...]                         gönderilmeyi bekleyenler
 * chrome.storage.session:
 *   token      { value, exp }                    Google erişim tokenı (auth.js)
 */
importScripts('config.js', 'lib/core.js', 'lib/sheetlogic.js', 'lib/sheets-api.js', 'lib/auth.js', 'tracker.js');

// Google erişim tokenı chrome.storage.session'da durur. Meet sayfasında çalışan
// content script'in bu alana erişmesini açıkça engelle (Chrome'un varsayılanı da budur).
chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(function () {});

var T = self.BelletmenTracker;
var L = self.BelletmenSheetLogic;
var Api = self.BelletmenSheetsApi;
var Auth = self.BelletmenAuth;

var RETRY_ALARM = 'belletmen-retry';
var RETRY_MINUTES = 5;
var KEEP_SESSIONS = 30;
var ORPHAN_AFTER_MS = 45000;

var STATUS_TEXT = {
  bekliyor: 'Bekliyor',
  gonderildi: 'Gönderildi',
  hata: 'Gönderilemedi',
  yetki: 'Giriş gerekli'
};

function get(keys) { return chrome.storage.local.get(keys); }
function set(obj) { return chrome.storage.local.set(obj); }
function errText(e) { return String(e && e.message || e); }

async function settings() { return (await get('settings')).settings || {}; }
async function saveSettings(patch) {
  var s = await settings();
  await set({ settings: Object.assign(s, patch) });
}

// ---------------------------------------------------------------------------
// İkon (rozet) uyarıları
// ---------------------------------------------------------------------------

function setBadge(tabId, msg) {
  var text = '', color = '#3a3a3c', title = 'belletmen';
  if (msg.level === 'error') { text = '!'; color = '#ff453a'; title = 'belletmen: ' + msg.text; }
  else if (msg.level === 'warn') { text = '!'; color = '#8e8e93'; title = 'belletmen: ' + msg.text; }
  else if (msg.tracking) { text = String(msg.count || 0); color = '#3a3a3c'; title = 'belletmen: yoklama sürüyor, ' + (msg.count || 0) + ' kişi'; }
  else if (msg.text) { title = 'belletmen: ' + msg.text; }
  var opts = tabId != null ? { tabId: tabId } : {};
  chrome.action.setBadgeText(Object.assign({ text: text }, opts));
  chrome.action.setBadgeBackgroundColor(Object.assign({ color: color }, opts));
  if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor(Object.assign({ color: '#ffffff' }, opts));
  chrome.action.setTitle(Object.assign({ title: title }, opts));
}

// ---------------------------------------------------------------------------
// Tabloya erişim (tüm yazımlar sırayla, tek tek)
// ---------------------------------------------------------------------------

var queue = Promise.resolve();
function serial(fn) {
  var p = queue.then(fn, fn);
  queue = p.catch(function () {});
  return p;
}

/**
 * Tabloyu okur, fn(workbook) ile değiştirir ve tek bir atomik batchUpdate ile yazar.
 * @param {boolean} interactive  Google girişi için pencere açılabilir mi
 */
function withWorkbook(interactive, fn) {
  return serial(async function () {
    var st = await settings();
    if (!st.spreadsheetId) {
      var e = new Error('Yoklama tablosu bağlı değil. Kurulumdan tablo oluştur.');
      e.code = 'no_sheet';
      throw e;
    }
    var token = await Auth.getToken({ interactive: interactive });
    var model;
    try {
      model = await Api.loadModel(token, st.spreadsheetId);
    } catch (e) {
      if (e.status !== 401) throw e;
      await Auth.invalidate();
      token = await Auth.getToken({ interactive: interactive });
      model = await Api.loadModel(token, st.spreadsheetId);
    }
    var wb = new L.Workbook(model);
    L.ensureStructure(wb);
    var result = fn(wb, model);
    await Api.batchUpdate(token, st.spreadsheetId, wb.toRequests());
    if (model.title !== st.spreadsheetTitle) await saveSettings({ spreadsheetTitle: model.title, spreadsheetUrl: model.spreadsheetUrl });
    return result;
  });
}

function isAuthError(e) {
  return e && (e.code === 'interaction_required' || e.code === 'not_connected' || e.code === 'cancelled' || e.status === 401);
}

// ---------------------------------------------------------------------------
// Oturum listesi
// ---------------------------------------------------------------------------

async function register(id, title, startedAt) {
  var g = await get(['sessions']);
  var list = (g.sessions || []).filter(function (s) { return s.id !== id; });
  list.unshift({ id: id, title: title || '', startedAt: startedAt || Date.now() });
  await set({ sessions: list });
  await prune();
}

async function prune() {
  var g = await get(['sessions', 'delivery', 'outbox']);
  var list = g.sessions || [];
  if (list.length <= KEEP_SESSIONS) return;
  var delivery = g.delivery || {};
  var outbox = g.outbox || [];
  var keep = [], drop = [];
  list.forEach(function (s, i) {
    var sent = delivery[s.id] && delivery[s.id].status === 'gonderildi';
    if (i >= KEEP_SESSIONS && sent && outbox.indexOf(s.id) < 0) drop.push(s.id); else keep.push(s);
  });
  if (!drop.length) return;
  drop.forEach(function (id) { delete delivery[id]; });
  await chrome.storage.local.remove(drop.map(function (id) { return 's:' + id; }));
  await set({ sessions: keep, delivery: delivery });
}

// ---------------------------------------------------------------------------
// Gönderim
// ---------------------------------------------------------------------------

async function enqueue(id) {
  var g = await get(['outbox', 'delivery']);
  var outbox = g.outbox || [];
  var delivery = g.delivery || {};
  if (outbox.indexOf(id) < 0) outbox.push(id);
  delivery[id] = Object.assign({ attempts: 0 }, delivery[id], { status: 'bekliyor', error: '' });
  await set({ outbox: outbox, delivery: delivery });
}

var flushing = null;
function flush(interactive) {
  if (!flushing) flushing = doFlush(!!interactive).finally(function () { flushing = null; });
  return flushing;
}

async function doFlush(interactive) {
  var g = await get(['outbox', 'delivery']);
  var outbox = (g.outbox || []).slice();
  var delivery = g.delivery || {};
  if (!outbox.length) { await chrome.alarms.clear(RETRY_ALARM); return; }

  for (var i = 0; i < outbox.length; i++) {
    var id = outbox[i];
    var d = delivery[id] = Object.assign({ attempts: 0 }, delivery[id]);
    var state = (await get('s:' + id))['s:' + id];
    if (!state) { d.status = 'hata'; d.error = 'Oturum verisi bulunamadı.'; outbox[i] = null; continue; }
    if (!state.endedAt) continue;
    d.attempts++;
    d.lastAttempt = Date.now();
    try {
      var payload = T.toPayload(state);
      var r = await withWorkbook(interactive, function (wb) {
        var rev = L.applyReview(wb, Date.now());
        var res = L.processAttendance(wb, payload, Date.now());
        L.refreshSummary(wb, Date.now());
        res.autoReview = rev.applied;
        return res;
      });
      d.status = 'gonderildi'; d.error = ''; d.sentAt = Date.now();
      d.result = { members: r.members, review: r.review, duplicate: !!r.duplicate };
      outbox[i] = null;
    } catch (e) {
      if (isAuthError(e)) { d.status = 'yetki'; d.error = 'Google oturumu yenilenmeli.'; }
      else if (e.code === 'no_sheet') { d.status = 'hata'; d.error = errText(e); }
      else { d.status = 'hata'; d.error = errText(e); }
      // Aynı nedenle diğerleri de başarısız olur; bu turu bitir
      if (isAuthError(e) || e.code === 'no_sheet' || e.code === 'no_client') {
        outbox.slice(i + 1).forEach(function (other) {
          if (!other) return;
          delivery[other] = Object.assign({ attempts: 0 }, delivery[other], { status: d.status, error: d.error });
        });
        break;
      }
    }
  }

  var remaining = outbox.filter(Boolean);
  await set({ outbox: remaining, delivery: delivery });
  if (remaining.length) chrome.alarms.create(RETRY_ALARM, { delayInMinutes: RETRY_MINUTES });
  else await chrome.alarms.clear(RETRY_ALARM);
}

async function submit(id, interactive) {
  await enqueue(id);
  await flush(interactive);
  return ((await get('delivery')).delivery || {})[id] || null;
}

// ---------------------------------------------------------------------------
// Yarım kalan oturum (sekme kapandı / tarayıcı çöktü)
// ---------------------------------------------------------------------------

async function finalizeOrphan() {
  var a = (await get('active')).active;
  if (!a) return { ok: false, error: 'Yarım kalan yoklama yok.' };
  var state = (await get('s:' + a.id))['s:' + a.id];
  if (state && Date.now() - (state.heartbeatAt || 0) < ORPHAN_AFTER_MS) {
    return { ok: false, error: 'Yoklama başka bir sekmede hâlâ sürüyor.' };
  }
  await chrome.storage.local.remove('active');
  if (!state) return { ok: false, error: 'Oturum verisi bulunamadı.' };
  if (!state.endedAt) {
    T.finalize(state, state.lastSeenAt);
    var o = {}; o['s:' + state.id] = state;
    await set(o);
  }
  await register(state.id, state.title, state.startedAt).catch(function () {});
  return { ok: true, id: state.id, delivery: await submit(state.id, true) };
}

// ---------------------------------------------------------------------------
// Kurulum: bağlan, tablo oluştur / bağla
// ---------------------------------------------------------------------------

async function status() {
  var st = await settings();
  var acc = await Auth.account();
  return {
    clientConfigured: !!Auth.clientId(),
    redirectUri: Auth.redirectUri(),
    extensionId: chrome.runtime.id,
    email: acc && acc.email || '',
    spreadsheetId: st.spreadsheetId || '',
    spreadsheetUrl: st.spreadsheetUrl || '',
    spreadsheetTitle: st.spreadsheetTitle || ''
  };
}

async function connect() {
  var r = await Auth.connect();
  if (r.changed) {
    // Başka bir hesap: eski tabloya bu hesapla erişilemez
    await saveSettings({ spreadsheetId: '', spreadsheetUrl: '', spreadsheetTitle: '' });
  }
  flush(false);
  return { ok: true, email: r.email };
}

async function createSheet() {
  var token = await Auth.getToken({ interactive: true });
  var tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Istanbul';
  var created = await Api.create(token, L.createBody('belletmen yoklama', tz));
  await saveSettings({ spreadsheetId: created.spreadsheetId, spreadsheetUrl: created.spreadsheetUrl, spreadsheetTitle: created.properties.title });
  await withWorkbook(true, function (wb) { L.refreshSummary(wb, Date.now()); });
  flush(false);
  return { ok: true, url: created.spreadsheetUrl };
}

async function linkSheet(url) {
  var id = Api.parseId(url);
  if (!id) return { ok: false, error: 'Geçerli bir Google Sheets adresi değil.' };
  var prev = await settings();
  await saveSettings({ spreadsheetId: id, spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/' + id + '/edit', spreadsheetTitle: '' });
  try {
    await withWorkbook(true, function () {});
  } catch (e) {
    await saveSettings({ spreadsheetId: prev.spreadsheetId || '', spreadsheetUrl: prev.spreadsheetUrl || '', spreadsheetTitle: prev.spreadsheetTitle || '' });
    throw e;
  }
  flush(false);
  return { ok: true };
}

async function sheetAction(action) {
  if (action === 'applyReview') {
    var r = await withWorkbook(true, function (wb) {
      var res = L.applyReview(wb, Date.now());
      L.refreshSummary(wb, Date.now());
      res.counts = L.reviewCounts(wb);
      return res;
    });
    return { ok: true, result: r };
  }
  if (action === 'refreshSummary') {
    await withWorkbook(true, function (wb) { L.refreshSummary(wb, Date.now()); });
    return { ok: true };
  }
  if (action === 'counts') {
    var c = await withWorkbook(false, function (wb) { return L.reviewCounts(wb); });
    return { ok: true, counts: c };
  }
  return { ok: false, error: 'Bilinmeyen işlem' };
}

async function overview() {
  var g = await get(['sessions', 'delivery', 'outbox', 'active', 'settings']);
  var delivery = g.delivery || {};
  var active = g.active || null;
  var activeInfo = null;
  if (active) {
    var s = (await get('s:' + active.id))['s:' + active.id];
    activeInfo = s ? {
      id: s.id, title: s.title, startedAt: s.startedAt, heartbeatAt: s.heartbeatAt,
      stale: Date.now() - (s.heartbeatAt || 0) > ORPHAN_AFTER_MS,
      people: Object.keys(s.people || {}).length
    } : null;
  }
  var st = g.settings || {};
  var acc = await Auth.account();
  var sessions = (g.sessions || []).slice(0, 10).map(function (s) {
    var d = delivery[s.id] || {};
    var running = active && active.id === s.id;
    return {
      id: s.id, title: s.title, startedAt: s.startedAt,
      status: d.status || (running ? 'suruyor' : ''),
      statusText: STATUS_TEXT[d.status] || (running ? 'Sürüyor' : ''),
      error: d.error || '', result: d.result || null
    };
  });
  return {
    configured: !!(Auth.clientId() && acc && acc.email && st.spreadsheetId),
    email: acc && acc.email || '',
    spreadsheetUrl: st.spreadsheetUrl || '',
    debug: !!st.debug,
    outboxCount: (g.outbox || []).length,
    needsAuth: sessions.some(function (s) { return s.status === 'yetki'; }),
    active: activeInfo,
    sessions: sessions
  };
}

// ---------------------------------------------------------------------------
// Olaylar
// ---------------------------------------------------------------------------

function wrap(p) {
  return p.catch(function (e) { return { ok: false, error: errText(e), code: e && e.code || '' }; });
}

// Meet sekmesindeki content script yalnızca bu mesajları gönderebilir. Google
// bağlantısı, tablo bağlama ve tablo işlemleri yalnızca eklentinin kendi
// sayfalarından (popup, kurulum) gelebilir.
var TAB_ALLOWED = { health: 1, register: 1, submit: 1 };

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type || sender.id !== chrome.runtime.id) return false;
  // Kurulum sayfası bir sekmede açıldığı için sender.tab'a değil, gönderen sayfanın adresine bakılır.
  var fromExtensionPage = typeof sender.url === 'string' && sender.url.indexOf('chrome-extension://' + chrome.runtime.id + '/') === 0;
  if (!fromExtensionPage && !TAB_ALLOWED[msg.type]) {
    sendResponse({ ok: false, error: 'İzin verilmeyen istek.' });
    return false;
  }
  var p;
  switch (msg.type) {
    case 'health':
      setBadge(sender.tab ? sender.tab.id : null, msg);
      sendResponse({ ok: true });
      return false;
    case 'register': p = register(msg.id, msg.title, msg.startedAt).then(function () { return { ok: true }; }); break;
    case 'submit': p = submit(msg.id, false); break;
    case 'flush': p = flush(true).then(overview); break;
    case 'overview': p = overview(); break;
    case 'finalizeOrphan': p = finalizeOrphan(); break;
    case 'status': p = status(); break;
    case 'connect': p = connect(); break;
    case 'disconnect': p = Auth.disconnect().then(function () { return { ok: true }; }); break;
    case 'createSheet': p = createSheet(); break;
    case 'linkSheet': p = linkSheet(msg.url); break;
    case 'sheetAction': p = sheetAction(msg.action); break;
    default: return false;
  }
  wrap(p).then(sendResponse);
  return true;
});

chrome.alarms.onAlarm.addListener(function (a) { if (a.name === RETRY_ALARM) flush(false); });
chrome.runtime.onStartup.addListener(function () { flush(false); });
chrome.runtime.onInstalled.addListener(function (details) {
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
  flush(false);
});
