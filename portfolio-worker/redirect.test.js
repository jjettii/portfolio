import { test } from 'node:test';
import assert from 'node:assert/strict';
import { home } from './storage.js';

test('homeserver fetch uses Workers-supported redirect mode and rejects redirects', async () => {
  const originalFetch = globalThis.fetch;
  const env = { HOMESERVER_URL: 'https://files.example', HOMESERVER_API_TOKEN: 'test-only' };
  let status = 200;
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    if (!['manual', 'follow'].includes(options.redirect)) throw new TypeError('Invalid redirect value');
    assert.equal(options.redirect, 'manual');
    assert.equal(new URL(url).origin, 'https://files.example');
    return status === 200 ? Response.json({ready: true}) : new Response(null, {
      status, headers: {Location: 'https://other.example/do-not-follow'}
    });
  };
  try {
    assert.deepEqual(await home(env, '/v1/health'), {ready: true});
    for (const code of [301, 302, 303, 307, 308]) {
      status = code;
      const before = calls;
      await assert.rejects(home(env, '/v1/health'), /Homeserver operation failed/);
      assert.equal(calls, before + 1);
    }
  } finally { globalThis.fetch = originalFetch; }
});
