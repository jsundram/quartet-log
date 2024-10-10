#!/bin/bash

for md in *.md; do
    f=$(basename "$md" .md)
    pandoc -f gfm -t html5 -o $f.html $f.md --css github-markdown.css --embed-resources -s --metadata title=" " --template _pt.html
done

./snapshot.sh

# assumes aws command line tool is installed and configured
aws s3 sync . s3://viz.runningwithdata.com/musiclog \
    --exclude "*.csv" \
    --exclude "*.md" \
    --exclude "*.py" \
    --exclude "*.sh" \
    --exclude "*.zip" \
    --exclude "github-markdown.css" \
    --exclude .DS_Store
