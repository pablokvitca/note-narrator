# Third-party notices

Note Narrator is licensed under the [0BSD license](LICENSE). It bundles no third-party runtime code: the built `main.js` contains only this repository's own source, and the Obsidian API and CodeMirror libraries are provided by Obsidian at runtime (they are not part of this plugin's files).

The notices below cover third-party material that this plugin's own source is derived from or depends on.

## Lucide icons

Some of the plugin's custom icons (`src/ui/icons.ts`) reuse geometry from [Lucide](https://lucide.dev): the waveform paths of the `audio-lines` icon (used in the "saved audio" toolbar icon) and the arc and arrowhead of the `rotate-ccw` icon (used in the rewind and skip-forward controls). Icons drawn with Obsidian's own `setIcon()` are Lucide icons that ship with Obsidian itself.

Lucide is licensed under the ISC License, reproduced below from Lucide's repository (<https://github.com/lucide-icons/lucide/blob/main/LICENSE>). Lucide also lists icons it derived from Feather (MIT); the two icons used here, `audio-lines` and `rotate-ccw`, are not on that list, so only the ISC License applies.

```
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

## Services and trademarks

Note Narrator sends text to the [ElevenLabs](https://elevenlabs.io) text to speech API when you ask it to read. No ElevenLabs software or code is included. "ElevenLabs" and "Obsidian" are trademarks of their respective owners. Note Narrator is an independent project and is not affiliated with, endorsed by, or sponsored by either company.

## Development tools

The project is built with tools such as esbuild, TypeScript, ESLint and Vitest, each under its own open source license. They are used only at build time and none of their code is included in the released plugin files.
