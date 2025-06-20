#!/bin/bash

echo "🚀 Setting up Keycloak for Timey application..."

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo "❌ Docker is not running. Please start Docker and try again."
    exit 1
fi

# Start Keycloak with PostgreSQL
echo "📦 Starting Keycloak with PostgreSQL..."
docker-compose up -d

# Wait for Keycloak to be ready
echo "⏳ Waiting for Keycloak to start..."
until curl -s http://localhost:8080/health > /dev/null 2>&1; do
    echo "   Waiting for Keycloak to be ready..."
    sleep 5
done

echo "✅ Keycloak is running at http://localhost:8080"
echo "✅ PostgreSQL is running at localhost:5432"
echo ""
echo "🔧 Next steps:"
echo "1. Open http://localhost:8080 in your browser"
echo "2. Login with admin/admin"
echo "3. Create a new realm called 'timey'"
echo "4. Create a new client with ID 'timey-client'"
echo "5. Set Valid Redirect URIs to: http://localhost:3001/*"
echo "6. Set Web Origins to: http://localhost:3001"
echo "7. Create a test user"
echo ""
echo "📖 See KEYCLOAK_SETUP.md for detailed instructions"
echo ""
echo "🚀 Start your application with: npm run dev"
echo ""
echo "💡 To stop Keycloak: docker-compose down"
echo "💡 To view logs: docker-compose logs -f keycloak" 