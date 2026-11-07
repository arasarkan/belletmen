'use strict';
/*
 * Google Sheets API'nin bellek içi taklidi: Belletmen'in gönderdiği batchUpdate
 * isteklerini uygular ve loadModel'in döndürdüğü biçimde model üretir.
 * Gerçek API gibi atomiktir: bir istek hatalıysa hiçbiri uygulanmaz.
 */

function clone(x) { return JSON.parse(JSON.stringify(x)); }

class FakeSpreadsheet {
  constructor(body) {
    this.timeZone = body.properties.timeZone;
    this.title = body.properties.title;
    this.sheets = (body.sheets || []).map((s) => this._newSheet(s.properties));
    this.log = [];
  }

  _newSheet(p) {
    return {
      sheetId: p.sheetId, title: p.title,
      rowCount: p.gridProperties.rowCount, colCount: p.gridProperties.columnCount,
      cells: [], notes: {}, validations: {}, hiddenCols: {}, formats: {}
    };
  }

  _sheet(state, id) {
    const s = state.find((x) => x.sheetId === id);
    if (!s) throw new Error('Bilinmeyen sheetId ' + id);
    return s;
  }

  /** loadModel ile aynı biçim */
  model() {
    return {
      spreadsheetId: 'fake', spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/fake/edit',
      title: this.title, timeZone: this.timeZone,
      sheets: this.sheets.map((s) => ({
        sheetId: s.sheetId, title: s.title, rowCount: s.rowCount, colCount: s.colCount,
        values: trimRows(s.cells)
      }))
    };
  }

  batchUpdate(requests) {
    const state = clone(this.sheets);
    requests.forEach((req) => this._apply(state, req));
    this.sheets = state;
    this.log.push(requests);
  }

  _apply(state, req) {
    const kind = Object.keys(req)[0];
    const r = req[kind];
    switch (kind) {
      case 'addSheet': {
        const p = r.properties;
        if (state.some((s) => s.title === p.title || s.sheetId === p.sheetId)) throw new Error('addSheet çakışması: ' + p.title);
        state.push(this._newSheet(p));
        break;
      }
      case 'appendDimension': {
        const s = this._sheet(state, r.sheetId);
        if (r.dimension === 'ROWS') s.rowCount += r.length; else s.colCount += r.length;
        break;
      }
      case 'updateCells': {
        if (r.range) {
          const s = this._sheet(state, r.range.sheetId);
          if (r.rows) throw new Error('range + rows desteklenmiyor');
          s.cells = []; // tüm sayfa temizliği (Belletmen yalnızca bunu kullanır)
          break;
        }
        const s = this._sheet(state, r.start.sheetId);
        r.rows.forEach((row, i) => {
          row.values.forEach((cd, j) => {
            const ri = r.start.rowIndex + i, ci = r.start.columnIndex + j;
            if (ri >= s.rowCount || ci >= s.colCount) throw new Error(`Izgara sınırı aşıldı: ${s.title} ${ri},${ci}`);
            if (r.fields === 'note') { s.notes[ri + ',' + ci] = cd.note; return; }
            if (!r.fields.startsWith('userEnteredValue')) throw new Error('beklenmeyen fields: ' + r.fields);
            const uv = cd.userEnteredValue || {};
            if ('formulaValue' in uv) throw new Error('Formül yazılmamalı');
            const v = 'stringValue' in uv ? uv.stringValue : 'numberValue' in uv ? uv.numberValue : 'boolValue' in uv ? uv.boolValue : '';
            while (s.cells.length <= ri) s.cells.push([]);
            s.cells[ri][ci] = v;
            if (cd.userEnteredFormat && cd.userEnteredFormat.numberFormat) s.formats[ri + ',' + ci] = cd.userEnteredFormat.numberFormat.type;
            else delete s.formats[ri + ',' + ci];
          });
        });
        break;
      }
      case 'setDataValidation': {
        const s = this._sheet(state, r.range.sheetId);
        s.validations[r.range.startColumnIndex] = r.rule.condition.values.map((x) => x.userEnteredValue);
        break;
      }
      case 'updateDimensionProperties': {
        const s = this._sheet(state, r.range.sheetId);
        if (r.properties.hiddenByUser) s.hiddenCols[r.range.startIndex] = true;
        break;
      }
      case 'addConditionalFormatRule':
        break;
      default:
        throw new Error('Desteklenmeyen istek: ' + kind);
    }
  }

  // --- test yardımcıları ---
  sheet(title) { return this.sheets.find((s) => s.title === title); }

  objects(title) {
    const s = this.sheet(title);
    const vals = trimRows(s.cells);
    const h = vals[0] || [];
    return vals.slice(1).filter((r) => r.some((v) => v !== '' && v != null)).map((r) => {
      const o = {};
      h.forEach((k, i) => { o[k] = r[i] == null ? '' : r[i]; });
      return o;
    });
  }

  /** Kullanıcının bir hücreye yazması (başlığa ve satıra göre) */
  userSet(title, rowPredicate, header, value) {
    const s = this.sheet(title);
    const h = s.cells[0];
    const col = h.indexOf(header);
    for (let r = 1; r < s.cells.length; r++) {
      const o = {};
      h.forEach((k, i) => { o[k] = s.cells[r] ? s.cells[r][i] : ''; });
      if (rowPredicate(o)) { s.cells[r][col] = value; return r + 1; }
    }
    throw new Error('satır bulunamadı');
  }

  userAppend(title, row) {
    const s = this.sheet(title);
    s.cells.push(row.slice());
  }
}

function trimRows(cells) {
  // Gerçek API gibi: sondaki boş satır/sütunlar dönmez
  const out = cells.map((r) => {
    const row = (r || []).map((v) => (v == null ? '' : v));
    while (row.length && row[row.length - 1] === '') row.pop();
    return row;
  });
  while (out.length && !out[out.length - 1].length) out.pop();
  return out;
}

module.exports = { FakeSpreadsheet };
