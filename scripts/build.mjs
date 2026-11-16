import { context } from 'esbuild';
import { readFile } from 'node:fs/promises';

const notices = await Promise.all(['LICENSE', 'node_modules/semver/LICENSE', 'node_modules/@noble/hashes/LICENSE'].map(path => readFile(path, 'utf8')));

const build = await context({
  entryPoints: ['src/main.ts'],
  outfile: 'main.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2018',
  external: ['obsidian'],
  sourcemap: false,
  logLevel: 'info',
  treeShaking: true,
  banner: { js: `/*!\n${notices.join('\n\n').replaceAll('*/', '* /')}\n*/` },
});
if (process.argv.includes('--watch')) await build.watch();
else { await build.rebuild(); await build.dispose(); }
