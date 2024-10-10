#!/bin/bash

# Function to get the most recent file's modification time
get_latest_mod_time() {
    find "$1" -type f -exec stat -f "%m" {} + | sort -n | tail -1
}

# Check if last_deploy folder exists
if [ -d "last_deploy" ]; then
    # Get the timestamp of the most recent file
    timestamp=$(get_latest_mod_time "last_deploy")
    formatted_time=$(date -r "$timestamp" +"%Y-%m-%dT%H:%M:%S")
    
    # Create zip archive
    zip -r "${formatted_time}.zip" last_deploy
    
    # Remove the old last_deploy folder
    rm -rf last_deploy
fi

# Create new last_deploy folder
mkdir last_deploy

# Copy all files (excluding update.sh and zip files) to last_deploy
find . -maxdepth 1 -type f ! -name "update.sh" ! -name "*.zip" -exec cp {} last_deploy/ \;

echo "Deployment files updated in last_deploy folder."
