import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { expect, it } from 'vitest';

it('builds a source archive without Git metadata and keeps privacy checks active', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vault-fetch-source-archive-'));
  const project = process.cwd();
  const source = join(root, 'source');
  try {
    await cp(project, source, { recursive: true, filter: path => !['.git', 'node_modules', '.dev', 'coverage', 'main.js'].includes(basename(path)) });
    await cp(join(project, 'node_modules'), join(source, 'node_modules'), { recursive: true });
    expect(spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: source }).status).not.toBe(0);
    const build = spawnSync(process.execPath, [join(source, 'scripts/build.mjs')], { cwd: source, encoding: 'utf8', timeout: 15_000 });
    expect(build.status, build.stderr).toBe(0);
    const validate = () => spawnSync(process.execPath, ['scripts/validate-package.mjs', '--bundle'], { cwd: source, encoding: 'utf8', timeout: 15_000 });
    const clean = validate();
    expect(clean.status, clean.stderr).toBe(0);
    expect((await readFile(join(source, 'main.js'), 'utf8')).length).toBeGreaterThan(1000);
    const syntheticToken = ['ghp', '_', 'a'.repeat(36)].join('');
    await writeFile(join(source, 'src/synthetic-leak.txt'), syntheticToken);
    const rejected = validate();
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain('Privacy check failed');
    expect(rejected.stderr).not.toContain(syntheticToken);
    await rm(join(source, 'src/synthetic-leak.txt'));
    await writeFile(join(source, 'node_modules/synthetic-leak.txt'), syntheticToken);
    expect(spawnSync('git', ['init', '-q'], { cwd: source }).status).toBe(0);
    expect(spawnSync('git', ['add', '-f', 'node_modules/synthetic-leak.txt'], { cwd: source }).status).toBe(0);
    const trackedLeak = validate();
    expect(trackedLeak.status).not.toBe(0);
    expect(trackedLeak.stderr).toContain('Privacy check failed');
    expect(trackedLeak.stderr).not.toContain(syntheticToken);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);
