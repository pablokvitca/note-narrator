---
name: release
description: "Publish a release of the Obsidian plugin in the current repository. `/release beta` pushes a beta build for BRAT testers; `/release stable` cuts a stable release (Kaneo release checklist, guideline review, version bump, tag, GitHub release, main fast-forward). Use for EVERY release and for any push to a next/** or release/** branch, never run the release commands by hand."
argument-hint: "beta | stable [X.Y.Z]"
---

# Release (pointer)

This file is only a pointer. The real skill is shared by every plugin and lives in the `obsidian-plugin-standards` repository, next to this one.

1. Find it: the plugin repository root is `git rev-parse --show-toplevel`; the skill is `../obsidian-plugin-standards/skills/release/SKILL.md` relative to that root. Inside a git worktree, use the main checkout instead: `dirname "$(git rev-parse --path-format=absolute --git-common-dir)"` is its root, and the standards repository is that root's sibling.
2. Read that `SKILL.md` and follow it, using this repository's `.claude/project/` files (`profile.md`, and `release.md` if present) for everything project-specific.
3. If the standards repository is not there, stop and tell the user to clone it next to the plugin repository. Do not improvise the release from memory.

Never copy the shared skill's content into this file. Fixes and improvements go to the standards repository through a pull request; plugin-only notes go in `.claude/project/release.md`.
