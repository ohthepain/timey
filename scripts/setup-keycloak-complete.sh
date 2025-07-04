#!/bin/bash

# Complete Keycloak setup script for Timey
echo "🚀 Complete Keycloak Setup for Timey"
echo "====================================="

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo "❌ Docker is not running. Please start Docker and try again."
    exit 1
fi

# Stop any existing containers
echo "🛑 Stopping existing containers..."
docker-compose down > /dev/null 2>&1

# Start services
echo "🐳 Starting Keycloak and PostgreSQL..."
docker-compose up -d

# Wait for services to be ready
echo "⏳ Waiting for services to start..."
sleep 10

# Check if Keycloak is ready
echo "🔍 Checking if Keycloak is ready..."
MAX_ATTEMPTS=30
ATTEMPT=0

while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
    if curl -s -f http://localhost:8080 > /dev/null 2>&1; then
        echo "✅ Keycloak is ready!"
        break
    fi
    
    ATTEMPT=$((ATTEMPT + 1))
    echo "⏳ Waiting for Keycloak... (attempt $ATTEMPT/$MAX_ATTEMPTS)"
    sleep 5
done

if [ $ATTEMPT -eq $MAX_ATTEMPTS ]; then
    echo "❌ Keycloak failed to start within the expected time."
    echo "Check the logs with: docker-compose logs keycloak"
    exit 1
fi

# Run the realm setup script
echo "🔧 Setting up realm and theme..."
./scripts/setup-keycloak-realm.sh

echo ""
echo "🎉 Complete setup finished!"
echo ""
echo "Your Keycloak instance is now ready with:"
echo "• Realm: timey"
echo "• Client: timey-client"
echo "• Theme: timey (custom theme)"
echo "• Test user: testuser / password"
echo ""
echo "Access points:"
echo "• Keycloak Admin Console: http://localhost:8080 (admin/admin)"
echo "• Your app should now work with authentication!"
echo ""
echo "To stop services: docker-compose down"
echo "To view logs: docker-compose logs -f" 