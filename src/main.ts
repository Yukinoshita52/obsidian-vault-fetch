import { App, Notice, Plugin } from 'obsidian';
import { PluginInstaller } from './core/installer';
import { VaultFetchController, safeError } from './controller';
import { createObsidianHost } from './obsidian-host';
import { parseSettings } from './settings';
import { VaultFetchSettingsTab } from './ui/settings-tab';
import { AddSourceModal } from './ui/source-modal';
import { t } from './ui/strings';

const SESSION = Symbol.for('vault-fetch.install-session');
interface RuntimeSession { done: Promise<void>; finish(): void }
type SessionApp = App & { [key: symbol]: RuntimeSession | undefined };

export default class VaultFetchPlugin extends Plugin {
  controller?: VaultFetchController;
  initializationError = '';
  private changed = new Set<() => void>();
  private stopped = false;
  private abort = new AbortController();
  private initializing: Promise<void> = Promise.resolve();
  private initializingController?: VaultFetchController;
  private session?: RuntimeSession;
  private settingsTab?: VaultFetchSettingsTab;

  onload(): void {
    this.settingsTab = new VaultFetchSettingsTab(this.app, this);
    this.addSettingTab(this.settingsTab);
    this.addCommand({ id: 'add-source', name: t('add'), callback: () => this.openAddSource() });
    this.addCommand({ id: 'check-updates', name: t('checkAll'), callback: () => { void this.run(() => this.controller?.checkAll() ?? Promise.resolve()); } });
    this.addRibbonIcon('download', 'VaultFetch', () => this.openAddSource());
    const app = this.app as SessionApp;
    const previous = app[SESSION];
    let finish!: () => void;
    this.session = { done: new Promise<void>(resolve => { finish = resolve; }), finish: () => finish() };
    app[SESSION] = this.session;
    this.initializing = (async () => {
      await previous?.done;
      if (!this.stopped) await this.initialize();
    })();
  }

  private async initialize(): Promise<void> {
    try {
      const settings = parseSettings(await this.loadData());
      if (this.stopped) return;
      const host = createObsidianHost(this.app, this.abort.signal);
      let controller: VaultFetchController | undefined;
      const installer = new PluginInstaller(host.files, host.lifecycle, {
        configDir: this.app.vault.configDir,
        selfId: this.manifest.id,
        isCommitted: (pluginId: string, transactionId: string) => controller?.hasCommitted(pluginId, transactionId) ?? false,
      });
      controller = new VaultFetchController(settings, {
        transport: host.transport,
        secret: name => name ? this.app.secretStorage.getSecret(name) : null,
        installed: host.installed,
        exists: id => host.files.exists(`${this.app.vault.configDir}/plugins/${id}`),
        compatible: host.compatible,
        save: value => this.saveData(value),
        changed: () => this.refresh(),
      }, installer, this.manifest.id);
      this.initializingController = controller;
      await controller.recover();
      if (this.stopped) { controller.dispose(); return; }
      this.controller = controller;
      this.refresh();
      this.app.workspace.onLayoutReady(() => {
        if (this.stopped || !this.controller?.settings.checkOnStartup) return;
        const timer = window.setTimeout(() => { if (!this.stopped && this.controller?.settings.checkOnStartup) void this.controller.checkAll(true); }, 15_000);
        this.register(() => window.clearTimeout(timer));
      });
    } catch (error) { this.initializationError = safeError(error); this.refresh(); }
  }

  subscribe(callback: () => void): () => void {
    this.changed.add(callback);
    return () => this.changed.delete(callback);
  }

  private refresh(): void {
    try { this.settingsTab?.refreshIndex(); } catch { /* A settings window may close during initialization. */ }
    for (const listener of [...this.changed]) { try { listener(); } catch { /* Detached settings windows may close during a refresh. */ } }
  }

  openAddSource(): void {
    if (!this.controller) { new Notice(this.initializationError || 'VaultFetch is starting. Try again shortly.'); return; }
    new AddSourceModal(this.app, this).open();
  }

  async run(work: () => Promise<unknown>): Promise<void> {
    try { await work(); }
    catch (error) { if (!this.stopped) new Notice(safeError(error)); }
  }

  onunload(): void {
    this.stopped = true;
    this.abort.abort();
    this.controller?.dispose();
    this.initializingController?.dispose();
    this.changed.clear();
    void (async () => {
      await this.initializing.catch(() => undefined);
      await (this.controller ?? this.initializingController)?.settled();
      this.session?.finish();
      const app = this.app as SessionApp;
      if (app[SESSION] === this.session) delete app[SESSION];
    })();
  }
}
