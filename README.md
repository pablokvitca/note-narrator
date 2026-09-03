# Obsidian Reader

An Obsidian plugin that reads your notes aloud using text-to-speech. MVP ships with [ElevenLabs](https://elevenlabs.io) as the only provider; the TTS layer (`src/tts/`) is a small interface so more providers can be added later without touching the reading logic.

## Features

### Triggering a read

- The ribbon icon in the left sidebar (always visible) and the speaker icon in each note's top-right action row (next to the "more options" `⋯` icon) just open the **Obsidian Reader** panel in the right sidebar — they don't start generating audio by themselves.
- The panel itself has its own **Voice** dropdown and, when idle, a **Read** button, so you can pick a voice and explicitly start a read without leaving the panel.
- The **Read note aloud** command is the one exception: since it names the action explicitly, it opens the panel and starts reading immediately, without needing a click on the panel's Read button.
- If a note already has saved audio (see below), the panel shows **Play saved** (plays the existing file with no regeneration) alongside a **Read** button that relabels itself to **Regenerate** (note content changed since the audio was generated) or **Regenerate with new voice** (the selected voice differs from the one the saved audio used).
- **Read selection instead of whole note** setting — when on, reading a note with an active text selection reads only the selection instead of the whole note.
- **Read note title** (on by default) and **Read note properties** (off by default) settings — properties reads "Properties", each frontmatter key and value, then "Content", before the note's body. Neither applies when reading a selection.

### Playback

- Icon **Rewind**/**Skip forward** (seconds, amount configurable), **Pause/Resume**, and **Stop** controls, plus **Previous part**/**Next part** buttons for multi-chunk reads that jump immediately rather than waiting for the current part to finish.
- A live **Playback speed** slider (0.5x–3x, min/max and current value shown) that adjusts the current/next read without changing your configured default speed.
- Progress display: elapsed / total / remaining time (remaining divides by playback speed), a "Part X of Y · Z% complete" line, and a segmented bar showing which chunks have finished generating.

### Long notes and chunking

- Notes are split into TTS-request-sized chunks according to the **Text chunker** setting: **Markdown-aware** (default) splits by heading section first (up to a configurable **max heading depth**), then by sentence within each section; **Sentence-only** ignores headings and just packs sentences up to the character limit.
- **Start playback immediately** (on by default) begins playing as soon as the first chunk is ready instead of waiting for the whole note; **Quick start** (on by default, requires the above) makes that first chunk artificially short — including the title/properties preamble, if enabled — so it returns faster. **Quick start unit** picks whether that target size is in **Words** (default, 150) or **Characters** (default 750), each with its own size slider.
- **Generate chunks in parallel** (on by default, window of 2) lets more than one chunk generate at once instead of strictly one at a time; **Max parallel chunk generation** controls the window size. If ElevenLabs returns a 429 (rate limited), requests retry automatically with exponential backoff (up to 3 attempts), and generation falls back to sequential (one at a time) for the rest of that read to avoid repeating it.

### Saving audio to a file

- **Save generated audio to a file** setting (off by default) saves each read as an `.mp3`, in the note's folder or a configurable custom folder (created automatically if missing). The file is written as soon as *generation* finishes, not once playback finishes.
- **Link saved audio in the note** setting (off by default, requires saving) writes the audio's link, a content hash (for staleness), the raw file path (used internally), a generation timestamp, and the voice ID used, each into its own **individually configurable** frontmatter property (defaults: `reader_audio`, `reader_audio_hash`, `reader_audio_path`, `reader_audio_timestamp`, `reader_audio_voice`). The panel shows whether the saved audio is up to date or outdated.
- **On regenerate**: **Replace existing file** (default) overwrites the previously linked file in place; **Keep old versions** creates a new file each time instead.
- **Auto-generate on open** (off by default, requires saving + linking) silently (re)generates and saves a note's audio in the background when you open it, if missing or outdated — without playing it or touching anything currently playing.
- Saved filenames include the voice used, e.g. `My Note (Rachel).mp3`.
- A **⋮ menu** in the panel's own title bar (top-right) has a **Clear reader files** item (on by default, toggle to hide it) that deletes a note's linked audio file and removes all of the properties above, after a confirmation dialog.

### Voices

- **Voice** is a dropdown populated from your ElevenLabs account's voices (first 100), with a refresh button.
- **Panel voices** setting lets you toggle a short list of voices (each with its own toggle) to show in the panel's Voice dropdown instead of your whole account list.

### Other

- Markdown syntax (links, emphasis, code blocks, frontmatter, etc.) is stripped before sending text to the TTS provider so it isn't read aloud literally.
- Buttons that don't currently apply (e.g. Previous/Next part with a single-chunk read, Play saved with no saved audio) are shown disabled rather than disappearing, so the panel's layout stays stable.

### Planned

See [FUTURE_FEATURES.md](FUTURE_FEATURES.md) for ideas not yet implemented (other TTS providers, local/offline generation, background generation, auto-following the active note, image captioning, and more).

## Setup

1. Install the plugin (see below).
2. Open **Settings → Obsidian Reader** and add your ElevenLabs API key. It's stored via Obsidian's built-in [SecretStorage](https://docs.obsidian.md/plugins/guides/secret-storage), not in this plugin's own settings file — the setting only remembers which secret to look up, so the key can be shared with other plugins that use the same secret and never appears in `data.json`.
3. Pick a **Voice** from the dropdown (fetched from your ElevenLabs account) and a **Model** — Eleven v3 (research preview), Eleven Multilingual v2, or Eleven Flash v2.5.
4. Click the ribbon icon in the left sidebar, or the speaker icon at the top-right of a note, to open the **Obsidian Reader** panel in the right sidebar, then click its **Read** button — or just run **Read note aloud** from the command palette to open the panel and start reading in one step.

## Known limitations (MVP)

- Most of this plugin's UI and behavior (the panel, its buttons, settings interactions, file save/link/clear flows) has only been verified by type-checking, lint, and standalone logic tests run outside Obsidian — not by clicking through a running vault. The per-note action icon and ribbon icon are confirmed working; treat everything else as untested until you've tried it yourself.
- Staleness tracking hashes the note's full content (not just what was actually read, if you read a selection), so editing any part of the note will mark saved audio as outdated, even if the edit was outside the text that was actually read.
- When "Replace existing file" is on and the voice changes between regenerations, the file keeps its original filename (with the old voice's name in parentheses) rather than being renamed — only its contents are replaced.
- Auto-generate on open makes one or more ElevenLabs API calls (and consumes credits) every time you open a note whose saved audio is missing or outdated — be mindful of this on notes you edit frequently.
- "Clear reader files" moves the audio file to trash (respecting your vault's file-deletion preference) and removes the properties; there's no undo for the properties themselves.
- The voice dropdown fetches only the first 100 voices from your ElevenLabs account (no pagination past that).
- Saving audio concatenates raw chunk bytes for multi-part reads rather than properly re-muxing the MP3 stream; this works in practice for ElevenLabs' output but isn't a fully spec-correct MP3 concatenation.
- The rate-limit fallback to sequential generation applies only to the read in progress; each new read starts again at your configured parallel-generation setting.
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
