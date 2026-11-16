import { App, ButtonComponent, Modal, Notice, SecretComponent, Setting } from 'obsidian';
import type VaultFetchPlugin from '../main';
import { safeError } from '../controller';
import { ManagedSource, PreparedRelease } from '../types';
import { t } from './strings';

export class AddSourceModal extends Modal {
  private repository = '';
  private secretName = '';
  private tag = '';
  private adopt = false;
  private enable = true;
  private release?: PreparedRelease;
  private generation = 0;
  private closed = false;
  private previewEl!: HTMLElement;
  private issueEl!: HTMLElement;
  private previewButton!: ButtonComponent;
  private installButton!: ButtonComponent;

  constructor(app: App, private readonly plugin: VaultFetchPlugin, source?: ManagedSource) {
    super(app);
    if (source) { this.repository = source.repository; this.secretName = source.secretName; this.tag = source.pinnedTag; }
  }

  onOpen(): void {
    this.setTitle(t('add'));
    this.contentEl.addClass('vault-fetch');
    const reset = () => {
      this.generation++; this.release = undefined; this.adopt = false;
      this.previewEl?.empty(); this.issueEl?.empty(); this.installButton?.setDisabled(true);
      this.previewButton?.setDisabled(false).setButtonText(t('preview'));
    };
    new Setting(this.contentEl).setName(t('repository')).setDesc(t('repositoryHelp')).addText(input => {
      input.setPlaceholder('owner/repository').setValue(this.repository).onChange(value => { this.repository = value.trim(); reset(); });
      input.inputEl.maxLength = 250;
    });
    new Setting(this.contentEl).setName(t('override')).setDesc(t('overrideHelp')).addComponent(el =>
      new SecretComponent(this.app, el).setValue(this.secretName).onChange(name => { this.secretName = name ?? ''; reset(); }));
    new Setting(this.contentEl).setName(t('tag')).setDesc(t('tagHelp')).addText(input => {
      input.setValue(this.tag).onChange(value => { this.tag = value.trim(); reset(); });
      input.inputEl.maxLength = 150;
    });
    new Setting(this.contentEl).addButton(button => { this.previewButton = button; button.setButtonText(t('preview')).onClick(() => { void this.preview(); }); });
    this.issueEl = this.contentEl.createDiv({ cls: 'vault-fetch-error' });
    this.issueEl.setAttribute('role', 'alert');
    this.previewEl = this.contentEl.createDiv({ cls: 'vault-fetch-preview' });
    new Setting(this.contentEl).setName(t('enable')).setDesc(t('enableHelp')).addToggle(toggle => toggle.setValue(this.enable).onChange(value => { this.enable = value; }));
    new Setting(this.contentEl).setDesc(t('restartHelp'));
    this.contentEl.createEl('p', { text: t('executeHelp'), cls: 'vault-fetch-muted' });
    new Setting(this.contentEl)
      .addButton(button => button.setButtonText(t('cancel')).onClick(() => this.close()))
      .addButton(button => { this.installButton = button; button.setButtonText(t('install')).setCta().setDisabled(true).onClick(() => { void this.install(); }); });
  }

  private async preview(): Promise<void> {
    const controller = this.plugin.controller;
    if (!controller) return;
    const generation = ++this.generation;
    this.issueEl.empty(); this.previewEl.empty(); this.release = undefined;
    this.installButton.setDisabled(true);
    this.previewButton.setButtonText(t('previewing')).setDisabled(true);
    try {
      const release = await controller.preview(this.repository, this.tag, this.secretName);
      const directoryExists = await controller.hasExistingPlugin(release.manifest.id);
      if (this.closed || generation !== this.generation) return;
      this.release = release;
      this.previewEl.createEl('h3', { text: release.manifest.name });
      this.previewEl.createEl('p', { text: `${release.manifest.id} / ${release.manifest.version}` });
      this.previewEl.createEl('p', { text: release.repository, cls: 'vault-fetch-repository' });
      this.previewEl.createEl('p', { text: `${t('compatibility')} ${release.manifest.minAppVersion}${release.manifest.isDesktopOnly ? ` / ${t('desktopOnly')}` : ''}` });
      if (release.notes) this.previewEl.createEl('p', { text: release.notes.slice(0,1500), cls: 'vault-fetch-notes' });
      const existing = controller.installed({ pluginId: release.manifest.id });
      if (existing) this.previewEl.createEl('p', { text: `${t('installedVersion')}: ${existing.version}` });
      const unmanaged = (!!existing || directoryExists) && !controller.source(release.repository);
      if (unmanaged) {
        new Setting(this.previewEl).setName(t('adopt')).setDesc(t('adoptHelp')).addToggle(toggle => toggle.setValue(false).onChange(value => { this.adopt = value; this.installButton.setDisabled(!value); }));
      }
      this.installButton.setDisabled(unmanaged);
    } catch (error) { if (!this.closed && generation === this.generation) this.issueEl.setText(safeError(error)); }
    finally { if (!this.closed && generation === this.generation) this.previewButton.setButtonText(t('preview')).setDisabled(false); }
  }

  private async install(): Promise<void> {
    const controller = this.plugin.controller;
    const release = this.release;
    if (!controller || !release) return;
    this.installButton.setDisabled(true); this.previewButton.setDisabled(true);
    this.contentEl.inert = true;
    this.contentEl.setAttr('aria-busy', 'true');
    try {
      await controller.install(release, { secretName: this.secretName, pinnedTag: this.tag, enableAfterInstall: this.enable, adoptExisting: this.adopt, allowMissing: true });
      new Notice(`${t('installed')}: ${release.manifest.name} ${release.manifest.version}`);
      this.close();
    } catch (error) {
      if (!this.closed) {
        this.contentEl.inert = false; this.contentEl.removeAttribute('aria-busy');
        this.issueEl.setText(safeError(error)); this.installButton.setDisabled(false); this.previewButton.setDisabled(false);
      }
    }
  }

  onClose(): void { this.closed = true; this.generation++; this.contentEl.empty(); }
}

export class SourceOptionsModal extends Modal {
  constructor(app: App, private readonly plugin: VaultFetchPlugin, private readonly source: ManagedSource) { super(app); }

  onOpen(): void {
    this.setTitle(t('options'));
    this.contentEl.createEl('p', { text: this.source.repository });
    let secretName = this.source.secretName;
    let pinnedTag = this.source.pinnedTag;
    let autoUpdate = this.source.autoUpdate;
    new Setting(this.contentEl).setName(t('override')).setDesc(t('overrideHelp')).addComponent(el => new SecretComponent(this.app, el).setValue(secretName).onChange(name => { secretName = name ?? ''; }));
    new Setting(this.contentEl).setName(t('tag')).setDesc(t('tagHelp')).addText(input => { input.setValue(pinnedTag).onChange(value => { pinnedTag = value.trim(); }); input.inputEl.maxLength = 150; });
    new Setting(this.contentEl).setName(t('auto')).setDesc(t('autoHelp')).addToggle(toggle => toggle.setValue(autoUpdate).onChange(value => { autoUpdate = value; }));
    new Setting(this.contentEl).addButton(button => button.setButtonText(t('save')).setCta().onClick(() => {
      button.setDisabled(true);
      void this.plugin.run(async () => {
        try { await this.plugin.controller?.updateOptions(this.source.repository, { secretName, pinnedTag, autoUpdate: !pinnedTag && autoUpdate }); this.close(); }
        finally { button.setDisabled(false); }
      });
    }));
  }
}
