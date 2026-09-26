# `/release beta`

Publish a beta build for BRAT testers by pushing the tracking branch. A beta is not shipped and nothing here touches `main`, tags or `npm version`.

Do the common preconditions from [SKILL.md](SKILL.md) first (tracking branch, up to date, clean or agreed changes, build/lint/test pass).

## 1. Make sure the version is bumped

Read the rule in [reference.md](reference.md). Determine the last stable tag (`gh release list --exclude-pre-releases --limit 1 --json tagName -q '.[0].tagName'`) and `manifest.json`'s `version`:

- On `next/X.Y` (a new minor): the manifest version must be `X.Y.0`, greater than the last stable. If not, bump it.
- On `release/X.Y` (a patch): if the manifest version equals the last stable version and there are commits to publish, bump the patch (`X.Y.(Z+1)`). If it is already above the last stable, leave it.

A missing bump publishes a beta that BRAT will not offer. If a bump is needed and other commits are already unpushed, create the bump as the **first** of the unpushed commits (only `manifest.json`'s `version` line changes in it), then the rest. Commit message: `Bump version to X.Y.Z`.

## 2. Push

`git push origin <branch>` (set upstream if needed). Do not create tags. Do not use `--follow-tags`.

If more than one branch is being pushed, or history was rewritten, follow the "Special cases" in [reference.md](reference.md) to pause the beta workflow first.

## 3. Verify the beta

Wait for the beta workflow: `gh run list --repo pablokvitca/note-narrator --limit 3` until nothing is in progress, then
`gh release list --repo pablokvitca/note-narrator --limit 5 --json tagName,isPrerelease`.
Expect a new pre-release named `<manifest version>-beta.<run number>`. If it is missing or has the wrong base version, diagnose (a missing bump, a failed run: `gh run view <id> --log-failed`) before reporting.

## 4. Report

Say "pushed a beta for testing" with the beta tag, and remind the user how to test it: BRAT, add `pablokvitca/note-narrator`, enable beta versions. Mention anything that was bumped or committed on their behalf. Do not say the plugin was released or shipped.
