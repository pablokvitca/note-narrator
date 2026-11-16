# `/release stable [X.Y.Z]`

Cut a stable release. This publishes something people install, so it is gated and tracked in Kaneo, the self-hosted task tracker (workspace QuantumKaneo, project "Obsidian Plugin: Note Narrator", ticket keys `OBNN-N`). Read [reference.md](reference.md) first if you have not: it covers the branching model, immutable releases and the special cases (notably a PR merged by rebase).

**Only proceed when the user explicitly asked for a stable release or to ship in this conversation.** Never infer it. If a beta of this version has not been tested by the user, ask before continuing.

Target version: the argument if given, else `manifest.json`'s `version` on the tracking branch (it was bumped on the first commit of the branch, so it is the version to ship). Tell the user the version you are about to release.

Load the Kaneo tools if deferred: `ToolSearch` with `select:mcp__kaneo__search,mcp__kaneo__get_task_by_ticket_id,mcp__kaneo__get_task,mcp__kaneo__create_task,mcp__kaneo__update_task_status,mcp__kaneo__create_task_comment,mcp__kaneo__create_task_relation,mcp__kaneo__get_task_relations,mcp__kaneo__list_project_custom_fields,mcp__kaneo__set_task_custom_field_value,mcp__kaneo__attach_label_to_task`. If the session has no `mcp__kaneo__*` tools at all (it started before the server was added), run the Kaneo calls through a headless `claude -p "<what to do>" --allowedTools "mcp__kaneo"` from the shell.

## Part 1: the release checklist in Kaneo

Every stable release has a Kaneo task, created **before** anything is tagged.

### Find or create the release task

Search Kaneo (`search` with `q: "Release Stable X.Y.Z"`, `type: "tasks"`, the workspace id and the Note Narrator `projectId` from `AGENTS.md`; check the titles, the search is fuzzy). If it does not exist, create it:

- `create_task` with title `Release Stable X.Y.Z`, project Note Narrator, status `in-progress`, priority `no-priority`, assigned to the user. Attach the `Chore` label (`attach_label_to_task`).
- Set the `Milestone` custom field (`list_project_custom_fields` gives its id and options; `set_task_custom_field_value`) to this version's option, `X.Y.Z`. If there is no option for it, ask the user to add one in the Kaneo UI: the MCP tools cannot edit field definitions.
- These subtasks: create each with `create_task` (same project, status `to-do`, same `Milestone`), then link it with `create_task_relation` (`relationType: "subtask"`, `sourceTaskId`: the release task, `targetTaskId`: the subtask):
  1. `Run the guideline review`: run the `review-for-stable-release` skill (`/review-for-stable-release X.Y.Z --release-task <release task id>`). It posts its report as a comment on this subtask, files each confirmed breach as a subtask of the release task, and sets this subtask to Done.
  2. `Update documentation for X.Y.Z`: update the docs vault (`pk-plugins-docs`, folder `Note Narrator`) for what changed: affected pages, the `plugin-version` and `updated` frontmatter, Known limitations, the Roadmap (move shipped items), screenshots.
  3. `Review documentation for X.Y.Z`: read the docs against the build being released (settings, labels, defaults, commands), check the screenshot checklist, links and the publish selection, and fix inaccuracies.
  4. `Test on <platform>` for each platform below: install the beta (or release candidate) and exercise the main flows (read, pause, skip, save, link, background generation, settings tabs).
  5. `Submit to the community directory`: follow <https://docs.obsidian.md/plugins/releasing/submit-plugin>. Needed for the first stable release; for later releases, check that page for whether the listing fields (id, name, author, description) changed and need a pull request, and otherwise close it as not needed.

**Platforms** (edit this list to match the devices that can actually be tested): Desktop: macOS, Windows, Linux. Mobile: iPhone, iPad, iPad mini, visionOS, Android.

### The gate

Show the user the release task's subtasks (`get_task_relations`) and their states. **Do not run Part 2 until every subtask (including breach subtasks filed by the review) is `done` (or `canceled`), or the user has explicitly waived the open ones in this conversation.** Urgent and High breach subtasks need fixing or an explicit waiver. If the guideline review has not been run yet, offer to run it now with the `review-for-stable-release` skill.

## Part 2: the release

Do the common preconditions from [SKILL.md](SKILL.md) (tracking branch, up to date, clean tree, build/lint/test pass). Then:

1. Check the manifest version is X.Y.Z and that no tag `X.Y.Z` (and no release, even a deleted one) already exists: `git tag --list X.Y.Z` and `gh release view X.Y.Z`. Tag names are not reusable (immutable releases).
2. `npm version X.Y.Z -m "Release %s"`: bumps `package.json`, runs the `version` script (syncs `manifest.json`, adds the `versions.json` entry), commits everything as `Release X.Y.Z`, and creates the tag `X.Y.Z` (no `v`). See the special cases in [reference.md](reference.md) if it refuses.
3. `git push origin <branch> --follow-tags`. The tag push triggers the release workflow. Wait for it, then verify: `gh release view X.Y.Z --json isPrerelease,isDraft,assets` shows not a pre-release, not a draft, and at least these 3 release files: `main.js`, `manifest.json`, `styles.css` (the workflow also attaches `LICENSE` and `THIRD_PARTY_NOTICES.md`).
4. Fast-forward `main`: `git checkout main && git merge --ff-only <branch> && git push origin main`. If a PR exists from this branch GitHub marks it merged by itself. If the PR was merged by rebase or squash, use the "PR merged with rebase" variant in [reference.md](reference.md) instead (release from `main`).
5. Only for a new-minor release (not a patch): rename the branch for future patches: `git branch -m next/X.Y release/X.Y && git push origin release/X.Y` (pause the beta workflow while pushing it, see [reference.md](reference.md)). Check `git ls-remote origin` before deleting a remote `next/X.Y` yourself; GitHub may have removed it.
6. The release workflow attaches the assets; never attach them by hand.
7. Comment on the `Release Stable X.Y.Z` task (`create_task_comment`) with a link to the GitHub release and anything deferred or waived, then set it to `done` (`update_task_status`). Make sure the `Submit to the community directory` subtask has been handled or explicitly closed.

## Report

Tell the user the release is out (link the GitHub release), what state `main` and the branches are in, the Kaneo task status, and anything left for them (community directory submission, docs publish, follow-up subtasks).
