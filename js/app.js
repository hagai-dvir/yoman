// היומן · main UI. Plain ES modules, no build step.
import * as V from './vault.js';
import { vault } from './vault.js';
import * as W from './webauthn.js';
import { tidy, tokenize, rawText, tidyText, dictationSegments, writtenSegments, tidyWritten } from './tidy.js';
import { parseExif, mapsUrl } from './exif.js';
import * as S from './summaries.js';
import { Recorder, speechSupported } from './speech.js';
import { buildKoru } from './koru.js';
import { TEST_DB } from './db.js';
import * as P from './platform.js';
import * as VO from './voice.js';

const VERSION = '1.4.0';
const WORD_PAGE = 1500;        // word buttons rendered at once in the raw view (100K-character entries stay fast)
const SHARE_TEXT_MAX = 15000;   // longer texts are shared as a .txt file: share targets cut long text
const QUICK_URL = new URL('./?rec=1', location.href.split(/[?#]/)[0]).href;
const app = document.getElementById('app');
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (n, cls = 'ic') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${n}"/></svg>`;
const wave = (pos) => `<svg class="wave ${pos}" aria-hidden="true"><use href="#koru"/></svg>`;
const HILLS = '<svg class="hills" viewBox="0 0 300 150" preserveAspectRatio="none" aria-hidden="true"><path d="M0 60 C60 20 120 50 170 40 S260 20 300 36 V150 H0Z" fill="#A7B347"/><path d="M0 100 C70 70 140 104 210 84 S280 80 300 88 V150 H0Z" fill="#6E9632"/></svg>';
const entryDur = (e) => (e.input === 'written' ? 'נכתב' : fmtDur(e.durationSec || 0) + (e.written ? ' + כתיבה' : ''));
const FS_BTN = '<button type="button" class="chip" data-act="fs-toggle">מסך מלא</button>';
function grow(ta) { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 4 + 'px'; }
const tidyFor = (e) => (e.input === 'written' ? tidyWritten(e.segments) : tidy(e.segments));
const fmtDur = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} דק׳`;
const today = () => S.dayKey(Date.now());

const ui = {
  screen: 'boot', lastScreen: null,
  entryId: null, entryTab: 'raw', libTab: 'raw', sumKind: 'day', sumKey: null,
  word: null, freeEdit: false, tidyEdit: false, sumEdit: false, confirm: null, viewPhoto: null,
  undo: new Map(), rec: null, dict: null, external: false, hasPrf: false, prfMeta: null, bioPending: null,
  sd: null, photoTarget: null, restoreMode: false, settings: { autolockMin: 3, recordAudio: true, inputMode: 'auto', lastBackupAt: 0, carMode: false, quickCapture: false },
  quick: false, mics: null, reader: null,
};
const refreshSettings = async () => { ui.settings = await V.getSettings(); return ui.settings; };
// Which input path a recording takes, and why (the reason goes to the diagnostics log).
// Live recognition is always tried first, also in the iPhone Home Screen app; keyboard dictation is the fallback.
// After live recognition failed on this exact browser version, go straight to dictation until iOS/Chrome updates.
function chooseInputPath() {
  if (ui.settings.inputMode === 'dictation') return { mode: 'dictation', reason: 'setting' };
  if (!speechSupported()) return { mode: 'dictation', reason: 'no-speech-api' };
  const fb = ui.settings.speechFallback;
  if (fb && fb.ua === navigator.userAgent) return { mode: 'dictation', reason: 'learned:' + fb.reason };
  return { mode: 'live', reason: fb ? 'retry-after-update' : 'default' };
}

// ---------------------------------------------------------------- navigation
const TRANSIENT = { word: null, freeEdit: false, tidyEdit: false, sumEdit: false, confirm: null, viewPhoto: null, wordLimit: WORD_PAGE };
function go(screen, patch = {}, mode = 'push') {
  Object.assign(ui, TRANSIENT, patch, { screen });
  const st = { screen, entryId: ui.entryId, entryTab: ui.entryTab, libTab: ui.libTab, sumKind: ui.sumKind, sumKey: ui.sumKey };
  if (mode === 'push') history.pushState(st, '');
  else if (mode === 'replace') history.replaceState(st, '');
  render();
}
window.addEventListener('popstate', (e) => {
  if (ui.rec || ui.dict) { history.pushState({ screen: 'record' }, ''); return; } // never leave a running recording by "back"
  if (!V.isUnlocked()) return;
  if (ui.screen === 'write') saveDraftNow();
  const st = e.state;
  if (!st || !st.screen || ['record', 'dictate', 'setup', 'lock', 'bioOffer', 'boot'].includes(st.screen)) { go('today', {}, 'none'); return; }
  go(st.screen, st, 'none');
});

function render() {
  // While locked only the lock screens and the quick-capture screens (which never show diary content) may render.
  const lockedOk = ['setup', 'lock', 'boot'].concat(ui.quick ? ['record', 'dictate', 'tapstart', 'quickDone'] : []);
  if (!V.isUnlocked() && !lockedOk.includes(ui.screen)) ui.screen = ui.hasVault ? 'lock' : 'setup';
  const fn = SCREENS[ui.screen] || SCREENS.today;
  app.innerHTML = fn() + (ui.viewPhoto ? viewer() : '');
  if (ui.screen !== ui.lastScreen) { window.scrollTo(0, 0); ui.lastScreen = ui.screen; }
  hydrate();
  app.querySelectorAll('textarea.grow').forEach(grow);
  const wt = $('#write-ta');
  if (wt) { updateWriteCount(); if (!ui.writeFocused) { ui.writeFocused = true; wt.focus(); } }
  const wi = $('#word-input');
  if (wi) { wi.focus(); if (ui.word && ui.word.mode !== 'add') wi.select(); }
}

async function hydrate() {
  for (const img of app.querySelectorAll('img[data-blob]')) {
    try { const u = await V.blobUrl(img.dataset.blob, 'image/jpeg'); if (u) img.src = u; } catch (e) { /* locked meanwhile */ }
  }
  for (const au of app.querySelectorAll('audio[data-audio]')) {
    try { const u = await V.audioUrl(au.dataset.audio, au.dataset.mime); if (u) au.src = u; } catch (e) { /* ignore */ }
  }
}

let toastTimer;
function toast(msg, ms = 4500) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
function showErr(form, msg) {
  const el = form && form.querySelector('.err');
  if (el) { el.textContent = msg; el.hidden = false; } else toast(msg);
}
async function busy(btn, label, fn) {
  const old = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.textContent = label; }
  try { return await fn(); } finally { if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = old; } }
}

// ---------------------------------------------------------------- data helpers
const entriesSorted = () => [...vault.entries.values()].sort((a, b) => b.createdAt - a.createdAt);
const entriesOfDays = (keys) => { const set = new Set(keys); return entriesSorted().filter((e) => set.has(e.dayKey)); };
const photosOfDays = (keys) => { const set = new Set(keys); return [...vault.photos.values()].filter((p) => set.has(p.dayKey)).sort((a, b) => (a.takenAt || a.createdAt) - (b.takenAt || b.createdAt)); };
const daysOf = (kind, key) => kind === 'day' ? [key] : kind === 'week' ? Array.from({ length: 7 }, (_, i) => S.addDays(key, i)) : S.daysOfMonth(key);
const defaultKey = (kind) => kind === 'day' ? today() : kind === 'week' ? S.weekStart(today()) : S.monthKey(today());
const periodLabel = (kind, key) => kind === 'day' ? S.longDate(key) : kind === 'week' ? `שבוע ${S.weekLabel(key)}` : S.monthLabel(key);

function summaryText(kind, key) {
  const st = vault.summaries.get(S.summaryId(kind, key));
  if (st && st.edited) return st.text;
  if (kind === 'day') return S.buildDaily(entriesOfDays([key]));
  if (kind === 'week') return S.buildWeekly(key, (k) => summaryText('day', k));
  return S.buildMonthly(key, (k) => summaryText('day', k));
}

function pushUndo(e) {
  const st = ui.undo.get(e.id) || [];
  st.push(JSON.stringify({ segments: e.segments, tidy: e.tidy, rawVersion: e.rawVersion }));
  if (st.length > 60) st.shift();
  ui.undo.set(e.id, st);
}

const CONFLICT_TEXT = {
  'speech-audio-capture': 'הקול עצמו לא נשמר בהקלטה הזו: התמלול והקלטת הקול התנגשו על המיקרופון, והתמלול קיבל עדיפות.',
  'speech-ends-immediately': 'הקול עצמו לא נשמר בהקלטה הזו: כשהקלטת הקול פעלה, התמלול הפסיק לשמוע. התמלול קיבל עדיפות.',
  'recorder-hears-silence': 'הקול עצמו לא נשמר במלואו: הקלטת הקול קיבלה שקט בזמן שהתמלול עבד. כנראה שהתמלול תופס את המיקרופון.',
};
const conflictText = (r) => CONFLICT_TEXT[r] || (r && r.startsWith('getUserMedia') ? `לא הצלחתי להקליט את הקול (${r.replace('getUserMedia-', '')}). התמלול לא נפגע.` : '');

// ---------------------------------------------------------------- shared pieces
const on = (cond) => (cond ? 'on' : '');
const nav = () => `<nav class="nav"><div class="nav-in">
  <button data-act="tab" data-to="today" class="${on(ui.screen === 'today')}">היום</button>
  <button data-act="tab" data-to="library" class="${on(ui.screen === 'library')}">ספריות</button>
  <button class="rec" data-act="record" aria-label="הקלטה חדשה">${icon('mic')}</button>
  <button data-act="tab" data-to="summaries" class="${on(ui.screen === 'summaries')}">סיכומים</button>
  <button data-act="tab" data-to="settings" class="${on(ui.screen === 'settings')}">הגדרות</button>
</div></nav>`;

const bioButton = () => (ui.bioPending
  ? `<p class="notice">מפתח הגישה נוצר. נשאר אישור אחד כדי לחבר אותו להצפנה.</p><button class="btn wide" data-act="bio-finish">${icon('finger')}שלב אחרון: אשר שוב</button>`
  : `<button class="btn wide" data-act="bio-enroll">${icon('finger')}הפעל ${P.biometricName}</button>`);

// iPhone in a Safari tab: data can be evicted after 7 days without use. Installing prevents that.
// Shown as a slim bar under the record button; tapping it opens the steps.
function installBar() {
  if (!P.isIOS || P.isStandalone()) return '';
  return `<details class="install-bar"><summary>${icon('download')}<span>חשוב באייפון: התקן את היומן במסך הבית</span></summary>
    <p>ב-Safari, אם לא תפתח את היומן 7 ימים, Safari רשאי למחוק אותו. יומן שמותקן במסך הבית מוגן מזה.</p>
    <ol class="steps"><li>לחץ על כפתור השיתוף של Safari (ריבוע עם חץ למעלה).</li><li>בחר "הוסף למסך הבית", ואז "הוסף".</li><li>מעכשיו פתח את היומן רק מהאייקון החדש.</li></ol>
    <p class="note">היומן במסך הבית נפרד מזה שב-Safari. אם כבר הקלטת כאן: צור גיבוי (בהגדרות), ושחזר אותו ביומן המותקן.</p></details>`;
}function backupNudge() {
  const days = (Date.now() - (ui.settings.lastBackupAt || 0)) / 86400000;
  const oldest = Math.min(...[...vault.entries.values()].map((e) => e.createdAt));
  if (!vault.entries.size || days < 7 || Date.now() - oldest < 3 * 86400000) return ''; // no nagging in the first days
  return `<section class="card notice-card"><p>${ui.settings.lastBackupAt ? `עברו ${Math.floor(days)} ימים מהגיבוי האחרון.` : 'עוד לא יצרת גיבוי.'} גיבוי מוצפן שומר את היומן גם אם נתוני הדפדפן יימחקו.</p>
    <button class="chip" data-act="tab" data-to="settings">${icon('download')}לגיבוי</button></section>`;
}

function confirmBox(key, text, yesAct, yesLabel) {
  if (ui.confirm !== key) return '';
  return `<div class="confirm" role="alert"><p>${esc(text)}</p><div class="row"><button class="btn danger" data-act="${yesAct}">${esc(yesLabel)}</button><button class="btn ghost" data-act="confirm-cancel">ביטול</button></div></div>`;
}

function photosHtml(photos, deletable) {
  return photos.map((p) => `<figure class="ph">
    <button class="icon-btn" style="all:unset;cursor:pointer" data-act="photo-view" data-id="${p.id}" aria-label="הגדל תמונה"><img data-blob="${p.thumbId}" alt="תמונה מ-${S.short(p.dayKey)}"></button>
    ${p.lat != null ? `<a href="${mapsUrl(p.lat, p.lng)}" target="_blank" rel="noopener noreferrer">${icon('pin')}גוגל מפות</a>` : '<span class="nogps">אין מיקום</span>'}
    ${deletable ? `<button class="ph-del" data-act="photo-del" data-id="${p.id}">${ui.confirm === 'photo:' + p.id ? 'לחץ שוב להסרה' : 'הסר'}</button>` : ''}
  </figure>`).join('');
}
const photoButtons = (dayKey, entryId = '') => `<div class="row">
  <button class="chip" data-act="photo" data-src="camera" data-day="${dayKey}" data-entry="${entryId}">${icon('camera')}צלם</button>
  <button class="chip" data-act="photo" data-src="gallery" data-day="${dayKey}" data-entry="${entryId}">${icon('image')}מהגלריה</button></div>`;

function viewer() {
  const p = vault.photos.get(ui.viewPhoto);
  if (!p) return '';
  const when = p.takenAt ? `${S.short(S.dayKey(p.takenAt))} · ${S.timeOf(p.takenAt)}` : S.short(p.dayKey);
  const src = { gps: 'מיקום מהטלפון בזמן הצילום', exif: 'מיקום מתוך נתוני התמונה' }[p.locSource] || 'לתמונה הזו אין מיקום';
  return `<div class="viewer" role="dialog" aria-label="תמונה">
    <img data-blob="${p.blobId}" alt="תמונה">
    <div class="row split"><span>${esc(when)} · ${src}</span>${p.lat != null ? `<a href="${mapsUrl(p.lat, p.lng)}" target="_blank" rel="noopener noreferrer">${icon('pin')}פתח בגוגל מפות</a>` : ''}</div>
    <button class="btn" data-act="viewer-close">סגור</button></div>`;
}

// ---------------------------------------------------------------- screens
const SCREENS = {
  boot: () => '<main class="scr boot"><p class="muted">טוען…</p></main>',

  setup: () => `<main class="scr">${wave('big')}
  <div class="card" style="margin-top:150px"><h1 class="brand">היומן</h1><p class="owner">של חגי דביר</p><p>מדברים, והיומן כותב. מה שנכתב נשמר בטלפון הזה בלבד.</p></div>
  <section class="card disclose"><h2>לפני שמתחילים</h2><ul>
    <li><b>התמלול עובר דרך ${P.speechVendor}.</b> בזמן הקלטה, הדפדפן שולח את הקול לשרתי ${P.speechVendor} כדי להפוך אותו לטקסט. כרגע זו הדרך היחידה לתמלל עברית בטלפון בזמן אמת.</li>
    ${P.isIOS ? `<li><b>באייפון צריך להתקין את היומן במסך הבית.</b> אחרת Safari עלול למחוק אותו אם לא תפתח אותו שבוע. ההסבר יופיע אחרי שתיצור את היומן.</li>` : ''}
    <li><b>הטקסט, התמונות והקול נשמרים רק בטלפון הזה,</b> מוצפנים בסיסמה שתבחר עכשיו. אין שרת ואין ענן.</li>
    <li><b>אין שחזור סיסמה.</b> בלי הסיסמה אי אפשר לפתוח את היומן. גם לא דרך הגיבוי.</li>
    <li><b>מחיקת נתוני האתר בדפדפן מוחקת את היומן.</b> כדאי ליצור מדי פעם גיבוי מוצפן (בהגדרות).</li>
    <li><b>מיקום:</b> כשמצלמים מתוך היומן, הטלפון ישאל אם לשמור את המיקום. הוא נשמר רק כאן.</li>
  </ul></section>
  <form class="card" data-form="setup" ${ui.restoreMode ? 'hidden' : ''} novalidate>
    <h2>בחר סיסמה</h2>
    <label class="field">סיסמה, לפחות 8 תווים<input type="password" id="pw1" autocomplete="new-password" required></label>
    <label class="field">הקלד שוב<input type="password" id="pw2" autocomplete="new-password" required></label>
    <label class="check"><input type="checkbox" id="agree"><span>קראתי והבנתי את מה שכתוב למעלה</span></label>
    <p class="err" hidden></p>
    <button class="btn wide" type="submit">צור את היומן</button>
    <button type="button" class="link" data-act="restore-mode">יש לי קובץ גיבוי</button>
  </form>
  <form class="card" data-form="setup-restore" ${ui.restoreMode ? '' : 'hidden'} novalidate>
    <h2>שחזור מגיבוי</h2>
    <p class="note">סיסמת הגיבוי תהיה גם הסיסמה של היומן בטלפון הזה.</p>
    <label class="field">קובץ הגיבוי<input type="file" id="restore-file" accept=".json,application/json"></label>
    <label class="field">סיסמת הגיבוי<input type="password" id="restore-pw" autocomplete="current-password"></label>
    <label class="check"><input type="checkbox" id="agree2"><span>קראתי והבנתי את מה שכתוב למעלה</span></label>
    <p class="err" hidden></p>
    <button class="btn wide" type="submit">שחזר</button>
    <button type="button" class="link" data-act="restore-mode-off">חזרה ליצירת יומן חדש</button>
  </form></main>`,

  lock: () => `<main class="scr">${wave('big')}${HILLS}<div class="lockwrap">
  <form class="card" data-form="unlock" novalidate>
    <h1 class="brand">היומן</h1>
    <p class="owner">של חגי דביר</p>
    <p class="muted">${S.longDate(today())} · נעול</p>
    <label class="field">סיסמה<input type="password" id="pw" autocomplete="current-password"></label>
    <p class="err" hidden></p>
    <div class="row"><button class="btn" style="flex:1" type="submit">פתח</button>
    ${ui.hasPrf ? `<button type="button" class="round" data-act="bio-unlock" aria-label="פתח ב-${P.biometricName}">${icon('finger')}</button>` : ''}</div>
    <p class="note">${ui.hasPrf ? `${P.biometricName}, או סיסמה.` : 'הכול מוצפן בטלפון הזה.'}</p>
  </form>
  ${ui.settings.quickCapture && ui.hasInbox ? `<button class="btn honey wide quick-btn" data-act="quick-rec">${icon('mic')}הקלטה מהירה בלי לפתוח</button>` : ''}
  </div></main>`,

  bioOffer: () => `<main class="scr">${wave('big')}${HILLS}<div class="lockwrap">
  <section class="card"><h2>פתיחה מהירה</h2>
    <p>אפשר לפתוח את היומן ב-${P.biometricName} במקום להקליד סיסמה. הסיסמה תמשיך לעבוד תמיד.</p>
    <p class="note">${P.passkeyHint}</p>
    ${bioButton()}
    <button class="btn ghost wide" data-act="tab" data-to="today">אחר כך</button>
  </section></div></main>`,

  // One-button home: a single big record button fills the first screen. Everything else sits below it.
  today() {
    const k = today();
    const es = entriesOfDays([k]);
    const ps = photosOfDays([k]);
    const sum = summaryText('day', k);
    return `<main class="scr with-nav home">${wave('tr')}
    <header class="home-head"><p class="eyebrow">חגי דביר · ${S.longDate(k)}</p></header>
    <section class="home-main">
      <button class="rec-huge" data-act="record" aria-label="התחל להקליט">${icon('mic')}</button>
      <p class="home-label">הקלט</p>
      <p class="note">נגיעה אחת מתחילה להקליט, והמילים נכתבות לבד.</p>
      <button class="btn ghost write-btn" data-act="write-new">${icon('pencil')}${ui.draft && ui.draft.text ? 'המשך את הטיוטה' : 'כתוב'}</button>
    </section>
    ${installBar()}
    ${backupNudge()}
    <section class="card"><h2>ההקלטות של היום</h2>
      ${es.length ? `<div class="list">${es.map((e) => `<div class="item"><button class="item-main" data-act="open-entry" data-id="${e.id}" data-tab="tidy">
        <span class="d"><span>${S.timeOf(e.createdAt)}</span><span>${entryDur(e)}</span></span><span class="t"><b>${esc(e.tidy.title)}</b></span></button></div>`).join('')}</div>` : '<p class="muted">עוד לא הקלטת היום.</p>'}
    </section>
    <section class="card"><h2>תמונות של היום</h2>
      ${ps.length ? `<div class="photos">${photosHtml(ps, false)}</div>` : '<p class="muted">אין עדיין תמונות.</p>'}
      ${photoButtons(k)}</section>
    <section class="card"><h2>סיכום היום</h2>
      ${sum ? `<p class="sumtext">${esc(S.firstSentences(sum.replace(/\n/g, ' '), 3))}</p>` : '<p class="muted">הסיכום ייבנה מההקלטות של היום.</p>'}
      <button class="link" data-act="open-sum" data-kind="day" data-key="${k}">לסיכום המלא ←</button></section>
    </main>${nav()}`;
  },
  record() {
    const car = ui.settings.carMode;
    const phrase = car && ui.settings.endPhrase ? ui.settings.endPhrase : '';
    const silence = car && ui.settings.silenceStopSec ? ui.settings.silenceStopSec : 0;
    const handsFree = [phrase ? `אמור "${esc(phrase)}" כדי לסיים` : '', silence ? `ההקלטה תיעצר אחרי ${silence} שניות שקט` : ''].filter(Boolean).join(' · ');
    return `<main class="scr rec-scr${car ? ' car' : ''}">${wave('bl')}
    ${ui.quick ? '<p class="quick-badge">הקלטה מהירה · היומן נשאר נעול, וההקלטה תיכנס אליו כשתפתח אותו</p>' : ''}
    <div class="row split"><span class="sticker"><i></i><span id="rec-time">00:00</span></span><span class="rec-status" id="rec-status">מתחיל…</span></div>
    <p class="rec-mic" id="rec-mic">מיקרופון: ${P.isIOS ? 'לפי בחירת האייפון (דיבורית או אוזניות, אם מחוברות)' : 'ברירת המחדל של הטלפון'}</p>
    <div class="lined rec-text" id="rec-text"><span class="muted">מדברים, והמילים יופיעו כאן.</span></div>
    <p class="note" id="rec-audio"></p>
    ${handsFree ? `<p class="handsfree">${handsFree}</p>` : ''}
    <button class="btn honey wide" id="rec-resume" data-act="rec-resume" hidden>הזיהוי נעצר. הקש כאן כדי להמשיך</button>
    <div class="stopzone"><button class="stop${car ? ' huge' : ''}" data-act="stop-rec" aria-label="עצור"><i></i></button><span class="stop-l">עצור</span></div>
  </main>`;
  },

  // Shown when a hands-free start (Siri shortcut, ?rec=1) was refused by the browser: one tap anywhere starts.
  tapstart: () => `<main class="scr tapstart"><button class="tap-all" data-act="tap-start" aria-label="התחל להקליט">
    <span class="rec-huge" aria-hidden="true">${icon('mic')}</span><span class="home-label">גע בכל מקום כדי להקליט</span>
    <span class="note">הדפדפן לא מאפשר להתחיל להקליט בלי נגיעה אחת.</span></button></main>`,

  quickDone: () => `<main class="scr">${wave('big')}${HILLS}<div class="lockwrap">
    <section class="card"><h2>נשמר</h2><p>ההקלטה נשמרה מוצפנת. היא תיכנס ליומן כשתפתח אותו בסיסמה או ב-${P.biometricName}.</p>
    <button class="btn wide" data-act="quick-rec">${icon('mic')}הקלטה נוספת</button>
    <button class="btn ghost wide" data-act="quick-exit">פתח את היומן</button></section></div></main>`,
  dictate: () => `<main class="scr rec-scr">${wave('bl')}
    <div class="row split"><span class="sticker"><i></i><span id="rec-time">00:00</span></span><span class="rec-status">הכתבה במקלדת</span></div>
    <p class="dict-hint">${icon('mic')}<span>לחץ על המיקרופון במקלדת, ודבר</span></p>
    <p class="note">${ui.dict && ui.dict.why ? esc(ui.dict.why) + ' ' : ''}אם המקלדת לא נפתחה, הקש על הדף. אם ההכתבה נעצרת, לחץ שוב על המיקרופון. בסוף לחץ "שמור".</p>
    <textarea class="lined rec-text dict" id="dict-ta" lang="he" dir="rtl" autocomplete="off" spellcheck="false" placeholder="המילים יופיעו כאן"></textarea>
    <p class="note">ההכתבה של המקלדת עוברת דרך ${P.speechVendor}. במצב הזה הקול עצמו לא נשמר.</p>
    <div class="stopzone"><button class="stop" data-act="stop-dict" aria-label="שמור"><i></i></button><span class="stop-l">שמור</span></div>
  </main>`,

  // Full-screen writing. The page is sized to the visible viewport, so the text stays above the iOS keyboard.
  write() {
    const ctx = ui.writeCtx || { mode: 'new' };
    const target = ctx.mode === 'append' ? vault.entries.get(ctx.entryId) : null;
    return `<main class="write-scr">
      <header class="write-bar">
        <button class="chip" data-act="write-cancel">סגור</button>
        <div class="write-mid"><b>${target ? 'הוספה ל: ' + esc(target.tidy.title) : 'כתיבה חדשה'}</b><span id="write-state" class="note">${ui.writeRestored ? 'טיוטה קודמת נפתחה' : 'נשמר אוטומטית, מוצפן'}</span></div>
        <button class="btn" data-act="write-save">שמור</button>
      </header>
      <textarea id="write-ta" class="write-ta" lang="he" dir="rtl" placeholder="כתוב כאן. אין הגבלת אורך." autocomplete="off">${esc(ui.writeText || '')}</textarea>
      <footer class="write-foot"><span id="write-count" class="note"></span>
        ${ui.writeText ? `<button class="chip" data-act="write-discard">${ui.confirm === 'write-discard' ? 'לחץ שוב למחיקת הטיוטה' : 'מחק טיוטה'}</button>` : ''}</footer>
    </main>`;
  },
  entry() {
    const e = vault.entries.get(ui.entryId);
    if (!e) { ui.screen = 'today'; return SCREENS.today(); }
    const stale = e.rawVersion !== e.tidy.fromRawVersion;
    const stack = ui.undo.get(e.id) || [];
    const undoBtn = `<button class="chip" data-act="undo" ${stack.length ? '' : 'disabled'}>${icon('undo')}בטל</button>`;
    let body;
    if (ui.entryTab === 'raw') {
      const tools = `<div class="row">${undoBtn}<button class="chip ${on(ui.freeEdit)}" data-act="free-edit">${icon('text')}עריכה חופשית</button><button class="chip" data-act="write-append">${icon('pencil')}הוסף כתיבה</button>${stale ? `<button class="chip hot" data-act="regen">${icon('sparkle')}סדר מחדש</button>` : ''}</div>`;
      if (ui.freeEdit) {
        body = `${tools}<form data-form="free-edit" class="col" style="display:flex;flex-direction:column;gap:10px">
          <p class="note">כל שורה היא קטע דיבור. אפשר לשנות הכול.</p>
          <textarea class="input grow" id="free-ta">${esc(e.segments.map((s) => s.text).join('\n'))}</textarea>
          <div class="row"><button class="btn" type="submit">שמור</button><button type="button" class="btn ghost" data-act="free-cancel">ביטול</button>${FS_BTN}</div></form>`;
      } else {
        // Word buttons are rendered in pages, so a 100,000-character entry does not create ~18,000 buttons at once.
        const limit = ui.wordLimit || WORD_PAGE;
        const parts = [];
        let total = 0;
        e.segments.forEach((s, si) => {
          const fixed = new Set(s.fixed || []);
          tokenize(s.text).forEach((w, wi) => {
            total++;
            if (total > limit) return;
            const sel = ui.word && ui.word.s === si && ui.word.w === wi;
            parts.push(`<button class="w${sel ? ' sel' : ''}${fixed.has(wi) ? ' fixed' : ''}" data-act="word" data-s="${si}" data-w="${wi}">${esc(w)}</button>`);
          });
        });
        const words = parts.join(' ');
        const more = total > limit ? `<div class="row"><button class="chip" data-act="more-words">הצג עוד ${Math.min(WORD_PAGE, total - limit).toLocaleString('he-IL')} מילים</button><span class="note">מוצגות ${limit.toLocaleString('he-IL')} מתוך ${total.toLocaleString('he-IL')} מילים</span></div>` : '';
        body = `${tools}${words ? `<p class="words">${words}</p>${more}` : '<p class="muted">לא נקלט טקסט בהקלטה הזו.</p>'}
          <p class="note">נגיעה במילה פותחת תיקון. קו גלי מסמן מילה שתוקנה.</p>
          ${stale ? '<p class="notice">תיקנת את הגרסה הגולמית. "סדר מחדש" יעדכן את הגרסה המסודרת.</p>' : ''}`;
      }
    } else if (ui.tidyEdit) {
      body = `<form data-form="tidy-edit" style="display:flex;flex-direction:column;gap:10px">
        <label class="field">כותרת<input id="tidy-title" value="${esc(e.tidy.title)}"></label>
        <label class="field">טקסט (שורה ריקה בין פסקאות)<textarea class="input typedta grow" id="tidy-ta">${esc(e.tidy.paragraphs.join('\n\n'))}</textarea></label>
        <div class="row"><button class="btn" type="submit">שמור</button><button type="button" class="btn ghost" data-act="tidy-cancel">ביטול</button>${FS_BTN}</div></form>`;
    } else {
      body = `<article class="typed"><h2>${esc(e.tidy.title)}</h2>${e.tidy.paragraphs.map((p) => `<p>${esc(p)}</p>`).join('') || '<p class="muted">אין טקסט.</p>'}</article>
        ${e.tidy.edited ? '<p class="note">הגרסה הזו נערכה ידנית.</p>' : ''}
        ${stale ? '<p class="notice">הגרסה הגולמית תוקנה אחרי הסידור. "סדר מחדש מהגולמי" יעדכן כאן.</p>' : ''}
        <div class="row">${undoBtn}<button class="chip" data-act="tidy-edit">${icon('pencil')}ערוך</button>
        <button class="chip ${stale ? 'hot' : ''}" data-act="regen">${icon('sparkle')}סדר מחדש מהגולמי</button>
        <button class="chip" data-act="share-entry">${icon('share')}שלח</button>
        <button class="chip" data-act="tts-play" data-src="entry">${icon('speaker')}השמע</button></div>`;
    }
    const a = e.audioId && vault.audio.get(e.audioId);
    let audio = '';
    if (a) {
      audio = `<audio controls preload="none" data-audio="${a.id}" data-mime="${esc(e.audioMime || '')}"></audio>
        <label class="switch"><span>שמור את הקול לתמיד${a.keep ? '' : `<br><span class="note">אחרת יימחק ב-${S.short(S.dayKey(V.audioExpiry(a)))}</span>`}</span><input type="checkbox" data-change="audio-keep" data-id="${a.id}" ${a.keep ? 'checked' : ''}></label>`;
    } else if (e.audioId) audio = '<p class="muted">הקול של ההקלטה נמחק אחרי 30 יום. הטקסט נשאר.</p>';
    if (e.audioNote) audio += `<p class="note">${esc(conflictText(e.audioNote))}</p>`;
    const photos = (e.photoIds || []).map((id) => vault.photos.get(id)).filter(Boolean);
    return `<main class="scr with-nav">${wave('tr')}
      <header class="head"><button class="icon-btn" data-act="back" aria-label="חזרה">${icon('back')}</button>
        <p class="eyebrow" style="flex:1">${S.longDate(e.dayKey)} · ${S.timeOf(e.createdAt)} · ${entryDur(e)}${e.via === 'quick' ? ' · הקלטה מהירה' : ''}</p></header>
      <div><div class="tabs"><button data-act="entry-tab" data-tab="raw" class="${on(ui.entryTab === 'raw')}">מה שאמרתי</button><button data-act="entry-tab" data-tab="tidy" class="${on(ui.entryTab === 'tidy')}">מסודר לפרסום</button></div>
      <div class="folder">${confirmBox('regen', 'הגרסה המסודרת נערכה ידנית. סידור מחדש ידרוס את העריכה (אפשר לבטל אחר כך).', 'regen-yes', 'סדר מחדש')}${body}</div></div>
      ${audio ? `<section class="card audio-box"><h2>הקול</h2>${audio}</section>` : ''}
      <section class="card"><h2>תמונות</h2>${photos.length ? `<div class="photos">${photosHtml(photos, true)}</div>` : '<p class="muted">אין תמונות להקלטה הזו.</p>'}${photoButtons(e.dayKey, e.id)}</section>
      ${confirmBox('del-entry', 'למחוק את ההקלטה, את הגרסה המסודרת, את הקול ואת התמונות שלה? אי אפשר לבטל.', 'del-entry-yes', 'מחק')}
      <button class="link" style="color:var(--danger)" data-act="del-entry">מחק את ההקלטה</button>
    </main>${ui.word ? wordPop(e) : ''}${nav()}`;
  },

  library() {
    const raw = ui.libTab === 'raw';
    let last = '';
    const items = entriesSorted().map((e) => {
      const m = S.monthKey(e.dayKey);
      const h = m !== last ? `<h3 class="month-h">${S.monthLabel(m)}</h3>` : '';
      last = m;
      const preview = raw
        ? `<span class="t hand">${esc(rawText(e.segments).slice(0, 220)) || '…'}</span>`
        : `<span class="t"><b>${esc(e.tidy.title)}</b> ${esc(S.firstSentences(e.tidy.paragraphs.join(' '), 1))}</span>`;
      return `${h}<div class="item"><button class="item-main" data-act="open-entry" data-id="${e.id}" data-tab="${raw ? 'raw' : 'tidy'}">
        <span class="d"><span>${S.longDate(e.dayKey)} · ${S.timeOf(e.createdAt)}</span><span>${entryDur(e)}</span></span>${preview}</button>
        <button class="other" data-act="open-entry" data-id="${e.id}" data-tab="${raw ? 'tidy' : 'raw'}">${raw ? 'לגרסה המסודרת ←' : 'למה שאמרתי ←'}</button></div>`;
    }).join('');
    return `<main class="scr with-nav">${wave('tr')}
      <header class="head"><h1>ספריות</h1></header>
      <div><div class="tabs"><button data-act="lib-tab" data-tab="raw" class="${on(raw)}">מה שאמרתי</button><button data-act="lib-tab" data-tab="tidy" class="${on(!raw)}">מסודר לפרסום</button></div>
      <div class="folder"><div class="list">${items || '<p class="muted">עוד אין הקלטות. הכפתור הירוק למטה מתחיל הקלטה.</p>'}</div></div></div>
    </main>${nav()}`;
  },

  summaries() {
    const kind = ui.sumKind;
    const key = ui.sumKey || defaultKey(kind);
    ui.sumKey = key;
    const days = daysOf(kind, key);
    const text = summaryText(kind, key);
    const st = vault.summaries.get(S.summaryId(kind, key));
    const edited = st && st.edited;
    const es = entriesOfDays(days);
    const newer = edited && es.some((e) => e.createdAt > st.editedAt);
    const nextKey = kind === 'day' ? S.addDays(key, 1) : kind === 'week' ? S.addDays(key, 7) : S.addMonths(key, 1);
    const canNext = (kind === 'month' ? nextKey + '-01' : nextKey) <= today();
    const withDaily = days.filter((k) => summaryText('day', k)).length;
    const source = kind === 'day' ? `נבנה מ-${es.length} הקלטות` : `נבנה מ-${withDaily} סיכומים יומיים`;
    const dots = kind === 'week' ? `<div class="days" aria-label="ימים עם הקלטה">${days.map((k, i) => `<span><i class="${entriesOfDays([k]).length ? 'y' : ''}"></i>${S.DAY_LETTERS[i]}</span>`).join('')}</div>` : '';
    const photos = photosOfDays(days);
    const body = ui.sumEdit
      ? `<form data-form="sum-edit" style="display:flex;flex-direction:column;gap:10px"><textarea class="input typedta grow" id="sum-ta">${esc(text)}</textarea>
          <div class="row"><button class="btn" type="submit">שמור</button><button type="button" class="btn ghost" data-act="sum-cancel">ביטול</button>${FS_BTN}</div></form>`
      : `${text ? `<p class="sumtext">${esc(text)}</p>` : '<p class="muted">אין עדיין הקלטות בתקופה הזו.</p>'}
         <p class="note">${edited ? 'נערך ידנית.' : source + '. מתעדכן לבד.'}</p>
         ${newer ? '<p class="notice">נוספו הקלטות אחרי העריכה. "בנה מחדש" יכלול אותן וידרוס את העריכה.</p>' : ''}
         <div class="row"><button class="chip" data-act="sum-edit">${icon('pencil')}ערוך</button>${edited ? `<button class="chip ${newer ? 'hot' : ''}" data-act="sum-rebuild">${icon('sparkle')}בנה מחדש</button>` : ''}</div>
         ${confirmBox('sum-rebuild', 'לבנות מחדש מהסיכומים היומיים? העריכה הידנית תימחק.', 'sum-rebuild-yes', 'בנה מחדש')}`;
    return `<main class="scr with-nav">${wave('tr')}
      <header class="head"><h1>סיכומים</h1></header>
      <div class="seg"><button data-act="sum-kind" data-kind="day" class="${on(kind === 'day')}">יומי</button><button data-act="sum-kind" data-kind="week" class="${on(kind === 'week')}">שבועי</button><button data-act="sum-kind" data-kind="month" class="${on(kind === 'month')}">חודשי</button></div>
      <div class="period"><button class="icon-btn" data-act="sum-nav" data-dir="-1" aria-label="התקופה הקודמת">${icon('back')}</button><h2>${periodLabel(kind, key)}</h2>
        <button class="icon-btn" data-act="sum-nav" data-dir="1" aria-label="התקופה הבאה" ${canNext ? '' : 'disabled style="opacity:.3"'}>${icon('next')}</button></div>
      <section class="card">${dots}${body}</section>
      ${photos.length ? `<section class="card"><h2>תמונות</h2><div class="photos">${photosHtml(photos, false)}</div></section>` : ''}
      <div class="row"><button class="btn honey" style="flex:1" data-act="share-sum" ${text ? '' : 'disabled'}>${icon('share')}שלח</button>
        <button class="round" data-act="tts-play" data-src="sum" aria-label="השמע" ${text ? '' : 'disabled'}>${icon('speaker')}</button>
        <button class="round" data-act="copy-sum" aria-label="העתק" ${text ? '' : 'disabled'}>${icon('copy')}</button>
        <button class="round" data-act="file-sum" aria-label="הורד כקובץ טקסט" ${text ? '' : 'disabled'}>${icon('download')}</button></div>
    </main>${nav()}`;
  },

  settings() {
    const d = ui.sd;
    if (!d) { loadSettingsData(); return `<main class="scr with-nav"><p class="muted">טוען…</p></main>${nav()}`; }
    const mb = (b) => (b == null ? '?' : (b / 1048576).toFixed(1) + ' מ"ב');
    const bio = d.prf
      ? `<p>פתיחה ב-${P.biometricName}: <b>פעילה</b>.</p>${confirmBox('bio-remove', 'לבטל את הפתיחה הביומטרית? הסיסמה תמשיך לעבוד. את מפתח הגישה עצמו אפשר למחוק במנהל הסיסמאות של Google.', 'bio-remove-yes', 'בטל פתיחה ביומטרית')}<button class="btn ghost" data-act="bio-remove">בטל פתיחה ביומטרית</button>`
      : d.caps.platform
        ? `<p>אפשר לפתוח ב-${P.biometricName}. הסיסמה תמשיך לעבוד.</p><p class="note">${P.passkeyHint}</p>${bioButton()}`
        : '<p class="muted">בטלפון או בדפדפן הזה אין זיהוי ביומטרי זמין לאתרים.</p>';
    const logTxt = d.log.slice(-60).reverse().map((l) => `${new Date(l.t).toLocaleString('he-IL')}  ${l.ev}  ${l.detail}`).join('\n');
    return `<main class="scr with-nav">${wave('tr')}
      <header class="head"><h1>הגדרות</h1></header>
      <details class="card" open><summary>כניסה ונעילה</summary>
        ${bio}
        <label class="field">נעילה אוטומטית אחרי חוסר פעילות<select id="autolock" data-change="autolock">${[1, 3, 5, 10].map((m) => `<option value="${m}" ${d.settings.autolockMin === m ? 'selected' : ''}>${m} דקות</option>`).join('')}</select></label>
        <p class="note">היומן ננעל גם מיד כשעוברים לאפליקציה אחרת או מכבים את המסך.</p>
        <button class="btn ghost" data-act="lock-now">${icon('lock')}נעל עכשיו</button>
      </details>
      <details class="card"><summary>החלפת סיסמה</summary>
        <form data-form="change-pw" style="display:flex;flex-direction:column;gap:10px" novalidate>
          <label class="field">הסיסמה הנוכחית<input type="password" id="cp-old" autocomplete="current-password"></label>
          <label class="field">סיסמה חדשה, לפחות 8 תווים<input type="password" id="cp-new" autocomplete="new-password"></label>
          <label class="field">שוב את החדשה<input type="password" id="cp-new2" autocomplete="new-password"></label>
          <p class="err" hidden></p><button class="btn" type="submit">החלף סיסמה</button></form>
      </details>
      <details class="card"${d.settings.carMode ? ' open' : ''}><summary>נהיגה ודיבורית</summary>
        <label class="switch"><span>מצב נהיגה: צלילים, כפתור עצירה ענק, וסיום בלי ידיים</span><input type="checkbox" data-change="car-mode" ${d.settings.carMode ? 'checked' : ''}></label>
        <label class="field">מילת סיום (נמחקת מהטקסט). השאר ריק כדי לכבות<input id="end-phrase" data-change="end-phrase" value="${esc(d.settings.endPhrase || '')}" autocomplete="off"></label>
        <label class="field">עצירה אוטומטית אחרי שקט<select id="silence-stop" data-change="silence-stop">${[[0, 'כבוי'], [20, '20 שניות'], [30, '30 שניות'], [60, 'דקה'], [120, '2 דקות']].map(([v, l]) => `<option value="${v}" ${d.settings.silenceStopSec === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="switch"><span>לומר "נשמר" בסוף (בנוסף לצליל)</span><input type="checkbox" data-change="spoken-cues" ${d.settings.spokenCues ? 'checked' : ''}></label>
        <p class="note">מילת הסיום והעצירה אחרי שקט פועלות רק במצב נהיגה. בלי מצב נהיגה ההקלטה נעצרת רק כשלוחצים "עצור".</p>
        ${P.isIOS
          ? '<p class="note">באייפון הדפדפן לא יכול לבחור מיקרופון. כשדיבורית הרכב או אוזניות בלוטות\' מחוברות, האייפון בדרך כלל משתמש במיקרופון שלהן. במסך ההקלטה כתוב איזה מיקרופון פעיל, כשאפשר לדעת.</p>'
          : `<label class="field">מיקרופון<select id="mic" data-change="mic"><option value="">ברירת המחדל של הטלפון</option>${(ui.mics || []).map((m) => `<option value="${esc(m.deviceId)}" ${d.settings.micDeviceId === m.deviceId ? 'selected' : ''}>${esc(m.label || 'מיקרופון')}</option>`).join('')}</select></label>
             <button class="chip" data-act="mics-load">${icon('mic')}הצג את המיקרופונים המחוברים</button>
             <p class="note">המיקרופון שנבחר משמש להקלטת הקול. התמלול של Chrome משתמש בו רק אם הדפדפן תומך בזה, ואם לא, הוא שומע מהמיקרופון של המערכת.</p>`}
      </details>
      <details class="card"><summary>הפעלה בקול</summary>
        <label class="switch"><span>הקלטה מהירה בלי לפתוח את היומן</span><input type="checkbox" data-change="quick-capture" ${d.settings.quickCapture ? 'checked' : ''}></label>
        <p class="note">כשזה פועל, אפשר להקליט גם כשהיומן נעול. ההקלטה נשמרת מוצפנת, ורק פתיחה בסיסמה או ב-${P.biometricName} מכניסה אותה ליומן. מי שמחזיק את הטלפון לא יכול לקרוא כלום, אבל יכול להוסיף הקלטה. לכן הקלטות כאלה מסומנות "הקלטה מהירה".</p>
        <p>הכתובת להקלטה מיידית:</p>
        <p class="url-box" dir="ltr">${esc(QUICK_URL)}</p>
        <button class="chip" data-act="copy-quick-url">${icon('copy')}העתק כתובת</button>
        ${P.isIOS ? `<h3>קיצור ל-Siri</h3><ol class="steps">
          <li>פתח את האפליקציה "קיצורים" (Shortcuts).</li>
          <li>לחץ על + למעלה.</li>
          <li>לחץ "הוסף פעולה", חפש "פתח כתובות URL" ובחר בה.</li>
          <li>לחץ על "URL" והדבק את הכתובת שהעתקת.</li>
          <li>לחץ על שם הקיצור למעלה, ושנה אותו ל"יומן".</li>
          <li>מעכשיו אמור: "היי סירי, יומן".</li></ol>
          <p class="notice">הקיצור פותח את היומן ב-Safari, לא ביומן שמותקן במסך הבית. אפל לא מאפשרת לקיצור לפתוח אפליקציה של מסך הבית. היומן ב-Safari והיומן המותקן שומרים נתונים בנפרד, ולכן כדי להשתמש ב-Siri צריך לנהל את היומן ב-Safari.</p>
          <p class="note">אם האייפון נעול, Siri תבקש קודם לפתוח אותו. ייתכן גם ש-Safari ידרוש נגיעה אחת כדי להתחיל להקליט. אז יופיע מסך שכולו כפתור.</p>`
        : `<h3>באנדרואיד</h3><ol class="steps"><li>אם היומן מותקן, לחיצה ארוכה על האייקון מציגה "הקלטה מהירה".</li><li>אפשר גם לומר "Hey Google, פתח את היומן" ולגעת בכפתור הגדול.</li></ol>`}
      </details>
      <details class="card"><summary>השמעה בקול</summary>
        <p>הכפתור "השמע" מקריא את הגרסה המסודרת ואת הסיכומים בקול עברי של הטלפון. כשדיבורית או אוזניות מחוברות, הקול יוצא דרכן.</p>
        <p class="note">${(() => { const v = VO.pickVoice(); return v ? `הקול: ${esc(v.name)} · ${v.localService ? 'נוצר בתוך הטלפון, בלי לשלוח את הטקסט' : `נוצר בשרת של ${P.speechVendor}: הטקסט נשלח אליו`}` : 'עוד לא נמצא קול עברי (לפעמים הרשימה נטענת רק אחרי ההשמעה הראשונה).'; })()}</p>
      </details>      <details class="card"><summary>הקלטה</summary>
        <label class="field">איך להקליט<select id="input-mode" data-change="input-mode"><option value="auto" ${d.settings.inputMode !== 'dictation' ? 'selected' : ''}>תמלול חי (מומלץ)</option><option value="dictation" ${d.settings.inputMode === 'dictation' ? 'selected' : ''}>הכתבה במקלדת</option></select></label>
        ${d.settings.speechFallback ? `<p class="notice">בהקלטה קודמת התמלול החי לא עבד כאן (${esc(d.settings.speechFallback.reason)}), ולכן ההקלטה נפתחת בהכתבה במקלדת. אחרי עדכון של המערכת ננסה שוב לבד.</p><button class="chip" data-act="retry-live">נסה שוב תמלול חי</button>` : ''}
        <label class="switch"><span>לשמור גם את הקול עצמו (מוצפן, 30 יום)</span><input type="checkbox" data-change="rec-audio" ${d.settings.recordAudio ? 'checked' : ''}></label>
        <p class="note">הקול נשמר כדי שאפשר יהיה לשמוע שוב ולתקן. אחרי 30 יום הוא נמחק, אלא אם סימנת "שמור לתמיד" בהקלטה. דקה של קול תופסת בערך רבע מגה.</p>
        <p class="note">אם התמלול והקלטת הקול מתנגשים על המיקרופון, התמלול מקבל עדיפות, והקול לא נשמר באותה הקלטה. תופיע על כך הודעה.</p>
      </details>
      <details class="card"><summary>אחסון וגיבוי</summary>
        <p>אחסון קבוע: <b>${d.storage.persisted ? 'מאושר' : 'לא מאושר'}</b>. בשימוש: ${mb(d.storage.usage)}.</p>
        ${d.storage.persisted ? '' : `<button class="btn ghost" data-act="persist">בקש אחסון קבוע</button>`}
        <p class="note">${P.isIOS ? (P.isStandalone() ? 'היומן מותקן במסך הבית, ולכן Safari לא אמור למחוק אותו מעצמו. אבל מחיקת האייקון מוחקת גם את היומן. לכן כדאי ליצור גיבוי מדי פעם.' : 'ב-Safari, יומן שלא נפתח 7 ימים עלול להימחק. התקן אותו במסך הבית (שיתוף, ואז "הוסף למסך הבית"), וצור גיבוי מדי פעם.') : 'אחסון קבוע אומר שהדפדפן לא ימחק את היומן מעצמו כשחסר מקום. אבל אם תמחק את נתוני האתר או תנקה את נתוני Chrome, היומן יימחק לגמרי. לכן כדאי ליצור גיבוי מדי פעם.'}</p>
        <p class="note">גיבוי אחרון: ${d.settings.lastBackupAt ? S.short(S.dayKey(d.settings.lastBackupAt)) : 'עוד לא'}.</p>
        <form data-form="backup" style="display:flex;flex-direction:column;gap:10px" novalidate>
          <h3>יצירת גיבוי מוצפן</h3>
          <label class="field">סיסמה לגיבוי (אפשר את אותה סיסמה)<input type="password" id="bk-pw" autocomplete="new-password"></label>
          <p class="err" hidden></p><button class="btn" type="submit">${icon('download')}צור קובץ גיבוי</button>
          <p class="note">${P.isIOS ? 'באייפון הקובץ נשמר ב"קבצים", בתיקיית ההורדות. אם תבחר לשמור אותו ב-iCloud Drive, הוא ייצא מהטלפון (מוצפן).' : 'הקובץ נשמר בתיקיית ההורדות בטלפון.'} בלי הסיסמה אי אפשר לפתוח אותו.</p></form>
        <form data-form="restore" style="display:flex;flex-direction:column;gap:10px" novalidate>
          <h3>שחזור מגיבוי</h3>
          <label class="field">קובץ<input type="file" id="rs-file" accept=".json,application/json"></label>
          <label class="field">סיסמת הגיבוי<input type="password" id="rs-pw" autocomplete="off"></label>
          <label class="field">איך לשחזר<select id="rs-mode"><option value="merge">להוסיף למה שיש</option><option value="replace">להחליף את כל מה שיש</option></select></label>
          <p class="err" hidden></p><button class="btn ghost" type="submit">שחזר</button></form>
      </details>
      <details class="card"><summary>מה יוצא מהטלפון</summary>
        <ul style="margin:0;padding-inline-start:20px;display:flex;flex-direction:column;gap:6px">
          <li>בזמן הקלטה: הקול עובר לגוגל לצורך התמלול, דרך Chrome.</li>
          <li>כשאתה לוחץ "שלח": הטקסט והתמונות עוברים לאפליקציה שבחרת.</li>
          <li>כשאתה לוחץ על קישור מפה: גוגל מפות נפתח עם הנקודה.</li>
          <li>שום דבר אחר. האתר חסום מלשלוח נתונים לכל כתובת.</li></ul>
      </details>
      <details class="card"><summary>אבחון</summary>
        <dl class="kv"><dt>גרסה</dt><dd>${VERSION}</dd>
          <dt>זיהוי דיבור</dt><dd>${speechSupported() ? 'נתמך' : 'לא נתמך'}</dd>
          <dt>ביומטרי בדפדפן</dt><dd>${d.caps.platform ? 'זמין' : 'לא זמין'}</dd>
          <dt>PRF לפי הדפדפן</dt><dd>${d.caps.prfCapability == null ? 'לא ידוע' : d.caps.prfCapability ? 'נתמך' : 'לא נתמך'}</dd>
          ${d.prf ? `<dt>רישום PRF</dt><dd>${esc(d.prf.path)} (enabled=${esc(String(d.prf.enabledFlag))})</dd>` : ''}
          <dt>מותקן כאפליקציה</dt><dd>${P.isStandalone() ? 'כן' : 'לא'}</dd>
          <dt>מערכת</dt><dd>${P.isIOS ? 'iOS' : P.isAndroid ? 'Android' : 'אחר'} · תמלול דרך ${P.speechVendor}</dd>
          <dt>הקלטת קול</dt><dd>${window.MediaRecorder ? (P.audioMimeCandidates().find((m) => MediaRecorder.isTypeSupported(m)) || 'אין פורמט נתמך') : 'לא נתמכת'}</dd></dl>
        <p class="note">היומן הטכני לא כולל שום טקסט שלך.</p>
        <pre class="logl">${esc(logTxt) || '—'}</pre>
        <button class="chip" data-act="copy-log">${icon('copy')}העתק אבחון</button>
      </details>
    </main>${nav()}`;
  },
};

function wordPop(e) {
  const { s, w, mode } = ui.word;
  const word = tokenize((e.segments[s] && e.segments[s].text) || '')[w] || '';
  const acts = mode === 'add'
    ? `<button class="on" data-act="word-add-do"><b>${icon('plus')}</b>הוסף</button><button data-act="word-mode" data-mode="edit"><b>${icon('undo')}</b>חזרה</button><span></span>`
    : `<button class="on" data-act="word-replace"><b>${icon('swap')}</b>החלף</button><button data-act="word-delete"><b>${icon('trash')}</b>מחק</button><button data-act="word-mode" data-mode="add"><b>${icon('plus')}</b>הוסף אחרי</button>`;
  return `<div class="pop" role="dialog" aria-label="תיקון מילה">
    <div class="row split"><span class="lbl">${mode === 'add' ? `הוספה אחרי «${esc(word)}»` : `תיקון: «${esc(word)}»`}</span><button class="icon-btn" data-act="word-close" aria-label="סגור">✕</button></div>
    <input class="input" id="word-input" value="${mode === 'add' ? '' : esc(word)}" placeholder="${mode === 'add' ? 'מה להוסיף' : ''}" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="done">
    <div class="acts">${acts}</div></div>`;
}

async function loadSettingsData() {
  ui.sd = { settings: await V.getSettings(), prf: await V.prfInfo(), storage: await V.storageInfo(), caps: await W.capabilities(), log: await V.getLog() };
  if (ui.screen === 'settings') render();
}

// ---------------------------------------------------------------- word editing
async function wordOp(op) {
  const e = vault.entries.get(ui.entryId);
  if (!e || !ui.word) return;
  const { s, w } = ui.word;
  const seg = e.segments[s];
  const words = tokenize(seg.text);
  const input = $('#word-input');
  const vals = tokenize(input ? input.value : '');
  if ((op === 'replace' || op === 'add') && !vals.length) { if (op === 'replace') op = 'delete'; else return; }
  pushUndo(e);
  const fixed = seg.fixed || [];
  let delta = 0;
  if (op === 'replace') { words.splice(w, 1, ...vals); delta = vals.length - 1; }
  if (op === 'delete') { words.splice(w, 1); delta = -1; }
  if (op === 'add') { words.splice(w + 1, 0, ...vals); delta = vals.length; }
  let nf = fixed.filter((i) => !(i === w && op !== 'add')).map((i) => (i > w ? i + delta : i));
  if (op === 'replace') nf = nf.concat(vals.map((_, k) => w + k));
  if (op === 'add') nf = nf.concat(vals.map((_, k) => w + 1 + k));
  seg.text = words.join(' ');
  seg.fixed = [...new Set(nf)].filter((i) => i >= 0 && i < words.length);
  e.segments = e.segments.filter((x) => x.text.trim());
  e.rawVersion = (e.rawVersion || 1) + 1;
  ui.word = null;
  await V.saveEntry(e);
  render();
}

async function regenerate(e) {
  pushUndo(e);
  e.tidy = { ...tidyFor(e), edited: false, fromRawVersion: e.rawVersion };
  await V.saveEntry(e);
  Object.assign(ui, { confirm: null, entryTab: 'tidy' });
  render();
  toast('הגרסה המסודרת עודכנה.');
}

// ---------------------------------------------------------------- recording
const mmss = (ms) => { const s = Math.floor(ms / 1000); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
// opts.quick: the diary is locked; the result is sealed into the inbox instead of the diary.
// opts.auto: started without a tap (Siri shortcut / ?rec=1). If the browser refuses, show one big tap target.
async function startRecording(pathReason = 'default', opts = {}) {
  if (ui.rec) return;
  // No await before r.start(): Safari only allows the microphone and recognition inside the tap itself.
  const settings = ui.settings;
  const car = !!settings.carMode;
  if (car && !opts.auto) VO.primeAudio();
  const r = new Recorder({
    withAudio: settings.recordAudio,
    endPhrase: car ? (settings.endPhrase || '') : '',
    silenceStopMs: car ? (settings.silenceStopSec || 0) * 1000 : 0,
    deviceId: P.isIOS ? '' : (settings.micDeviceId || ''),
    log: (ev, d) => V.log(ev, d),
    onUpdate: ({ finalText, interim }) => {
      const el = $('#rec-text');
      if (!el) return;
      el.innerHTML = esc(finalText) + (interim ? ` <span class="interim">${esc(interim)}</span>` : '') + '<i class="caret"></i>';
      el.scrollTop = el.scrollHeight;
    },
    onStatus: (s) => {
      const st = $('#rec-status');
      const au = $('#rec-audio');
      if (opts.auto && !r.everStarted && (s.kind === 'fatal' || s.kind === 'unavailable')) { autoStartRefused(r, s); return; }
      if (s.kind === 'restart' && st) st.textContent = `מקשיב… חודש אוטומטית ×${s.count}`;
      if (s.kind === 'network' && st) st.textContent = 'אין חיבור לאינטרנט. התמלול צריך רשת. ממשיך לנסות…';
      if (s.kind === 'fatal') { toast(P.isIOS ? 'אין הרשאה למיקרופון או לזיהוי דיבור. אפשר לאשר בהגדרות > Safari, ולוודא שההכתבה (Siri ודיבור) מופעלת.' : 'אין הרשאה למיקרופון או לזיהוי דיבור. אפשר לאשר בהגדרות האתר ב-Chrome.', 8000); finishRecording('fatal'); }
      if (s.kind === 'need-tap') { const b = $('#rec-resume'); if (b) b.hidden = false; if (st) st.textContent = 'הזיהוי נעצר וממתין לנגיעה'; if (car) VO.beep('alert'); }
      if (s.kind === 'unavailable') switchToDictation(s.reason);
      if (s.kind === 'end-phrase' || s.kind === 'silence-stop') finishRecording(s.kind);
      if (s.kind === 'mic') { const m = $('#rec-mic'); if (m) m.textContent = 'מיקרופון: ' + (s.label || 'לא ידוע'); }
      if (s.kind === 'audio' && au) {
        if (s.state === 'recording') au.textContent = 'גם הקול נשמר, מוצפן, ל-30 יום.';
        if (s.state === 'conflict') { au.textContent = conflictText(s.reason); toast('התמלול והקלטת הקול התנגשו. התמלול ממשיך, הקול לא נשמר.', 6000); }
        if (s.state === 'failed') au.textContent = conflictText('getUserMedia-' + (s.reason || 'error'));
      }
    },
  });
  ui.rec = { r, t0: Date.now(), quick: !!opts.quick, auto: !!opts.auto, car };
  if (opts.quick) ui.quick = true;
  go('record');
  try {
    await r.start();
    V.log('rec-path', `live reason=${pathReason} ios=${P.isIOS} standalone=${P.isStandalone()} audio=${settings.recordAudio} car=${car} quick=${!!opts.quick} auto=${!!opts.auto}`);
    if (!opts.auto) {
      // Live recognition worked after an earlier failure (e.g. iOS fixed it): forget the learned fallback.
      setTimeout(async () => { if (r.everStarted && ui.settings.speechFallback) { await V.setSettings({ speechFallback: null }); await refreshSettings(); V.log('rec-path', 'live works again, fallback cleared'); } }, 5000);
    }
    if (car) setTimeout(() => { if (r.everStarted) VO.beep('start'); }, 50);
    const st = $('#rec-status');
    if (st) st.textContent = 'מקשיב…';
  } catch (e) {
    ui.rec = null;
    V.log('rec-start-failed', e.message);
    if (opts.auto) { go('tapstart', {}, 'replace'); return; }
    toast('לא הצלחתי להתחיל הקלטה: ' + e.message);
    go(ui.quick ? 'lock' : 'today', {}, 'replace');
    return;
  }
  ui.rec.timer = setInterval(() => { const el = $('#rec-time'); if (el && ui.rec) el.textContent = mmss(Date.now() - ui.rec.t0); }, 500);
}

// Start whichever input path applies; quick = the diary is locked and the result goes to the inbox.
function startAny(reason, quick) {
  if (quick) ui.quick = true;
  const c = chooseInputPath();
  if (c.mode === 'dictation') return startDictation('', `${c.reason}/${reason}`);
  return startRecording(reason, quick ? { quick: true } : {});
}
// A start without a tap was refused (normal on iOS). Abandon quietly; one tap anywhere starts instead.
async function autoStartRefused(r, s) {
  const rec = ui.rec;
  if (!rec || rec.finishing) return;
  rec.finishing = true;
  clearInterval(rec.timer);
  await r.stop();
  ui.rec = null;
  V.log('auto-start-refused', `${s.kind}:${s.error || s.reason || ''} ios=${P.isIOS} standalone=${P.isStandalone()}`);
  go('tapstart', {}, 'replace');
}

function entryFromRecording(id, createdAt, res, extra = {}) {
  return {
    id, createdAt, dayKey: S.dayKey(createdAt), durationSec: res.durationSec,
    segments: res.segments, rawVersion: 1, tidy: { ...tidy(res.segments), edited: false, fromRawVersion: 1 },
    audioId: null, audioMime: null, audioNote: res.audioConflict || null, photoIds: [], restarts: res.restarts,
    mic: res.micLabel || '', ...extra,
  };
}

async function finishRecording(reason = 'stop') {
  const rec = ui.rec;
  if (!rec || rec.finishing) return null;
  rec.finishing = true;
  clearInterval(rec.timer);
  const st = $('#rec-status');
  if (st) st.textContent = 'שומר…';
  const res = await rec.r.stop();
  ui.rec = null;
  const handsFree = reason === 'end-phrase' || reason === 'silence-stop';
  if (!res.segments.length && !res.audioBlob) {
    V.log('rec-empty', reason);
    if (rec.car) VO.beep('stop');
    if (reason !== 'hidden') { toast('לא נקלט דיבור, ולכן לא נשמר כלום.'); go(rec.quick ? 'quickDone' : 'today', {}, 'replace'); }
    return null;
  }
  const logLine = `reason=${reason} segs=${res.segments.length} restarts=${res.restarts} audio=${res.audioState}${res.audioConflict ? ' conflict=' + res.audioConflict : ''} mic=${res.micLabel ? 'named' : 'default'} trackToRecognizer=${res.trackToRecognizer}`;
  if (rec.quick) {
    // Locked: seal to the inbox public key. Nothing readable is written.
    await V.addToInbox({ createdAt: rec.t0, durationSec: res.durationSec, segments: res.segments, restarts: res.restarts,
      audioMime: res.audioMime || '', audioConflict: res.audioConflict || null, micLabel: res.micLabel || '', via: 'quick' }, res.audioBlob);
    V.log('rec-saved-quick', logLine);
  } else {
    const id = V.uid();
    const e = entryFromRecording(id, rec.t0, res);
    if (res.audioBlob) { const a = await V.saveAudio(id, res.audioBlob, res.audioMime); e.audioId = a.id; e.audioMime = a.mime; }
    await V.saveEntry(e);
    V.log('rec-saved', logLine);
    rec.entryId = id;
  }
  if (rec.car) { VO.beep('stop'); if (ui.settings.spokenCues) setTimeout(() => VO.sayShort('נשמר'), 450); }
  if (reason === 'hidden') return null;
  if (rec.quick) go('quickDone', {}, 'replace');
  else go('entry', { entryId: rec.entryId, entryTab: handsFree ? 'tidy' : 'raw' }, 'replace');
  return true;
}
// ---------------------------------------------------------------- keyboard dictation (iOS Home Screen app, or by choice)
// Must be called inside a tap so the textarea can take focus and raise the keyboard.
function startDictation(why = '', reason = 'chosen') {
  ui.dict = { t0: Date.now(), marks: [], why, quick: !!ui.quick };
  V.log('rec-path', `dictation reason=${reason} ios=${P.isIOS} standalone=${P.isStandalone()}`);
  go('dictate');
  const ta = $('#dict-ta');
  if (ta) ta.focus();
  ui.dict.timer = setInterval(() => { const el = $('#rec-time'); if (el && ui.dict) el.textContent = mmss(Date.now() - ui.dict.t0); }, 500);
}

async function switchToDictation(failReason = 'unknown') {
  const rec = ui.rec;
  if (!rec || rec.finishing) return;
  rec.finishing = true;
  clearInterval(rec.timer);
  await rec.r.stop();
  ui.rec = null;
  await V.setSettings({ speechFallback: { reason: failReason, ua: navigator.userAgent, at: Date.now() } });
  await refreshSettings();
  startDictation('התמלול החי לא עבד כאן, אז עברנו להכתבה. בפעם הבאה היא תיפתח מיד.', 'live-failed:' + failReason);
  toast('התמלול החי לא זמין כאן, אז עוברים להכתבה במקלדת.', 6000);
}

async function finishDictation(reason = 'stop') {
  const d = ui.dict;
  if (!d || d.finishing) return null;
  d.finishing = true;
  clearInterval(d.timer);
  const ta = $('#dict-ta');
  const text = ta ? ta.value : '';
  ui.dict = null;
  const segments = dictationSegments(text, d.marks);
  if (!segments.length) {
    V.log('dictation-empty', reason);
    if (reason !== 'hidden') { toast('לא נכתב כלום, ולכן לא נשמר כלום.'); go('today', {}, 'replace'); }
    return null;
  }
  const id = V.uid();
  const e = {
    id, createdAt: d.t0, dayKey: S.dayKey(d.t0), durationSec: Math.round((Date.now() - d.t0) / 1000),
    segments, rawVersion: 1, tidy: { ...tidy(segments), edited: false, fromRawVersion: 1 },
    audioId: null, audioMime: null, audioNote: null, photoIds: [], restarts: 0, input: 'dictation',
  };
  if (d.quick) {
    await V.addToInbox({ createdAt: e.createdAt, durationSec: e.durationSec, segments, restarts: 0, via: 'quick' }, null);
    V.log('dictation-saved-quick', `reason=${reason} segs=${segments.length}`);
    if (reason !== 'hidden') go('quickDone', {}, 'replace');
    return true;
  }
  await V.saveEntry(e);
  V.log('dictation-saved', `reason=${reason} segs=${segments.length}`);
  if (reason !== 'hidden') go('entry', { entryId: id, entryTab: 'raw' }, 'replace');
  return e;
}

// ---------------------------------------------------------------- writing
function openWrite(ctx) {
  const d = ui.draft;
  // An unsaved draft always wins, so nothing typed earlier is lost.
  if (d && d.text && d.text.trim()) { ui.writeCtx = d.ctx || { mode: 'new' }; ui.writeText = d.text; ui.writeRestored = true; }
  else { ui.writeCtx = ctx; ui.writeText = ''; ui.writeRestored = false; }
  ui.writeFocused = false;
  go('write');
}
function updateWriteCount() {
  const el = $('#write-count');
  if (el) el.textContent = `${(ui.writeText || '').length.toLocaleString('he-IL')} תווים`;
}
let draftTimer = null;
function scheduleDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraftNow, 700);
}
async function saveDraftNow() {
  clearTimeout(draftTimer);
  if (!V.isUnlocked() || ui.screen !== 'write') return;
  const text = ui.writeText || '';
  ui.draft = { text, ctx: ui.writeCtx };
  if (text.trim()) await V.saveDraft(ui.draft); else await V.clearDraft();
  const st = $('#write-state');
  if (st) st.textContent = 'טיוטה נשמרה ' + S.timeOf(Date.now());
}
async function saveWriting() {
  const text = ($('#write-ta') || {}).value || ui.writeText || '';
  const segs = writtenSegments(text);
  if (!segs.length) { toast('אין מה לשמור.'); return; }
  const ctx = ui.writeCtx || { mode: 'new' };
  let id;
  if (ctx.mode === 'append' && vault.entries.get(ctx.entryId)) {
    const e = vault.entries.get(ctx.entryId);
    pushUndo(e);
    const lastT = e.segments.length ? e.segments[e.segments.length - 1].t || 0 : 0;
    e.segments = e.segments.concat(segs.map((s) => ({ ...s, t: lastT })));
    if (e.input !== 'written') e.written = true;
    e.rawVersion = (e.rawVersion || 1) + 1;
    if (!e.tidy.edited) e.tidy = { ...tidyFor(e), edited: false, fromRawVersion: e.rawVersion };
    await V.saveEntry(e);
    id = e.id;
    V.log('write-append', 'chars=' + text.length);
  } else {
    id = V.uid();
    const now = Date.now();
    const e = { id, createdAt: now, dayKey: S.dayKey(now), durationSec: 0, segments: segs, rawVersion: 1, input: 'written',
      tidy: { ...tidyWritten(segs), edited: false, fromRawVersion: 1 }, audioId: null, audioMime: null, audioNote: null, photoIds: [], restarts: 0 };
    await V.saveEntry(e);
    V.log('write-new', 'chars=' + text.length);
  }
  await V.clearDraft();
  ui.draft = null;
  ui.writeText = '';
  go('entry', { entryId: id, entryTab: 'tidy' }, 'replace');
  toast('נשמר.');
}

// The visible viewport shrinks when the iOS keyboard opens; the writing screen follows it.
if (window.visualViewport) {
  const vv = window.visualViewport;
  const fit = () => {
    document.documentElement.style.setProperty('--vvh', vv.height + 'px');
    document.documentElement.style.setProperty('--vvtop', vv.offsetTop + 'px');
  };
  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);
  fit();
}
// ---------------------------------------------------------------- photos
function getPosition() {
  return new Promise((res) => {
    if (!navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition(
      (p) => res({ lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6) }),
      (err) => { V.log('geo-failed', err.code); res(null); },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 120000 });
  });
}
async function toJpeg(bmp, max, q) {
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(bmp.img || bmp, 0, 0, w, h);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', q));
  return { blob, w, h };
}
function decodeViaImg(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); res({ width: img.naturalWidth, height: img.naturalHeight, img, close() {} }); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('img-decode')); };
    img.src = url;
  });
}
async function processPhoto(file, source, target) {
  const buf = await file.arrayBuffer();
  const ex = parseExif(buf);
  let lat = null, lng = null, locSource = null;
  if (source === 'camera') { const p = await getPosition(); if (p) { ({ lat, lng } = p); locSource = 'gps'; } }
  if (lat == null && ex.lat != null) { lat = ex.lat; lng = ex.lng; locSource = 'exif'; }
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch (e) {
    // Fallback through <img>: Safari decodes some formats (e.g. HEIC) only this way.
    try { bmp = await decodeViaImg(file); }
    catch (e2) { V.log('photo-decode-failed', file.type); throw Object.assign(new Error('decode'), { code: 'decode' }); }
  }
  const full = await toJpeg(bmp, 2048, 0.85);
  const thumb = await toJpeg(bmp, 360, 0.8);
  if (bmp.close) bmp.close();
  const p = await V.savePhoto({
    dayKey: target.dayKey, entryId: target.entryId || null, createdAt: Date.now(),
    takenAt: ex.takenAt || (source === 'camera' ? Date.now() : null), lat, lng, locSource, source, w: full.w, h: full.h,
  }, full.blob, thumb.blob);
  if (target.entryId) {
    const e = vault.entries.get(target.entryId);
    if (e) { e.photoIds = [...(e.photoIds || []), p.id]; await V.saveEntry(e); }
  }
  V.log('photo-saved', `${source} loc=${locSource || 'none'} exifgps=${ex.lat != null} type=${file.type}`);
  return p;
}
for (const [id, source] of [['pick-camera', 'camera'], ['pick-gallery', 'gallery']]) {
  document.getElementById(id).addEventListener('change', async (ev) => {
    const files = [...ev.target.files];
    const target = ui.photoTarget;
    ui.external = false;
    if (!files.length || !target || !V.isUnlocked()) return;
    let ok = 0, noLoc = 0;
    toast('שומר תמונה…');
    for (const f of files) {
      try { const p = await processPhoto(f, source, target); ok++; if (p.lat == null) noLoc++; }
      catch (e) { toast(e.code === 'decode' ? 'לא הצלחתי לפתוח את התמונה. אולי הפורמט לא נתמך (למשל HEIC).' : 'שמירת התמונה נכשלה.'); }
    }
    const tip = noLoc && source === 'gallery' && P.isIOS ? ' באייפון: בבחירת תמונה לחץ "אפשרויות" למעלה והפעל "מיקום".' : '';
    if (ok) toast((ok === 1 ? (noLoc ? 'התמונה נשמרה, בלי מיקום.' : 'התמונה נשמרה עם מיקום.') : `נשמרו ${ok} תמונות${noLoc ? `, ל-${noLoc} מהן אין מיקום` : ''}.`) + tip, tip ? 9000 : 4500);
    render();
  });
}

// ---------------------------------------------------------------- share / copy / file
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e2) { /* ignore */ }
    ta.remove();
    return ok;
  }
}
function downloadBlob(blob, name) {
  ui.external = true;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); ui.external = false; }, 4000);
}
function withLocations(text, photos) {
  const locs = photos.filter((p) => p.lat != null).map((p, i) => `מיקום תמונה ${i + 1}: ${mapsUrl(p.lat, p.lng)}`);
  return locs.length ? `${text}\n\n${locs.join('\n')}` : text;
}
// Very long texts get cut by share targets (and by Android's intent size), so they go as a .txt file.
async function shareLongText(title, full) {
  const file = new File([full], 'yoman.txt', { type: 'text/plain' });
  V.log('share-long', 'chars=' + full.length);
  if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
    ui.external = true;
    try { await navigator.share({ title, files: [file] }); V.log('share', 'long as file'); return; }
    catch (e) { if (e.name === 'AbortError') return; V.log('share-failed', e.name); }
    finally { setTimeout(() => { ui.external = false; }, 1500); }
  }
  downloadBlob(file, 'yoman.txt');
  toast(`הטקסט ארוך (${full.length.toLocaleString('he-IL')} תווים), ולכן הוא נשמר כקובץ טקסט בהורדות במקום להישלח כהודעה.`, 7000);
}async function shareContent({ title, text, photos = [] }) {
  const full = withLocations(text, photos);
  if (full.length > SHARE_TEXT_MAX) return shareLongText(title, full);
  if (navigator.share) {
    const data = { title, text: full };
    if (photos.length) {
      const files = [];
      for (const [i, p] of photos.slice(0, 10).entries()) {
        const b = await V.blobBytes(p.blobId);
        if (b) files.push(new File([b], `photo-${i + 1}.jpg`, { type: 'image/jpeg' }));
      }
      if (files.length && navigator.canShare && navigator.canShare({ files })) data.files = files;
    }
    ui.external = true;
    try { await navigator.share(data); V.log('share', 'ok files=' + (data.files ? data.files.length : 0)); return; }
    catch (e) { if (e.name === 'AbortError') return; V.log('share-failed', e.name); }
    finally { setTimeout(() => { ui.external = false; }, 1500); }
  }
  const ok = await copyText(full);
  toast(ok ? 'שיתוף לא זמין כאן, אז הטקסט הועתק. אפשר להדביק אותו בכל אפליקציה.' : 'שיתוף לא זמין. אפשר להוריד את הטקסט כקובץ בכפתור ההורדה.', 6000);
}

// ---------------------------------------------------------------- lock / unlock
let lastActivity = Date.now();
['pointerdown', 'keydown', 'touchstart', 'scroll'].forEach((ev) => addEventListener(ev, () => { lastActivity = Date.now(); }, { passive: true, capture: true }));

async function doLock(reason) {
  if (!V.isUnlocked()) return;
  if (ui.screen === 'write') { try { await saveDraftNow(); } catch (e) { V.log('draft-save-failed', e.message); } }
  if (ui.reader) ui.reader.stop();
  V.lock();
  ui.undo.clear();
  ui.sd = null;
  ui.quick = false;
  ui.hasInbox = await V.hasInboxKey();
  ui.prfMeta = (await V.prfInfo()) || null;
  ui.hasPrf = !!ui.prfMeta;
  V.log('lock', reason);
  go('lock', {}, 'replace');
}
async function afterUnlock(how) {
  V.log('unlock', how);
  await refreshSettings();
  V.storageInfo().then((s) => { if (s.persisted === false) V.requestPersist().then((r) => V.log('persist-on-unlock', String(r))); });
  lastActivity = Date.now();
  ui.quick = false;
  ui.draft = await V.getDraft().catch(() => null);
  ui.hasInbox = await V.hasInboxKey();
  const n = await V.drainInbox(async (p, audio) => {
    const id = V.uid();
    const e = entryFromRecording(id, p.createdAt, { segments: p.segments || [], durationSec: p.durationSec || 0, restarts: p.restarts || 0, audioConflict: p.audioConflict, micLabel: p.micLabel }, { via: p.via || 'quick' });
    if (audio && audio.length) { const a = await V.saveAudio(id, new Blob([audio], { type: p.audioMime || 'audio/mp4' }), p.audioMime); e.audioId = a.id; e.audioMime = a.mime; }
    await V.saveEntry(e);
  });
  if (n) { V.log('inbox-drained', String(n)); toast(n === 1 ? 'הקלטה מהירה אחת נכנסה ליומן.' : `${n} הקלטות מהירות נכנסו ליומן.`); }
  if (ui.pendingRec) { ui.pendingRec = false; go('today', {}, 'replace'); startRecording('rec-link-after-unlock', { auto: true }); return; }
  go('today', {}, 'replace');
}

setInterval(async () => {
  if (!V.isUnlocked() || ui.rec || ui.dict || ui.external) return;
  const s = ui.settings;
  if (Date.now() - lastActivity > s.autolockMin * 60000) doLock('idle');
}, 10000);

let hiddenAt = 0;
document.addEventListener('visibilitychange', async () => {
  if (document.hidden) {
    hiddenAt = Date.now();
    if (ui.rec && ui.rec.quick) { await finishRecording('hidden'); return; }
    if (ui.dict && ui.dict.quick) { await finishDictation('hidden'); return; } // locked quick capture: seal what was said
    if (!V.isUnlocked() || ui.external) return;
    if (ui.rec) { await finishRecording('hidden'); }
    if (ui.dict) { await finishDictation('hidden'); }
    doLock('background');
  } else if (ui.external) {
    if (Date.now() - hiddenAt > 5 * 60000) { ui.external = false; doLock('background-long'); return; }
    setTimeout(() => { ui.external = false; }, 2000); // the picker/share sheet was cancelled
  }
});

// ---------------------------------------------------------------- actions
// ---------------------------------------------------------------- read aloud
async function readAloud(src) {
  if (!VO.ttsSupported()) { toast('הדפדפן הזה לא יודע להקריא.'); return; }
  let title = '', text = '';
  if (src === 'entry') {
    const e = vault.entries.get(ui.entryId);
    if (!e) return;
    title = e.tidy.title;
    text = e.tidy.paragraphs.join('\n');
  } else {
    title = periodLabel(ui.sumKind, ui.sumKey);
    text = summaryText(ui.sumKind, ui.sumKey);
  }
  if (!text.trim()) { toast('אין מה להקריא.'); return; }
  // Start speaking inside the tap when voices are already known (iOS needs the gesture).
  if (!VO.hebrewVoices().length) await VO.waitForVoices();
  const v = VO.pickVoice();
  if (!v) { toast(P.isIOS ? 'לא נמצא קול עברי. אפשר להוסיף בהגדרות > נגישות > תוכן מוקרא > קולות > עברית.' : 'לא נמצא קול עברי בטלפון. אפשר להתקין "עברית" בהגדרות הטקסט לדיבור של אנדרואיד.', 9000); }
  else if (!v.localService) { toast(`הקול העברי כאן נוצר בשרת של ${P.speechVendor}. הטקסט נשלח אליו כדי להקריא אותו.`, 7000); }
  if (!ui.reader) ui.reader = new VO.Reader({ onState: () => renderPlayer() });
  ui.reader.rate = ui.settings.ttsRate || 1;
  ui.reader.load(text, title);
  ui.reader.label = title;
  ui.reader.play();
  V.log('tts', `src=${src} voice=${v ? (v.localService ? 'local' : 'network') : 'none'}`);
  renderPlayer();
}

function renderPlayer() {
  const pl = $('#player');
  const r = ui.reader;
  if (!pl) return;
  if (!r || (r.state === 'idle' && r.i === 0 && !r.chunks.length)) { pl.hidden = true; return; }
  pl.hidden = false;
  const playing = r.state === 'playing';
  pl.innerHTML = `<div class="player-in">
    <button class="round" data-pact="tts-toggle" aria-label="${playing ? 'השהה' : 'המשך'}">${playing ? '<span class="pause-ic" aria-hidden="true"></span>' : '<span class="play-ic" aria-hidden="true"></span>'}</button>
    <div class="player-txt"><b>${esc(r.label || 'הקראה')}</b><span>${r.state === 'idle' ? 'הסתיים' : `קטע ${Math.min(r.i + 1, r.chunks.length)} מתוך ${r.chunks.length}`}</span></div>
    <button class="chip" data-pact="tts-rate" aria-label="מהירות">×${ui.settings.ttsRate || 1}</button>
    <button class="chip" data-pact="tts-stop">עצור</button></div>`;
}
document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-pact]');
  if (el) ACTIONS[el.dataset.pact](el, ev);
});
async function enrollFlow(el, fn) {
  try {
    const r = await busy(el, 'ממתין לאישור בטלפון…', fn);
    await V.enrollPrf(r);
    ui.bioPending = null;
    ui.hasPrf = true;
    ui.prfMeta = await V.prfInfo();
    V.log('prf-enrolled', `path=${r.path} enabled=${r.enabledFlag}`);
    toast(`מעכשיו אפשר לפתוח ב-${P.biometricName}.`);
  } catch (e) {
    if (e.code === 'needs-second-tap') {
      ui.bioPending = e.pending;
      V.log('prf-needs-second-tap', 'enabled=' + e.pending.enabledFlag);
      ui.sd = null;
      render();
      return;
    }
    ui.bioPending = null;
    if (e.code === 'prf-unsupported') {
      V.log('prf-unsupported', 'enabled=' + e.enabledFlag);
      toast(`מפתח הגישה נוצר, אבל הטלפון לא מחזיר ממנו מפתח הצפנה (PRF). בלי זה ${P.biometricName} לא יכולים לפתוח יומן מוצפן, ולכן הכניסה נשארת בסיסמה.${P.isIOS ? ' צריך iOS 18 ומעלה ו"סיסמאות" של iCloud.' : ' אפשר לנסות שוב ולבחור במנהל הסיסמאות של Google.'}`, 12000);
    } else if (e.name === 'NotAllowedError') {
      V.log('prf-enroll-cancelled', e.name);
      toast('הרישום בוטל.');
    } else {
      V.log('prf-enroll-failed', `${e.name}: ${e.message}`);
      toast('הרישום נכשל: ' + (e.name || e.message));
    }
  }
  if (ui.screen === 'bioOffer') go('today', {}, 'replace'); else { ui.sd = null; render(); }
}

const ACTIONS = {  'restore-mode': () => { ui.restoreMode = true; render(); },
  'restore-mode-off': () => { ui.restoreMode = false; render(); },
  tab: (el) => { if (el.dataset.to === 'settings') ui.sd = null; go(el.dataset.to); },
  back: () => history.back(),
  record: () => { const c = chooseInputPath(); return c.mode === 'dictation' ? startDictation('', c.reason) : startRecording(c.reason); },
  'write-new': () => openWrite({ mode: 'new' }),
  'write-append': () => openWrite({ mode: 'append', entryId: ui.entryId }),
  'write-save': (el) => busy(el, 'שומר…', saveWriting),
  'write-cancel': async () => { await saveDraftNow(); const ctx = ui.writeCtx || {}; if ((ui.writeText || '').trim()) toast('הטיוטה נשמרה. היא תיפתח בפעם הבאה שתלחץ "כתוב".'); if (ctx.mode === 'append') go('entry', { entryId: ctx.entryId, entryTab: 'raw' }, 'replace'); else go('today', {}, 'replace'); },
  'write-discard': async () => {
    if (ui.confirm !== 'write-discard') { ui.confirm = 'write-discard'; ui.writeText = ($('#write-ta') || {}).value || ''; render(); return; }
    await V.clearDraft(); ui.draft = null; ui.writeText = ''; ui.confirm = null; ui.writeRestored = false; ui.writeFocused = false; render();
  },
  'more-words': () => { ui.wordLimit = (ui.wordLimit || WORD_PAGE) + WORD_PAGE; render(); },
  'fs-toggle': (el) => { const f = el.closest('form'); if (!f) return; f.classList.toggle('fs'); el.textContent = f.classList.contains('fs') ? 'צמצם' : 'מסך מלא'; const ta = f.querySelector('textarea'); if (ta) { if (f.classList.contains('fs')) ta.style.height = ''; else grow(ta); ta.focus(); } },  'tap-start': () => startAny('tap-after-refused-auto', !V.isUnlocked()),
  'quick-rec': () => startAny('quick-button', true),
  'quick-exit': () => { ui.quick = false; go('lock', {}, 'replace'); },
  'tts-play': (el) => readAloud(el.dataset.src),
  'tts-toggle': () => { const r = ui.reader; if (!r) return; if (r.state === 'playing') r.pause(); else if (r.state === 'paused') r.resume(); else r.play(); },
  'tts-stop': () => { if (ui.reader) ui.reader.stop(); const pl = $('#player'); if (pl) pl.hidden = true; },
  'tts-rate': async () => {
    const rates = [0.8, 1, 1.25, 1.5];
    const next = rates[(rates.indexOf(ui.settings.ttsRate || 1) + 1) % rates.length];
    await V.setSettings({ ttsRate: next }); await refreshSettings();
    if (ui.reader) ui.reader.setRate(next);
    renderPlayer();
  },
  'mics-load': async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true }); // labels appear only after permission
      s.getTracks().forEach((t) => t.stop());
      ui.mics = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
      V.log('mics', String(ui.mics.length));
    } catch (e) { toast('לא הצלחתי לקבל את רשימת המיקרופונים: ' + (e.name || e.message)); }
    ui.sd = null; render();
  },
  'copy-quick-url': async () => { const ok = await copyText(QUICK_URL); toast(ok ? 'הכתובת הועתקה.' : 'ההעתקה לא הצליחה. אפשר לסמן את הכתובת ולהעתיק.'); },  'retry-live': async () => { await V.setSettings({ speechFallback: null, inputMode: 'auto' }); await refreshSettings(); ui.sd = null; render(); toast('בהקלטה הבאה ננסה שוב תמלול חי.'); },
  'stop-dict': (el) => { el.disabled = true; finishDictation('stop'); },
  'rec-resume': (el) => { el.hidden = true; if (ui.rec) ui.rec.r.resume(); const st = $('#rec-status'); if (st) st.textContent = 'מקשיב…'; },
  'stop-rec': (el) => { el.disabled = true; finishRecording('stop'); },
  'open-entry': (el) => go('entry', { entryId: el.dataset.id, entryTab: el.dataset.tab }),
  'entry-tab': (el) => { ui.entryTab = el.dataset.tab; Object.assign(ui, TRANSIENT); history.replaceState({ ...history.state, entryTab: ui.entryTab }, ''); render(); },
  'lib-tab': (el) => { ui.libTab = el.dataset.tab; history.replaceState({ ...history.state, libTab: ui.libTab }, ''); render(); },
  word: (el) => { ui.word = { s: +el.dataset.s, w: +el.dataset.w, mode: 'edit' }; render(); },
  'word-close': () => { ui.word = null; render(); },
  'word-mode': (el) => { ui.word.mode = el.dataset.mode; render(); },
  'word-replace': () => wordOp('replace'),
  'word-delete': () => wordOp('delete'),
  'word-add-do': () => wordOp('add'),
  undo: async () => {
    const e = vault.entries.get(ui.entryId);
    const st = ui.undo.get(e.id) || [];
    if (!st.length) return;
    Object.assign(e, JSON.parse(st.pop()));
    await V.saveEntry(e);
    ui.word = null;
    render();
    toast('הפעולה האחרונה בוטלה.');
  },
  'free-edit': () => { ui.freeEdit = !ui.freeEdit; ui.word = null; render(); },
  'free-cancel': () => { ui.freeEdit = false; render(); },
  'tidy-edit': () => { ui.tidyEdit = true; render(); },
  'tidy-cancel': () => { ui.tidyEdit = false; render(); },
  regen: () => {
    const e = vault.entries.get(ui.entryId);
    if (e.tidy.edited) { ui.confirm = 'regen'; render(); return; }
    regenerate(e);
  },
  'regen-yes': () => regenerate(vault.entries.get(ui.entryId)),
  'confirm-cancel': () => { ui.confirm = null; render(); },
  'del-entry': () => { ui.confirm = 'del-entry'; render(); },
  'del-entry-yes': async () => { await V.deleteEntry(ui.entryId); ui.confirm = null; toast('ההקלטה נמחקה.'); go('today', {}, 'replace'); },
  'share-entry': () => {
    const e = vault.entries.get(ui.entryId);
    shareContent({ title: e.tidy.title, text: tidyText(e.tidy), photos: (e.photoIds || []).map((id) => vault.photos.get(id)).filter(Boolean) });
  },
  photo: (el) => {
    ui.photoTarget = { dayKey: el.dataset.day, entryId: el.dataset.entry || null };
    ui.external = true;
    const inp = document.getElementById(el.dataset.src === 'camera' ? 'pick-camera' : 'pick-gallery');
    inp.value = '';
    inp.click();
  },
  'photo-view': (el) => { ui.viewPhoto = el.dataset.id; render(); },
  'viewer-close': () => { ui.viewPhoto = null; render(); },
  'photo-del': async (el) => {
    const id = el.dataset.id;
    if (ui.confirm !== 'photo:' + id) { ui.confirm = 'photo:' + id; render(); return; }
    const p = vault.photos.get(id);
    if (p && p.entryId) { const e = vault.entries.get(p.entryId); if (e) { e.photoIds = (e.photoIds || []).filter((x) => x !== id); await V.saveEntry(e); } }
    await V.deletePhoto(id);
    ui.confirm = null;
    render();
  },
  'open-sum': (el) => go('summaries', { sumKind: el.dataset.kind, sumKey: el.dataset.key }),
  'sum-kind': (el) => { ui.sumKind = el.dataset.kind; ui.sumKey = defaultKey(ui.sumKind); Object.assign(ui, TRANSIENT); render(); },
  'sum-nav': (el) => {
    const d = +el.dataset.dir, k = ui.sumKey;
    ui.sumKey = ui.sumKind === 'day' ? S.addDays(k, d) : ui.sumKind === 'week' ? S.addDays(k, 7 * d) : S.addMonths(k, d);
    Object.assign(ui, TRANSIENT);
    render();
  },
  'sum-edit': () => { ui.sumEdit = true; render(); },
  'sum-cancel': () => { ui.sumEdit = false; render(); },
  'sum-rebuild': () => { ui.confirm = 'sum-rebuild'; render(); },
  'sum-rebuild-yes': async () => { await V.deleteSummary(S.summaryId(ui.sumKind, ui.sumKey)); ui.confirm = null; render(); toast('הסיכום נבנה מחדש.'); },
  'share-sum': () => {
    const label = periodLabel(ui.sumKind, ui.sumKey);
    const kindName = { day: 'סיכום יומי', week: 'סיכום שבועי', month: 'סיכום חודשי' }[ui.sumKind];
    shareContent({ title: `${kindName} · ${label}`, text: `${kindName} · ${label}\n\n${summaryText(ui.sumKind, ui.sumKey)}`, photos: photosOfDays(daysOf(ui.sumKind, ui.sumKey)) });
  },
  'copy-sum': async () => {
    const label = periodLabel(ui.sumKind, ui.sumKey);
    const ok = await copyText(withLocations(`${label}\n\n${summaryText(ui.sumKind, ui.sumKey)}`, photosOfDays(daysOf(ui.sumKind, ui.sumKey))));
    toast(ok ? 'הועתק.' : 'ההעתקה לא הצליחה.');
  },
  'file-sum': () => {
    const label = periodLabel(ui.sumKind, ui.sumKey);
    const text = withLocations(`${label}\n\n${summaryText(ui.sumKind, ui.sumKey)}`, photosOfDays(daysOf(ui.sumKind, ui.sumKey)));
    downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), `summary-${ui.sumKind}-${ui.sumKey}.txt`);
  },
  'bio-enroll': (el) => enrollFlow(el, () => W.enroll()),
  'bio-finish': (el) => enrollFlow(el, () => W.finishEnroll(ui.bioPending)),
  'bio-remove': () => { ui.confirm = 'bio-remove'; render(); },
  'bio-remove-yes': async () => { await V.removePrf(); ui.hasPrf = false; ui.prfMeta = null; ui.confirm = null; ui.sd = null; V.log('prf-removed'); render(); },
  'bio-unlock': async (el) => {
    const form = el.closest('form');
    const p = ui.prfMeta;
    if (!p) { showErr(form, 'הפתיחה הביומטרית לא מוגדרת. היכנס בסיסמה.'); return; }
    try {
      // Called directly inside the tap: Safari refuses WebAuthn calls that come after an await.
      const prf = await busy(el, '…', () => W.evaluate(p.credId, p.prfSalt));
      if (!prf) { V.log('prf-missing-on-get'); showErr(form, 'הטלפון לא החזיר את מפתח ההצפנה. היכנס בסיסמה.'); return; }
      await V.unlockWithPrf(prf);
      afterUnlock('biometric');
    } catch (e) {
      V.log('bio-unlock-failed', e.name || e.message);
      showErr(form, e.name === 'NotAllowedError' ? 'הזיהוי בוטל או לא הצליח. אפשר לנסות שוב או להקליד סיסמה.' : 'הפתיחה הביומטרית נכשלה. היכנס בסיסמה.');
    }
  },
  'lock-now': () => doLock('manual'),
  persist: async () => { const r = await V.requestPersist(); V.log('persist', String(r)); toast(r ? 'האחסון הקבוע אושר.' : 'הדפדפן לא אישר עדיין. התקנת היומן כאפליקציה בדרך כלל עוזרת.'); ui.sd = null; render(); },
  'copy-log': async () => { const ok = await copyText((await V.getLog()).map((l) => `${new Date(l.t).toISOString()} ${l.ev} ${l.detail}`).join('\n')); toast(ok ? 'הועתק.' : 'ההעתקה לא הצליחה.'); },
};

const FORMS = {
  async setup(form, btn) {
    const pw1 = $('#pw1').value, pw2 = $('#pw2').value;
    if (!$('#agree').checked) return showErr(form, 'צריך לסמן שקראת את ההסבר.');
    if (pw1.length < 8) return showErr(form, 'הסיסמה קצרה מדי. צריך לפחות 8 תווים.');
    if (pw1 !== pw2) return showErr(form, 'שתי הסיסמאות לא זהות.');
    await busy(btn, 'יוצר יומן מוצפן…', () => V.createVault(pw1));
    ui.hasVault = true;
    const persisted = await V.requestPersist();
    V.log('setup', 'persist=' + persisted);
    const caps = await W.capabilities();
    go(caps.platform ? 'bioOffer' : 'today', {}, 'replace');
  },
  async 'setup-restore'(form, btn) {
    const file = $('#restore-file').files[0], pw = $('#restore-pw').value;
    if (!$('#agree2').checked) return showErr(form, 'צריך לסמן שקראת את ההסבר.');
    if (!file || !pw) return showErr(form, 'צריך לבחור קובץ ולהקליד את סיסמת הגיבוי.');
    try {
      const n = await busy(btn, 'משחזר…', async () => {
        const payload = await V.readBackup(await file.text(), pw);
        await V.createVault(pw);
        await V.importBackup(payload, 'replace');
        return (payload.entries || []).length;
      });
      ui.hasVault = true;
      V.log('setup-restore', 'entries=' + n);
      await V.requestPersist();
      toast(`שוחזרו ${n} הקלטות.`);
      go('today', {}, 'replace');
    } catch (e) {
      showErr(form, e.code === 'bad-password' ? 'הסיסמה לא פותחת את הגיבוי.' : e.code === 'not-backup' ? 'זה לא קובץ גיבוי של היומן.' : 'השחזור נכשל.');
    }
  },
  async unlock(form, btn) {
    const pw = $('#pw').value;
    if (!pw) return showErr(form, 'צריך להקליד סיסמה.');
    try { await busy(btn, 'פותח…', () => V.unlockWithPassword(pw)); afterUnlock('password'); }
    catch (e) { V.log('unlock-failed', e.code || e.name); showErr(form, e.code === 'bad-password' ? 'הסיסמה לא נכונה.' : 'הפתיחה נכשלה.'); }
  },
  async 'free-edit'() {
    const e = vault.entries.get(ui.entryId);
    const lines = $('#free-ta').value.split('\n').map((l) => l.trim().replace(/\s+/g, ' ')).filter(Boolean);
    pushUndo(e);
    const old = e.segments;
    e.segments = lines.map((text, i) => ({ text, t: old[i] ? old[i].t : (old.length ? old[old.length - 1].t : 0) }));
    e.rawVersion = (e.rawVersion || 1) + 1;
    await V.saveEntry(e);
    ui.freeEdit = false;
    render();
  },
  async 'tidy-edit'() {
    const e = vault.entries.get(ui.entryId);
    pushUndo(e);
    e.tidy = { ...e.tidy, title: $('#tidy-title').value.trim() || e.tidy.title, paragraphs: $('#tidy-ta').value.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean), edited: true };
    await V.saveEntry(e);
    ui.tidyEdit = false;
    render();
  },
  async 'sum-edit'() {
    await V.saveSummary({ id: S.summaryId(ui.sumKind, ui.sumKey), kind: ui.sumKind, key: ui.sumKey, text: $('#sum-ta').value.trim(), edited: true, editedAt: Date.now() });
    ui.sumEdit = false;
    render();
  },
  async 'change-pw'(form, btn) {
    const o = $('#cp-old').value, n1 = $('#cp-new').value, n2 = $('#cp-new2').value;
    if (n1.length < 8) return showErr(form, 'הסיסמה החדשה קצרה מדי.');
    if (n1 !== n2) return showErr(form, 'הסיסמאות החדשות לא זהות.');
    try { await busy(btn, 'מחליף…', () => V.changePassword(o, n1)); V.log('password-changed'); form.reset(); toast('הסיסמה הוחלפה.'); }
    catch (e) { showErr(form, e.code === 'bad-password' ? 'הסיסמה הנוכחית לא נכונה.' : 'ההחלפה נכשלה.'); }
  },
  async backup(form, btn) {
    const pw = $('#bk-pw').value;
    if (pw.length < 8) return showErr(form, 'צריך סיסמה של לפחות 8 תווים לגיבוי.');
    const blob = await busy(btn, 'מכין גיבוי…', () => V.exportBackup(pw));
    downloadBlob(blob, `yoman-backup-${today()}.json`);
    V.log('backup', String(blob.size));
    await V.setSettings({ lastBackupAt: Date.now() });
    await refreshSettings();
    toast('קובץ הגיבוי נשמר בהורדות.');
  },
  async restore(form, btn) {
    const file = $('#rs-file').files[0], pw = $('#rs-pw').value, mode = $('#rs-mode').value;
    if (!file || !pw) return showErr(form, 'צריך לבחור קובץ ולהקליד את סיסמת הגיבוי.');
    try {
      const n = await busy(btn, 'משחזר…', async () => { const p = await V.readBackup(await file.text(), pw); await V.importBackup(p, mode); return (p.entries || []).length; });
      V.log('restore', `mode=${mode} entries=${n}`);
      toast(`שוחזרו ${n} הקלטות.`);
      ui.sd = null;
      render();
    } catch (e) {
      showErr(form, e.code === 'bad-password' ? 'הסיסמה לא פותחת את הגיבוי.' : e.code === 'not-backup' ? 'זה לא קובץ גיבוי של היומן.' : 'השחזור נכשל.');
    }
  },
};

const CHANGES = {
  autolock: async (el) => { await V.setSettings({ autolockMin: +el.value }); await refreshSettings(); toast(`נעילה אחרי ${el.value} דקות.`); },
  'rec-audio': async (el) => { await V.setSettings({ recordAudio: el.checked }); await refreshSettings(); },
  'car-mode': async (el) => { await V.setSettings({ carMode: el.checked }); await refreshSettings(); ui.sd = null; render(); },
  'end-phrase': async (el) => { await V.setSettings({ endPhrase: el.value.trim() }); await refreshSettings(); toast(el.value.trim() ? `מילת הסיום: "${el.value.trim()}"` : 'מילת הסיום כבויה.'); },
  'silence-stop': async (el) => { await V.setSettings({ silenceStopSec: +el.value }); await refreshSettings(); },
  'spoken-cues': async (el) => { await V.setSettings({ spokenCues: el.checked }); await refreshSettings(); },
  mic: async (el) => { await V.setSettings({ micDeviceId: el.value }); await refreshSettings(); toast(el.value ? 'המיקרופון נבחר. הוא ישמש להקלטת הקול, ואם הדפדפן מאפשר, גם לתמלול.' : 'חזרה למיקרופון ברירת המחדל.'); },
  'quick-capture': async (el) => { await V.setSettings({ quickCapture: el.checked }); await refreshSettings(); V.log('quick-capture', String(el.checked)); },  'input-mode': async (el) => { await V.setSettings({ inputMode: el.value, ...(el.value === 'auto' ? { speechFallback: null } : {}) }); await refreshSettings(); },
  'audio-keep': async (el) => { await V.setAudioKeep(el.dataset.id, el.checked); render(); toast(el.checked ? 'הקול יישמר לתמיד.' : 'הקול יימחק 30 יום אחרי ההקלטה.'); },
};

app.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = ACTIONS[el.dataset.act];
  if (fn) { ev.preventDefault(); Promise.resolve(fn(el, ev)).catch((e) => { V.log('action-failed', `${el.dataset.act}: ${e.message}`); toast('משהו נכשל: ' + e.message); }); }
});
app.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const form = ev.target;
  const fn = FORMS[form.dataset.form];
  if (fn) Promise.resolve(fn(form, form.querySelector('[type=submit]'))).catch((e) => { V.log('form-failed', `${form.dataset.form}: ${e.message}`); showErr(form, 'משהו נכשל: ' + e.message); });
});
app.addEventListener('input', (ev) => {
  if (ev.target.id === 'write-ta') { ui.writeText = ev.target.value; updateWriteCount(); scheduleDraft(); lastActivity = Date.now(); return; }
  if (ev.target.classList && ev.target.classList.contains('grow') && !ev.target.closest('form.fs')) grow(ev.target);
  if (ev.target.id === 'dict-ta' && ui.dict) { ui.dict.marks.push({ len: ev.target.value.length, t: Date.now() - ui.dict.t0 }); lastActivity = Date.now(); }
});
app.addEventListener('change', (ev) => {
  const fn = CHANGES[ev.target.dataset.change];
  if (fn) fn(ev.target);
});
app.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && ev.target.id === 'word-input') { ev.preventDefault(); wordOp(ui.word && ui.word.mode === 'add' ? 'add' : 'replace'); }
  if (ev.key === 'Escape' && ui.word) { ui.word = null; render(); }
});

// ---------------------------------------------------------------- boot
async function boot() {
  buildKoru(document.getElementById('sprite'));
  if ('serviceWorker' in navigator && !TEST_DB) navigator.serviceWorker.register('./sw.js').catch((e) => V.log('sw-failed', e.message));
  ui.hasVault = await V.hasVault();
  await refreshSettings();
  ui.prfMeta = (await V.prfInfo()) || null;
  ui.hasPrf = !!ui.prfMeta;
  ui.hasInbox = await V.hasInboxKey();
  VO.waitForVoices();
  document.body.insertAdjacentHTML('beforeend', '<div id="player" class="player" hidden></div>');
  // ?rec=1 (Siri shortcut / home-screen shortcut): start recording right away. Remove it from the address first.
  const wantRec = new URLSearchParams(location.search).get('rec') === '1';
  if (wantRec) history.replaceState(null, '', location.pathname);
  if (wantRec && ui.hasVault && ui.settings.quickCapture && ui.hasInbox) {
    ui.quick = true;
    V.log('rec-link', 'quick capture while locked');
    startRecording('rec-link', { quick: true, auto: true });
    return;
  }
  if (wantRec && ui.hasVault) { ui.pendingRec = true; V.log('rec-link', 'locked, recording starts after unlock'); }
  go(ui.hasVault ? 'lock' : 'setup', {}, 'replace');
}
if (TEST_DB) window.__app = { V, ui, go, render, S, VO, readAloud, SHARE_TEXT_MAX, WORD_PAGE };
boot();
