# Obsidian community plugin guidelines checklist

52 guidelines, one entry each. The review skill launches one read-only subagent per entry that applies.

**Entry format**
- **Guideline:** the rule (Obsidian's wording, condensed).
- **Scope:** `always` (run on every stable release review) or a list of globs. An entry with globs runs only when the diff between the last stable and the new stable touches a matching path; otherwise it is recorded as "Not affected by this diff".
- **Check:** what the reviewer must establish, with repo-specific hints.

**Repo facts the checks assume** (verify they still hold): plugin id `note-narrator`; TypeScript in `src/` (folders `ui/`, `settings/`, `text/`, `engine/`, `tts/`), tests in `tests/` mirroring `src/`; bundled by `esbuild.config.mjs` into `main.js` (externals: `obsidian`, `electron`, `@codemirror/*`, `@lezer/*`, Node builtins); `isDesktopOnly: false`; settings UI in `src/settings/` (`setting-tab.ts` plus one file per tab in `sections/`; Obsidian 1.13 declarative API, custom tab bar); panel view `src/ui/player-view.ts`; engine `src/engine/reader.ts`; CodeMirror extension `src/ui/highlight-extension.ts`; the only network calls are `requestUrl` to `api.elevenlabs.io` in `src/tts/elevenlabs-provider.ts`.

Where a check says "report facts", the reviewer must not soften or invent findings, and must cite `file:line`.

---

## A. Not allowed

### G01 No obfuscated code
- **Guideline:** Plugins must not obfuscate code to hide its purpose.
- **Scope:** `src/**`, `esbuild.config.mjs`, `package.json`, `.github/workflows/**`
- **Check:** production build only applies ordinary minification (`minify: prod`, no mangleProps/obfuscator/string encoding); readable source is in the repo and CI builds `main.js` from committed source; no `eval`, `new Function`, base64/encoded blobs, or convoluted control flow in `src/`.

### G02 No dynamic ads loaded over the internet
- **Guideline:** Plugins must not insert dynamic ads loaded over the internet.
- **Scope:** `src/**`, `styles.css`
- **Check:** list every network call and every remote resource (scripts, iframes, images, fonts, CSS `url()`/`@import`); confirm nothing can load or render third-party promotional content; no remote HTML or Markdown rendered.

### G03 No static ads outside the plugin's own interface
- **Guideline:** No static ads outside a plugin's own interface.
- **Scope:** `src/**`, `README.md`, `manifest.json`
- **Check:** inventory UI added outside the settings tab and panel (ribbon, toolbar action, commands, editor decorations, Notices, modals); none promotional (upsells, sponsor/referral links, donate or review prompts); `fundingUrl` state.

### G04 No client-side telemetry
- **Guideline:** No client-side telemetry.
- **Scope:** `src/**`, `package.json`
- **Check:** list every outbound request (host, trigger, data sent); only the user's chosen TTS provider; nothing on load or timers; no analytics/crash SDKs; no usage data, identifiers, vault contents or settings sent beyond what synthesis needs.

### G05 No self install or update
- **Guideline:** Plugins must not install or update themselves or their dependencies.
- **Scope:** `src/**`, `package.json`, `esbuild.config.mjs`
- **Check:** no runtime download/eval of code, no writes to plugin folders or other plugins, no update checks, no `app.plugins` install/enable APIs; all dependencies bundled at build time (`package.json` has no runtime `dependencies` or each is bundled).

## B. Disclosures (allowed only if clearly indicated in the README)

### G06 Payment required
- **Guideline:** Disclose if payment is required for full access.
- **Scope:** always
- **Check:** does full use need payment (author or third party, e.g. ElevenLabs credits)? README states it clearly and attributes the charge correctly; manifest description does not contradict.

### G07 Account required
- **Guideline:** Disclose if an account is required for full access.
- **Scope:** always
- **Check:** trace what the plugin needs (ElevenLabs account and API key, stored in secret storage); README states it prominently, before install, and says how the key is stored.

### G08 Network use
- **Guideline:** Clearly explain which remote services are used and why.
- **Scope:** always
- **Check:** build ground truth from `src/` (every request: host, method, headers, body, trigger, gating setting, retries, background jobs); compare with the README Disclosures section for accuracy and completeness (no claim like "only when you trigger a read" that the code contradicts; says internet is required).

### G09 Files outside the vault
- **Guideline:** Disclose and justify access to files outside Obsidian vaults.
- **Scope:** `src/**`, `README.md`
- **Check:** every file API use (`vault.*`, `fileManager.*`, `adapter`, Node fs, Electron, absolute paths); does anything read or write outside the vault, including via the custom save folder setting; README claims about file access match the code.

### G10 Static ads in own interface
- **Guideline:** Static ads such as banners and pop-ups in the plugin's own interface must be disclosed.
- **Scope:** `src/**`, `README.md`, `styles.css`
- **Check:** grep all user-visible strings (settings, panel, modals, Notices, tooltips) for promotional language; `fundingUrl`; README says "no ads" only if true.

### G11 Server-side telemetry
- **Guideline:** Disclose server-side telemetry and link a privacy policy.
- **Scope:** always
- **Check:** does the author (or plugin) operate or send data to any server of their own or an analytics endpoint? Note the third-party ElevenLabs processing separately and whether README links ElevenLabs' privacy policy and terms.

### G12 Closed-source code
- **Guideline:** Closed-source code is disclosed and handled case by case.
- **Scope:** always
- **Check:** is the GitHub repo public? (`gh repo view pablokvitca/note-narrator --json visibility`); open license; full source for what ships in `main.js`; CI builds releases from tags; README links to the source and mentions the ElevenLabs dependency. A private repo is an Urgent blocker for submission.

## C. Copyright and licensing

### G13 LICENSE file
- **Guideline:** Include a LICENSE file and clearly indicate the license.
- **Scope:** always
- **Check:** root `LICENSE` is a full recognised license with correct holder and year; `package.json` license is a valid SPDX id and matches; README license section; consistent everywhere.

### G14 Comply with original licenses and attribute
- **Guideline:** Comply with the original licenses of any code the plugin uses, including README attribution if required.
- **Scope:** `src/**`, `styles.css`, `package.json`, `THIRD_PARTY_NOTICES.md`, `README.md`
- **Check:** what third-party code or assets ship in `main.js`/`styles.css` (bundled deps, copied or derived code, Lucide-derived icon geometry in `src/ui/icons.ts`); required notices present in `THIRD_PARTY_NOTICES.md` and linked from the README.

### G15 Respect Obsidian's trademark policy
- **Guideline:** Don't use the "Obsidian" trademark in a way that could confuse users into thinking the plugin is first-party.
- **Scope:** `manifest.json`, `README.md`, `package.json`, `src/**`, `styles.css`
- **Check:** name, id, description, repo name and branding contain no "Obsidian" as part of the product name and no lookalike logo; all uses are descriptive; non-affiliation disclaimer present; old names ("Obsidian Reader") gone from published artifacts.

## D. Forks

### G16 Not a fork, no inherited code
- **Guideline:** Forks are not allowed in the directory without the original author's approval; inherit no code from another plugin without permission.
- **Scope:** always
- **Check:** `gh repo view` `isFork`/`parent`; history starts from the official sample plugin scaffolding only; no code, headers or README text copied from another plugin. (Overlap with other plugins is only encouragement, report as a caveat.)

## E. Manifest

### G17 fundingUrl only for real support links
- **Guideline:** Only use `fundingUrl` to link to financial support services; remove it if you don't accept donations.
- **Scope:** `manifest.json`, `package.json`, `.github/**`, `README.md`
- **Check:** `fundingUrl` present or not, and if present points at Buy Me a Coffee/GitHub Sponsors-type services; no contradicting donation text.

### G18 Appropriate minAppVersion
- **Guideline:** `minAppVersion` must be the minimum Obsidian version the plugin is compatible with (or the latest stable if unknown).
- **Scope:** always
- **Check:** compare `manifest.json` and `versions.json` against the highest `@since` tag in `node_modules/obsidian/obsidian.d.ts` of every Obsidian API and property used (settings-definition properties such as `displayValue`/`status`/`search` are 1.13.1); report too low or needlessly high.

### G19 Short, simple description
- **Guideline:** Description: action statement, max 250 characters, ends with a period, no emoji or special characters, correct capitalisation of proper nouns, follows the Obsidian style guide; do not start with "This is a plugin".
- **Scope:** `manifest.json`, `package.json`
- **Check:** count characters exactly; period; verb start; no emoji/special characters; consistent across manifest, `package.json`, README opening and the GitHub repo description.

### G20 isDesktopOnly matches API use
- **Guideline:** Node.js and Electron APIs only work on desktop; if used, `isDesktopOnly` must be true.
- **Scope:** `src/**`, `package.json`, `esbuild.config.mjs`, `manifest.json`
- **Check:** `manifest.json` `isDesktopOnly`; no Node builtins, `electron`, `process`, `Buffer`, `window.require`, `FileSystemAdapter` in `src/`; list what built `main.js` `require()`s.

## F. Mobile

### G21 Node and Electron APIs crash mobile
- **Guideline:** Calls to Node or Electron APIs by the plugin or its dependencies can crash mobile.
- **Scope:** `src/**`, `package.json`, `esbuild.config.mjs`
- **Check:** as G20 with emphasis on dependencies and the shipped bundle: runtime deps, bundle contents, `require()` list from `main.js`; note the stock esbuild config externalises Node builtins (latent risk if any bundled code imports one).

### G22 No regex lookbehind
- **Guideline:** Lookbehind in regular expressions is only supported on iOS 16.4+.
- **Scope:** `src/**`
- **Check:** list every regex literal and `new RegExp`; no `(?<=` or `(?<!` (and note named groups and newer regex flags); how the user-typed heading-skip patterns are compiled and whether failures are surfaced (see OBS-155); build `target` in `esbuild.config.mjs`.

## G. Settings tab and UI copy

### G23 Headings only when there is more than one section
- **Guideline:** Only use headings under settings if you have more than one section; avoid a top-level heading such as "General", "Settings" or the plugin name; keep general settings at the top without a heading (see Settings, Appearance).
- **Scope:** `src/settings/**`
- **Check:** enumerate every `heading:` per tab and page (tree); flag headings over a tab's only section, headings repeating the tab or plugin name, and a missing headingless general group.

### G24 No "settings" in headings
- **Guideline:** Avoid the word "settings" in settings headings.
- **Scope:** `src/settings/**`
- **Check:** list every heading, page title and tab label; flag any containing "settings" (and near-synonyms as borderline).

### G25 Sentence case in UI
- **Guideline:** All UI text in sentence case; only the first word and proper nouns capitalised.
- **Scope:** `src/**`, `styles.css`
- **Check:** exhaustive manual pass over every user-visible string (settings names, descriptions, dropdown options, buttons, tooltips, panel labels, menu items, command names, Notices, modal titles and buttons), independent of the ESLint rule (which only warns and misses helper-built labels like `createLabeledButton` and `ConfirmModal` arguments). Brands (ElevenLabs, Markdown, Note Narrator, Eleven model names) stay capitalised. Also flag descriptions quoting stale label names.

### G26 Use setHeading, not HTML headings
- **Guideline:** Use `setHeading` (or the declarative `heading`) instead of `<h1>`/`<h2>`.
- **Scope:** `src/**`, `styles.css`
- **Check:** no `createEl('h1'..'h6')`, `<h1..6>` strings, or fake headings; settings section titles come from Obsidian's heading mechanism.

## H. Security and resource management

### G27 No innerHTML, outerHTML or insertAdjacentHTML
- **Guideline:** Build DOM with the DOM API or `createEl`/`createDiv`/`createSpan`; clean up with `el.empty()`.
- **Scope:** `src/**`
- **Check:** grep for `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `srcdoc`, `DOMParser`, `createContextualFragment`, `MarkdownRenderer`; trace user or remote data (note names, profile names, voice names from the API, error text) into the DOM; SVG strings passed to `addIcon` must contain only static markup and trusted numbers.

### G28 Clean up resources on unload
- **Guideline:** Anything the plugin creates (listeners, timers, DOM) must be released when it unloads; prefer `registerEvent`, `registerDomEvent`, `registerInterval`, `addCommand`.
- **Scope:** `src/**`
- **Check:** table of each resource (Obsidian events, DOM listeners on `document`/`window`, timers, Audio and blob URLs, background generation jobs, toolbar buttons, body-appended popovers and tooltips, editor extension) with how it is released; read `onunload` and every `onClose`/`destroy`. Known trouble spots: background jobs not cancelled on unload, touch tooltip (OBS-151).

### G29 Don't detach leaves in onunload
- **Guideline:** Do not detach leaves in `onunload`; Obsidian restores them in place after an update.
- **Scope:** `src/main.ts`, `src/ui/player-view.ts`
- **Check:** full body of `onunload`; no `detachLeavesOfType`/`.detach()`; panel opened via `activateView` reusing an existing leaf.

## I. Commands

### G30 No plugin id in command ids
- **Guideline:** Obsidian prefixes command ids with the plugin id; don't include it.
- **Scope:** `src/main.ts`
- **Check:** every `addCommand` id and name (id must not contain `note-narrator`; names shouldn't start with "Note Narrator:"); docs list the palette names correctly.

### G31 No default hotkeys
- **Guideline:** Avoid setting a default hotkey for commands.
- **Scope:** `src/main.ts`
- **Check:** no `hotkeys:` in any `addCommand`; no global keyboard registration (`scope.register`, document keydown acting as a shortcut); docs claim no built-in defaults.

### G32 Correct command callback type
- **Guideline:** `callback` for unconditional commands; `checkCallback` for conditional; `editorCallback`/`editorCheckCallback` if an active Markdown editor is required.
- **Scope:** `src/main.ts`
- **Check:** each command's callback type versus what it needs (e.g. "Read note aloud" needs an active Markdown view: `checkCallback`, not `editorCallback`, so Reading view keeps working). See OBS-152.

## J. Workspace

### G33 Don't access workspace.activeLeaf
- **Guideline:** Use `getActiveViewOfType()` (or `activeEditor`) instead of `workspace.activeLeaf`.
- **Scope:** `src/**`
- **Check:** grep for `activeLeaf`, `getActiveLeaf`, `getMostRecentLeaf`; how the panel finds the active note while it has focus.

### G34 Don't manage references to custom views
- **Guideline:** `registerView(TYPE, () => new View())`, no stored view instances; reach views via `getLeavesOfType`.
- **Scope:** `src/main.ts`, `src/ui/player-view.ts`
- **Check:** the `registerView` factory only returns a new view; no fields, arrays or module variables hold `PlayerView` or leaves; the view unsubscribes from the long-lived `Reader` (via `registerEvent`).

## K. Vault

### G35 Editor API over Vault.modify for the active file
- **Guideline:** Edit the active note through the Editor, not `Vault.modify`.
- **Scope:** `src/**`
- **Check:** table of every write API and its target (note vs binary audio vs plugin data); no `Vault.modify` on Markdown notes, no `editor.setValue` rewrites.

### G36 Vault.process over Vault.modify for background edits
- **Guideline:** Use `Vault.process` to modify a closed note atomically.
- **Scope:** `src/**`
- **Check:** as G35 with focus on background paths (auto-generate on open, background jobs, replace-existing-file); `Vault.process` is text-only, so `modifyBinary` on the `.mp3` is expected: state race handling.

### G37 processFrontMatter for frontmatter edits
- **Guideline:** Modify frontmatter with `FileManager.processFrontMatter`.
- **Scope:** `src/**`
- **Check:** every frontmatter write goes through it with a synchronous callback that mutates in place; no manual YAML parsing that is written back; `stripFrontmatter` and `metadataCache` reads are read-only.

### G38 Vault API over Adapter API
- **Guideline:** Prefer the Vault API to `app.vault.adapter`.
- **Scope:** `src/**`
- **Check:** no `adapter`, `FileSystemAdapter`, `getResourcePath`, Node fs; table of file operations and API used; notes read with `cachedRead`.

### G39 Don't iterate all files to find one by path
- **Guideline:** Use `getFileByPath`/`getFolderByPath`/`getAbstractFileByPath`, not `getFiles().find(...)`.
- **Scope:** `src/**`
- **Check:** no `getFiles`, `getMarkdownFiles`, `getAllLoadedFiles`, link-graph scans; event handlers scale with open tabs, not vault size.

### G40 normalizePath for user-defined paths
- **Guideline:** Use `normalizePath()` for user-defined and constructed vault paths.
- **Scope:** `src/**`
- **Check:** table of each path (custom folder, composed audio path, path read back from frontmatter, `parent.path`) and whether `normalizePath` is applied; root-folder edge cases. Rejecting `..` is tracked separately (OBS-139).

## L. Editor

### G41 Reconfigure editor extensions correctly
- **Guideline:** To change a registered editor extension use a stable array plus `workspace.updateOptions()`.
- **Scope:** `src/ui/highlight-extension.ts`, `src/main.ts`, `src/settings/**`
- **Check:** what is decided at creation versus at render time; whether the extension array is ever replaced; how settings changes reach open editors (see OBS-156).

## M. Styling

### G42 No hardcoded styling
- **Guideline:** Use CSS classes and Obsidian CSS variables, not `el.style.*` for presentation.
- **Scope:** `src/**`, `styles.css`
- **Check:** every inline style and `setCssStyles`/`setCssProps` call (dynamic geometry is acceptable, static presentation is not); `styles.css`: hardcoded colours outside `var()` fallbacks, `!important`, unscoped selectors that leak into Obsidian or other plugins; icons use `currentColor`.

## N. TypeScript

### G43 const and let, not var
- **Guideline:** Prefer `const` and `let` over `var`.
- **Scope:** `src/**`, `*.mjs`, `*.mts`
- **Check:** zero `var` declarations; ESLint `no-var` in effect.

### G44 async/await over promise chains
- **Guideline:** Prefer async/await over `.then` chains.
- **Scope:** `src/**`
- **Check:** every `.then(`, `.catch(`, `new Promise`, `Promise.*`: classify as chain (breach candidate), fire-and-forget `void`, event wrapper (fine), concurrency (fine). See OBS-154.

## O. Code hygiene

### G45 No unnecessary console logging
- **Guideline:** By default the developer console should only show errors.
- **Scope:** `src/**`, `esbuild.config.mjs`
- **Check:** every `console.*` call with level and trigger; only `console.error` in genuine error paths; nothing prints in normal operation; no note text or API keys in logged errors; note whether the build drops console.

### G46 Organise code into folders
- **Guideline:** Consider organising files into folders.
- **Scope:** `src/**`, `tsconfig.json`
- **Check:** layout, oversized files, tests location (advisory: "consider"). See OBS-144 and OBS-146.

### G47 No sample plugin code left
- **Guideline:** Remove all sample plugin code.
- **Scope:** `src/**`, `styles.css`, `manifest.json`
- **Check:** none of the sample plugin's ribbon, status bar, modal, sample commands, `registerInterval`, sample settings or "Sample Plugin" text; state what actually ships (`main.js`, `manifest.json`, `styles.css`) versus developer docs.

### G48 Avoid the global app instance
- **Guideline:** Use `this.app`, not the global `app` or `window.app`.
- **Scope:** `src/**`
- **Check:** every `app` reference originates from `this.app` of the Plugin/View/Tab/Modal or a parameter passed down from one.

### G49 Rename placeholder class names
- **Guideline:** Rename `MyPlugin`, `MyPluginSettings`, `SampleSettingTab` and similar.
- **Scope:** `src/**`, `manifest.json`, `package.json`
- **Check:** list every class, interface, type and exported constant; none is a sample placeholder; ids, view types, icon ids and CSS prefixes use the plugin's name.

## P. Repository requirements and release format

### G50 README that describes the purpose and use of the plugin
- **Guideline:** A `README.md` that describes the purpose of the plugin and how to use it. An excerpt is shown on the public listing page, with relative links and images (for example `./images/screenshot.png`) automatically rewritten to resolve against the repository.
- **Scope:** `README.md`, `docs/**`, `images/**`
- **Check:** purpose and usage are described (install, quick start, features); the top of the README (the listing excerpt) states the purpose immediately and doesn't depend on GitHub-only rendering (alert blockquotes `> [!IMPORTANT]`, badges, HTML); list every relative link and image with its target, whether the target exists at that path, and that it resolves against the repository; unfinished placeholder text ("link to be added", screenshot placeholders, TODOs) is acceptable for a public listing only if intended; features and command or label names are accurate versus the code.

### G51 manifest.json describes the plugin and uses x.y.z versions
- **Guideline:** A `manifest.json` that describes your plugin; `version` follows Semantic Versioning in the format `x.y.z` only.
- **Scope:** always
- **Check:** valid JSON with `id`, `name`, `version`, `minAppVersion`, `description`, `author`, `isDesktopOnly` (correct types); `version` is strictly `x.y.z` (no `v` prefix, no `-beta.N` suffix; the beta workflow must not write suffixes into the manifest); `id` never changed since the first published release, lowercase, no "obsidian", matches the install folder in the README and `package.json` name; `versions.json` valid, contains the new version, consistent with `minAppVersion`.

### G52 GitHub release format
- **Guideline:** Create a GitHub release whose tag matches `manifest.json`'s version exactly; upload `main.js`, `manifest.json` and (optionally) `styles.css` as binary attachments; the release name and description are free-form; versions only in `x.y.z`.
- **Scope:** `.github/workflows/**`, `version-bump.mjs`, `manifest.json`, `versions.json`, `.claude/skills/release/**`
- **Check:** the stable workflow triggers on `x.y.z` tags without a `v`, verifies tag equals manifest version, builds from source, attaches at least `main.js`, `manifest.json` and `styles.css` as individual assets (plus `LICENSE` and `THIRD_PARTY_NOTICES.md`), creates a stable (not pre-release, not draft) release for plain versions and a pre-release for suffixed ones; the previous stable releases actually have those assets (`gh release view <tag> --json assets`); the stable procedure in the `release` skill (`.claude/skills/release/stable.md`) produces this. Note the repository uses immutable releases (a deleted release's tag name can never be reused).
