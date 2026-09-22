import fs from 'node:fs/promises';
import path from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { z } from 'zod';
import { silentLogger, type Logger } from '../../infra/logger.js';
import { clip, defineTool, fail, ok } from './types.js';

export interface BrowserOptions {
  enabled: boolean;
  headless: boolean;
  channel: 'auto' | 'chrome' | 'msedge' | 'chromium';
}

const REF_ATTR = 'data-op-ref';

/**
 * The agent's dedicated browser: one Playwright-driven Chrome/Edge profile with multiple tabs.
 * `snapshot` labels interactive elements with refs (e1, e2 …) that `act` then targets.
 */
export class BrowserSession {
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private active: Page | undefined;
  private launching: Promise<void> | undefined;

  constructor(
    private readonly options: () => BrowserOptions,
    private readonly screenshotDir: string,
    private readonly log: Logger = silentLogger,
  ) {}

  get running(): boolean {
    return this.browser !== undefined;
  }

  status() {
    return {
      running: this.running,
      tabs: this.context?.pages().length ?? 0,
      url: this.active && !this.active.isClosed() ? this.active.url() : undefined,
      headless: this.options().headless,
    };
  }

  async start(): Promise<void> {
    if (this.browser) return;
    this.launching ??= this.launch().finally(() => (this.launching = undefined));
    await this.launching;
  }

  async stop(): Promise<void> {
    const b = this.browser;
    this.browser = undefined;
    this.context = undefined;
    this.active = undefined;
    await b?.close().catch(() => undefined);
  }

  async page(): Promise<Page> {
    await this.start();
    if (!this.active || this.active.isClosed()) {
      this.active =
        this.context!.pages().find((p) => !p.isClosed()) ?? (await this.context!.newPage());
    }
    return this.active;
  }

  async tabs(): Promise<{ targetId: string; url: string; title: string; active: boolean }[]> {
    if (!this.context) return [];
    const pages = this.context.pages();
    return Promise.all(
      pages.map(async (p, i) => ({
        targetId: `t${i + 1}`,
        url: p.url(),
        title: await p.title().catch(() => ''),
        active: p === this.active,
      })),
    );
  }

  async open(url: string): Promise<Page> {
    await this.start();
    const p = await this.context!.newPage();
    this.active = p;
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    return p;
  }

  focus(targetId: string): boolean {
    const idx = Number(targetId.replace(/^t/, '')) - 1;
    const p = this.context?.pages()[idx];
    if (!p) return false;
    this.active = p;
    return true;
  }

  async close(targetId?: string): Promise<boolean> {
    const p = targetId
      ? this.context?.pages()[Number(targetId.replace(/^t/, '')) - 1]
      : this.active;
    if (!p) return false;
    await p.close();
    if (p === this.active) this.active = undefined;
    return true;
  }

  async screenshot(fullPage: boolean): Promise<string> {
    const p = await this.page();
    await fs.mkdir(this.screenshotDir, { recursive: true });
    const file = path.join(
      this.screenshotDir,
      `${new Date().toISOString().replace(/[:.]/g, '-')}.png`,
    );
    await p.screenshot({ path: file, fullPage });
    return file;
  }

  private async launch(): Promise<void> {
    const opts = this.options();
    if (!opts.enabled) throw new Error('Browser is disabled (browser.enabled=false).');
    const { chromium } = await import('playwright-core');
    const candidates =
      opts.channel === 'auto'
        ? ['chrome', 'msedge', undefined]
        : [opts.channel === 'chromium' ? undefined : opts.channel];
    const errors: string[] = [];
    for (const channel of candidates) {
      try {
        const browser = await chromium.launch({
          headless: opts.headless,
          ...(channel && { channel }),
        });
        browser.on('disconnected', () => {
          if (this.browser === browser) {
            this.browser = undefined;
            this.context = undefined;
            this.active = undefined;
          }
        });
        this.browser = browser;
        this.context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        this.active = await this.context.newPage();
        this.log.info('browser started', {
          channel: channel ?? 'chromium',
          headless: opts.headless,
        });
        return;
      } catch (error) {
        errors.push(`${channel ?? 'chromium'}: ${(error as Error).message.split('\n')[0]}`);
      }
    }
    throw new Error(
      `No usable browser (${errors.join('; ')}). Install Chrome or Edge, or run "npx playwright install chromium".`,
    );
  }
}

/** Label interactive elements with refs and return a compact outline of the page. */
async function snapshot(page: Page, maxChars: number): Promise<string> {
  const outline = await page.evaluate((attr) => {
    // Runs in the browser. The gateway does not compile against DOM types, so the handful of
    // properties this walk touches are described structurally instead.
    interface Style {
      display: string;
      visibility: string;
    }
    interface El {
      tagName?: string;
      innerText?: string;
      value?: string;
      placeholder?: string;
      title?: string;
      name?: string;
      type?: string;
      ownerDocument: { defaultView: { getComputedStyle: (el: El) => Style } };
      matches?: (selector: string) => boolean;
      setAttribute: (name: string, value: string) => void;
      getAttribute: (name: string) => string | null;
      querySelector: (selector: string) => El | null;
    }
    interface Walker {
      currentNode: El | null;
      nextNode: () => El | null;
    }
    interface Doc {
      body: El;
      createTreeWalker: (root: El, whatToShow: number) => Walker;
    }

    const doc = (globalThis as unknown as { document: Doc }).document;
    let n = 0;
    const lines: string[] = [];
    const interactive =
      'a[href],button,input,textarea,select,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],[contenteditable="true"]';
    const walker = doc.createTreeWalker(doc.body, 1);
    let el = walker.currentNode;
    while (el) {
      const tag = String(el.tagName ?? '').toLowerCase();
      const style = el.ownerDocument.defaultView.getComputedStyle(el);
      const hidden = style.display === 'none' || style.visibility === 'hidden';
      if (!hidden) {
        if (/^h[1-6]$/.test(tag)) {
          const t = String(el.innerText ?? '')
            .trim()
            .replace(/\s+/g, ' ');
          if (t) lines.push(`${'#'.repeat(Number(tag[1]))} ${t.slice(0, 120)}`);
        } else if (el.matches?.(interactive)) {
          n += 1;
          const ref = `e${n}`;
          el.setAttribute(attr, ref);
          const inputRole =
            el.type === 'checkbox' ? 'checkbox' : el.type === 'submit' ? 'button' : 'textbox';
          const role =
            el.getAttribute('role') ||
            (tag === 'a'
              ? 'link'
              : tag === 'select'
                ? 'combobox'
                : tag === 'textarea'
                  ? 'textbox'
                  : tag === 'input'
                    ? inputRole
                    : tag);
          const name = String(
            el.getAttribute('aria-label') ||
              el.innerText ||
              el.value ||
              el.placeholder ||
              el.title ||
              el.name ||
              '',
          )
            .trim()
            .replace(/\s+/g, ' ')
            .slice(0, 80);
          const extra = tag === 'a' ? ` → ${el.getAttribute('href') ?? ''}` : '';
          lines.push(`[${ref}] ${role} "${name}"${extra}`);
        } else if (tag === 'p' || tag === 'li' || tag === 'td') {
          const t = String(el.innerText ?? '')
            .trim()
            .replace(/\s+/g, ' ');
          if (t && !el.querySelector(interactive)) lines.push(t.slice(0, 200));
        }
      }
      el = walker.nextNode();
    }
    return lines.join('\n');
  }, REF_ATTR);
  return clip(`Title: ${await page.title()}\nURL: ${page.url()}\n\n${outline}`, maxChars);
}

const ActRequest = z.object({
  kind: z.enum(['click', 'type', 'press', 'hover', 'select', 'fill', 'wait', 'evaluate']),
  ref: z.string().optional().describe('Element ref from snapshot, e.g. "e12".'),
  text: z.string().optional().describe('Text for type/fill, option for select.'),
  key: z.string().optional().describe('Key for press, e.g. Enter.'),
  submit: z.boolean().optional().describe('For type: press Enter afterwards.'),
  timeMs: z.number().int().min(0).max(30_000).optional().describe('For wait.'),
  fn: z.string().optional().describe('For evaluate: a JS expression evaluated in the page.'),
});

export function createBrowserTool(session: BrowserSession) {
  return defineTool({
    name: 'browser',
    description:
      "Control the agent's own browser. Actions: status, start, stop, tabs, open {url}, focus {targetId}, close {targetId?}, navigate {url}, snapshot (outline with element refs like e12), screenshot {fullPage?} (saved to a file), act {request:{kind: click|type|press|hover|select|fill|wait|evaluate, ref, text, key, submit}}. Take a snapshot first, then act on refs from it.",
    input: z.object({
      action: z.enum([
        'status',
        'start',
        'stop',
        'tabs',
        'open',
        'focus',
        'close',
        'navigate',
        'snapshot',
        'screenshot',
        'act',
      ]),
      url: z.string().optional(),
      targetId: z.string().optional(),
      fullPage: z.boolean().optional(),
      request: ActRequest.optional(),
      maxChars: z.number().int().min(500).optional(),
    }),
    summarize: (i) =>
      `browser ${i.action}${i.url ? ` ${i.url}` : i.request ? ` ${i.request.kind}${i.request.ref ? ` ${i.request.ref}` : ''}` : ''}`,
    async execute(input) {
      const max = input.maxChars ?? 12_000;
      const needUrl = () => {
        if (!input.url) throw new Error('"url" is required');
        const u = new URL(/^[a-z]+:/i.test(input.url) ? input.url : `https://${input.url}`);
        if (u.protocol !== 'http:' && u.protocol !== 'https:')
          throw new Error('only http(s) URLs are allowed');
        return u.href;
      };
      try {
        switch (input.action) {
          case 'status':
            return ok(JSON.stringify(session.status()));
          case 'start':
            await session.start();
            return ok('Browser started.');
          case 'stop':
            await session.stop();
            return ok('Browser stopped.');
          case 'tabs':
            return ok(
              (await session.tabs())
                .map((t) => `${t.active ? '*' : ' '} ${t.targetId}  ${t.title}  ${t.url}`)
                .join('\n') || 'No tabs.',
            );
          case 'open': {
            const p = await session.open(needUrl());
            return ok(await snapshot(p, max));
          }
          case 'focus':
            return session.focus(input.targetId ?? '') ? ok('Focused.') : fail('Unknown targetId.');
          case 'close':
            return (await session.close(input.targetId)) ? ok('Closed.') : fail('No such tab.');
          case 'navigate': {
            const p = await session.page();
            await p.goto(needUrl(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
            return ok(await snapshot(p, max));
          }
          case 'snapshot':
            return ok(await snapshot(await session.page(), max));
          case 'screenshot':
            return ok(`Saved screenshot: ${await session.screenshot(input.fullPage ?? false)}`);
          case 'act': {
            const r = input.request;
            if (!r) return fail('"request" is required for act');
            const p = await session.page();
            const target = () => {
              if (!r.ref) throw new Error('"request.ref" is required (take a snapshot first)');
              return p.locator(`[${REF_ATTR}="${r.ref}"]`).first();
            };
            switch (r.kind) {
              case 'click':
                await target().click({ timeout: 10_000 });
                break;
              case 'hover':
                await target().hover({ timeout: 10_000 });
                break;
              case 'type':
              case 'fill':
                await target().fill(r.text ?? '', { timeout: 10_000 });
                if (r.submit) await target().press('Enter');
                break;
              case 'press':
                if (r.ref) await target().press(r.key ?? 'Enter');
                else await p.keyboard.press(r.key ?? 'Enter');
                break;
              case 'select':
                await target().selectOption(r.text ?? '');
                break;
              case 'wait':
                await p.waitForTimeout(r.timeMs ?? 1000);
                break;
              case 'evaluate': {
                const value: unknown = await p.evaluate(r.fn ?? 'undefined');
                return ok(clip(JSON.stringify(value, null, 2) ?? 'undefined', max));
              }
            }
            await p.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => undefined);
            return ok(await snapshot(p, max));
          }
        }
      } catch (error) {
        return fail(`browser ${input.action} failed: ${(error as Error).message.split('\n')[0]}`);
      }
      return fail('Unknown action');
    },
  });
}
