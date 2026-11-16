import { describe, expect, it, vi } from 'vitest';
import { PluginInstaller } from '../../src/core/installer';
import type { FileStore, InstallOptions, PluginBuild, PluginLifecycle } from '../../src/types';

const encode = (value: unknown) => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
const decode = (value: Uint8Array | undefined) => value ? new TextDecoder().decode(value) : undefined;
const config = 'synthetic-config';
const pluginDir = `${config}/plugins/sample-plugin`;
const selfId = 'vault-fetch';
const transactionRoot = `${config}/plugins/${selfId}/transactions`;

function build(version = '1.1.0', id = 'sample-plugin', styles = true): PluginBuild {
  const manifest = { id, name: 'Sample', version, minAppVersion: '1.6.0', description: 'Synthetic fixture', author: 'Example' };
  return { repository: 'example/sample', tag: `v${version}`, manifest,
    files: { 'manifest.json': encode(manifest), 'main.js': encode(`code-${version}`), ...(styles ? { 'styles.css': encode(`css-${version}`) } : {}) } };
}

class MemoryFiles implements FileStore {
  readonly files = new Map<string, Uint8Array>();
  readonly folders = new Set<string>();
  readonly mutations: string[] = [];
  fail?: (operation: string, path: string) => boolean;
  partialWrite?: (path: string) => boolean;
  partialDelete?: (path: string) => boolean;
  onWrite?: (path: string) => void;
  onRead?: (path: string) => void;
  private check(operation: string, path: string): void {
    this.mutations.push(`${operation}:${path}`);
    if (this.fail?.(operation, path)) throw new Error('Synthetic disk failure');
  }
  async exists(path: string): Promise<boolean> { return this.files.has(path) || this.folders.has(path); }
  async read(path: string): Promise<Uint8Array> {
    this.onRead?.(path);
    const value = this.files.get(path);
    if (!value) throw new Error('Synthetic missing file');
    return value.slice();
  }
  async write(path: string, value: Uint8Array): Promise<void> {
    this.check('write', path);
    if (!this.folders.has(path.slice(0, path.lastIndexOf('/')))) throw new Error('Synthetic parent missing');
    if (this.partialWrite?.(path)) {
      this.files.set(path, value.slice(0, Math.max(1, Math.floor(value.byteLength / 2))));
      throw new Error('Synthetic failure after writing a partial file');
    }
    this.files.set(path, value.slice());
    this.onWrite?.(path);
  }
  async mkdir(path: string): Promise<void> { this.check('mkdir', path); this.folders.add(path); }
  async remove(path: string): Promise<void> { this.check('remove', path); this.files.delete(path); }
  async rename(from: string, to: string): Promise<void> {
    this.check('rename', to);
    if (await this.exists(to)) throw new Error('Synthetic rename does not overwrite existing destinations');
    if (this.folders.has(from)) {
      for (const path of [...this.files.keys()]) if (path.startsWith(`${from}/`)) {
        this.files.set(`${to}${path.slice(from.length)}`, this.files.get(path)!); this.files.delete(path);
      }
      for (const path of [...this.folders]) if (path === from || path.startsWith(`${from}/`)) {
        this.folders.add(`${to}${path.slice(from.length)}`); this.folders.delete(path);
      }
    } else { this.files.set(to, await this.read(from)); this.files.delete(from); }
  }
  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const immediate = (entry: string) => entry.startsWith(`${path}/`) && !entry.slice(path.length + 1).includes('/');
    return { files: [...this.files.keys()].filter(immediate), folders: [...this.folders].filter(immediate) };
  }
  async rmdir(path: string, recursive: boolean): Promise<void> {
    this.check('rmdir', path);
    if (this.partialDelete?.(path)) {
      this.files.delete(`${path}/journal.json`);
      throw new Error('Synthetic deletion failure after removing the journal');
    }
    if (recursive) {
      for (const name of this.files.keys()) if (name.startsWith(`${path}/`)) this.files.delete(name);
      for (const name of this.folders) if (name.startsWith(`${path}/`)) this.folders.delete(name);
    }
    this.folders.delete(path);
  }
  seed(path: string, content: Uint8Array): void {
    const components = path.split('/');
    for (let count = 1; count < components.length; count++) this.folders.add(components.slice(0, count).join('/'));
    this.files.set(path, content.slice());
  }
}

class Lifecycle implements PluginLifecycle {
  enabled = new Set<string>();
  loaded = new Set<string>();
  calls: string[] = [];
  failLoad?: () => boolean;
  supported(): boolean { return true; }
  isEnabled(id: string): boolean { return this.enabled.has(id); }
  isLoaded(id: string): boolean { return this.loaded.has(id); }
  async unload(id: string): Promise<void> { this.calls.push(`unload:${id}`); this.loaded.delete(id); }
  async refresh(): Promise<void> { this.calls.push('refresh'); }
  async load(id: string): Promise<void> {
    this.calls.push(`load:${id}`);
    if (this.failLoad?.()) throw new Error('Synthetic load failure');
    this.loaded.add(id);
  }
  async enable(id: string): Promise<void> { this.calls.push(`enable:${id}`); this.enabled.add(id); await this.load(id); }
  async disable(id: string): Promise<void> { this.calls.push(`disable:${id}`); this.enabled.delete(id); this.loaded.delete(id); }
}

function setup(existing = true, enabled = true): { files: MemoryFiles; lifecycle: Lifecycle; installer: PluginInstaller } {
  const files = new MemoryFiles();
  const lifecycle = new Lifecycle();
  if (existing) {
    const original = build('1.0.0');
    for (const [name, content] of Object.entries(original.files)) files.seed(`${pluginDir}/${name}`, content);
    files.seed(`${pluginDir}/data.json`, encode({ syntheticPreference: true }));
    files.seed(`${pluginDir}/custom.txt`, encode('preserve synthetic user file'));
    if (enabled) { lifecycle.enabled.add('sample-plugin'); lifecycle.loaded.add('sample-plugin'); }
  }
  return { files, lifecycle, installer: new PluginInstaller(files, lifecycle, { configDir: config, selfId }) };
}

const options = (extra: Partial<InstallOptions> = {}): InstallOptions => ({ managed: true, expectedPluginId: 'sample-plugin', enableAfterInstall: true, commit: async () => {}, ...extra });

describe('transactional plugin installer', () => {
  it('rejects unmanaged ID collisions, self replacement, and identity drift before changing files', async () => {
    const { files, installer } = setup();
    await expect(installer.install(build(), options({ managed: false }))).rejects.toMatchObject({ code: 'conflict' });
    await expect(installer.install(build('1.1.0', selfId), options())).rejects.toMatchObject({ code: 'self' });
    await expect(installer.install(build(), options({ expectedPluginId: 'different-id' }))).rejects.toMatchObject({ code: 'conflict' });
    const mutated = build(); mutated.manifest.id = 'different-id';
    await expect(installer.install(mutated, options())).rejects.toMatchObject({ code: 'manifest' });
    expect(files.mutations).toEqual([]);
  });

  it('updates only code files, removes obsolete CSS and preserves a disabled plugin', async () => {
    const { files, lifecycle, installer } = setup(true, false);
    await expect(installer.install(build('1.1.0', 'sample-plugin', false), options())).resolves.toEqual({ pluginId: 'sample-plugin', version: '1.1.0', enabled: false });
    expect(decode(files.files.get(`${pluginDir}/main.js`))).toBe('code-1.1.0');
    expect(await files.exists(`${pluginDir}/styles.css`)).toBe(false);
    expect(decode(files.files.get(`${pluginDir}/data.json`))).toBe('{"syntheticPreference":true}');
    expect(decode(files.files.get(`${pluginDir}/custom.txt`))).toBe('preserve synthetic user file');
    expect(lifecycle.isEnabled('sample-plugin')).toBe(false);
    expect(lifecycle.isLoaded('sample-plugin')).toBe(false);
    expect(files.mutations.some(value => value.endsWith('/data.json') || value.endsWith('/custom.txt'))).toBe(false);
  });

  it('preserves enabled and loaded state during an update', async () => {
    const { lifecycle, installer } = setup();
    await installer.install(build(), options({ enableAfterInstall: false }));
    expect(lifecycle.calls[0]).toBe('unload:sample-plugin');
    expect(lifecycle.isEnabled('sample-plugin')).toBe(true);
    expect(lifecycle.isLoaded('sample-plugin')).toBe(true);
  });

  it('installs a new plugin disabled unless enableAfterInstall is selected', async () => {
    for (const enabled of [false, true]) {
      const { lifecycle, installer } = setup(false);
      await installer.install(build(), options({ managed: false, expectedPluginId: undefined, enableAfterInstall: enabled }));
      expect(lifecycle.isEnabled('sample-plugin')).toBe(enabled);
      expect(lifecycle.isLoaded('sample-plugin')).toBe(enabled);
    }
  });

  it('allows reinstalling a registered plugin whose directory is missing', async () => {
    const { files, installer } = setup(false);
    await installer.install(build(), options({ allowMissing: true }));
    expect(await files.exists(`${pluginDir}/manifest.json`)).toBe(true);
  });

  it('rejects managed updates or adoption if manifest or main disappeared before the install lock', async () => {
    for (const missing of ['directory', 'manifest.json', 'main.js']) {
      const { files, installer } = setup(missing !== 'directory');
      if (missing !== 'directory') files.files.delete(`${pluginDir}/${missing}`);
      await expect(installer.install(build(), options())).rejects.toMatchObject({ code: 'conflict' });
      expect(files.mutations).toEqual([]);
    }
  });

  it('detects a plugin directory disappearing after the backup snapshot', async () => {
    const { files, installer } = setup();
    files.onWrite = path => {
      if (path.endsWith('/activation/main.js.tmp')) {
        for (const name of [...files.files.keys()]) if (name.startsWith(`${pluginDir}/`)) files.files.delete(name);
        files.folders.delete(pluginDir);
      }
    };
    await expect(installer.install(build(), options())).rejects.toMatchObject({ code: 'conflict' });
    expect(await files.exists(`${pluginDir}/manifest.json`)).toBe(false);
    expect(files.mutations.some(mutation => mutation.startsWith(`rename:${pluginDir}/`) || mutation.startsWith(`write:${pluginDir}/`))).toBe(false);
  });

  it('rejects an update if main disappears between the existence check and backup snapshot', async () => {
    const { files, installer } = setup();
    files.onRead = path => { if (path === `${pluginDir}/manifest.json`) files.files.delete(`${pluginDir}/main.js`); };
    await expect(installer.install(build(), options())).rejects.toMatchObject({ code: 'conflict' });
    expect(files.mutations).toEqual([]);
  });

  it('rejects an unmanaged directory appearing while a new install is staged', async () => {
    const { files, installer } = setup(false);
    files.onWrite = path => {
      if (path.endsWith('/activation/main.js.tmp')) files.seed(`${pluginDir}/data.json`, encode('independent synthetic preferences'));
    };
    await expect(installer.install(build(), options({ managed: false, expectedPluginId: undefined }))).rejects.toMatchObject({ code: 'conflict' });
    expect(await files.exists(`${pluginDir}/manifest.json`)).toBe(false);
    expect(decode(files.files.get(`${pluginDir}/data.json`))).toBe('independent synthetic preferences');
  });

  it('rolls back files and runtime state when new code cannot load', async () => {
    const { files, lifecycle, installer } = setup();
    lifecycle.failLoad = () => decode(files.files.get(`${pluginDir}/main.js`)) === 'code-1.1.0';
    const commit = vi.fn(async () => {});
    await expect(installer.install(build(), options({ commit }))).rejects.toMatchObject({ code: 'lifecycle' });
    expect(commit).not.toHaveBeenCalled();
    expect(decode(files.files.get(`${pluginDir}/main.js`))).toBe('code-1.0.0');
    expect(lifecycle.isEnabled('sample-plugin')).toBe(true);
    expect(lifecycle.isLoaded('sample-plugin')).toBe(true);
  });

  it('rolls back when persisting the managed registration fails', async () => {
    const { files, lifecycle, installer } = setup();
    await expect(installer.install(build(), options({ commit: async () => { throw new Error('Synthetic save failure'); } }))).rejects.toMatchObject({ code: 'filesystem' });
    expect(decode(files.files.get(`${pluginDir}/main.js`))).toBe('code-1.0.0');
    expect(lifecycle.isLoaded('sample-plugin')).toBe(true);
    expect((await files.list(transactionRoot)).folders).toEqual([]);
  });

  it('rolls back a target rename failure', async () => {
    const { files, installer } = setup();
    let failed = false;
    files.fail = (operation, path) => {
      if (!failed && operation === 'rename' && path === `${pluginDir}/main.js`) { failed = true; return true; }
      return false;
    };
    await expect(installer.install(build(), options())).rejects.toMatchObject({ code: 'filesystem' });
    expect(JSON.parse(decode(files.files.get(`${pluginDir}/manifest.json`))!).version).toBe('1.0.0');
    expect(decode(files.files.get(`${pluginDir}/main.js`))).toBe('code-1.0.0');
  });

  it('never exposes a partial activation write in the plugin directory', async () => {
    const { files, installer } = setup();
    files.partialWrite = path => path.endsWith('/activation/main.js.tmp');
    await expect(installer.install(build(), options())).rejects.toMatchObject({ code: 'filesystem' });
    expect(decode(files.files.get(`${pluginDir}/main.js`))).toBe('code-1.0.0');
    expect(JSON.parse(decode(files.files.get(`${pluginDir}/manifest.json`))!).version).toBe('1.0.0');
    expect(files.mutations.some(mutation => mutation.startsWith(`write:${pluginDir}/`) || mutation.startsWith(`remove:${pluginDir}/`))).toBe(false);
  });

  it('verifies complete activation bytes even when a truncated write reports success', async () => {
    const { files, installer } = setup();
    files.onWrite = path => {
      if (path.endsWith('/activation/main.js.tmp')) files.files.set(path, encode('truncated'));
    };
    await expect(installer.install(build(), options())).rejects.toMatchObject({ code: 'checksum' });
    expect(decode(files.files.get(`${pluginDir}/main.js`))).toBe('code-1.0.0');
    expect(files.mutations.some(mutation => mutation.startsWith(`remove:${pluginDir}/`))).toBe(false);
  });

  it('recovers preparation leftovers after a partial write before a valid journal exists', async () => {
    const { files, installer } = setup();
    files.partialWrite = path => path.endsWith('/activation/main.js.tmp');
    files.fail = operation => operation === 'rmdir';
    await expect(installer.install(build(), options())).rejects.toMatchObject({ code: 'filesystem' });
    expect((await files.list(transactionRoot)).folders[0]).toMatch(/\/preparing-[a-f0-9]{32}$/);
    expect([...files.files.keys()].some(path => path.endsWith('/journal.json'))).toBe(false);
    files.partialWrite = undefined;
    files.fail = undefined;
    expect(await installer.recover()).toEqual([{ pluginId: '', recovered: true }]);
    expect(decode(files.files.get(`${pluginDir}/main.js`))).toBe('code-1.0.0');
    await expect(installer.install(build(), options())).resolves.toHaveProperty('version', '1.1.0');
  });

  it('does not publish a partial initial journal or touch the target plugin', async () => {
    const { files, installer } = setup();
    files.partialWrite = path => path.endsWith('/journal.json.tmp');
    files.fail = operation => operation === 'rmdir';
    await expect(installer.install(build(), options())).rejects.toMatchObject({ code: 'filesystem' });
    expect([...files.files.keys()].some(path => path.endsWith('/journal.json'))).toBe(false);
    expect(files.mutations.some(mutation => mutation.startsWith(`remove:${pluginDir}/`))).toBe(false);
    files.partialWrite = undefined;
    files.fail = undefined;
    expect(await installer.recover()).toEqual([{ pluginId: '', recovered: true }]);
  });

  it('retains a valid journal and recoverable target files after a partial rollback temp write', async () => {
    const { files, lifecycle, installer } = setup();
    lifecycle.failLoad = () => decode(files.files.get(`${pluginDir}/main.js`)) === 'code-1.1.0';
    files.partialWrite = path => path.endsWith('/restore/main.js.tmp');
    await expect(installer.install(build(), options())).rejects.toMatchObject({ code: 'rollback' });
    expect(decode(files.files.get(`${pluginDir}/main.js`))).toBe('code-1.1.0');
    files.partialWrite = undefined;
    expect(await installer.recover()).toEqual([{ pluginId: 'sample-plugin', recovered: true }]);
    expect(decode(files.files.get(`${pluginDir}/main.js`))).toBe('code-1.0.0');
    expect(files.mutations.some(mutation => mutation.startsWith(`write:${pluginDir}/`))).toBe(false);
  });

  it('disables an explicitly reinstalled plugin on rollback when only its enabled cache existed before installation', async () => {
    const { files, lifecycle, installer } = setup(false);
    lifecycle.enabled.add('sample-plugin');
    lifecycle.loaded.add('sample-plugin');
    await expect(installer.install(build(), options({ allowMissing: true, commit: async () => { throw new Error('Synthetic save failure'); } })))
      .rejects.toMatchObject({ code: 'filesystem' });
    expect(await files.exists(`${pluginDir}/manifest.json`)).toBe(false);
    expect(await files.exists(`${pluginDir}/main.js`)).toBe(false);
    expect(lifecycle.isEnabled('sample-plugin')).toBe(false);
    expect(lifecycle.isLoaded('sample-plugin')).toBe(false);
  });

  it('checks cancellation before mutations and still completes rollback', async () => {
    const { files, installer } = setup();
    const guard = () => {
      if (decode(files.files.get(`${pluginDir}/main.js`)) === 'code-1.1.0') throw new Error('Synthetic cancellation');
    };
    await expect(installer.install(build(), options({ guard }))).rejects.toMatchObject({ code: 'cancelled' });
    expect(decode(files.files.get(`${pluginDir}/main.js`))).toBe('code-1.0.0');
    expect(decode(files.files.get(`${pluginDir}/styles.css`))).toBe('css-1.0.0');
  });

  it('does not call the guard or roll back after a successful commit, even if cleanup fails', async () => {
    const { files, installer } = setup();
    let committed = false;
    files.fail = operation => operation === 'rmdir';
    await installer.install(build(), options({ guard: () => { if (committed) throw new Error('Config fingerprint changed'); }, commit: async () => { committed = true; } }));
    expect(decode(files.files.get(`${pluginDir}/main.js`))).toBe('code-1.1.0');
    const journalPath = [...files.files.keys()].find(path => path.endsWith('/journal.json'))!;
    const committedPath = journalPath.replace('/journal.json', '/committed.json');
    expect(JSON.parse(decode(files.files.get(journalPath))!).phase).toBe('prepared');
    expect(JSON.parse(decode(files.files.get(committedPath))!).phase).toBe('committed');
    files.fail = undefined;
    expect(await installer.recover()).toEqual([{ pluginId: '', recovered: true }]);
    expect(decode(files.files.get(`${pluginDir}/main.js`))).toBe('code-1.1.0');
  });

  it('recovers cleanup interrupted after deleting the committed transaction journal without needing a receipt', async () => {
    const { files, lifecycle, installer } = setup();
    files.partialDelete = path => path.includes('/cleanup-');
    await installer.install(build(), options());
    const tombstone = (await files.list(transactionRoot)).folders[0]!;
    expect(tombstone).toMatch(/\/cleanup-[a-f0-9]{32}$/);
    expect(await files.exists(`${tombstone}/journal.json`)).toBe(false);
    expect(decode(files.files.get(`${pluginDir}/main.js`))).toBe('code-1.1.0');
    files.partialDelete = undefined;
    lifecycle.calls = [];
    const restarted = new PluginInstaller(files, lifecycle, { configDir: config, selfId });
    expect(await restarted.recover()).toEqual([{ pluginId: '', recovered: true }]);
    expect(lifecycle.calls).toEqual([]);
    expect(decode(files.files.get(`${pluginDir}/main.js`))).toBe('code-1.1.0');
    expect(decode(files.files.get(`${pluginDir}/data.json`))).toBe('{"syntheticPreference":true}');
    expect((await files.list(transactionRoot)).folders).toEqual([]);
  });

  it('recovers cleanup interrupted after deleting the fully rolled-back transaction journal', async () => {
    const { files, lifecycle, installer } = setup();
    files.partialDelete = path => path.includes('/cleanup-');
    await expect(installer.install(build(), options({ commit: async () => { throw new Error('Synthetic save failure'); } })))
      .rejects.toMatchObject({ code: 'filesystem' });
    const tombstone = (await files.list(transactionRoot)).folders[0]!;
    expect(tombstone).toMatch(/\/cleanup-[a-f0-9]{32}$/);
    expect(await files.exists(`${tombstone}/journal.json`)).toBe(false);
    expect(decode(files.files.get(`${pluginDir}/main.js`))).toBe('code-1.0.0');
    expect(lifecycle.isLoaded('sample-plugin')).toBe(true);
    files.partialDelete = undefined;
    lifecycle.calls = [];
    const restarted = new PluginInstaller(files, lifecycle, { configDir: config, selfId });
    expect(await restarted.recover()).toEqual([{ pluginId: '', recovered: true }]);
    expect(lifecycle.calls).toEqual([]);
    expect(decode(files.files.get(`${pluginDir}/main.js`))).toBe('code-1.0.0');
    expect((await files.list(transactionRoot)).folders).toEqual([]);
  });

  it('uses the persisted transaction ID if the final journal marker cannot be written', async () => {
    const { files, lifecycle } = setup();
    let registeredTransaction = '';
    files.partialWrite = path => path.endsWith('/committed.json.tmp');
    const installer = new PluginInstaller(files, lifecycle, { configDir: config, selfId,
      isCommitted: (id, transaction) => id === 'sample-plugin' && transaction === registeredTransaction });
    await installer.install(build(), options({ commit: async transaction => { registeredTransaction = transaction; } }));
    expect(registeredTransaction).toMatch(/^[a-f0-9]{32}$/);
    const journalPath = [...files.files.keys()].find(path => path.endsWith('/journal.json'))!;
    expect(JSON.parse(decode(files.files.get(journalPath))!).phase).toBe('prepared');
    expect(decode(files.files.get(`${pluginDir}/main.js`))).toBe('code-1.1.0');
    files.partialWrite = undefined;
    expect(await installer.recover()).toEqual([{ pluginId: 'sample-plugin', recovered: true }]);
    expect(decode(files.files.get(`${pluginDir}/main.js`))).toBe('code-1.1.0');
  });

  it('keeps the prepared journal intact if publishing the committed marker fails', async () => {
    const { files, lifecycle } = setup();
    let receipt = '';
    files.fail = (operation, path) => operation === 'rename' && path.endsWith('/committed.json');
    const installer = new PluginInstaller(files, lifecycle, { configDir: config, selfId,
      isCommitted: (id, transaction) => id === 'sample-plugin' && receipt === transaction });
    await installer.install(build(), options({ commit: async transaction => { receipt = transaction; } }));
    const directory = `${transactionRoot}/${receipt}`;
    expect(JSON.parse(decode(files.files.get(`${directory}/journal.json`))!).phase).toBe('prepared');
    expect(await files.exists(`${directory}/committed.json`)).toBe(false);
    expect(await files.exists(`${directory}/committed.json.tmp`)).toBe(true);
    expect(files.mutations).toContain(`rename:${transactionRoot}/preparing-${receipt}/journal.json`);
    expect(files.mutations.some(mutation => /^write:.*\/(?:journal|committed)\.json$/.test(mutation))).toBe(false);
    files.fail = undefined;
    expect(await installer.recover()).toEqual([{ pluginId: 'sample-plugin', recovered: true }]);
    expect(decode(files.files.get(`${pluginDir}/main.js`))).toBe('code-1.1.0');
  });

  it('blocks a second transaction while an earlier committed transaction cannot be retired', async () => {
    const { files, installer } = setup();
    files.fail = (operation, path) => operation === 'rename' && path.includes('/cleanup-');
    await installer.install(build(), options());
    await expect(installer.install(build('1.2.0'), options())).rejects.toMatchObject({ code: 'busy' });
    expect(decode(files.files.get(`${pluginDir}/main.js`))).toBe('code-1.1.0');
  });

  it('locks the plugin ID across installer instances while allowing the first transaction to complete', async () => {
    const { files, lifecycle, installer } = setup();
    let enter!: () => void;
    let finish!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const waiting = new Promise<void>(resolve => { finish = resolve; });
    const first = installer.install(build(), options({ commit: async () => { enter(); await waiting; } }));
    await entered;
    const second = new PluginInstaller(files, lifecycle, { configDir: config, selfId });
    expect(await second.recover()).toEqual([]);
    await expect(second.install(build(), options())).rejects.toMatchObject({ code: 'busy' });
    finish();
    await first;
  });
});

describe('transaction recovery', () => {
  it('retires a recovered transaction before partial garbage deletion can remove its journal', async () => {
    const { files, lifecycle, installer } = setup();
    files.fail = (operation, path) => operation === 'rename' && path === `${pluginDir}/main.js`;
    await expect(installer.install(build(), options())).rejects.toMatchObject({ code: 'rollback' });
    files.fail = undefined;
    files.partialDelete = path => path.includes('/cleanup-');
    const restarted = new PluginInstaller(files, lifecycle, { configDir: config, selfId });
    expect(await restarted.recover()).toEqual([{ pluginId: 'sample-plugin', recovered: true }]);
    const tombstone = (await files.list(transactionRoot)).folders[0]!;
    expect(tombstone).toMatch(/\/cleanup-[a-f0-9]{32}$/);
    expect(await files.exists(`${tombstone}/journal.json`)).toBe(false);
    files.partialDelete = undefined;
    expect(await new PluginInstaller(files, lifecycle, { configDir: config, selfId }).recover()).toEqual([{ pluginId: '', recovered: true }]);
    expect(decode(files.files.get(`${pluginDir}/main.js`))).toBe('code-1.0.0');
    expect((await files.list(transactionRoot)).folders).toEqual([]);
  });

  it('disables an enabled new plugin when recovering its uncommitted installation with no previous code', async () => {
    const { files, lifecycle, installer } = setup(false);
    files.fail = (operation, path) => operation === 'remove' && path === `${pluginDir}/main.js`;
    await expect(installer.install(build(), options({ managed: false, expectedPluginId: undefined,
      commit: async () => { throw new Error('Synthetic interruption before registration'); } }))).rejects.toMatchObject({ code: 'rollback' });
    const journalPath = [...files.files.keys()].find(path => path.endsWith('/journal.json'))!;
    expect(JSON.parse(decode(files.files.get(journalPath))!).oldFiles).toEqual([]);
    expect(lifecycle.isEnabled('sample-plugin')).toBe(true);
    lifecycle.loaded.add('sample-plugin');
    lifecycle.calls = [];
    files.fail = undefined;
    const restarted = new PluginInstaller(files, lifecycle, { configDir: config, selfId });
    expect(await restarted.recover()).toEqual([{ pluginId: 'sample-plugin', recovered: true }]);
    expect(await files.exists(`${pluginDir}/manifest.json`)).toBe(false);
    expect(await files.exists(`${pluginDir}/main.js`)).toBe(false);
    expect(lifecycle.isEnabled('sample-plugin')).toBe(false);
    expect(lifecycle.isLoaded('sample-plugin')).toBe(false);
    expect(lifecycle.calls).not.toContain('enable:sample-plugin');
    expect(lifecycle.calls).not.toContain('load:sample-plugin');
    expect((await files.list(transactionRoot)).folders).toEqual([]);
  });

  it('preserves an incomplete backup on failure and restores it on the next recovery', async () => {
    const { files, lifecycle, installer } = setup();
    files.fail = (operation, path) => operation === 'rename' && path === `${pluginDir}/main.js`;
    await expect(installer.install(build(), options())).rejects.toMatchObject({ code: 'rollback' });
    expect((await files.list(transactionRoot)).folders).toHaveLength(1);
    files.fail = undefined;
    const restarted = new PluginInstaller(files, lifecycle, { configDir: config, selfId });
    expect(await restarted.recover()).toEqual([{ pluginId: 'sample-plugin', recovered: true }]);
    expect(decode(files.files.get(`${pluginDir}/main.js`))).toBe('code-1.0.0');
    expect(JSON.parse(decode(files.files.get(`${pluginDir}/manifest.json`))!).version).toBe('1.0.0');
    expect(decode(files.files.get(`${pluginDir}/data.json`))).toBe('{"syntheticPreference":true}');
    expect(lifecycle.isEnabled('sample-plugin')).toBe(true);
    expect(lifecycle.isLoaded('sample-plugin')).toBe(false);
  });

  it('preserves the current disabled state instead of re-enabling a plugin from an older journal', async () => {
    const { files, lifecycle, installer } = setup();
    files.fail = (operation, path) => operation === 'rename' && path === `${pluginDir}/main.js`;
    await expect(installer.install(build(), options())).rejects.toMatchObject({ code: 'rollback' });
    const journalPath = [...files.files.keys()].find(path => path.endsWith('/journal.json'))!;
    expect(JSON.parse(decode(files.files.get(journalPath))!).enabled).toBe(true);
    files.fail = undefined;
    lifecycle.enabled.clear();
    lifecycle.loaded.clear();
    lifecycle.calls = [];
    const restarted = new PluginInstaller(files, lifecycle, { configDir: config, selfId });
    expect(await restarted.recover()).toEqual([{ pluginId: 'sample-plugin', recovered: true }]);
    expect(decode(files.files.get(`${pluginDir}/main.js`))).toBe('code-1.0.0');
    expect(lifecycle.isEnabled('sample-plugin')).toBe(false);
    expect(lifecycle.isLoaded('sample-plugin')).toBe(false);
    expect(lifecycle.calls).not.toContain('enable:sample-plugin');
    expect(lifecycle.calls).not.toContain('load:sample-plugin');
  });

  it('refuses recovery if target code changed independently', async () => {
    const { files, installer } = setup();
    files.fail = (operation, path) => operation === 'rename' && path === `${pluginDir}/main.js`;
    await expect(installer.install(build(), options())).rejects.toMatchObject({ code: 'rollback' });
    files.fail = undefined;
    files.seed(`${pluginDir}/main.js`, encode('independent synthetic edit'));
    expect(await installer.recover()).toEqual([expect.objectContaining({ recovered: false })]);
    expect(decode(files.files.get(`${pluginDir}/main.js`))).toBe('independent synthetic edit');
    expect((await files.list(transactionRoot)).folders).toHaveLength(1);
  });

  it.each([
    { pluginId: '../escape' }, { pluginId: selfId }, { oldFiles: ['data.json'] },
    { targetPath: `${pluginDir}/data.json` }, { schema: 2 },
  ])('rejects malicious journal fields without changing plugin files: %j', async extra => {
    const { files, installer } = setup();
    const journalPath = `${transactionRoot}/${'a'.repeat(32)}/journal.json`;
    files.seed(journalPath, encode({ schema: 1, phase: 'prepared', transactionId: 'a'.repeat(32), pluginId: 'sample-plugin', oldFiles: [],
      oldHashes: {}, newHashes: { 'manifest.json': '0'.repeat(64), 'main.js': '0'.repeat(64) }, enabled: false, loaded: false, ...extra }));
    const before = new Map([...files.files].map(([path, content]) => [path, decode(content)]));
    const result = await installer.recover();
    expect(result[0]?.recovered).toBe(false);
    expect(files.mutations).toEqual([]);
    expect(new Map([...files.files].map(([path, content]) => [path, decode(content)]))).toEqual(before);
  });

  it('retains a damaged ready transaction and blocks another update', async () => {
    const { files, installer } = setup();
    const journalPath = `${transactionRoot}/${'b'.repeat(32)}/journal.json`;
    files.seed(journalPath, encode('{"schema":1,"partial":'));
    expect(await installer.recover()).toEqual([expect.objectContaining({ recovered: false })]);
    expect(await files.exists(journalPath)).toBe(true);
    await expect(installer.install(build(), options())).rejects.toMatchObject({ code: 'rollback' });
    expect(files.mutations).toEqual([]);
    expect(decode(files.files.get(`${pluginDir}/main.js`))).toBe('code-1.0.0');
  });
});
