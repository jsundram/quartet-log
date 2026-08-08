# Markdown pages (pandoc)

`md/about.md` and `md/howto.md` are rendered to `about.html` and `howto.html` by pandoc, using `md/_pandoc_template.html`. The template includes inline CSS + a small JS snippet that gives the markdown pages the same hamburger menu + site title chrome as the SPA. Menu items on the static pages link back to `index.html#main` / `#calendar` / `#dashboard` / `about.html` (the `Download Data` and `Log Out` items are omitted since they need SPA context).

Pandoc reads `gfm+attributes+implicit_figures` so `![alt](path){width=600px}` syntax works and images-alone-in-a-paragraph auto-wrap as `<figure>` with the alt text as the caption. The build runs pandoc with output written **directly** to `$DEPLOY/` (not via `md/`) so fswatch on `md/` doesn't see write events and spin in a rebuild loop.
