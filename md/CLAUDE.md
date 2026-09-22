# md/

`howto.md` is the user-facing record of the sheet's conventions, and the app
enforces what it promises. "Create the form" (the Google Form needs `Other`
enabled on Composer) and all of part 3 — which column holds which part,
`(instrument)` annotations, a blank cell dittos while `Others?` cannot, write a
full name the first time you log someone — are load-bearing: changing one of
them is a change to the reader, not just to the docs.

**Cite its sections by quoted heading, not by number.** `src/` and the root
`CLAUDE.md` both point into this file, the numbers have already moved twice,
and a grep for the heading text finds both ends.

Everything else about this directory — how pandoc is invoked, why its output
goes straight to `$DEPLOY/`, and why `CLAUDE.md` is skipped by name — is
commented in `build.sh` at the loop that does it.
