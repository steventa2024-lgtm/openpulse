import net from 'node:net';

export type PortOccupant = 'openpulse' | 'foreign' | 'free';

export interface ProbeResult {
  occupant: PortOccupant;
  version?: string;
}

export interface ProbeDeps {
  fetchFn?: typeof fetch;
  connectFn?: typeof net.connect;
  timeoutMs?: number;
}

/**
 * Work out who owns a port.
 *
 * An HTTP answer from `/health` identifies an OpenPulse gateway we can attach to. Anything else
 * that accepts a TCP connection is somebody else's — on Windows that includes services which
 * accept and then say nothing, which is why a failed HTTP request alone is not enough to call a
 * port free.
 */
export async function probePort(port: number, deps: ProbeDeps = {}): Promise<ProbeResult> {
  const timeoutMs = deps.timeoutMs ?? 2_000;
  const fetchFn = deps.fetchFn ?? fetch;

  try {
    const response = await fetchFn(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) {
      const body = (await response.json()) as { ok?: boolean; version?: string };
      if (body.ok === true && typeof body.version === 'string') {
        return { occupant: 'openpulse', version: body.version };
      }
    }
    return { occupant: 'foreign' };
  } catch {
    // No usable HTTP answer: fall through to the connection test.
  }

  return (await canConnect(port, timeoutMs, deps.connectFn))
    ? { occupant: 'foreign' }
    : { occupant: 'free' };
}

function canConnect(
  port: number,
  timeoutMs: number,
  connectFn: typeof net.connect = net.connect,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    const socket = connectFn({ port, host: '127.0.0.1' });
    socket.setTimeout?.(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}
