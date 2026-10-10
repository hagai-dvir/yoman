// Version updates for the installed app (mainly the iPhone Home Screen app, which has no reload button).
// On every open and every return to the foreground the app asks the browser to check sw.js. A new version
// installs in the background and then waits. The owner taps "עדכן עכשיו": the page sends SKIP_WAITING, the new
// service worker takes over (controllerchange), and the page reloads into the lock screen.
// Never during a recording, dictation, writing or an open edit form: the bar waits until it is safe.

export class Updater {
  constructor({ current, isBusy = () => false, onChange = () => {}, log = () => {}, reload = () => location.reload(), minGapMs = 10000 } = {}) {
    Object.assign(this, { current, isBusy, onChange, log, reload, minGapMs });
    this.sw = null; this.reg = null;
    this.waiting = null; this.newVersion = null;
    this.applying = false; this.lastCheck = 0; this.supported = false;
  }

  // sw: navigator.serviceWorker (or a fake in tests); reg: the registration
  attach(sw, reg) {
    this.sw = sw; this.reg = reg; this.supported = !!(sw && reg);
    if (!this.supported) return;
    reg.addEventListener('updatefound', () => this.track(reg.installing));
    if (reg.installing) this.track(reg.installing);
    if (reg.waiting && sw.controller) this.setWaiting(reg.waiting);
    sw.addEventListener('controllerchange', () => {
      this.log('sw-controllerchange', this.applying ? 'reload' : 'ignored');
      if (this.applying) { this.applying = false; this.reload(); }
    });
  }

  track(w) {
    if (!w) return;
    const done = () => { if (w.state === 'installed' && this.sw.controller) this.setWaiting(w); };
    w.addEventListener('statechange', done);
    done();
  }

  setWaiting(w) {
    if (this.waiting === w) return;
    this.waiting = w;
    this.newVersion = null;
    this.log('sw-waiting', '');
    this.onChange();
    askVersion(w).then((v) => { if (this.waiting === w) { this.newVersion = v; this.onChange(); } });
  }

  get available() { return !!this.waiting && this.waiting.state !== 'redundant'; }

  // Asks the browser to look for a new sw.js. Returns 'available' | 'latest' | 'unsupported' | 'error'.
  async check({ force = false, waitMs = 8000 } = {}) {
    if (!this.supported) return 'unsupported';
    if (!force && Date.now() - this.lastCheck < this.minGapMs) return this.available ? 'available' : 'latest';
    this.lastCheck = Date.now();
    try { await this.reg.update(); } catch (e) { this.log('sw-update-failed', e.message); return this.available ? 'available' : 'error'; }
    if (this.reg.installing) this.track(this.reg.installing);
    // a new version may still be downloading; give it a few seconds to finish installing
    const t0 = Date.now();
    while (this.reg.installing && Date.now() - t0 < waitMs) await new Promise((r) => setTimeout(r, 200));
    if (this.reg.waiting && this.sw.controller) this.setWaiting(this.reg.waiting);
    return this.available ? 'available' : 'latest';
  }

  // 'busy' | 'none' | 'applying'
  apply() {
    if (!this.available) return 'none';
    if (this.isBusy()) return 'busy';
    this.applying = true;
    this.log('sw-apply', this.newVersion || '?');
    this.waiting.postMessage({ type: 'SKIP_WAITING' });
    // If the switch is not reported within a few seconds, reload anyway: the worst case is the same version again.
    setTimeout(() => { if (this.applying) { this.applying = false; this.log('sw-apply-timeout', ''); this.reload(); } }, this.applyTimeoutMs || 6000);
    return 'applying';
  }
}

function askVersion(w, ms = 3000) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const ch = new MessageChannel();
      ch.port1.onmessage = (e) => fin(e.data && e.data.version || null);
      w.postMessage({ type: 'GET_VERSION' }, [ch.port2]);
    } catch (e) { fin(null); }
    setTimeout(() => fin(null), ms);
  });
}
