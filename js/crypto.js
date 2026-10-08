// Encryption helpers. All user content is encrypted with a random data key (DEK, AES-GCM 256).
// The DEK is stored only wrapped: by a key derived from the owner's password (PBKDF2-SHA256),
// and optionally by a key derived from a WebAuthn PRF output (HKDF-SHA256).
const te = new TextEncoder();
const td = new TextDecoder();

export const PBKDF2_ITER = 600000; // OWASP 2023+ recommendation for PBKDF2-HMAC-SHA256

export function rand(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

export async function kekFromPassword(password, salt, iterations = PBKDF2_ITER) {
  const base = await crypto.subtle.importKey('raw', te.encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey', 'encrypt', 'decrypt']
  );
}

export async function kekFromPrf(prfBytes, salt) {
  const base = await crypto.subtle.importKey('raw', prfBytes, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: te.encode('hamesader-prf-kek-v1') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey']
  );
}

export function newDek() {
  // extractable so it can be re-wrapped (password change, adding biometric). It never leaves memory unwrapped.
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

export async function wrapDek(dek, kek) {
  const iv = rand(12);
  const ct = await crypto.subtle.wrapKey('raw', dek, kek, { name: 'AES-GCM', iv });
  return { iv, ct: new Uint8Array(ct) };
}

export function unwrapDek(wrapped, kek) {
  return crypto.subtle.unwrapKey('raw', wrapped.ct, kek, { name: 'AES-GCM', iv: wrapped.iv },
    { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

function params(iv, aad) {
  const p = { name: 'AES-GCM', iv };
  if (aad) p.additionalData = te.encode(aad);
  return p;
}

export async function encryptBytes(key, bytes, aad) {
  const iv = rand(12);
  const ct = await crypto.subtle.encrypt(params(iv, aad), key, bytes);
  return { iv, ct: new Uint8Array(ct) };
}

export async function decryptBytes(key, box, aad) {
  const pt = await crypto.subtle.decrypt(params(box.iv, aad), key, box.ct);
  return new Uint8Array(pt);
}

export async function encryptJSON(key, obj, aad) {
  return encryptBytes(key, te.encode(JSON.stringify(obj)), aad);
}

export async function decryptJSON(key, box, aad) {
  return JSON.parse(td.decode(await decryptBytes(key, box, aad)));
}

// ---- base64 (chunked, safe for large buffers) ----
export function toB64(u8) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return btoa(s);
}

export function fromB64(b64) {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

// ---- gzip via CompressionStream (Chrome 80+) ----
export async function gzip(u8) {
  if (typeof CompressionStream === 'undefined') return { data: u8, gz: false };
  const cs = new Blob([u8]).stream().pipeThrough(new CompressionStream('gzip'));
  return { data: new Uint8Array(await new Response(cs).arrayBuffer()), gz: true };
}

export async function gunzip(u8) {
  const ds = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(ds).arrayBuffer());
}

export const utf8 = { enc: (s) => te.encode(s), dec: (b) => td.decode(b) };

// ---- Quick-capture inbox: sealed boxes to a public key (ECDH P-256 + HKDF-SHA256 + AES-GCM) ----
// Anyone holding the public key can write; only the private key (stored encrypted under the DEK) can read.
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };

export async function newInboxKeyPair() {
  const kp = await crypto.subtle.generateKey(ECDH, true, ['deriveBits']);
  return {
    publicJwk: await crypto.subtle.exportKey('jwk', kp.publicKey),
    privatePkcs8: new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey)),
  };
}

async function boxKey(privateKey, publicKey, salt) {
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
  const base = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: te.encode('hamesader-inbox-v1') },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// Returns { epk, salt, parts: [{iv, ct}, ...] } — one ephemeral key per sealed message, several parts allowed.
export async function seal(publicJwk, partsBytes, aad) {
  const recipient = await crypto.subtle.importKey('jwk', publicJwk, ECDH, false, []);
  const eph = await crypto.subtle.generateKey(ECDH, true, ['deriveBits']);
  const salt = rand(16);
  const key = await boxKey(eph.privateKey, recipient, salt);
  const parts = [];
  for (let i = 0; i < partsBytes.length; i++) parts.push(await encryptBytes(key, partsBytes[i], `${aad}:${i}`));
  return { epk: await crypto.subtle.exportKey('jwk', eph.publicKey), salt, parts };
}

export async function unseal(privatePkcs8, box, aad) {
  const priv = await crypto.subtle.importKey('pkcs8', privatePkcs8, ECDH, false, ['deriveBits']);
  const eph = await crypto.subtle.importKey('jwk', box.epk, ECDH, false, []);
  const key = await boxKey(priv, eph, box.salt);
  const out = [];
  for (let i = 0; i < box.parts.length; i++) out.push(await decryptBytes(key, box.parts[i], `${aad}:${i}`));
  return out;
}
