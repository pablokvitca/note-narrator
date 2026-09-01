# Future features

Ideas not yet implemented, roughly in the order they came up.

1. **Support other TTS providers.** The `src/tts/` layer is already a small interface (`TTSProvider`) specifically so providers beyond ElevenLabs can be added without touching the reading/chunking/playback logic.

2. **Support local generation** (OS-based TTS, e.g. macOS `say`/AVSpeechSynthesizer, or a local model) as an alternative provider — no API key or network required, likely lower quality/expressiveness in exchange.

3. **"Continue generating in background" button.** Lets the rest of a note keep generating after you stop/close playback, using a separate (likely lower) parallel-generation setting for background work so it doesn't compete with an actively-playing read. The player view would need a way to show what's generating in the background and what's recently finished, and a way to jump into/play those results.

4. **Fix "point to current note" when a new note is focused.** Right now the panel doesn't automatically point at whatever note you've just opened. If a read is already in progress when you switch notes, don't just yank the panel over — surface a "Replace playback with current note" button instead, so switching notes to jot something down doesn't interrupt what's playing.

5. **Auto-caption images** in a note (via a different, vision-capable model) so image content gets a short spoken description instead of being silently skipped.

6. **Better per-chunk saving for intermediate generations.** The current MP3 save concatenates raw chunk bytes (documented as a known limitation); worth revisiting once there's a reason to save/resume partial reads more robustly — e.g. proper re-muxing, or saving chunks individually with a manifest instead of one flat file.

7. **Show the current reading/generating note's title in the panel.** Right now the panel shows status ("Reading…", "Generating speech…") but not which note that status is about — useful once background generation (#3) or auto-following the active note (#4) means the panel isn't always obviously about "whatever note is open right now".

8. **Indicate missing parts in the total/remaining time.** The elapsed/total/remaining readout is only ever measured from chunks that have actually finished generating, so when later parts haven't generated yet, "total" and "remaining" silently undercount the real note length. When there are ungenerated parts beyond the current one, append "(+N parts)" to both figures, e.g. `0:42 / 1:30 (+3 parts) - 0:48 (+3 parts) remaining`, so it's clear those numbers aren't the full picture yet.

9. **Full-audio playback times, with a "Time display" setting.** Playback times should account for the whole read (cumulative elapsed/total/remaining across every chunk, using #8's "+N parts" for chunks not generated yet), not just the currently-playing chunk's local audio element as today. Add a settings dropdown to choose what the panel shows: **Show full times** (whole-read totals only), **Show current part times** (today's per-chunk behavior), or **Show full times + current part times** (full times with the current part's times shown alongside in parentheses).

10. **Highlight the currently-playing text in the note.** A settings option to choose the highlight granularity — **word**, **sentence**, **section**, or **chunk** — and highlight/underline that unit in the editor as it's read. Chunk/section/sentence granularity can reuse this plugin's own text-splitting boundaries mapped back onto editor offsets; word-level highlighting is a materially bigger lift since it needs word-level timing from the TTS provider (audio-to-text alignment), not just our own chunk boundaries — ElevenLabs' alignment/timestamps support (if used) would need to be threaded all the way through generation, saving, and playback.

11. **"Jump to current" buttons.** **Jump to current section**, **Jump to current chunk**, and **Jump to current word** buttons/commands that scroll the note to (and reveal) whatever's currently playing, independent of whether highlighting (#10) is also enabled.
