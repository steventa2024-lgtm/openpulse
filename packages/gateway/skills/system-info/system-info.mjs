import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
const hours = (s) => `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;

const cpus = os.cpus();
const lines = [
  `Host: ${os.hostname()} · ${os.type()} ${os.release()} (${os.arch()})`,
  `Uptime: ${hours(os.uptime())}`,
  `CPU: ${cpus.length}× ${cpus[0]?.model.trim() ?? 'unknown'}` +
    (process.platform === 'win32'
      ? ''
      : ` · load ${os
          .loadavg()
          .map((l) => l.toFixed(2))
          .join(' / ')}`),
  `Memory: ${gb(os.totalmem() - os.freemem())} used of ${gb(os.totalmem())} (${gb(os.freemem())} free)`,
  'Disks:',
];

for (const mount of await mountPoints()) {
  try {
    const s = await fs.statfs(mount);
    const total = s.blocks * s.bsize;
    if (total === 0) continue;
    const free = s.bavail * s.bsize;
    lines.push(
      `- ${mount} ${gb(free)} free of ${gb(total)} (${((free / total) * 100).toFixed(0)}% free)`,
    );
  } catch {
    // Not ready (e.g. an empty card reader); skip.
  }
}
console.log(lines.join('\n'));

async function mountPoints() {
  if (process.platform === 'win32') {
    const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    const found = await Promise.all(
      letters.map((l) =>
        fs.access(`${l}:\\`).then(
          () => `${l}:\\`,
          () => null,
        ),
      ),
    );
    return found.filter(Boolean);
  }
  return [...new Set(['/', os.homedir(), path.parse(os.tmpdir()).root])];
}
