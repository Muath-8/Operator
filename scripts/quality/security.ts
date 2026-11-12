import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import ts from 'typescript';
import { syntheticCorpus } from '../../packages/evals/fixtures/seed.js';

const root = resolve(process.cwd()),
  findings: { kind: string; file: string; line: number }[] = [];
const profiles = syntheticCorpus()
  .filter(f => f.suite === 'product')
  .flatMap(f => {
    const p = f.input['profile'];
    return p && typeof p === 'object' && !Array.isArray(p) && typeof p['id'] === 'string' ? [p['id']] : [];
  });
const categoryNames = [...new Set(profiles)].map(name => name.toLowerCase());
async function scan(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (
      ['node_modules', '.next', 'dist', '.git', '.local', 'coverage', 'prototypes'].includes(entry.name) ||
      entry.name.startsWith('.next-')
    )
      continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await scan(path);
      continue;
    }
    if (!/\.(?:ts|tsx|js|mjs|json|sql|ya?ml)$/.test(path) || /lock\.yaml$/.test(path)) continue;
    const body = await readFile(path, 'utf8'),
      relative = path.slice(root.length + 1);
    for (const pattern of [/\bsk-proj-[A-Za-z0-9_-]{20,}\b/g, /\bAKIA[A-Z0-9]{16}\b/g, /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g])
      for (const match of body.matchAll(pattern))
        findings.push({
          kind: 'possible_secret',
          file: relative,
          line: body.slice(0, match.index).split('\n').length,
        });
    if (!/\.(?:ts|tsx)$/.test(path) || /(?:fixtures|profiles|seed|\.test\.|\.spec\.)/.test(relative)) continue;
    const source = ts.createSourceFile(path, body, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteralLike(node) && categoryNames.some(name => node.text.toLowerCase().includes(name)))
        findings.push({
          kind: 'category_literal_outside_seed',
          file: relative,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        });
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
}
await scan(root);
await mkdir(join(root, '.local/quality'), { recursive: true });
await writeFile(
  join(root, '.local/quality/security-scan.json'),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      scope: 'source heuristics only; not a penetration test or proof of all I-11/I-15 behavior',
      findings,
    },
    null,
    2,
  ) + '\n',
);
process.stdout.write(
  JSON.stringify({
    findings: findings.length,
    secrets: findings.filter(f => f.kind === 'possible_secret').length,
    categoryHits: findings.filter(f => f.kind === 'category_literal_outside_seed').length,
  }) + '\n',
);
process.exitCode = findings.length ? 1 : 0;
