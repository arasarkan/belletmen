/*
 * belletmen: Google ile giriş (service worker'da çalışır).
 *
 * chrome.identity.launchWebAuthFlow ile Google'ın OAuth ekranı açılır; kullanıcı
 * tarayıcıda açık olan herhangi bir hesabı seçebilir (çoklu hesap sorunu yok).
 * İzinler:
 *   drive.file  yalnızca belletmen'in oluşturduğu dosyalara erişim
 *   openid email  bağlı hesabın e-postası (yalnızca bu tarayıcıda, sessiz
 *                 yenileme ve "Bağlı: ..." gösterimi için)
 * Erişim tokenı ~1 saat geçerlidir ve chrome.storage.session'da (bellekte) tutulur.
 */
(function (root) {
  'use strict';
  var AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
  var USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
  var REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
  var SCOPES = ['https://www.googleapis.com/auth/drive.file', 'openid', 'email'];
  var MARGIN_MS = 2 * 60 * 1000;

  function clientId() {
    return (root.BELLETMEN_CONFIG && root.BELLETMEN_CONFIG.googleClientId || '').trim();
  }

  function redirectUri() { return chrome.identity.getRedirectURL('oauth2'); }

  function AuthError(code, message) {
    var e = new Error(message);
    e.code = code;
    return e;
  }

  async function launch(interactive, extra) {
    var id = clientId();
    if (!id) throw AuthError('no_client', 'Google istemci kimliği tanımlı değil (config.js).');
    var state = Math.random().toString(36).slice(2);
    var params = Object.assign({
      client_id: id,
      response_type: 'token',
      redirect_uri: redirectUri(),
      scope: SCOPES.join(' '),
      include_granted_scopes: 'true',
      state: state
    }, extra || {});
    var url = AUTH_URL + '?' + Object.keys(params).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
    }).join('&');

    var opts = { url: url, interactive: interactive };
    if (!interactive) { opts.abortOnLoadForNonInteractive = false; opts.timeoutMsForNonInteractive = 15000; }
    var resp;
    try {
      resp = await chrome.identity.launchWebAuthFlow(opts);
    } catch (e) {
      throw AuthError(interactive ? 'cancelled' : 'interaction_required',
        interactive ? 'Google girişi tamamlanmadı.' : 'Google oturumunun yenilenmesi gerekiyor.');
    }
    var frag = new URLSearchParams((resp.split('#')[1] || resp.split('?')[1] || ''));
    if (frag.get('error')) throw AuthError(frag.get('error'), 'Google girişi başarısız: ' + frag.get('error'));
    if (frag.get('state') !== state) throw AuthError('state', 'Google girişi doğrulanamadı.');
    var token = frag.get('access_token');
    if (!token) throw AuthError('no_token', 'Google erişim izni alınamadı.');
    var granted = (frag.get('scope') || '').split(' ');
    if (granted.indexOf(SCOPES[0]) < 0) {
      throw AuthError('scope', 'Google ekranında Drive dosyaları iznini işaretleyip tekrar bağlan.');
    }
    var exp = Date.now() + (Number(frag.get('expires_in')) || 3600) * 1000;
    await chrome.storage.session.set({ token: { value: token, exp: exp } });
    return token;
  }

  async function fetchEmail(token) {
    try {
      var res = await fetch(USERINFO_URL, { headers: { Authorization: 'Bearer ' + token } });
      var j = await res.json();
      return j.email || '';
    } catch (e) { return ''; }
  }

  async function account() {
    var g = await chrome.storage.local.get('account');
    return g.account || null;
  }

  /**
   * Geçerli bir erişim tokenı döndürür.
   * @param {{interactive?: boolean}} o  interactive=false ise kullanıcıya pencere gösterilmez
   */
  async function getToken(o) {
    o = o || {};
    var g = await chrome.storage.session.get('token');
    if (g.token && g.token.exp - MARGIN_MS > Date.now()) return g.token.value;
    var acc = await account();
    if (acc && acc.email) {
      try { return await launch(false, { prompt: 'none', login_hint: acc.email }); } catch (e) { if (!o.interactive) throw e; }
    } else if (!o.interactive) {
      throw AuthError('not_connected', 'Google hesabı bağlı değil.');
    }
    return launch(true, acc && acc.email ? { login_hint: acc.email } : { prompt: 'select_account' });
  }

  /** Hesap seçtirerek bağlanır (ayarlar sayfasından). */
  async function connect() {
    await revokeCurrent();
    var token = await launch(true, { prompt: 'select_account' });
    var email = await fetchEmail(token);
    var prev = await account();
    await chrome.storage.local.set({ account: { email: email, connectedAt: Date.now() } });
    return { email: email, changed: !!(prev && prev.email && prev.email !== email) };
  }

  /** Mevcut tokenı Google'da iptal eder (adres çubuğu/günlüklere düşmemesi için gövdede gönderilir). */
  async function revokeCurrent() {
    var g = await chrome.storage.session.get('token');
    await chrome.storage.session.remove('token');
    if (!g.token) return;
    try {
      await fetch(REVOKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'token=' + encodeURIComponent(g.token.value)
      });
    } catch (e) { /* çevrimdışı: token en geç 1 saatte kendiliğinden geçersizleşir */ }
  }

  async function disconnect() {
    await revokeCurrent();
    await chrome.storage.local.remove('account');
  }

  async function invalidate() { await chrome.storage.session.remove('token'); }

  root.BelletmenAuth = {
    clientId: clientId, redirectUri: redirectUri, getToken: getToken, connect: connect,
    disconnect: disconnect, invalidate: invalidate, account: account
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
