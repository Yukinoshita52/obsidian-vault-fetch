import { readFile, access, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import semver from 'semver';

const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const versions = JSON.parse(await readFile('versions.json', 'utf8'));
if (pkg.license !== 'MIT' || !(await readFile('LICENSE', 'utf8')).startsWith('MIT License\n')) throw new Error('The project must use the MIT license.');
for (const path of ['README.md', 'README.zh-CN.md', 'LICENSE', 'styles.css']) await access(path);
if (manifest.id !== 'vault-fetch' || manifest.name !== 'VaultFetch') throw new Error('Unexpected plugin identity.');
if (semver.valid(manifest.version) !== manifest.version || pkg.version !== manifest.version) throw new Error('Version declarations differ.');
if (versions[manifest.version] !== manifest.minAppVersion) throw new Error('Compatibility mapping differs.');
if (!manifest.description.endsWith('.') || manifest.description.length > 250) throw new Error('Invalid directory description.');
const tag = process.argv.slice(2).find(value => value !== '--bundle');
if (tag && tag !== manifest.version) throw new Error('Release tag must exactly match manifest.version.');
async function sourceFiles(directory = '.') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['.git', 'node_modules', '.dev', 'coverage', '.DS_Store', 'main.js'].includes(entry.name) && directory === '.') continue;
    const path = directory === '.' ? entry.name : `${directory}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Unexpected symbolic link: ${path}.`);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}
const files = await sourceFiles();
if (await access('.git').then(() => true, () => false)) {
  const tracked = execFileSync('git', ['ls-files', '-z', '--cached'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  files.push(...tracked.split('\0').filter(path => path && !files.includes(path)));
}
if (process.argv.includes('--bundle')) files.push('main.js');
const patterns = [
  /(?:gh[pousr]_[A-Za-z0-9_]{25,}|github_pat_[A-Za-z0-9_]{40,})/,
  /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/,
  /\/Users\/[^/\s]+\//,
  /[A-Z]:\\Users\\/,
];
for (const path of files) {
  if (/(?:^|\/)data\.json$|(?:^|\/)\.env(?:\.|$)|(?:^|\/)\.obsidian\//.test(path)) throw new Error('Runtime data must not be tracked.');
  const contents = await readFile(path, 'utf8');
  if (patterns.some(pattern => pattern.test(contents))) throw new Error(`Privacy check failed for ${path}; value withheld.`);
}
console.log(`Package and privacy checks passed (${files.length} source files).`);
