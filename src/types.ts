export const CODE_FILES = ['manifest.json', 'main.js', 'styles.css'] as const;
export type CodeFile = (typeof CODE_FILES)[number];

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  minAppVersion: string;
  description?: string;
  author?: string;
  isDesktopOnly?: boolean;
}

export interface ReleaseSummary {
  tag: string;
  name: string;
  url: string;
  publishedAt?: string;
  notes?: string;
  prerelease: boolean;
}

export interface ReleaseAsset {
  id: number;
  name: string;
  size: number;
  digest?: string;
}

export interface PreparedRelease extends ReleaseSummary {
  repository: string;
  manifest: PluginManifest;
  manifestBytes: Uint8Array;
  assets: { manifest: ReleaseAsset; main: ReleaseAsset; styles?: ReleaseAsset };
}

export interface PluginBuild {
  repository: string;
  tag: string;
  manifest: PluginManifest;
  files: { 'manifest.json': Uint8Array; 'main.js': Uint8Array; 'styles.css'?: Uint8Array };
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  bytes: Uint8Array;
}

export interface HttpTransport {
  request(url: string, headers: Record<string, string>): Promise<HttpResponse>;
}

export interface FileStore {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  rmdir(path: string, recursive: boolean): Promise<void>;
}

export interface PluginLifecycle {
  supported(): boolean;
  isEnabled(id: string): boolean;
  isLoaded(id: string): boolean;
  unload(id: string): Promise<void>;
  refresh(): Promise<void>;
  load(id: string): Promise<void>;
  enable(id: string): Promise<void>;
  disable(id: string): Promise<void>;
}

export interface InstallOptions {
  managed: boolean;
  allowMissing?: boolean;
  expectedPluginId?: string;
  enableAfterInstall: boolean;
  guard?: () => void;
  commit: (transactionId: string) => Promise<void>;
}

export interface InstallResult {
  pluginId: string;
  version: string;
  enabled: boolean;
}

export interface RecoveryResult {
  pluginId: string;
  recovered: boolean;
  error?: string;
}

export type ErrorCode =
  | 'repository' | 'network' | 'authentication' | 'access' | 'rate-limit'
  | 'release' | 'asset' | 'manifest' | 'checksum' | 'too-large'
  | 'conflict' | 'self' | 'busy' | 'lifecycle' | 'filesystem'
  | 'rollback' | 'cancelled' | 'compatibility' | 'settings';

export class VaultFetchError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly status?: number,
    public readonly retryAt?: number,
  ) {
    super(message);
    this.name = 'VaultFetchError';
  }
}

export interface ManagedSource {
  repository: string;
  pluginId: string;
  name: string;
  secretName: string;
  pinnedTag: string;
  autoUpdate: boolean;
  installedTag: string;
  installedVersion: string;
  transactionId?: string;
}

export interface VaultFetchSettings {
  schemaVersion: 1;
  secretName: string;
  checkOnStartup: boolean;
  applyUpdatesOnStartup: boolean;
  sources: ManagedSource[];
}

export type SourceStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'installing' }
  | { kind: 'current'; version: string }
  | { kind: 'available'; release: PreparedRelease }
  | { kind: 'error'; message: string };
