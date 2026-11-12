import { createGenerator } from 'ts-json-schema-generator';
import { createRequire } from 'node:module';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const Ajv = require('ajv');
const standalone = require('ajv/dist/standalone');
const schema = createGenerator({
  path: 'apps/web/src/ui-contract.ts',
  tsconfig: 'apps/web/tsconfig.json',
  type: 'MissionView',
  jsDoc: 'none',
  additionalProperties: true,
}).createSchema('MissionView');
const ajv = new Ajv({ code: { source: true, esm: true }, strict: true });
const code = '// Generated from ui-contract.ts. Run pnpm schema:ui; do not edit.\n' + standalone(ajv, ajv.compile(schema));
const path = 'apps/web/src/lib/mission-view-validator.js';
if (process.argv.includes('--check')) {
  if ((await readFile(path, 'utf8')) !== code) throw new Error('UI validator is stale: run pnpm schema:ui');
} else {
  await writeFile(`${path}.tmp`, code, 'utf8');
  await rename(`${path}.tmp`, path);
}
