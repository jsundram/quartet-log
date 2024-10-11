#!/bin/bash
DEPLOY="./last_deploy"

# Nuke previous build. 
# TODO: will this cause problems for http.server serving this locally?
rm -rf $DEPLOY
mkdir $DEPLOY


pushd md/
for md in *.md; do
    f=$(basename "$md" .md)
    pandoc -f gfm -t html5 -o $f.html $f.md --css github-markdown.css --embed-resources -s --metadata title=" " --template _pandoc_template.html
done
popd
echo "Converted md files to html"


# Manually select files to copy; it's a short list.
cp d3.v7.min.js $DEPLOY
cp favicon/* $DEPLOY
cp index.html $DEPLOY
cp viz.css $DEPLOY
cp viz.js $DEPLOY
mv md/TODO.html $DEPLOY
mv md/about.html $DEPLOY

echo "Build updated in $DEPLOY."
