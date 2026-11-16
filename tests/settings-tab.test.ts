import { beforeEach, expect, it, vi } from 'vitest';
import type { App, Setting, SettingDefinitionItem, SettingDefinitionRender, SettingGroup } from 'obsidian';
import type VaultFetchPlugin from '../src/main';
import { defaultSettings } from '../src/settings';

const ui = vi.hoisted(() => {
  class Element {
    children: Element[] = [];
    parent?: Element;
    addClass() { return this; }
    empty() { for (const child of this.children) child.parent = undefined; this.children = []; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = undefined; }
    createDiv() { const child = new Element(); child.parent = this; this.children.push(child); return child; }
    createEl() { return this.createDiv(); }
    setAttr() { return this; }
  }
  class Row {
    settingEl: Element;
    constructor(parent: Element = new Element()) { this.settingEl = parent.createDiv(); }
    setName() { return this; } setDesc() { return this; } setHeading() { return this; }
    addComponent() { return this; } addToggle() { return this; } addButton() { return this; }
  }
  return { Element, Row };
});
const compatibility = vi.hoisted(() => ({ modern: true }));
vi.mock('obsidian', () => ({
  App: class {}, PluginSettingTab: class {
    containerEl = new ui.Element();
    settingItems: SettingDefinitionItem[] = [];
    constructor(public app: App) {}
    getSettingDefinitions(): SettingDefinitionItem[] { return []; }
    update() { this.settingItems = this.getSettingDefinitions(); }
  },
  Setting: ui.Row, SecretComponent: class {}, Modal: class {}, Notice: class {}, getLanguage: () => 'en',
  requireApiVersion: (version: string) => version === '1.13.0' && compatibility.modern,
}));
import { VaultFetchSettingsTab } from '../src/ui/settings-tab';

beforeEach(() => { compatibility.modern = true; });

function setup(ready = true) {
  const listeners = new Set<() => void>();
  const controller = { settings: defaultSettings(), installed: () => undefined, status: () => ({ kind: 'idle' }), busy: () => false };
  const plugin = { controller: ready ? controller : undefined, initializationError: '',
    subscribe: (callback: () => void) => { listeners.add(callback); return () => { listeners.delete(callback); }; } };
  const tab = new VaultFetchSettingsTab({} as App, plugin as unknown as VaultFetchPlugin);
  return { tab, plugin, controller, listeners };
}
const rows = (items: SettingDefinitionItem[]): SettingDefinitionRender[] => items.flatMap(item =>
  'items' in item ? rows(item.items as SettingDefinitionItem[] ?? []) : item as SettingDefinitionRender);

it('refreshes search definitions when initialization finishes while the tab is hidden', () => {
  const { tab, plugin, controller } = setup(false);
  const update = vi.spyOn(tab, 'update');
  tab.refreshIndex();
  expect(rows(tab.settingItems).map(item => item.name)).toEqual(['VaultFetch']);
  plugin.controller = controller;
  tab.refreshIndex();
  expect(rows(tab.settingItems).map(item => item.name)).toContain('Default GitHub credential');
  tab.refreshIndex();
  expect(update).toHaveBeenCalledTimes(2);
});

it('indexes added source identities without rebuilding the index for status-only changes', () => {
  const { tab, controller } = setup();
  const update = vi.spyOn(tab, 'update'); tab.refreshIndex();
  controller.settings.sources.push({ repository: 'example/sample', pluginId: 'sample-plugin', name: 'Synthetic source', secretName: '', pinnedTag: '', autoUpdate: false, installedTag: '', installedVersion: '' });
  tab.refreshIndex();
  expect(rows(tab.settingItems).flatMap(item => item.aliases ?? [])).toContain('example/sample');
  tab.refreshIndex(); expect(update).toHaveBeenCalledTimes(2);
});

it('reuses a native row without accumulating lists or allowing stale cleanup to unsubscribe its replacement', () => {
  const { tab, listeners } = setup();
  const list = rows(tab.getSettingDefinitions()).at(-1)!;
  const setting = new ui.Row();
  const first = list.render(setting as unknown as Setting, {} as SettingGroup);
  const second = list.render(setting as unknown as Setting, {} as SettingGroup);
  expect(setting.settingEl.children).toHaveLength(1);
  expect(listeners.size).toBe(1);
  if (typeof first === 'function') first();
  expect(setting.settingEl.children).toHaveLength(1); expect(listeners.size).toBe(1);
  if (typeof second === 'function') second();
  expect(setting.settingEl.children).toHaveLength(0); expect(listeners.size).toBe(0);
});

it('keeps the pre-1.13 renderer working without leaking subscriptions on repeated display', () => {
  compatibility.modern = false;
  const { tab, listeners } = setup();
  Object.defineProperty(tab, 'update', { get() { throw new Error('A newer API was accessed on an older version.'); } });
  tab.refreshIndex(); tab.display(); tab.display();
  expect(listeners.size).toBe(1);
  tab.hide(); expect(listeners.size).toBe(0);
});

it('finishes initialization on older versions without reading the newer update API', () => {
  compatibility.modern = false;
  const { tab, listeners, plugin, controller } = setup(false);
  Object.defineProperty(tab, 'update', { get() { throw new Error('A newer API was accessed on an older version.'); } });
  tab.display();
  plugin.controller = controller;
  for (const listener of [...listeners]) listener();
  expect(listeners.size).toBe(1);
  tab.hide(); expect(listeners.size).toBe(0);
});
