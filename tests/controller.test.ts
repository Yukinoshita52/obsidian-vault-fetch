import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VaultFetchController } from '../src/controller';
import { defaultSettings, parseSettings } from '../src/settings';
import type { ControllerHost } from '../src/controller';
import type { InstallOptions, ManagedSource, PluginBuild, PluginManifest, PreparedRelease, VaultFetchSettings } from '../src/types';

const network = vi.hoisted(() => ({ prepare: vi.fn(), download: vi.fn() }));
vi.mock('../src/core/github', async importOriginal => {
  const original = await importOriginal<typeof import('../src/core/github')>();
  return { ...original, GitHubClient: class {
    prepare(...args: unknown[]) { return network.prepare(...args); }
    download(...args: unknown[]) { return network.download(...args); }
  } };
});

const manifest: PluginManifest = { id: 'sample-plugin', name: 'Sample', version: '1.1.0', minAppVersion: '1.6.0', description: 'Synthetic fixture', author: 'Example' };
function release(version = '1.1.0', id = 'sample-plugin'): PreparedRelease {
  return { repository: 'example/sample', tag: version, name: version, url: 'https://github.com/example/sample/releases', prerelease: false,
    manifest: { ...manifest, id, version }, manifestBytes: new TextEncoder().encode('{}'),
    assets: { manifest: { id: 1, name: 'manifest.json', size: 2 }, main: { id: 2, name: 'main.js', size: 1 } } };
}
const tracked = (extra: Partial<ManagedSource> = {}): ManagedSource => ({ repository: 'example/sample', pluginId: 'sample-plugin', name: 'Sample', secretName: '', pinnedTag: '', autoUpdate: false, installedTag: '1.0.0', installedVersion: '1.0.0', ...extra });
const transactionId = 'a'.repeat(32);

function setup(settings = defaultSettings(), present = false) {
  const installed = new Map<string, PluginManifest>();
  if (present) installed.set('sample-plugin', { ...manifest, version: '1.0.0' });
  const persisted: VaultFetchSettings[] = [];
  const host: ControllerHost = {
    transport: { request: vi.fn() }, secret: () => 'synthetic-secret-value',
    installed: id => installed.get(id), exists: async id => installed.has(id), compatible: () => true,
    save: vi.fn(async value => { persisted.push(value); }), changed: vi.fn(),
  };
  const installer = {
    install: vi.fn(async (build: PluginBuild, options: InstallOptions) => {
      options.guard?.();
      await options.commit(transactionId);
      installed.set(build.manifest.id, build.manifest);
      return { pluginId: build.manifest.id, version: build.manifest.version, enabled: true };
    }),
    recover: vi.fn(async () => [] as { pluginId: string; recovered: boolean }[]),
  };
  return { controller: new VaultFetchController(settings, host, installer, 'vault-fetch'), host, installer, installed, persisted };
}

beforeEach(() => {
  network.prepare.mockReset().mockImplementation(async () => release());
  network.download.mockReset().mockImplementation(async (r: PreparedRelease) => ({ repository: r.repository, tag: r.tag, manifest: r.manifest, files: { 'manifest.json': r.manifestBytes, 'main.js': new Uint8Array([1]) } }));
});

describe('source ownership and persistence', () => {
  it('rejects self installation and incompatible releases before writing', async () => {
    const { controller, host, installer } = setup();
    network.prepare.mockResolvedValueOnce(release('1.1.0', 'vault-fetch'));
    await expect(controller.preview('example/sample', '', '')).rejects.toMatchObject({ code: 'self' });
    host.compatible = () => false;
    await expect(controller.preview('example/sample', '', '')).rejects.toMatchObject({ code: 'compatibility' });
    expect(installer.install).not.toHaveBeenCalled();
  });

  it('requires explicit adoption and passes a previously validated ID to the installer', async () => {
    const { controller, installer } = setup(defaultSettings(), true);
    const options = { secretName: 'example-secret-name', pinnedTag: '', enableAfterInstall: true, adoptExisting: false };
    await expect(controller.install(release(), options)).rejects.toMatchObject({ code: 'conflict' });
    await controller.install(release(), { ...options, adoptExisting: true });
    expect(installer.install.mock.calls[0]?.[1]).toMatchObject({ managed: true, expectedPluginId: 'sample-plugin' });
    expect(controller.settings.sources[0]).toMatchObject({ pluginId: 'sample-plugin', transactionId, secretName: 'example-secret-name' });
    expect(JSON.stringify(controller.settings)).not.toContain('synthetic-secret-value');
  });

  it('also protects a directory without a registered manifest', async () => {
    const { controller, host, installer } = setup();
    host.exists = async () => true;
    expect(await controller.hasExistingPlugin('sample-plugin')).toBe(true);
    await expect(controller.install(release(), { secretName: '', pinnedTag: '', enableAfterInstall: true, adoptExisting: false })).rejects.toMatchObject({ code: 'conflict' });
    expect(installer.install).not.toHaveBeenCalled();
  });

  it('does not switch an ID already owned by another repository', async () => {
    const settings = defaultSettings(); settings.sources.push(tracked({ repository: 'example/other' }));
    const { controller, installer } = setup(settings, true);
    await expect(controller.install(release(), { secretName: '', pinnedTag: '', enableAfterInstall: false, adoptExisting: true })).rejects.toMatchObject({ code: 'conflict' });
    expect(installer.install).not.toHaveBeenCalled();
  });

  it('rolls back in-memory ownership when persisting its transaction marker fails', async () => {
    const { controller, host } = setup();
    host.save = vi.fn(async () => { throw new Error('Synthetic disk error'); });
    await expect(controller.install(release(), { secretName: '', pinnedTag: '', enableAfterInstall: true, adoptExisting: false })).rejects.toMatchObject({ code: 'settings' });
    expect(controller.settings.sources).toHaveLength(0);
    expect(controller.hasCommitted('sample-plugin', transactionId)).toBe(false);
  });

  it('cancels a prepared download if credential selection changes before installation', async () => {
    const { controller, installer } = setup();
    let finish!: (build: PluginBuild) => void;
    network.download.mockImplementationOnce(() => new Promise<PluginBuild>(resolve => { finish = resolve; }));
    const operation = controller.install(release(), { secretName: '', pinnedTag: '', enableAfterInstall: true, adoptExisting: false });
    await vi.waitFor(() => expect(network.download).toHaveBeenCalled());
    await controller.mutate(next => { next.secretName = 'another-secret-name'; });
    finish({ repository: 'example/sample', tag: '1.1.0', manifest, files: { 'manifest.json': new Uint8Array(), 'main.js': new Uint8Array() } });
    await expect(operation).rejects.toMatchObject({ code: 'cancelled' });
    expect(installer.install).not.toHaveBeenCalled();
  });

  it('serializes settings changes without losing unrelated edits', async () => {
    const { controller, host } = setup();
    let finish!: () => void;
    host.save = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; })).mockResolvedValue(undefined);
    const a = controller.mutate(next => { next.checkOnStartup = false; });
    const b = controller.mutate(next => { next.applyUpdatesOnStartup = true; });
    await vi.waitFor(() => expect(host.save).toHaveBeenCalledTimes(1)); finish();
    await Promise.all([a, b]);
    expect(controller.settings).toMatchObject({ checkOnStartup: false, applyUpdatesOnStartup: true });
  });

  it('rechecks the source fingerprint when a queued commit actually runs', async () => {
    const settings = defaultSettings(); settings.sources.push(tracked());
    const { controller, host, installer } = setup(settings, true);
    let finish!: () => void;
    host.save = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; })).mockResolvedValue(undefined);
    const firstSave = controller.mutate(next => { next.checkOnStartup = false; });
    await vi.waitFor(() => expect(host.save).toHaveBeenCalledTimes(1));
    const optionsSave = controller.updateOptions('example/sample', { pinnedTag: '1.0.0', autoUpdate: false, secretName: 'another-key' });
    const install = controller.install(release(), { secretName: '', pinnedTag: '', enableAfterInstall: false, adoptExisting: false });
    const assertion = expect(install).rejects.toMatchObject({ code: 'cancelled' });
    await vi.waitFor(() => expect(installer.install).toHaveBeenCalled());
    finish();
    await Promise.all([firstSave, optionsSave, assertion]);
    expect(controller.source('example/sample')).toMatchObject({ pinnedTag: '1.0.0', secretName: 'another-key', installedVersion: '1.0.0' });
  });

  it('finalizes pending committed journals before forgetting their ownership receipt', async () => {
    const settings = defaultSettings(); settings.sources.push(tracked({ transactionId }));
    const { controller, installer } = setup(settings, true);
    installer.recover.mockImplementationOnce(async () => {
      expect(controller.hasCommitted('sample-plugin', transactionId)).toBe(true);
      return [{ pluginId: 'sample-plugin', recovered: true }];
    });
    await controller.remove('example/sample');
    expect(installer.recover).toHaveBeenCalledTimes(1);
    expect(controller.source('example/sample')).toBeUndefined();
  });

  it('keeps the receipt when a pending transaction cannot be finalized', async () => {
    const settings = defaultSettings(); settings.sources.push(tracked({ transactionId }));
    const { controller, installer } = setup(settings, true);
    installer.recover.mockResolvedValueOnce([{ pluginId: 'sample-plugin', recovered: false }]);
    await expect(controller.remove('example/sample')).rejects.toMatchObject({ code: 'rollback' });
    expect(controller.hasCommitted('sample-plugin', transactionId)).toBe(true);
    expect(controller.busy()).toBe(false);
  });

  it('waits for an in-flight settings commit before releasing an unloaded session', async () => {
    const { controller, host } = setup();
    let finish!: () => void;
    host.save = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const operation = controller.install(release(), { secretName: '', pinnedTag: '', enableAfterInstall: true, adoptExisting: false });
    await vi.waitFor(() => expect(host.save).toHaveBeenCalled());
    controller.dispose();
    let settled = false;
    const drain = controller.settled().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    await operation;
    await drain;
    expect(settled).toBe(true);
    expect(controller.hasCommitted('sample-plugin', transactionId)).toBe(true);
  });
});

describe('automatic update scope and recovery', () => {
  it('honors disabled startup checks even if an automatic check was already scheduled', async () => {
    const settings = defaultSettings(); settings.checkOnStartup = false; settings.applyUpdatesOnStartup = true;
    settings.sources.push(tracked({ autoUpdate: true }));
    const { controller, installer } = setup(settings, true);
    await controller.checkAll(true);
    expect(network.prepare).not.toHaveBeenCalled();
    expect(installer.install).not.toHaveBeenCalled();
  });

  it.each([
    { global: false, source: true, pinned: '', expected: 0 },
    { global: true, source: false, pinned: '', expected: 0 },
    { global: true, source: true, pinned: '1.1.0', expected: 0 },
    { global: true, source: true, pinned: '', expected: 1 },
  ])('applies only explicitly enabled unpinned sources: $global/$source/$pinned', async input => {
    const settings = defaultSettings(); settings.applyUpdatesOnStartup = input.global;
    settings.sources.push(tracked({ autoUpdate: input.source, pinnedTag: input.pinned }));
    const { controller, installer } = setup(settings, true);
    await controller.checkAll(true);
    expect(installer.install).toHaveBeenCalledTimes(input.expected);
  });

  it('does not resurrect a missing plugin during automatic maintenance', async () => {
    const settings = defaultSettings(); settings.applyUpdatesOnStartup = true; settings.sources.push(tracked({ autoUpdate: true }));
    const { controller, installer } = setup(settings);
    await controller.checkAll(true);
    expect(controller.status('example/sample').kind).toBe('error');
    expect(installer.install).not.toHaveBeenCalled();
  });

  it('does not trust a cached manifest when the plugin directory is gone', async () => {
    const settings = defaultSettings(); settings.applyUpdatesOnStartup = true; settings.sources.push(tracked({ autoUpdate: true }));
    const { controller, installer, host } = setup(settings, true);
    host.exists = async () => false;
    await controller.checkAll(true);
    expect(controller.status('example/sample').kind).toBe('error');
    expect(installer.install).not.toHaveBeenCalled();
  });

  it('blocks startup if an interrupted transaction cannot be recovered', async () => {
    const { controller, installer } = setup();
    installer.recover.mockResolvedValueOnce([{ pluginId: 'sample-plugin', recovered: false }]);
    await expect(controller.recover()).rejects.toMatchObject({ code: 'rollback' });
  });

  it('rejects unknown schemas and normalizes only approved persisted fields', () => {
    expect(() => parseSettings({ schemaVersion: 2, sources: [] })).toThrow();
    const parsed = parseSettings({ ...defaultSettings(), ignoredSensitiveField: 'synthetic-value' });
    expect(JSON.stringify(parsed)).not.toContain('synthetic-value');
    expect(() => parseSettings({ ...defaultSettings(), sources: [tracked(), tracked()] })).toThrow();
  });
});
