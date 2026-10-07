// Biometric unlock through WebAuthn + the PRF extension.
// The PRF output (32 bytes, bound to this passkey and a salt) derives the key that unwraps the data key.
// No PRF -> no biometric unlock. We never store a password or a data key in the clear to "fake" it.
import { rand } from './crypto.js';

export async function capabilities() {
  const out = { webauthn: false, platform: false, prfCapability: null };
  try {
    if (!window.PublicKeyCredential || !navigator.credentials) return out;
    out.webauthn = true;
    out.platform = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    if (typeof PublicKeyCredential.getClientCapabilities === 'function') {
      const caps = await PublicKeyCredential.getClientCapabilities();
      if (caps && 'extension:prf' in caps) out.prfCapability = !!caps['extension:prf'];
    }
  } catch (e) { /* keep defaults */ }
  return out;
}

function prfFirst(cred) {
  const ext = (cred.getClientExtensionResults && cred.getClientExtensionResults()) || {};
  const prf = ext.prf || {};
  const first = prf.results && prf.results.first;
  return { first: first ? new Uint8Array(first) : null, enabled: 'enabled' in prf ? prf.enabled : null };
}

export async function evaluate(credId, prfSalt) {
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: rand(32),
      allowCredentials: [{ type: 'public-key', id: credId }],
      userVerification: 'required',
      timeout: 60000,
      extensions: { prf: { eval: { first: prfSalt } } },
    },
  });
  return prfFirst(assertion).first;
}

// Returns { credId, prfSalt, prf, path, enabledFlag }.
// path: 'create' when PRF came back at registration (Google Password Manager),
//       'get-after-create' when it only came back on a follow-up assertion (Samsung Pass behaviour).
export async function enroll() {
  const prfSalt = rand(32);
  const cred = await navigator.credentials.create({
    publicKey: {
      rp: { name: 'היומן' },
      user: { id: rand(16), name: 'היומן', displayName: 'היומן' },
      challenge: rand(32),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'preferred', userVerification: 'required' },
      attestation: 'none',
      timeout: 60000,
      extensions: { prf: { eval: { first: prfSalt } } },
    },
  });
  const credId = new Uint8Array(cred.rawId);
  const created = prfFirst(cred);
  let prf = created.first;
  let path = 'create';
  if (!prf) {
    // Some providers (Samsung Pass, iCloud Keychain on some versions) report nothing at creation and
    // still answer PRF on get(). We ask once more before concluding there is no PRF.
    path = 'get-after-create';
    try {
      prf = await evaluate(credId, prfSalt);
    } catch (e) {
      if (e.name === 'NotAllowedError') {
        // Safari allows one WebAuthn call per tap. The UI must ask for a second tap and call finishEnroll().
        const pending = new Error('needs-second-tap');
        pending.code = 'needs-second-tap';
        pending.pending = { credId, prfSalt, enabledFlag: created.enabled };
        throw pending;
      }
      throw e;
    }
  }
  if (!prf) {
    const err = new Error('prf-unsupported');
    err.code = 'prf-unsupported';
    err.enabledFlag = created.enabled;
    throw err;
  }
  return { credId, prfSalt, prf, path, enabledFlag: created.enabled };
}

// Second step of enroll() after a fresh tap (Safari).
export async function finishEnroll(pending) {
  const prf = await evaluate(pending.credId, pending.prfSalt);
  if (!prf) {
    const err = new Error('prf-unsupported');
    err.code = 'prf-unsupported';
    err.enabledFlag = pending.enabledFlag;
    throw err;
  }
  return { credId: pending.credId, prfSalt: pending.prfSalt, prf, path: 'get-after-tap', enabledFlag: pending.enabledFlag };
}
