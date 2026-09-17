# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working with this repository.

This file holds what spans files, or what you need *before* you know which file
to open: non-guessable commands, cross-file constraints, safety prohibitions,
and decisions review keeps re-proposing. Everything else lives where it applies
— a comment at the line, the commit that made the change, or one of the two
directory-scoped files (`md/`, `scripts/`), which hold only what the code in
that directory doesn't already say. Read **Where rationale goes** before
adding to this file; it should stay small.

## Build, test, deploy

```bash
./build.sh                    # dev: watch + local server on :8000 (--port to override)
./build.sh --prod             # runs npm test first; also generates sw.js + version.json
npm test                      # node:test over test/*.mjs, no external deps
npm run lint                  # eslint flat config
npm run typecheck             # tsc --noEmit over // @ts-check'd files
npm run test:e2e              # Playwright; build with ./build.sh --prod first
npm run audit                 # data-quality audits (see scripts/CLAUDE.md)
npm run attribution           # just the decaying findings
npm run overlap               # score this file's claims against source comments
```

Three callers screen new `CLAUDE.md` prose against the comments it may be
restating: a `PostToolUse` hook at the edit, a pre-commit hook, and a PR job
that writes the same report to the checks page. None of them blocks anything.
**When one flags a claim, open the file it names before writing more**: drop the
claim if that comment already makes it, move it to the line if it belongs there,
and keep it only when it says something no single file can. The percentages look
low by design; `scripts/claudemd_overlap.mjs` carries the measurement.

Push to `main` deploys to <https://log.quartetroulette.com> via GitHub Actions.
PR CI runs test, lint, typecheck and Playwright; all actions in both workflows
are pinned to commit SHAs.

Dev traffic is served through `scripts/dev_proxy.mjs` on `$PORT`, which stamps
`Cache-Control: no-store` on everything esbuild serves from `$PORT+1`. **Use the
proxy's URL, not the `:$PORT+1` one esbuild prints** — esbuild's server can't
set headers, so browsers reuse a stale `bundle.js` across same-session
navigations. Prod doesn't need this; its assets are content-hashed.

`.dev-data-url` (gitignored, one line) makes the dev build print a preconfigured
`?data=…` URL, so you skip the setup prompt.

Typechecking is opt-in per file via a leading `// @ts-check` — currently the
data layer and the build scripts. The canonical row shape is the `Row` typedef
in `src/dataProcessor.js`; reuse it as `import('./dataProcessor.js').Row`.
`tsconfig.json` keeps `strict` on but `noImplicitAny` off, so imports from
unannotated modules flow as `any`.

Node 26 is pinned in `.nvmrc` and `engines`. fswatch is optional (dev watch
mode only). pandoc's version and .deb sha256 are single-sourced in
`package.json` `"config"`, and the deploy workflow checksum-verifies them.

## Layout

Vanilla JS + D3 v7 SPA, no framework, no build-time templating. Each user
configures their own published Google Sheet URL in localStorage; the site
refetches it on every visit behind a cache-first boot.

- Four hash-routed views — `#main`, `#calendar`, `#dashboard`, `#log` — plus two
  static pandoc pages. `NavigationComponent` owns routing.
- `src/app.js` orchestrates: owns the data, wires components, runs `filterData()`.
- **`src/dataProcessor.js` is pure and imports nothing.** Keep it that way. It is
  what lets the audits, the tests and the log form reuse the app's own rules
  instead of reimplementing them, and every place one of those reimplemented a
  rule is a bug in this repo's history.
- The log form is four modules split by what they answer: `formConfig` (where
  does a row go), `logEntry` (what is a row), `logStore` (what survives a
  reload), `logComponent` (the UI). Everything but the send works offline.
- `src/catalog.js` is data-driven from `static/data/all_works.json`. Adding
  another multi-composer tab (`5+`, `MISC`) is a JSON-only change.

## Alias privacy

`src/aliases.js` holds ~40 real people's full names. **It is gitignored and must
never be committed.** This repo is public.

`src/aliases.stub.js` and `scripts/ensure_aliases.mjs` document the
stub/secret mechanism at the top of each. Two things that aren't in either:

- **Run `scripts/push_aliases.sh` after editing the tables.** Nothing does it
  automatically, and the next deploy builds from the secret, not from your disk.
- Accepted residue: the real names are in git history (pre-extraction
  `src/config.js`) and in the served bundle of any deploy that has the secret. A
  history rewrite was explicitly declined.

**The name tables are an argument, never an import** — in `src/`, in `scripts/`
and in tests alike. `src/aliases.js` is real names locally and the empty stub in
CI, so anything importing it passes in both places while testing two different
things. This has bitten twice. `dataProcessor.js` and `scripts/lib/cli.mjs` each
carry the local half of the rule; the cross-file half is that only
`src/dataService.js` and `scripts/fetch_processed.mjs` import the tables at all.

Fixture names come from a published list — Alice/Bob/Carol, and when more are
needed, an Atlantic hurricane list walked in order. **Don't screen that list
against the log.** A name from a published list says nothing about who is in the
log either way; filtering it would make the omissions themselves say who is.

## The processing order is load-bearing

`DataService.processData` runs `prepareRows` → `fillForward` →
`normalizePlayerNames` → drop partial movements. Three separate things break if
the middle two are swapped, and it has already been a source of bugs:

1. `fillForward` resolves a bare name that repeats a full one from the same
   session by matching the text the logger typed. Normalize first and `Peter` an
   hour after `Peter Dutilly` becomes `Peter Ouyang` — local evidence beaten by
   a global default, on exactly the ambiguous rows that matter.
2. The two tables are a chain: `PLAYER_ABBREVIATIONS` maps a letter to a short
   name, and `PLAYER_ALIASES` maps that short name to a full one. Aliasing first
   leaves the expansion un-canonicalized.
3. `fillForward` copies the column string, while `normalizePlayerNames` has
   already moved the `(instrument)` annotation into the parallel
   `playerInstruments` array — so a filled slot loses its annotation, breaking
   the carry-forward `md/howto.md` §6 promises.

A useful consequence of the current order: a cell the sheet's own repetition
resolves never reaches an alias at all.

## Gotchas

Each of these looked fine and wasn't.

- **One tooltip.** Every component renders into the single body-level `#tooltip`
  via `src/tooltip.js`. Tap-outside dismissal matches by ancestry against a
  WeakSet of registered triggers, **never a class-name allowlist**. Same
  reasoning in `pullToRefresh.js`'s `startsInScroller`: a structural test covers
  a new scrollable panel for free.
- **A component that bakes a color at render time must re-render on theme
  change.** `onThemeChange()` calls `invalidateColorCache()` first, then each
  component's rerender. Anything using only `var(--…)` in CSS updates for free.
  `static/css/viz.css` is the canonical source of part colors.
- **The e2e spec is not a boot smoke test.** Most of it drives the log form and
  asserts on the **submitted request body**, because that form's failures are
  invisible on screen — carried extras that display and submit empty, a
  redirected write target, a removed player who comes back. Three of the five
  defects one review found were that shape. Anything below the DOM's notice — a
  placeholder, a fitted dropdown height, the phone form layout — is pinned there
  because nothing else can see it.

## The sheet's conventions

What a blank cell means, how `(instrument)` annotations read, and why a column
nobody is on is written `-`: `md/howto.md` §5–§7 is the user-facing statement,
and `dataProcessor.js`'s `fillForward` and `logEntry.js`'s seat rules each carry
the reasoning for their half. Read those before changing how a row is parsed —
the app, the log form and the audits encode the same conventions separately.

## The pwa-starter contract

`src/pullToRefresh.js`, `src/updateChecker.js` and `static/sw.js` share ideas
with [pwa-starter](https://github.com/jsundram/pwa-starter), which tracks
provenance per file with `// pwa-starter: <file> @ <sha>` stamps.

**Never stamp them.** They are independent implementations, not vendored copies.
A file-level stamp would report them behind every upstream commit regardless of
whether it touched anything they share. `check-downstream.py` listing
`src/pullToRefresh.js` under "unstamped copies" and `src/updateChecker.js` under
"discovery-only" is expected and correct, not a task.

**`src/pullToRefresh.js` is the ancestor** — pwa-starter's version was written
from it.

**The flow is two-way.** This repo originated the cache-first paint (`3322370`)
and the empty-payload guard (`fd71bde`, which became upstream's `ddd9ab8`), so
being reported "behind" those is backwards. When something here turns out to be
general, **port it upstream first** rather than leaving it here and relying on
remembering — that is the exact failure the stamp mechanism exists to prevent.
Upstream currently names two standing pull-back candidates from the #8 hardening
pass: the `version.json` probe and the `gen_sw.mjs` codegen.

Upstream's `PROPAGATE.md` is the authority and it moves; re-read it before
syncing either direction.

## Where rationale goes

One test: **will somebody redo this decision if they don't see it?**

- **No** → the commit message or PR. The default, and where most of it belongs.
  It is attached to the change, `git blame` finds it, it costs nothing per
  session, and it cannot go stale because it describes a moment rather than the
  present.
- **Yes, while editing a particular line** → a comment there. `defaultSlotParts`
  carries one: review has twice proposed scoping its inheritance to the session
  window, and the note is what stopped a third round. A commit message three
  weeks back would not have.
- **Yes, before you know which file to open** → this file, or the nearest
  directory-scoped one. Cross-file constraints, non-guessable commands, safety
  prohibitions.

**Comments say why, never how.** The reader is a software engineer or an LLM;
neither needs the code explained. Sort by what a comment describes, not by how
long it is: anything that walks through the code beneath it goes, while a fact
from another module or a rejected alternative stays. Mechanism comments rot
silently because nothing tests them — one four-line function here had
accumulated fifteen lines describing three implementations of itself, two
already deleted. After a behaviour change, grep for the vocabulary of what you
removed; rot clusters, and a reviewer reading for sense will not find it all.

Anonymize every example (Alice/Bob, never a real collaborator).

## Other conventions

- **Python**: `uv run --with <pkg> python …` for one-off scripts and tools. Don't
  try `pip install` — environments here are isolated via `uv`.
- **Don't prepend `cd <current-dir>`** to commands that need permission; it
  changes the matched string and triggers redundant prompts. Use absolute paths,
  or `(cd path && cmd)` in a subshell only when the tool genuinely needs a
  different cwd (pandoc resolving relative image paths).
- **Don't destructively overwrite user-supplied assets.** Write the transform to
  a new path (`*-redacted.png`) so the source can be reused, unless in-place
  editing was asked for.
- **Verify before claiming done.** `npm test` for behaviour changes; pandoc plus
  a grep of the output for markdown changes.
- **Focused commits** with present-tense imperative messages, not kitchen-sink
  ones.

## Gitignored / untracked things to know

- `src/aliases.js` — the real name tables. See **Alias privacy**.
- `archive/data-raw.csv` — the raw sheet, refreshed by `scripts/fetch_raw.sh`.
  The single input to every audit. Personal data.
- `archive/data.csv` — the processed export, mirroring the "Download Data"
  button. No audit reads it. Personal data.
- `.dev-data-url`, `last_deploy/`, `alias-output.txt`, `archive/*.zip`.

- `md/*.html` — pandoc used to write here and now writes straight to
  `last_deploy/`; the glob stays ignored as a safety net, with
  `!md/_pandoc_template.html`.
