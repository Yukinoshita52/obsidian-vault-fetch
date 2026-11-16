# VaultFetch

[简体中文](README.zh-CN.md)

Install and update Obsidian plugins from public or private **GitHub Releases**, using credentials linked through Obsidian SecretStorage.

## Features

- Preview the plugin ID, version, compatibility and release notes before installation.
- Read private release assets through GitHub's authenticated asset API.
- Follow the latest stable release or pin a specific release tag.
- Check one source or all managed sources. Optional startup checks run after 15 seconds.
- Automatic updates require both a global opt-in and a per-source opt-in. Pinned sources are excluded.
- Keep existing plugin settings and enabled state when updating. Existing unmanaged plugins require explicit adoption.
- Stage code, preserve code backups, roll back failed installations, and reconcile interrupted transactions at startup.
- Use English or Simplified Chinese according to Obsidian's language.

## Install VaultFetch

VaultFetch is prepared for the Obsidian Community directory but **is not listed yet**. A public GitHub repository or release does not imply directory approval.

While submission is pending:

1. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/Yukinoshita52/obsidian-vault-fetch/releases/latest).
2. Create `vault-fetch` under the vault's configuration folder, in `plugins/`.
3. Place the three files directly in that folder, refresh the installed plugins list, and enable VaultFetch.

After approval, install it from **Settings → Community plugins → Browse**. VaultFetch itself is updated using Obsidian's native update mechanism; it cannot install or update itself.

Requires Obsidian **1.11.4+** for SecretStorage. The implementation avoids Node.js and Electron and uses the vault's configured directory. Desktop and mobile compatibility still depends on Obsidian exposing the required plugin lifecycle methods; VaultFetch checks them before writing plugin code.

## Use a private repository

1. Create a GitHub credential with read access to the target repository. A fine-grained PAT needs **Contents: read**. Existing OAuth credentials with equivalent access also work; VaultFetch does not restrict token prefixes.
2. In VaultFetch settings, link the credential using Obsidian's secret selector. Optionally override it for an individual source.
3. Choose **Add plugin**, enter `owner/repository` or its HTTPS GitHub URL, then preview the release.
4. Review the identity and compatibility, approve adoption if a plugin with that ID already exists, then install.

Leave the release tag empty to follow the latest stable release. Enter a tag to pin a version. Tags must match the manifest version, optionally with a `v` prefix.

Updates preserve the target plugin's `data.json` and other non-code files. Automatic updates never silently reinstall a missing plugin or switch a managed plugin to a different ID. **Stop managing** removes only VaultFetch's source record; it does not uninstall the plugin.

## Publisher requirements

Each target release must provide:

- `manifest.json`: valid plugin ID, name, version, minimum Obsidian version, description and author.
- `main.js`: the compiled plugin entry point.
- `styles.css`: optional.

Additional repository files and runtime modules are not installed. Bundle dependencies into `main.js` or use another distribution method if the target needs extra files. Draft releases are rejected; a prerelease may be selected by its explicit tag.

Asset limits: manifest **64 KiB**, JavaScript **20 MiB**, CSS **2 MiB**. Download sizes and available GitHub SHA-256 digests are checked before installation. A digest validates the downloaded asset against GitHub metadata; it does not establish trust in its publisher.

## Privacy and recovery

- VaultFetch contacts `api.github.com` for release metadata and assets. Obsidian's networking stack handles GitHub's download redirects. Repository links open only when clicked.
- Credentials are read from Obsidian SecretStorage and attached to GitHub API requests. `data.json` stores secret names, source identities and preferences, not token values. VaultFetch does not synchronize secrets or claim they are portable between devices.
- There is no telemetry, account service, vault-note upload or runtime dependency download.
- Installing or updating a plugin executes that publisher's code. Choose sources you trust.
- Transactions live under VaultFetch's own plugin folder in `transactions/`. Only `manifest.json`, `main.js` and `styles.css` are backed up and replaced. Unrecoverable or externally changed transactions are retained rather than overwritten.
- Rollback cannot undo data migrations or other changes made by the installed plugin itself. Keep vault backups independently.
- Avoid simultaneous updates of the same plugin using multiple managers. The lifecycle bridge uses capability-checked internal Obsidian APIs because no public plugin-management API exists.

## Development and releases

```sh
npm ci --ignore-scripts
npm run check
npm run build
```

Node.js 22+ is used only for development. Runtime dependencies are bundled into the release entry point; license notices are embedded in the build.

A release tag must exactly match `manifest.json`, for example `0.1.0` (not `v0.1.0`). The release workflow builds from the tagged source and uploads `main.js`, `manifest.json` and `styles.css` separately.

Directory submission is through [Obsidian Community](https://community.obsidian.md), following the [official submission guide](https://docs.obsidian.md/plugins/releasing/submit-plugin). It requires the publisher's Obsidian/GitHub account connection and directory review. No submission is implied by this repository.

## License

MIT. Bundled dependency notices are included in `main.js`.
