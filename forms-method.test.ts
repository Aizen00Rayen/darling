import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
// Secrets, and personal data (a customer's or a user's name and phone): either must never be able to reach the URL
// through a native GET fallback (a submit before hydration, JavaScript disabled or failing).
const SECRET_MARKERS = [
  'type="password"',
  'autoComplete="current-password"',
  'autoComplete="new-password"',
  'one-time-code',
  'token',
  'name="phone"',
  'name="fullName"',
];

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return tsxFiles(full);
    return full.endsWith('.tsx') && !full.endsWith('.test.tsx') ? [full] : [];
  });
}

/** Every `<form ...>` opening tag with the source up to its `</form>`. */
function formBlocks(source: string): { tag: string; block: string }[] {
  const blocks: { tag: string; block: string }[] = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf('<form', from);
    if (start === -1) return blocks;
    const end = source.indexOf('</form>', start);
    const block = source.slice(start, end === -1 ? undefined : end);
    blocks.push({ tag: block.slice(0, block.indexOf('>') + 1), block });
    from = start + 5;
  }
}

describe('forms that carry secrets or personal data', () => {
  it('are method="post" (a native GET fallback would leak them into the URL)', () => {
    const offenders: string[] = [];
    for (const dir of ['app', 'components']) {
      for (const file of tsxFiles(path.join(ROOT, dir))) {
        for (const { tag, block } of formBlocks(readFileSync(file, 'utf8'))) {
          const secret = SECRET_MARKERS.some((m) => block.includes(m));
          if (secret && !/method="post"/i.test(tag)) offenders.push(`${path.relative(ROOT, file)}: ${tag}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
