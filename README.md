# Obsidian Reader

An Obsidian plugin that reads your notes aloud using text-to-speech. MVP ships with [ElevenLabs](https://elevenlabs.io) as the only provider; the TTS layer (`src/tts/`) is a small interface so more providers can be added later without touching the reading logic.

## Features

- A ribbon (toolbar) button and a **Read note aloud** command that read the active note's text.
- **Read selection instead of whole note** setting — when on, reading a note with an active text selection reads only the selection instead of the whole note.
- A **Stop reading** command to interrupt playback.
- **Playback speed** setting (0.5x–2x), applied client-side on the audio player so it works with any TTS provider or voice.
- Markdown syntax (headings, links, emphasis, code blocks, frontmatter, etc.) is stripped before sending text to the TTS provider so it isn't read aloud literally.

### Planned

- Highlighting/underlining the text in the note as it's read aloud.
- Additional TTS providers beyond ElevenLabs.

## Setup

1. Install the plugin (see below).
2. Open **Settings → Obsidian Reader** and add your ElevenLabs API key. It's stored via Obsidian's built-in [SecretStorage](https://docs.obsidian.md/plugins/guides/secret-storage), not in this plugin's own settings file — the setting only remembers which secret to look up, so the key can be shared with other plugins that use the same secret and never appears in `data.json`.
3. Set a **Voice ID** (find one in your ElevenLabs voice library) and pick a **Model** — Eleven v3 (research preview), Eleven Multilingual v2, or Eleven Flash v2.5.
4. Click the ribbon icon, or run **Read note aloud** from the command palette.

## Known limitations (MVP)

- No chunking: very long notes may exceed ElevenLabs' per-request character limits for your plan/model (e.g. Eleven v3 caps requests at 5,000 characters, versus 10,000 for Eleven Multilingual v2).
- Eleven v3 is ElevenLabs' own "research preview" model — it can be more expressive but also more prone to hallucinated/mispronounced output than Multilingual v2, and their Professional Voice Clones aren't fully optimized for it yet.
- No playback controls beyond stop (no pause/resume, no scrubbing).
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
