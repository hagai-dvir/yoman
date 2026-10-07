// Date keys and rule-based summaries. Weekly and monthly summaries are built from daily summaries.
import { tidyText } from './tidy.js';

const pad = (n) => String(n).padStart(2, '0');
export const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
export const DAY_LETTERS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];
export const MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

export function dayKey(d) {
  d = new Date(d);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function parseDay(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function addDays(key, n) {
  const d = parseDay(key);
  d.setDate(d.getDate() + n);
  return dayKey(d);
}
// Weeks start on Sunday.
export function weekStart(key) {
  const d = parseDay(key);
  return addDays(key, -d.getDay());
}
export function monthKey(key) {
  return key.slice(0, 7);
}
export function addMonths(mKey, n) {
  const [y, m] = mKey.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}
export function daysOfMonth(mKey) {
  const [y, m] = mKey.split('-').map(Number);
  const n = new Date(y, m, 0).getDate();
  return Array.from({ length: n }, (_, i) => `${mKey}-${pad(i + 1)}`);
}
export const short = (key) => { const d = parseDay(key); return `${d.getDate()}.${d.getMonth() + 1}`; };
export const longDate = (key) => { const d = parseDay(key); return `יום ${DAY_NAMES[d.getDay()]}, ${d.getDate()} ב${MONTHS[d.getMonth()]}`; };
export const timeOf = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const weekLabel = (wKey) => `${short(wKey)} – ${short(addDays(wKey, 6))}`;
export const monthLabel = (mKey) => { const [y, m] = mKey.split('-').map(Number); return `${MONTHS[m - 1]} ${y}`; };

export function summaryId(kind, key) { return `${kind}:${key}`; }

export function firstSentences(text, n) {
  const flat = text.replace(/\s+/g, ' ').trim();
  const parts = flat.match(/[^.!?]+[.!?]?/g) || [];
  return parts.slice(0, n).join('').trim();
}

// Daily: one block per recording, from its tidy version (title + first two sentences).
export function buildDaily(entries) {
  return entries
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((e) => {
      const body = e.tidy.paragraphs.join(' ');
      return `${timeOf(e.createdAt)} · ${e.tidy.title}\n${firstSentences(body, 2)}`.trim();
    })
    .join('\n\n');
}

// dailyText(dayKey) -> text of that day's summary or ''
function dayLine(key, text, sentences) {
  const body = text.split('\n').filter((l) => !/^\d{2}:\d{2} · /.test(l)).join(' ');
  const s = firstSentences(body || text, sentences);
  const d = parseDay(key);
  return `יום ${DAY_NAMES[d.getDay()]} ${short(key)}: ${s}`;
}

export function buildWeekly(wKey, dailyText) {
  const lines = [];
  for (let i = 0; i < 7; i++) {
    const k = addDays(wKey, i);
    const t = dailyText(k);
    if (t) lines.push(dayLine(k, t, 2));
  }
  return lines.join('\n');
}

export function buildMonthly(mKey, dailyText) {
  const blocks = [];
  let curWeek = null;
  let cur = [];
  for (const k of daysOfMonth(mKey)) {
    const t = dailyText(k);
    if (!t) continue;
    const w = weekStart(k);
    if (w !== curWeek) {
      if (cur.length) blocks.push(cur.join('\n'));
      curWeek = w;
      cur = [`שבוע ${weekLabel(w)}`];
    }
    cur.push(dayLine(k, t, 1));
  }
  if (cur.length) blocks.push(cur.join('\n'));
  return blocks.join('\n\n');
}

export function entryShareText(e) {
  return tidyText(e.tidy);
}
