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

- One row of icon controls, in order: **Previous part**, **Rewind** (seconds configurable), **Pause/Resume**, **Skip forward**, **Next part**, **Stop**, then -- separated, since it scrolls the note rather than touches playback -- **Scroll to current section** (see below). Previous/Next part jump immediately between chunks rather than waiting for the current one to finish. During **Play Saved**, they work the same way, moving between the saved file's own per-chunk parts (see below), instead of being disabled the way they were before that data existed.
- A live **Playback speed** slider (0.5x–3x, min/max and current value shown) that adjusts the current/next read without changing your configured default speed.
- Progress display: elapsed / total / remaining time (remaining divides by playback speed), a "Part X of Y · Z% complete" line, and a segmented bar showing which chunks have finished generating.

### Now-playing highlight & scroll-to-current

- **Highlight while reading** setting (off by default) marks the currently-playing text in the editor as the note is read. Requires the note to be open in **Editing view** -- like any editor decoration, it has nothing to draw onto in Reading view. **Highlight granularity** picks how much lights up at once: **Chunk** (default, moves once per generated audio request) or **Section** (moves least often; with the sentence-only chunker, which has no sections, this highlights the whole note). Both are exact -- driven by which chunk is actually playing, a real event. **Highlight style** picks how it's marked: **Margin marker** (default) shows a small speaker icon in the editor's left gutter (the same column line numbers use, and the same mechanism Git blame/diff plugins render into); **Background wash** and **Underline** mark the text itself. With Section granularity, **Only highlight the section heading** narrows it to just the heading line instead of the whole section body.
- Sentence- and word-level highlighting/scroll-to-current aren't implemented yet -- both would need to *estimate* position from elapsed playback time or ElevenLabs' separate timestamps endpoint rather than a real chunk-boundary event, and an early sentence-level implementation was pulled after testing showed it drifted noticeably out of sync. Left for a future milestone.
- **Scroll-to-current button** setting (on by default) adds a **Scroll to current section** button to the playback controls row, scrolling the note to (and selecting) whichever section is currently playing — independent of whether highlighting is also on. Named "scroll", not "jump", to make clear it only moves the editor, not playback. Section rather than chunk: a chunk is an internal TTS-request boundary, not something you actually navigate by.
- Both features also work during **Play Saved** (not just a live read): the saved file is sliced back into its per-chunk parts (using each chunk's `[duration, byte length]`, saved alongside the audio -- see **Chunk durations property** below) and played one chunk at a time, the same reliable way a live read does, rather than relying on seeking within one big concatenated file. This needs the note to still be up to date with that saved audio (an outdated note's current structure can't be trusted to match what was actually generated) and falls back to a single opaque, non-navigable chunk if reading/chunking settings have changed since generation in a way that changes the chunk count, or if the saved byte lengths don't add up to the file's actual size.
- Neither feature applies to a selection read (no reliable position to anchor to).

### Long notes and chunking

- Notes are split into TTS-request-sized chunks according to the **Text chunker** setting: **Markdown-aware** (default) splits by heading section first (up to a configurable **max heading depth**), then by sentence within each section; **Sentence-only** ignores headings and just packs sentences up to the character limit.
- **Skip sections by heading** setting (Markdown-aware chunker only) lists regex patterns, one per line; any section whose heading text matches one is skipped entirely when chunking/reading -- e.g. to always skip a "Changelog" or "Notes to self" section.
- **Start playback immediately** (on by default) begins playing as soon as the first chunk is ready instead of waiting for the whole note; **Quick start** (on by default, requires the above) makes that first chunk artificially short — including the title/properties preamble, if enabled — so it returns faster. **Quick start unit** picks whether that target size is in **Words** (default, 150) or **Characters** (default 750), each with its own size slider.
- **Generate chunks in parallel** (on by default, window of 2) lets more than one chunk generate at once instead of strictly one at a time; **Max parallel chunk generation** controls the window size. If ElevenLabs returns a 429 (rate limited), requests retry automatically with exponential backoff (up to 3 attempts), and generation falls back to sequential (one at a time) for the rest of that read to avoid repeating it.

### Saving audio to a file

- **Save generated audio to a file** setting (off by default) saves each read as an `.mp3`, in the note's folder or a configurable custom folder (created automatically if missing). The file is written as soon as *generation* finishes, not once playback finishes.
- **Link saved audio in the note** setting (off by default, requires saving) writes the audio's link, a content hash (for staleness), the raw file path (used internally), a generation timestamp, the voice ID used, and each chunk's `[duration, byte length]` (used to slice the saved file back into its per-chunk parts, for Previous/Next part and highlighting/scroll-to-current during **Play Saved**), each into its own **individually configurable** frontmatter property (defaults: `reader_audio`, `reader_audio_hash`, `reader_audio_path`, `reader_audio_timestamp`, `reader_audio_voice`, `reader_audio_chunk_durations`). The panel shows whether the saved audio is up to date or outdated. The reader's own six properties are always excluded when computing that hash; an **Extra properties to exclude from staleness hashing** setting lets you list additional frontmatter properties (one per line) — e.g. ones another plugin auto-updates — that shouldn't count as an edit either.
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
- The now-playing highlight/scroll-to-current position for chunk and section granularity is a *proportional estimate* (allocated by each chunk's share of its section's stripped-text length), not a byte-exact mapping back to the raw note -- markdown-stripping changes text length, so it can be off by a word or two at a boundary. A comment (`%% like this %%`) that happens to contain heading-like text (`# ...`) can also throw off section boundaries, the same known limitation as the chunker itself.
- Previous/Next part and highlighting/scroll-to-current during **Play Saved** re-derive the note's current chunk structure and compare its count against the saved chunk-durations property -- if any reading/chunking setting that affects how the note splits (chunker style, max heading depth, skip-by-heading patterns, quick start, model) has changed since that audio was generated, the counts won't match and the file plays back as a single, non-navigable chunk instead, even though the note itself still reports "up to date". Regenerating fixes it.
- HTML comments (`<!-- like this -->`) aren't stripped or otherwise handled specially — they're read as literal text, `<`/`!`/`-`/`>` symbols included. An attempted "Skip HTML comments" setting was pulled after it didn't reliably suppress them in testing; root cause not yet found. Obsidian/Markdown comments (`%% like this %%`) are unaffected and have their own working settings.
- Requires an ElevenLabs account and API key; this plugin makes network requests to `api.elevenlabs.io` only when you trigger a read.

## Development

- `npm i` to install dependencies.
- `npm run dev` to compile in watch mode.
- `npm run build` to type-check and produce a production `main.js`.
- `npm run lint` to run ESLint.
- Pushing a tag matching `manifest.json`'s `version` (no leading `v`) triggers a GitHub Actions workflow that builds the plugin and creates a GitHub release with `main.js`, `manifest.json`, and `styles.css` attached. This only creates the release — it does not publish to the community plugin directory.
- A version with a SemVer pre-release suffix (e.g. `1.7.0-beta.1`) is published as a GitHub **pre-release** instead of a stable release, so it doesn't appear as "latest" and is only picked up by [BRAT](https://github.com/TfTHacker/obsidian42-brat) users who've opted in to beta versions for this plugin.

### Branching model

- `main` always reflects the latest **released stable** version — nothing merges directly into it except a fast-forward to a tracking branch's tip at release time.
- Feature work for an upcoming minor version targets a `next/X.Y` branch (e.g. `next/0.11`), branched off `main`. **Immediately bump `manifest.json`'s `version` to `X.Y.0` as the first commit on the branch** — do not leave it at the inherited last-released version. Beta tags are `<manifest version>-beta.N`, and SemVer ranks a prerelease *below* its base version once that version has actually shipped (`0.10.1-beta.N` sorts below the real `0.10.1`), so BRAT will silently keep serving the old stable release instead of the beta until this bump happens. Every push to the branch triggers a beta pre-release (see below) so it can be tested via BRAT before shipping.
- Once `X.Y.0` ships (version bumped, tagged, released, `main` fast-forwarded to match), the branch is renamed `next/X.Y` → `release/X.Y` and becomes where patches for that line land directly (`X.Y.1`, `X.Y.2`, ...) — each patch release follows the same bump-tag-push-fast-forward-main flow.
- A new `next/X.(Y+1)` branch (or `next/(X+1).0`) is cut from `main` once the next minor's feature work starts.
- Every push to a `next/**` or `release/**` branch triggers a separate GitHub Actions workflow that builds the plugin and publishes a GitHub **pre-release** tagged `<current manifest version>-beta.<run number>` — an on-push beta build for BRAT testers, without ever committing a version bump back to the branch. Each push supersedes (deletes) the previous beta release for that version line, so only the latest beta build stays published.

## Manually installing the plugin

Copy `main.js`, `manifest.json` to `VaultFolder/.obsidian/plugins/obsidian-reader/`, then enable it in Obsidian's Community Plugins settings (this plugin is not published to the community plugin store). To test a beta release before it's promoted to stable, install via [BRAT](https://github.com/TfTHacker/obsidian42-brat) instead, adding this repo and enabling beta versions.

Requires Obsidian 1.13.0+ (for the declarative settings API; SecretStorage itself only needs 1.11.4+).
