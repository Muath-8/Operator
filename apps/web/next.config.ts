import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';
const outputDirectory = process.env.LO_NEXT_DIST_DIR ?? '.next';
if (!['.next', '.next-production', '.next-local'].includes(outputDirectory)) throw new Error('Invalid dedicated Next build directory');
const config: NextConfig = {
  distDir: outputDirectory,
  transpilePackages: ['@lo/state', '@lo/policy', '@lo/adapters', '@lo/runtime'],
  serverExternalPackages: ['playwright-core'],
  poweredByHeader: false,
  outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)),
  outputFileTracingIncludes: { '/api/missions/*/export': ['./assets/fonts/**/*'], '/api/inngest': ['../runtime/roles/*.md'] },
  webpack(config) {
    config.resolve.extensionAlias = { ...config.resolve.extensionAlias, '.js': ['.ts', '.tsx', '.js'] };
    return config;
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};
export default config;
