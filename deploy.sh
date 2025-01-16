#!/bin/bash
# Assumes aws command line tools are installed and configured.
# aws-cli/2.15.3 Python/3.11.6 Darwin/24.1.0 exe/x86_64 prompt/off
DEPLOY="./last_deploy"

 
if [ -d $DEPLOY ]; then
    # Upload
    aws s3 sync --delete $DEPLOY s3://viz.runningwithdata.com/musiclog 
    echo "$DEPLOY synced to s3://viz.runningwithdata.com/musiclog"

    datetime=$(date +"%Y-%m-%dT%H-%M-%S")
    
    # Archive the deployed bits 
    zip -r "./archive/$(date +"%Y-%m-%dT%H-%M-%S").zip" $DEPLOY
else
    echo "$DEPLOY not found. Did you run ./build.sh?"
fi
