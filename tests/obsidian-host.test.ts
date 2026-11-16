import { afterEach, describe, expect, it, vi } from 'vitest';
const network = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('obsidian', () => ({ Platform: { isMobile: false }, requireApiVersion: () => true, normalizePath: (value: string) => value, requestUrl: network.request }));
import { createObsidianHost } from '../src/obsidian-host';
import type { App } from 'obsidian';

const app = { vault: { adapter: {} } } as App;
const response = (status: number, headers: Record<string, string> = {}) => ({ status, headers, arrayBuffer: new ArrayBuffer(0) });

afterEach(() => { network.request.mockReset(); vi.useRealTimers(); });

describe('Obsidian transport boundary', () => {
  it('follows a signed asset redirect without forwarding the credential', async () => {
    network.request.mockResolvedValueOnce(response(302, { Location: 'https://release-assets.githubusercontent.com/example/file?signature=synthetic' })).mockResolvedValueOnce(response(200));
    await createObsidianHost(app).transport.request('https://api.github.com/repos/example/sample/releases/assets/1', { Authorization: 'Bearer synthetic-value', Accept: 'application/octet-stream' });
    expect(network.request.mock.calls[0]?.[0].headers.Authorization).toBe('Bearer synthetic-value');
    expect(network.request.mock.calls[1]?.[0].headers).toEqual({ Accept: 'application/octet-stream' });
  });

  it('rejects an unexpected redirect host before sending a second request', async () => {
    network.request.mockResolvedValueOnce(response(302, { location: 'https://untrusted.invalid/download' }));
    await expect(createObsidianHost(app).transport.request('https://api.github.com/example', { Authorization: 'Bearer synthetic-value' })).rejects.toMatchObject({ code: 'network' });
    expect(network.request).toHaveBeenCalledTimes(1);
  });

  it('sanitizes errors and times out stalled metadata requests', async () => {
    vi.useFakeTimers();
    network.request.mockImplementation(() => new Promise(() => {}));
    const promise = createObsidianHost(app).transport.request('https://api.github.com/example', {});
    const assertion = expect(promise).rejects.toMatchObject({ code: 'network' });
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });

  it('does not write or change plugin state if lifecycle capabilities are unavailable', () => {
    expect(createObsidianHost(app).lifecycle.supported()).toBe(false);
  });

  it('releases a stalled request when the owning plugin unloads', async () => {
    network.request.mockImplementation(() => new Promise(() => {}));
    const abort = new AbortController();
    const pending = createObsidianHost(app, abort.signal).transport.request('https://api.github.com/example', {});
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  });
});
