import { createServer } from 'node:http';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { VaultFetchController } from '../../src/controller';
import { PluginInstaller } from '../../src/core/installer';
import { parsePluginManifest } from '../../src/core/github';
import { defaultSettings } from '../../src/settings';
import type { FileStore, HttpTransport, PluginLifecycle, PluginManifest } from '../../src/types';

it('installs and updates over HTTP on real files, preserves settings, and rolls back a failed ownership save', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'vault-fetch-integration-'));
  const encode = (value: unknown) => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
  let version = '1.0.0';
  const requests: string[] = [];
  const assets = () => [
    { name: 'manifest.json', bytes: encode({ id: 'sample-plugin', name: 'Sample', version, minAppVersion: '1.6.0', author: 'Example', description: 'Synthetic fixture' }) },
    { name: 'main.js', bytes: encode(`synthetic-code-${version}`) },
  ];
  const server = createServer((request, response) => {
    requests.push(request.url ?? '');
    if (request.headers.authorization !== 'Bearer synthetic-integration-credential') { response.writeHead(401).end(); return; }
    if (request.url === '/repos/example/private-sample/releases/latest') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ tag_name: version, draft: false, prerelease: false, name: version,
        assets: assets().map((asset, index) => ({ id: index + 1, name: asset.name, size: asset.bytes.length })) }));
      return;
    }
    const match = request.url?.match(/^\/repos\/example\/private-sample\/releases\/assets\/([12])$/);
    const asset = match && assets()[Number(match[1]) - 1];
    if (!asset || request.headers.accept !== 'application/octet-stream') { response.writeHead(404).end(); return; }
    response.setHeader('Content-Type', 'application/octet-stream'); response.end(asset.bytes);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Synthetic server unavailable');
  const path = (relative: string) => join(root, relative);
  const files: FileStore = {
    exists: async name => fs.access(path(name)).then(() => true, () => false),
    read: async name => new Uint8Array(await fs.readFile(path(name))),
    write: async (name, bytes) => { await fs.writeFile(path(name), bytes); },
    mkdir: async name => { await fs.mkdir(path(name)); },
    remove: async name => { await fs.unlink(path(name)); },
    rename: async (from, to) => { await fs.rename(path(from), path(to)); },
    list: async name => {
      const entries = await fs.readdir(path(name), { withFileTypes: true });
      return { files: entries.filter(entry => entry.isFile()).map(entry => `${name}/${entry.name}`), folders: entries.filter(entry => entry.isDirectory()).map(entry => `${name}/${entry.name}`) };
    },
    rmdir: async (name, recursive) => { await fs.rm(path(name), { recursive }); },
  };
  const manifests = new Map<string, PluginManifest>();
  const enabled = new Set<string>(), loaded = new Set<string>();
  const lifecycle: PluginLifecycle = {
    supported: () => true, isEnabled: id => enabled.has(id), isLoaded: id => loaded.has(id),
    refresh: async () => {
      const target = '.config/plugins/sample-plugin/manifest.json';
      if (await files.exists(target)) manifests.set('sample-plugin', parsePluginManifest(await files.read(target)));
      else manifests.delete('sample-plugin');
    },
    unload: async id => { loaded.delete(id); }, load: async id => { loaded.add(id); },
    enable: async id => { enabled.add(id); loaded.add(id); }, disable: async id => { enabled.delete(id); loaded.delete(id); },
  };
  const transport: HttpTransport = {
    request: async (url, headers) => {
      const endpoint = new URL(url);
      expect(endpoint.origin).toBe('https://api.github.com');
      const response = await fetch(`http://127.0.0.1:${address.port}${endpoint.pathname}`, { headers });
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, name) => { responseHeaders[name] = value; });
      return { status: response.status, headers: responseHeaders, bytes: new Uint8Array(await response.arrayBuffer()) };
    },
  };
  let failSave = false;
  let controller!: VaultFetchController;
  const installer = new PluginInstaller(files, lifecycle, { configDir: '.config', selfId: 'vault-fetch', isCommitted: (id, transaction) => controller.hasCommitted(id, transaction) });
  controller = new VaultFetchController(defaultSettings(), {
    transport, secret: () => 'synthetic-integration-credential', installed: id => manifests.get(id),
    exists: id => files.exists(`.config/plugins/${id}`), compatible: () => true, changed() {},
    save: async settings => { if (failSave) throw new Error('Synthetic disk full'); await files.write('.config/plugins/vault-fetch/data.json', encode(settings)); },
  }, installer, 'vault-fetch');
  const options = { secretName: '', pinnedTag: '', enableAfterInstall: true, adoptExisting: false };
  try {
    await controller.recover();
    await controller.install(await controller.preview('example/private-sample', '', ''), options);
    await files.write('.config/plugins/sample-plugin/data.json', encode({ preference: 'preserve' }));
    version = '1.1.0';
    await controller.check('example/private-sample');
    const status = controller.status('example/private-sample');
    expect(status.kind).toBe('available');
    if (status.kind !== 'available') throw new Error('Synthetic update unavailable');
    await controller.install(status.release, options);
    expect(new TextDecoder().decode(await files.read('.config/plugins/sample-plugin/main.js'))).toBe('synthetic-code-1.1.0');
    expect(enabled.has('sample-plugin') && loaded.has('sample-plugin')).toBe(true);
    version = '1.2.0'; failSave = true;
    await expect(controller.install(await controller.preview('example/private-sample', '', ''), options)).rejects.toMatchObject({ code: 'settings' });
    expect(manifests.get('sample-plugin')?.version).toBe('1.1.0');
    expect(controller.source('example/private-sample')?.installedVersion).toBe('1.1.0');
    expect(new TextDecoder().decode(await files.read('.config/plugins/sample-plugin/data.json'))).toBe('{"preference":"preserve"}');
    expect(await installer.recover()).toEqual([]);
    expect(requests.filter(request => request.includes('/releases/assets/'))).toHaveLength(6);
    expect(new TextDecoder().decode(await files.read('.config/plugins/vault-fetch/data.json'))).not.toContain('synthetic-integration-credential');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
});
