---
name: review-for-stable-release
description: "Review the changes between the last stable release and a new stable candidate of the Obsidian plugin in the current repository against Obsidian's community plugin guidelines plus the shared and project-specific checks (guidelines.md and the plugin's .claude/project/guidelines.md), post the report as a comment on the release's review subtask in Kaneo, and file every confirmed breach as a subtask of the release task. Use when preparing a stable release, as part of `/release stable`, before the final release steps."
argument-hint: "[new-version] [--release-task KEY-N] [--base <tag>]"
---

# Review for stable release (pointer)

This file is only a pointer. The real skill is shared by every plugin and lives in the `obsidian-plugin-standards` repository, next to this one.

1. Find it: the plugin repository root is `git rev-parse --show-toplevel`; the skill is `../obsidian-plugin-standards/skills/review-for-stable-release/SKILL.md` relative to that root. Inside a git worktree, use the main checkout instead: `dirname "$(git rev-parse --path-format=absolute --git-common-dir)"` is its root, and the standards repository is that root's sibling.
2. Read that `SKILL.md` and follow it, using this repository's `.claude/project/` files (`profile.md`, and `guidelines.md` and `release.md` if present) for everything project-specific.
3. If the standards repository is not there, stop and tell the user to clone it next to the plugin repository. Do not improvise the review from memory.

Never copy the shared skill's content into this file. Fixes and improvements go to the standards repository through a pull request; plugin-only overrides go in `.claude/project/guidelines.md`.
