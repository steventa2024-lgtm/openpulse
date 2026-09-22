import { z } from 'zod';
import { clip, defineTool, fail, ok } from './types.js';

const CACHE_MS = 15 * 60_000;
const cache = new Map<string, { at: number; value: string }>();

function cached(key: string): string | undefined {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  return undefined;
}

export const webFetchTool = defineTool({
  name: 'web_fetch',
  description:
    'Fetch a URL and extract readable content (HTML → markdown or text). Good for articles and docs; use the browser tool for JS-heavy sites. Responses are cached for 15 minutes.',
  input: z.object({
    url: z.string().url(),
    extractMode: z.enum(['markdown', 'text']).default('markdown'),
    maxChars: z.number().int().min(100).optional(),
  }),
  summarize: (i) => `fetch ${i.url}`,
  async execute(input, ctx) {
    const url = new URL(input.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      return fail('Only http(s) URLs are supported.');
    const max = Math.min(
      input.maxChars ?? ctx.config.tools.web.fetch.maxChars,
      ctx.config.tools.web.fetch.maxChars,
    );
    const key = `${input.extractMode}:${url.href}`;
    let text = cached(key);
    if (text === undefined) {
      const res = await fetch(url, {
        headers: {
          'user-agent': 'Mozilla/5.0 (OpenPulse web_fetch)',
          accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(20_000),
        ...(ctx.signal && { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(20_000)]) }),
      });
      if (!res.ok) return fail(`HTTP ${res.status} ${res.statusText} for ${url.href}`);
      const type = res.headers.get('content-type') ?? '';
      const body = await res.text();
      text = type.includes('html') ? htmlToReadable(body, input.extractMode) : body;
      cache.set(key, { at: Date.now(), value: text });
    }
    return ok(clip(`Source: ${url.href}\n\n${text}`, max));
  },
});

export const webSearchTool = defineTool({
  name: 'web_search',
  description: 'Search the web (Brave Search). Returns titles, URLs and snippets.',
  input: z.object({
    query: z.string().min(1),
    count: z.number().int().min(1).max(10).optional(),
  }),
  summarize: (i) => `search "${i.query}"`,
  async execute(input, ctx) {
    const cfg = ctx.config.tools.web.search;
    const key = cfg.apiKey ?? process.env.BRAVE_API_KEY;
    if (!key)
      return fail(
        'web_search needs a Brave Search API key (tools.web.search.apiKey or BRAVE_API_KEY). Use web_fetch or the browser instead.',
      );
    const count = input.count ?? cfg.maxResults;
    const cacheKey = `search:${count}:${input.query}`;
    const hit = cached(cacheKey);
    if (hit) return ok(hit);
    const res = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(input.query)}&count=${count}`,
      {
        headers: { accept: 'application/json', 'x-subscription-token': key },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) return fail(`Brave Search HTTP ${res.status}`);
    const data = (await res.json()) as {
      web?: { results?: { title: string; url: string; description?: string }[] };
    };
    const rows = (data.web?.results ?? []).map(
      (r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${stripTags(r.description ?? '')}`,
    );
    const text = rows.join('\n') || 'No results.';
    cache.set(cacheKey, { at: Date.now(), value: text });
    return ok(text);
  },
});

/** Small, dependency-free HTML → markdown/text extraction. */
export function htmlToReadable(html: string, mode: 'markdown' | 'text'): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe)[\s\S]*?<\/\1>/gi, '');
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(s)?.[1]?.trim();
  const main = /<(main|article)[^>]*>([\s\S]*?)<\/\1>/i.exec(s);
  if (main) s = main[2]!;
  const md = mode === 'markdown';
  s = s
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_a, n: string, t: string) =>
      md ? `\n\n${'#'.repeat(Number(n))} ${stripTags(t)}\n\n` : `\n\n${stripTags(t)}\n\n`,
    )
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_a, href: string, t: string) => {
      const label = stripTags(t).trim();
      return md && label && /^https?:/.test(href) ? `[${label}](${href})` : label;
    })
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|tr|ul|ol|table|blockquote|pre)>/gi, '\n\n')
    .replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, (_a, _t, t: string) => (md ? `**${t}**` : t))
    .replace(/<code>([\s\S]*?)<\/code>/gi, (_a, t: string) => (md ? `\`${t}\`` : t));
  s = decodeEntities(stripTags(s))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+\n/g, '\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return title ? `${md ? '# ' : ''}${decodeEntities(title)}\n\n${s}` : s;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '');
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_a, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}
