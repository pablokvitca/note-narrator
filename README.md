# Obsidian Reader

An Obsidian plugin that reads your notes aloud using text-to-speech. MVP ships with [ElevenLabs](https://elevenlabs.io) as the only provider; the TTS layer (`src/tts/`) is a small interface so more providers can be added later without touching the reading logic.

## Features

- Two ways to trigger a read, both of which open the **Obsidian Reader** panel as a tab in the right sidebar: a ribbon icon in the left sidebar (always visible), and a speaker icon in each note's top-right action row (next to the "more options" `⋯` icon). A **Read note aloud** command does the same.
- The player view shows generation/playback progress (elapsed / total / remaining, the last adjusted for playback speed) and has icon **Rewind**, **Pause/Resume**, **Skip forward**, and **Stop** controls, plus a live **Playback speed** slider (0.5x–3x, showing the range and current value).
- **Skip amount** setting controls how many seconds Rewind/Skip forward jump by (default 15s).
- **Read selection instead of whole note** setting — when on, reading a note with an active text selection reads only the selection instead of the whole note.
- **Playback speed** setting (0.5x–3x), applied client-side on the audio player so it works with any TTS provider or voice.
- Long notes are automatically split into multiple requests (respecting each ElevenLabs model's character limit) and played back-to-back, rather than failing outright.
- Markdown syntax (headings, links, emphasis, code blocks, frontmatter, etc.) is stripped before sending text to the TTS provider so it isn't read aloud literally.
- **Voice** is a dropdown populated from your ElevenLabs account's voices (first 100), with a refresh button — no need to look up voice IDs manually.
- **Save generated audio to a file** setting (off by default) — saves each read as an `.mp3`, either in the same folder as the note or a configurable custom folder.
- **Link saved audio in the note** setting (off by default, requires saving audio) — writes a link to the saved audio into a configurable frontmatter property (default `reader-audio`), plus companion `<property>-hash` and `<property>-path` properties used internally. The player view shows whether that saved audio is still up to date with the note's current content, or outdated because the note changed since.
- **On regenerate** setting — when a note's audio already exists and is regenerated, either **Replace existing file** (default; overwrites it in place) or **Keep old versions** (creates a new file each time). Replace requires linking to be on, since that's what tracks which file to overwrite.
- **Auto-generate on open** setting (off by default, requires saving + linking) — silently (re)generates and saves a note's audio in the background when you open it, if missing or outdated, without playing it or interrupting anything currently playing.
- Saved audio filenames include the voice used, e.g. `My Note (Rachel).mp3`.
- Chunks are generated with one-chunk lookahead: the next part starts generating while the current one plays, so long notes usually play back-to-back without a gap waiting on the network.
- The player view also has its own **Voice** dropdown and, when nothing is playing, a **Read** button — so you can pick a voice and start a read without leaving the panel.

### Planned

- Highlighting/underlining the text in the note as it's read aloud.
- Additional TTS providers beyond ElevenLabs.

## Setup

1. Install the plugin (see below).
2. Open **Settings → Obsidian Reader** and add your ElevenLabs API key. It's stored via Obsidian's built-in [SecretStorage](https://docs.obsidian.md/plugins/guides/secret-storage), not in this plugin's own settings file — the setting only remembers which secret to look up, so the key can be shared with other plugins that use the same secret and never appears in `data.json`.
3. Pick a **Voice** from the dropdown (fetched from your ElevenLabs account) and a **Model** — Eleven v3 (research preview), Eleven Multilingual v2, or Eleven Flash v2.5.
4. Click the ribbon icon in the left sidebar, or the speaker icon at the top-right of a note (or run **Read note aloud** from the command palette). This opens the **Obsidian Reader** panel in the right sidebar with progress and playback controls.

## Known limitations (MVP)

- The player view, pause/resume/skip controls, voice dropdowns, save-to-file feature, on-regenerate versioning, auto-generate-on-open, and note-audio-link/staleness tracking have only been verified by type-checking, lint, and standalone logic tests, not by clicking through them in a running vault — the per-note action icon and ribbon icon are confirmed working.
- Staleness tracking hashes the note's full content (not just what was actually read, if you read a selection), so editing any part of the note will mark saved audio as outdated, even if the edit was outside the text that was actually read.
- When "Replace existing file" is on and the voice changes between regenerations, the file keeps its original filename (with the old voice's name in parentheses) rather than being renamed — only its contents are replaced.
- Auto-generate on open makes one or more ElevenLabs API calls (and consumes credits) every time you open a note whose saved audio is missing or outdated — be mindful of this on notes you edit frequently.
- The voice dropdown fetches only the first 100 voices from your ElevenLabs account (no pagination past that).
- Saving audio concatenates raw chunk bytes for multi-part reads rather than properly re-muxing the MP3 stream; this works in practice for ElevenLabs' output but isn't a fully spec-correct MP3 concatenation.
- Eleven v3 is ElevenLabs' own "research preview" model — it can be more expressive but also more prone to hallucinated/mispronounced output than Multilingual v2, and their Professional Voice Clones aren't fully optimized for it yet.
- No scrubbing to an arbitrary point — only relative rewind/skip by the configured skip amount.
- Requires an ElevenLabs account and API key; this plugin makes network requests to `api.elevenlabs.io` only when you trigger a read.
- Settings use the classic `display()`-based settings tab, not Obsidian 1.13's declarative settings API, so this plugin's settings won't appear in Obsidian's in-app settings search on 1.13.0+ (you can still find them normally under **Settings → Obsidian Reader**).

## Development

- `npm i` to install dependencies.
- `npm run dev` to compile in watch mode.
- `npm run build` to type-check and produce a production `main.js`.
- `npm run lint` to run ESLint.

## Manually installing the plugin

Copy `main.js`, `manifest.json` to `VaultFolder/.obsidian/plugins/obsidian-reader/`, then enable it in Obsidian's Community Plugins settings (this plugin is not published to the community plugin store).

Requires Obsidian 1.11.4+ (for the SecretStorage API).
