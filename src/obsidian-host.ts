import { App, Platform, normalizePath, requestUrl, requireApiVersion } from 'obsidian';
import { FileStore, HttpTransport, PluginLifecycle, PluginManifest, VaultFetchError } from './types';

interface CommunityPlugins {
  manifests: Record<string, PluginManifest | undefined>;
  plugins: Record<string, unknown>;
  enabledPlugins: Set<string>;
  loadManifests(): Promise<void>;
  loadPlugin(id: string): Promise<unknown>;
  unloadPlugin(id: string): Promise<void>;
  enablePluginAndSave(id: string): Promise<void>;
  disablePluginAndSave(id: string): Promise<void>;
}

// Plugin lifecycle management is not part of Obsidian's public type declarations.
// Keep the capability check and the compatibility boundary in this one adapter.
function registry(app: App): CommunityPlugins | undefined {
  return (app as App & { plugins?: CommunityPlugins }).plugins;
}

export function createObsidianHost(app: App, signal?: AbortSignal) {
  const adapter = app.vault.adapter;
  const files: FileStore = {
    exists: path => adapter.exists(normalizePath(path)),
    read: async path => new Uint8Array(await adapter.readBinary(normalizePath(path))),
    write: (path, bytes) => adapter.writeBinary(normalizePath(path), Uint8Array.from(bytes).buffer),
    mkdir: path => adapter.mkdir(normalizePath(path)),
    remove: path => adapter.remove(normalizePath(path)),
    rename: (from, to) => adapter.rename(normalizePath(from), normalizePath(to)),
    list: path => adapter.list(normalizePath(path)),
    rmdir: (path, recursive) => adapter.rmdir(normalizePath(path), recursive),
  };
  const supported = () => {
    const api = registry(app);
    return !!api && typeof api.enabledPlugins?.has === 'function'
      && ['loadManifests', 'loadPlugin', 'unloadPlugin', 'enablePluginAndSave', 'disablePluginAndSave']
        .every(name => typeof api[name as keyof CommunityPlugins] === 'function');
  };
  const get = () => {
    const api = registry(app);
    if (!api || !supported()) throw new VaultFetchError('lifecycle', 'This Obsidian version does not expose the required plugin lifecycle capabilities.');
    return api;
  };
  const lifecycle: PluginLifecycle = {
    supported,
    isEnabled: id => registry(app)?.enabledPlugins?.has(id) ?? false,
    isLoaded: id => !!registry(app)?.plugins?.[id],
    unload: async id => { await get().unloadPlugin(id); },
    refresh: async () => { await get().loadManifests(); },
    load: async id => {
      await get().loadPlugin(id);
      if (!registry(app)?.plugins[id]) throw new VaultFetchError('lifecycle', 'The installed plugin could not be loaded.');
    },
    enable: async id => {
      await get().enablePluginAndSave(id);
      if (!registry(app)?.plugins[id] || !registry(app)?.enabledPlugins.has(id)) throw new VaultFetchError('lifecycle', 'The installed plugin could not be enabled.');
    },
    disable: async id => { await get().disablePluginAndSave(id); },
  };
  const transport: HttpTransport = {
    async request(url, headers) {
      if (new URL(url).origin !== 'https://api.github.com') throw new VaultFetchError('network', 'Only GitHub API requests are supported.');
      let current = url;
      const deadline = Date.now() + (/\/releases\/assets\/\d+$/.test(new URL(url).pathname) ? 120_000 : 30_000);
      try {
        for (let redirects = 0; redirects <= 5; redirects++) {
          const api = new URL(current).origin === 'https://api.github.com';
          let timer: ReturnType<typeof setTimeout> | undefined;
          let onAbort: (() => void) | undefined;
          const timeout = deadline - Date.now();
          if (timeout <= 0) throw new Error('Request timed out');
          if (signal?.aborted) throw new Error('Request cancelled');
          const response = await Promise.race([
            requestUrl({ url: current, headers: api ? headers : { Accept: 'application/octet-stream' }, method: 'GET', throw: false }),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Request timed out')), timeout); }),
            new Promise<never>((_, reject) => { onAbort = () => reject(new Error('Request cancelled')); signal?.addEventListener('abort', onAbort, { once: true }); }),
          ]).finally(() => { if (timer) clearTimeout(timer); if (onAbort) signal?.removeEventListener('abort', onAbort); });
          if (![301, 302, 303, 307, 308].includes(response.status)) return { status: response.status, headers: response.headers, bytes: new Uint8Array(response.arrayBuffer) };
          const location = Object.entries(response.headers).find(([name]) => name.toLowerCase() === 'location')?.[1];
          if (!location) throw new Error('Missing redirect');
          const target = new URL(location, current);
          if (target.protocol !== 'https:' || target.username || target.password || target.port ||
            !['api.github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(target.hostname)) throw new Error('Unsupported redirect');
          current = target.href;
        }
        throw new Error('Too many redirects');
      } catch {
        if (signal?.aborted) throw new VaultFetchError('cancelled', 'The request was cancelled.');
        throw new VaultFetchError('network', 'The GitHub request failed. Check your connection and retry.');
      }
    },
  };
  return {
    files, lifecycle, transport,
    installed: (id: string) => registry(app)?.manifests?.[id],
    compatible: (manifest: PluginManifest) => requireApiVersion(manifest.minAppVersion) && !(Platform.isMobile && manifest.isDesktopOnly),
  };
}
