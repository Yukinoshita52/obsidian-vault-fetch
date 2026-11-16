import { beforeEach, describe, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ load: vi.fn(), tabs: vi.fn() }));
vi.mock('obsidian', () => ({
  Plugin: class {
    constructor(public app: object, public manifest: object) {}
    addSettingTab(tab: unknown) { io.tabs(tab); }
    addCommand() {}
    addRibbonIcon() {}
    loadData() { return io.load(); }
  },
  PluginSettingTab: class {}, Modal: class {}, Setting: class {}, SecretComponent: class {}, Notice: class {},
  getLanguage: () => 'en', Platform: { isMobile: false }, normalizePath: (p: string) => p, requireApiVersion: () => true,
}));
import VaultFetchPlugin from '../src/main';
import type { App, PluginManifest } from 'obsidian';

const manifest = { id: 'vault-fetch', version: '0.1.0' } as PluginManifest;
beforeEach(() => { io.load.mockReset(); io.tabs.mockReset(); });

describe('bootstrap and session ownership', () => {
  it('registers settings immediately and does not repeatedly notify a listener added during error rendering', async () => {
    let reject!: (reason: Error) => void;
    io.load.mockReturnValue(new Promise((_, fail) => { reject = fail; }));
    const plugin = new VaultFetchPlugin({} as App, manifest);
    plugin.onload();
    expect(io.tabs).toHaveBeenCalledTimes(1);
    let secondCalls = 0;
    const first = vi.fn(() => { unsubscribe(); plugin.subscribe(() => { secondCalls++; }); });
    const unsubscribe = plugin.subscribe(first);
    await vi.waitFor(() => expect(io.load).toHaveBeenCalled());
    reject(new Error('Synthetic read failure'));
    await vi.waitFor(() => expect(plugin.initializationError).not.toBe(''));
    expect(first).toHaveBeenCalledTimes(1);
    expect(secondCalls).toBe(0);
    plugin.onunload();
  });

  it('waits for the previous instance before starting recovery', async () => {
    let finish!: () => void;
    const previous = new Promise<void>(resolve => { finish = resolve; });
    const app = { [Symbol.for('vault-fetch.install-session')]: { done: previous, finish() {} } };
    io.load.mockRejectedValue(new Error('Synthetic read failure'));
    const plugin = new VaultFetchPlugin(app as unknown as App, manifest);
    plugin.onload();
    await Promise.resolve();
    expect(io.load).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(io.load).toHaveBeenCalledTimes(1));
    plugin.onunload();
  });
});
