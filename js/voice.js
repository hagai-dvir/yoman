// Sound cues and read-aloud. Both run in the browser; nothing is sent anywhere by this code.
// Read-aloud uses the system voices (speechSynthesis). A voice with localService === false is a
// network voice of the browser/OS vendor; the UI says so when such a voice is the only Hebrew one.

let actx = null;
// Call inside a tap first (iOS unlocks audio only from a gesture).
export function primeAudio() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!actx && Ctx) actx = new Ctx();
    if (actx && actx.state === 'suspended') actx.resume();
  } catch (e) { /* ignore */ }
}

// Short tones, not words, so the recognizer has nothing to transcribe.
export function beep(kind = 'start') {
  try {
    primeAudio();
    if (!actx) return;
    const seq = kind === 'start' ? [[880, 0, 0.14]] : kind === 'stop' ? [[660, 0, 0.12], [520, 0.18, 0.16]] : [[440, 0, 0.3]];
    for (const [f, at, dur] of seq) {
      const o = actx.createOscillator();
      const g = actx.createGain();
      o.frequency.value = f;
      o.type = 'sine';
      const t = actx.currentTime + at;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(actx.destination);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
  } catch (e) { /* cues are optional */ }
}

export const ttsSupported = () => 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;

function voicesNow() { try { return speechSynthesis.getVoices() || []; } catch (e) { return []; } }

export function hebrewVoices() {
  return voicesNow().filter((v) => /^(he|iw)([-_]|$)/i.test(v.lang));
}

export function waitForVoices(ms = 1500) {
  return new Promise((res) => {
    if (!ttsSupported()) return res([]);
    if (voicesNow().length) return res(hebrewVoices());
    const done = () => res(hebrewVoices());
    speechSynthesis.addEventListener('voiceschanged', done, { once: true });
    setTimeout(done, ms);
  });
}

// Prefer an on-device Hebrew voice.
export function pickVoice() {
  const hv = hebrewVoices();
  return hv.find((v) => v.localService) || hv[0] || null;
}

export function splitForSpeech(text) {
  // Short chunks: long utterances get cut off on some browsers, and pausing works per chunk.
  const parts = (text || '').replace(/\s+/g, ' ').match(/[^.!?\n]+[.!?]?/g) || [];
  const out = [];
  for (const p of parts) {
    let s = p.trim();
    while (s.length > 220) { const cut = s.lastIndexOf(' ', 200); out.push(s.slice(0, cut > 50 ? cut : 200)); s = s.slice(cut > 50 ? cut + 1 : 200); }
    if (s) out.push(s);
  }
  return out;
}

// Pause/resume are done by remembering the chunk and restarting it: speechSynthesis.pause() is
// unreliable on Android.
export class Reader {
  constructor({ onState = () => {} } = {}) {
    this.onState = onState;
    this.chunks = [];
    this.i = 0;
    this.rate = 1;
    this.state = 'idle'; // idle | playing | paused
  }

  load(text, title = '') {
    this.stop();
    this.chunks = splitForSpeech((title ? title + '. ' : '') + text);
    this.i = 0;
  }

  play() {
    if (!ttsSupported() || !this.chunks.length) return false;
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* ignore */ }
    this.state = 'playing';
    this.onState(this);
    this.speakCurrent();
    return true;
  }

  speakCurrent() {
    if (this.state !== 'playing') return;
    if (this.i >= this.chunks.length) { this.state = 'idle'; this.i = 0; this.onState(this); return; }
    const u = new SpeechSynthesisUtterance(this.chunks[this.i]);
    const v = pickVoice();
    if (v) u.voice = v;
    u.lang = v ? v.lang : 'he-IL';
    u.rate = this.rate;
    const token = (this.token = {});
    u.onend = () => { if (this.token !== token || this.state !== 'playing') return; this.i++; this.onState(this); this.speakCurrent(); };
    u.onerror = (e) => { if (this.token !== token) return; if (e.error === 'interrupted' || e.error === 'canceled') return; this.state = 'idle'; this.onState(this, e.error); };
    speechSynthesis.speak(u);
  }

  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.token = null;
    speechSynthesis.cancel();
    this.onState(this);
  }

  resume() {
    if (this.state !== 'paused') return;
    this.state = 'playing';
    this.onState(this);
    this.speakCurrent();
  }

  setRate(r) {
    this.rate = r;
    if (this.state === 'playing') { this.token = null; speechSynthesis.cancel(); this.speakCurrent(); }
  }

  stop() {
    this.token = null;
    this.state = 'idle';
    this.i = 0;
    try { if (ttsSupported()) speechSynthesis.cancel(); } catch (e) { /* ignore */ }
    this.onState(this);
  }
}

// One short spoken word ("נשמר") after recording ended, so the driver needs no screen.
export function sayShort(text) {
  if (!ttsSupported()) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice();
    if (v) u.voice = v;
    u.lang = v ? v.lang : 'he-IL';
    speechSynthesis.speak(u);
  } catch (e) { /* ignore */ }
}
