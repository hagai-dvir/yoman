// Continuous Hebrew transcription with Chrome's Web Speech API (cloud: audio goes to Google for recognition),
// plus an optional parallel MediaRecorder for the audio itself.
// Rule: transcription wins. If the recorder and the recognizer fight over the microphone,
// the recorder is stopped, the event is logged and the UI is told. Nothing is dropped silently.

import { audioMimeCandidates } from './platform.js';

export function speechSupported() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

// Merge a session's final results, guarding against the Android Chrome bug where each new final
// result repeats all the previous ones as a prefix.
export function dedupeFinals(finals) {
  const out = [];
  let acc = '';
  for (const raw of finals) {
    let s = (raw || '').trim();
    if (!s) continue;
    if (acc && s.startsWith(acc)) s = s.slice(acc.length).trim();
    else if (out.length && s.startsWith(out[out.length - 1])) s = s.slice(out[out.length - 1].length).trim();
    if (!s) continue;
    out.push(s);
    acc = (acc + ' ' + s).trim();
  }
  return out;
}

export class Recorder {
  constructor({ lang = 'he-IL', withAudio = true, onUpdate = () => {}, onStatus = () => {}, log = () => {} } = {}) {
    Object.assign(this, { lang, withAudio, onUpdate, onStatus, log });
    this.segments = [];        // committed: [{ text, t }]
    this.sessionFinals = [];   // raw finals of the running recognition session
    this.sessionTimes = [];
    this.interim = '';
    this.restarts = 0;
    this.stopping = false;
    this.running = false;
    this.audio = { state: withAudio ? 'starting' : 'off', chunks: [], mime: '', conflict: null };
    this.recentEnds = [];
    this.gotResultInSession = false;
  }

  elapsed() { return Date.now() - this.t0; }

  async start() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) throw Object.assign(new Error('speech-unsupported'), { code: 'speech-unsupported' });
    this.SR = SR;
    this.t0 = Date.now();
    this.running = true;
    this.requestWakeLock();
    this.startRecognition();
    // If recognition never starts (iOS Home Screen web apps: API present but inert), report it
    // so the UI can switch to keyboard dictation instead of showing an empty page forever.
    this.watchdog = setTimeout(() => {
      if (!this.everStarted && !this.stopping) {
        this.log('speech-never-started', '');
        this.onStatus({ kind: 'unavailable', reason: 'never-started' });
      }
    }, 4500);
    // Give the recognizer the microphone first; start the recorder once recognition reports audio.
    if (this.withAudio) {
      this.audioTimer = setTimeout(() => this.startAudio(), 1200);
    }
  }

  // Safari may refuse to restart recognition without a fresh tap. The UI calls this from a tap.
  resume() {
    if (!this.paused || this.stopping) return;
    this.paused = false;
    this.log('speech-resume-tap', '');
    this.startRecognition();
  }

  startRecognition() {
    const r = new this.SR();
    r.lang = this.lang;
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;
    this.sessionFinals = [];
    this.sessionTimes = [];
    this.interim = '';
    this.gotResultInSession = false;
    this.sessionStart = Date.now();
    r.onresult = (ev) => {
      this.gotResultInSession = true;
      const finals = [];
      let interim = '';
      for (let i = 0; i < ev.results.length; i++) {
        const res = ev.results[i];
        if (res.isFinal) {
          finals.push(res[0].transcript);
          if (this.sessionTimes[i] === undefined) this.sessionTimes[i] = this.elapsed();
        } else {
          interim += res[0].transcript + ' ';
        }
      }
      this.sessionFinals = finals;
      this.interim = interim.trim();
      this.emit();
    };
    r.onstart = () => { this.everStarted = true; clearTimeout(this.watchdog); };
    r.onerror = (ev) => {
      this.log('speech-error', ev.error);
      if ((ev.error === 'not-allowed' || ev.error === 'service-not-allowed') && this.everStarted) {
        // Worked before, refused on an automatic restart: Safari wants a user gesture. Keep the recording.
        this.paused = true;
        this.onStatus({ kind: 'need-tap' });
      } else if (ev.error === 'service-not-allowed') {
        this.stopping = true;
        clearTimeout(this.watchdog);
        this.onStatus({ kind: 'unavailable', reason: ev.error });
      } else if (ev.error === 'not-allowed') {
        this.fatal = ev.error;
        this.onStatus({ kind: 'fatal', error: ev.error });
        this.stopping = true;
      } else if (ev.error === 'audio-capture' && this.recorder) {
        this.resolveConflict('speech-audio-capture');
      } else if (ev.error === 'network') {
        this.onStatus({ kind: 'network' });
      }
    };
    r.onend = () => {
      this.commitSession();
      if (this.stopping) {
        this.running = false;
        if (this.endResolve) this.endResolve();
        return;
      }
      if (this.paused) return; // waiting for the owner's tap (see resume())
      // Recognition stopped by itself (silence, time limit, network). Restart so no words are lost.
      const now = Date.now();
      const quick = now - this.sessionStart < 1500 && !this.gotResultInSession;
      this.recentEnds = this.recentEnds.filter((t) => now - t < 15000);
      if (quick) this.recentEnds.push(now);
      if (quick && this.recorder && this.recentEnds.length >= 3) this.resolveConflict('speech-ends-immediately');
      this.restarts++;
      this.onStatus({ kind: 'restart', count: this.restarts });
      this.log('speech-restart', String(this.restarts));
      const delay = this.recentEnds.length >= 5 ? 1500 : 250;
      setTimeout(() => {
        if (!this.stopping) {
          try { this.startRecognition(); } catch (e) { this.log('speech-restart-failed', e.message); setTimeout(() => !this.stopping && this.startRecognition(), 1000); }
        }
      }, delay);
    };
    this.rec = r;
    try {
      r.start();
    } catch (e) {
      this.log('speech-start-threw', e.name || e.message);
      if (this.everStarted) { this.paused = true; this.onStatus({ kind: 'need-tap' }); }
      else { this.stopping = true; this.onStatus({ kind: 'unavailable', reason: e.name || 'start-threw' }); }
    }
  }

  commitSession() {
    const parts = dedupeFinals(this.sessionFinals);
    // Keep any interim words too: if the session ended mid-phrase they would otherwise be lost.
    if (this.interim) parts.push(this.interim);
    const t = this.sessionTimes.find((x) => x !== undefined) ?? this.elapsed();
    parts.forEach((text, i) => this.segments.push({ text, t: this.sessionTimes[i] ?? t }));
    this.sessionFinals = [];
    this.sessionTimes = [];
    this.interim = '';
    this.emit();
  }

  currentText() {
    const committed = this.segments.map((s) => s.text);
    const live = dedupeFinals(this.sessionFinals);
    return { finalText: [...committed, ...live].join(' '), interim: this.interim };
  }

  emit() { this.onUpdate(this.currentText()); }

  async startAudio() {
    if (this.stopping || !this.withAudio) return;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const mime = audioMimeCandidates().find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
      this.recorder = new MediaRecorder(this.stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);
      this.audio.mime = this.recorder.mimeType || mime;
      this.recorder.ondataavailable = (e) => { if (e.data && e.data.size) this.audio.chunks.push(e.data); };
      this.recorder.start(5000);
      this.audio.state = 'recording';
      this.onStatus({ kind: 'audio', state: 'recording' });
      this.log('audio-start', this.audio.mime);
      this.watchSilence();
    } catch (e) {
      this.audio.state = 'failed';
      this.audio.conflict = 'getUserMedia-' + (e.name || 'error');
      this.log('audio-failed', e.name || e.message);
      this.onStatus({ kind: 'audio', state: 'failed', reason: e.name });
    }
  }

  // If the recorder only gets digital silence while the recognizer keeps producing text,
  // the two are not sharing the microphone. Report it.
  watchSilence() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.actx = new Ctx();
      const src = this.actx.createMediaStreamSource(this.stream);
      const an = this.actx.createAnalyser();
      an.fftSize = 2048;
      src.connect(an);
      const buf = new Float32Array(an.fftSize);
      let silentSince = Date.now();
      let textAtSilence = this.currentText().finalText.length;
      this.silenceTimer = setInterval(() => {
        an.getFloatTimeDomainData(buf);
        let peak = 0;
        for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
        if (peak > 0.0005) { silentSince = Date.now(); textAtSilence = this.currentText().finalText.length; return; }
        const textGrew = this.currentText().finalText.length - textAtSilence > 15;
        if (Date.now() - silentSince > 8000 && textGrew) this.resolveConflict('recorder-hears-silence');
      }, 500);
    } catch (e) { this.log('silence-watch-failed', e.message); }
  }

  resolveConflict(reason) {
    if (this.audio.state !== 'recording') return;
    this.log('mic-conflict', reason);
    this.audio.conflict = reason;
    this.stopAudio(false);
    this.audio.state = 'conflict';
    this.onStatus({ kind: 'audio', state: 'conflict', reason });
  }

  stopAudio(keep = true) {
    clearInterval(this.silenceTimer);
    clearTimeout(this.watchdog);
    clearTimeout(this.audioTimer);
    if (this.actx) { this.actx.close().catch(() => {}); this.actx = null; }
    const rec = this.recorder;
    this.recorder = null;
    const done = new Promise((res) => {
      if (!rec || rec.state === 'inactive') return res();
      rec.onstop = () => res();
      try { rec.stop(); } catch (e) { res(); }
    });
    return done.then(() => {
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
      if (!keep) this.audio.chunks = [];
    });
  }

  async stop() {
    this.stopping = true;
    const ended = new Promise((res) => { this.endResolve = res; });
    try { this.rec && this.rec.stop(); } catch (e) { /* already stopped */ }
    await Promise.race([ended, new Promise((r) => setTimeout(r, 2500))]);
    if (this.running) { this.commitSession(); this.running = false; } // onend never came
    await this.stopAudio(true);
    this.releaseWakeLock();
    const audioBlob = this.audio.chunks.length ? new Blob(this.audio.chunks, { type: this.audio.mime || 'audio/webm' }) : null;
    return {
      segments: this.segments.filter((s) => s.text.trim()),
      durationSec: Math.round(this.elapsed() / 1000),
      restarts: this.restarts,
      audioBlob,
      audioMime: this.audio.mime,
      audioState: this.audio.state,
      audioConflict: this.audio.conflict,
    };
  }

  async requestWakeLock() {
    try { if (navigator.wakeLock) this.wake = await navigator.wakeLock.request('screen'); } catch (e) { this.log('wakelock-failed', e.name); }
  }
  releaseWakeLock() { try { this.wake && this.wake.release(); } catch (e) { /* ignore */ } this.wake = null; }
}
