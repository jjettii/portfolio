const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function page(rows = [], pageOptions = {}) {
  const elements = new Map(), calls = [];
  class Element {
    constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.value = ''; this.hidden = false; this.children = []; this.listeners = {}; this.textContent = ''; }
    addEventListener(event, fn) { this.listeners[event] = fn; }
    async fire(event) { await this.listeners[event]?.({ preventDefault() {} }); }
    append(child) { this.children.push(child); }
    replaceChildren() { this.children = []; }
    querySelector(selector) { if (selector === 'button[type="submit"]') return this.submit || null; return this.button ||= new Element('button'); }
    scrollIntoView() {}
  }
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  for (const m of html.matchAll(/<(\w+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const el = new Element(m[1]); el.hidden = /\bhidden\b/.test(m[0]);
    el.value = /\bvalue="([^"]*)"/.exec(m[0])?.[1] || ''; elements.set(m[2], el);
  }
  elements.get('editForm').submit = new Element('button');
  const ctx = vm.createContext({
    document: { getElementById: id => elements.get(id), createElement: tag => new Element(tag) },
    location: { search: '?admin=1' }, URLSearchParams, URL, Date, console,
    window: { addEventListener() {} }, navigator: { clipboard: { async writeText() {} } },
    fetch: async (url, options) => {
      const route = new URL(url).pathname.replace('/incoming', ''), body = options.body && JSON.parse(options.body);
      calls.push({ route, method: options.method, body });
      let data;
      if (route === '/login') data = { token: 'admin-session' };
      else if (route === '/admin/capabilities') {
        if (pageOptions.oldBackend) return { ok: false, status: 404, json: async () => ({ error: 'Not found.' }) };
        data = { apiVersion: 2, maxSize: 500000000000 };
      }
      else if (route === '/admin' && options.method === 'GET') data = rows;
      else if (route === '/admin' && options.method === 'POST') data = { id: 'created', ...body, expires: Date.now() + 86400000, password: body.password || 'generated' };
      else if (options.method === 'GET') data = rows.find(row => route === `/admin/${row.id}`);
      else if (options.method === 'PATCH') data = { ...rows.find(row => route === `/admin/${row.id}`), ...body };
      else throw Error('Unexpected request');
      return { ok: true, json: async () => data };
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'upload.js'), 'utf8'), ctx);
  const $ = id => elements.get(id);
  return { $, calls, login: () => $('adminLogin').fire('submit') };
}

test('admin creates an invitation with the chosen password and shares returned credentials', async () => {
  const p = page(); await p.login();
  p.$('label').value = 'Client project'; p.$('invitePassword').value = 'chosen password'; p.$('limit').value = '500';
  await p.$('createForm').fire('submit');
  const create = p.calls.find(call => call.method === 'POST' && call.route === '/admin');
  assert.equal(create.body.password, 'chosen password'); assert.equal(create.body.maxSize, 500000000000);
  assert.match(p.$('shareDetails').value, /Password: chosen password/); assert.equal(p.$('invitePassword').value, '');
});

test('admin edits existing details, keeps unchanged expiry, and submits with the Save button', async () => {
  const row = { id: 'existing', label: 'Original', maxSize: 20000000000, expires: Date.now() + 86400000, state: 'waiting' };
  const p = page([row]); await p.login();
  await p.$('inbox').children[0].children.find(child => child.textContent === 'Edit invitation').fire('click');
  assert.equal(p.$('editForm').hidden, false); assert.match(p.$('editLink').value, /id=existing$/);
  p.$('editLabel').value = 'Renamed'; p.$('editPassword').value = 'replacement'; p.$('editLimit').value = '500';
  await p.$('editForm').fire('submit');
  const edit = p.calls.find(call => call.method === 'PATCH');
  assert.equal(edit.route, '/admin/existing'); assert.equal(edit.body.label, 'Renamed');
  assert.equal(edit.body.password, 'replacement'); assert.equal(edit.body.maxSize, 500000000000);
  assert.equal(edit.body.expires, undefined); assert.equal(p.$('editForm').hidden, true);
  assert.match(p.$('shareDetails').value, /Password: replacement/); assert.match(p.$('shareDetails').value, /id=existing/);
  assert.equal(p.$('copyEditLink').disabled, undefined);
});

test('blank edit password preserves the password; sign-out clears editor and share credentials', async () => {
  const p = page([{ id: 'existing', label: 'Original', maxSize: 20000000000, expires: Date.now() + 86400000, state: 'waiting' }]);
  await p.login(); await p.$('inbox').children[0].children.find(child => child.textContent === 'Edit invitation').fire('click');
  await p.$('editForm').fire('submit');
  assert.equal(p.calls.find(call => call.method === 'PATCH').body.password, undefined);
  assert.match(p.$('shareDetails').value, /Password: unchanged/);
  p.$('invitePassword').value = 'not saved'; await p.$('logout').fire('click');
  assert.equal(p.$('invitePassword').value, ''); assert.equal(p.$('shareDetails').value, '');
  assert.equal(p.$('editPassword').value, ''); assert.equal(p.$('dashboard').hidden, true);
});

test('old backends show an upgrade message before custom passwords or editing can be used', async () => {
  const p = page([], { oldBackend: true }); await p.login();
  assert.match(p.$('error').textContent, /older upload service/);
  assert.match(p.$('error').textContent, /500 GB/);
  assert.equal(p.$('dashboard').hidden, true);
  assert.equal(p.$('adminLogin').hidden, false);
  assert.equal(p.calls.some(call => call.route === '/admin'), false);
});
