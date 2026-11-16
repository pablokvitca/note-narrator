# Project profile: Note Narrator

Read by the shared skills in `obsidian-plugin-standards`. Keep it factual and current. See `obsidian-plugin-standards/docs/project-profile.md` for what each field means.

| Field | Value |
| --- | --- |
| Plugin name | Note Narrator |
| Plugin id | `note-narrator` |
| Repository | `pablokvitca/note-narrator` |
| Visibility | public |
| Test vault folder | `note-narrator-test-vault` |
| Test vault repository | `pablokvitca/note-narrator-test-vault` |
| Kaneo project | Obsidian Plugin: Note Narrator |
| Ticket key | `OBNN` |
| Current version line | `release/1.2` (patches; last stable `1.2.1`, manifest at `1.2.2`). No next minor line is cut yet. A remote `next/1.2` still exists although `1.2.0` shipped (its tip is already in `main`): ask the owner before using or deleting it. |
| Integration branch | none |
| Patch lines | `release/1.2` (current); older lines `release/0.10` to `release/0.17`, `release/1.0`, `release/1.1` (and `release/1.1-stack`) |
| Platforms | macOS, iPhone, iPad, iPad mini, visionOS; Windows, Linux, Android (optional: the owner may waive them when no device is available) |

## Docs to update at a stable release

- `README.md`
- Docs site (`pk-plugins-docs`, local folder `note-narrator-docs`), section `Note Narrator`: affected pages, their `plugin-version` and `updated` frontmatter, Known limitations, the Roadmap, screenshots
- `THIRD_PARTY_NOTICES.md` when bundled or derived code changed
- No changelog file in this repository

## Release checklist tasks

- `1.2.2`: not created yet.
- Last one: `OBNN-231` Release Stable 1.2.1, subtasks `OBNN-232` to `OBNN-236` (`OBNN-236`, the community directory subtask, was still `to-do`).

## Specifics for reviewers

- Internal Obsidian APIs: `app.setting.closePage()` (the settings modal) in `src/settings/section.ts` `closeSettingsPage()`, feature-detected, with a plain re-render as the fallback. No other internal API found.
- Bundled runtime dependencies: none (no `dependencies` in `package.json`; Lucide-derived icon geometry in `src/ui/icons.ts`)
- Writes user data: saves generated audio (`.mp3`, or `.wav` with Google Gemini) in the vault next to the note or in a custom folder, links it from the note's frontmatter, can replace an existing audio file; settings in `data.json`; API keys in Obsidian's secret storage
- Network use: `requestUrl` to the text to speech provider the user configured (ElevenLabs, OpenAI, Google Gemini or Amazon Polly; `src/tts/`), only for synthesis and model or voice lists; requires an account and API key, which the provider charges for
