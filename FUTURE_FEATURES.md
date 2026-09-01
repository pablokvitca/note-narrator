# Future features

Ideas not yet implemented, roughly in the order they came up.

1. **Support other TTS providers.** The `src/tts/` layer is already a small interface (`TTSProvider`) specifically so providers beyond ElevenLabs can be added without touching the reading/chunking/playback logic.

2. **Support local generation** (OS-based TTS, e.g. macOS `say`/AVSpeechSynthesizer, or a local model) as an alternative provider — no API key or network required, likely lower quality/expressiveness in exchange.

3. **"Continue generating in background" button.** Lets the rest of a note keep generating after you stop/close playback, using a separate (likely lower) parallel-generation setting for background work so it doesn't compete with an actively-playing read. The player view would need a way to show what's generating in the background and what's recently finished, and a way to jump into/play those results.

4. **Fix "point to current note" when a new note is focused.** Right now the panel doesn't automatically point at whatever note you've just opened. If a read is already in progress when you switch notes, don't just yank the panel over — surface a "Replace playback with current note" button instead, so switching notes to jot something down doesn't interrupt what's playing.

5. **Auto-caption images** in a note (via a different, vision-capable model) so image content gets a short spoken description instead of being silently skipped.

6. **Better per-chunk saving for intermediate generations.** The current MP3 save concatenates raw chunk bytes (documented as a known limitation); worth revisiting once there's a reason to save/resume partial reads more robustly — e.g. proper re-muxing, or saving chunks individually with a manifest instead of one flat file.

7. **Show the current reading/generating note's title in the panel.** Right now the panel shows status ("Reading…", "Generating speech…") but not which note that status is about — useful once background generation (#3) or auto-following the active note (#4) means the panel isn't always obviously about "whatever note is open right now".
