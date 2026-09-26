# Release reference

Background and rules shared by `beta.md` and `stable.md`.

## Branching model

- `main` always reflects the latest **released stable** version. Nothing merges into it except a fast-forward to a tracking branch's tip at release time, never a regular merge commit.
- Feature work for an upcoming minor version happens on `next/X.Y` (for example `next/0.18`), branched off `main`.
- Once `X.Y.0` ships, `next/X.Y` is renamed to `release/X.Y` and becomes where patches for that line land directly (`X.Y.1`, `X.Y.2`, ...).
- A new `next/X.(Y+1)` (or `next/(X+1).0`) is cut from `main` once the next minor's feature work starts.
- If a later `next/X.(Y+1)` branch already exists when an earlier line ships a release, merge the released branch into it afterwards (`git merge release/X.Y`) so it inherits the release commit; otherwise its own eventual release won't be a valid fast-forward of the new `main`.

## The version-bump rule (easy to miss)

**As the first commit whenever you start work on a `next/X.Y` branch, and again as the first commit of any fix or feature that lands on a `release/X.Y` branch (a patch), bump `manifest.json`'s `version` to the target version (`X.Y.0` for a new minor, `X.Y.(Z+1)` for a patch) before pushing anything else.**

Why: every push to a `next/**` or `release/**` branch auto-publishes a beta tagged `<manifest version>-beta.N`. SemVer ranks a prerelease below its base version once that version has shipped, so `0.14.0-beta.51` sorts below the released `0.14.0`. Push a fix to `release/0.14` without bumping to `0.14.1` and the beta is `0.14.0-beta.N`; BRAT considers it older than the shipped `0.14.0` and silently keeps serving the old stable build. `manifest.json`'s version must equal the version you intend to ship next, at all times while a tracking branch has unreleased commits.

Only `manifest.json` is bumped by hand. `package.json` and `versions.json` are updated by `npm version` at stable release time (`version-bump.mjs` keeps `minAppVersion` and adds the `versions.json` entry only if it is missing).

## Beta builds (automatic)

- Every push to a `next/**` or `release/**` branch triggers `.github/workflows/beta-release.yml`, which builds the plugin and publishes a GitHub **pre-release** tagged `<manifest version>-beta.<run number>`. The workflow stamps the suffix into the build output only; nothing is committed back.
- Each push supersedes (deletes) the previous beta for that version line, so only the latest beta for a base version stays published.
- Testers install via [BRAT](https://github.com/TfTHacker/obsidian42-brat) with beta versions enabled.
- Verify with `gh release list --repo pablokvitca/note-narrator --limit 5 --json tagName,isPrerelease`.

## Stable releases

- The stable workflow (`.github/workflows/release.yml`) runs on a pushed tag, checks the tag equals `manifest.json`'s version, builds, and creates the GitHub release with `main.js`, `manifest.json` and `styles.css` attached. Tags have **no `v` prefix** (`.npmrc` sets `tag-version-prefix=""`). Plain `x.y.z` tags become stable releases; suffixed tags become pre-releases.
- **The repository uses immutable releases.** A published release's tag and assets cannot be changed, and a deleted release's tag name can never be reused (the `0.16.0` name was burned this way). Get the version right before pushing the tag; if a stable release goes wrong, ship a new version number.

## Special cases

- **Pushing several branches or force-pushing history** (for example after a history rewrite): every push to a `release/**` or `next/**` branch would publish a beta. Pause the workflow first: `gh workflow list --repo pablokvitca/note-narrator`, `gh workflow disable <Beta release id>`, push, then `gh workflow enable <id>`.
- **Creating `release/X.Y` from `main`** after a stable release: pause the beta workflow the same way, otherwise a stray `X.Y.Z-beta.N` (below the stable release) is published.
- **The PR was merged with rebase or squash** (`main` has new commit ids, the tracking branch tip is not an ancestor of `main`): release from `main`. Verify the trees match (`git diff origin/main <branch>` is empty), `git checkout main && git merge --ff-only origin/main`, run the checks, `npm version X.Y.Z -m "Release %s"` on `main`, `git push origin main --follow-tags`, then create `release/X.Y` from `main`. (This is how 0.17.0 was released.) A remote `next/X.Y` may already be auto-deleted; delete the local one.
- **`npm version` refuses because `package.json` already has the version**: set `package.json`'s version back to the previous stable first, then run it.
- **The beta of the version being released** (`X.Y.Z-beta.N`) stays listed as a pre-release after the stable release; BRAT ignores it. Ask the user before deleting it.
