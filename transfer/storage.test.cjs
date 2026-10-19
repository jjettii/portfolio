const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const html = readFileSync(`${__dirname}/index.html`, 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function page() {
  const nodes = new Map();
  const document = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, { value: '', style: {}, textContent: '', innerHTML: '' });
      return nodes.get(id);
    },
    querySelector(selector) { return this.getElementById(selector); },
  };
  const context = vm.createContext({ document, location: { search: '' }, URLSearchParams });
  vm.runInContext(script, context);
  return context;
}

test('legacy hosting and admin labels', () => {
  const p = page();
  assert.equal(p.storageProvider({}), 'cloudflare');
  assert.equal(p.storageLabel({ storage_provider: 'homeserver' }), 'Homeserver');
  p.renderTransferList([
    { id: 'old', filename: 'Old', created_at: '2026-10-19' },
    { id: 'new', filename: 'New', created_at: '2026-10-19', storage_provider: 'homeserver' },
  ]);
  const list = p.document.getElementById('transferList').innerHTML;
  assert.match(list, /Cloudflare/);
  assert.match(list, /Homeserver/);
});

test('new transfer resets hosting to Cloudflare', () => {
  const p = page();
  p.resetUploadForm();
  assert.equal(p.document.querySelector('input[name="storageProvider"][value="cloudflare"]').checked, true);
});

test('large homeserver files use direct PUT; large legacy Cloudflare files use multipart', async () => {
  const p = page();
  const calls = [];
  p.uploadWithProgress = (...args) => calls.push(args);
  const file = { size: 6e9 };
  await p.uploadStoredFile({ storage_provider: 'homeserver', uploadUrl: 'https://files.example/upload' }, 'homeserver', 'key', file, () => {});
  await p.uploadStoredFile({}, 'cloudflare', 'key', file, () => {});
  assert.equal(calls[0][0], 'https://files.example/upload');
  assert.equal(calls[0][3], false);
  assert.equal(calls[1][0], 'key');
  assert.equal(calls[1][3], true);
  assert.throws(() => p.uploadStoredFile({ uploadUrl: 'https://r2.example' }, 'homeserver', 'key', file, () => {}), /did not confirm/);
  assert.equal(calls.length, 2);
});

test('homeserver requires advertised availability', async () => {
  const p = page();
  p.fetch = async () => ({ ok: false });
  await assert.rejects(p.requireHomeserver(), /not configured/);
  p.fetch = async () => ({ ok: true, json: async () => ({ storage_providers: ['cloudflare'] }) });
  await assert.rejects(p.requireHomeserver(), /unavailable/);
  p.fetch = async () => ({ ok: true, json: async () => ({ storage_providers: ['cloudflare', 'homeserver'] }) });
  await p.requireHomeserver();
});

test('single and folder creation transmit and verify provider', async () => {
  const p = page();
  vm.runInContext("chosenFiles = [{ file: { name: 'clip.mov', size: 123 }, path: 'folder/clip.mov' }]", p);
  const requests = [];
  const uploads = [];
  p.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ id: 'test', storage_provider: 'homeserver', uploadUrl: 'https://files.example/upload' }) };
  };
  p.uploadWithProgress = async (...args) => uploads.push(args);
  const bar = { style: {} }, label = {};
  assert.equal(await p.doSingleUpload('pass', 'Name', bar, label, {}, 'homeserver'), 'test');
  assert.equal(await p.doMultiUpload('pass', 'Name', bar, label, 'homeserver'), 'test');
  assert.equal(requests[0].body.storage_provider, 'homeserver');
  assert.equal(requests[1].body.storage_provider, 'homeserver');
  assert.equal(requests[2].body.filename, 'folder/clip.mov');
  assert.equal(uploads.length, 2);
  p.fetch = async () => ({ ok: true, json: async () => ({ id: 'wrong-provider' }) });
  await assert.rejects(p.doMultiUpload('pass', 'Name', bar, label, 'homeserver'), /did not confirm/);
  assert.equal(uploads.length, 2);
});
