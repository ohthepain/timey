# Registration and Authentication Flow

## Overview

The application uses Keycloak for authentication and user management. The registration flow is designed to work seamlessly with Keycloak's built-in registration system while ensuring users exist in both Keycloak and the local database.

## Registration Flow

1. **User visits `/signup`** - Shows a simple registration page
2. **User clicks "Continue to Registration"** - Redirects to Keycloak's registration page
3. **User fills out Keycloak registration form** - Creates account in Keycloak
4. **User is redirected back to the app** - Keycloak handles the registration
5. **User logs in for the first time** - The `ensureKeycloakUser` function automatically creates a corresponding user in the local database

## Authentication Flow

1. **User visits `/login`** - Shows login page
2. **User clicks "Sign in with Keycloak"** - Redirects to Keycloak login
3. **User authenticates with Keycloak** - Keycloak validates credentials
4. **User is redirected back to the app** - App receives authentication token
5. **App ensures user exists in local database** - `ensureKeycloakUser` creates local user if needed
6. **User can now perform authenticated actions** - Create methods, modules, beats, etc.

## Key Components

### `ensureKeycloakUser` Function

- Located in `src/lib/ensureKeycloakUser.ts`
- Checks if authenticated Keycloak user exists in local database
- Creates local user record if not found
- Returns user ID for use in API calls

### API Endpoints

All protected API endpoints use `requireKeycloakUser()` to:

- Ensure user is authenticated
- Get the authenticated user's ID
- Use that ID as the `authorId` for created resources

### Keycloak Configuration

- Realm: `timey`
- Admin credentials: `admin/admin`
- Custom theme: `timey` (located in `keycloak-theme/`)
- Registration enabled: Yes

## Environment Variables

The following environment variables should be set:

```bash
# Database
DATABASE_URL="postgresql://username:password@localhost:5432/timey_db"

# Keycloak
KEYCLOAK_URL="http://localhost:8080"
KEYCLOAK_REALM="timey"
KEYCLOAK_CLIENT_ID="timey-client"
```

## Testing the Flow

1. Start the application and Keycloak:

   ```bash
   docker-compose up -d
   npm run dev
   ```

2. Visit `http://localhost:3000/signup`

3. Complete registration through Keycloak

4. Log in and try creating a method - it should work with your user as the author

## Security Notes

- Users must be authenticated to perform any create/update operations
- The `ensureKeycloakUser` function only creates local users for already-authenticated Keycloak users
- No unauthenticated access is allowed to protected endpoints
- All user data is validated and sanitized
