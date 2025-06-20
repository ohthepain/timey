# Keycloak Setup Guide

This guide will help you set up Keycloak authentication for the Timey application.

## Prerequisites

- Docker and Docker Compose installed
- Node.js and npm installed

## Step 1: Start Keycloak

1. Start Keycloak using Docker Compose:

   ```bash
   docker-compose up -d
   ```

2. Wait for Keycloak to start (this may take a few minutes). You can check the logs with:

   ```bash
   docker-compose logs -f keycloak
   ```

3. Access Keycloak Admin Console at: http://localhost:8080
   - Username: `admin`
   - Password: `admin`

## Step 2: Create a Realm

1. In the Keycloak Admin Console, click on the dropdown in the top-left corner
2. Click "Create Realm"
3. Enter "timey" as the realm name
4. Click "Create"

## Step 3: Create a Client

1. In the left sidebar, click "Clients"
2. Click "Create"
3. Configure the client:

   - **Client ID**: `timey-client`
   - **Client Protocol**: `openid-connect`
   - Click "Save"

4. Configure the client settings:

   - **Access Type**: `public`
   - **Valid Redirect URIs**: `http://localhost:3000/*` (or whatever port your app uses)
   - **Web Origins**: `http://localhost:3000` (or whatever port your app uses)
   - Click "Save"

   **Note**: If your app is running on a different port (like 3001), use that port instead of 3000.

## Step 4: Create a User

1. In the left sidebar, click "Users"
2. Click "Add user"
3. Fill in the user details:

   - **Username**: `testuser`
   - **Email**: `test@example.com`
   - **First Name**: `Test`
   - **Last Name**: `User`
   - Click "Save"

4. Set a password:
   - Click on the "Credentials" tab
   - Set a password (e.g., `password`)
   - Turn off "Temporary" if you want the password to be permanent
   - Click "Save"

## Step 5: Configure Environment Variables

Create a `.env` file in your project root:

```env
VITE_KEYCLOAK_URL=http://localhost:8080
VITE_KEYCLOAK_REALM=timey
VITE_KEYCLOAK_CLIENT_ID=timey-client
```

## Step 6: Start the Application

1. Install dependencies:

   ```bash
   npm install
   ```

2. Start the development server:

   ```bash
   npm run dev
   ```

3. Note the port your application is running on (check the terminal output)
   - It might be `http://localhost:3000/` or `http://localhost:3001/` or another port
   - Update the Keycloak client configuration to match this port

## Step 7: Test Authentication

1. You should see a login form when you're not authenticated
2. Click "Sign in with Keycloak" to be redirected to Keycloak's login page
3. Log in with the test user credentials
4. You should be redirected back to your application and see the user menu

## Customization

### Custom Login UI

The application includes custom login and registration forms. You can modify these components in:

- `src/components/auth/LoginForm.tsx`
- `src/components/auth/RegisterForm.tsx`

### Server-Side Authentication

For server-side authentication, the application uses the `getKeycloakUser()` function in `src/lib/keycloakAuth.ts`. This function:

- Extracts the JWT token from the Authorization header
- Decodes the token to get user information
- Returns user details for use in your server functions

### Production Deployment

For production deployment:

1. **Keycloak Hosting**: You can either:

   - Self-host Keycloak on your own infrastructure
   - Use Keycloak Cloud (managed service)
   - Use a cloud provider's Keycloak offering

2. **Environment Variables**: Update the environment variables with your production Keycloak URL and configuration

3. **Token Validation**: In production, implement proper JWT token validation using Keycloak's public key

4. **HTTPS**: Ensure all communication uses HTTPS in production

## Troubleshooting

### Keycloak Won't Start

- Check if port 8080 is already in use
- Check Docker logs: `docker-compose logs keycloak`

### Authentication Not Working

- Verify the client configuration in Keycloak
- Check that redirect URIs match your application URL (including the correct port)
- Ensure the realm name matches your configuration

### CORS Issues

- Verify Web Origins are configured correctly in the Keycloak client
- Check that your application URL (including port) is included in the allowed origins

### Environment Variables Not Working

- Make sure environment variables are prefixed with `VITE_`
- Restart the development server after changing `.env` file
- Check that the `.env` file is in the project root directory

### Wrong Port Configuration

- Check what port your application is actually running on
- Update the Keycloak client's Valid Redirect URIs and Web Origins to match
- Common ports: 3000, 3001, 5173 (Vite default)

## Security Notes

- The current implementation includes basic JWT token decoding
- For production, implement proper JWT signature verification
- Store sensitive configuration in environment variables
- Use HTTPS in production
- Regularly update Keycloak and dependencies
