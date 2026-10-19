// Homeserver control traffic only. File bytes travel directly between browser and server.
export class StorageError extends Error {
  constructor(message, status = 503) { super(message); this.status = status; }
}

export function provider(value = 'cloudflare') {
  if (!['cloudflare', 'homeserver'].includes(value)) throw new StorageError('Invalid storage provider', 400);
  return value;
}

export function validateFile(filename, filesize) {
  if (typeof filename !== 'string' || !filename || filename.length > 1024 ||
      /[\\\x00-\x1f\x7f:%]/.test(filename) || filename.split('/').some(p => !p || p === '.' || p === '..')) {
    throw new StorageError('Invalid relative filename', 400);
  }
  if (!Number.isSafeInteger(filesize) || filesize < 0) throw new StorageError('Invalid file size', 400);
}

export async function home(env, route, method = 'GET', body) {
  if (!env.HOMESERVER_URL || !env.HOMESERVER_API_TOKEN) throw new StorageError('Homeserver hosting is not configured');
  const base = new URL(env.HOMESERVER_URL);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new StorageError('Invalid homeserver configuration');
  }
  let response;
  try {
    response = await fetch(new URL(route, base), {
      method, redirect: 'manual', signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${env.HOMESERVER_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch { throw new StorageError('Homeserver is unavailable. Please retry.'); }
  // DELETE must explicitly succeed (including already-absent objects), not return 404.
  if (!response.ok) throw new StorageError('Homeserver operation failed. Please retry.', response.status === 409 ? 409 : 503);
  if (method === 'DELETE') return;
  try { return await response.json(); }
  catch { throw new StorageError('Invalid homeserver response'); }
}

export async function homeUrl(env, id, key, method, filename, filesize) {
  const data = await home(env, `/v1/transfers/${encodeURIComponent(id)}/authorize`, 'POST', {
    object_id: key.split('/').pop(), method, filename, filesize,
    expires_in: method === 'PUT' ? 7200 : 3600,
  });
  let url;
  try { url = new URL(data.url); } catch { throw new StorageError('Invalid homeserver upload/download URL'); }
  // Keep capabilities on the configured HTTPS origin; no redirects or credential disclosure.
  if (url.origin !== new URL(env.HOMESERVER_URL).origin || url.username || url.password) {
    throw new StorageError('Invalid homeserver upload/download origin');
  }
  return url.href;
}

export async function requireHomeReady(env) {
  const health = await home(env, '/v1/health');
  if (health.ready !== true) throw new StorageError('Homeserver hosting is not ready');
}

export async function readyFiles(env, id, files) {
  const data = await home(env, `/v1/transfers/${encodeURIComponent(id)}/files`);
  if (!Array.isArray(data.object_ids) || data.object_ids.some(x => typeof x !== 'string')) {
    throw new StorageError('Invalid homeserver file list');
  }
  const ready = new Set(data.object_ids);
  return files.filter(f => ready.has(f.r2_key.split('/').pop()));
}

export async function requireCloudflareKey(env, key) {
  const match = typeof key === 'string' && key.match(/^transfers\/([^/]+)\//);
  if (!match) throw new StorageError('Invalid transfer key', 400);
  const row = await env.DB.prepare('SELECT storage_provider, storage_deleting FROM transfers WHERE id = ?').bind(match[1]).first();
  if (!row || row.storage_provider !== 'cloudflare' || row.storage_deleting) throw new StorageError('Invalid Cloudflare transfer', 409);
  const file = await env.DB.prepare(`SELECT r2_key FROM transfers WHERE id = ? AND r2_key = ?
    UNION ALL SELECT r2_key FROM transfer_files WHERE transfer_id = ? AND r2_key = ?`).bind(match[1], key, match[1], key).first();
  if (!file) throw new StorageError('Unknown transfer file', 404);
}
