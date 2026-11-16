import { sha256 } from '@noble/hashes/sha2.js';
import { ASSET_LIMITS, normalizeRepository, parsePluginManifest, validatePluginId } from './github';
import { hasControlCharacters } from './validation';
import { CODE_FILES, VaultFetchError } from '../types';
import type {
  CodeFile, FileStore, InstallOptions, InstallResult, PluginBuild, PluginLifecycle, RecoveryResult,
} from '../types';

type FileHashes = Partial<Record<CodeFile, string>>;
interface Journal {
  schema: 1;
  phase: 'prepared' | 'committed';
  transactionId: string;
  pluginId: string;
  oldFiles: CodeFile[];
  oldHashes: FileHashes;
  newHashes: FileHashes;
  enabled: boolean;
  loaded: boolean;
}

const LOCKS = new WeakMap<FileStore, Set<string>>();
const ACTIVE_TRANSACTIONS = new WeakMap<FileStore, Set<string>>();
const NONCE = /^[a-f0-9]{32}$/;
const PREPARING = /^preparing-[a-f0-9]{32}$/;
const CLEANUP = /^cleanup-[a-f0-9]{32}$/;
const HASH = /^[a-f0-9]{64}$/;
const encoder = new TextEncoder();

function hash(bytes: Uint8Array): string {
  return Array.from(sha256(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

function relativeDirectory(value: string): string {
  if (!value || value.length > 1024 || value.includes('\\') || hasControlCharacters(value) ||
      value.split('/').some(part => !part || part === '.' || part === '..' || part.includes(':'))) {
    throw new VaultFetchError('filesystem', 'The vault configuration directory is invalid.');
  }
  return value;
}

function safeError(error: unknown, code: 'filesystem' | 'lifecycle' = 'filesystem'): VaultFetchError {
  return error instanceof VaultFetchError ? error : new VaultFetchError(code, code === 'lifecycle' ?
    'The plugin lifecycle operation failed.' : 'The plugin files could not be updated.');
}

export class PluginInstaller {
  private readonly configDir: string;
  private readonly selfId: string;
  private readonly transactions: string;
  private readonly locks: Set<string>;
  private readonly activeTransactions: Set<string>;
  private readonly isCommitted: (pluginId: string, transactionId: string) => boolean;

  constructor(private readonly files: FileStore, private readonly lifecycle: PluginLifecycle, options: {
    configDir: string; selfId: string; isCommitted?: (pluginId: string, transactionId: string) => boolean;
  }) {
    this.configDir = relativeDirectory(options.configDir);
    this.selfId = validatePluginId(options.selfId);
    this.transactions = `${this.configDir}/plugins/${this.selfId}/transactions`;
    let locks = LOCKS.get(files);
    if (!locks) { locks = new Set(); LOCKS.set(files, locks); }
    this.locks = locks;
    let active = ACTIVE_TRANSACTIONS.get(files);
    if (!active) { active = new Set(); ACTIVE_TRANSACTIONS.set(files, active); }
    this.activeTransactions = active;
    this.isCommitted = options.isCommitted ?? (() => false);
  }

  private target(id: string): string { return `${this.configDir}/plugins/${id}`; }

  private guard(options: InstallOptions): void {
    try { options.guard?.(); }
    catch { throw new VaultFetchError('cancelled', 'The installation was cancelled.'); }
  }

  private async mkdir(path: string, guard: () => void): Promise<void> {
    let current = '';
    for (const component of path.split('/')) {
      current = current ? `${current}/${component}` : component;
      if (!(await this.files.exists(current))) { guard(); await this.files.mkdir(current); }
    }
  }

  private acquire(id: string): () => void {
    const key = this.target(id);
    if (this.locks.has(key)) throw new VaultFetchError('busy', 'Another operation is already updating this plugin.');
    this.locks.add(key);
    return () => { this.locks.delete(key); };
  }

  private async runtime(id: string, enabled: boolean, loaded: boolean, guard: () => void): Promise<void> {
    try {
      guard(); await this.lifecycle.refresh();
      if (enabled !== this.lifecycle.isEnabled(id)) {
        guard();
        if (enabled) await this.lifecycle.enable(id); else await this.lifecycle.disable(id);
      }
      if (loaded !== this.lifecycle.isLoaded(id)) {
        guard();
        if (loaded) await this.lifecycle.load(id); else await this.lifecycle.unload(id);
      }
      if (enabled !== this.lifecycle.isEnabled(id) || loaded !== this.lifecycle.isLoaded(id)) {
        throw new VaultFetchError('lifecycle', 'The plugin could not reach its requested enabled and loaded state.');
      }
    } catch (error) { throw safeError(error, 'lifecycle'); }
  }

  private async writeJournal(transaction: string, journal: Journal, guard: () => void): Promise<void> {
    const filename = journal.phase === 'prepared' ? 'journal.json' : 'committed.json';
    const bytes = encoder.encode(JSON.stringify(journal));
    await this.verifiedWrite(`${transaction}/${filename}.tmp`, bytes, hash(bytes), guard);
    guard();
    await this.files.rename(`${transaction}/${filename}.tmp`, `${transaction}/${filename}`);
  }

  private async verifiedWrite(path: string, bytes: Uint8Array, digest: string, guard: () => void): Promise<void> {
    guard(); await this.files.write(path, bytes);
    if (hash(await this.files.read(path)) !== digest) throw new VaultFetchError('checksum', 'A transaction file could not be written completely.');
  }

  private async replaceFrom(temporary: string, target: string, guard: () => void): Promise<void> {
    if (await this.files.exists(target)) { guard(); await this.files.remove(target); }
    guard(); await this.files.rename(temporary, target);
  }

  private async readJournal(transaction: string, nonce: string): Promise<Journal> {
    const prepared = this.parseJournal(await this.files.read(`${transaction}/journal.json`), nonce);
    if (!(await this.files.exists(`${transaction}/committed.json`))) return prepared;
    const committed = this.parseJournal(await this.files.read(`${transaction}/committed.json`), nonce);
    if (committed.phase !== 'committed' || JSON.stringify(committed) !== JSON.stringify({ ...prepared, phase: 'committed' })) {
      throw new VaultFetchError('rollback', 'The transaction commit marker does not match its journal.');
    }
    return committed;
  }

  private async finishTransaction(transaction: string): Promise<void> {
    const nonce = transaction.slice(this.transactions.length + 1);
    if (!transaction.startsWith(`${this.transactions}/`) || !NONCE.test(nonce)) {
      throw new VaultFetchError('rollback', 'The completed transaction path is invalid.');
    }
    const tombstone = `${this.transactions}/cleanup-${nonce}`;
    await this.files.rename(transaction, tombstone);
    this.activeTransactions.add(tombstone);
    try { await this.files.rmdir(tombstone, true); }
    catch { /* The tombstone remains safe to delete even after its journal is gone. */ }
    finally { this.activeTransactions.delete(tombstone); }
  }

  private async restore(transaction: string, journal: Journal, preserveCurrentState = false): Promise<void> {
    const hasOldPlugin = journal.oldFiles.includes('manifest.json') && journal.oldFiles.includes('main.js');
    const enabled = hasOldPlugin && (preserveCurrentState ? this.lifecycle.isEnabled(journal.pluginId) : journal.enabled);
    const loaded = hasOldPlugin && (preserveCurrentState ? enabled && this.lifecycle.isLoaded(journal.pluginId) : journal.loaded);
    const backups = new Map<CodeFile, Uint8Array>();
    for (const name of journal.oldFiles) {
      const bytes = await this.files.read(`${transaction}/backup/${name}`);
      if (bytes.byteLength > ASSET_LIMITS[name] || hash(bytes) !== journal.oldHashes[name]) {
        throw new VaultFetchError('rollback', 'A transaction backup is missing or damaged. The backup was preserved.');
      }
      backups.set(name, bytes);
    }
    const manifest = backups.get('manifest.json');
    if (manifest && parsePluginManifest(manifest).id !== journal.pluginId) {
      throw new VaultFetchError('rollback', 'The transaction backup has a different plugin identity.');
    }
    await this.mkdir(`${transaction}/restore`, () => {});
    for (const [name, bytes] of backups) {
      await this.verifiedWrite(`${transaction}/restore/${name}.tmp`, bytes, journal.oldHashes[name]!, () => {});
    }
    if (this.lifecycle.isLoaded(journal.pluginId)) await this.lifecycle.unload(journal.pluginId);
    for (const name of CODE_FILES) {
      const path = `${this.target(journal.pluginId)}/${name}`;
      const backup = backups.get(name);
      if (backup) await this.replaceFrom(`${transaction}/restore/${name}.tmp`, path, () => {});
      else if (await this.files.exists(path)) await this.files.remove(path);
    }
    await this.runtime(journal.pluginId, enabled, loaded, () => {});
  }

  private async assertNoPending(id: string): Promise<void> {
    if (!(await this.files.exists(this.transactions))) return;
    for (const entry of (await this.files.list(this.transactions)).folders) {
      const name = entry.startsWith(`${this.transactions}/`) ? entry.slice(this.transactions.length + 1) : entry;
      if (CLEANUP.test(name)) continue;
      if (PREPARING.test(name)) {
        if (!this.activeTransactions.has(`${this.transactions}/${name}`)) throw new VaultFetchError('rollback', 'An incomplete preparation must be cleaned before another installation.');
        continue;
      }
      if (!NONCE.test(name)) throw new VaultFetchError('rollback', 'An invalid transaction must be inspected before another installation.');
      const transaction = `${this.transactions}/${name}`;
      if (this.activeTransactions.has(transaction)) continue;
      const journal = await this.readJournal(transaction, name);
      if (journal.pluginId === id) throw new VaultFetchError('busy', 'An earlier transaction for this plugin still needs recovery.');
    }
  }

  async install(input: PluginBuild, options: InstallOptions): Promise<InstallResult> {
    let releaseLock: (() => void) | undefined;
    let transaction: string | undefined;
    let journal: Journal | undefined;
    let prepared = false;
    let committed = false;
    try {
      this.guard(options);
      if (!this.lifecycle.supported()) throw new VaultFetchError('compatibility', 'This Obsidian version does not expose the required plugin lifecycle controls.');
      const manifestBytes = input.files['manifest.json'].slice();
      const manifest = parsePluginManifest(manifestBytes);
      const id = manifest.id;
      if (id === this.selfId) throw new VaultFetchError('self', 'VaultFetch cannot replace itself.');
      if (input.manifest.id !== id || input.manifest.version !== manifest.version || input.tag.replace(/^v/, '') !== manifest.version) {
        throw new VaultFetchError('manifest', 'The downloaded plugin identity or release version changed.');
      }
      normalizeRepository(input.repository);
      if (options.expectedPluginId !== undefined && validatePluginId(options.expectedPluginId) !== id) {
        throw new VaultFetchError('conflict', 'The release plugin ID differs from the managed plugin ID.');
      }
      if (options.managed && options.expectedPluginId !== id) throw new VaultFetchError('conflict', 'An update requires the previously registered plugin ID.');
      const code: Partial<Record<CodeFile, Uint8Array>> = { 'manifest.json': manifestBytes };
      for (const name of ['main.js', 'styles.css'] as const) {
        const bytes = input.files[name];
        if (name === 'main.js' && (!bytes || bytes.byteLength === 0)) throw new VaultFetchError('asset', 'The plugin build is missing main.js.');
        if (bytes) {
          if (bytes.byteLength > ASSET_LIMITS[name]) throw new VaultFetchError('too-large', `${name} exceeds its size limit.`);
          code[name] = bytes.slice();
        }
      }
      await this.recover();
      this.guard(options);
      releaseLock = this.acquire(id);
      await this.assertNoPending(id);
      const target = this.target(id);
      if (!options.managed && (await this.files.exists(target) || this.lifecycle.isLoaded(id) || this.lifecycle.isEnabled(id))) {
        throw new VaultFetchError('conflict', 'A plugin with this ID already exists and is not managed by VaultFetch.');
      }
      if (options.managed && !options.allowMissing &&
          (!(await this.files.exists(`${target}/manifest.json`)) || !(await this.files.exists(`${target}/main.js`)))) {
        throw new VaultFetchError('conflict', 'The managed plugin is missing. Use the explicit reinstall action to restore it.');
      }
      const guard = () => this.guard(options);
      const oldFiles: CodeFile[] = [];
      const oldHashes: FileHashes = {};
      const backups = new Map<CodeFile, Uint8Array>();
      for (const name of CODE_FILES) {
        const path = `${target}/${name}`;
        if (await this.files.exists(path)) {
          const bytes = await this.files.read(path);
          if (bytes.byteLength > ASSET_LIMITS[name]) throw new VaultFetchError('too-large', 'An installed code file is too large to back up safely.');
          if (name === 'manifest.json' && parsePluginManifest(bytes).id !== id) throw new VaultFetchError('conflict', 'The installed manifest has a different plugin ID.');
          oldFiles.push(name); oldHashes[name] = hash(bytes); backups.set(name, bytes);
        }
      }
      if (options.managed && !options.allowMissing && (!oldHashes['manifest.json'] || !oldHashes['main.js'])) {
        throw new VaultFetchError('conflict', 'The managed plugin disappeared while its backup was being prepared.');
      }
      const newHashes: FileHashes = {};
      for (const name of CODE_FILES) if (code[name]) newHashes[name] = hash(code[name]);
      journal = { schema: 1, phase: 'prepared', transactionId: '', pluginId: id, oldFiles, oldHashes, newHashes,
        enabled: this.lifecycle.isEnabled(id), loaded: this.lifecycle.isLoaded(id) };
      await this.mkdir(this.transactions, guard);
      for (let attempt = 0; attempt < 5; attempt++) {
        const random = new Uint8Array(16);
        window.crypto.getRandomValues(random);
        const nonce = Array.from(random, value => value.toString(16).padStart(2, '0')).join('');
        const candidate = `${this.transactions}/preparing-${nonce}`;
        if (!(await this.files.exists(candidate)) && !(await this.files.exists(`${this.transactions}/${nonce}`))) {
          transaction = candidate; journal.transactionId = nonce; break;
        }
      }
      if (!transaction) throw new VaultFetchError('filesystem', 'A transaction directory could not be created.');
      this.activeTransactions.add(transaction);
      await this.mkdir(`${transaction}/stage`, guard);
      await this.mkdir(`${transaction}/backup`, guard);
      await this.mkdir(`${transaction}/activation`, guard);
      for (const name of CODE_FILES) {
        const bytes = code[name];
        if (bytes) {
          await this.verifiedWrite(`${transaction}/stage/${name}`, bytes, newHashes[name]!, guard);
          await this.verifiedWrite(`${transaction}/activation/${name}.tmp`, bytes, newHashes[name]!, guard);
        }
        const backup = backups.get(name);
        if (backup) await this.verifiedWrite(`${transaction}/backup/${name}`, backup, oldHashes[name]!, guard);
      }
      await this.writeJournal(transaction, journal, guard);
      if (!options.managed && await this.files.exists(target)) {
        throw new VaultFetchError('conflict', 'Another plugin directory appeared while preparing the installation.');
      }
      for (const name of CODE_FILES) {
        const path = `${target}/${name}`;
        if (await this.files.exists(path)) {
          if (!oldHashes[name] || hash(await this.files.read(path)) !== oldHashes[name]) {
            throw new VaultFetchError('conflict', 'The installed code changed while preparing the update.');
          }
        } else if (oldHashes[name]) throw new VaultFetchError('conflict', 'The installed code disappeared while preparing the update.');
      }
      const ready = `${this.transactions}/${journal.transactionId}`;
      guard(); await this.files.rename(transaction, ready);
      this.activeTransactions.delete(transaction);
      transaction = ready;
      this.activeTransactions.add(transaction);
      prepared = true;
      if (journal.loaded) {
        guard();
        try { await this.lifecycle.unload(id); }
        catch { throw new VaultFetchError('lifecycle', 'The installed plugin could not be unloaded.'); }
      }
      await this.mkdir(target, guard);
      for (const name of CODE_FILES) {
        const bytes = code[name];
        if (bytes) {
          const staged = await this.files.read(`${transaction}/stage/${name}`);
          if (hash(staged) !== newHashes[name]) throw new VaultFetchError('checksum', 'A staged plugin file changed before installation.');
          const temporary = `${transaction}/activation/${name}.tmp`;
          if (hash(await this.files.read(temporary)) !== newHashes[name]) throw new VaultFetchError('checksum', 'A plugin activation file changed before installation.');
          await this.replaceFrom(temporary, `${target}/${name}`, guard);
        } else if (await this.files.exists(`${target}/${name}`)) { guard(); await this.files.remove(`${target}/${name}`); }
      }
      const installed = parsePluginManifest(await this.files.read(`${target}/manifest.json`));
      if (installed.id !== id || installed.version !== manifest.version) throw new VaultFetchError('manifest', 'The installed manifest does not match the downloaded plugin.');
      const enabled = options.managed ? journal.enabled : options.enableAfterInstall;
      const loaded = options.managed ? journal.loaded : options.enableAfterInstall;
      await this.runtime(id, enabled, loaded, guard);
      guard(); await options.commit(journal.transactionId);
      committed = true;
      // Persisted settings reconcile a crash between commit() and the final journal marker.
      try {
        await this.writeJournal(transaction, { ...journal, phase: 'committed' }, () => {});
        await this.finishTransaction(transaction);
      } catch { /* recover() retries finalization without undoing a committed installation. */ }
      return { pluginId: id, version: manifest.version, enabled };
    } catch (error) {
      if (prepared && !committed && transaction && journal) {
        try {
          await this.restore(transaction, journal);
          await this.finishTransaction(transaction);
        } catch {
          throw new VaultFetchError('rollback', 'Installation failed and the previous plugin could not be fully restored. The transaction backup was preserved. Restart Obsidian to retry recovery.');
        }
      } else if (transaction && !prepared) {
        try { await this.files.rmdir(transaction, true); } catch { /* No installed files were changed. */ }
      }
      throw safeError(error);
    } finally {
      if (transaction) this.activeTransactions.delete(transaction);
      releaseLock?.();
    }
  }

  private parseJournal(bytes: Uint8Array, transactionId: string): Journal {
    if (bytes.byteLength > 16 * 1024) throw new VaultFetchError('rollback', 'The transaction journal is too large.');
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new VaultFetchError('rollback', 'The transaction journal is invalid.'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new VaultFetchError('rollback', 'The transaction journal is invalid.');
    const entry = value as Record<string, unknown>;
    const allowed = ['schema', 'phase', 'transactionId', 'pluginId', 'oldFiles', 'oldHashes', 'newHashes', 'enabled', 'loaded'];
    if (Object.keys(entry).some(key => !allowed.includes(key)) || entry.schema !== 1 ||
        entry.transactionId !== transactionId || !NONCE.test(transactionId) ||
        (entry.phase !== 'prepared' && entry.phase !== 'committed') || typeof entry.enabled !== 'boolean' || typeof entry.loaded !== 'boolean') {
      throw new VaultFetchError('rollback', 'The transaction journal has an unsupported format.');
    }
    const pluginId = validatePluginId(entry.pluginId);
    if (pluginId === this.selfId) throw new VaultFetchError('rollback', 'A transaction cannot target VaultFetch itself.');
    if (!Array.isArray(entry.oldFiles) || entry.oldFiles.some(name => !CODE_FILES.includes(name as CodeFile)) || new Set(entry.oldFiles).size !== entry.oldFiles.length) {
      throw new VaultFetchError('rollback', 'The transaction file list is invalid.');
    }
    for (const key of ['oldHashes', 'newHashes'] as const) {
      const hashes = entry[key];
      if (!hashes || typeof hashes !== 'object' || Array.isArray(hashes) || Object.entries(hashes).some(([name, digest]) =>
        !CODE_FILES.includes(name as CodeFile) || typeof digest !== 'string' || !HASH.test(digest))) {
        throw new VaultFetchError('rollback', 'The transaction checksums are invalid.');
      }
    }
    const oldHashes = entry.oldHashes as FileHashes;
    const newHashes = entry.newHashes as FileHashes;
    if (Object.keys(oldHashes).length !== entry.oldFiles.length || entry.oldFiles.some(name => !oldHashes[name as CodeFile]) ||
        !newHashes['manifest.json'] || !newHashes['main.js']) {
      throw new VaultFetchError('rollback', 'The transaction is missing required checksums.');
    }
    return { schema: 1, phase: entry.phase, transactionId, pluginId, oldFiles: entry.oldFiles as CodeFile[], oldHashes, newHashes,
      enabled: entry.enabled, loaded: entry.loaded };
  }

  async recover(): Promise<RecoveryResult[]> {
    const results: RecoveryResult[] = [];
    let folders: string[];
    try {
      if (!(await this.files.exists(this.transactions))) return results;
      folders = (await this.files.list(this.transactions)).folders;
    } catch { return [{ pluginId: '', recovered: false, error: 'The transaction directory could not be read.' }]; }
    for (const entry of folders) {
      let pluginId = '';
      let cleanupOnly = false;
      let releaseLock: (() => void) | undefined;
      try {
        const name = entry.startsWith(`${this.transactions}/`) ? entry.slice(this.transactions.length + 1) : entry;
        if (PREPARING.test(name) || CLEANUP.test(name)) {
          cleanupOnly = true;
          const discardable = `${this.transactions}/${name}`;
          if (this.activeTransactions.has(discardable)) continue;
          this.activeTransactions.add(discardable);
          try { await this.files.rmdir(discardable, true); }
          finally { this.activeTransactions.delete(discardable); }
          results.push({ pluginId: '', recovered: true });
          continue;
        }
        if (!NONCE.test(name)) throw new VaultFetchError('rollback', 'The transaction directory name is invalid.');
        const transaction = `${this.transactions}/${name}`;
        if (this.activeTransactions.has(transaction)) continue;
        const journal = await this.readJournal(transaction, name);
        pluginId = journal.pluginId;
        if (this.locks.has(this.target(pluginId))) continue;
        releaseLock = this.acquire(pluginId);
        if (journal.phase === 'prepared' && !this.isCommitted(pluginId, journal.transactionId)) {
          if (!this.lifecycle.supported()) throw new VaultFetchError('compatibility', 'Plugin lifecycle recovery is unavailable in this Obsidian version.');
          const staged = await this.files.read(`${transaction}/stage/manifest.json`);
          if (hash(staged) !== journal.newHashes['manifest.json'] || parsePluginManifest(staged).id !== pluginId) {
            throw new VaultFetchError('rollback', 'The staged manifest does not match the transaction.');
          }
          for (const name of CODE_FILES) {
            const path = `${this.target(pluginId)}/${name}`;
            if (await this.files.exists(path)) {
              const bytes = await this.files.read(path);
              const digest = hash(bytes);
              if (digest !== journal.oldHashes[name] && digest !== journal.newHashes[name]) {
                throw new VaultFetchError('rollback', 'Plugin files changed outside the interrupted transaction. The backup was preserved.');
              }
            }
          }
          await this.mkdir(this.target(pluginId), () => {});
          await this.restore(transaction, journal, true);
        }
        await this.finishTransaction(transaction);
        results.push({ pluginId, recovered: true });
      } catch {
        results.push({ pluginId, recovered: false, error: cleanupOnly ?
          'Transaction cleanup could not finish. Restart Obsidian to retry cleanup.' :
          'The transaction could not be recovered safely. Its backup was preserved for inspection.' });
      } finally { releaseLock?.(); }
    }
    return results;
  }
}
