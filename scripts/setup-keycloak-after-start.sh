#!/bin/bash

# Wait for Keycloak to be ready
echo "Waiting for Keycloak to be ready..."
until curl -s http://localhost:8080/health > /dev/null 2>&1; do
  sleep 2
done

echo "Keycloak is ready, setting up realm..."

# Get admin token
ADMIN_TOKEN=$(curl -s -X POST \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=admin&password=admin&grant_type=password&client_id=admin-cli" \
  "http://localhost:8080/realms/master/protocol/openid-connect/token" | jq -r '.access_token')

if [ "$ADMIN_TOKEN" = "null" ] || [ -z "$ADMIN_TOKEN" ]; then
    echo "❌ Failed to get admin token"
    exit 1
fi

echo "✅ Admin token obtained"

# Check if realm exists
REALM_EXISTS=$(curl -s -X GET "http://localhost:8080/admin/realms/timey" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.realm')

if [ "$REALM_EXISTS" = "timey" ]; then
    echo "✅ Realm 'timey' already exists"
else
    echo "🏗️  Creating realm 'timey'..."
    curl -s -X POST \
      -H "Authorization: Bearer $ADMIN_TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"realm\":\"timey\",\"enabled\":true}" \
      "http://localhost:8080/admin/realms"
    echo "✅ Realm 'timey' created"
fi

# Check if client exists
CLIENT_EXISTS=$(curl -s -X GET "http://localhost:8080/admin/realms/timey/clients" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.[] | select(.clientId == "timey-client") | .clientId')

if [ "$CLIENT_EXISTS" = "timey-client" ]; then
    echo "✅ Client 'timey-client' already exists"
else
    echo "🔧 Creating client 'timey-client'..."
    curl -s -X POST \
      -H "Authorization: Bearer $ADMIN_TOKEN" \
      -H "Content-Type: application/json" \
      -d "{
        \"clientId\":\"timey-client\",
        \"enabled\":true,
        \"publicClient\":true,
        \"standardFlowEnabled\":true,
        \"directAccessGrantsEnabled\":true,
        \"redirectUris\":[\"http://localhost:3000/*\",\"http://localhost:3001/*\",\"http://localhost:3002/*\"],
        \"webOrigins\":[\"http://localhost:3000\",\"http://localhost:3001\",\"http://localhost:3002\"]
      }" \
      "http://localhost:8080/admin/realms/timey/clients"
    echo "✅ Client 'timey-client' created"
fi

# Check if test user exists
USER_EXISTS=$(curl -s -X GET "http://localhost:8080/admin/realms/timey/users" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.[] | select(.username == "testuser") | .username')

if [ "$USER_EXISTS" = "testuser" ]; then
    echo "✅ Test user 'testuser' already exists"
else
    echo "👤 Creating test user..."
    curl -s -X POST \
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
      "http://localhost:8080/admin/realms/timey/users"
    echo "✅ Test user 'testuser' created"
fi

echo "🎉 Keycloak setup complete!"
echo ""
echo "Test login:"
echo "- Username: testuser"
echo "- Password: password"
echo ""
echo "Keycloak Admin Console: http://localhost:8080 (admin/admin)" 