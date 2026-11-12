import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadTestLinks } from './traceability-links.js';

const root = resolve(process.cwd()),
  artifacts = resolve(root, '.local/quality');
async function files(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', '.next', 'dist', '.git', '.local', 'coverage'].includes(entry.name) || entry.name.startsWith('.next-')) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else if (/\.(test|spec)\.tsx?$/.test(path)) result.push(path);
  }
  return result;
}
const requirementsPath = process.env['LO_REQUIREMENTS_FILE'] ?? join(root, 'docs/01-BRD-and-Functional-Requirements.md');
let brd: string;
try {
  brd = await readFile(requirementsPath, 'utf8');
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  console.error(
    'BLOCKED: Full release traceability requires the private requirements file. Set LO_REQUIREMENTS_FILE to its path. No acceptance evidence is counted as passed.',
  );
  process.exit(2);
}
const requirements = brd
  .split(/\r?\n/)
  .filter(line => /^\| NFR-/.test(line) || (/^\| FR-/.test(line) && (/\| MVP \|/.test(line) || /^\| FR-PLY-08 /.test(line))))
  .map(line => line.match(/(?:FR-[A-Z]+|NFR)-\d+/)?.[0])
  .filter((id): id is string => !!id);
const declarations: Record<string, string[]> = {};
for (const file of await files(root)) {
  const content = await readFile(file, 'utf8');
  for (const id of new Set(content.match(/(?:FR-[A-Z]+|NFR)-\d+/g) ?? []))
    declarations[id] = [...(declarations[id] ?? []), file.slice(root.length + 1)];
}
const mappedLinks = await loadTestLinks(
  root,
  requirements,
  process.env['LO_REQUIREMENT_TEST_MAP'] ?? join(root, 'docs/implementation/requirement-test-map.json'),
);
for (const link of mappedLinks)
  declarations[link.requirementId] = [...new Set([...(declarations[link.requirementId] ?? []), link.testFile])];
const covered = requirements.filter(id => declarations[id]?.length),
  missing = requirements.filter(id => !declarations[id]?.length);
await mkdir(artifacts, { recursive: true });
await writeFile(
  join(artifacts, 'requirement-traceability.json'),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      kind: 'declared_test_links',
      note: 'Source declarations identify tests to execute; they do not certify passed acceptance evidence.',
      expectedInScopeCount: requirements.length,
      declaredCount: covered.length,
      declaredCoverage: requirements.length ? covered.length / requirements.length : 0,
      requirements: requirements.map(id => ({
        id,
        testFiles: declarations[id] ?? [],
        mappedLinks: mappedLinks.filter(link => link.requirementId === id),
      })),
      missing,
    },
    null,
    2,
  ) + '\n',
);
process.stdout.write(
  JSON.stringify({
    expectedInScope: requirements.length,
    declared: covered.length,
    missing: missing.length,
    artifact: join(artifacts, 'requirement-traceability.json'),
  }) + '\n',
);
process.exitCode = missing.length ? 1 : 0;
