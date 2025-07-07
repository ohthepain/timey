#!/bin/bash

# Get admin token from Keycloak
ADMIN_TOKEN=$(curl -s -X POST \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "username=admin&password=admin&grant_type=password&client_id=admin-cli" \
    "http://localhost:8080/realms/master/protocol/openid-connect/token" | \
    jq -r '.access_token')

echo "Admin token: $ADMIN_TOKEN" 
