#!/bin/bash

# Export Keycloak realm to JSON file
# Usage: ./export_realm.sh [target_filename]

# Check if target filename is provided
if [ $# -eq 0 ]; then
    TARGET_FILE="keycloak-theme/realm-export.json"
else
    TARGET_FILE="$1"
fi

echo "Exporting realm using Keycloak CLI..."

# Export realm using Keycloak CLI
docker exec keycloak /opt/keycloak/bin/kc.sh export \
    --realm timey \
    --dir /tmp/export \
    --users realm_file

# Check if export was successful
if [ $? -eq 0 ]; then
    echo "✅ Realm exported successfully using CLI"
    
    # Copy the exported file to the target location
    docker cp keycloak:/tmp/export/timey-realm.json "$TARGET_FILE"
    
    if [ $? -eq 0 ]; then
        echo "✅ Realm exported successfully to: $TARGET_FILE"
        echo "📁 File size: $(ls -lh "$TARGET_FILE" | awk '{print $5}')"
    else
        echo "❌ Error: Failed to copy exported file"
        exit 1
    fi
else
    echo "❌ Error: Failed to export realm using CLI"
    exit 1
fi
