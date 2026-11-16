# Release notes: Note Narrator

Project-specific additions to the shared `release` skill (`obsidian-plugin-standards/skills/release/`). The shared skill reads this file after `profile.md`. Nothing here loosens the shared hard gate.

## History that matters

- **Immutable releases are enabled on this repository.** A published release's tag and assets cannot be changed, and a deleted release's tag name can never be reused: the `0.16.0` name was burned this way.
- `0.17.0` was released from `main` with the "pull request merged with rebase or squash" variant in the shared `reference.md`.
- Release lines `0.10` onwards each have a `release/X.Y` branch; patches land on the newest one (see the profile).

## Workflows

- The repository is public, so the "Attest build provenance" step runs and BRAT needs no token.
- In `.github/workflows/release.yml` and `beta-release.yml` that step is **not** guarded with `if: ${{ !github.event.repository.private }}`. That is fine while the repository is public, but if it is ever made private the step fails both workflows: guard it first (through a pull request).
- The stable workflow attaches `main.js`, `manifest.json`, `styles.css`, `LICENSE` and `THIRD_PARTY_NOTICES.md`.

## Main flows to test

For each `Test on <platform>` subtask, in `note-narrator-test-vault` only:

- Read, pause, skip
- Save the audio, link it from the note
- Background generation
- Each settings tab

Every read costs money with the configured provider. Keep **Auto-generate on open** off in the test vault unless that flow is being tested, since opening a note without saved audio generates it when the setting is on.

Windows, Linux and Android are optional platforms (no device has been available; `CONTRIBUTING.md` says they are not tested yet). The 1.2.1 checklist used one combined subtask, `Test on macOS, iPhone, iPad, iPad mini and visionOS`, which is acceptable as long as every required platform is covered by it.

## Docs subtask

`Update docs for X.Y.Z` covers the docs vault (`pk-plugins-docs`, section `Note Narrator`): affected pages, the `plugin-version` and `updated` frontmatter, Known limitations, the Roadmap (move shipped items to Recently shipped), screenshots. `Review docs for X.Y.Z` also checks the screenshot checklist and the publish selection. Older checklists title these `Update documentation for X.Y.Z` and `Review documentation for X.Y.Z`.

## Waivers

- Standing waivers for the guideline review are recorded in `guidelines.md` next to this file (currently G39).
- A per-release waiver (for example the platform tests waived for 1.2.1 because only docs links changed) applies to that release only; record it on the subtask and never reuse it for a later release.

## Superseded by the shared skill

The former copy of this skill said the `Submit to the community directory` subtask could be "closed as not needed" for later releases. That is no longer allowed: the community directory subtask is never closed as not needed (shared `stable.md`). Older checklists use that title for it.
