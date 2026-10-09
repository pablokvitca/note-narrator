# Development

How to build, test and try Note Narrator locally. For how to propose changes, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Setup

You need a current Node.js LTS (18 or newer) and npm.

```bash
npm install
```

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Builds `main.js` in watch mode, with an inline source map |
| `npm run build` | Type-checks, then builds a minified production `main.js` |
| `npm run lint` | Runs ESLint, including Obsidian's own plugin rules (`eslint-plugin-obsidianmd`) |
| `npm test` | Runs the unit tests with Vitest |

CI runs the build, lint and tests on every push.

## Project layout

- `src/main.ts`: the plugin's lifecycle only (loading, commands, views, events).
- `src/engine/`: reading, chunk generation, the background queue and saved audio.
- `src/ui/`: the panel, background job list, editor highlighting and other UI.
- `src/settings/`: settings, defaults, profiles, and one file per settings tab in `sections/`.
- `src/text/`: Markdown stripping, chunking and other text helpers.
- `src/tts/`: text to speech providers (ElevenLabs).
- `tests/`: unit and integration tests, mirroring `src/` (`src/text/text-utils.ts` is tested by `tests/text/text-utils.test.ts`). They are type-checked by `npm run build` but never bundled into `main.js`. `tests/stubs/obsidian.ts` stands in for the `obsidian` package at runtime.

## Trying it in a vault

1. Run `npm run dev` (or `npm run build`).
2. Copy `main.js`, `manifest.json` and `styles.css` into `<your vault>/.obsidian/plugins/note-narrator/`, or symlink the folder.
3. Reload Obsidian and enable **Note Narrator** under **Settings → Community plugins**.

Reading spends ElevenLabs credits. A separate test vault with **Auto-generate on open** turned off is a good idea, since opening a note without saved audio generates it when that setting is on.

## Releases

Releases are built by GitHub Actions from tags; never attach a hand-built `main.js`. The branching model (`main`, `next/X.Y`, `release/X.Y`), the version-bump rule and the beta and stable procedures are documented in [AGENTS.md](AGENTS.md) and `.claude/skills/release/`.
