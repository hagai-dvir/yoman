// "מחיקת נתונים" (1.6.4): list what is stored, choose by kind / dates / single recordings, delete for real.
// Never touches the password wrapping ('vault'), the biometric wrapping ('prf'), the settings or the
// quick-capture keys: they live in 'meta' under their own ids and are not part of any kind below.
// Deleting one kind keeps the others and their links: an entry whose voice was deleted keeps its text
// and is marked audioDeletedAt; an entry is removed as a whole only when nothing is left in it.
import * as db from './db.js';
import * as V from './vault.js';
import { vault } from './vault.js';
import * as S from './summaries.js';

export const TYPES = [
  { key: 'raw', label: 'מה שאמרתי: תמלולים וכתיבות גולמיים', unit: 'הקלטות', one: 'הקלטה אחת', entry: true },
  { key: 'tidy', label: 'מסודר לפרסום: הגרסאות הערוכות והכותרות', unit: 'הקלטות', one: 'הקלטה אחת', entry: true },
  { key: 'audio', label: 'הקלטות קול', unit: 'קבצי קול', one: 'קובץ קול אחד', entry: true },
  { key: 'photos', label: 'תמונות, יחד עם המיקום שלהן', unit: 'תמונות', one: 'תמונה אחת', entry: true },
  { key: 'locations', label: 'מיקומים בלבד (התמונות נשארות)', unit: 'מיקומים', one: 'מיקום אחד', entry: true },
  { key: 'summaries', label: 'סיכומים ותקצירים שמורים', unit: 'סיכומים', one: 'סיכום אחד' },
  { key: 'pending', label: 'הקלטות מהירות או קטועות שממתינות להיכנס ליומן', unit: 'הקלטות', one: 'הקלטה אחת' },
  { key: 'draft', label: 'טיוטת כתיבה שלא נשמרה', unit: 'טיוטות', one: 'טיוטה אחת' },
  { key: 'log', label: 'יומן אבחון טכני (בלי טקסט שלך)', unit: 'שורות', one: 'שורה אחת' },
];
export const TYPE = Object.fromEntries(TYPES.map((t) => [t.key, t]));
export const qty = (type, n) => (n === 1 ? TYPE[type].one : `${n.toLocaleString('he-IL')} ${TYPE[type].unit}`);

const te = new TextEncoder();
const jsonBytes = (x) => te.encode(JSON.stringify(x)).length;
const encBytes = (r) => (r && r.enc ? r.enc.ct.byteLength + r.enc.iv.byteLength : 0);
const boxBytes = (box) => (box && box.parts ? box.parts.reduce((n, p) => n + p.ct.byteLength + p.iv.byteLength, 0) + 160 : 0);
const logKey = (it) => `${it.t}|${it.ev}|${it.detail}`;

export function periodOf(kind, key) {
  if (kind === 'week') return [key, S.addDays(key, 6)];
  if (kind === 'month') { const d = S.daysOfMonth(key); return [d[0], d[d.length - 1]]; }
  return [key, key];
}

const photosOf = (e) => {
  const ids = new Set((e.photoIds || []).filter((id) => vault.photos.has(id)));
  for (const p of vault.photos.values()) if (p.entryId === e.id) ids.add(p.id);
  return [...ids];
};
const audioOf = (e) => [e.audioId, ...(e.audioMore || []).map((m) => m.id)].filter((id) => id && vault.audio.has(id));

// Every deletable piece ("atom"): { type, id, day, dayEnd?, entryId?, bytes }.
// skipJournal: the id of a recording running in this page (its journal is not a leftover).
export async function scan({ skipJournal = null } = {}) {
  if (!V.isUnlocked()) throw Object.assign(new Error('locked'), { code: 'locked' });
  const atoms = [];
  for (const e of vault.entries.values()) {
    if (e.segments && e.segments.length) atoms.push({ type: 'raw', id: e.id, day: e.dayKey, entryId: e.id, bytes: jsonBytes(e.segments) });
    if (e.tidy && !e.tidy.deleted) atoms.push({ type: 'tidy', id: e.id, day: e.dayKey, entryId: e.id, bytes: jsonBytes(e.tidy) });
  }
  for (const a of vault.audio.values()) {
    const e = a.entryId && vault.entries.get(a.entryId);
    atoms.push({ type: 'audio', id: a.id, day: e ? e.dayKey : S.dayKey(a.createdAt), entryId: e ? e.id : null, bytes: (a.size || 0) + 28 });
  }
  for (const p of vault.photos.values()) {
    const owner = (p.entryId && vault.entries.has(p.entryId)) ? p.entryId
      : ([...vault.entries.values()].find((e) => (e.photoIds || []).includes(p.id)) || {}).id || null;
    const bytes = (await V.blobSize(p.blobId)) + (await V.blobSize(p.thumbId)) + jsonBytes(p) + 28;
    atoms.push({ type: 'photos', id: p.id, day: p.dayKey, entryId: owner, bytes });
    if (p.lat != null) atoms.push({ type: 'locations', id: p.id, day: p.dayKey, entryId: owner, bytes: 40 });
  }
  for (const s of vault.summaries.values()) {
    const [from, to] = periodOf(s.kind, s.key);
    atoms.push({ type: 'summaries', id: s.id, day: from, dayEnd: to, bytes: jsonBytes(s) + 28 });
  }
  for (const r of await db.getAll('inbox')) atoms.push({ type: 'pending', id: 'inbox|' + r.id, day: S.dayKey(r.createdAt || Date.now()), bytes: boxBytes(r.box) });
  const groups = new Map();
  for (const r of await db.getAll('journal')) {
    const recId = r.recId || String(r.id).split('|')[0];
    if (recId === skipJournal) continue;
    const g = groups.get(recId) || { bytes: 0, at: null };
    g.bytes += boxBytes(r.box);
    if (r.createdAt) g.at = r.createdAt; else if (!g.at && r.savedAt) g.at = r.savedAt;
    groups.set(recId, g);
  }
  for (const [recId, g] of groups) atoms.push({ type: 'pending', id: 'journal|' + recId, day: S.dayKey(g.at || Date.now()), bytes: g.bytes });
  const dr = await db.get('meta', 'draft');
  if (dr) {
    let at = Date.now();
    try { const d = await V.getDraft(); if (d && d.savedAt) at = d.savedAt; } catch (e) { /* undecryptable draft: still listed */ }
    atoms.push({ type: 'draft', id: 'draft', day: S.dayKey(at), bytes: encBytes(dr) });
  }
  for (const it of await V.getLog()) atoms.push({ type: 'log', id: logKey(it), day: S.dayKey(it.t), bytes: jsonBytes(it) });
  return atoms;
}

// sel: { scope: 'all'|'range'|'pick', from, to, entryIds: Set, types: Set }
export function rangeOk(sel) { return !(sel.scope === 'range' && sel.from && sel.to && sel.from > sel.to); }
export function inScope(a, sel) {
  if (sel.scope === 'pick') return !!a.entryId && !!sel.entryIds && sel.entryIds.has(a.entryId);
  if (sel.scope === 'range') {
    if (!rangeOk(sel)) return false;
    return a.day >= (sel.from || '0000-00-00') && (a.dayEnd || a.day) <= (sel.to || '9999-99-99');
  }
  return true;
}
// Which kinds can be chosen in this scope (single recordings: only what belongs to a recording).
export const applicable = (type, sel) => sel.scope !== 'pick' || TYPE[type].entry;

// The atoms that will be deleted. Photos include their location, so 'locations' is dropped for them.
export function select(atoms, sel) {
  const types = new Set([...(sel.types || [])].filter((t) => applicable(t, sel)));
  const out = atoms.filter((a) => types.has(a.type) && inScope(a, sel));
  if (types.has('photos')) {
    const gone = new Set(out.filter((a) => a.type === 'photos').map((a) => a.id));
    return out.filter((a) => !(a.type === 'locations' && gone.has(a.id)));
  }
  return out;
}

// { type: { count, bytes, from, to } }
export function tally(atoms) {
  const t = {};
  for (const a of atoms) {
    const x = t[a.type] || (t[a.type] = { count: 0, bytes: 0, from: null, to: null });
    x.count++;
    x.bytes += a.bytes;
    const end = a.dayEnd || a.day;
    if (!x.from || a.day < x.from) x.from = a.day;
    if (!x.to || end > x.to) x.to = end;
  }
  return t;
}

const byType = (atoms) => {
  const m = Object.fromEntries(TYPES.map((t) => [t.key, new Set()]));
  for (const a of atoms) m[a.type].add(a.id);
  return m;
};

// What the deletion does to the recordings, said in advance: removed as a whole, text kept without voice, etc.
export function effects(atoms) {
  const by = byType(atoms);
  const out = { removed: 0, voiceMarked: 0, textKeptNoTidy: 0, tidyKeptNoRaw: 0, emptyKept: 0, photosUnlinked: 0 };
  for (const e of vault.entries.values()) {
    const au = audioOf(e), ph = photosOf(e);
    const hit = by.raw.has(e.id) || by.tidy.has(e.id) || au.some((id) => by.audio.has(id)) || ph.some((id) => by.photos.has(id));
    if (!hit) continue;
    const rawGone = !(e.segments && e.segments.length) || by.raw.has(e.id);
    const tidyGone = !!(e.tidy && e.tidy.deleted) || by.tidy.has(e.id);
    const audioLeft = au.filter((id) => !by.audio.has(id)).length;
    const photosLeft = ph.filter((id) => !by.photos.has(id)).length;
    if (ph.some((id) => by.photos.has(id))) out.photosUnlinked++;
    if (rawGone && tidyGone && !audioLeft && !photosLeft) { out.removed++; continue; }
    if (au.some((id) => by.audio.has(id))) out.voiceMarked++;
    if (rawGone && tidyGone) out.emptyKept++;
    else if (by.tidy.has(e.id) && !rawGone) out.textKeptNoTidy++;
    else if (by.raw.has(e.id) && !tidyGone) out.tidyKeptNoRaw++;
  }
  return out;
}

// One photo, for real: the recordings that point to it stop pointing to it, then its record (with the location in it)
// and both blobs (full size + thumbnail) leave IndexedDB. markAt: stamp the recordings with photosDeletedAt (the
// "מחיקת נתונים" notice). Returns the ids of the recordings that changed; the caller saves them.
async function dropPhoto(id, markAt = null) {
  const p = vault.photos.get(id);
  if (!p) return [];
  const changed = [];
  for (const e of vault.entries.values()) {
    if ((e.photoIds || []).includes(id) || p.entryId === e.id) {
      e.photoIds = (e.photoIds || []).filter((x) => x !== id);
      if (markAt) e.photosDeletedAt = markAt;
      changed.push(e.id);
    }
  }
  await V.deletePhoto(id);
  return changed;
}

// 1.6.5 "מחק תמונה" in the photo viewer: one photo and its location. The recording and its text always stay,
// even if this was its last photo (unlike "מחיקת נתונים", which removes a recording left with nothing in it).
export async function deleteOnePhoto(id) {
  if (!V.isUnlocked()) throw Object.assign(new Error('locked'), { code: 'locked' });
  if (!vault.photos.has(id)) return { deleted: false, entries: [] };
  const changed = await dropPhoto(id);
  for (const eid of changed) { const e = vault.entries.get(eid); if (e) await V.saveEntry(e); }
  return { deleted: true, entries: changed };
}

// Deletes exactly the given atoms. Nothing at all is deleted before auth ({ password } or { prf }) is verified.
// opts.isRecording(): true while a recording runs; then nothing is deleted.
export async function execute(atoms, auth, opts = {}) {
  if (opts.isRecording && opts.isRecording()) throw Object.assign(new Error('recording'), { code: 'recording' });
  await V.requireAuth(auth);
  if (opts.isRecording && opts.isRecording()) throw Object.assign(new Error('recording'), { code: 'recording' });
  if (!V.isUnlocked()) throw Object.assign(new Error('locked'), { code: 'locked' });
  const before = (await V.storageInfo()).usage;
  const by = byType(atoms);
  const now = Date.now();
  const dirty = new Set();
  const done = Object.fromEntries(TYPES.map((t) => [t.key, 0]));

  for (const id of by.photos) {
    if (!vault.photos.has(id)) continue;
    for (const eid of await dropPhoto(id, now)) dirty.add(eid);
    done.photos++;
  }
  for (const id of by.locations) {
    const p = vault.photos.get(id);
    if (!p || p.lat == null) continue;
    await V.savePhotoMeta({ ...p, lat: null, lng: null, locSource: null, locDeletedAt: now });
    done.locations++;
  }
  for (const id of by.audio) {
    const a = vault.audio.get(id);
    if (!a) continue;
    const e = a.entryId && vault.entries.get(a.entryId);
    if (e) { e.audioDeletedAt = now; dirty.add(e.id); }
    await V.deleteAudio(id);
    done.audio++;
  }
  for (const id of by.raw) {
    const e = vault.entries.get(id);
    if (!e || !(e.segments && e.segments.length)) continue;
    e.segments = [];
    e.rawDeletedAt = now;
    if (e.tidy) e.tidy.fromRawVersion = e.rawVersion; // nothing left to re-tidy from: no "stale" notice
    dirty.add(id);
    done.raw++;
  }
  for (const id of by.tidy) {
    const e = vault.entries.get(id);
    if (!e || (e.tidy && e.tidy.deleted)) continue;
    e.tidy = { title: '', paragraphs: [], edited: false, deleted: true, deletedAt: now, fromRawVersion: e.rawVersion || 1 };
    dirty.add(id);
    done.tidy++;
  }
  let removed = 0;
  for (const id of dirty) {
    const e = vault.entries.get(id);
    if (!e) continue;
    const empty = !(e.segments && e.segments.length) && e.tidy && e.tidy.deleted && !audioOf(e).length && !photosOf(e).length;
    if (empty) { await V.deleteEntry(id); removed++; } else await V.saveEntry(e);
  }
  for (const id of by.summaries) { if (vault.summaries.has(id)) { await V.deleteSummary(id); done.summaries++; } }
  for (const id of by.pending) {
    const [kind, rid] = [id.slice(0, id.indexOf('|')), id.slice(id.indexOf('|') + 1)];
    if (kind === 'inbox') { if (await db.get('inbox', rid)) { await db.del('inbox', rid); done.pending++; } }
    else if (await V.journalDrop(rid)) done.pending++;
  }
  if (by.draft.size && (await db.get('meta', 'draft'))) { await V.clearDraft(); done.draft++; }
  if (by.log.size) done.log = await V.pruneLog((it) => by.log.has(logKey(it)));
  const after = (await V.storageInfo()).usage;
  return { done, removedEntries: removed, freed: atoms.reduce((n, a) => n + a.bytes, 0), before, after };
}
