/**
 * Client build script using Bun.build() API.
 *
 * Aliases react → preact/compat for libraries like virtua.
 * Bun's `alias` handles bare specifiers (react, react-dom).
 * A plugin handles subpath imports (react/jsx-runtime) that `alias` doesn't cover.
 */

import type { BunPlugin } from 'bun';
import { resolve } from 'node:path';

const preactJsxRuntime = resolve(
  import.meta.dir,
  'node_modules/preact/jsx-runtime/dist/jsxRuntime.mjs',
);

const reactCompatPlugin: BunPlugin = {
  name: 'react-to-preact',
  setup(build) {
    build.onResolve({ filter: /^react\/jsx(-dev)?-runtime$/ }, () => ({
      path: preactJsxRuntime,
    }));
  },
};

const result = await Bun.build({
  entrypoints: ['src/client/index.tsx'],
  outdir: 'public',
  target: 'browser',
  sourcemap: 'inline',
  minify: process.argv.includes('--minify'),
  plugins: [reactCompatPlugin],
  alias: {
    react: 'preact/compat',
    'react-dom': 'preact/compat',
  },
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}
