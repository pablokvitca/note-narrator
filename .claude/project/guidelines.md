# Stable review overrides: Note Narrator

Overrides and additions for the shared `review-for-stable-release` skill (`obsidian-plugin-standards/skills/review-for-stable-release/guidelines.md`). Numbers refer to the shared list; format in `obsidian-plugin-standards/docs/project-profile.md`. Ticket ids of the form `OBS-N` below come from the retired tracker; look up the matching `OBNN` task if one was migrated.

## Repo facts

Verify they still hold. Plugin id `note-narrator`; TypeScript in `src/` (folders `ui/`, `settings/`, `text/`, `engine/`, `tts/`), tests in `tests/` mirroring `src/`; bundled by `esbuild.config.mjs` into `main.js` (externals: `obsidian`, `electron`, `@codemirror/*`, `@lezer/*`, Node builtins); `isDesktopOnly: false`; settings UI in `src/settings/` (`setting-tab.ts` plus one file per tab in `sections/`; Obsidian 1.13 declarative API, custom tab bar); panel view `src/ui/player-view.ts`; engine `src/engine/reader.ts`; CodeMirror extension `src/ui/highlight-extension.ts`; the only network calls are `requestUrl` to the text to speech providers in `src/tts/`.

**Stale, check first:** the former checklist said the only network calls were `requestUrl` to `api.elevenlabs.io` in `src/tts/elevenlabs-provider.ts`. The code now has four providers (ElevenLabs, OpenAI, Google Gemini, Amazon Polly: `src/tts/*-provider.ts`, `aws-sigv4.ts`, `request.ts`). Every note below that names ElevenLabs applies to each provider.

## Overrides

- **G03** Note: the plugin's own interface is the settings tab and the panel; also inventory the toolbar action.
- **G04** Note: the only outbound requests go to the user's chosen TTS provider; nothing on load or timers; nothing sent beyond what synthesis needs.
- **G06** Note: full use needs payment to a third party (ElevenLabs credits, and the other providers' charges). The README must state it clearly and attribute the charge correctly; the manifest description must not contradict.
- **G07** Note: needs a provider account and API key, stored in secret storage. The README states it prominently, before install, and says how the key is stored.
- **G08** Note: no README claim such as "only when you trigger a read" that the code contradicts; the README says internet is required. Compare with the README Disclosures section.
- **G09** Note: check the custom save folder setting.
- **G10** Note: user-visible strings include the panel.
- **G11** Note: note the third-party provider processing separately and whether the README links each provider's privacy policy and terms.
- **G12** Note: the README mentions the provider dependency (ElevenLabs and the others).
- **G14** Note: shipped third-party assets include the Lucide-derived icon geometry in `src/ui/icons.ts`.
- **G15** Note: old names ("Obsidian Reader") must be gone from published artifacts.
- **G16** Note: history starts from the official sample plugin scaffolding only.
- **G18** Note: settings-definition properties such as `displayValue`/`status`/`search` are 1.13.1.
- **G22** Note: check how the user-typed heading-skip patterns are compiled and whether failures are surfaced (see OBS-155).
- **G23** Note: enumerate every `heading:` per tab and page (tree).
- **G25** Note: the ESLint rule misses helper-built labels like `createLabeledButton` and `ConfirmModal` arguments. Brands (ElevenLabs, Markdown, Note Narrator, Eleven model names, and the other providers' names) stay capitalised.
- **G27** Note: icon SVG passed to `addIcon` is built in `src/ui/icons.ts`.
- **G28** Note: resources include Audio and blob URLs, background generation jobs, toolbar buttons, body-appended popovers and tooltips, the editor extension. Known trouble spots: background jobs not cancelled on unload, touch tooltip (OBS-151).
- **G29** Note: scope is `src/main.ts` and `src/ui/player-view.ts`; the panel is opened via `activateView` reusing an existing leaf.
- **G30** Note: commands are registered in `src/main.ts` (`Read note aloud`, `Generate note audio in background`, `Stop reading`); ids must not contain `note-narrator`.
- **G31** Note: commands are registered in `src/main.ts`; the plugin ships no default hotkeys.
- **G32** Note: "Read note aloud" needs an active Markdown view: `checkCallback`, not `editorCallback`, so Reading view keeps working. See OBS-152.
- **G33** Note: check how the panel finds the active note while it has focus.
- **G34** Note: no fields, arrays or module variables hold `PlayerView` or leaves; the view unsubscribes from the long-lived `Reader` (via `registerEvent`).
- **G35** Note: write targets are notes, binary audio files and plugin data; no `Vault.modify` on Markdown notes, no `editor.setValue` rewrites.
- **G36** Note: background paths are auto-generate on open, background jobs and replace-existing-file; `modifyBinary` on the `.mp3` is expected: state race handling.
- **G37** Note: `stripFrontmatter` and `metadataCache` reads are read-only.
- **G38** Note: expected no `adapter` use at all.
- **G39** Note (standing waiver): `SavedAudio.isAnotherNotesAudio()` (`src/engine/saved-audio.ts`) scans `getMarkdownFiles()` to find whether another note shares a note's saved audio. It reads only the metadata cache and runs once per save or Clear (including saves started by Auto-generate on open), never per event, so it is accepted (OBS-240). It is skipped entirely when the "Protect audio shared with copied notes" setting is off, and disclosed in the README (OBS-241). Report it only if it moves into an event handler, starts reading files, or runs with that setting off.
- **G40** Note: paths are the custom folder, the composed audio path, the path read back from frontmatter and `parent.path`. Rejecting `..` is tracked separately (OBS-139).
- **G41** Note: the extension is `src/ui/highlight-extension.ts`; see OBS-156.
- **G44** Note: see OBS-154.
- **G45** Note: no note text or API keys in logged errors.
- **G46** Note: see OBS-144 and OBS-146.
- **G52** Note: immutable releases are enabled on this repository (a deleted release's tag name can never be reused). The stable workflow attaches `main.js`, `manifest.json`, `styles.css`, `LICENSE` and `THIRD_PARTY_NOTICES.md`.
- **G53** Note: the one known internal API use is `app.setting.closePage()` in `src/settings/section.ts` (`closeSettingsPage()`), feature-detected with a plain re-render fallback.
- **G54** Note: trace user or remote data (note names, profile names, voice and model names from the provider APIs, provider error text) into the DOM.
- **G55** Note: the user-typed heading-skip patterns are compiled at runtime; check that an invalid pattern is surfaced, not thrown (see OBS-155).
- **G59** Note: the repository is public, so the attestation step must run and succeed for the latest releases. Both workflows run it unguarded; that only becomes a breach if the repository is made private (see `release.md`).

## Mapping from this plugin's former copy

G01 to G52 keep their numbers. The former copy had no G53 onwards; the shared G53 to G57 and G59 now also apply. G58 is reserved and not run.
