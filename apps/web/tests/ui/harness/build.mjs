// TEST HARNESS ONLY. Bundles tests/ui/harness/main.tsx (real components + explicit test fixtures) into
// tests/ui/harness/dist/ (gitignored). Never part of the app build or any production route.
// esbuild is resolved from the repository; set ESBUILD_PATH to point at another install if needed.
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..', '..', '..');
export const DIST = join(here, 'dist');

async function loadEsbuild() {
  if (process.env.ESBUILD_PATH) return import(pathToFileURL(process.env.ESBUILD_PATH).href);
  for (const from of [
    import.meta.url,
    pathToFileURL(join(webRoot, 'package.json')).href,
    pathToFileURL(join(webRoot, '..', '..', 'package.json')).href,
  ]) {
    try {
      return import(pathToFileURL(createRequire(from).resolve('esbuild')).href);
    } catch {
      /* try the next location */
    }
  }
  throw new Error('esbuild is not installed. Add it as a dev dependency (root owns installs) or set ESBUILD_PATH.');
}

export async function build() {
  const esbuild = await loadEsbuild();
  mkdirSync(DIST, { recursive: true });
  await esbuild.build({
    entryPoints: [join(here, 'main.tsx')],
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    outdir: DIST,
    loader: { '.css': 'css' },
    define: { 'process.env.NODE_ENV': '"development"' },
    nodePaths: [join(webRoot, 'node_modules')],
    logLevel: 'warning',
    sourcemap: false,
  });
  copyFileSync(join(here, 'index.html'), join(DIST, 'index.html'));
  return DIST;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  build().then(
    d => console.log(`harness built: ${d}`),
    e => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
