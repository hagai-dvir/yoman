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
      const m = markerAt(tokens, i);
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
