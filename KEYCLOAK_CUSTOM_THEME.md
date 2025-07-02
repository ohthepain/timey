# Custom Keycloak Login Theme Setup

## Overview

Keycloak supports custom themes that allow you to completely customize the login, registration, and other authentication pages to match your application's design.

## Method 1: Custom Theme (Recommended)

### Step 1: Create Theme Directory Structure

```bash
# Create theme directory in Keycloak
mkdir -p keycloak/themes/timey/login
mkdir -p keycloak/themes/timey/email
mkdir -p keycloak/themes/timey/admin
```

### Step 2: Create Theme Properties

Create `keycloak/themes/timey/theme.properties`:

```properties
parent=keycloak
import=common/keycloak
styles=css/login.css
scripts=js/login.js
```

### Step 3: Create Custom Login Template

Create `keycloak/themes/timey/login/login.ftl`:

```ftl
<#import "template.ftl" as layout>
<@layout.registrationLayout displayInfo=social.displayInfo displayWide=(realm.password && social.providers??); section>
    <#if section = "header">
        ${msg("doLogIn")}
    <#elseif section = "form">
        <div class="login-container">
            <div class="login-box">
                <div class="login-header">
                    <h1>Welcome to Timey</h1>
                    <p>Sign in to continue your journey</p>
                </div>

                <form id="kc-form-login" onsubmit="login.disabled = true; return true;" action="${url.loginAction}" method="post">
                    <div class="form-group">
                        <label for="username">Username or Email</label>
                        <input tabindex="1" id="username" class="form-control" name="username" value="${(login.username!'')}"  type="text" autofocus autocomplete="off"
                               aria-invalid="<#if messagesPerField.existsError('username','password')>true</#if>"
                        />
                    </div>

                    <div class="form-group">
                        <label for="password">Password</label>
                        <input tabindex="2" id="password" class="form-control" name="password" type="password" autocomplete="off"
                               aria-invalid="<#if messagesPerField.existsError('username','password')>true</#if>"
                        />
                    </div>

                    <div class="form-options">
                        <#if realm.rememberMe && !usernameEditDisabled??>
                            <div class="checkbox">
                                <label>
                                    <#if login.rememberMe??>
                                        <input tabindex="3" id="rememberMe" name="rememberMe" type="checkbox" checked> ${msg("rememberMe")}
                                    <#else>
                                        <input tabindex="3" id="rememberMe" name="rememberMe" type="checkbox"> ${msg("rememberMe")}
                                    </#if>
                                </label>
                            </div>
                        </#if>
                    </div>

                    <div class="form-actions">
                        <input type="hidden" id="id-hidden-input" name="credentialId" <#if auth.selectedCredential?has_content>value="${auth.selectedCredential}"</#if>/>
                        <input tabindex="4" class="btn btn-primary btn-block btn-lg" name="login" id="kc-login" type="submit" value="${msg("doLogIn")}"/>
                    </div>
                </form>

                <div class="login-footer">
                    <#if realm.password>
                        <div><a href="${url.loginResetCredentialsUrl}">${msg("doForgotPassword")}</a></div>
                    </#if>
                    <#if realm.password && realm.registrationAllowed && !registrationDisabled??>
                        <div><a href="${url.registrationUrl}">${msg("doRegister")}</a></div>
                    </#if>
                </div>
            </div>
        </div>
    </#if>
</@layout.registrationLayout>
```

### Step 4: Create Custom CSS

Create `keycloak/themes/timey/login/resources/css/login.css`:

```css
.login-container {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

.login-box {
  background: white;
  border-radius: 12px;
  box-shadow: 0 20px 40px rgba(0, 0, 0, 0.1);
  padding: 40px;
  width: 100%;
  max-width: 400px;
}

.login-header {
  text-align: center;
  margin-bottom: 30px;
}

.login-header h1 {
  color: #333;
  font-size: 28px;
  font-weight: 600;
  margin-bottom: 8px;
}

.login-header p {
  color: #666;
  font-size: 16px;
  margin: 0;
}

.form-group {
  margin-bottom: 20px;
}

.form-group label {
  display: block;
  margin-bottom: 8px;
  color: #333;
  font-weight: 500;
  font-size: 14px;
}

.form-control {
  width: 100%;
  padding: 12px 16px;
  border: 2px solid #e1e5e9;
  border-radius: 8px;
  font-size: 16px;
  transition: border-color 0.2s ease;
  box-sizing: border-box;
}

.form-control:focus {
  outline: none;
  border-color: #667eea;
  box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
}

.form-options {
  margin-bottom: 20px;
}

.checkbox {
  display: flex;
  align-items: center;
}

.checkbox input[type='checkbox'] {
  margin-right: 8px;
}

.checkbox label {
  margin: 0;
  font-size: 14px;
  color: #666;
}

.form-actions {
  margin-bottom: 20px;
}

.btn {
  width: 100%;
  padding: 14px 20px;
  border: none;
  border-radius: 8px;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-primary {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
}

.btn-primary:hover {
  transform: translateY(-1px);
  box-shadow: 0 8px 20px rgba(102, 126, 234, 0.3);
}

.btn-primary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
  transform: none;
}

.login-footer {
  text-align: center;
  border-top: 1px solid #e1e5e9;
  padding-top: 20px;
}

.login-footer a {
  color: #667eea;
  text-decoration: none;
  font-size: 14px;
  margin: 0 10px;
}

.login-footer a:hover {
  text-decoration: underline;
}

/* Error messages */
.alert {
  padding: 12px 16px;
  border-radius: 8px;
  margin-bottom: 20px;
  font-size: 14px;
}

.alert-error {
  background: #fee;
  color: #c53030;
  border: 1px solid #feb2b2;
}

.alert-info {
  background: #e6fffa;
  color: #2c7a7b;
  border: 1px solid #9ae6b4;
}
```

### Step 5: Enable Custom Theme in Keycloak

1. Go to Keycloak Admin Console
2. Navigate to Realm Settings > Themes
3. Set Login Theme to "timey"
4. Save

## Method 2: Custom Login Form in Your App

If you want to handle login entirely in your app and just use Keycloak for token validation:

### Step 1: Create Custom Login Form

```tsx
// src/components/auth/CustomLoginForm.tsx
import { useState } from 'react';
import { useKeycloak } from '~/contexts/KeycloakContext';

export function CustomLoginForm() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { keycloak } = useKeycloak();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const success = await keycloak.login({
        username,
        password,
        redirectUri: window.location.origin,
      });

      if (!success) {
        setError('Invalid credentials');
      }
    } catch (err) {
      setError('Login failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="max-w-md w-full space-y-8">
        <div>
          <h2 className="text-center text-3xl font-extrabold text-gray-900">Sign in to Timey</h2>
        </div>

        <form className="mt-8 space-y-6" onSubmit={handleSubmit}>
          {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">{error}</div>}

          <div>
            <label htmlFor="username" className="block text-sm font-medium text-gray-700">
              Username or Email
            </label>
            <input
              id="username"
              name="username"
              type="text"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-gray-700">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
            />
          </div>

          <div>
            <button
              type="submit"
              disabled={loading}
              className="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
            >
              {loading ? 'Signing in...' : 'Sign in'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
```

## Method 3: Hybrid Approach

Use Keycloak's theme for the initial login but handle password reset, registration, etc. in your app.

## Recommendation

**Use Method 1 (Custom Theme)** because:

- ✅ Full control over design
- ✅ Consistent with Keycloak's security model
- ✅ Handles all edge cases (password reset, account lockout, etc.)
- ✅ No need to handle sensitive data in your app
- ✅ Keycloak handles security best practices

The custom theme approach gives you complete design control while maintaining Keycloak's robust security features.
