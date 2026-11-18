import path from 'node:path';
import { existsSync, readdirSync, statSync, linkSync, unlinkSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

export function ensureStorageSchema(db) {
  const columns = db.prepare('PRAGMA table_info(invites)').all();
  for (const name of ['storage_name', 'storage_source']) {
    if (!columns.some(c => c.name === name)) db.exec(`ALTER TABLE invites ADD COLUMN ${name} TEXT`);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS invites_storage_name ON invites(storage_name COLLATE NOCASE)');
}

export function safePath(root, name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[<>:"/\\|?*\x00-\x1f\x7f]/.test(name) || /[. ]$/.test(name) || !name.isWellFormed()) throw Error('Unsafe storage filename');
  return path.join(root, name);
}

function component(value, fallback) {
  let name = String(value || '').toWellFormed().normalize('NFC')
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_').replace(/[. ]+$/g, '').trim();
  if (!name || /^\.+$/.test(name)) name = fallback;
  if (/^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(name)) name = `_${name}`;
  // Bound both UTF-8 bytes (Linux) and UTF-16 length (Windows), preserving code points.
  let shortened = '';
  for (const char of name) { if (Buffer.byteLength(shortened + char) > 90) break; shortened += char; }
  return shortened.replace(/[. ]+$/g, '') || fallback;
}

export function readableName(row) {
  const extension = row.filename?.match(/\.zip$/i)?.[0] || '.zip';
  return `${component(row.label, 'Upload')} - ${component(String(row.filename || 'archive.zip').replace(/\.zip$/i, ''), 'archive')}${extension}`;
}

const key = name => name.normalize('NFC').toLowerCase();
export function chooseName(db, root, row) {
  const taken = new Set(readdirSync(root).map(key));
  for (const item of db.prepare('SELECT storage_name FROM invites WHERE storage_name IS NOT NULL').all()) taken.add(key(item.storage_name));
  const base = readableName(row), extension = path.extname(base), stem = base.slice(0, -extension.length);
  let name = base;
  while (taken.has(key(name))) name = `${stem} - ${randomBytes(4).toString('hex')}${extension}`;
  return name;
}

function syncDirectory(root) {
  if (process.platform === 'win32') return;
  const fd = openSync(root, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function legacyArchive(root, row) {
  if (!/^[a-f0-9-]{36}$/.test(row.id)) throw Error('Invalid upload ID');
  const extension = row.filename?.match(/\.zip$/i)?.[0] || '.zip';
  for (const name of [`${row.id}${extension}`, `${row.id}.file`]) {
    if (existsSync(safePath(root, name))) return name;
  }
  throw Object.assign(Error('Archive missing'), { code: 'ENOENT' });
}

// Journal intent in SQLite before touching files. Hard-link publication is atomic and
// refuses to overwrite; syncing each directory change makes replay safe after a crash.
// Only one service OR offline migration may own this data directory at a time.
export function publishArchive(db, root, row, source) {
  if (!row.storage_name) {
    safePath(root, source);
    const info = statSync(safePath(root, source));
    if (!info.isFile() || info.size !== row.size) throw Error('Archive size mismatch');
    const name = chooseName(db, root, row);
    db.prepare('UPDATE invites SET storage_name=?,storage_source=? WHERE id=?').run(name, source, row.id);
    row = { ...row, storage_name: name, storage_source: source };
  }
  if (!row.storage_source) return safePath(root, row.storage_name);
  let from = safePath(root, row.storage_source), to = safePath(root, row.storage_name);
  if (existsSync(from)) {
    const original = statSync(from);
    if (!original.isFile() || original.size !== row.size) throw Error('Archive size mismatch');
    if (existsSync(to)) {
      const target = statSync(to);
      if (original.dev !== target.dev || original.ino !== target.ino) {
        // A different file claimed the destination. Never replace or delete it.
        const name = chooseName(db, root, row);
        db.prepare('UPDATE invites SET storage_name=? WHERE id=?').run(name, row.id);
        row = { ...row, storage_name: name }; to = safePath(root, name);
      }
    }
    if (!existsSync(to)) linkSync(from, to);
    syncDirectory(root);
    unlinkSync(from);
    syncDirectory(root);
  } else {
    const target = statSync(to);
    if (!target.isFile() || target.size !== row.size) throw Error('Archive recovery size mismatch');
  }
  db.prepare('UPDATE invites SET storage_source=NULL WHERE id=?').run(row.id);
  return to;
}

export function recoverStorage(db, root) {
  for (const row of db.prepare('SELECT * FROM invites WHERE storage_source IS NOT NULL').all()) publishArchive(db, root, row);
}
