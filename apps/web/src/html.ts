/** HTML that has already been escaped or built from trusted templates. */
export class Html {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

type Part = Html | string | number | boolean | null | undefined | Part[];

function render(part: Part): string {
  if (part === null || part === undefined || part === false || part === true) return '';
  if (Array.isArray(part)) return part.map(render).join('');
  if (part instanceof Html) return part.value;
  return escapeHtml(String(part));
}

/**
 * Tagged template that escapes every interpolated value unless it is already Html. Arrays are
 * joined, and null, undefined and booleans render as nothing, so conditionals read naturally.
 */
export function html(strings: TemplateStringsArray, ...values: Part[]): Html {
  let out = strings[0] ?? '';
  values.forEach((value, i) => {
    out += render(value) + (strings[i + 1] ?? '');
  });
  return new Html(out);
}

/** Mark a string as trusted HTML. Only for content written in this repository. */
export function raw(value: string): Html {
  return new Html(value);
}
