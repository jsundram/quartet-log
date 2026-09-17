# md/

`howto.md` is the user-facing record of the sheet's conventions, and the app
enforces what it promises. §1 (the Google Form needs `Other` enabled on
Composer), §5 (`(instrument)` annotations), §6 (a blank cell dittos, `Others?`
cannot) and §7 (write a full name the first time you log someone) are all
load-bearing: changing one of them is a change to the reader, not just to the
docs.

Everything else about this directory — how pandoc is invoked, why its output
goes straight to `$DEPLOY/`, and why `CLAUDE.md` is skipped by name — is
commented in `build.sh` at the loop that does it.
