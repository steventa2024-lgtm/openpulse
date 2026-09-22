import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { KeyedMutex, readTextOr, writeFileAtomic } from '../util/fs.js';

export interface PairedDevice {
  deviceId: string;
  publicKey: string;
  displayName?: string;
  platform?: string;
  clientId?: string;
  role: 'operator' | 'node';
  createdAtMs: number;
  approvedAtMs: number;
  lastSeenAtMs?: number;
  /** sha256 of the issued device token. */
  tokenHash: string;
  label?: string;
}

export interface PairingRequestDevice {
  requestId: string;
  deviceId: string;
  publicKey: string;
  displayName?: string;
  platform?: string;
  clientId?: string;
  role: 'operator' | 'node';
  remoteIp?: string;
  ts: number;
}

/** Device id = first 32 hex chars of sha256(public key DER). */
export function deviceIdFromPublicKey(publicKeyB64: string): string {
  return createHash('sha256')
    .update(Buffer.from(publicKeyB64, 'base64'))
    .digest('hex')
    .slice(0, 32);
}

/** Verify an ECDSA P-256 (IEEE P1363) signature made with WebCrypto or node:crypto. */
export function verifyDeviceSignature(
  publicKeyB64: string,
  payload: string,
  signatureB64: string,
): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKeyB64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    return verify(
      'sha256',
      Buffer.from(payload),
      { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signatureB64, 'base64'),
    );
  } catch {
    return false;
  }
}

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

/**
 * Paired Control UI / CLI / node devices (devices/paired.json) and pending requests
 * (devices/pending.json). Loopback devices are approved silently by the gateway.
 */
export class DeviceStore extends EventEmitter<{
  requested: [PairingRequestDevice];
  resolved: [{ requestId: string; deviceId: string; decision: 'approved' | 'rejected' }];
}> {
  private readonly lock = new KeyedMutex();

  constructor(private readonly dir: string) {
    super();
  }

  async listPaired(): Promise<PairedDevice[]> {
    return Object.values(await this.readPaired());
  }

  async listPending(): Promise<PairingRequestDevice[]> {
    return (await this.readPending()).filter((r) => Date.now() - r.ts < 24 * 3600_000);
  }

  async get(deviceId: string): Promise<PairedDevice | undefined> {
    return (await this.readPaired())[deviceId];
  }

  checkToken(device: PairedDevice, token: string): boolean {
    const a = Buffer.from(hashToken(token));
    const b = Buffer.from(device.tokenHash);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Approve a device directly (loopback auto-approval, or from a pending request). Returns its token. */
  async approve(
    d: Omit<PairedDevice, 'createdAtMs' | 'approvedAtMs' | 'tokenHash'>,
  ): Promise<string> {
    return this.lock.run('paired', async () => {
      const all = await this.readPaired();
      const token = randomBytes(24).toString('base64url');
      const now = Date.now();
      all[d.deviceId] = {
        ...d,
        createdAtMs: all[d.deviceId]?.createdAtMs ?? now,
        approvedAtMs: now,
        tokenHash: hashToken(token),
      };
      await this.writePaired(all);
      return token;
    });
  }

  async touch(deviceId: string): Promise<void> {
    await this.lock.run('paired', async () => {
      const all = await this.readPaired();
      if (all[deviceId]) {
        all[deviceId].lastSeenAtMs = Date.now();
        await this.writePaired(all);
      }
    });
  }

  async addPending(
    r: Omit<PairingRequestDevice, 'requestId' | 'ts'>,
  ): Promise<PairingRequestDevice> {
    return this.lock.run('pending', async () => {
      const list = await this.readPending();
      const existing = list.find((x) => x.deviceId === r.deviceId);
      if (existing) return existing;
      const req: PairingRequestDevice = {
        ...r,
        requestId: randomBytes(4).toString('hex'),
        ts: Date.now(),
      };
      list.push(req);
      await this.writePending(list);
      this.emit('requested', req);
      return req;
    });
  }

  async approveRequest(requestId: string): Promise<PairedDevice | undefined> {
    const list = await this.readPending();
    const req = list.find((r) => r.requestId === requestId);
    if (!req) return undefined;
    await this.lock.run('pending', () => this.writePending(list.filter((r) => r !== req)));
    await this.approve({
      deviceId: req.deviceId,
      publicKey: req.publicKey,
      role: req.role,
      ...(req.displayName !== undefined && { displayName: req.displayName }),
      ...(req.platform !== undefined && { platform: req.platform }),
      ...(req.clientId !== undefined && { clientId: req.clientId }),
    });
    this.emit('resolved', { requestId, deviceId: req.deviceId, decision: 'approved' });
    return this.get(req.deviceId);
  }

  async rejectRequest(requestId: string): Promise<boolean> {
    return this.lock.run('pending', async () => {
      const list = await this.readPending();
      const req = list.find((r) => r.requestId === requestId);
      if (!req) return false;
      await this.writePending(list.filter((r) => r !== req));
      this.emit('resolved', { requestId, deviceId: req.deviceId, decision: 'rejected' });
      return true;
    });
  }

  async remove(deviceId: string): Promise<boolean> {
    return this.lock.run('paired', async () => {
      const all = await this.readPaired();
      if (!all[deviceId]) return false;
      delete all[deviceId];
      await this.writePaired(all);
      return true;
    });
  }

  private async readPaired(): Promise<Record<string, PairedDevice>> {
    const t = await readTextOr(path.join(this.dir, 'paired.json'), '');
    try {
      return t ? ((JSON.parse(t) as { devices?: Record<string, PairedDevice> }).devices ?? {}) : {};
    } catch {
      return {};
    }
  }

  private async writePaired(devices: Record<string, PairedDevice>): Promise<void> {
    await writeFileAtomic(
      path.join(this.dir, 'paired.json'),
      `${JSON.stringify({ version: 1, devices }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }

  private async readPending(): Promise<PairingRequestDevice[]> {
    const t = await readTextOr(path.join(this.dir, 'pending.json'), '');
    try {
      return t ? ((JSON.parse(t) as { requests?: PairingRequestDevice[] }).requests ?? []) : [];
    } catch {
      return [];
    }
  }

  private async writePending(requests: PairingRequestDevice[]): Promise<void> {
    await writeFileAtomic(
      path.join(this.dir, 'pending.json'),
      `${JSON.stringify({ version: 1, requests }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
}
