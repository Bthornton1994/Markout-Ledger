// The v1 offline boundary (docs/OWNER_GATE_STATUS.md): Markout Ledger v1 is offline evaluation, so its default path
// (src/cli/main.ts, src/index.ts and every module they import) never reaches the disabled Kraken adapter placeholder,
// no file under src/ holds network code or a venue endpoint, no package script names a venue, and the placeholder stays
// disabled. These checks read the tree under test; none performs network I/O. A Kraken adapter pursued later fails them
// by design, and pursuing one reopens C2, C3 and C5.
import { readdirSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KRAKEN_ADAPTER_ENABLED, openKrakenAdapter } from '../src/market/kraken-adapter.js';

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const ADAPTER = 'src/market/kraken-adapter.ts';
const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> } & Record<string, unknown>;

/** Every TypeScript file under src/, as a repository-relative POSIX path. */
const sources = (): string[] =>
  readdirSync(new URL('../src/', import.meta.url), { encoding: 'utf8', recursive: true })
    .map((f) => `src/${f.replace(/\\/g, '/')}`)
    .filter((f) => f.endsWith('.ts'))
    .sort();

/** The files reachable from `entry` through relative imports, re-exports and dynamic imports (a `.js` specifier names the
 * `.ts` source). A specifier inside a comment counts too, which can only make the walk reach more. */
const reachable = (entry: string): Set<string> => {
  const seen = new Set<string>();
  const queue = [entry];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    for (const m of read(file).matchAll(/\b(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
      queue.push(posix.join(posix.dirname(file), m[1]!.replace(/\.js$/, '.ts')));
    }
  }
  return seen;
};

/** Network code or a venue endpoint: a Kraken API host, a WebSocket URL or class, fetch and the other browser clients, or
 * an import of a Node network module or of a network client package. */
const NETWORK =
  /api\.kraken\.com|wss:\/\/|WebSocket|\bfetch\s*\(|\bXMLHttpRequest\b|\bEventSource\b|\b(?:from|import|require)\s*\(?\s*['"](?:node:)?(?:net|http|https|http2|tls|dgram|ws|undici|axios|node-fetch)['"]/i;

describe('the v1 default path', () => {
  it('reaches the replay engine from src/cli/main.ts and src/index.ts, and never the disabled Kraken adapter', () => {
    for (const entry of ['src/cli/main.ts', 'src/index.ts']) {
      const files = reachable(entry);
      expect(files, entry).toContain('src/engine/replay.ts');
      expect(files, entry).toContain('src/market/synthetic.ts');
      expect(files, entry).not.toContain(ADAPTER);
    }
  });

  it('names no venue in any package script', () => {
    expect(Object.keys(pkg.scripts)).toContain('demo');
    for (const [name, command] of Object.entries(pkg.scripts)) expect(`${name}: ${command}`).not.toMatch(/kraken|wss/i);
  });
});

describe('no network code under src/', () => {
  it('finds no Kraken host, WebSocket, fetch or network import in any file under src/, the disabled adapter included', () => {
    const files = sources();
    expect(files).toContain('src/cli/main.ts');
    expect(files).toContain(ADAPTER);
    for (const file of files) expect(read(file), file).not.toMatch(NETWORK);
  });
});

describe('the disabled Kraken adapter placeholder', () => {
  it('is disabled, and calling it throws and names the gates it would reopen', () => {
    expect(KRAKEN_ADAPTER_ENABLED).toBe(false);
    expect(() => openKrakenAdapter()).toThrow(/disabled[\s\S]*reopens C2, C3 and C5/);
  });

  it('is not the CLI entry: the only source file a package script runs is src/cli/main.ts, and no entry field names it', () => {
    const run = Object.values(pkg.scripts).flatMap((command) => [...command.matchAll(/\btsx\s+(src\/\S+)/g)].map((m) => m[1]!));
    expect(new Set(run)).toEqual(new Set(['src/cli/main.ts']));
    for (const field of ['main', 'bin', 'exports', 'module']) expect(JSON.stringify(pkg[field] ?? null), field).not.toMatch(/kraken/i);
  });
});

describe('the README states the v1 scope without overclaiming', () => {
  const readme = read('README.md');

  it('records v1 as offline evaluation with C2, C3, and C5 OUT OF SCOPE FOR V1, and never calls it launched or production-ready', () => {
    expect(readme).toContain('v1 is offline evaluation on synthetic fixtures only');
    expect(readme).toContain('the default path is `npm run demo`');
    expect(readme).toContain('C2, C3, and C5 are OUT OF SCOPE FOR V1 and not passed');
    expect(readme).not.toMatch(/\blaunched\b|production-ready/i);
  });
});
