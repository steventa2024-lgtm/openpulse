import readline from 'node:readline';
import type { GatewayClient } from '@openpulse/gateway';
import { c } from './palette.js';

export interface TuiOptions {
  client: GatewayClient;
  sessionKey: string;
  /** Print tool activity as it happens. */
  verbose: boolean;
  out?: NodeJS.WritableStream;
  input?: NodeJS.ReadableStream;
}

/**
 * Interactive terminal chat: streams assistant text, shows tool activity, and answers exec
 * approvals inline (a/o/d) without leaving the conversation.
 */
export async function runTui(options: TuiOptions): Promise<void> {
  const out = options.out ?? process.stdout;
  const { client, sessionKey } = options;
  const write = (s: string) => out.write(s);

  const pendingApprovals: { id: string; command: string }[] = [];
  let streaming = false;
  let lastLength = 0;
  let busy = false;

  const prompt = () => {
    if (pendingApprovals.length > 0)
      write(`${c.warn('allow once [o] / always [a] / deny [d]')} › `);
    else write(`${c.bold('you')} › `);
  };

  client.on('event', ({ event, payload }) => {
    if (event === 'chat') {
      const p = payload as {
        sessionKey: string;
        state: string;
        message?: { content: { type: string; text?: string }[] };
        errorMessage?: string;
      };
      if (p.sessionKey !== sessionKey) return;
      const text =
        p.message?.content
          .filter((x) => x.type === 'text')
          .map((x) => x.text ?? '')
          .join('') ?? '';
      if (p.state === 'delta') {
        if (!streaming) {
          write(`\n${c.accent('openpulse')} › `);
          streaming = true;
          lastLength = 0;
        }
        write(text.slice(lastLength));
        lastLength = text.length;
      } else if (p.state === 'final') {
        if (!streaming) write(`\n${c.accent('openpulse')} › ${text}`);
        else if (text.length > lastLength) write(text.slice(lastLength));
        write('\n\n');
        streaming = false;
        busy = false;
        prompt();
      } else if (p.state === 'aborted') {
        write(`\n${c.muted('(aborted)')}\n\n`);
        streaming = false;
        busy = false;
        prompt();
      } else if (p.state === 'error') {
        write(`\n${c.error(`error: ${p.errorMessage ?? 'unknown'}`)}\n\n`);
        streaming = false;
        busy = false;
        prompt();
      }
      return;
    }
    if (event === 'agent' && options.verbose) {
      const p = payload as { sessionKey: string; stream: string; data: Record<string, unknown> };
      if (p.sessionKey !== sessionKey || p.stream !== 'tool') return;
      if (p.data.phase === 'start') write(`\n${c.muted(`  ⚙ ${String(p.data.summary)}`)}\n`);
      else if (p.data.isError) write(`${c.error(`  ✗ ${String(p.data.name)}`)}\n`);
      return;
    }
    if (event === 'exec.approval.requested') {
      const a = payload as {
        id: string;
        request: { command: string; risk: { level: string; reason: string } };
      };
      pendingApprovals.push({ id: a.id, command: a.request.command });
      write(
        `\n${c.warn(`⚠ approval required (${a.request.risk.level}: ${a.request.risk.reason})`)}\n  ${a.request.command}\n`,
      );
      prompt();
    }
  });

  const rl = readline.createInterface({
    input: options.input ?? process.stdin,
    output: out,
    terminal: false,
  });
  write(`${c.muted(`session ${sessionKey} · /help for commands · "exit" to quit`)}\n`);
  prompt();

  await new Promise<void>((resolve) => {
    rl.on('line', (line) => {
      const text = line.trim();
      const approval = pendingApprovals[0];
      if (approval) {
        const answer = text.toLowerCase();
        const decision =
          answer === 'o' || answer === 'y'
            ? 'allow-once'
            : answer === 'a'
              ? 'allow-always'
              : answer === 'd' || answer === 'n'
                ? 'deny'
                : undefined;
        if (!decision) {
          write(`${c.muted('answer with o (once), a (always) or d (deny)')}\n`);
          prompt();
          return;
        }
        pendingApprovals.shift();
        void client
          .request('exec.approval.resolve', { id: approval.id, decision })
          .catch(() => undefined);
        return;
      }
      if (text === '') return prompt();
      if (text === 'exit' || text === 'quit') return resolve();
      if (busy && text === '/stop') {
        void client.request('chat.abort', { sessionKey }).catch(() => undefined);
        return;
      }
      busy = true;
      void client
        .request<{ status: string; command?: boolean }>('chat.send', { sessionKey, message: text })
        .then((r) => {
          if (r.command) {
            busy = false; // command replies arrive as injected chat events
          }
        })
        .catch((e: unknown) => {
          write(`\n${c.error(`send failed: ${(e as Error).message}`)}\n`);
          busy = false;
          prompt();
        });
    });
    rl.on('close', () => resolve());
  });
  rl.close();
}
