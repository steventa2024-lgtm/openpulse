/**
 * This browser's device identity: an ECDSA P-256 key pair kept in localStorage as JWK.
 * The gateway derives the device id from the SPKI public key, exactly as the CLI does.
 */

const STORAGE_KEY = 'openpulse.device.v1';

export interface BrowserIdentity {
  deviceId: string;
  publicKey: string; // base64 SPKI
  privateKey: CryptoKey;
}

interface StoredIdentity {
  publicKeyJwk: JsonWebKey;
  privateKeyJwk: JsonWebKey;
  publicKey: string;
  deviceId: string;
}

const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const;

export async function loadOrCreateIdentity(): Promise<BrowserIdentity> {
  const stored = read();
  if (stored) {
    try {
      const privateKey = await crypto.subtle.importKey(
        'jwk',
        stored.privateKeyJwk,
        ALGORITHM,
        true,
        ['sign'],
      );
      return { deviceId: stored.deviceId, publicKey: stored.publicKey, privateKey };
    } catch {
      // fall through and regenerate
    }
  }
  const pair = await crypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);
  const spki = await crypto.subtle.exportKey('spki', pair.publicKey);
  const publicKey = toBase64(new Uint8Array(spki));
  const deviceId = await deviceIdFromPublicKey(spki);
  const entry: StoredIdentity = {
    publicKey,
    deviceId,
    publicKeyJwk: await crypto.subtle.exportKey('jwk', pair.publicKey),
    privateKeyJwk: await crypto.subtle.exportKey('jwk', pair.privateKey),
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entry));
  } catch {
    // private browsing — the identity simply won't persist
  }
  return { deviceId, publicKey, privateKey: pair.privateKey };
}

export async function signChallenge(
  identity: BrowserIdentity,
  p: { nonce: string; clientId: string; role: string },
): Promise<{ id: string; publicKey: string; signature: string; signedAt: number; nonce: string }> {
  const signedAt = Date.now();
  const payload = `openpulse-connect|v1|${p.nonce}|${signedAt}|${p.clientId}|${p.role}`;
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    identity.privateKey,
    new TextEncoder().encode(payload),
  );
  return {
    id: identity.deviceId,
    publicKey: identity.publicKey,
    signature: toBase64(new Uint8Array(signature)),
    signedAt,
    nonce: p.nonce,
  };
}

function read(): StoredIdentity | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredIdentity) : undefined;
  } catch {
    return undefined;
  }
}

async function deviceIdFromPublicKey(spki: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', spki);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
