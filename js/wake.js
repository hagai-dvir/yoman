// Keeps the screen on (Screen Wake Lock API) while the diary is in use.
// iOS: Safari 16.4+; Home Screen web apps only from iOS 18.4 (WebKit bug 254545).
// The lock is dropped by the system whenever the page is hidden, so it is re-requested on
// visibilitychange and after any release we did not ask for.
// No video-loop fallback (NoSleep.js style): on iOS a playing <video> takes the audio session and can
// disturb the microphone and speech recognition, and the system wake lock exists on every iOS that
// can run this app's recording path anyway. When the lock is unavailable, it is logged and the UI says so.

export class WakeKeeper {
  constructor({ log = () => {}, nav = globalThis.navigator, doc = globalThis.document } = {}) {
    Object.assign(this, { log, nav, doc });
    this.wanted = false;
    this.sentinel = null;
    this.state = 'off';       // off | on | unsupported | failed:<name> | released
    this.acquires = 0;
    this.failures = 0;
    this.pending = null;
    this.onVis = () => { if (!this.doc.hidden && this.wanted) this.acquire('visible'); };
    if (this.doc && this.doc.addEventListener) this.doc.addEventListener('visibilitychange', this.onVis);
  }

  get supported() { return !!(this.nav && this.nav.wakeLock && this.nav.wakeLock.request); }
  get held() { return !!(this.sentinel && !this.sentinel.released); }

  // want(true) while the app is in use; want(false) on the lock screen or when the owner turned it off.
  want(on, why = '') {
    on = !!on;
    if (on === this.wanted) { if (on && !this.held && !this.doc.hidden) this.acquire(why || 'again'); return; }
    this.wanted = on;
    if (on) this.acquire(why || 'want');
    else this.releaseNow(why || 'unwant');
  }

  async acquire(why) {
    if (!this.wanted || this.held || this.pending) return this.pending;
    if (this.doc.hidden) return null; // requests from a hidden page are refused; onVis retries
    if (!this.supported) {
      if (this.state !== 'unsupported') { this.state = 'unsupported'; this.log('wakelock', 'unsupported'); }
      return null;
    }
    this.pending = (async () => {
      try {
        const s = await this.nav.wakeLock.request('screen');
        if (!this.wanted) { try { await s.release(); } catch (e) { /* ignore */ } return; }
        this.sentinel = s;
        this.acquires++;
        if (this.state !== 'on') this.log('wakelock', `on (${why})`);
        this.state = 'on';
        s.addEventListener('release', () => {
          if (this.sentinel !== s) return;
          this.sentinel = null;
          if (!this.wanted) return;
          this.state = 'released';
          // Released by the system (page hidden, low power...). Get it back when visible.
          if (!this.doc.hidden) setTimeout(() => this.acquire('after-release'), 300);
        });
      } catch (e) {
        this.failures++;
        const st = 'failed:' + (e.name || 'error');
        if (this.state !== st) this.log('wakelock', `${st} (${why})`);
        this.state = st;
      } finally { this.pending = null; }
    })();
    return this.pending;
  }

  releaseNow(why) {
    const s = this.sentinel;
    this.sentinel = null;
    if (s && !s.released) { try { s.release(); } catch (e) { /* ignore */ } }
    if (this.state === 'on' || this.state === 'released') this.log('wakelock', `off (${why})`);
    this.state = 'off';
  }

  describe() {
    return `${this.state}${this.supported ? '' : ' (no API)'} acquires=${this.acquires} failures=${this.failures}`;
  }
}
