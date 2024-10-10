#!/bin/bash

DEPLOY="./last_deploy"

# Function to get the most recent file's modification time
get_latest_mod_time() {
    find "$1" -type f -exec stat -f "%m" {} + | sort -n | tail -1
}

# Check if $DEPLOY folder exists and archive the previous deploy
if [ -d $DEPLOY ]; then
    # Get the timestamp of the most recent file
    timestamp=$(get_latest_mod_time "$DEPLOY")
    formatted_time=$(date -r "$timestamp" +"%Y-%m-%dT%H-%M-%S")
    
    # Create zip archive
    zip -r "./archive/${formatted_time}.zip" last_deploy
    
    # Remove the old $DEPLOY folder
    rm -rf $DEPLOY
fi

# Create new $DEPLOY folder
mkdir $DEPLOY

pushd md/
for md in *.md; do
    f=$(basename "$md" .md)
    pandoc -f gfm -t html5 -o $f.html $f.md --css github-markdown.css --embed-resources -s --metadata title=" " --template _pt.html
done
popd

echo "Converted md files to html"

# Manually select files to copy; it's a short list.
cp d3.v7.min.js $DEPLOY
cp favicon/* $DEPLOY
cp index.html $DEPLOY
cp viz.css $DEPLOY
cp viz.js $DEPLOY
cp md/calendar.png $DEPLOY
mv md/TODO.html $DEPLOY
mv md/about.html $DEPLOY


echo "Deployment files updated in $DEPLOY."

# assumes aws command line tool is installed and configured
aws s3 sync --delete $DEPLOY s3://viz.runningwithdata.com/musiclog 

echo "$DEPLOY synced to s3://viz.runningwithdata.com/musiclog"
