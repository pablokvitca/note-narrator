# Third-party notices

Note Narrator is licensed under the [0BSD license](LICENSE). It bundles no third-party runtime code: the built `main.js` contains only this repository's own source, and the Obsidian API and CodeMirror libraries are provided by Obsidian at runtime (they are not part of this plugin's files).

The notices below cover third-party material that this plugin's own source is derived from or depends on.

## Lucide icons

Some of the plugin's custom icons (`src/icons.ts`) reuse geometry from [Lucide](https://lucide.dev): the waveform paths of the `audio-lines` icon (used in the "saved audio" toolbar icon) and the arc and arrowhead of the `rotate-ccw` icon (used in the rewind and skip-forward controls). Icons drawn with Obsidian's own `setIcon()` are Lucide icons that ship with Obsidian itself.

Lucide is licensed under the ISC License. Portions derived from Feather are licensed under the MIT License.

```
ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT).
All other copyright (c) for Lucide are held by Lucide Contributors 2022.

Permission to use, copy, modify, and/or distribute this software for any purpose with or without
fee is hereby granted, provided that the above copyright notice and this permission notice appear
in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS
SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE
AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT,
NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE
OF THIS SOFTWARE.
```

```
The MIT License (MIT) (for portions derived from Feather)

Copyright (c) 2013-2023 Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

The text above reproduces Lucide's published license; if in doubt, the authoritative copy is at <https://github.com/lucide-icons/lucide/blob/main/LICENSE>.

## Services and trademarks

Note Narrator sends text to the [ElevenLabs](https://elevenlabs.io) text to speech API when you ask it to read. No ElevenLabs software or code is included. "ElevenLabs" and "Obsidian" are trademarks of their respective owners. Note Narrator is an independent project and is not affiliated with, endorsed by, or sponsored by either company.

## Development tools

The project is built with tools such as esbuild, TypeScript, ESLint and Vitest, each under its own open source license. They are used only at build time and none of their code is included in the released plugin files.
