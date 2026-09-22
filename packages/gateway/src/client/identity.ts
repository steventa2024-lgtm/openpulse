import { generateKeyPairSync, createPrivateKey, sign } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { deviceIdFromPublicKey } from '../gateway/devices.js';
import { deviceSignaturePayload } from '../gateway/protocol.js';

export interface DeviceIdentity {
  deviceId: string;
  publicKey: string;
  privateKey: string;
}

/** Load (or create) this machine's device key: identity/device.json in the state dir. */
export async function loadOrCreateIdentity(identityDir: string): Promise<DeviceIdentity> {
  const file = path.join(identityDir, 'device.json');
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(await fsp.readFile(file, 'utf8')) as DeviceIdentity;
      if (parsed.publicKey && parsed.privateKey) return parsed;
    } catch {
      // regenerate below
    }
  }
  const identity = createIdentity();
  await fsp.mkdir(identityDir, { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(identity, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return identity;
}

export function createIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  const pub = publicKey.toString('base64');
  return {
    deviceId: deviceIdFromPublicKey(pub),
    publicKey: pub,
    privateKey: privateKey.toString('base64'),
  };
}

export function signChallenge(
  identity: DeviceIdentity,
  p: { nonce: string; clientId: string; role: string },
): { id: string; publicKey: string; signature: string; signedAt: number; nonce: string } {
  const signedAt = Date.now();
  const payload = deviceSignaturePayload({ ...p, signedAt });
  const key = createPrivateKey({
    key: Buffer.from(identity.privateKey, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  const signature = sign('sha256', Buffer.from(payload), {
    key,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64');
  return {
    id: identity.deviceId,
    publicKey: identity.publicKey,
    signature,
    signedAt,
    nonce: p.nonce,
  };
}
