import { sha256 } from '@noble/hashes/sha2.js';
import { valid } from 'semver';
import { VaultFetchError } from '../types';
import { hasControlCharacters } from './validation';
import type {
  HttpResponse, HttpTransport, PluginBuild, PluginManifest, PreparedRelease,
  ReleaseAsset, ReleaseSummary,
} from '../types';

export const ASSET_LIMITS = { 'manifest.json': 64 * 1024, 'main.js': 20 * 1024 * 1024, 'styles.css': 2 * 1024 * 1024 } as const;
const JSON_LIMIT = 2 * 1024 * 1024;
const API = 'https://api.github.com';
const RESERVED_ID = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function validatePluginId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(value) || RESERVED_ID.test(value)) {
    throw new VaultFetchError('manifest', 'The plugin ID is not a safe directory name.');
  }
  return value;
}

export function normalizeRepository(input: string): string {
  if (typeof input !== 'string') throw new VaultFetchError('repository', 'Enter a GitHub owner/repository.');
  let repository = input.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(repository)) {
    // Validate the original path before URL parsing can collapse dot segments.
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(repository) || /[%\\?#]/.test(repository) || hasControlCharacters(repository, true) ||
        repository.split('/').some(part => part === '.' || part === '..')) {
      throw new VaultFetchError('repository', 'Use a GitHub HTTPS repository root without credentials, query, or fragment.');
    }
    let url: URL;
    try { url = new URL(repository); }
    catch { throw new VaultFetchError('repository', 'The GitHub repository URL is invalid.'); }
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password ||
        repository.slice(repository.indexOf('://') + 3).split('/')[0]?.includes('@')) {
      throw new VaultFetchError('repository', 'Use a GitHub HTTPS repository root without credentials.');
    }
    repository = url.pathname.slice(1).replace(/\/$/, '');
  }
  const match = /^([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?)\/([a-zA-Z0-9._-]{1,100})$/.exec(repository);
  if (!match || match[1]?.includes('--') || match[2] === '..' || match[2] === '.') {
    throw new VaultFetchError('repository', 'Use owner/repository or its HTTPS GitHub repository URL.');
  }
  return repository;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function parsePluginManifest(bytes: Uint8Array): PluginManifest {
  if (bytes.byteLength > ASSET_LIMITS['manifest.json']) throw new VaultFetchError('too-large', 'The manifest exceeds 64 KiB.');
  let value: Record<string, unknown> | undefined;
  try { value = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
  catch { throw new VaultFetchError('manifest', 'The manifest must contain valid UTF-8 JSON.'); }
  if (!value) throw new VaultFetchError('manifest', 'The manifest must be a JSON object.');
  const id = validatePluginId(value.id);
  for (const key of ['name', 'description', 'author', 'version', 'minAppVersion'] as const) {
    if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 4096) {
      throw new VaultFetchError('manifest', `The manifest requires a valid ${key}.`);
    }
  }
  const version = value.version as string;
  const minAppVersion = value.minAppVersion as string;
  if (valid(version) !== version || valid(minAppVersion) !== minAppVersion) {
    throw new VaultFetchError('manifest', 'Manifest versions must use semantic versioning.');
  }
  if (value.isDesktopOnly !== undefined && typeof value.isDesktopOnly !== 'boolean') {
    throw new VaultFetchError('manifest', 'The manifest has an invalid desktop compatibility flag.');
  }
  return {
    id, name: value.name as string, version, minAppVersion,
    description: value.description as string, author: value.author as string,
    ...(value.isDesktopOnly === undefined ? {} : { isDesktopOnly: value.isDesktopOnly }),
  };
}

function safeTag(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 256 || hasControlCharacters(value)) {
    throw new VaultFetchError('release', 'The release has an invalid tag.');
  }
  return value;
}

function summary(value: unknown, repository: string): ReleaseSummary {
  const release = object(value);
  if (!release || release.draft !== false || typeof release.prerelease !== 'boolean') {
    throw new VaultFetchError('release', 'The release is unavailable or is a draft.');
  }
  const tag = safeTag(release.tag_name);
  return {
    tag, name: typeof release.name === 'string' && release.name ? release.name : tag,
    url: `https://github.com/${repository}/releases/tag/${encodeURIComponent(tag)}`,
    prerelease: release.prerelease,
    ...(typeof release.published_at === 'string' ? { publishedAt: release.published_at } : {}),
    ...(typeof release.body === 'string' ? { notes: release.body } : {}),
  };
}

function checkedAsset(value: unknown, name: keyof typeof ASSET_LIMITS): ReleaseAsset {
  const asset = object(value);
  if (!asset || !Number.isSafeInteger(asset.id) || (asset.id as number) <= 0 || asset.name !== name ||
      !Number.isSafeInteger(asset.size) || (asset.size as number) < (name === 'styles.css' ? 0 : 1)) {
    throw new VaultFetchError('asset', `The release has invalid ${name} metadata.`);
  }
  if ((asset.size as number) > ASSET_LIMITS[name]) throw new VaultFetchError('too-large', `${name} exceeds its size limit.`);
  if (asset.digest != null && (typeof asset.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/i.test(asset.digest))) {
    throw new VaultFetchError('checksum', `The ${name} checksum is unsupported or malformed.`);
  }
  return { id: asset.id as number, name, size: asset.size as number, ...(asset.digest ? { digest: asset.digest } : {}) };
}

function verifyBytes(bytes: Uint8Array, asset: ReleaseAsset): void {
  const name = asset.name as keyof typeof ASSET_LIMITS;
  if (bytes.byteLength > ASSET_LIMITS[name]) throw new VaultFetchError('too-large', `${name} exceeds its size limit.`);
  if (bytes.byteLength !== asset.size) throw new VaultFetchError('asset', `The downloaded ${name} size differs from its release metadata.`);
  if (asset.digest) {
    const digest = Array.from(sha256(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
    if (`sha256:${digest}` !== asset.digest.toLowerCase()) throw new VaultFetchError('checksum', `The ${name} checksum does not match.`);
  }
}

export class GitHubClient {
  constructor(private readonly http: HttpTransport, private readonly token: () => string | null) {}

  private async request(path: string, binary = false): Promise<HttpResponse> {
    let response: HttpResponse;
    let token: string | null;
    try { token = this.token(); }
    catch { throw new VaultFetchError('authentication', 'The selected credential could not be read.'); }
    if (token && hasControlCharacters(token, true)) throw new VaultFetchError('authentication', 'The selected credential is invalid.');
    try {
      response = await this.http.request(`${API}${path}`, {
        Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      });
    } catch {
      throw new VaultFetchError('network', 'The GitHub request could not be completed.');
    }
    const headers = Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key.toLowerCase(), value]));
    if (response.status === 429 || (response.status === 403 && (headers['x-ratelimit-remaining'] === '0' || headers['retry-after'] !== undefined))) {
      const reset = Number(headers['x-ratelimit-reset']);
      const retry = headers['retry-after'];
      const retryAt = retry && /^\d+$/.test(retry) ? Date.now() + Number(retry) * 1000 :
        retry && Number.isFinite(Date.parse(retry)) ? Date.parse(retry) : Number.isFinite(reset) && reset > 0 ? reset * 1000 : undefined;
      throw new VaultFetchError('rate-limit', 'GitHub has temporarily limited requests. Try again after the rate limit resets.', response.status, retryAt);
    }
    if (response.status === 401) throw new VaultFetchError('authentication', 'GitHub rejected the credential. Select a valid credential.', 401);
    if (response.status === 403) throw new VaultFetchError('access', 'GitHub denied access. Check repository permissions and organization authorization.', 403);
    if (response.status === 404) throw new VaultFetchError('access', 'The repository, release, or asset was not found or is not accessible to this credential.', 404);
    if (response.status !== 200) throw new VaultFetchError('network', 'GitHub returned an unexpected response.', response.status);
    return response;
  }

  private async json(path: string): Promise<unknown> {
    const response = await this.request(path);
    if (response.bytes.byteLength > JSON_LIMIT) throw new VaultFetchError('too-large', 'The GitHub release response exceeds its size limit.');
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.bytes)) as unknown; }
    catch { throw new VaultFetchError('release', 'GitHub returned invalid release metadata.'); }
  }

  async listReleases(input: string, includePrerelease = false): Promise<ReleaseSummary[]> {
    const repository = normalizeRepository(input);
    const releases: ReleaseSummary[] = [];
    for (let page = 1; page <= 10; page++) {
      const data = await this.json(`/repos/${repository}/releases?per_page=100&page=${page}`);
      if (!Array.isArray(data)) throw new VaultFetchError('release', 'GitHub returned invalid release metadata.');
      for (const value of data) {
        if (object(value)?.draft === true) continue;
        const release = summary(value, repository);
        if (includePrerelease || !release.prerelease) releases.push(release);
      }
      if (data.length < 100) break;
    }
    return releases;
  }

  async prepare(input: string, tag?: string): Promise<PreparedRelease> {
    const repository = normalizeRepository(input);
    const release = await this.json(`/repos/${repository}/releases/${tag === undefined ? 'latest' : `tags/${encodeURIComponent(safeTag(tag))}`}`);
    const info = summary(release, repository);
    if (tag === undefined && info.prerelease) throw new VaultFetchError('release', 'The latest stable release is unavailable.');
    if (tag !== undefined && info.tag !== tag) throw new VaultFetchError('release', 'GitHub returned a different release tag.');
    const values = object(release)?.assets;
    if (!Array.isArray(values)) throw new VaultFetchError('asset', 'The release does not contain plugin assets.');
    const find = (name: keyof typeof ASSET_LIMITS, required: boolean): ReleaseAsset | undefined => {
      const matches = values.filter(value => object(value)?.name === name);
      if (matches.length > 1 || (required && matches.length !== 1)) throw new VaultFetchError('asset', `The release must contain exactly one ${name}.`);
      return matches.length ? checkedAsset(matches[0], name) : undefined;
    };
    const assets = { manifest: find('manifest.json', true)!, main: find('main.js', true)!, styles: find('styles.css', false) };
    const manifestBytes = await this.asset(repository, assets.manifest, 'manifest.json');
    const manifest = parsePluginManifest(manifestBytes);
    if (info.tag.replace(/^v/, '') !== manifest.version) throw new VaultFetchError('manifest', 'The release tag and manifest version do not match.');
    return { ...info, repository, manifest, manifestBytes, assets };
  }

  private async asset(repository: string, asset: ReleaseAsset, name: keyof typeof ASSET_LIMITS): Promise<Uint8Array> {
    const checked = checkedAsset(asset, name);
    const bytes = (await this.request(`/repos/${normalizeRepository(repository)}/releases/assets/${checked.id}`, true)).bytes;
    verifyBytes(bytes, checked);
    return bytes.slice();
  }

  async download(prepared: PreparedRelease): Promise<PluginBuild> {
    const repository = normalizeRepository(prepared.repository);
    const manifestBytes = prepared.manifestBytes.slice();
    const manifestAsset = checkedAsset(prepared.assets.manifest, 'manifest.json');
    verifyBytes(manifestBytes, manifestAsset);
    const manifest = parsePluginManifest(manifestBytes);
    if (manifest.id !== prepared.manifest.id || manifest.version !== prepared.manifest.version || safeTag(prepared.tag).replace(/^v/, '') !== manifest.version) {
      throw new VaultFetchError('manifest', 'The prepared plugin identity changed. Check the release again.');
    }
    const main = await this.asset(repository, prepared.assets.main, 'main.js');
    const styles = prepared.assets.styles ? await this.asset(repository, prepared.assets.styles, 'styles.css') : undefined;
    return { repository, tag: prepared.tag, manifest, files: { 'manifest.json': manifestBytes, 'main.js': main, ...(styles ? { 'styles.css': styles } : {}) } };
  }
}
