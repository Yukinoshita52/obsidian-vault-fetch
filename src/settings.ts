import { normalizeRepository, validatePluginId } from './core/github';
import { ManagedSource, VaultFetchError, VaultFetchSettings } from './types';

export function defaultSettings(): VaultFetchSettings {
  return { schemaVersion: 1, secretName: '', checkOnStartup: true, applyUpdatesOnStartup: false, sources: [] };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new VaultFetchError('settings', 'Invalid settings object.');
  return value as Record<string, unknown>;
}

function text(value: unknown, fallback = ''): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > 4096) throw new VaultFetchError('settings', 'Invalid settings value.');
  return value.trim();
}

function flag(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new VaultFetchError('settings', 'Invalid settings flag.');
  return value;
}

export function parseSettings(raw: unknown): VaultFetchSettings {
  if (raw == null) return defaultSettings();
  const data = object(raw);
  if (data.schemaVersion !== 1) throw new VaultFetchError('settings', 'Unsupported settings version.');
  if (!Array.isArray(data.sources)) throw new VaultFetchError('settings', 'Invalid managed sources.');
  const seenRepos = new Set<string>();
  const seenIds = new Set<string>();
  const sources: ManagedSource[] = data.sources.map(value => {
    const item = object(value);
    const repository = normalizeRepository(text(item.repository));
    const pluginId = validatePluginId(item.pluginId);
    if (seenRepos.has(repository.toLowerCase()) || seenIds.has(pluginId)) throw new VaultFetchError('settings', 'Duplicate managed source.');
    seenRepos.add(repository.toLowerCase());
    seenIds.add(pluginId);
    return {
      repository, pluginId, name: text(item.name, pluginId), secretName: text(item.secretName),
      pinnedTag: text(item.pinnedTag), autoUpdate: flag(item.autoUpdate, false),
      installedTag: text(item.installedTag), installedVersion: text(item.installedVersion),
      transactionId: item.transactionId === undefined ? undefined : text(item.transactionId),
    };
  });
  return { schemaVersion: 1, secretName: text(data.secretName), checkOnStartup: flag(data.checkOnStartup, true), applyUpdatesOnStartup: flag(data.applyUpdatesOnStartup, false), sources };
}

export function cloneSettings(settings: VaultFetchSettings): VaultFetchSettings {
  return { ...settings, sources: settings.sources.map(source => ({ ...source })) };
}
