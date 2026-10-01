import { cp, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';

await mkdir('dist/ui', { recursive: true });
await build({
  entryPoints: ['src/ui/harness-dashboard.ts'],
  bundle: true,
  format: 'esm',
  outfile: 'dist/ui/app.js',
  sourcemap: true,
  target: ['es2022'],
});
await cp('src/ui/index.html', 'dist/ui/index.html');
