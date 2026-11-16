import { gt } from 'semver';
import { GitHubClient, normalizeRepository } from './core/github';
import { PluginInstaller } from './core/installer';
import { cloneSettings, parseSettings } from './settings';
import {
  HttpTransport, ManagedSource, PluginManifest, PreparedRelease, SourceStatus,
  VaultFetchError, VaultFetchSettings,
} from './types';

export interface ControllerHost {
  transport: HttpTransport;
  secret(name: string): string | null;
  installed(id: string): PluginManifest | undefined;
  exists(id: string): Promise<boolean>;
  compatible(manifest: PluginManifest): boolean;
  save(settings: VaultFetchSettings): Promise<void>;
  changed(): void;
}

export interface InstallRequest {
  secretName: string;
  pinnedTag: string;
  enableAfterInstall: boolean;
  adoptExisting: boolean;
  allowMissing?: boolean;
}

export class VaultFetchController {
  readonly statuses = new Map<string, SourceStatus>();
  readonly active = new Set<string>();
  private disposed = false;
  private saves: Promise<unknown> = Promise.resolve();
  private pending = new Set<Promise<void>>();

  constructor(
    public settings: VaultFetchSettings,
    private readonly host: ControllerHost,
    private readonly installer: Pick<PluginInstaller, 'install' | 'recover'>,
    private readonly selfId: string,
  ) {}

  private key(repository: string): string { return repository.toLowerCase(); }
  private assertLive(): void { if (this.disposed) throw new VaultFetchError('cancelled', 'Operation cancelled.'); }
  private changed(): void { if (!this.disposed) this.host.changed(); }
  source(repository: string): ManagedSource | undefined { return this.settings.sources.find(s => this.key(s.repository) === this.key(repository)); }
  busy(repository?: string): boolean { return repository ? this.active.has(this.key(repository)) : this.active.size > 0; }
  status(repository: string): SourceStatus { return this.statuses.get(this.key(repository)) ?? { kind: 'idle' }; }
  installed(source: Pick<ManagedSource, 'pluginId'>): PluginManifest | undefined { return this.host.installed(source.pluginId); }
  hasExistingPlugin(pluginId: string): Promise<boolean> { return this.host.exists(pluginId); }

  mutate(change: (next: VaultFetchSettings) => void): Promise<void> {
    const save = this.saves.then(async () => {
      this.assertLive();
      const previous = this.settings;
      const candidate = cloneSettings(previous);
      change(candidate);
      const next = parseSettings(candidate);
      this.settings = next;
      this.changed();
      try { await this.host.save(cloneSettings(next)); }
      catch { this.settings = previous; this.changed(); throw new VaultFetchError('settings', 'Could not save settings.'); }
    });
    this.saves = save.catch(() => undefined);
    return save;
  }

  private client(secretName: string): GitHubClient {
    return new GitHubClient(this.host.transport, () => this.host.secret(secretName));
  }

  private fingerprint(source?: ManagedSource): string {
    return JSON.stringify({ source, defaultSecret: this.settings.secretName, automatic: this.settings.applyUpdatesOnStartup, startup: this.settings.checkOnStartup });
  }

  private async exclusive<T>(repository: string, work: () => Promise<T>): Promise<T> {
    this.assertLive();
    const key = this.key(repository);
    if (this.active.has(key)) throw new VaultFetchError('busy', 'This source is busy.');
    this.active.add(key);
    let finish!: () => void;
    const settled = new Promise<void>(resolve => { finish = resolve; });
    this.pending.add(settled);
    this.changed();
    try { return await work(); }
    finally { this.active.delete(key); this.pending.delete(settled); finish(); this.changed(); }
  }

  async preview(repository: string, tag: string, secretName: string): Promise<PreparedRelease> {
    this.assertLive();
    const repo = normalizeRepository(repository);
    const release = await this.client(secretName || this.settings.secretName).prepare(repo, tag || undefined);
    this.validateRelease(release);
    return release;
  }

  private validateRelease(release: PreparedRelease): void {
    if (release.manifest.id === this.selfId) throw new VaultFetchError('self', 'VaultFetch updates itself only through the community directory.');
    if (!this.host.compatible(release.manifest)) throw new VaultFetchError('compatibility', 'This release is incompatible with this device or Obsidian version.');
  }

  async install(release: PreparedRelease, request: InstallRequest): Promise<void> {
    await this.exclusive(release.repository, async () => {
      this.validateRelease(release);
      const existing = this.source(release.repository);
      if (existing && existing.pluginId !== release.manifest.id) throw new VaultFetchError('conflict', 'The repository changed its plugin ID.');
      if (this.settings.sources.some(s => s.pluginId === release.manifest.id && s !== existing)) throw new VaultFetchError('conflict', 'Another source already owns this plugin ID.');
      if ((this.host.installed(release.manifest.id) || await this.host.exists(release.manifest.id)) && !existing && !request.adoptExisting) throw new VaultFetchError('conflict', 'Explicit approval is required to manage an existing plugin.');
      const fingerprint = this.fingerprint(existing);
      const secretName = request.secretName || this.settings.secretName;
      const guard = () => {
        this.assertLive();
        if (this.fingerprint(this.source(release.repository)) !== fingerprint) throw new VaultFetchError('cancelled', 'Source settings changed. Preview the release again.');
      };
      this.statuses.set(this.key(release.repository), { kind: 'installing' }); this.changed();
      try {
        const build = await this.client(secretName).download(release);
        guard();
        await this.installer.install(build, {
          managed: !!existing || request.adoptExisting,
          allowMissing: request.allowMissing === true,
          expectedPluginId: existing?.pluginId ?? (request.adoptExisting ? release.manifest.id : undefined),
          enableAfterInstall: request.enableAfterInstall,
          guard,
          commit: transactionId => this.mutate(next => {
            guard();
            const source: ManagedSource = {
              repository: release.repository, pluginId: release.manifest.id, name: release.manifest.name,
              secretName: request.secretName, pinnedTag: request.pinnedTag,
              autoUpdate: existing?.autoUpdate ?? false, installedTag: release.tag, installedVersion: release.manifest.version,
              transactionId,
            };
            next.sources = next.sources.filter(s => this.key(s.repository) !== this.key(release.repository));
            next.sources.push(source);
          }),
        });
        this.statuses.set(this.key(release.repository), { kind: 'current', version: release.manifest.version });
      } catch (error) {
        this.statuses.set(this.key(release.repository), { kind: 'error', message: safeError(error) });
        throw error;
      }
    });
  }

  async check(repository: string): Promise<void> {
    await this.exclusive(repository, async () => {
      const source = this.source(repository);
      if (!source) return;
      this.statuses.set(this.key(repository), { kind: 'checking' }); this.changed();
      try {
        const current = this.host.installed(source.pluginId);
        if (!current || !await this.host.exists(source.pluginId)) throw new VaultFetchError('conflict', 'The plugin is missing. Reinstall it explicitly or stop managing this source.');
        const release = await this.preview(source.repository, source.pinnedTag, source.secretName);
        if (release.manifest.id !== source.pluginId) throw new VaultFetchError('conflict', 'The repository changed its plugin ID.');
        this.assertLive();
        this.statuses.set(this.key(repository), gt(release.manifest.version, current.version)
          ? { kind: 'available', release } : { kind: 'current', version: current.version });
      } catch (error) { this.statuses.set(this.key(repository), { kind: 'error', message: safeError(error) }); }
    });
  }

  async checkAll(automatic = false): Promise<void> {
    for (const item of [...this.settings.sources]) {
      if (this.disposed || (automatic && !this.settings.checkOnStartup)) return;
      if (this.busy(item.repository)) continue;
      await this.check(item.repository);
      const status = this.status(item.repository);
      const current = this.source(item.repository);
      if (automatic && this.settings.checkOnStartup && current?.autoUpdate && this.settings.applyUpdatesOnStartup && !current.pinnedTag && status.kind === 'available') {
        try { await this.install(status.release, { secretName: current.secretName, pinnedTag: '', enableAfterInstall: false, adoptExisting: false }); }
        catch { /* Each source retains its own error while the remaining sources continue. */ }
      }
    }
  }

  async remove(repository: string): Promise<void> {
    await this.exclusive(repository, async () => {
      const result = await this.installer.recover();
      if (result.some(item => !item.recovered)) throw new VaultFetchError('rollback', 'Finish recovering interrupted installations before removing a source.');
      await this.mutate(next => { next.sources = next.sources.filter(s => this.key(s.repository) !== this.key(repository)); });
      this.statuses.delete(this.key(repository));
    });
  }

  async updateOptions(repository: string, options: Pick<ManagedSource, 'secretName' | 'pinnedTag' | 'autoUpdate'>): Promise<void> {
    if (this.busy(repository)) throw new VaultFetchError('busy', 'This source is busy.');
    await this.mutate(next => { const source = next.sources.find(s => this.key(s.repository) === this.key(repository)); if (source) Object.assign(source, options); });
    this.statuses.delete(this.key(repository)); this.changed();
  }

  hasCommitted(pluginId: string, transactionId: string): boolean {
    return this.settings.sources.some(source => source.pluginId === pluginId && source.transactionId === transactionId);
  }

  async recover(): Promise<void> {
    const result = await this.installer.recover();
    if (result.some(item => !item.recovered)) throw new VaultFetchError('rollback', 'An interrupted installation could not be recovered. Its backup has been preserved.');
    if (this.settings.sources.some(source => this.host.installed(source.pluginId)?.version !== source.installedVersion)) {
      await this.mutate(next => {
        for (const source of next.sources) {
          const version = this.host.installed(source.pluginId)?.version ?? '';
          if (version !== source.installedVersion) { source.installedVersion = version; source.installedTag = ''; }
        }
      });
    }
  }
  dispose(): void { this.disposed = true; }
  async settled(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
    await this.saves;
  }
}

export function safeError(error: unknown): string {
  if (error instanceof VaultFetchError) return `${error.message}${error.status ? ` (HTTP ${error.status})` : ''}`;
  return 'The operation failed. Check the connection and file permissions, then retry.';
}
