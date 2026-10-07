// Platform facts the UI must be honest about (who receives the audio, what iOS allows where).
const ua = navigator.userAgent || '';

// iPadOS reports itself as a Mac; touch support tells them apart.
export const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
export const isAndroid = /Android/.test(ua);

export function isStandalone() {
  return navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
}

// Who processes the speech audio. On iOS every browser is WebKit, so recognition is Apple's.
export const speechVendor = isIOS ? 'אפל' : /Chrome|Chromium|CriOS/.test(ua) ? 'גוגל' : 'יצרן הדפדפן';

// Known WebKit limitation (bug 225298, open since 2021): SpeechRecognition exists but does not work
// in Home Screen web apps. There the app falls back to the keyboard's dictation button.
export const liveSpeechLikelyBlocked = () => isIOS && isStandalone();

export const biometricName = isIOS ? 'Face ID או טביעת אצבע' : 'טביעת אצבע או פנים';
export const passkeyHint = isIOS
  ? 'המפתח נשמר ב"סיסמאות" (iCloud Keychain). צריך iOS 18 ומעלה. ייתכן שתתבקש לאשר פעמיים.'
  : 'אם הטלפון שואל איפה לשמור את מפתח הגישה, בחר "מנהל הסיסמאות של Google". ייתכן שתתבקש לאשר פעמיים.';

export function audioMimeCandidates() {
  const mp4 = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4'];
  const webm = ['audio/webm;codecs=opus', 'audio/webm'];
  return isIOS ? [...mp4, ...webm] : [...webm, ...mp4];
}
