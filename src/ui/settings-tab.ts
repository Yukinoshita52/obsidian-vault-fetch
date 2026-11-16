import { App, PluginSettingTab, SecretComponent, Setting, requireApiVersion } from 'obsidian';
import type { SettingDefinitionItem } from 'obsidian';
import type VaultFetchPlugin from '../main';
import { AddSourceModal, SourceOptionsModal } from './source-modal';
import { t } from './strings';

interface SettingRow {
  name: string;
  desc?: string;
  aliases?: string[];
  searchable?: boolean;
  render(setting: Setting): void | (() => void);
}
type TabDefinition = SettingRow | { type: 'group'; heading: string; items: SettingRow[] };

export class VaultFetchSettingsTab extends PluginSettingTab {
  private unsubscribe?: () => void;
  private list?: HTMLElement;
  private indexedState = '';

  constructor(app: App, private readonly plugin: VaultFetchPlugin) { super(app, plugin); }

  getSettingDefinitions(): SettingDefinitionItem[] { return this.definitions(); }

  refreshIndex(): void {
    const state = JSON.stringify({ ready: !!this.plugin.controller, error: this.plugin.initializationError,
      sources: this.plugin.controller?.settings.sources.map(source => [source.repository, source.name]) });
    if (state === this.indexedState) return;
    if (requireApiVersion('1.13.0')) {
      if (typeof this.update === 'function') this.update();
    }
    this.indexedState = state;
  }

  private watch(callback: () => void): () => void {
    this.unsubscribe?.();
    const unsubscribe = this.plugin.subscribe(callback);
    this.unsubscribe = unsubscribe;
    return () => { unsubscribe(); if (this.unsubscribe === unsubscribe) this.unsubscribe = undefined; };
  }

  private refreshDefinitions(): void {
    if (requireApiVersion('1.13.0')) {
      if (typeof this.update === 'function') { this.update(); return; }
    }
    this.renderLegacy();
  }

  private definitions(): TabDefinition[] {
    this.containerEl.addClass('vault-fetch');
    const controller = this.plugin.controller;
    if (!controller) {
      return [{ name: 'VaultFetch', desc: this.plugin.initializationError || t('loading'),
        render: () => this.watch(() => this.refreshDefinitions()) }];
    }
    return [
      { name: 'VaultFetch', desc: t('intro'), render: setting => { setting.setHeading(); } },
      { type: 'group', heading: t('credentials'), items: [
        { name: t('secret'), desc: `${t('secretHelp')} ${t('noSecretSync')}`, render: setting => {
          setting.addComponent(el => new SecretComponent(this.app, el).setValue(controller.settings.secretName).onChange(name => {
            void this.plugin.run(() => controller.mutate(next => { next.secretName = name ?? ''; }));
          }));
        } },
      ] },
      { name: t('startup'), desc: t('startupHelp'), render: setting => {
        setting.addToggle(toggle => toggle.setValue(controller.settings.checkOnStartup).onChange(value => {
          void this.plugin.run(() => controller.mutate(next => { next.checkOnStartup = value; }));
        }));
      } },
      { name: t('automatic'), desc: t('automaticHelp'), render: setting => {
        setting.addToggle(toggle => toggle.setValue(controller.settings.applyUpdatesOnStartup).onChange(value => {
          void this.plugin.run(() => controller.mutate(next => { next.applyUpdatesOnStartup = value; }));
        }));
      } },
      { name: t('sources'), aliases: [t('checkAll'), t('add')], render: setting => {
        setting.setHeading()
          .addButton(button => button.setButtonText(t('checkAll')).onClick(() => { void this.plugin.run(() => controller.checkAll()); }))
          .addButton(button => button.setButtonText(t('add')).setCta().onClick(() => this.plugin.openAddSource()));
      } },
      { name: t('sources'), aliases: controller.settings.sources.flatMap(source => [source.name, source.repository]), render: setting => {
        setting.settingEl.addClass('vault-fetch-list-row');
        setting.settingEl.empty();
        const list = setting.settingEl.createDiv({ cls: 'vault-fetch-sources' });
        this.list = list;
        let identities = JSON.stringify(controller.settings.sources.map(source => [source.repository, source.name]));
        const unwatch = this.watch(() => {
          const next = JSON.stringify(controller.settings.sources.map(source => [source.repository, source.name]));
          if (next !== identities) { identities = next; this.refreshDefinitions(); }
          else this.renderSources();
        });
        this.renderSources();
        return () => { unwatch(); list.remove(); if (this.list === list) this.list = undefined; };
      } },
    ];
  }

  // Older Obsidian versions render the same definitions through this compatibility entry point.
  display(): void { this.renderLegacy(); }

  private renderLegacy(): void {
    this.hide(); this.containerEl.empty();
    const render = (definition: SettingRow) => {
      const setting = new Setting(this.containerEl).setName(definition.name);
      if (definition.desc) setting.setDesc(definition.desc);
      definition.render(setting);
    };
    for (const definition of this.definitions()) {
      if ('type' in definition) {
        new Setting(this.containerEl).setName(definition.heading).setHeading();
        definition.items.forEach(render);
      } else render(definition);
    }
  }

  private renderSources(): void {
    const controller = this.plugin.controller;
    if (!this.list || !controller) return;
    this.list.empty();
    if (!controller.settings.sources.length) { this.list.createEl('p', { text: t('empty'), cls: 'vault-fetch-empty' }); return; }
    for (const source of controller.settings.sources) {
      const card = this.list.createDiv({ cls: 'vault-fetch-source' });
      new Setting(card).setName(source.name).setHeading();
      card.createEl('a', { text: source.repository, href: `https://github.com/${source.repository}`, cls: 'vault-fetch-repository' }).setAttr('rel', 'noopener noreferrer');
      const installed = controller.installed(source);
      const status = controller.status(source.repository);
      const summary = [installed?.version ?? t('missing')];
      if (source.pinnedTag) summary.push(`${t('fixed')}: ${source.pinnedTag}`);
      if (status.kind === 'checking') summary.push(t('checking'));
      if (status.kind === 'installing') summary.push(t('installing'));
      if (status.kind === 'available') summary.push(`${t('available')}: ${status.release.manifest.version}`);
      if (status.kind === 'current') summary.push(t('current'));
      card.createEl('p', { text: summary.join(' · '), cls: 'vault-fetch-muted' });
      if (status.kind === 'error') card.createEl('p', { text: status.message, cls: 'vault-fetch-error', attr: { role: 'alert' } });
      const busy = controller.busy(source.repository);
      const actions = new Setting(card);
      actions.addButton(button => button.setButtonText(t('check')).setDisabled(busy).onClick(() => { void this.plugin.run(() => controller.check(source.repository)); }));
      if (status.kind === 'available') actions.addButton(button => button.setButtonText(t('update')).setCta().setDisabled(busy).onClick(() => {
        void this.plugin.run(() => controller.install(status.release, { secretName: source.secretName, pinnedTag: source.pinnedTag, enableAfterInstall: false, adoptExisting: false }));
      }));
      actions.addButton(button => button.setButtonText(t('reinstall')).setDisabled(busy).onClick(() => new AddSourceModal(this.app, this.plugin, source).open()));
      actions.addButton(button => button.setButtonText(t('options')).setDisabled(busy).onClick(() => new SourceOptionsModal(this.app, this.plugin, source).open()));
      new Setting(card).setName(t('auto')).setDesc(t('autoHelp')).addToggle(toggle => toggle.setValue(source.autoUpdate).setDisabled(busy || !!source.pinnedTag).onChange(value => {
        void this.plugin.run(() => controller.updateOptions(source.repository, { secretName: source.secretName, pinnedTag: source.pinnedTag, autoUpdate: value }));
      }));
      new Setting(card).setDesc(t('stopHelp')).addButton(button => button.setButtonText(t('stop')).setDisabled(busy).onClick(() => { void this.plugin.run(() => controller.remove(source.repository)); }));
    }
  }

  hide(): void { this.unsubscribe?.(); this.unsubscribe = undefined; this.list = undefined; }
}
