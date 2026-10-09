# Contributing

Thanks for helping with Note Narrator. Bug reports, platform test reports and pull requests are all welcome.

## Reporting bugs and testing platforms

Open an issue on [GitHub](https://github.com/pablokvitca/note-narrator/issues) with:

- your platform (for example Windows 11, Android, iPadOS) and Obsidian version,
- the Note Narrator version,
- what you did, what you expected, and what happened instead.

Windows, Linux and Android are not tested yet, so a report that it works (or doesn't) there is useful too.

Please don't include API keys or note text you want to keep private.

## Pull requests

1. Set up the project as described in [DEVELOPMENT.md](DEVELOPMENT.md).
2. Branch from the current tracking branch, not `main`: `release/X.Y` for fixes to the current version, or `next/X.Y` for new features if one exists. `main` only moves when a stable version is released.
3. Keep each pull request to one change, and describe what it changes and why.
4. Make sure `npm run build`, `npm run lint` and `npm test` pass, and add or update tests in `tests/` for behavior you change.

## Code style

- TypeScript with `strict` on. Prefer `async`/`await` over promise chains.
- Keep `src/main.ts` to the plugin's lifecycle; put features in their own modules under `src/`.
- Register every event, interval and DOM listener with Obsidian's `register*` helpers so the plugin unloads cleanly.
- UI text uses sentence case, and settings descriptions say plainly what a setting does.
- Follow Obsidian's [plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines) and [developer policies](https://docs.obsidian.md/Developer+policies): no network requests beyond what a feature needs, nothing outside the vault, no telemetry.
- Write the provider's name as ElevenLabs, in plain text, and don't imply any affiliation with it or with Obsidian.

## License

By contributing, you agree that your contributions are released under the project's [0BSD license](LICENSE).
