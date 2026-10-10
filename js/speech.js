// Continuous Hebrew transcription with Chrome's Web Speech API (cloud: audio goes to Google for recognition),
// plus an optional parallel MediaRecorder for the audio itself.
// Rule: transcription wins. If the recorder and the recognizer fight over the microphone,
// the recorder is stopped, the event is logged and the UI is told. Nothing is dropped silently.

import { audioMimeCandidates } from './platform.js';
import { endsWithPhrase, stripEndPhrase } from './tidy.js';

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
  // endPhrase / silenceStopMs: hands-free stopping, only passed when the owner turned on car mode.
  // deviceId: a chosen microphone (Android); recognition then tries to listen to that same track.
  // onChunk(part, seq, blob): every recorded audio chunk, for the crash-safe journal.
  constructor({ lang = 'he-IL', withAudio = true, onUpdate = () => {}, onStatus = () => {}, log = () => {},
    endPhrase = '', silenceStopMs = 0, deviceId = '', onChunk = () => {} } = {}) {
    Object.assign(this, { lang, withAudio, onUpdate, onStatus, log, endPhrase, silenceStopMs, deviceId, onChunk });
    this.segments = [];        // committed: [{ text, t }]
    this.sessionFinals = [];   // raw finals of the running recognition session
    this.sessionTimes = [];
    this.interim = '';
    this.restarts = 0;
    this.stopping = false;
    this.running = false;
    // Audio may come in several parts: if iOS ends the microphone while the app is in the background,
    // a new recorder starts on return, and each recorder's output is a separate playable file.
    this.audio = { state: withAudio ? 'starting' : 'off', parts: [], mime: '', conflict: null };
    this.recentEnds = [];
    this.gotResultInSession = false;
    this.hidden = false;
    this.gaps = [];            // [{ from, to }] ms offsets while the app was in the background
    this.bg = { times: 0, resultsWhileHidden: 0, speechEndedHidden: 0, trackEvents: [], audioRestarts: 0, chunksWhileHidden: 0 };
  }
  get chunkCount() { return this.audio.parts.reduce((n, p) => n + p.chunks.length, 0); }

  elapsed() { return Date.now() - this.t0; }

  async start() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) throw Object.assign(new Error('speech-unsupported'), { code: 'speech-unsupported' });
    this.SR = SR;
    this.t0 = Date.now();
    this.running = true;
    try { if (navigator.audioSession) navigator.audioSession.type = 'play-and-record'; } catch (e) { /* Safari 16.4+ only */ }
    this.lastChange = Date.now();
    if (this.silenceStopMs) {
      this.silenceTimer2 = setInterval(() => {
        if (!this.stopping && !this.handsFreeFired && Date.now() - this.lastChange > this.silenceStopMs) {
          this.handsFreeFired = true;
          this.log('auto-stop', 'silence ' + Math.round(this.silenceStopMs / 1000) + 's');
          this.onStatus({ kind: 'silence-stop' });
        }
      }, 1000);
    }
    if (this.deviceId && this.withAudio) await this.startAudio(); // chosen mic first, so recognition can use its track
    this.startRecognition();
    // If recognition never starts (iOS Home Screen web apps: API present but inert), report it
    // so the UI can switch to keyboard dictation instead of showing an empty page forever.
    this.watchdog = setTimeout(() => {
      if (!this.everStarted && !this.stopping && !this.hidden) {
        this.log('speech-never-started', '');
        this.onStatus({ kind: 'unavailable', reason: 'never-started' });
      }
    }, 4500);
    // Give the recognizer the microphone first; start the recorder once recognition reports audio.
    if (this.withAudio && !this.recorder) {
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
      this.lastChange = Date.now();
      if (this.hidden) this.bg.resultsWhileHidden++;
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
      this.log('speech-error', ev.error + (this.hidden ? ' (hidden)' : ''));
      if (this.hidden && this.everStarted && (ev.error === 'not-allowed' || ev.error === 'service-not-allowed' || ev.error === 'audio-capture' || ev.error === 'aborted')) {
        // In the background iOS takes recognition away. Not a fault: it is resumed on return (see setHidden).
        this.speechIdleHidden = true;
        return;
      }
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
      if (this.hidden) {
        // Do not restart from the background: it fails on iOS, and quick failures would be mistaken
        // for a microphone conflict and stop the audio recorder. setHidden(false) restarts it.
        this.speechIdleHidden = true;
        this.bg.speechEndedHidden++;
        this.log('bg-rec', 'speech ended in background');
        return;
      }
      // Recognition stopped by itself (silence, time limit, network). Restart so no words are lost.
      const now = Date.now();
      const quick = now - this.sessionStart < 1500 && !this.gotResultInSession;
      this.recentEnds = this.recentEnds.filter((t) => now - t < 15000);
      if (quick) this.recentEnds.push(now);
      const justBack = this.visibleAt && now - this.visibleAt < 10000;
      if (quick && this.recorder && this.recentEnds.length >= 3 && !justBack) this.resolveConflict('speech-ends-immediately');
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
      const tr = this.deviceId && this.stream ? this.stream.getAudioTracks()[0] : null;
      if (tr) {
        try { r.start(tr); this.trackToRecognizer = true; } catch (e2) { this.log('recognizer-track-unsupported', e2.name); r.start(); }
      } else r.start();
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

  emit() {
    const cur = this.currentText();
    this.onUpdate(cur);
    if (this.endPhrase && !this.handsFreeFired && endsWithPhrase(cur.finalText + ' ' + cur.interim, this.endPhrase)) {
      this.handsFreeFired = true;
      this.log('auto-stop', 'end phrase');
      this.onStatus({ kind: 'end-phrase' });
    }
  }

  async startAudio() {
    if (this.stopping || !this.withAudio) return;
    try {
      const constraints = { echoCancellation: true, noiseSuppression: true };
      if (this.deviceId) constraints.deviceId = { exact: this.deviceId };
      try { this.stream = await navigator.mediaDevices.getUserMedia({ audio: constraints }); }
      catch (e) { if (!this.deviceId) throw e; this.log('mic-choice-failed', e.name); delete constraints.deviceId; this.stream = await navigator.mediaDevices.getUserMedia({ audio: constraints }); }
      if (this.stopping) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; return; }
      const tr = this.stream.getAudioTracks()[0];
      this.micLabel = (tr && tr.label) || '';
      this.onStatus({ kind: 'mic', label: this.micLabel });
      if (tr) {
        // iOS mutes or ends web microphone capture in some background situations. Record what happens.
        for (const ev of ['mute', 'unmute', 'ended']) {
          tr.addEventListener(ev, () => {
            const item = `${ev}${this.hidden ? '@bg' : ''}@${Math.round(this.elapsed() / 1000)}s`;
            this.bg.trackEvents.push(item);
            if (this.bg.trackEvents.length > 20) this.bg.trackEvents.shift();
            this.log('bg-rec', 'track ' + item);
          });
        }
      }
      const mime = audioMimeCandidates().find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
      const recorder = new MediaRecorder(this.stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);
      this.recorder = recorder;
      this.audio.mime = recorder.mimeType || mime;
      const part = { mime: this.audio.mime, chunks: [], startedAt: this.elapsed() };
      const partIndex = this.audio.parts.push(part) - 1;
      recorder.ondataavailable = (e) => {
        if (!e.data || !e.data.size) return;
        part.chunks.push(e.data);
        if (this.hidden) this.bg.chunksWhileHidden++;
        try { this.onChunk(partIndex, part.chunks.length - 1, e.data, part.mime); } catch (err) { /* journal is best effort */ }
      };
      recorder.onerror = (e) => this.log('audio-error', (e.error && e.error.name) || 'error');
      recorder.start(5000);
      this.audio.state = 'recording';
      this.onStatus({ kind: 'audio', state: 'recording' });
      this.log('audio-start', `${this.audio.mime} part=${partIndex}`);
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
    clearInterval(this.silenceTimer2);
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
      if (!keep) this.audio.parts = [];
    });
  }

  // Close the current recorder (its file is complete and kept) and start a new part.
  async restartAudio(why) {
    if (this.stopping || this.audio.state !== 'recording') return;
    this.bg.audioRestarts++;
    this.log('bg-rec', 'audio restart: ' + why);
    clearInterval(this.silenceTimer);
    if (this.actx) { this.actx.close().catch(() => {}); this.actx = null; }
    const rec = this.recorder;
    this.recorder = null;
    await new Promise((res) => {
      if (!rec || rec.state === 'inactive') return res();
      rec.onstop = () => res();
      try { rec.stop(); } catch (e) { res(); }
      setTimeout(res, 2000);
    });
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    await this.startAudio();
  }

  // Called by the app on visibilitychange. In the background the audio recorder keeps going if iOS
  // lets it (Safari tab: usually; Home Screen app: reportedly not). Live recognition usually stops there.
  // On return: restart recognition, and start a new audio part if the microphone was taken away.
  async setHidden(hidden) {
    if (this.stopping || hidden === this.hidden) return;
    this.hidden = hidden;
    const t = this.elapsed();
    if (hidden) {
      this.bg.times++;
      this.hiddenFrom = t;
      this.hiddenChunks0 = this.chunkCount;
      this.hiddenResults0 = this.bg.resultsWhileHidden;
      this.log('bg-rec', `hidden at ${Math.round(t / 1000)}s ${this.stateLine()}`);
      return;
    }
    this.visibleAt = Date.now();
    this.gaps.push({ from: this.hiddenFrom, to: t });
    const tr = this.stream && this.stream.getAudioTracks()[0];
    const chunks = this.chunkCount - (this.hiddenChunks0 || 0);
    const words = this.bg.resultsWhileHidden - (this.hiddenResults0 || 0);
    this.log('bg-rec', `visible after ${Math.round((t - this.hiddenFrom) / 1000)}s chunks=${chunks} speechResults=${words} ${this.stateLine()}`);
    this.onStatus({ kind: 'back', awaySec: Math.round((t - this.hiddenFrom) / 1000), chunks, speechResults: words });
    // Audio: a recorder that stopped, or a track that ended, cannot resume. Start a new part.
    if (this.audio.state === 'recording') {
      const dead = !this.recorder || this.recorder.state === 'inactive' || !tr || tr.readyState === 'ended';
      if (dead) await this.restartAudio('dead after background');
      else if (tr.muted) {
        // Muted by the system: give it a moment to unmute by itself, then start fresh.
        setTimeout(() => { const t2 = this.stream && this.stream.getAudioTracks()[0]; if (!this.hidden && t2 && t2.muted) this.restartAudio('still muted after background'); }, 1500);
      }
    }
    // Speech: restart if it ended in the background.
    if (this.speechIdleHidden && !this.paused) {
      this.speechIdleHidden = false;
      this.restarts++;
      this.log('speech-restart', 'after background');
      try { this.startRecognition(); } catch (e) { this.paused = true; this.onStatus({ kind: 'need-tap' }); }
    }
  }

  stateLine() {
    const tr = this.stream && this.stream.getAudioTracks()[0];
    return `audio=${this.audio.state} recorder=${this.recorder ? this.recorder.state : 'none'} track=${tr ? tr.readyState + (tr.muted ? '/muted' : '') : 'none'} speechIdle=${!!this.speechIdleHidden} paused=${!!this.paused}`;
  }

  snapshot() {
    const cur = this.currentText();
    const segs = this.segments.slice();
    const live = dedupeFinals(this.sessionFinals);
    if (live.length || this.interim) segs.push({ text: [...live, this.interim].filter(Boolean).join(' '), t: this.elapsed() });
    return { segments: segs.filter((s) => s.text && s.text.trim()), gaps: this.gaps.slice(), durationSec: Math.round(this.elapsed() / 1000), chars: cur.finalText.length };
  }

  async stop() {
    this.stopping = true;
    const ended = new Promise((res) => { this.endResolve = res; });
    try { this.rec && this.rec.stop(); } catch (e) { /* already stopped */ }
    if (this.hidden) this.gaps.push({ from: this.hiddenFrom, to: this.elapsed() }); // stopped while still in the background
    await Promise.race([ended, new Promise((r) => setTimeout(r, this.speechIdleHidden || this.paused ? 300 : 2500))]);
    if (this.running) { this.commitSession(); this.running = false; } // onend never came
    await this.stopAudio(true);
    clearInterval(this.silenceTimer2);
    try { if (navigator.audioSession) navigator.audioSession.type = 'auto'; } catch (e) { /* ignore */ }
    let segments = this.segments.filter((s) => s.text.trim());
    if (this.endPhrase) segments = stripEndPhrase(segments, this.endPhrase);
    const audioParts = this.audio.parts.filter((p) => p.chunks.length)
      .map((p) => ({ mime: p.mime, startedAt: p.startedAt, blob: new Blob(p.chunks, { type: p.mime || 'audio/webm' }) }));
    const audioBlob = audioParts.length ? audioParts[0].blob : null;
    return {
      audioParts,
      gaps: this.gaps.filter((g) => g.to - g.from >= 1000),
      bg: { ...this.bg, trackEvents: this.bg.trackEvents.slice() },
      segments,
      micLabel: this.micLabel || '',
      trackToRecognizer: !!this.trackToRecognizer,
      durationSec: Math.round(this.elapsed() / 1000),
      restarts: this.restarts,
      audioBlob,
      audioMime: this.audio.mime,
      audioState: this.audio.state,
      audioConflict: this.audio.conflict,
    };
  }

}
