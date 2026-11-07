/*
 * belletmen: Google Sheets REST API için küçük istemci (service worker'da çalışır).
 * Yalnızca drive.file izniyle erişilebilen, belletmen'in oluşturduğu tablolarla çalışır.
 */
(function (root) {
  'use strict';
  var BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

  function SheetsError(status, message) {
    var e = new Error(message);
    e.status = status;
    return e;
  }

  async function call(token, method, url, body) {
    var res;
    try {
      res = await fetch(url, {
        method: method,
        headers: Object.assign({ Authorization: 'Bearer ' + token }, body ? { 'Content-Type': 'application/json' } : {}),
        body: body ? JSON.stringify(body) : undefined
      });
    } catch (e) {
      throw SheetsError(0, 'İnternet bağlantısı yok.');
    }
    var text = await res.text();
    var json = null;
    try { json = text ? JSON.parse(text) : {}; } catch (e) { /* JSON değil */ }
    if (!res.ok) {
      var msg = json && json.error && json.error.message || ('HTTP ' + res.status);
      if (res.status === 404 || res.status === 403) {
        msg = 'Tabloya erişilemiyor. Tablo silinmiş ya da başka bir hesapla oluşturulmuş olabilir.';
      } else if (res.status === 429) {
        msg = 'Google istek sınırına takıldı. Birazdan tekrar denenecek.';
      }
      throw SheetsError(res.status, msg);
    }
    return json;
  }

  function create(token, body) {
    return call(token, 'POST', BASE, body);
  }

  /** Tabloyu Workbook modeli olarak okur. */
  async function loadModel(token, id) {
    var meta = await call(token, 'GET', BASE + '/' + encodeURIComponent(id) +
      '?fields=spreadsheetId,spreadsheetUrl,properties(title,timeZone),sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))');
    var sheets = (meta.sheets || []).map(function (s) {
      var p = s.properties;
      return { sheetId: p.sheetId, title: p.title, rowCount: p.gridProperties.rowCount, colCount: p.gridProperties.columnCount, values: [] };
    });
    var known = {};
    var titles = root.BelletmenSheetLogic.TITLES;
    Object.keys(titles).forEach(function (k) { known[titles[k]] = true; });
    var wanted = sheets.filter(function (s) { return known[s.title]; });
    if (wanted.length) {
      var qs = wanted.map(function (s) { return 'ranges=' + encodeURIComponent("'" + s.title.replace(/'/g, "''") + "'"); }).join('&');
      var vals = await call(token, 'GET', BASE + '/' + encodeURIComponent(id) + '/values:batchGet?' + qs +
        '&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER&majorDimension=ROWS');
      (vals.valueRanges || []).forEach(function (vr, i) { wanted[i].values = vr.values || []; });
    }
    return {
      spreadsheetId: meta.spreadsheetId,
      spreadsheetUrl: meta.spreadsheetUrl,
      title: meta.properties.title,
      timeZone: meta.properties.timeZone,
      sheets: sheets
    };
  }

  function batchUpdate(token, id, requests) {
    if (!requests.length) return Promise.resolve({});
    return call(token, 'POST', BASE + '/' + encodeURIComponent(id) + ':batchUpdate', { requests: requests });
  }

  /** Tablo adresinden kimliği çıkarır. */
  function parseId(urlOrId) {
    var s = String(urlOrId || '').trim();
    var m = /\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/.exec(s);
    if (m) return m[1];
    return /^[a-zA-Z0-9_-]{20,}$/.test(s) ? s : '';
  }

  root.BelletmenSheetsApi = { create: create, loadModel: loadModel, batchUpdate: batchUpdate, parseId: parseId };
})(typeof globalThis !== 'undefined' ? globalThis : this);
