'use strict';
(() => {
  const API = 'https://files.jordanettinger.com';
  const $ = id => document.getElementById(id);
  const show = (id, yes = true) => { $(id).hidden = !yes; };
  const error = e => { $('error').textContent = e.message; show('error'); };
  const clearError = () => show('error', false);
  const size = bytes => `${(bytes / 1000 ** 3).toLocaleString(undefined, { maximumFractionDigits: 2 })} GB`;
  let adminToken = '', clientToken = '', upload, running = false, paused = false, xhr, wakeLock;
  let editingId = '', originalExpiry = '';
  const shareLink = id => `https://www.jordanettinger.com/upload/?id=${id}`;
  async function api(route, { token, method = 'GET', body } = {}) {
    const r = await fetch(`${API}/incoming${route}`, { method, headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}),
    }, body: body ? JSON.stringify(body) : undefined, cache: 'no-store', referrerPolicy: 'no-referrer' });
    const data = await r.json();
    if (!r.ok) throw Object.assign(Error(data.error || 'Request failed.'), { status: r.status });
    return data;
  }
  function bind(id, fn) {
    $(id).addEventListener($(id).tagName === 'FORM' ? 'submit' : 'click', async e => {
      e.preventDefault(); clearError(); const button = $(id).tagName === 'FORM' ? $(id).querySelector('button[type="submit"]') || $(id).querySelector('button') : $(id);
      button.disabled = true;
      try { await fn(); } catch (e) { error(e); } finally { button.disabled = false; }
    });
  }
  const params = new URLSearchParams(location.search);
  if (params.has('admin')) { show('clientView', false); show('adminView'); }
  $('uploadId').value = params.get('id') || '';
  function renderUpload() {
    show('unlockForm', false); show('uploadPanel');
    $('clientLabel').textContent = upload.label;
    show('uploadControls', upload.state !== 'complete'); show('uploadSuccess', upload.state === 'complete');
    $('uploadLimit').textContent = `Maximum ${size(upload.maxSize)} · Expires ${new Date(upload.expires).toLocaleString()}`;
    $('resumeHint').textContent = upload.state === 'uploading' ? `Select your original ZIP (${upload.filename}) to resume from ${size(upload.offset)}.` : '';
    $('uploadProgress').value = upload.size ? upload.offset / upload.size * 100 : 0;
  }
  bind('unlockForm', async () => {
    const data = await api('/unlock', { method: 'POST', body: { id: $('uploadId').value.trim(), password: $('uploadPassword').value } });
    clientToken = data.token; upload = data.upload; $('uploadPassword').value = ''; renderUpload();
  });
  async function fingerprint(file) {
    // Hash every byte with bounded memory. This also prevents resuming a different ZIP with the same name/size.
    // Per-chunk digest chain avoids holding a large file in browser memory.
    let digest = new Uint8Array(32);
    for (let offset = 0; offset < file.size; offset += upload.chunkSize) {
      if (paused) throw Error('Upload paused. Select Upload ZIP to resume.');
      const chunk = new Uint8Array(await file.slice(offset, offset + upload.chunkSize).arrayBuffer());
      const combined = new Uint8Array(digest.length + chunk.length); combined.set(digest); combined.set(chunk, digest.length);
      digest = new Uint8Array(await crypto.subtle.digest('SHA-256', combined));
      $('progressText').textContent = `Checking ZIP for safe resume… ${Math.round(Math.min(offset + chunk.length, file.size) / file.size * 100)}%`;
    }
    return [...digest].map(x => x.toString(16).padStart(2, '0')).join('');
  }
  function chunk(file, offset, onProgress) {
    return new Promise((resolve, reject) => {
      xhr = new XMLHttpRequest(); xhr.open('PUT', `${API}/incoming/client/${upload.id}/chunk`);
      xhr.setRequestHeader('Authorization', `Bearer ${clientToken}`); xhr.setRequestHeader('Upload-Offset', String(offset));
      // No total timeout: even a very slow connection can keep making progress.
      let stall;
      const touch = () => { clearTimeout(stall); stall = setTimeout(() => xhr?.abort(), 100000); };
      xhr.upload.onprogress = e => { touch(); onProgress(e.loaded); };
      xhr.onload = () => { clearTimeout(stall); let data; try { data = JSON.parse(xhr.responseText); } catch { reject(Error('Unexpected server response.')); return; }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data); else reject(Object.assign(Error(data.error || 'Upload interrupted.'), { status: xhr.status })); };
      xhr.onerror = xhr.onabort = () => { clearTimeout(stall); reject(Error(paused ? 'Upload paused.' : 'Connection interrupted.')); };
      touch(); xhr.send(file.slice(offset, offset + upload.chunkSize));
    });
  }
  bind('sendFile', async () => {
    if (running) return;
    const files = $('zipFile').files, file = files[0];
    if (files.length !== 1 || !file || !/\.zip$/i.test(file.name)) throw Error('Choose exactly one ZIP containing all your files.');
    if (!file.size || file.size > upload.maxSize) throw Error('The ZIP exceeds this invitation’s size limit or is empty.');
    running = true; paused = false; $('zipFile').disabled = true; show('pauseFile');
    try {
      try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* Optional on supported devices. */ }
      const fp = await fingerprint(file);
      upload = await api(`/client/${upload.id}/start`, { token: clientToken, method: 'POST', body: { filename: file.name, size: file.size, fingerprint: fp } });
      let failures = 0, start = performance.now(), initial = upload.offset;
      while (upload.offset < file.size) {
        if (paused) throw Error('Upload paused. Select Upload ZIP to resume.');
        try {
          upload = await chunk(file, upload.offset, loaded => {
            const bytes = upload.offset + loaded;
            $('uploadProgress').value = bytes / file.size * 100;
            const speed = (bytes - initial) / ((performance.now() - start) / 1000);
            const remaining = speed > 0 ? Math.ceil((file.size - bytes) / speed / 60) : 0;
            $('progressText').textContent = `${Math.min(100, Math.floor(bytes / file.size * 100))}% · ${size(bytes)} of ${size(file.size)} · ${remaining > 0 ? `about ${remaining} min remaining` : 'Finishing…'}`;
          }); failures = 0;
        } catch (e) {
          if (paused || [400, 401, 403, 404, 410, 413, 507].includes(e.status) || ++failures > 8) throw e;
          $('progressText').textContent = `Connection interrupted. Retrying… (${failures}/8)`;
          await new Promise(resolve => setTimeout(resolve, Math.min(1000 * 2 ** failures, 30000)));
          if (paused) throw Error('Upload paused. Select Upload ZIP to resume.');
          // A response can be lost after the server commits a chunk. Ask for its durable offset.
          try { upload = await api(`/client/${upload.id}`, { token: clientToken }); } catch (statusError) {
            if ([401, 404, 410].includes(statusError.status)) throw statusError;
          }
        }
      }
      $('progressText').textContent = 'Confirming delivery…';
      // Completion is idempotent; recover a response lost after the server seals the invitation.
      for (let attempt = 0; ; attempt++) {
        try { upload = await api(`/client/${upload.id}/complete`, { token: clientToken, method: 'POST' }); break; }
        catch (e) { if (attempt >= 4 || (e.status && e.status < 500 && e.status !== 409)) throw e; await new Promise(r => setTimeout(r, 2000)); }
      }
      $('zipFile').value = ''; renderUpload();
    } finally {
      running = false; xhr = null; $('zipFile').disabled = false; show('pauseFile', false);
      await wakeLock?.release().catch(() => {}); wakeLock = null;
    }
  });
  $('pauseFile').addEventListener('click', () => { paused = true; xhr?.abort(); });
  window.addEventListener('beforeunload', e => { if (running) { e.preventDefault(); e.returnValue = ''; } });
  bind('adminLogin', async () => {
    const data = await api('/login', { method: 'POST', body: { password: $('adminPassword').value } });
    try {
      const caps = await api('/admin/capabilities', { token: data.token });
      if (caps.apiVersion < 2 || caps.maxSize !== 500 * 1000 ** 3) throw Error('The homeserver upload service needs updating. Install the latest server.mjs, restart portfolio-uploads, then sign in again.');
    } catch (e) {
      if (e.status === 404) throw Error('The homeserver is running an older upload service. Install the latest server.mjs and restart portfolio-uploads to enable the 500 GB limit and editing.');
      throw e;
    }
    adminToken = data.token; $('adminPassword').value = ''; show('adminLogin', false); show('dashboard'); await refresh();
  });
  async function refresh() {
    const rows = await api('/admin', { token: adminToken }); $('inbox').replaceChildren();
    if (!rows.length) { $('inbox').textContent = 'No upload invitations yet.'; return; }
    for (const row of rows) {
      const card = document.createElement('article'); card.className = 'card';
      const title = document.createElement('h2'); title.textContent = row.label; card.append(title);
      const meta = document.createElement('p'); meta.className = 'meta';
      const state = row.state !== 'complete' && row.expires < Date.now() ? 'Expired' : row.state;
      meta.textContent = `${state} · ${row.id}\n${row.filename || 'Waiting for one ZIP'}${row.size ? ` · ${size(row.size)}` : ''}\nExpires ${new Date(row.expires).toLocaleString()}${row.state === 'uploading' ? `\n${Math.floor(row.offset / row.size * 100)}% received` : ''}`;
      card.append(meta);
      const edit = document.createElement('button'); edit.textContent = 'Edit invitation'; edit.className = 'secondary';
      edit.addEventListener('click', async () => {
        clearError(); edit.disabled = true;
        try { await openEditor(row.id); } catch (e) { error(e); } finally { edit.disabled = false; }
      }); card.append(edit);
      if (row.state === 'complete') {
        const download = document.createElement('button'); download.textContent = 'Download ZIP';
        download.addEventListener('click', async () => {
          clearError(); download.disabled = true;
          try { const data = await api(`/admin/${row.id}/download`, { token: adminToken, method: 'POST' });
            const link = document.createElement('a'); link.href = new URL(data.url, API).href; link.referrerPolicy = 'no-referrer'; link.click();
          } catch (e) { error(e); } finally { download.disabled = false; }
        }); card.append(download);
      }
      const remove = document.createElement('button'); remove.className = 'secondary'; remove.textContent = 'Delete invitation + file';
      remove.addEventListener('click', async () => {
        if (!confirm(`Permanently delete “${row.label}” and its file?`)) return;
        clearError(); remove.disabled = true;
        try {
          await api(`/admin/${row.id}`, { token: adminToken, method: 'DELETE' });
          if (editingId === row.id) closeEditor();
          show('newInvite', false); $('shareDetails').value = ''; await refresh();
        }
        catch (e) { error(e); remove.disabled = false; }
      }); card.append(remove); $('inbox').append(card);
    }
  }
  bind('refresh', refresh);
  function closeEditor() {
    editingId = ''; originalExpiry = ''; $('editPassword').value = ''; $('editLink').value = ''; show('editForm', false);
  }
  async function openEditor(id) {
    const row = await api(`/admin/${id}`, { token: adminToken });
    editingId = id;
    $('editLabel').value = row.label; $('editPassword').value = ''; $('editLimit').value = row.maxSize / 1000 ** 3;
    const expiry = new Date(row.expires);
    originalExpiry = new Date(row.expires - expiry.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    $('editExpires').value = originalExpiry;
    $('editLink').value = shareLink(id);
    $('editState').textContent = `${row.id} · ${row.state}${row.state === 'complete' ? ' · This invitation has already been used.' : ''}`;
    $('editStatus').textContent = ''; show('editForm'); $('editForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  bind('copyEditLink', async () => { await navigator.clipboard.writeText($('editLink').value); $('editStatus').textContent = 'Link copied.'; });
  $('cancelEdit').addEventListener('click', closeEditor);
  function showShareDetails(row, password) {
    $('shareDetails').value = `Upload: ${shareLink(row.id)}\n${password === undefined ? 'Password: unchanged (use the password previously shared)' : `Password: ${password}`}\nExpires: ${new Date(row.expires).toLocaleString()}\nPlease send all files in a single .ZIP file (maximum ${size(row.maxSize)}).`;
    show('newInvite'); $('copyStatus').textContent = '';
  }
  bind('editForm', async () => {
    if (!editingId) throw Error('Select an invitation to edit.');
    const body = { label: $('editLabel').value.trim(), maxSize: Math.round(Number($('editLimit').value) * 1000 ** 3) };
    if ($('editExpires').value !== originalExpiry) body.expires = new Date($('editExpires').value).getTime();
    if ($('editPassword').value !== '') body.password = $('editPassword').value;
    const row = await api(`/admin/${editingId}`, { token: adminToken, method: 'PATCH', body });
    showShareDetails(row, body.password); closeEditor(); await refresh();
    $('copyStatus').textContent = 'Changes saved. The upload link stays the same.';
  });
  bind('createForm', async () => {
    const row = await api('/admin', { token: adminToken, method: 'POST', body: { label: $('label').value.trim(), password: $('invitePassword').value, days: Number($('days').value), maxSize: Number($('limit').value) * 1000 ** 3 } });
    showShareDetails(row, row.password); $('invitePassword').value = ''; await refresh();
  });
  bind('copyInvite', async () => { await navigator.clipboard.writeText($('shareDetails').value); $('copyStatus').textContent = 'Copied.'; });
  $('logout').addEventListener('click', () => {
    adminToken = ''; $('shareDetails').value = ''; $('invitePassword').value = ''; closeEditor(); $('inbox').replaceChildren(); show('newInvite', false); show('dashboard', false); show('adminLogin'); clearError();
  });
})();
