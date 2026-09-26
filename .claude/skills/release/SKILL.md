---
name: release
description: Publish a release of Note Narrator. `/release beta` pushes a beta build for BRAT testers; `/release stable` cuts a stable release (Linear release checklist, guideline review, version bump, tag, GitHub release, main fast-forward). Use for EVERY release and for any push to a next/** or release/** branch, never run the release commands by hand.
argument-hint: "beta | stable [X.Y.Z]"
---

# Release

The single entry point for releasing this plugin. The detailed procedure lives in the files next to this one and is only loaded when you release; do not copy it into `AGENTS.md`.

## 1. Pick the mode

The argument is `beta` or `stable` (optionally followed by the target version for `stable`, e.g. `/release stable 0.18.0`).

- No argument, or anything else: ask the user which they want. Do not guess.
- **`beta`**: read [beta.md](beta.md) and follow it.
- **`stable`**: read [stable.md](stable.md) and follow it. A stable release is gated: only continue when the user explicitly asked for a stable release (or shipping) in this conversation. "The fix is done" or "tests pass" is never a request.

Both modes rely on the rules and background in [reference.md](reference.md): read it first if you are unsure about the branching model, the version-bump rule, how betas are built, or the special cases (rebase-merged PRs, force pushes, immutable releases).

## 2. Common preconditions (both modes)

1. `git branch --show-current`: must be a tracking branch, `next/X.Y` (new minor) or `release/X.Y` (patch). On `main` or any other branch, stop and tell the user.
2. `git fetch origin` and check the branch is not behind its remote.
3. `git status --short`: if there are uncommitted changes, show them and ask whether to commit them as part of this release. Never commit unrelated changes. Commit messages end with the co-author trailer given in the session's attribution instructions.
4. `npm run build && npm run lint && npm test` must pass before anything is pushed or tagged.

## 3. Hard rules

- Never create a version tag, run `npm version`, or touch `main` in `beta` mode.
- Never create a beta tag or release by hand: pushing a commit is what publishes a beta.
- Never push, tag or release without the user's request in this conversation. A `beta` push publishes something, so it needs the user asking for a beta (or for a push to a tracking branch).
- Report what actually happened: "pushed a beta for testing", not "released", unless the stable steps ran.
