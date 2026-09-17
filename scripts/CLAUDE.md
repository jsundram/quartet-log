# scripts/

The audits comment their own design at 42–65% density; read the module. Two
things are not in any of them.

## Alias maintenance in practice

The owner records a surname only where the first name is ambiguous. Fourteen
people in the log have no surname anywhere, including the three most frequent
collaborators. **That is deliberate, not an oversight to fix** — a bare `Alice`
is unambiguous today and 1908 rows deep.

The alias table is for the other case, where a surname is known but was never
typed into the sheet. Eleven entries are currently the only record of one, which
is why backing up `src/aliases.js` is a standing risk the audit names.

New people arrive at roughly 12/month, very unevenly: 1–4 in quiet months, 20–28
after a camp or a trip, since that is where first-name-only entry happens in
bulk. `md/howto.md` §7 carries the upstream fix — a full name on first entry for
anyone new — which is what stops the ambiguity being created at all.

## Attribution's scope is deliberate

It takes only `bare` subjects. An *initialled* name ("Peter O.") is a real gap,
tracked as [#32](https://github.com/jsundram/quartet-log/issues/32) and left open
on purpose: covering it changes what the tool reports rather than how it is
built.
