#!/bin/bash
# deps: esbuild 0.24.2, pandoc 3.6.2 
#
DEPLOY="./last_deploy"

# Check for production flag
PROD=$([[ "$1" == "--prod" ]] && echo true || echo false)

# Ensure deploy directory exists and is clean
rm -rf $DEPLOY
mkdir -p $DEPLOY

# Process markdown files
pushd md/
for md in *.md; do
    f=$(basename "$md" .md)
    pandoc -f gfm -t html5 -o $f.html $f.md \
        --css github-markdown.css \
        --embed-resources -s \
        --metadata title=" " \
        --template _pandoc_template.html
done
popd
echo "Converted md files to html"
# Generated HTML pages
mv md/TODO.html $DEPLOY/
mv md/about.html $DEPLOY/
mv md/setup.html $DEPLOY/

# Copy all required files to deploy directory, flattening
cp index.html $DEPLOY/
cp static/css/viz.css $DEPLOY/
cp static/data/all_works.json $DEPLOY/

# wget -O d3.v7.min.js https://unpkg.com/d3@7.9.0/dist/d3.min.js
cp static/js/d3.v7.min.js $DEPLOY/

# Favicon files (including manifest)
cp -r static/favicon/* $DEPLOY/

# The browser targets were arrived at by noticing that the array.at()
# method (used in calendarComponent.js) was added in:
#   * Chrome 92 (Jul 2021)
#   * Firefox 90 (Jul 2021)
#   * Safari 15.4 (Mar 2022)
#   * Edge 92 (Jul 2021)
BASE_ESBUILD_CMD="esbuild src/app.js \
    --bundle \
    --target=chrome92,firefox90,safari15.4,edge92 \
    --format=iife \
    --global-name=App \
    --outfile=$DEPLOY/bundle.js"

if [[ "$PROD" == true ]]; then
    echo "Building for production..."
    eval "$BASE_ESBUILD_CMD \
        --minify \
        --tree-shaking=true"
else
    echo "Building for development..."
    eval "$BASE_ESBUILD_CMD \
        --sourcemap \
        --watch \
        --servedir=$DEPLOY"
fi

echo -e "\nBuild complete. Files in deploy directory:"
ls -la $DEPLOY
echo -e "\nBundle size:"
ls -lh $DEPLOY/bundle.js
