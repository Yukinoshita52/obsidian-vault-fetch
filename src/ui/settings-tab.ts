import { App, PluginSettingTab, SecretComponent, Setting } from 'obsidian';
import type VaultFetchPlugin from '../main';
import { AddSourceModal, SourceOptionsModal } from './source-modal';
import { t } from './strings';

export class VaultFetchSettingsTab extends PluginSettingTab {
  private unsubscribe?: () => void;
  private list?: HTMLElement;

  constructor(app: App, private readonly plugin: VaultFetchPlugin) { super(app, plugin); }

  display(): void {
    this.unsubscribe?.();
    this.containerEl.empty(); this.containerEl.addClass('vault-fetch');
    this.containerEl.createEl('h2', { text: 'VaultFetch' });
    this.containerEl.createEl('p', { text: t('intro'), cls: 'vault-fetch-intro' });
    const controller = this.plugin.controller;
    if (!controller) {
      this.containerEl.createEl('p', { text: this.plugin.initializationError || t('loading'), cls: this.plugin.initializationError ? 'vault-fetch-error' : '' });
      this.unsubscribe = this.plugin.subscribe(() => this.display());
      return;
    }
    new Setting(this.containerEl).setName(t('credentials')).setHeading();
    new Setting(this.containerEl).setName(t('secret')).setDesc(t('secretHelp')).addComponent(el =>
      new SecretComponent(this.app, el).setValue(controller.settings.secretName).onChange(name => {
        void this.plugin.run(() => controller.mutate(next => { next.secretName = name ?? ''; }));
      }));
    this.containerEl.createEl('p', { text: t('noSecretSync'), cls: 'vault-fetch-muted' });
    new Setting(this.containerEl).setName(t('startup')).setDesc(t('startupHelp')).addToggle(toggle => toggle.setValue(controller.settings.checkOnStartup).onChange(value => {
      void this.plugin.run(() => controller.mutate(next => { next.checkOnStartup = value; }));
    }));
    new Setting(this.containerEl).setName(t('automatic')).setDesc(t('automaticHelp')).addToggle(toggle => toggle.setValue(controller.settings.applyUpdatesOnStartup).onChange(value => {
      void this.plugin.run(() => controller.mutate(next => { next.applyUpdatesOnStartup = value; }));
    }));
    new Setting(this.containerEl).setName(t('sources')).setHeading()
      .addButton(button => button.setButtonText(t('checkAll')).onClick(() => { void this.plugin.run(() => controller.checkAll()); }))
      .addButton(button => button.setButtonText(t('add')).setCta().onClick(() => this.plugin.openAddSource()));
    this.list = this.containerEl.createDiv({ cls: 'vault-fetch-sources' });
    this.unsubscribe = this.plugin.subscribe(() => this.renderSources());
    this.renderSources();
  }

  private renderSources(): void {
    const controller = this.plugin.controller;
    if (!this.list || !controller) return;
    this.list.empty();
    if (!controller.settings.sources.length) { this.list.createEl('p', { text: t('empty'), cls: 'vault-fetch-empty' }); return; }
    for (const source of controller.settings.sources) {
      const card = this.list.createDiv({ cls: 'vault-fetch-source' });
      card.createEl('h3', { text: source.name });
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

  hide(): void { this.unsubscribe?.(); this.unsubscribe = undefined; }
}
