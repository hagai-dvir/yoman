// Local, rule-based tidying of a raw Hebrew transcript. Nothing leaves the phone.
// It only removes fillers and repeats, adds punctuation and paragraph breaks, and picks a title
// from the speaker's own first words. It never adds content.

const FILLERS = new Set(['אה', 'אהה', 'אההה', 'אהם', 'אמ', 'אממ', 'אממם', 'הממ', 'המממ', 'מממ', 'יעני', 'אמממ', 'אהמ']);
// Multi-word markers that usually open a new sentence. Longest first.
const SENTENCE_MARKERS = [
  'אחרי הצהריים', 'אחר הצהריים', 'אחר כך', 'אחרי זה', 'בדרך חזרה', 'בסוף היום',
  'ואחר כך', 'ואחרי זה', 'ואז', 'בבוקר', 'בצהריים', 'בערב', 'בלילה', 'ובבוקר', 'ובצהריים', 'ובערב', 'ובלילה',
  'למחרת', 'בסוף', 'בינתיים',
].map((m) => m.split(' '));
// Markers that start a new paragraph when the current one already has some sentences.
const PARAGRAPH_MARKERS = new Set(['אחרי הצהריים', 'אחר הצהריים', 'בבוקר', 'בצהריים', 'בערב', 'בלילה', 'ובבוקר', 'ובצהריים', 'ובערב', 'ובלילה', 'למחרת', 'בסוף היום']);
const COMMA_BEFORE = new Set(['אבל', 'כי', 'למרות', 'אלא', 'אם כי']);
const QUESTION_WORDS = new Set(['למה', 'מה', 'איך', 'מתי', 'האם', 'איפה', 'כמה', 'מי', 'לאן', 'מאיפה', 'מדוע']);

const norm = (w) => w.replace(/[.,!?;:"'״׳()\-–]/g, '');

export function tokenize(text) {
  return text.split(/\s+/).filter(Boolean);
}

// Remove fillers and immediate repetitions of 1–3 word groups.
export function cleanTokens(tokens) {
  let out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const n = norm(t);
    if (!n) continue;
    if (FILLERS.has(n)) continue;
    if (n === 'כאילו') {
      const next = tokens[i + 1] ? norm(tokens[i + 1]) : '';
      if (!next.startsWith('ש')) continue; // "כאילו שהוא..." is meaningful; a bare "כאילו" is a filler
    }
    out.push(t);
  }
  // collapse repeated n-grams (n = 3, 2, 1): "ממש ממש" -> "ממש", "אני הולך אני הולך" -> "אני הולך"
  for (const n of [3, 2, 1]) {
    const res = [];
    for (let i = 0; i < out.length; i++) {
      res.push(out[i]);
      if (res.length >= 2 * n) {
        const a = res.slice(-2 * n, -n).map(norm).join(' ');
        const b = res.slice(-n).map(norm).join(' ');
        if (a === b) res.splice(-n, n);
      }
    }
    out = res;
  }
  return out;
}

function markerAt(tokens, i) {
  for (const m of SENTENCE_MARKERS) {
    if (m.every((w, k) => tokens[i + k] && norm(tokens[i + k]) === w)) return m.join(' ');
  }
  return null;
}

function finishSentence(words) {
  if (!words.length) return '';
  let s = words.join(' ').replace(/\s+([,.!?])/g, '$1').trim();
  s = s.replace(/[,;:\s]+$/, '');
  if (/[.!?]$/.test(s)) return s;
  const first = norm(words[0]);
  return s + (QUESTION_WORDS.has(first) ? '?' : '.');
}

// segments: [{ text, t }] where t is ms since recording start (pauses between segments are informative)
export function tidy(segments) {
  const sentences = []; // { text, para } para=true -> start a new paragraph before it
  let prevT = null;
  let first = true;
  for (const seg of segments) {
    let tokens = cleanTokens(tokenize(seg.text || ''));
    if (first && tokens.length > 1 && norm(tokens[0]) === 'אז') tokens = tokens.slice(1); // opening "אז"
    if (!tokens.length) continue;
    const longPause = prevT !== null && typeof seg.t === 'number' && seg.t - prevT > 6000;
    prevT = typeof seg.t === 'number' ? seg.t : prevT;
    let cur = [];
    let curPara = longPause;
    for (let i = 0; i < tokens.length; i++) {
      let m = markerAt(tokens, i);
      // a marker that ends the segment ("...בעשר בבוקר") closes the sentence; it does not open a new one
      if (m && i + m.split(' ').length >= tokens.length) m = null;
      if (m && cur.length >= 4) {
        sentences.push({ text: finishSentence(cur), para: curPara });
        cur = [];
        curPara = PARAGRAPH_MARKERS.has(m);
      } else if (m && cur.length === 0 && PARAGRAPH_MARKERS.has(m)) {
        curPara = true;
      }
      const n = norm(tokens[i]);
      const two = tokens[i + 1] ? n + ' ' + norm(tokens[i + 1]) : '';
      if ((COMMA_BEFORE.has(n) || COMMA_BEFORE.has(two)) && cur.length >= 3 && !/[,.]$/.test(cur[cur.length - 1])) {
        cur[cur.length - 1] += ',';
      }
      cur.push(tokens[i]);
      if (cur.length >= 28) { // very long run without a pause: break it anyway
        sentences.push({ text: finishSentence(cur), para: curPara });
        cur = [];
        curPara = false;
      }
    }
    if (cur.length) sentences.push({ text: finishSentence(cur), para: curPara });
    first = false;
  }

  const paragraphs = [];
  let p = [];
  for (const s of sentences) {
    if (p.length && (s.para && p.length >= 2 || p.length >= 4)) {
      paragraphs.push(p.join(' '));
      p = [];
    }
    p.push(s.text);
  }
  if (p.length) paragraphs.push(p.join(' '));

  return { title: makeTitle(sentences[0] ? sentences[0].text : ''), paragraphs };
}

export function makeTitle(sentence) {
  const words = sentence.replace(/[.!?,]/g, '').split(/\s+/).filter(Boolean);
  if (!words.length) return 'הקלטה ללא טקסט';
  if (words.length <= 7) return words.join(' ');
  return words.slice(0, 6).join(' ') + '…';
}

export function rawText(segments) {
  return segments.map((s) => s.text.trim()).filter(Boolean).join(' ');
}

export function tidyText(t) {
  return [t.title, ...t.paragraphs].join('\n\n');
}

// Split dictated text into segments where the typing paused for more than 2.5 s, and at line breaks.
export function dictationSegments(text, marks) {
  const cuts = [];
  for (let i = 1; i < marks.length; i++) {
    if (marks[i].t - marks[i - 1].t > 2500 && marks[i - 1].len < text.length) cuts.push({ at: marks[i - 1].len, t: marks[i].t });
  }
  const segs = [];
  let start = 0, t = 0;
  for (const c of [...cuts, { at: text.length, t: null }]) {
    if (c.at < start) continue;
    for (const line of text.slice(start, c.at).split('\n')) {
      const s = line.trim().replace(/\s+/g, ' ');
      if (s) segs.push({ text: s, t });
    }
    start = c.at;
    if (c.t !== null) t = c.t;
  }
  return segs;
}

// ---- hands-free end word (default "דרקון", since 1.6.2) ----
export const DEFAULT_END_PHRASE = 'דרקון';
// Other spellings the recognizer may produce for the same spoken end word.
// "dragon": Chrome's Hebrew recognizer sometimes writes a word that sounds English in Latin letters.
const END_ALIASES = { 'דרקון': [['dragon']] };
// Letters and digits only, lower case: "דרקון." / "דרקון!" / "(דרקון)" / "Dragon," all compare equal.
const endNorm = (w) => w.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
const endTokens = (text) => tokenize(text || '').map(endNorm).filter(Boolean);
const HEB = /^[א-ת]/;
// The first word may carry a Hebrew prefix the recognizer glued on: "הדרקון", "ודרקון", "והדרקון".
function wordMatches(got, want, first) {
  if (got === want) return true;
  if (!first || !HEB.test(want) || !got.endsWith(want)) return false;
  return ['ה', 'ו', 'וה'].includes(got.slice(0, got.length - want.length));
}
// How many words at the end of the text are the end phrase (0 = it does not end with it).
function endMatchLen(tokens, phrase) {
  const main = endTokens(phrase);
  if (!main.length) return 0;
  for (const p of [main, ...(END_ALIASES[main.join(' ')] || [])]) {
    if (tokens.length < p.length) continue;
    const tail = tokens.slice(-p.length);
    if (p.every((w, i) => wordMatches(tail[i], w, i === 0))) return p.length;
  }
  return 0;
}

// True when the spoken text ends with the end phrase.
export function endsWithPhrase(text, phrase) {
  return endMatchLen(endTokens(text), phrase) > 0;
}

// Number of real words in a text (punctuation-only tokens do not count).
export const wordCount = (text) => endTokens(text).length;

// Removes the end phrase from the end of the segments (it may be split across the last two segments).
export function stripEndPhrase(segments, phrase) {
  const segs = segments.map((s) => ({ ...s }));
  let remaining = endMatchLen(endTokens(segs.map((s) => s.text).join(' ')), phrase);
  if (!remaining) return segments;
  for (let i = segs.length - 1; i >= 0 && remaining > 0; i--) {
    const words = tokenize(segs[i].text);
    // drop trailing empty-after-normalising tokens (punctuation) together with the phrase words
    while (words.length && remaining > 0) {
      const w = words.pop();
      if (endNorm(w)) remaining--;
    }
    segs[i].text = words.join(' ').replace(/[\s,;:\-–]+$/, ''); // "היה יום טוב, דרקון" -> "היה יום טוב"
  }
  return segs.filter((s) => s.text.trim());
}
// ---- written text (typed, not spoken) ----
// One segment per paragraph the owner wrote, so his own paragraph breaks survive.
export function writtenSegments(text, t = 0) {
  return (text || '').replace(/\r/g, '').split(/\n\s*\n+/).map((p) => p.replace(/\s*\n\s*/g, ' ').replace(/[ \t]+/g, ' ').trim()).filter(Boolean).map((p) => ({ text: p, t }));
}
// Tidy each written paragraph on its own: fillers and repeats are cleaned, paragraph breaks are kept.
export function tidyWritten(segments) {
  const paragraphs = [];
  for (const s of segments) paragraphs.push(...tidy([{ text: s.text, t: 0 }]).paragraphs);
  const first = paragraphs.length ? (paragraphs[0].match(/[^.!?]+[.!?]?/) || [''])[0] : '';
  return { title: makeTitle(first), paragraphs };
}