#!/bin/sh
DOCUMENT_ROOT=/var/www/sources

# Use environment variable to determine deployment type
PRE_RELEASE=${PRE_RELEASE:-false}  # Default to false if not set

# Plugin file names (must be set via environment variables)
ICON_FILE=${ICON_FILE:?"ICON_FILE environment variable is required"}
SCRIPT_FILE=${SCRIPT_FILE:?"SCRIPT_FILE environment variable is required"}
CONFIG_FILE=${CONFIG_FILE:?"CONFIG_FILE environment variable is required"}
PLUGIN_NAME=${PLUGIN_NAME:?"PLUGIN_NAME environment variable is required"}

# Determine deployment directory
if [ "$PRE_RELEASE" = "true" ]; then
    RELATIVE_PATH="unstable/$PLUGIN_NAME"
else
    RELATIVE_PATH="$PLUGIN_NAME"
fi

DEPLOY_DIR="$DOCUMENT_ROOT/$RELATIVE_PATH"
PLUGIN_URL_ROOT="https://plugins.grayjay.app/$RELATIVE_PATH"
SOURCE_URL="$PLUGIN_URL_ROOT/$CONFIG_FILE"

# Take site offline
echo "Taking site offline..."
touch $DOCUMENT_ROOT/maintenance.file

# Swap over the content
echo "Deploying content..."
mkdir -p "$DEPLOY_DIR"
cp "$ICON_FILE" "$DEPLOY_DIR"
cp "$CONFIG_FILE" "$DEPLOY_DIR"
cp "$SCRIPT_FILE" "$DEPLOY_DIR"

# Update the sourceUrl in config file
echo "Updating sourceUrl in $CONFIG_FILE..."
jq --arg sourceUrl "$SOURCE_URL" '.sourceUrl = $sourceUrl' "$DEPLOY_DIR/$CONFIG_FILE" > "$DEPLOY_DIR/${CONFIG_FILE%.json}_temp.json"
if [ $? -eq 0 ]; then
    mv "$DEPLOY_DIR/${CONFIG_FILE%.json}_temp.json" "$DEPLOY_DIR/$CONFIG_FILE"
else
    echo "Failed to update $CONFIG_FILE" >&2
    exit 1
fi

sh sign.sh "$DEPLOY_DIR/$SCRIPT_FILE" "$DEPLOY_DIR/$CONFIG_FILE"

# Notify Cloudflare to wipe the CDN cache
echo "Purging Cloudflare cache for zone $CLOUDFLARE_ZONE_ID..."
curl -X POST "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/purge_cache" \
     -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
     -H "Content-Type: application/json" \
     --data '{"files":["'"$PLUGIN_URL_ROOT/$ICON_FILE"'", "'"$PLUGIN_URL_ROOT/$CONFIG_FILE"'", "'"$PLUGIN_URL_ROOT/$SCRIPT_FILE"'"]}'

# Take site back online
echo "Bringing site back online..."
rm "$DOCUMENT_ROOT/maintenance.file"
