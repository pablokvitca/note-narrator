# Obsidian community plugin

## Project overview

- Target: Obsidian Community Plugin (TypeScript → bundled JavaScript).
- Entry point: `src/main.ts` compiled to `main.js` and loaded by Obsidian.
- Required release artifacts: `main.js`, `manifest.json`, and optional `styles.css`.

## Environment & tooling

- Node.js: use current LTS (Node 18+ recommended).
- **Package manager: npm** (required for this sample - `package.json` defines npm scripts and dependencies).
- **Bundler: esbuild** (required for this sample - `esbuild.config.mjs` and build scripts depend on it). Alternative bundlers like Rollup or webpack are acceptable for other projects if they bundle all external dependencies into `main.js`.
- Types: `obsidian` type definitions.

**Note**: This sample project has specific technical dependencies on npm and esbuild. If you're creating a plugin from scratch, you can choose different tools, but you'll need to replace the build configuration accordingly.

### Install

```bash
npm install
```

### Dev (watch)

```bash
npm run dev
```

### Production build

```bash
npm run build
```

## Linting

- ESLint is preconfigured with `eslint-plugin-obsidianmd` for Obsidian-specific rules.
- Run `npm run lint` to lint the project.
- A GitHub Action automatically lints every commit on all branches.

## File & folder conventions

- **Organize code into multiple files**: Split functionality across separate modules rather than putting everything in `main.ts`.
- Source lives in `src/`. Keep `main.ts` small and focused on plugin lifecycle (loading, unloading, registering commands).
- **Example file structure**:
    ```
    src/
      main.ts           # Plugin entry point, lifecycle management
      settings.ts       # Settings interface and defaults
      commands/         # Command implementations
        command1.ts
        command2.ts
      ui/              # UI components, modals, views
        modal.ts
        view.ts
      utils/           # Utility functions, helpers
        helpers.ts
        constants.ts
      types.ts         # TypeScript interfaces and types
    ```
- **Do not commit build artifacts**: Never commit `node_modules/`, `main.js`, or other generated files to version control.
- Keep the plugin small. Avoid large dependencies. Prefer browser-compatible packages.
- Generated output should be placed at the plugin root or `dist/` depending on your build setup. Release artifacts must end up at the top level of the plugin folder in the vault (`main.js`, `manifest.json`, `styles.css`).

## Manifest rules (`manifest.json`)

- Must include (non-exhaustive):
    - `id` (plugin ID; for local dev it should match the folder name)
    - `name`
    - `version` (Semantic Versioning `x.y.z`)
    - `minAppVersion`
    - `description`
    - `isDesktopOnly` (boolean)
    - Optional: `author`, `authorUrl`, `fundingUrl` (string or map)
- Never change `id` after release. Treat it as stable API.
- Keep `minAppVersion` accurate when using newer APIs.
- Canonical requirements are coded here: https://github.com/obsidianmd/obsidian-releases/blob/master/.github/workflows/validate-plugin-entry.yml

## Testing

- Manual install for testing: copy `main.js`, `manifest.json`, `styles.css` (if any) to:
    ```
    <Vault>/.obsidian/plugins/<plugin-id>/
    ```
- Reload Obsidian and enable the plugin in **Settings → Community plugins**.

## Commands & settings

- Any user-facing commands should be added via `this.addCommand(...)`.
- If the plugin has configuration, provide a settings tab and sensible defaults.
- Persist settings using `this.loadData()` / `this.saveData()`.
- Use stable command IDs; avoid renaming once released.

## Versioning & releases

This repo uses a `next/X.Y` → `release/X.Y` branching model with fully automated beta builds on every push. Follow this exactly — skipping the immediate version bump (below) is a real, easy-to-hit mistake that has actually happened in this repo.

### Branching model

- `main` always reflects the latest **released stable** version. Nothing merges into it except a fast-forward to a tracking branch's tip at release time — never a regular merge commit.
- Feature work for an upcoming minor version happens on `next/X.Y` (e.g. `next/0.14`), branched off `main`.
- Once `X.Y.0` ships, `next/X.Y` is renamed to `release/X.Y` and becomes where patches for that line land directly (`X.Y.1`, `X.Y.2`, ...).
- A new `next/X.(Y+1)` (or `next/(X+1).0`) branch is cut from `main` once the next minor's feature work starts.
- If a later `next/X.(Y+1)` branch already exists when an earlier line ships a release, merge the released branch into it afterward (`git merge release/X.Y`) so it inherits the release commit — otherwise its own eventual release won't be a valid fast-forward of the new `main`.

### The rule that's easy to miss: bump the version immediately, on every tracking branch, every time

**As the first commit whenever you start work on a `next/X.Y` branch, and again as the first commit of *any* fix/feature that lands on a `release/X.Y` branch (a patch), bump `manifest.json`'s `version` to the target version (`X.Y.0` for a new minor, `X.Y.(Z+1)` for a patch) before pushing anything else.** This applies equally to patch branches, not just new minors — that's the part that's easy to forget.

Why: every push to a `next/**` or `release/**` branch auto-publishes a beta tagged `<manifest version>-beta.N` (see below). SemVer ranks a prerelease *below* its base version once that version has shipped — `0.14.0-beta.51` sorts below the real, already-released `0.14.0`. Push a fix to `release/0.14` without first bumping `manifest.json` to `0.14.1`, and the resulting beta tag is `0.14.0-beta.N` — BRAT considers that older than the shipped `0.14.0` and silently keeps serving the old stable build instead of surfacing the fix at all. Concretely: `manifest.json`'s version must equal the version you intend to ship next, at all times while a tracking branch has unreleased commits.

### Beta builds — automatic, do nothing extra

- Every push to a `next/**` or `release/**` branch triggers a workflow that builds the plugin and publishes a GitHub **pre-release** tagged `<manifest version>-beta.<run number>`.
- Each push supersedes (deletes) the previous beta release for that version line, so only the latest beta build for a given base version stays published.
- Never manually create a beta tag or release — just push commits (with the version already bumped per the rule above) and the beta appears within a minute or two. Verify it exists and is versioned as expected: `gh release list --repo <owner>/<repo> --limit 5 --json tagName,isPrerelease`.
- Testers install via [BRAT](https://github.com/TfTHacker/obsidian42-brat), adding this repo and enabling beta versions.

### Final (stable) release

Only do this when explicitly asked to release/ship — never on your own initiative, and never skip straight here without a beta having been tested first unless told to.

1. On the tracking branch (`next/X.Y` for a new minor, `release/X.Y` for a patch): working tree clean, `npm run build && npm run lint && npm test` all passing.
2. `npm version X.Y.Z -m "Release %s"` — bumps `package.json`, runs the `version` script (syncs `manifest.json`/adds a `versions.json` entry), commits everything as `Release X.Y.Z`, and creates git tag `X.Y.Z` (this repo's `.npmrc` sets `tag-version-prefix=""`, so no leading `v`).
3. `git push origin <branch> --follow-tags` — pushes the release commit and tag together. The tag push triggers the release workflow, which creates the **stable** GitHub release (verify: `gh release view X.Y.Z`).
4. Fast-forward `main`: `git checkout main && git merge --ff-only <branch> && git push origin main`. If a PR exists from this branch, GitHub auto-detects the fast-forward and marks it merged on its own.
5. Only for a new-minor release (not a patch): rename the branch for future patches — `git checkout <branch> && git branch -m next/X.Y release/X.Y && git push origin release/X.Y`. GitHub may auto-delete the old `next/X.Y` remote ref once its PR is detected merged; check `git ls-remote origin` before trying to delete it yourself.
6. Attach `manifest.json`, `main.js`, and `styles.css` as release assets — the release workflow does this automatically; don't do it by hand.
7. After the *first-ever* stable release, separately follow the process to add/update this plugin in the community plugin catalog, if applicable.

## Security, privacy, and compliance

Follow Obsidian's **Developer Policies** and **Plugin Guidelines**. In particular:

- Default to local/offline operation. Only make network requests when essential to the feature.
- No hidden telemetry. If you collect optional analytics or call third-party services, require explicit opt-in and document clearly in `README.md` and in settings.
- Never execute remote code, fetch and eval scripts, or auto-update plugin code outside of normal releases.
- Minimize scope: read/write only what's necessary inside the vault. Do not access files outside the vault.
- Clearly disclose any external services used, data sent, and risks.
- Respect user privacy. Do not collect vault contents, filenames, or personal information unless absolutely necessary and explicitly consented.
- Avoid deceptive patterns, ads, or spammy notifications.
- Register and clean up all DOM, app, and interval listeners using the provided `register*` helpers so the plugin unloads safely.

## UX & copy guidelines (for UI text, commands, settings)

- Prefer sentence case for headings, buttons, and titles.
- Use clear, action-oriented imperatives in step-by-step copy.
- Use **bold** to indicate literal UI labels. Prefer "select" for interactions.
- Use arrow notation for navigation: **Settings → Community plugins**.
- Keep in-app strings short, consistent, and free of jargon.

## Performance

- Keep startup light. Defer heavy work until needed.
- Avoid long-running tasks during `onload`; use lazy initialization.
- Batch disk access and avoid excessive vault scans.
- Debounce/throttle expensive operations in response to file system events.

## Coding conventions

- TypeScript with `"strict": true` preferred.
- **Keep `main.ts` minimal**: Focus only on plugin lifecycle (onload, onunload, addCommand calls). Delegate all feature logic to separate modules.
- **Split large files**: If any file exceeds ~200-300 lines, consider breaking it into smaller, focused modules.
- **Use clear module boundaries**: Each file should have a single, well-defined responsibility.
- Bundle everything into `main.js` (no unbundled runtime deps).
- Avoid Node/Electron APIs if you want mobile compatibility; set `isDesktopOnly` accordingly.
- Prefer `async/await` over promise chains; handle errors gracefully.

## Mobile

- Where feasible, test on iOS and Android.
- Don't assume desktop-only behavior unless `isDesktopOnly` is `true`.
- Avoid large in-memory structures; be mindful of memory and storage constraints.

## Agent do/don't

**Do**

- Add commands with stable IDs (don't rename once released).
- Provide defaults and validation in settings.
- Write idempotent code paths so reload/unload doesn't leak listeners or intervals.
- Use `this.register*` helpers for everything that needs cleanup.

**Don't**

- Introduce network calls without an obvious user-facing reason and documentation.
- Ship features that require cloud services without clear disclosure and explicit opt-in.
- Store or transmit vault contents unless essential and consented.

## Common tasks

### Organize code across multiple files

**main.ts** (minimal, lifecycle only):

```ts
import { Plugin } from 'obsidian';
import { MySettings, DEFAULT_SETTINGS } from './settings';
import { registerCommands } from './commands';

export default class MyPlugin extends Plugin {
	settings!: MySettings;

	async onload() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<MySettings>,
		);
		registerCommands(this);
	}
}
```

**settings.ts**:

```ts
export interface MySettings {
	enabled: boolean;
	apiKey: string;
}

export const DEFAULT_SETTINGS: MySettings = {
	enabled: true,
	apiKey: '',
};
```

**commands/index.ts**:

```ts
import { Plugin } from 'obsidian';
import { doSomething } from './my-command';

export function registerCommands(plugin: Plugin) {
	plugin.addCommand({
		id: 'do-something',
		name: 'Do something',
		callback: () => doSomething(plugin),
	});
}
```

### Add a command

```ts
this.addCommand({
	id: 'your-command-id',
	name: 'Do the thing',
	callback: () => this.doTheThing(),
});
```

### Persist settings

```ts
interface MySettings { enabled: boolean }
const DEFAULT_SETTINGS: MySettings = { enabled: true };

async onload() {
  this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<MySettings>);
  await this.saveData(this.settings);
}
```

### Register listeners safely

```ts
this.registerEvent(
	this.app.workspace.on('file-open', (f) => {
		/* ... */
	}),
);
this.registerDomEvent(activeWindow, 'resize', () => {
	/* ... */
});
this.registerInterval(
	window.setInterval(() => {
		/* ... */
	}, 1000),
);
```

## Troubleshooting

- Plugin doesn't load after build: ensure `main.js` and `manifest.json` are at the top level of the plugin folder under `<Vault>/.obsidian/plugins/<plugin-id>/`.
- Build issues: if `main.js` is missing, run `npm run build` or `npm run dev` to compile your TypeScript source code.
- Commands not appearing: verify `addCommand` runs after `onload` and IDs are unique.
- Settings not persisting: ensure `loadData`/`saveData` are awaited and you re-render the UI after changes.
- Mobile-only issues: confirm you're not using desktop-only APIs; check `isDesktopOnly` and adjust.

## References

- Obsidian sample plugin: https://github.com/obsidianmd/obsidian-sample-plugin
- API documentation: https://docs.obsidian.md
- Developer policies: https://docs.obsidian.md/Developer+policies
- Plugin guidelines: https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines
- Style guide: https://help.obsidian.md/style-guide
