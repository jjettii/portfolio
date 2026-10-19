import { StorageError, provider, validateFile, home, homeUrl, readyFiles, requireCloudflareKey, requireHomeReady } from './storage.js';
var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// node_modules/aws4fetch/dist/aws4fetch.esm.mjs
var encoder = new TextEncoder();
var HOST_SERVICES = {
  appstream2: "appstream",
  cloudhsmv2: "cloudhsm",
  email: "ses",
  marketplace: "aws-marketplace",
  mobile: "AWSMobileHubService",
  pinpoint: "mobiletargeting",
  queue: "sqs",
  "git-codecommit": "codecommit",
  "mturk-requester-sandbox": "mturk-requester",
  "personalize-runtime": "personalize"
};
var UNSIGNABLE_HEADERS = /* @__PURE__ */ new Set([
  "authorization",
  "content-type",
  "content-length",
  "user-agent",
  "presigned-expires",
  "expect",
  "x-amzn-trace-id",
  "range",
  "connection"
]);
var AwsClient = class {
  constructor({ accessKeyId, secretAccessKey, sessionToken, service, region, cache, retries, initRetryMs }) {
    if (accessKeyId == null)
      throw new TypeError("accessKeyId is a required option");
    if (secretAccessKey == null)
      throw new TypeError("secretAccessKey is a required option");
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.sessionToken = sessionToken;
    this.service = service;
    this.region = region;
    this.cache = cache || /* @__PURE__ */ new Map();
    this.retries = retries != null ? retries : 10;
    this.initRetryMs = initRetryMs || 50;
  }
  async sign(input, init) {
    if (input instanceof Request) {
      const { method, url, headers, body } = input;
      init = Object.assign({ method, url, headers }, init);
      if (init.body == null && headers.has("Content-Type")) {
        init.body = body != null && headers.has("X-Amz-Content-Sha256") ? body : await input.clone().arrayBuffer();
      }
      input = url;
    }
    const signer = new AwsV4Signer(Object.assign({ url: input.toString() }, init, this, init && init.aws));
    const signed = Object.assign({}, init, await signer.sign());
    delete signed.aws;
    try {
      return new Request(signed.url.toString(), signed);
    } catch (e) {
      if (e instanceof TypeError) {
        return new Request(signed.url.toString(), Object.assign({ duplex: "half" }, signed));
      }
      throw e;
    }
  }
  async fetch(input, init) {
    for (let i = 0; i <= this.retries; i++) {
      const fetched = fetch(await this.sign(input, init));
      if (i === this.retries) {
        return fetched;
      }
      const res = await fetched;
      if (res.status < 500 && res.status !== 429) {
        return res;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.random() * this.initRetryMs * Math.pow(2, i)));
    }
    throw new Error("An unknown error occurred, ensure retries is not negative");
  }
};
__name(AwsClient, "AwsClient");
var AwsV4Signer = class {
  constructor({ method, url, headers, body, accessKeyId, secretAccessKey, sessionToken, service, region, cache, datetime, signQuery, appendSessionToken, allHeaders, singleEncode }) {
    if (url == null)
      throw new TypeError("url is a required option");
    if (accessKeyId == null)
      throw new TypeError("accessKeyId is a required option");
    if (secretAccessKey == null)
      throw new TypeError("secretAccessKey is a required option");
    this.method = method || (body ? "POST" : "GET");
    this.url = new URL(url);
    this.headers = new Headers(headers || {});
    this.body = body;
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.sessionToken = sessionToken;
    let guessedService, guessedRegion;
    if (!service || !region) {
      [guessedService, guessedRegion] = guessServiceRegion(this.url, this.headers);
    }
    this.service = service || guessedService || "";
    this.region = region || guessedRegion || "us-east-1";
    this.cache = cache || /* @__PURE__ */ new Map();
    this.datetime = datetime || (/* @__PURE__ */ new Date()).toISOString().replace(/[:-]|\.\d{3}/g, "");
    this.signQuery = signQuery;
    this.appendSessionToken = appendSessionToken || this.service === "iotdevicegateway";
    this.headers.delete("Host");
    if (this.service === "s3" && !this.signQuery && !this.headers.has("X-Amz-Content-Sha256")) {
      this.headers.set("X-Amz-Content-Sha256", "UNSIGNED-PAYLOAD");
    }
    const params = this.signQuery ? this.url.searchParams : this.headers;
    params.set("X-Amz-Date", this.datetime);
    if (this.sessionToken && !this.appendSessionToken) {
      params.set("X-Amz-Security-Token", this.sessionToken);
    }
    this.signableHeaders = ["host", ...this.headers.keys()].filter((header) => allHeaders || !UNSIGNABLE_HEADERS.has(header)).sort();
    this.signedHeaders = this.signableHeaders.join(";");
    this.canonicalHeaders = this.signableHeaders.map((header) => header + ":" + (header === "host" ? this.url.host : (this.headers.get(header) || "").replace(/\s+/g, " "))).join("\n");
    this.credentialString = [this.datetime.slice(0, 8), this.region, this.service, "aws4_request"].join("/");
    if (this.signQuery) {
      if (this.service === "s3" && !params.has("X-Amz-Expires")) {
        params.set("X-Amz-Expires", "86400");
      }
      params.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
      params.set("X-Amz-Credential", this.accessKeyId + "/" + this.credentialString);
      params.set("X-Amz-SignedHeaders", this.signedHeaders);
    }
    if (this.service === "s3") {
      try {
        this.encodedPath = decodeURIComponent(this.url.pathname.replace(/\+/g, " "));
      } catch (e) {
        this.encodedPath = this.url.pathname;
      }
    } else {
      this.encodedPath = this.url.pathname.replace(/\/+/g, "/");
    }
    if (!singleEncode) {
      this.encodedPath = encodeURIComponent(this.encodedPath).replace(/%2F/g, "/");
    }
    this.encodedPath = encodeRfc3986(this.encodedPath);
    const seenKeys = /* @__PURE__ */ new Set();
    this.encodedSearch = [...this.url.searchParams].filter(([k]) => {
      if (!k)
        return false;
      if (this.service === "s3") {
        if (seenKeys.has(k))
          return false;
        seenKeys.add(k);
      }
      return true;
    }).map((pair) => pair.map((p) => encodeRfc3986(encodeURIComponent(p)))).sort(([k1, v1], [k2, v2]) => k1 < k2 ? -1 : k1 > k2 ? 1 : v1 < v2 ? -1 : v1 > v2 ? 1 : 0).map((pair) => pair.join("=")).join("&");
  }
  async sign() {
    if (this.signQuery) {
      this.url.searchParams.set("X-Amz-Signature", await this.signature());
      if (this.sessionToken && this.appendSessionToken) {
        this.url.searchParams.set("X-Amz-Security-Token", this.sessionToken);
      }
    } else {
      this.headers.set("Authorization", await this.authHeader());
    }
    return {
      method: this.method,
      url: this.url,
      headers: this.headers,
      body: this.body
    };
  }
  async authHeader() {
    return [
      "AWS4-HMAC-SHA256 Credential=" + this.accessKeyId + "/" + this.credentialString,
      "SignedHeaders=" + this.signedHeaders,
      "Signature=" + await this.signature()
    ].join(", ");
  }
  async signature() {
    const date = this.datetime.slice(0, 8);
    const cacheKey = [this.secretAccessKey, date, this.region, this.service].join();
    let kCredentials = this.cache.get(cacheKey);
    if (!kCredentials) {
      const kDate = await hmac("AWS4" + this.secretAccessKey, date);
      const kRegion = await hmac(kDate, this.region);
      const kService = await hmac(kRegion, this.service);
      kCredentials = await hmac(kService, "aws4_request");
      this.cache.set(cacheKey, kCredentials);
    }
    return buf2hex(await hmac(kCredentials, await this.stringToSign()));
  }
  async stringToSign() {
    return [
      "AWS4-HMAC-SHA256",
      this.datetime,
      this.credentialString,
      buf2hex(await hash(await this.canonicalString()))
    ].join("\n");
  }
  async canonicalString() {
    return [
      this.method.toUpperCase(),
      this.encodedPath,
      this.encodedSearch,
      this.canonicalHeaders + "\n",
      this.signedHeaders,
      await this.hexBodyHash()
    ].join("\n");
  }
  async hexBodyHash() {
    let hashHeader = this.headers.get("X-Amz-Content-Sha256") || (this.service === "s3" && this.signQuery ? "UNSIGNED-PAYLOAD" : null);
    if (hashHeader == null) {
      if (this.body && typeof this.body !== "string" && !("byteLength" in this.body)) {
        throw new Error("body must be a string, ArrayBuffer or ArrayBufferView, unless you include the X-Amz-Content-Sha256 header");
      }
      hashHeader = buf2hex(await hash(this.body || ""));
    }
    return hashHeader;
  }
};
__name(AwsV4Signer, "AwsV4Signer");
async function hmac(key, string) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    typeof key === "string" ? encoder.encode(key) : key,
    { name: "HMAC", hash: { name: "SHA-256" } },
    false,
    ["sign"]
  );
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(string));
}
__name(hmac, "hmac");
async function hash(content) {
  return crypto.subtle.digest("SHA-256", typeof content === "string" ? encoder.encode(content) : content);
}
__name(hash, "hash");
var HEX_CHARS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "a", "b", "c", "d", "e", "f"];
function buf2hex(arrayBuffer) {
  const buffer = new Uint8Array(arrayBuffer);
  let out = "";
  for (let idx = 0; idx < buffer.length; idx++) {
    const n = buffer[idx];
    out += HEX_CHARS[n >>> 4 & 15];
    out += HEX_CHARS[n & 15];
  }
  return out;
}
__name(buf2hex, "buf2hex");
function encodeRfc3986(urlEncodedStr) {
  return urlEncodedStr.replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}
__name(encodeRfc3986, "encodeRfc3986");
function guessServiceRegion(url, headers) {
  const { hostname, pathname } = url;
  if (hostname.endsWith(".on.aws")) {
    const match2 = hostname.match(/^[^.]{1,63}\.lambda-url\.([^.]{1,63})\.on\.aws$/);
    return match2 != null ? ["lambda", match2[1] || ""] : ["", ""];
  }
  if (hostname.endsWith(".r2.cloudflarestorage.com")) {
    return ["s3", "auto"];
  }
  if (hostname.endsWith(".backblazeb2.com")) {
    const match2 = hostname.match(/^(?:[^.]{1,63}\.)?s3\.([^.]{1,63})\.backblazeb2\.com$/);
    return match2 != null ? ["s3", match2[1] || ""] : ["", ""];
  }
  const match = hostname.replace("dualstack.", "").match(/([^.]{1,63})\.(?:([^.]{0,63})\.)?amazonaws\.com(?:\.cn)?$/);
  let service = match && match[1] || "";
  let region = match && match[2];
  if (region === "us-gov") {
    region = "us-gov-west-1";
  } else if (region === "s3" || region === "s3-accelerate") {
    region = "us-east-1";
    service = "s3";
  } else if (service === "iot") {
    if (hostname.startsWith("iot.")) {
      service = "execute-api";
    } else if (hostname.startsWith("data.jobs.iot.")) {
      service = "iot-jobs-data";
    } else {
      service = pathname === "/mqtt" ? "iotdevicegateway" : "iotdata";
    }
  } else if (service === "autoscaling") {
    const targetPrefix = (headers.get("X-Amz-Target") || "").split(".")[0];
    if (targetPrefix === "AnyScaleFrontendService") {
      service = "application-autoscaling";
    } else if (targetPrefix === "AnyScaleScalingPlannerFrontendService") {
      service = "autoscaling-plans";
    }
  } else if (region == null && service.startsWith("s3-")) {
    region = service.slice(3).replace(/^fips-|^external-1/, "");
    service = "s3";
  } else if (service.endsWith("-fips")) {
    service = service.slice(0, -5);
  } else if (region && /-\d$/.test(service) && !/-\d$/.test(region)) {
    [service, region] = [region, service];
  }
  return [HOST_SERVICES[service] || service, region || ""];
}
__name(guessServiceRegion, "guessServiceRegion");

// src/index.js
var CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++)
      c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
    t[i] = c;
  }
  return t;
})();
function zipLocalHeader(nameBytes, dosTime, dosDate) {
  const buf = new Uint8Array(30 + nameBytes.length);
  const v = new DataView(buf.buffer);
  v.setUint32(0, 67324752, true);
  v.setUint16(4, 20, true);
  v.setUint16(6, 8, true);
  v.setUint16(8, 0, true);
  v.setUint16(10, dosTime, true);
  v.setUint16(12, dosDate, true);
  v.setUint16(26, nameBytes.length, true);
  buf.set(nameBytes, 30);
  return buf;
}
__name(zipLocalHeader, "zipLocalHeader");
function zipDataDescriptor(crc, size) {
  const buf = new Uint8Array(16);
  const v = new DataView(buf.buffer);
  v.setUint32(0, 134695760, true);
  v.setUint32(4, crc, true);
  v.setUint32(8, size, true);
  v.setUint32(12, size, true);
  return buf;
}
__name(zipDataDescriptor, "zipDataDescriptor");
function zipCentralEntry(nameBytes, dosTime, dosDate, crc, size, localOffset) {
  const buf = new Uint8Array(46 + nameBytes.length);
  const v = new DataView(buf.buffer);
  v.setUint32(0, 33639248, true);
  v.setUint16(4, 20, true);
  v.setUint16(6, 20, true);
  v.setUint16(8, 8, true);
  v.setUint16(10, 0, true);
  v.setUint16(12, dosTime, true);
  v.setUint16(14, dosDate, true);
  v.setUint32(16, crc, true);
  v.setUint32(20, size, true);
  v.setUint32(24, size, true);
  v.setUint16(28, nameBytes.length, true);
  v.setUint32(42, localOffset, true);
  buf.set(nameBytes, 46);
  return buf;
}
__name(zipCentralEntry, "zipCentralEntry");
function zipEndRecord(count, cdSize, cdOffset) {
  const buf = new Uint8Array(22);
  const v = new DataView(buf.buffer);
  v.setUint32(0, 101010256, true);
  v.setUint16(8, count, true);
  v.setUint16(10, count, true);
  v.setUint32(12, cdSize, true);
  v.setUint32(16, cdOffset, true);
  return buf;
}
__name(zipEndRecord, "zipEndRecord");
async function streamZipDownload(env, files, zipName) {
  const { readable, writable } = new IdentityTransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const now = /* @__PURE__ */ new Date();
  const dosTime = now.getHours() << 11 | now.getMinutes() << 5 | Math.floor(now.getSeconds() / 2);
  const dosDate = now.getFullYear() - 1980 << 9 | now.getMonth() + 1 << 5 | now.getDate();
  (async () => {
    try {
      const central = [];
      let offset = 0;
      for (const f of files) {
        const nameBytes = enc.encode(f.filename);
        const localOffset = offset;
        const header = zipLocalHeader(nameBytes, dosTime, dosDate);
        await writer.write(header);
        offset += header.length;
        const obj = await env.BUCKET.get(f.r2_key);
        const crc = f.crc32 >>> 0 || 0;
        let size = 0;
        if (obj) {
          const reader = obj.body.getReader();
          for (; ; ) {
            const { done, value } = await reader.read();
            if (done)
              break;
            size += value.length;
            await writer.write(value);
            offset += value.length;
          }
        }
        const desc = zipDataDescriptor(crc, size);
        await writer.write(desc);
        offset += desc.length;
        central.push({ nameBytes, dosTime, dosDate, crc, size, localOffset });
      }
      const cdOffset = offset;
      for (const e of central) {
        const entry = zipCentralEntry(e.nameBytes, e.dosTime, e.dosDate, e.crc, e.size, e.localOffset);
        await writer.write(entry);
        offset += entry.length;
      }
      await writer.write(zipEndRecord(central.length, offset - cdOffset, cdOffset));
      await writer.close();
    } catch (err) {
      console.error("ZIP stream error:", err.message ?? err);
      try {
        await writer.abort(err);
      } catch {
      }
    }
  })();
  const safeName = zipName.replace(/[^\w\s.-]/g, "_");
  return new Response(readable, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${safeName}.zip"`,
      ...CORS
    }
  });
}
__name(streamZipDownload, "streamZipDownload");
var CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};
var UPLOAD_EXPIRY = 7200;
var DOWNLOAD_EXPIRY = 3600;
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS }
  });
}
__name(json, "json");
function isAdmin(request, env) {
  const auth = request.headers.get("Authorization") || "";
  return auth === `Bearer ${env.ADMIN_SECRET}`;
}
__name(isAdmin, "isAdmin");
function requireAdmin(request, env) {
  if (!isAdmin(request, env))
    return json({ error: "Unauthorized" }, 401);
  return null;
}
__name(requireAdmin, "requireAdmin");
async function hashPassword(password, env) {
  const salt = env.PASSWORD_SALT || "je-review-2026";
  const data = new TextEncoder().encode(salt + password);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(hashPassword, "hashPassword");
async function getPresignedUrl(env, r2Key, method, expireSeconds, disposition) {
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto"
  });
  const url = new URL(
    `https://${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${r2Key}`
  );
  url.searchParams.set("X-Amz-Expires", String(expireSeconds));
  if (disposition)
    url.searchParams.set("response-content-disposition", disposition);
  const signed = await client.sign(new Request(url.toString(), { method }), {
    aws: { signQuery: true, allHeaders: true }
  });
  return signed.url;
}
__name(getPresignedUrl, "getPresignedUrl");
async function handleTransferCreate(request, env) {
  const denied = requireAdmin(request, env);
  if (denied)
    return denied;
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const { filename, filesize, description, password } = body;
  if (!filename || !password)
    return json({ error: "filename and password are required" }, 400);
  const storage = provider(body.storage_provider);
  if (storage === 'homeserver') {
    validateFile(filename, filesize);
    await requireHomeReady(env);
  }
  const id = crypto.randomUUID();
  const r2Key = `transfers/${id}/${storage === "homeserver" ? crypto.randomUUID() : filename}`;
  const passwordHash = await hashPassword(password, env);
  await env.DB.prepare(
    `INSERT INTO transfers (id, filename, filesize, r2_key, password_hash, description, storage_provider)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, filename, filesize ?? null, r2Key, passwordHash, description || null, storage).run();
  if (storage === 'homeserver') await home(env, '/v1/transfers/' + id, 'POST', {});
  const uploadUrl = storage === 'homeserver'
    ? await homeUrl(env, id, r2Key, 'PUT', filename, filesize)
    : await getPresignedUrl(env, r2Key, "PUT", UPLOAD_EXPIRY);
  return json({ id, uploadUrl, storage_provider: storage });
}
__name(handleTransferCreate, "handleTransferCreate");
async function handleTransferInfo(request, env, id) {
  if (isAdmin(request, env)) {
    const row2 = await env.DB.prepare(
      `SELECT id, filename, filesize, total_size, description, created_at, r2_key, storage_provider FROM transfers WHERE id = ?`
    ).bind(id).first();
    if (!row2)
      return json({ error: "Transfer not found" }, 404);
    const { results: files2 } = await env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM transfer_files WHERE transfer_id = ?`
    ).bind(id).all();
    const fileCount2 = files2[0]?.cnt || 0;
    const isMulti2 = fileCount2 > 0 || !row2.r2_key;
    return json({
      id: row2.id,
      storage_provider: row2.storage_provider,
      filename: row2.filename,
      filesize: isMulti2 ? row2.total_size : row2.filesize,
      description: row2.description,
      created_at: row2.created_at,
      is_multi: isMulti2,
      file_count: isMulti2 ? fileCount2 : null
    });
  }
  const url = new URL(request.url);
  const password = url.searchParams.get("password") || "";
  const row = await env.DB.prepare(
    `SELECT id, filename, filesize, total_size, description, created_at, password_hash, r2_key, storage_provider, storage_deleting FROM transfers WHERE id = ?`
  ).bind(id).first();
  if (!row)
    return json({ error: "Transfer not found" }, 404);
  const hash2 = await hashPassword(password, env);
  if (hash2 !== row.password_hash)
    return json({ error: "Invalid password" }, 403);
  if (row.storage_deleting) return json({ error: 'Transfer is being deleted' }, 409);
  const { results: files } = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM transfer_files WHERE transfer_id = ?`
  ).bind(id).all();
  const fileCount = files[0]?.cnt || 0;
  const isMulti = fileCount > 0 || !row.r2_key;
  return json({
    id: row.id,
    filename: row.filename,
    filesize: isMulti ? row.total_size : row.filesize,
    description: row.description,
    created_at: row.created_at,
    is_multi: isMulti,
    file_count: isMulti ? fileCount : null
  });
}
__name(handleTransferInfo, "handleTransferInfo");
async function handleTransferDownload(request, env, id) {
  const url = new URL(request.url);
  const password = url.searchParams.get("password") || "";
  const row = await env.DB.prepare(
    `SELECT filename, r2_key, password_hash, storage_provider, storage_deleting FROM transfers WHERE id = ?`
  ).bind(id).first();
  if (!row)
    return json({ error: "Transfer not found" }, 404);
  const hash2 = await hashPassword(password, env);
  if (hash2 !== row.password_hash)
    return json({ error: "Invalid password" }, 403);
  if (row.storage_deleting) return json({ error: 'Transfer is being deleted' }, 409);
  if (row.storage_provider === 'homeserver') {
    if (!row.r2_key) return json({ error: 'Use the individual file download links for this transfer' }, 400);
    const downloadUrl = await homeUrl(env, id, row.r2_key, 'GET', row.filename);
    return json({ downloadUrl, filename: row.filename });
  }
  const { results: files } = await env.DB.prepare(
    `SELECT filename, r2_key, crc32 FROM transfer_files WHERE transfer_id = ? ORDER BY sort_order ASC`
  ).bind(id).all();
  if (files.length > 0) {
    return streamZipDownload(env, files, row.filename);
  }
  const downloadUrl = await getPresignedUrl(env, row.r2_key, "GET", DOWNLOAD_EXPIRY, `attachment; filename="${row.filename}"`);
  return json({ downloadUrl, filename: row.filename });
}
__name(handleTransferDownload, "handleTransferDownload");
async function handleTransferList(request, env) {
  const denied = requireAdmin(request, env);
  if (denied)
    return denied;
  const { results } = await env.DB.prepare(
    `SELECT t.id, t.filename, t.filesize, t.total_size, t.description, t.created_at, t.storage_provider,
            COUNT(tf.id) AS file_count
     FROM transfers t
     LEFT JOIN transfer_files tf ON tf.transfer_id = t.id
     GROUP BY t.id
     ORDER BY t.created_at DESC`
  ).all();
  return json(results);
}
__name(handleTransferList, "handleTransferList");
async function handleTransferDelete(request, env, id) {
  const denied = requireAdmin(request, env);
  if (denied)
    return denied;
  const row = await env.DB.prepare(`SELECT r2_key, storage_provider FROM transfers WHERE id = ?`).bind(id).first();
  if (!row)
    return json({ error: "Transfer not found" }, 404);
  if (row.storage_provider === 'homeserver') {
    await env.DB.prepare('UPDATE transfers SET storage_deleting = 1 WHERE id = ?').bind(id).run();
    await home(env, '/v1/transfers/' + encodeURIComponent(id), 'DELETE');
    await env.DB.batch([
      env.DB.prepare('DELETE FROM transfer_files WHERE transfer_id = ?').bind(id),
      env.DB.prepare('DELETE FROM transfers WHERE id = ?').bind(id),
    ]);
    return json({ ok: true });
  }
  const { results: files } = await env.DB.prepare(
    `SELECT r2_key FROM transfer_files WHERE transfer_id = ?`
  ).bind(id).all();
  for (const f of files)
    await env.BUCKET.delete(f.r2_key);
  await env.DB.prepare(`DELETE FROM transfer_files WHERE transfer_id = ?`).bind(id).run();
  if (row.r2_key)
    await env.BUCKET.delete(row.r2_key);
  await env.DB.prepare(`DELETE FROM transfers WHERE id = ?`).bind(id).run();
  return json({ ok: true });
}
__name(handleTransferDelete, "handleTransferDelete");
async function handleTransferUpdate(request, env, id) {
  const denied = requireAdmin(request, env);
  if (denied)
    return denied;
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  if (body.storage_provider !== undefined) return json({ error: 'File hosting cannot be changed after creation' }, 400);
  const row = await env.DB.prepare(`SELECT id FROM transfers WHERE id = ?`).bind(id).first();
  if (!row)
    return json({ error: "Transfer not found" }, 404);
  const updates = [];
  const values = [];
  if (body.filename !== void 0) {
    updates.push("filename = ?");
    values.push(body.filename);
  }
  if (body.password) {
    updates.push("password_hash = ?");
    values.push(await hashPassword(body.password, env));
  }
  if (!updates.length)
    return json({ error: "Nothing to update" }, 400);
  values.push(id);
  await env.DB.prepare(`UPDATE transfers SET ${updates.join(", ")} WHERE id = ?`).bind(...values).run();
  return json({ ok: true });
}
__name(handleTransferUpdate, "handleTransferUpdate");
async function handleTransferFileDelete(request, env, id) {
  const denied = requireAdmin(request, env);
  if (denied)
    return denied;
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const { filename } = body;
  if (!filename)
    return json({ error: "filename required" }, 400);
  const file = await env.DB.prepare(
    `SELECT r2_key, filesize FROM transfer_files WHERE transfer_id = ? AND filename = ?`
  ).bind(id, filename).first();
  if (!file)
    return json({ error: "File not found" }, 404);
  const transfer = await env.DB.prepare('SELECT storage_provider FROM transfers WHERE id = ?').bind(id).first();
  if (transfer?.storage_provider === 'homeserver') {
    await home(env, '/v1/transfers/' + encodeURIComponent(id) + '/files/' + encodeURIComponent(file.r2_key.split('/').pop()), 'DELETE');
  } else if (file.r2_key) await env.BUCKET.delete(file.r2_key);
  await env.DB.prepare(`DELETE FROM transfer_files WHERE transfer_id = ? AND filename = ?`).bind(id, filename).run();
  if (file.filesize) {
    await env.DB.prepare(
      `UPDATE transfers SET total_size = MAX(0, COALESCE(total_size, 0) - ?) WHERE id = ?`
    ).bind(file.filesize, id).run();
  }
  return json({ ok: true });
}
__name(handleTransferFileDelete, "handleTransferFileDelete");
async function handleTransferFileCrc(request, env, id) {
  const denied = requireAdmin(request, env);
  if (denied)
    return denied;
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const { filename, crc32 } = body;
  if (!filename || crc32 == null)
    return json({ error: "filename and crc32 required" }, 400);
  await env.DB.prepare(
    `UPDATE transfer_files SET crc32 = ? WHERE transfer_id = ? AND filename = ?`
  ).bind(crc32 >>> 0, id, filename).run();
  return json({ ok: true });
}
__name(handleTransferFileCrc, "handleTransferFileCrc");
async function handleTransferFileList(request, env, id) {
  if (!isAdmin(request, env)) {
    const url = new URL(request.url);
    const password = url.searchParams.get("password") || "";
    const row = await env.DB.prepare(
      `SELECT password_hash FROM transfers WHERE id = ?`
    ).bind(id).first();
    if (!row)
      return json({ error: "Transfer not found" }, 404);
    const hash2 = await hashPassword(password, env);
    if (hash2 !== row.password_hash)
      return json({ error: "Invalid password" }, 403);
  } else {
    const row = await env.DB.prepare(`SELECT id FROM transfers WHERE id = ?`).bind(id).first();
    if (!row)
      return json({ error: "Transfer not found" }, 404);
  }
  const transfer = await env.DB.prepare('SELECT storage_provider, storage_deleting FROM transfers WHERE id = ?').bind(id).first();
  if (transfer.storage_deleting) return json({ error: 'Transfer is being deleted' }, 409);
  const { results: files } = await env.DB.prepare(
    `SELECT filename, filesize, r2_key FROM transfer_files WHERE transfer_id = ? ORDER BY sort_order ASC`
  ).bind(id).all();
  const visibleFiles = transfer.storage_provider === 'homeserver' && !isAdmin(request, env)
    ? await readyFiles(env, id, files) : files;
  const result = await Promise.all(visibleFiles.map(async (f) => {
    const leafName = f.filename.split("/").pop();
    if (transfer.storage_provider === 'homeserver') {
      const url = isAdmin(request, env) ? undefined : await homeUrl(env, id, f.r2_key, 'GET', leafName);
      return { filename: f.filename, filesize: f.filesize, url };
    }
    const downloadUrl = await getPresignedUrl(
      env,
      f.r2_key,
      "GET",
      DOWNLOAD_EXPIRY,
      `attachment; filename="${leafName}"`
    );
    return { filename: f.filename, filesize: f.filesize, url: downloadUrl };
  }));
  return json({ files: result });
}
__name(handleTransferFileList, "handleTransferFileList");
async function handleTransferCreateMulti(request, env) {
  const denied = requireAdmin(request, env);
  if (denied)
    return denied;
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const { name, description, password } = body;
  if (!name || !password)
    return json({ error: "name and password are required" }, 400);
  const storage = provider(body.storage_provider);
  if (storage === 'homeserver') await requireHomeReady(env);
  const id = crypto.randomUUID();
  const passwordHash = await hashPassword(password, env);
  await env.DB.prepare(
    `INSERT INTO transfers (id, filename, filesize, r2_key, password_hash, description, storage_provider)
     VALUES (?, ?, NULL, '', ?, ?, ?)`
  ).bind(id, name, passwordHash, description || null, storage).run();
  if (storage === 'homeserver') await home(env, '/v1/transfers/' + id, 'POST', {});
  return json({ id, storage_provider: storage });
}
__name(handleTransferCreateMulti, "handleTransferCreateMulti");
async function handleTransferAddFile(request, env, id) {
  const denied = requireAdmin(request, env);
  if (denied)
    return denied;
  const transfer = await env.DB.prepare(`SELECT id, storage_provider, storage_deleting FROM transfers WHERE id = ?`).bind(id).first();
  if (!transfer)
    return json({ error: "Transfer not found" }, 404);
  if (transfer.storage_deleting) return json({ error: 'Transfer is being deleted' }, 409);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const { filename, filesize, sort_order } = body;
  if (!filename)
    return json({ error: "filename required" }, 400);
  const storage = transfer.storage_provider;
  if (storage === 'homeserver') {
    validateFile(filename, filesize);
    const existing = await env.DB.prepare('SELECT id FROM transfer_files WHERE transfer_id = ? AND filename = ?').bind(id, filename).first();
    if (existing) return json({ error: 'A file with that name already exists' }, 409);
  }
  const r2Key = `transfers/${id}/${storage === 'homeserver' ? crypto.randomUUID() : filename}`;
  if (storage === 'homeserver') {
    const registered = await env.DB.batch([
      env.DB.prepare(`INSERT INTO transfer_files (transfer_id, filename, r2_key, filesize, sort_order)
        SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM transfers WHERE id = ? AND storage_deleting = 0)
        AND NOT EXISTS (SELECT 1 FROM transfer_files WHERE transfer_id = ? AND filename = ?)`)
        .bind(id, filename, r2Key, filesize, sort_order ?? 0, id, id, filename),
      env.DB.prepare(`UPDATE transfers SET total_size = COALESCE(total_size, 0) + ?
        WHERE id = ? AND EXISTS (SELECT 1 FROM transfer_files WHERE transfer_id = ? AND r2_key = ?)`)
        .bind(filesize, id, id, r2Key),
    ]);
    if (!registered[0].meta.changes) return json({ error: 'Transfer is being deleted or filename already exists' }, 409);
  } else {
    await env.DB.prepare(
    `INSERT INTO transfer_files (transfer_id, filename, r2_key, filesize, sort_order)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(id, filename, r2Key, filesize ?? null, sort_order ?? 0).run();
  await env.DB.prepare(
    `UPDATE transfers SET total_size = COALESCE(total_size, 0) + ? WHERE id = ?`
  ).bind(filesize || 0, id).run();
  }
  const uploadUrl = storage === 'homeserver'
    ? await homeUrl(env, id, r2Key, 'PUT', filename, filesize)
    : await getPresignedUrl(env, r2Key, "PUT", UPLOAD_EXPIRY);
  return json({ uploadUrl, storage_provider: storage });
}
__name(handleTransferAddFile, "handleTransferAddFile");
async function handleMultipartCreate(request, env) {
  const denied = requireAdmin(request, env);
  if (denied)
    return denied;
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  await requireCloudflareKey(env, body.key);
  const { key } = body;
  if (!key)
    return json({ error: "key is required" }, 400);
  const mpu = await env.BUCKET.createMultipartUpload(key);
  return json({ uploadId: mpu.uploadId, key: mpu.key });
}
__name(handleMultipartCreate, "handleMultipartCreate");
async function handleMultipartPresignPart(request, env) {
  const denied = requireAdmin(request, env);
  if (denied)
    return denied;
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  await requireCloudflareKey(env, body.key);
  const { key, uploadId, partNumber } = body;
  if (!key || !uploadId || partNumber == null)
    return json({ error: "key, uploadId, and partNumber are required" }, 400);
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto"
  });
  const url = new URL(
    `https://${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${key}`
  );
  url.searchParams.set("X-Amz-Expires", String(UPLOAD_EXPIRY));
  url.searchParams.set("partNumber", String(partNumber));
  url.searchParams.set("uploadId", uploadId);
  const signed = await client.sign(new Request(url.toString(), { method: "PUT" }), {
    aws: { signQuery: true, allHeaders: true }
  });
  return json({ url: signed.url });
}
__name(handleMultipartPresignPart, "handleMultipartPresignPart");
async function handleMultipartComplete(request, env) {
  const denied = requireAdmin(request, env);
  if (denied)
    return denied;
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  await requireCloudflareKey(env, body.key);
  const { key, uploadId, parts } = body;
  if (!key || !uploadId || !Array.isArray(parts))
    return json({ error: "key, uploadId, and parts are required" }, 400);
  const sanitizedParts = parts.map((p) => ({
    partNumber: Number(p.partNumber),
    etag: String(p.etag).replace(/^"|"$/g, "")
  }));
  try {
    const mpu = env.BUCKET.resumeMultipartUpload(key, uploadId);
    await mpu.complete(sanitizedParts);
  } catch (err) {
    console.error("multipart complete failed:", err);
    return json({ error: err.message || "Failed to complete multipart upload" }, 500);
  }
  return json({ ok: true });
}
__name(handleMultipartComplete, "handleMultipartComplete");
async function handleMultipartAbort(request, env) {
  const denied = requireAdmin(request, env);
  if (denied)
    return denied;
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  await requireCloudflareKey(env, body.key);
  const { key, uploadId } = body;
  if (!key || !uploadId)
    return json({ error: "key and uploadId are required" }, 400);
  const mpu = env.BUCKET.resumeMultipartUpload(key, uploadId);
  await mpu.abort();
  return json({ ok: true });
}
__name(handleMultipartAbort, "handleMultipartAbort");
async function handleReviewCreate(request, env) {
  const denied = requireAdmin(request, env);
  if (denied)
    return denied;
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const { name, password } = body;
  if (!name || !password)
    return json({ error: "name and password are required" }, 400);
  const id = crypto.randomUUID();
  const passwordHash = await hashPassword(password, env);
  await env.DB.prepare(
    `INSERT INTO reviews (id, name, password_hash) VALUES (?, ?, ?)`
  ).bind(id, name, passwordHash).run();
  return json({ id });
}
__name(handleReviewCreate, "handleReviewCreate");
async function handleReviewList(request, env) {
  const denied = requireAdmin(request, env);
  if (denied)
    return denied;
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.name, r.created_at,
            COUNT(v.stream_uid) AS video_count
     FROM reviews r
     LEFT JOIN videos v ON v.review_id = r.id
     GROUP BY r.id
     ORDER BY r.created_at DESC`
  ).all();
  return json(results);
}
__name(handleReviewList, "handleReviewList");
async function handleReviewInfo(request, env, id) {
  if (isAdmin(request, env)) {
    const row2 = await env.DB.prepare(
      `SELECT id, name, created_at FROM reviews WHERE id = ?`
    ).bind(id).first();
    if (!row2)
      return json({ error: "Review not found" }, 404);
    return json(row2);
  }
  const url = new URL(request.url);
  const password = url.searchParams.get("password") || "";
  const row = await env.DB.prepare(
    `SELECT id, name, created_at, password_hash FROM reviews WHERE id = ?`
  ).bind(id).first();
  if (!row)
    return json({ error: "Review not found" }, 404);
  const hash2 = await hashPassword(password, env);
  if (hash2 !== row.password_hash)
    return json({ error: "Invalid ID or password." }, 403);
  return json({ id: row.id, name: row.name, created_at: row.created_at });
}
__name(handleReviewInfo, "handleReviewInfo");
async function handleReviewUpdate(request, env, id) {
  const denied = requireAdmin(request, env);
  if (denied)
    return denied;
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const row = await env.DB.prepare(`SELECT id FROM reviews WHERE id = ?`).bind(id).first();
  if (!row)
    return json({ error: "Review not found" }, 404);
  const updates = [];
  const values = [];
  if (body.name) {
    updates.push("name = ?");
    values.push(body.name);
  }
  if (body.password) {
    updates.push("password_hash = ?");
    values.push(await hashPassword(body.password, env));
  }
  if (!updates.length)
    return json({ error: "Nothing to update" }, 400);
  values.push(id);
  await env.DB.prepare(`UPDATE reviews SET ${updates.join(", ")} WHERE id = ?`).bind(...values).run();
  return json({ ok: true });
}
__name(handleReviewUpdate, "handleReviewUpdate");
async function handleReviewDelete(request, env, id) {
  const denied = requireAdmin(request, env);
  if (denied)
    return denied;
  const { results: videos } = await env.DB.prepare(
    `SELECT stream_uid FROM videos WHERE review_id = ?`
  ).bind(id).all();
  for (const v of videos) {
    await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/stream/${v.stream_uid}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${env.STREAM_API_TOKEN}` } }
    );
    await env.DB.prepare(`DELETE FROM comments WHERE video_id = ?`).bind(v.stream_uid).run();
    await env.DB.prepare(`DELETE FROM videos WHERE stream_uid = ?`).bind(v.stream_uid).run();
  }
  await env.DB.prepare(`DELETE FROM reviews WHERE id = ?`).bind(id).run();
  return json({ ok: true });
}
__name(handleReviewDelete, "handleReviewDelete");
async function handleReviewVideos(request, env, id) {
  if (!isAdmin(request, env)) {
    const url = new URL(request.url);
    const password = url.searchParams.get("password") || "";
    const row = await env.DB.prepare(
      `SELECT password_hash FROM reviews WHERE id = ?`
    ).bind(id).first();
    if (!row)
      return json({ error: "Review not found" }, 404);
    const hash2 = await hashPassword(password, env);
    if (hash2 !== row.password_hash)
      return json({ error: "Invalid password" }, 403);
  }
  const { results } = await env.DB.prepare(
    `SELECT stream_uid, title, description, created_at
     FROM videos WHERE review_id = ? ORDER BY created_at ASC`
  ).bind(id).all();
  return json(results);
}
__name(handleReviewVideos, "handleReviewVideos");
function b64utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes)
    bin += String.fromCharCode(b);
  return btoa(bin);
}
__name(b64utf8, "b64utf8");
async function handleStreamUploadCreate(request, env) {
  const denied = requireAdmin(request, env);
  if (denied)
    return denied;
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const { title, description, review_id, filesize } = body;
  if (!title)
    return json({ error: "title is required" }, 400);
  if (!review_id)
    return json({ error: "review_id is required" }, 400);
  if (!filesize || filesize <= 0)
    return json({ error: "filesize is required" }, 400);
  const reviewRow = await env.DB.prepare(`SELECT id FROM reviews WHERE id = ?`).bind(review_id).first();
  if (!reviewRow)
    return json({ error: "Review not found" }, 404);
  const uploadMetadata = `name ${b64utf8(title)},maxDurationSeconds ${b64utf8("7200")}`;
  const resp = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/stream?direct_user=true`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.STREAM_API_TOKEN}`,
        "Tus-Resumable": "1.0.0",
        "Upload-Length": String(filesize),
        "Upload-Metadata": uploadMetadata
      }
    }
  );
  if (!resp.ok) {
    const text = await resp.text();
    return json({ error: "Stream API error", detail: text }, 502);
  }
  const uploadUrl = resp.headers.get("Location");
  const streamUid = resp.headers.get("stream-media-id");
  if (!uploadUrl || !streamUid) {
    return json({ error: "Stream API did not return an upload URL" }, 502);
  }
  await env.DB.prepare(
    `INSERT INTO videos (stream_uid, title, description, review_id) VALUES (?, ?, ?, ?)`
  ).bind(streamUid, title, description || null, review_id).run();
  return json({ uploadUrl, streamUid });
}
__name(handleStreamUploadCreate, "handleStreamUploadCreate");
async function handleStreamVideoList(request, env) {
  const denied = requireAdmin(request, env);
  if (denied)
    return denied;
  const { results } = await env.DB.prepare(
    `SELECT stream_uid, title, description, review_id, created_at FROM videos ORDER BY created_at DESC`
  ).all();
  return json(results);
}
__name(handleStreamVideoList, "handleStreamVideoList");
async function handleStreamVideoUpdate(request, env, streamUid) {
  const denied = requireAdmin(request, env);
  if (denied)
    return denied;
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const { title, description } = body;
  if (!title)
    return json({ error: "title is required" }, 400);
  await env.DB.prepare(
    `UPDATE videos SET title = ?, description = ? WHERE stream_uid = ?`
  ).bind(title.trim(), description?.trim() || null, streamUid).run();
  return json({ ok: true });
}
__name(handleStreamVideoUpdate, "handleStreamVideoUpdate");
async function handleStreamVideoDelete(request, env, streamUid) {
  const denied = requireAdmin(request, env);
  if (denied)
    return denied;
  await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/stream/${streamUid}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${env.STREAM_API_TOKEN}` }
    }
  );
  await env.DB.prepare(`DELETE FROM comments WHERE video_id = ?`).bind(streamUid).run();
  await env.DB.prepare(`DELETE FROM videos WHERE stream_uid = ?`).bind(streamUid).run();
  return json({ ok: true });
}
__name(handleStreamVideoDelete, "handleStreamVideoDelete");
async function handleCommentCreate(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const { video_id, timestamp_seconds, author, text } = body;
  if (!video_id || timestamp_seconds == null || !text) {
    return json({ error: "video_id, timestamp_seconds, and text are required" }, 400);
  }
  const { meta } = await env.DB.prepare(
    `INSERT INTO comments (video_id, timestamp_seconds, author, body) VALUES (?, ?, ?, ?)`
  ).bind(video_id, Number(timestamp_seconds), author?.trim() || "Anonymous", text.trim()).run();
  return json({ id: meta.last_row_id }, 201);
}
__name(handleCommentCreate, "handleCommentCreate");
async function handleCommentList(request, env, videoId) {
  const { results } = await env.DB.prepare(
    `SELECT id, timestamp_seconds, author, body, created_at
     FROM comments WHERE video_id = ? ORDER BY timestamp_seconds ASC`
  ).bind(videoId).all();
  return json(results);
}
__name(handleCommentList, "handleCommentList");
async function handleCommentDelete(request, env, id) {
  const denied = requireAdmin(request, env);
  if (denied)
    return denied;
  await env.DB.prepare(`DELETE FROM comments WHERE id = ?`).bind(Number(id)).run();
  return json({ ok: true });
}
__name(handleCommentDelete, "handleCommentDelete");
var src_default = {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    const { pathname } = new URL(request.url);
    const method = request.method;
    try {
      if (pathname === "/health" && method === "GET") {
        return json({ ok: true });
      }
      if (pathname === '/api/transfer/capabilities' && method === 'GET') {
        const denied = requireAdmin(request, env);
        if (denied) return denied;
        const storage_providers = ['cloudflare'];
        try { const health = await home(env, '/v1/health'); if (health.ready === true) storage_providers.push('homeserver'); } catch {}
        const response = json({ storage_providers });
        response.headers.set('Cache-Control', 'no-store');
        return response;
      }
      if (pathname === "/api/transfer/create" && method === "POST") {
        return await handleTransferCreate(request, env);
      }
      if (pathname === "/api/transfer/create-multi" && method === "POST") {
        return await handleTransferCreateMulti(request, env);
      }
      if (pathname === "/api/transfer/multipart/create" && method === "POST") {
        return await handleMultipartCreate(request, env);
      }
      if (pathname === "/api/transfer/multipart/presign-part" && method === "POST") {
        return await handleMultipartPresignPart(request, env);
      }
      if (pathname === "/api/transfer/multipart/complete" && method === "POST") {
        return await handleMultipartComplete(request, env);
      }
      if (pathname === "/api/transfer/multipart/abort" && method === "POST") {
        return await handleMultipartAbort(request, env);
      }
      if (pathname === "/api/transfers" && method === "GET") {
        return await handleTransferList(request, env);
      }
      const xferMatch = pathname.match(/^\/api\/transfer\/([^/]+)(\/download)?$/);
      if (xferMatch) {
        const [, id, sub] = xferMatch;
        if (method === "GET") {
          return sub === "/download" ? await handleTransferDownload(request, env, id) : await handleTransferInfo(request, env, id);
        }
        if (method === "PATCH")
          return await handleTransferUpdate(request, env, id);
        if (method === "DELETE")
          return await handleTransferDelete(request, env, id);
      }
      const xferFileMatch = pathname.match(/^\/api\/transfer\/([^/]+)\/add-file$/);
      if (xferFileMatch && method === "POST") {
        return await handleTransferAddFile(request, env, xferFileMatch[1]);
      }
      const xferSingleFileDeleteMatch = pathname.match(/^\/api\/transfer\/([^/]+)\/file$/);
      if (xferSingleFileDeleteMatch && method === "DELETE") {
        return await handleTransferFileDelete(request, env, xferSingleFileDeleteMatch[1]);
      }
      const xferCrcMatch = pathname.match(/^\/api\/transfer\/([^/]+)\/file-crc$/);
      if (xferCrcMatch && method === "PATCH") {
        return await handleTransferFileCrc(request, env, xferCrcMatch[1]);
      }
      const xferFilesListMatch = pathname.match(/^\/api\/transfer\/([^/]+)\/files$/);
      if (xferFilesListMatch && method === "GET") {
        return await handleTransferFileList(request, env, xferFilesListMatch[1]);
      }
      if (pathname === "/api/review/create" && method === "POST") {
        return await handleReviewCreate(request, env);
      }
      if (pathname === "/api/reviews" && method === "GET") {
        return await handleReviewList(request, env);
      }
      const reviewMatch = pathname.match(/^\/api\/review\/([^/]+)(\/videos)?$/);
      if (reviewMatch) {
        const [, rid, sub] = reviewMatch;
        if (method === "GET") {
          return sub === "/videos" ? await handleReviewVideos(request, env, rid) : await handleReviewInfo(request, env, rid);
        }
        if (method === "PATCH")
          return await handleReviewUpdate(request, env, rid);
        if (method === "DELETE")
          return await handleReviewDelete(request, env, rid);
      }
      if (pathname === "/api/stream/upload" && method === "POST") {
        return await handleStreamUploadCreate(request, env);
      }
      if (pathname === "/api/stream/videos" && method === "GET") {
        return await handleStreamVideoList(request, env);
      }
      const streamMatch = pathname.match(/^\/api\/stream\/([^/]+)$/);
      if (streamMatch) {
        if (method === "PATCH")
          return await handleStreamVideoUpdate(request, env, streamMatch[1]);
        if (method === "DELETE")
          return await handleStreamVideoDelete(request, env, streamMatch[1]);
      }
      if (pathname === "/api/comments" && method === "POST") {
        return await handleCommentCreate(request, env);
      }
      const commentMatch = pathname.match(/^\/api\/comments\/([^/]+)$/);
      if (commentMatch) {
        const id = commentMatch[1];
        if (method === "GET")
          return await handleCommentList(request, env, id);
        if (method === "DELETE")
          return await handleCommentDelete(request, env, id);
      }
      return json({ error: "Not found" }, 404);
    } catch (err) {
      if (err instanceof StorageError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: "Internal server error" }, 500);
    }
  }
};
export {
  src_default as default
};
/*! Bundled license information:

aws4fetch/dist/aws4fetch.esm.mjs:
  (**
   * @license MIT <https://opensource.org/licenses/MIT>
   * @copyright Michael Hart 2024
   *)
*/
