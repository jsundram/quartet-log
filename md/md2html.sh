#!/bin/bash
for md in *.md; do
    # CLAUDE.md is agent guidance scoped to this directory, not a site page.
    [ "$md" = "CLAUDE.md" ] && continue
    f=$(basename "$md" .md)
    pandoc -f gfm -t html5 -o $f.html $f.md --css github-markdown.css --embed-resources -s --metadata title=" " --template _pandoc_template.html
done
