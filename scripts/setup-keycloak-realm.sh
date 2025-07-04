#!/bin/bash

# Setup script for Keycloak realm and client
echo "Setting up Keycloak realm and client for Timey..."

# Keycloak admin credentials
KEYCLOAK_URL="http://localhost:8080"
ADMIN_USERNAME="admin"
ADMIN_PASSWORD="admin"
REALM_NAME="timey"
CLIENT_ID="timey-client"

# Get admin token
echo "🔐 Getting admin token..."
ADMIN_TOKEN=$(curl -s -X POST \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=$ADMIN_USERNAME&password=$ADMIN_PASSWORD&grant_type=password&client_id=admin-cli" \
  "$KEYCLOAK_URL/realms/master/protocol/openid-connect/token" | jq -r '.access_token')

if [ "$ADMIN_TOKEN" = "null" ] || [ -z "$ADMIN_TOKEN" ]; then
    echo "❌ Failed to get admin token. Make sure Keycloak is running and admin credentials are correct."
    exit 1
fi

echo "✅ Admin token obtained"

# Create realm
echo "🏗️  Creating realm '$REALM_NAME'..."
REALM_RESPONSE=$(curl -s -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"realm\":\"$REALM_NAME\",\"enabled\":true}" \
  "$KEYCLOAK_URL/admin/realms")

if [ $? -eq 0 ]; then
    echo "✅ Realm '$REALM_NAME' created successfully"
else
    echo "⚠️  Realm might already exist or there was an issue"
fi

# Create client
echo "🔧 Creating client '$CLIENT_ID'..."
CLIENT_RESPONSE=$(curl -s -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"clientId\":\"$CLIENT_ID\",
    \"enabled\":true,
    \"publicClient\":true,
    \"standardFlowEnabled\":true,
    \"directAccessGrantsEnabled\":true,
    \"redirectUris\":[\"http://localhost:3000/*\",\"http://localhost:3001/*\"],
    \"webOrigins\":[\"http://localhost:3000\",\"http://localhost:3001\"]
  }" \
  "$KEYCLOAK_URL/admin/realms/$REALM_NAME/clients")

if [ $? -eq 0 ]; then
    echo "✅ Client '$CLIENT_ID' created successfully"
else
    echo "⚠️  Client might already exist or there was an issue"
fi

# Create a test user
echo "👤 Creating test user..."
USER_RESPONSE=$(curl -s -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"username\":\"testuser\",
    \"enabled\":true,
    \"email\":\"test@example.com\",
    \"firstName\":\"Test\",
    \"lastName\":\"User\",
    \"credentials\":[{
      \"type\":\"password\",
      \"value\":\"password\",
      \"temporary\":false
    }]
  }" \
  "$KEYCLOAK_URL/admin/realms/$REALM_NAME/users")

if [ $? -eq 0 ]; then
    echo "✅ Test user 'testuser' created successfully"
    echo "   Username: testuser"
    echo "   Password: password"
else
    echo "⚠️  Test user might already exist or there was an issue"
fi

# Configure theme
echo "🎨 Configuring theme..."
THEME_RESPONSE=$(curl -s -X PUT \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"realm\":\"$REALM_NAME\",
    \"loginTheme\":\"timey\"
  }" \
  "$KEYCLOAK_URL/admin/realms/$REALM_NAME")

if [ $? -eq 0 ]; then
    echo "✅ Theme 'timey' configured successfully"
else
    echo "⚠️  Theme configuration might have failed"
fi

echo ""
echo "🎉 Keycloak setup complete!"
echo ""
echo "Test login:"
echo "- Username: testuser"
echo "- Password: password"
echo ""
echo "Keycloak Admin Console: http://localhost:8080 (admin/admin)" 