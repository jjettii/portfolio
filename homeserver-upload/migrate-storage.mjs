import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { statSync } from 'node:fs';
import { ensureStorageSchema, legacyArchive, readableName, safePath, publishArchive, recoverStorage } from './storage.mjs';

export function migrateStorage(root, { apply = false } = {}) {
  const db = new DatabaseSync(path.join(root, 'uploads.sqlite'), { readOnly: !apply });
  try {
    if (apply) {
      db.exec('PRAGMA synchronous=FULL');
      ensureStorageSchema(db);
      recoverStorage(db, root);
    }
    const rows = db.prepare("SELECT * FROM invites WHERE state='complete' ORDER BY created,id").all();
    // Preflight every legacy source before beginning new file moves.
    const plan = rows.filter(row => !row.storage_name).map(row => {
      const source = legacyArchive(root, row), info = statSync(safePath(root, source));
      if (!info.isFile() || info.size !== row.size) throw Error(`Archive size mismatch: ${row.id}`);
      return { row, source, proposed: readableName(row) };
    });
    const pending = apply ? [] : db.prepare('SELECT * FROM invites').all().filter(row => row.storage_source).map(row => ({
      id: row.id, source: row.storage_source, destination: row.storage_name, recoveryPending: true, applied: false
    }));
    return [...pending, ...plan.map(({ row, source, proposed }) => ({ id: row.id, source,
      destination: apply ? path.basename(publishArchive(db, root, row, source)) : proposed,
      applied: apply }))];
  } finally { db.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, ...flags] = process.argv.slice(2);
  if (!root || flags.some(flag => !['--apply', '--service-stopped'].includes(flag)) || (flags.includes('--apply') && !flags.includes('--service-stopped'))) {
    console.error('Usage: node migrate-storage.mjs DATA_ROOT [--apply --service-stopped]');
    process.exitCode = 1;
  } else {
    try {
      const apply = flags.includes('--apply');
      console.log(JSON.stringify(migrateStorage(path.resolve(root), { apply }), null, 2));
      if (!apply) console.log('Preview only. Duplicate/case-equivalent destinations receive a unique suffix during apply. Stop the service and back up app, config and data before applying.');
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
