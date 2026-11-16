import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { ASSET_LIMITS, GitHubClient, normalizeRepository, parsePluginManifest, validatePluginId } from '../../src/core/github';
import { VaultFetchError } from '../../src/types';
import type { HttpResponse, HttpTransport } from '../../src/types';

const bytes = (value: unknown) => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
const manifest = { id: 'sample-plugin', name: 'Sample', version: '1.2.3', minAppVersion: '1.6.0', description: 'Synthetic fixture', author: 'Example' };
const manifestBytes = bytes(manifest);
const mainBytes = bytes('synthetic-code');
const release = (extra: Record<string, unknown> = {}) => ({
  tag_name: 'v1.2.3', name: 'Example release', draft: false, prerelease: false,
  browser_download_url: 'https://untrusted.invalid/never-fetch',
  assets: [
    { id: 101, name: 'manifest.json', size: manifestBytes.byteLength, browser_download_url: 'https://untrusted.invalid/manifest' },
    { id: 102, name: 'main.js', size: mainBytes.byteLength, browser_download_url: 'https://untrusted.invalid/main' },
  ], ...extra,
});

class Transport implements HttpTransport {
  calls: { url: string; headers: Record<string, string> }[] = [];
  replies: HttpResponse[] = [];
  async request(url: string, headers: Record<string, string>): Promise<HttpResponse> {
    this.calls.push({ url, headers });
    const response = this.replies.shift();
    if (!response) throw new Error('Synthetic transport failure containing sensitive response material');
    return response;
  }
  reply(value: unknown, status = 200, headers: Record<string, string> = {}): this {
    this.replies.push({ status, headers, bytes: value instanceof Uint8Array ? value : bytes(value) });
    return this;
  }
}

describe('repository and manifest validation', () => {
  it('normalizes only repository roots', () => {
    expect(normalizeRepository('example/sample')).toBe('example/sample');
    expect(normalizeRepository('https://github.com/example/sample/')).toBe('example/sample');
    expect(normalizeRepository('HTTPS://GitHub.com/example/sample')).toBe('example/sample');
    expect(normalizeRepository('example/sample..beta')).toBe('example/sample..beta');
    expect(normalizeRepository('https://github.com/example/sample..beta')).toBe('example/sample..beta');
    for (const input of ['https://example.invalid/example/sample', 'https://user@github.com/example/sample',
      'https://github.com/example/sample?token=value', 'https://github.com/example/sample#readme',
      'https://github.com/example/sample/tree/main', 'example/../sample', 'example/%2e%2e',
      'https://github.com/example/../sample', 'https://github.com/example/./sample',
      'https://github.com/example/%2e%2e/sample', 'https://github.com/example/sample%2fother',
      'https://github.com/example/sample?', 'https://github.com/example/sample#', 'https://@github.com/example/sample',
      '/example/sample', 'example/sample\\escape', 'example/..', 'example/sample/']) {
      expect(() => normalizeRepository(input), input).toThrow(VaultFetchError);
    }
  });

  it('rejects unsafe cross-platform plugin IDs', () => {
    for (const id of ['../sample', 'sample/other', 'sample\\other', '.', '', 'UPPER', 'con', 'lpt1', 'sample.json', 'a'.repeat(101)]) {
      expect(() => validatePluginId(id), id).toThrow(VaultFetchError);
    }
    expect(validatePluginId('sample-plugin-2')).toBe('sample-plugin-2');
  });

  it('checks required fields, UTF-8, SemVer and compatibility flags', () => {
    expect(parsePluginManifest(manifestBytes)).toEqual(manifest);
    for (const value of [{ ...manifest, id: '../escape' }, { ...manifest, version: 'v1.2.3' },
      { ...manifest, minAppVersion: 'latest' }, { ...manifest, author: undefined },
      { ...manifest, description: '' }, { ...manifest, isDesktopOnly: 'false' }, []]) {
      expect(() => parsePluginManifest(bytes(value))).toThrow(VaultFetchError);
    }
    expect(() => parsePluginManifest(new Uint8Array([0xff]))).toThrow(VaultFetchError);
    expect(() => parsePluginManifest(new Uint8Array(ASSET_LIMITS['manifest.json'] + 1))).toThrowError(expect.objectContaining({ code: 'too-large' }));
  });
});

describe('GitHub release client', () => {
  it('uses authenticated asset API requests and reads the credential for every request', async () => {
    const http = new Transport().reply(release()).reply(manifestBytes).reply(mainBytes);
    let credential = 'synthetic-oauth-value';
    const client = new GitHubClient(http, () => credential);
    const prepared = await client.prepare('example/private-sample');
    credential = 'synthetic-pat-value';
    const build = await client.download(prepared);
    expect(build.files['manifest.json']).toEqual(manifestBytes);
    expect(build.files['main.js']).toEqual(mainBytes);
    expect(http.calls.map(call => call.url)).toEqual([
      'https://api.github.com/repos/example/private-sample/releases/latest',
      'https://api.github.com/repos/example/private-sample/releases/assets/101',
      'https://api.github.com/repos/example/private-sample/releases/assets/102',
    ]);
    expect(http.calls[1]?.headers).toMatchObject({ Accept: 'application/octet-stream', Authorization: 'Bearer synthetic-oauth-value' });
    expect(http.calls[2]?.headers.Authorization).toBe('Bearer synthetic-pat-value');
  });

  it.each<{ status: number; headers: Record<string, string>; code: string }>([
    { status: 401, headers: {}, code: 'authentication' }, { status: 403, headers: {}, code: 'access' },
    { status: 404, headers: {}, code: 'access' },
    { status: 403, headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '2000000000' }, code: 'rate-limit' },
    { status: 429, headers: { 'Retry-After': '30' }, code: 'rate-limit' },
  ])('sanitizes HTTP $status errors and distinguishes their meaning', async ({ status, headers, code }) => {
    const http = new Transport().reply({ message: 'never disclose synthetic private response' }, status, headers);
    const failure = await new GitHubClient(http, () => 'synthetic-value').prepare('example/sample').catch(error => error as VaultFetchError) as VaultFetchError;
    expect(failure).toBeInstanceOf(VaultFetchError);
    expect(failure).toMatchObject({ code, status });
    expect(failure.message).not.toContain('never disclose');
    expect(failure.message).not.toContain('synthetic-value');
    if (code === 'rate-limit') expect(failure.retryAt).toBeGreaterThan(0);
  });

  it('sanitizes network and malformed JSON failures', async () => {
    const network = new GitHubClient(new Transport(), () => null);
    await expect(network.prepare('example/sample')).rejects.toMatchObject({ code: 'network' });
    const malformed = new GitHubClient(new Transport().reply(bytes('private non-json response')), () => null);
    await expect(malformed.prepare('example/sample')).rejects.toMatchObject({ code: 'release' });
  });

  it('filters draft and prerelease entries while allowing an explicit prerelease', async () => {
    const values = [release(), release({ draft: true }), release({ prerelease: true, tag_name: 'v1.2.4-beta.1' })];
    const http = new Transport().reply(values).reply(values).reply(release({ prerelease: true })).reply(manifestBytes);
    const client = new GitHubClient(http, () => null);
    expect(await client.listReleases('example/sample')).toHaveLength(1);
    expect(await client.listReleases('example/sample', true)).toHaveLength(2);
    expect((await client.prepare('example/sample', 'v1.2.3')).prerelease).toBe(true);
    expect(http.calls[2]?.url).toMatch(/\/releases\/tags\/v1\.2\.3$/);
  });

  it('rejects drafts, a prerelease returned as latest, and version/tag mismatch', async () => {
    for (const data of [release({ draft: true }), release({ prerelease: true }), release({ tag_name: 'v1.2.4' })]) {
      const client = new GitHubClient(new Transport().reply(data).reply(manifestBytes), () => null);
      await expect(client.prepare('example/sample')).rejects.toBeInstanceOf(VaultFetchError);
    }
  });

  it('rejects missing, duplicate, and oversized assets before downloading them', async () => {
    for (const assets of [[], [release().assets[0]], [...release().assets, release().assets[0]],
      [release().assets[0], { id: 102, name: 'main.js', size: ASSET_LIMITS['main.js'] + 1 }]]) {
      const http = new Transport().reply(release({ assets }));
      await expect(new GitHubClient(http, () => null).prepare('example/sample')).rejects.toBeInstanceOf(VaultFetchError);
      expect(http.calls).toHaveLength(1);
    }
  });

  it('checks actual sizes and optional SHA-256 digests', async () => {
    const digest = Array.from(sha256(manifestBytes), value => value.toString(16).padStart(2, '0')).join('');
    const assets = [{ ...release().assets[0], digest: `sha256:${digest}` }, release().assets[1]];
    const good = new Transport().reply(release({ assets })).reply(manifestBytes);
    await expect(new GitHubClient(good, () => null).prepare('example/sample')).resolves.toHaveProperty('manifest.id', manifest.id);
    const wrong = new Transport().reply(release({ assets: [{ ...assets[0], digest: `sha256:${'0'.repeat(64)}` }, assets[1]] })).reply(manifestBytes);
    await expect(new GitHubClient(wrong, () => null).prepare('example/sample')).rejects.toMatchObject({ code: 'checksum' });
    const short = new Transport().reply(release()).reply(manifestBytes.slice(1));
    await expect(new GitHubClient(short, () => null).prepare('example/sample')).rejects.toMatchObject({ code: 'asset' });
  });
});
