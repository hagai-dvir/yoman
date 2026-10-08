// The encrypted store. While unlocked, decrypted records live in memory only; on lock they are dropped.
import * as db from './db.js';
import * as C from './crypto.js';

export const AUDIO_DAYS = 30;
const DAY_MS = 86400000;

export const vault = {
  key: null,
  entries: new Map(),
  photos: new Map(),
  summaries: new Map(),
  audio: new Map(), // id -> plain meta { id, entryId, createdAt, keep, size }
  urls: new Map(),  // blob id -> object URL cache
};

export const isUnlocked = () => !!vault.key;
export const uid = () => Date.now().toString(36) + '-' + C.toB64(C.rand(9)).replace(/[+/=]/g, '').slice(0, 10);

// ---------- settings & diagnostics (plain, no content) ----------
const DEFAULT_SETTINGS = { autolockMin: 3, recordAudio: true, inputMode: 'auto', lastBackupAt: 0, speechFallback: null,
  carMode: false, endPhrase: 'סיום הקלטה', silenceStopSec: 0, spokenCues: true, micDeviceId: '', ttsRate: 1 };
export async function getSettings() {
  const s = await db.get('meta', 'settings');
  return { ...DEFAULT_SETTINGS, ...(s || {}) };
}
export async function setSettings(patch) {
  const s = await getSettings();
  const next = { ...s, ...patch, id: 'settings' };
  await db.put('meta', next);
  return next;
}
export async function log(ev, detail = '') {
  try {
    const l = (await db.get('meta', 'log')) || { id: 'log', items: [] };
    l.items.push({ t: Date.now(), ev, detail: String(detail).slice(0, 120) });
    if (l.items.length > 200) l.items = l.items.slice(-200);
    await db.put('meta', l);
  } catch (e) { /* diagnostics must never break the app */ }
}
export async function getLog() {
  return ((await db.get('meta', 'log')) || { items: [] }).items;
}

// ---------- vault lifecycle ----------
export async function hasVault() {
  return !!(await db.get('meta', 'vault'));
}
export async function prfInfo() {
  return db.get('meta', 'prf');
}

export async function createVault(password) {
  const salt = C.rand(16);
  const kek = await C.kekFromPassword(password, salt);
  const dek = await C.newDek();
  const wrapped = await C.wrapDek(dek, kek);
  await db.put('meta', { id: 'vault', v: 1, salt, iter: C.PBKDF2_ITER, wrapped, created: Date.now() });
  await loadWithKey(dek);
}

export async function unlockWithPassword(password) {
  const m = await db.get('meta', 'vault');
  const kek = await C.kekFromPassword(password, m.salt, m.iter);
  let dek;
  try { dek = await C.unwrapDek(m.wrapped, kek); } catch (e) { throw Object.assign(new Error('bad-password'), { code: 'bad-password' }); }
  await loadWithKey(dek);
}

export async function unlockWithPrf(prf) {
  const p = await db.get('meta', 'prf');
  const kek = await C.kekFromPrf(prf, p.hkdfSalt);
  const dek = await C.unwrapDek(p.wrapped, kek);
  await loadWithKey(dek);
}

export async function enrollPrf({ credId, prfSalt, prf, path, enabledFlag }) {
  const hkdfSalt = C.rand(16);
  const kek = await C.kekFromPrf(prf, hkdfSalt);
  const wrapped = await C.wrapDek(vault.key, kek);
  await db.put('meta', { id: 'prf', credId, prfSalt, hkdfSalt, wrapped, path, enabledFlag, created: Date.now() });
}
export const removePrf = () => db.del('meta', 'prf');

export async function changePassword(oldPw, newPw) {
  const m = await db.get('meta', 'vault');
  const oldKek = await C.kekFromPassword(oldPw, m.salt, m.iter);
  try { await C.unwrapDek(m.wrapped, oldKek); } catch (e) { throw Object.assign(new Error('bad-password'), { code: 'bad-password' }); }
  const salt = C.rand(16);
  const kek = await C.kekFromPassword(newPw, salt);
  await db.put('meta', { ...m, salt, iter: C.PBKDF2_ITER, wrapped: await C.wrapDek(vault.key, kek) });
}

async function loadWithKey(dek) {
  vault.key = dek;
  vault.entries.clear(); vault.photos.clear(); vault.summaries.clear(); vault.audio.clear();
  for (const r of await db.getAll('entries')) vault.entries.set(r.id, await C.decryptJSON(dek, r.enc, 'entries:' + r.id));
  for (const r of await db.getAll('photos')) vault.photos.set(r.id, await C.decryptJSON(dek, r.enc, 'photos:' + r.id));
  for (const r of await db.getAll('summaries')) vault.summaries.set(r.id, await C.decryptJSON(dek, r.enc, 'summaries:' + r.id));
  for (const r of await db.getAll('audio')) vault.audio.set(r.id, { id: r.id, entryId: r.entryId, createdAt: r.createdAt, keep: r.keep, size: r.size });
  await purgeAudio();
  await ensureInboxKeys();
}

// ---------- quick-capture inbox (write while locked, read only after unlock) ----------
// The public key is stored in the clear so a locked diary can seal new recordings to it.
// The private key is stored only encrypted under the data key. A copy of the public key is also kept
// inside the encrypted record, so a swapped public key (someone with access to the device storage)
// is detected on the next unlock and replaced.
async function ensureInboxKeys() {
  const pub = await db.get('meta', 'inbox-pub');
  const sec = await db.get('meta', 'inbox-sec');
  if (pub && sec) {
    const s = await C.decryptJSON(vault.key, sec.enc, 'meta:inbox-sec');
    if (JSON.stringify(s.publicJwk) === JSON.stringify(pub.jwk)) return;
    await log('inbox-key-mismatch', 'public key changed outside the app; replaced');
  }
  const kp = await C.newInboxKeyPair();
  await db.put('meta', { id: 'inbox-sec', enc: await C.encryptJSON(vault.key, { publicJwk: kp.publicJwk, privateB64: C.toB64(kp.privatePkcs8) }, 'meta:inbox-sec') });
  await db.put('meta', { id: 'inbox-pub', jwk: kp.publicJwk, created: Date.now() });
}

export async function hasInboxKey() {
  return !!(await db.get('meta', 'inbox-pub'));
}

export async function inboxCount() {
  return (await db.getAll('inbox')).length;
}

// payload: { createdAt, durationSec, segments, restarts, via, audioMime? }  audioBlob optional.
export async function addToInbox(payload, audioBlob) {
  const pub = await db.get('meta', 'inbox-pub');
  if (!pub) throw Object.assign(new Error('no-inbox-key'), { code: 'no-inbox-key' });
  const id = uid();
  const parts = [C.utf8.enc(JSON.stringify(payload))];
  if (audioBlob) parts.push(new Uint8Array(await audioBlob.arrayBuffer()));
  const box = await C.seal(pub.jwk, parts, 'inbox:' + id);
  await db.put('inbox', { id, createdAt: payload.createdAt, box });
  return id;
}

// After unlock: open every inbox item, hand it to makeEntry(payload, audio), then delete it.
export async function drainInbox(makeEntry) {
  const items = await db.getAll('inbox');
  if (!items.length) return 0;
  const sec = await C.decryptJSON(vault.key, (await db.get('meta', 'inbox-sec')).enc, 'meta:inbox-sec');
  const priv = C.fromB64(sec.privateB64);
  let n = 0;
  for (const it of items) {
    try {
      const [json, audio] = await C.unseal(priv, it.box, 'inbox:' + it.id);
      await makeEntry(JSON.parse(C.utf8.dec(json)), audio || null);
      await db.del('inbox', it.id);
      n++;
    } catch (e) {
      await log('inbox-open-failed', e.name || e.message); // kept for a later attempt, never silently dropped
    }
  }
  return n;
}

export function lock() {
  vault.key = null;
  vault.entries.clear(); vault.photos.clear(); vault.summaries.clear(); vault.audio.clear();
  for (const u of vault.urls.values()) URL.revokeObjectURL(u);
  vault.urls.clear();
}

// ---------- records ----------
async function putEnc(store, obj) {
  await db.put(store, { id: obj.id, enc: await C.encryptJSON(vault.key, obj, store + ':' + obj.id) });
}

export async function saveEntry(e) { vault.entries.set(e.id, e); await putEnc('entries', e); }
export async function saveSummary(s) { vault.summaries.set(s.id, s); await putEnc('summaries', s); }
export async function deleteSummary(id) { vault.summaries.delete(id); await db.del('summaries', id); }

export async function deleteEntry(id) {
  const e = vault.entries.get(id);
  if (!e) return;
  const pids = new Set(e.photoIds || []);
  for (const p of vault.photos.values()) if (p.entryId === id) pids.add(p.id);
  for (const pid of pids) await deletePhoto(pid);
  if (e.audioId) await deleteAudio(e.audioId);
  vault.entries.delete(id);
  await db.del('entries', id);
}

// ---------- binary blobs ----------
async function putBlob(id, bytes) {
  await db.put('blobs', { id, enc: await C.encryptBytes(vault.key, bytes, 'blobs:' + id) });
}
export async function blobUrl(id, type = 'image/jpeg') {
  if (vault.urls.has(id)) return vault.urls.get(id);
  const r = await db.get('blobs', id);
  if (!r) return null;
  const bytes = await C.decryptBytes(vault.key, r.enc, 'blobs:' + id);
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  vault.urls.set(id, url);
  return url;
}
export async function blobBytes(id) {
  const r = await db.get('blobs', id);
  return r ? C.decryptBytes(vault.key, r.enc, 'blobs:' + id) : null;
}

export async function savePhoto(meta, fullBlob, thumbBlob) {
  const id = meta.id || uid();
  const p = { ...meta, id, blobId: id + '-f', thumbId: id + '-t' };
  await putBlob(p.blobId, new Uint8Array(await fullBlob.arrayBuffer()));
  await putBlob(p.thumbId, new Uint8Array(await thumbBlob.arrayBuffer()));
  vault.photos.set(id, p);
  await putEnc('photos', p);
  return p;
}
export async function deletePhoto(id) {
  const p = vault.photos.get(id);
  if (p) { await db.del('blobs', p.blobId); await db.del('blobs', p.thumbId); }
  vault.photos.delete(id);
  await db.del('photos', id);
}

// ---------- audio (kept 30 days unless "keep forever") ----------
export async function saveAudio(entryId, blob, mime) {
  const id = uid();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const meta = { id, entryId, createdAt: Date.now(), keep: false, size: bytes.length };
  await db.put('audio', { ...meta, enc: await C.encryptJSON(vault.key, { mime }, 'audio-meta:' + id) });
  await putBlob('audio-' + id, bytes);
  vault.audio.set(id, meta);
  return { id, mime };
}
export async function audioUrl(id, mime) { return blobUrl('audio-' + id, mime || 'audio/webm'); }
export async function setAudioKeep(id, keep) {
  const r = await db.get('audio', id);
  if (!r) return;
  r.keep = keep;
  await db.put('audio', r);
  vault.audio.get(id).keep = keep;
}
export async function deleteAudio(id) {
  await db.del('blobs', 'audio-' + id);
  await db.del('audio', id);
  vault.audio.delete(id);
}
export async function purgeAudio(now = Date.now()) {
  let n = 0;
  for (const a of [...vault.audio.values()]) {
    if (!a.keep && now - a.createdAt > AUDIO_DAYS * DAY_MS) { await deleteAudio(a.id); n++; }
  }
  if (n) await log('audio-purged', String(n));
  return n;
}
export const audioExpiry = (a) => a.createdAt + AUDIO_DAYS * DAY_MS;

// ---------- backup ----------
export async function exportBackup(password) {
  const blobs = {};
  for (const r of await db.getAll('blobs')) blobs[r.id] = C.toB64(await C.decryptBytes(vault.key, r.enc, 'blobs:' + r.id));
  const audio = [];
  for (const r of await db.getAll('audio')) {
    const m = await C.decryptJSON(vault.key, r.enc, 'audio-meta:' + r.id);
    audio.push({ id: r.id, entryId: r.entryId, createdAt: r.createdAt, keep: r.keep, size: r.size, mime: m.mime });
  }
  const payload = {
    app: 'hamesader', v: 1, exportedAt: Date.now(),
    entries: [...vault.entries.values()],
    photos: [...vault.photos.values()],
    summaries: [...vault.summaries.values()],
    audio, blobs,
  };
  const z = await C.gzip(C.utf8.enc(JSON.stringify(payload)));
  const salt = C.rand(16);
  const key = await C.kekFromPassword(password, salt);
  const box = await C.encryptBytes(key, z.data, 'hamesader-backup-v1');
  const file = {
    format: 'hamesader-backup', v: 1, gz: z.gz,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iter: C.PBKDF2_ITER, salt: C.toB64(salt) },
    iv: C.toB64(box.iv), data: C.toB64(box.ct),
  };
  return new Blob([JSON.stringify(file)], { type: 'application/json' });
}

export async function readBackup(text, password) {
  let file;
  try { file = JSON.parse(text); } catch (e) { throw Object.assign(new Error('not-backup'), { code: 'not-backup' }); }
  if (file.format !== 'hamesader-backup') throw Object.assign(new Error('not-backup'), { code: 'not-backup' });
  const key = await C.kekFromPassword(password, C.fromB64(file.kdf.salt), file.kdf.iter);
  let bytes;
  try { bytes = await C.decryptBytes(key, { iv: C.fromB64(file.iv), ct: C.fromB64(file.data) }, 'hamesader-backup-v1'); }
  catch (e) { throw Object.assign(new Error('bad-password'), { code: 'bad-password' }); }
  if (file.gz) bytes = await C.gunzip(bytes);
  return JSON.parse(C.utf8.dec(bytes));
}

// mode: 'replace' wipes current records first; 'merge' keeps them and adds/overwrites by id.
export async function importBackup(payload, mode = 'merge') {
  const key = vault.key;
  if (!key) throw new Error('locked');
  if (mode === 'replace') {
    for (const s of ['entries', 'photos', 'blobs', 'audio', 'summaries']) await db.clear(s);
    for (const u of vault.urls.values()) URL.revokeObjectURL(u);
    vault.urls.clear();
  }
  for (const e of payload.entries || []) await putEnc('entries', e);
  for (const p of payload.photos || []) await putEnc('photos', p);
  for (const s of payload.summaries || []) await putEnc('summaries', s);
  for (const [id, b64] of Object.entries(payload.blobs || {})) await putBlob(id, C.fromB64(b64));
  for (const a of payload.audio || []) {
    await db.put('audio', { id: a.id, entryId: a.entryId, createdAt: a.createdAt, keep: a.keep, size: a.size,
      enc: await C.encryptJSON(key, { mime: a.mime }, 'audio-meta:' + a.id) });
  }
  await loadWithKey(key);
}

export async function storageInfo() {
  const out = { persisted: null, usage: null, quota: null };
  try {
    if (navigator.storage && navigator.storage.persisted) out.persisted = await navigator.storage.persisted();
    if (navigator.storage && navigator.storage.estimate) { const e = await navigator.storage.estimate(); out.usage = e.usage; out.quota = e.quota; }
  } catch (e) { /* ignore */ }
  return out;
}
export async function requestPersist() {
  try { return navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : null; } catch (e) { return null; }
}

// ---------- writing draft (encrypted, autosaved while typing) ----------
export async function saveDraft(draft) {
  await db.put('meta', { id: 'draft', enc: await C.encryptJSON(vault.key, { ...draft, savedAt: Date.now() }, 'meta:draft') });
}
export async function getDraft() {
  const r = await db.get('meta', 'draft');
  return r ? C.decryptJSON(vault.key, r.enc, 'meta:draft') : null;
}
export const clearDraft = () => db.del('meta', 'draft');