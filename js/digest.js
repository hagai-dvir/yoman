// "תמצת את היום": a short, local, extractive digest of one day's recordings and writings.
// Nothing leaves the phone. The digest only picks sentences the owner said or wrote, in the order he
// said them. It may drop a leading filler word or cut a long sentence at a comma, but it never adds,
// rewrites or reorders words inside a sentence.

const PUNCT = /[.,!?;:"'״׳()\-–…]/g;
const FINALS = { 'ם': 'מ', 'ן': 'נ', 'ץ': 'צ', 'ף': 'פ', 'ך': 'כ' };
// Function words that carry no topic. Checked on the word without punctuation, before prefix stripping.
const STOP = new Set(('אני אתה את הוא היא אנחנו אתם הם הן זה זאת זו אלה אלו של שלי שלו שלה שלנו שלהם על עם אל מן מ גם רק כבר עוד ' +
  'אז ואז כי אבל או אם לא כן יש אין היה היתה הייתה היו יהיה להיות מאוד ממש קצת הרבה כל כמו איזה איזו אותו אותה אותי אותם ' +
  'לי לו לה לנו להם לך בו בה בי בהם אצל אצלי בין תוך יותר פחות אחד אחת דבר משהו סתם בעצם נגיד בקיצור כאילו יעני אוקיי ' +
  'פה כאן שם אחרי לפני אחר כך ככה מה מי איך למה מתי איפה עכשיו היום אחרי־כן וגם ועוד והוא והיא וזה שזה שהוא שהיא ' +
  'אה אהה אמ אממ הממ מממ נו טוב בסדר ככה').split(/\s+/));
// Words that open a spoken sentence without adding content. Dropped only at the start of a digest line.
const LEAD_FILLERS = new Set(['אז', 'ואז', 'טוב', 'אוקיי', 'בקיצור', 'נו', 'בעצם', 'וגם', 'כאילו', 'יעני']);

// maxItems: null = about a third of the day's sentences, between 3 and 7 lines.
export const DIGEST_DEFAULTS = { maxItems: null, maxChars: 600, longWords: 22, takeAllWords: 45 };

const bare = (w) => w.replace(PUNCT, '');

// Rough Hebrew stem: drop one prefix letter (two for ו/ש/כ/מ + ה/ב/ל/כ), normalise final letters,
// drop a plural ending. It is only used to compare sentences, never shown.
export function stem(word) {
  let s = bare(word);
  if (!s || /^\d+$/.test(s)) return s;
  s = s.replace(/[םןץףך]/g, (c) => FINALS[c]);
  if (s.length > 3 && 'והבלמשכ'.includes(s[0])) {
    const first = s[0];
    s = s.slice(1);
    if (s.length > 3 && 'ושכמ'.includes(first) && 'הבלכ'.includes(s[0])) s = s.slice(1);
  }
  if (s.length > 4 && /(ימ|ות)$/.test(s)) s = s.slice(0, -2);
  return s;
}

export function contentStems(text) {
  const out = [];
  for (const w of text.split(/\s+/)) {
    const b = bare(w);
    if (!b || STOP.has(b) || (b.length < 2 && !/\d/.test(b))) continue;
    out.push(stem(w));
  }
  return out;
}

export function splitSentences(text) {
  return (text.replace(/\s+/g, ' ').match(/[^.!?]+[.!?…]*/g) || []).map((s) => s.trim()).filter((s) => bare(s).trim());
}

// Very long sentences are offered as their comma-separated parts too, so a short digest can quote
// just the part that matters. Each part keeps the owner's words exactly; only a full stop is added.
function units(sentence, longWords) {
  const words = sentence.split(/\s+/);
  if (words.length <= longWords || !sentence.includes(',')) return [sentence];
  const parts = sentence.split(/,\s+/).map((p) => p.replace(/[.!?…]+$/, '').trim()).filter(Boolean);
  if (parts.length < 2) return [sentence];
  const end = (sentence.match(/[.!?…]+$/) || ['.'])[0];
  return parts.map((p) => p + end);
}

function dropLeadFiller(s) {
  const words = s.split(' ');
  while (words.length > 3 && LEAD_FILLERS.has(bare(words[0]))) words.shift();
  return words.join(' ').replace(/^[,\s]+/, '');
}

const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / (a.size + b.size - n);
};

const pad = (n) => String(n).padStart(2, '0');
const hhmm = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

// items: [{ id, createdAt, input, paragraphs: [string] }] — one per recording/writing of the day.
// Returns { text, items: [{ id, time, text }], stats }.
export function digestDay(items, opts = {}) {
  const o = { ...DIGEST_DEFAULTS, ...opts };
  const sorted = items.slice().sort((a, b) => a.createdAt - b.createdAt);
  const cands = [];
  sorted.forEach((it, ei) => {
    let si = 0;
    for (const p of it.paragraphs || []) {
      for (const sent of splitSentences(p)) {
        for (const u of units(sent, o.longWords)) {
          const text = dropLeadFiller(u);
          const stems = contentStems(text);
          cands.push({ ei, si: si++, id: it.id, time: hhmm(it.createdAt), text, words: text.split(/\s+/).length, stems, set: new Set(stems) });
        }
      }
    }
  });
  const srcWords = cands.reduce((n, c) => n + c.words, 0);
  const stats = { entries: sorted.length, written: sorted.filter((x) => x.input === 'written').length, sentences: cands.length, srcWords, outWords: 0, chosen: 0, method: 'local-extractive' };
  if (!cands.length) return { text: '', items: [], stats };
  if (!o.maxItems) o.maxItems = Math.min(7, Math.max(3, Math.ceil(cands.length / 3)));

  // How many sentences talk about each word. Words the day keeps coming back to are its topics.
  const df = new Map();
  for (const c of cands) for (const s of c.set) df.set(s, (df.get(s) || 0) + 1);
  for (const c of cands) {
    let w = 0;
    for (const s of c.set) { const f = df.get(s); w += f > 1 ? 1 + Math.log(f) : 0.6; }
    let score = c.set.size ? w / Math.sqrt(c.set.size + 2) : 0;
    if (/\d/.test(c.text)) score += 0.4;            // times, amounts, dates: concrete facts
    if (c.si === 0) score += 0.35;                  // the opening of a recording usually names its subject
    if (c.words < 4) score *= 0.35;                 // fragments
    else if (c.words > 30) score *= 0.75;
    c.score = score;
  }

  let chosen;
  if (srcWords <= o.takeAllWords) {
    chosen = cands.filter((c) => c.words >= 2);     // a very short day is already its own digest
  } else {
    chosen = [];
    let chars = 0;
    const fits = (c) => chosen.length < o.maxItems && (chosen.length === 0 || chars + c.text.length <= o.maxChars);
    const redundant = (c) => chosen.some((x) => jaccard(x.set, c.set) >= 0.5);
    const take = (c) => { chosen.push(c); chars += c.text.length; };
    // 1) every recording gets its best sentence (the best recordings first, if there are too many)
    const bestPer = sorted.map((_, ei) => cands.filter((c) => c.ei === ei).sort((a, b) => b.score - a.score)[0]).filter(Boolean);
    for (const c of bestPer.sort((a, b) => b.score - a.score)) if (fits(c) && !redundant(c)) take(c);
    // 2) then the strongest remaining sentences of the whole day
    for (const c of cands.slice().sort((a, b) => b.score - a.score)) {
      if (chosen.length >= o.maxItems) break;
      if (!chosen.includes(c) && fits(c) && !redundant(c)) take(c);
    }
  }
  chosen.sort((a, b) => a.ei - b.ei || a.si - b.si);  // the order things happened
  const out = chosen.map((c) => ({ id: c.id, time: c.time, text: c.text }));
  stats.chosen = out.length;
  stats.outWords = out.reduce((n, c) => n + c.text.split(/\s+/).length, 0);
  return { text: out.map((c) => `• ${c.time} · ${c.text}`).join('\n'), items: out, stats };
}

// The built-in summarizer APIs some browsers offer write new sentences (abstractive) and none supports
// Hebrew today; the diary does not use them. This only reports what the browser has, for diagnostics.
export function browserSummarizer() {
  if (typeof self === 'undefined') return 'none';
  if ('Summarizer' in self) return 'Summarizer API (not used: abstractive, no Hebrew)';
  if (self.ai && self.ai.summarizer) return 'window.ai.summarizer (not used)';
  return 'none';
}
