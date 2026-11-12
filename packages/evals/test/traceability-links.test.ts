import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { it, expect } from 'vitest';
import { validateTestLinks, loadTestLinks } from '../../../scripts/quality/traceability-links.js';
it('validates actual test declarations and rejects invented source links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lo-trace-links-'));
  try {
    await writeFile(
      join(root, 'sample.test.ts'),
      "const misleading='invented test';it('actual claim',()=>{});it.each([1])('parameterized claim',()=>{});",
    );
    const entry = {
      requirementId: 'FR-MIS-01',
      testFile: 'sample.test.ts',
      testTitle: 'actual claim',
      coverageNote: 'One narrow assertion, not full acceptance.',
    };
    expect(await validateTestLinks(root, ['FR-MIS-01'], [entry])).toEqual([entry]);
    const manifest = join(root, 'manifest.json');
    expect(await loadTestLinks(root, ['FR-MIS-01'], manifest)).toEqual([]);
    await writeFile(manifest, JSON.stringify([{ ...entry, testFile: 'missing.test.ts' }]));
    await expect(loadTestLinks(root, ['FR-MIS-01'], manifest)).rejects.toMatchObject({ code: 'ENOENT' });

    expect(await validateTestLinks(root, ['FR-MIS-01'], [{ ...entry, testTitle: 'parameterized claim' }])).toHaveLength(1);
    await expect(validateTestLinks(root, ['FR-MIS-01'], [{ ...entry, testTitle: 'invented test' }])).rejects.toThrow(/actual test/);
    await expect(validateTestLinks(root, ['FR-MIS-01'], [{ ...entry, testFile: '../outside.test.ts' }])).rejects.toThrow(/repository/);
    await expect(validateTestLinks(root, ['FR-MIS-01'], [{ ...entry, requirementId: 'NFR-99' }])).rejects.toThrow(/out-of-scope/);
  } finally {
    const target = resolve(root);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('lo-trace-links-'))
      throw Error('Test cleanup path outside created temporary directory');
    await rm(target, { recursive: true, force: true });
  }
});
