import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright-core';

/**
 * Captures the screenshots the website shows from a real, running OpenPulse gateway. Nothing is
 * staged in the page: whatever the gateway has — projects, change sets, recorded runs — is what
 * appears. Run it against a gateway on this machine (loopback clients get the token themselves):
 *
 *   OPENPULSE_URL=http://127.0.0.1:18789 pnpm --filter @openpulse/web exec tsx scripts/capture-screenshots.ts
 *
 * Needs Microsoft Edge or Google Chrome installed (BROWSER_CHANNEL=chrome to pick Chrome).
 */

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(appDir, 'public', 'img');
const base = (process.env.OPENPULSE_URL ?? 'http://127.0.0.1:18789').replace(/\/$/, '');

interface Shot {
  name: string;
  route: string;
  /** Optional interaction before the capture, e.g. opening a run. */
  prepare?: (page: Page) => Promise<void>;
}

const SHOTS: Shot[] = [
  {
    name: 'chat',
    route: 'chat',
    prepare: async (page) => {
      // A fresh conversation shows the welcome screen; the context panel shows the real project.
      await page.getByTitle('New conversation').click();
      await page.getByText('How can I help you today?').waitFor();
      await page.locator('.ctx-card').first().waitFor();
      await page
        .getByText(/available$/)
        .first()
        .waitFor({ timeout: 10_000 });
    },
  },
  {
    name: 'changes',
    route: 'changes',
    prepare: async (page) => {
      // The page opens the first pending change set; wait for its diff editor to render.
      await page.locator('.diff-host .monaco-diff-editor').first().waitFor({ timeout: 20_000 });
    },
  },
  {
    name: 'debugger',
    route: 'debugger',
    prepare: async (page) => {
      const withTool = page.getByText(/· 1 tool\b|· [2-9] tools/).first();
      await withTool.waitFor({ timeout: 10_000 });
      await withTool.click();
      await page.locator('.timeline-event').first().waitFor();
    },
  },
  {
    name: 'models',
    route: 'models',
    prepare: async (page) => {
      await page
        .getByText(/running · v/)
        .first()
        .waitFor({ timeout: 15_000 });
    },
  },
];

const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL ?? 'msedge',
  headless: true,
});
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1.5,
    colorScheme: 'dark',
  });
  // Show the chat's context panel, whatever this browser profile last chose.
  await context.addInitScript(() => {
    try {
      localStorage.setItem('openpulse.chat.context', '1');
    } catch {
      // ignore
    }
  });
  const page = await context.newPage();
  for (const shot of SHOTS) {
    await page.goto(`${base}/#/${shot.route}`);
    await page.getByText('Health OK').first().waitFor({ timeout: 15_000 });
    await shot.prepare?.(page);
    await page.waitForTimeout(800);
    const file = path.join(outDir, `${shot.name}.png`);
    await page.screenshot({ path: file });
    console.log(`captured ${path.relative(appDir, file)}`);
  }
} finally {
  await browser.close();
}
