#!/usr/bin/env node
/*
 * Bağımlılıksız mini test çalıştırıcı.
 * Kullanım: node test/run.js   (ya da npm test)
 */
'use strict';
const fs = require('fs');
const path = require('path');

const tests = [];
global.test = (name, fn) => tests.push({ name, fn, file: currentFile });
let currentFile = '';

const dir = __dirname;
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort();
for (const f of files) {
  currentFile = f;
  require(path.join(dir, f));
}

let passed = 0;
let failed = 0;
let lastFile = '';
for (const t of tests) {
  if (t.file !== lastFile) {
    console.log('\n' + t.file);
    lastFile = t.file;
  }
  try {
    t.fn();
    passed++;
    console.log('  ok    ' + t.name);
  } catch (err) {
    failed++;
    console.log('  HATA  ' + t.name);
    console.log('    ' + String(err && err.message ? err.message : err).split('\n').join('\n    '));
  }
}
console.log(`\n${passed} geçti, ${failed} kaldı`);
process.exit(failed ? 1 : 0);
