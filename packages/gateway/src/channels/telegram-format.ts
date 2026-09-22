/**
 * Convert the Markdown models write into Telegram's HTML parse mode, which only supports a small
 * tag set (b, i, s, code, pre, a, blockquote). Anything unrecognised is escaped as text.
 */
export function markdownToTelegramHtml(markdown: string): string {
  const blocks: string[] = [];
  // Pull fenced code blocks out first so nothing inside them is formatted.
  let text = markdown.replace(/```[^\n`]*\n([\s\S]*?)```/g, (_all, code: string) => {
    blocks.push(`<pre>${escapeHtml(code.replace(/\n$/, ''))}</pre>`);
    return `\uE000${blocks.length - 1}\uE000`;
  });

  const inline: string[] = [];
  text = text.replace(/`([^`\n]+)`/g, (_all, code: string) => {
    inline.push(`<code>${escapeHtml(code)}</code>`);
    return `\uE001${inline.length - 1}\uE001`;
  });

  text = escapeHtml(text)
    // Links: [text](https://…)
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_all, label: string, url: string) => {
      return `<a href="${url.replace(/"/g, '&quot;')}">${label}</a>`;
    })
    // Headings become bold lines.
    .replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/__([^_\n]+)__/g, '<b>$1</b>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<i>$2</i>')
    .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<i>$2</i>')
    .replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
    // Bullets: "- item" / "* item" → "• item"
    .replace(/^(\s*)[-*]\s+/gm, '$1• ')
    // Block quotes (">" was escaped to &gt;)
    .replace(/^&gt;\s?(.*)$/gm, '<blockquote>$1</blockquote>')
    .replace(/<\/blockquote>\n<blockquote>/g, '\n');

  return text
    .replace(/\uE001(\d+)\uE001/g, (_all, i: string) => inline[Number(i)]!)
    .replace(/\uE000(\d+)\uE000/g, (_all, i: string) => blocks[Number(i)]!);
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Split text into chunks under Telegram's 4096-character limit, preferring paragraph, then line,
 * then word boundaries.
 */
export function chunkText(text: string, max = 3900): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf('\n\n');
    if (cut < max * 0.5) cut = window.lastIndexOf('\n');
    if (cut < max * 0.5) cut = window.lastIndexOf(' ');
    if (cut < max * 0.5) cut = max;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0 || chunks.length === 0) chunks.push(rest);
  return chunks;
}
