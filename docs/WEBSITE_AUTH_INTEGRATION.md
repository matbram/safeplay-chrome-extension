# Website Authentication Integration for Chrome Extension

This document describes the changes required on the SafePlay website to complete the authentication integration with the Chrome extension.

## Overview

The Chrome extension has been updated to support user authentication. When a user signs in via the extension, they are redirected to a dedicated extension auth page on the website. This page checks if the user is already logged in:

- **If already logged in**: Sends auth token to the extension immediately (no login required!)
- **If not logged in**: Redirects to login page, then sends token after successful login

## Required Changes

### 1. Create the Extension Auth Page (REQUIRED)

This is the main entry point when users click "Sign In" in the extension. The extension opens:
```
https://your-website.com/extension/auth?extensionId={extensionId}
```

**File:** `src/app/extension/auth/page.tsx`

```typescript
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

export default function ExtensionAuthPage() {
  const [status, setStatus] = useState<'loading' | 'success' | 'error' | 'redirecting'>('loading');
  const [message, setMessage] = useState('Checking authentication...');
  const router = useRouter();

  useEffect(() => {
    async function handleAuth() {
      const params = new URLSearchParams(window.location.search);
      const extensionId = params.get('extensionId');

      if (!extensionId) {
        setStatus('error');
        setMessage('No extension ID provided. Please try again from the extension.');
        return;
      }

      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();

      if (!session) {
        // Not logged in - redirect to login with callback
        setStatus('redirecting');
        setMessage('Redirecting to login...');
        // Store extensionId in sessionStorage for after login
        sessionStorage.setItem('extensionAuthId', extensionId);
        router.push(`/login?redirect=/extension/auth?extensionId=${extensionId}`);
        return;
      }

      // Already logged in - send token to extension immediately
      setMessage('Connecting to extension...');
      await sendAuthToExtension(extensionId, session);
    }

    async function sendAuthToExtension(extensionId: string, session: any) {
      try {
        // Fetch profile data
        const profileResponse = await fetch('/api/user/profile');
        if (!profileResponse.ok) {
          throw new Error('Failed to fetch profile');
        }
        const profileData = await profileResponse.json();

        // Check if chrome.runtime is available
        if (typeof chrome === 'undefined' || !chrome.runtime) {
          setStatus('error');
          setMessage('Unable to communicate with extension. Make sure the SafePlay extension is installed.');
          return;
        }

        // Send to extension (including refresh token for auto-refresh)
        chrome.runtime.sendMessage(extensionId, {
          type: 'AUTH_TOKEN',
          token: session.access_token,
          refreshToken: session.refresh_token,           // For auto-refresh when token expires
          expiresAt: session.expires_at,                 // Token expiry timestamp (seconds)
          userId: session.user.id,
          tier: profileData.subscription?.plans?.name?.toLowerCase() || 'free',
          user: profileData.user,
          subscription: profileData.subscription,
          userCredits: profileData.credits,
          credits: {
            available: profileData.credits?.available_credits || 0,
            used_this_period: profileData.credits?.used_this_period || 0,
            plan_allocation: profileData.subscription?.plans?.monthly_credits || 30,
            percent_consumed: profileData.subscription?.plans?.monthly_credits
              ? (profileData.credits?.used_this_period / profileData.subscription.plans.monthly_credits) * 100
              : 0,
            plan: profileData.subscription?.plans?.name?.toLowerCase() || 'free',
          }
        }, (response) => {
          if (chrome.runtime.lastError) {
            setStatus('error');
            setMessage('Failed to connect to extension. Please make sure the SafePlay extension is installed and try again.');
            return;
          }

          if (response?.success) {
            setStatus('success');
            setMessage('Successfully connected! This tab will close automatically.');
            // Auto-close after 2 seconds
            setTimeout(() => window.close(), 2000);
          } else {
            setStatus('error');
            setMessage('Failed to connect to extension. Please try again.');
          }
        });
      } catch (error) {
        console.error('Extension auth error:', error);
        setStatus('error');
        setMessage('An error occurred. Please try again.');
      }
    }

    handleAuth();
  }, [router]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
      <div className="text-center p-8 max-w-md">
        {status === 'loading' && (
          <>
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-red-500 mx-auto mb-4" />
            <p className="text-gray-600 dark:text-gray-300">{message}</p>
          </>
        )}
        {status === 'redirecting' && (
          <>
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto mb-4" />
            <p className="text-gray-600 dark:text-gray-300">{message}</p>
          </>
        )}
        {status === 'success' && (
          <>
            <div className="text-green-500 text-6xl mb-4">✓</div>
            <h2 className="text-xl font-semibold text-green-600 dark:text-green-400 mb-2">Connected!</h2>
            <p className="text-gray-600 dark:text-gray-300">{message}</p>
          </>
        )}
        {status === 'error' && (
          <>
            <div className="text-red-500 text-6xl mb-4">✗</div>
            <h2 className="text-xl font-semibold text-red-600 dark:text-red-400 mb-2">Connection Failed</h2>
            <p className="text-gray-600 dark:text-gray-300 mb-4">{message}</p>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 transition"
            >
              Try Again
            </button>
          </>
        )}
      </div>
    </div>
  );
}
```

### 2. Update Login Page to Handle Extension Callback

After successful login, check if the user came from the extension and redirect back to the auth page:

**In your login success handler or auth callback:**

```typescript
// After successful login
useEffect(() => {
  if (session) {
    const params = new URLSearchParams(window.location.search);
    const redirect = params.get('redirect');

    // Check if this is an extension auth flow
    if (redirect?.includes('/extension/auth')) {
      // Redirect back to extension auth page which will send the token
      router.push(redirect);
      return;
    }

    // Normal login redirect
    router.push('/dashboard');
  }
}, [session, router]);
```

### 3. Update `/api/user/profile` Route to Support Bearer Token Authentication

The profile API route needs to accept Bearer token authentication (in addition to session cookies) so the extension can fetch user profile data.

**File:** `src/app/api/user/profile/route.ts`

```typescript
import { createClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";

// Helper to authenticate from either session or Bearer token
async function authenticateRequest(request: NextRequest) {
  const supabase = await createClient();

  // First, try Bearer token authentication (for extension)
  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (!error && user) {
      return { user, supabase };
    }
  }

  // Fall back to session authentication (for website)
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) {
    return { user: null, supabase, error: "Unauthorized" };
  }

  return { user, supabase };
}

export async function GET(request: NextRequest) {
  try {
    const { user, supabase, error: authError } = await authenticateRequest(request);

    if (authError || !user) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    // Get user profile
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .single();

    if (profileError) {
      return NextResponse.json(
        { error: "Failed to fetch profile" },
        { status: 500 }
      );
    }

    // Get subscription with plan details
    const { data: subscription } = await supabase
      .from("subscriptions")
      .select("*, plans(*)")
      .eq("user_id", user.id)
      .single();

    // Get credit balance
    const { data: credits } = await supabase
      .from("credit_balances")
      .select("*")
      .eq("user_id", user.id)
      .single();

    return NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        ...profile,
      },
      subscription,
      credits,
    });
  } catch (error) {
    console.error("Profile fetch error:", error);
    return NextResponse.json(
      { error: "An unexpected error occurred" },
      { status: 500 }
    );
  }
}
```

### 4. Handle Logout Sync (Optional but Recommended)

When a user logs out on the website, notify the extension:

```typescript
// In your logout handler
async function handleLogout() {
  // Your existing logout logic...

  // Notify extension about logout
  const extensionId = process.env.NEXT_PUBLIC_EXTENSION_ID;
  if (extensionId && typeof chrome !== 'undefined' && chrome.runtime) {
    try {
      chrome.runtime.sendMessage(extensionId, { type: 'LOGOUT' });
    } catch (e) {
      // Extension not installed, ignore
    }
  }
}
```

### 5. Environment Variables

Add the extension ID to your environment:

```env
NEXT_PUBLIC_EXTENSION_ID=your-chrome-extension-id-here
```

## Authentication Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     User clicks "Sign In" in extension                       │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│            Extension opens: /extension/auth?extensionId={id}                 │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
                        ┌─────────────────────────┐
                        │  User already logged in? │
                        └─────────────────────────┘
                           │                 │
                          YES                NO
                           │                 │
                           ▼                 ▼
              ┌────────────────────┐  ┌─────────────────────────┐
              │ Send token to      │  │ Redirect to /login      │
              │ extension via      │  │ with redirect param     │
              │ chrome.runtime     │  └─────────────────────────┘
              │ .sendMessage()     │              │
              └────────────────────┘              ▼
                           │         ┌─────────────────────────┐
                           │         │ User logs in            │
                           │         └─────────────────────────┘
                           │                      │
                           │                      ▼
                           │         ┌─────────────────────────┐
                           │         │ Redirect back to        │
                           │         │ /extension/auth         │
                           │         └─────────────────────────┘
                           │                      │
                           │                      ▼
                           │         ┌─────────────────────────┐
                           │         │ Send token to extension │
                           │         └─────────────────────────┘
                           │                      │
                           ▼                      ▼
              ┌─────────────────────────────────────────────────┐
              │        Extension receives token & stores it      │
              │        Shows user profile in popup               │
              │        Tab auto-closes                           │
              └─────────────────────────────────────────────────┘
```

## Message Format

The extension expects this message format:

```typescript
{
  type: 'AUTH_TOKEN',
  token: string,           // Supabase access token
  refreshToken: string,    // Supabase refresh token (for auto-refresh)
  expiresAt: number,       // Token expiry timestamp in seconds (from session.expires_at)
  userId: string,          // User ID
  tier: string,            // Plan name lowercase (e.g., 'free', 'individual')
  user: {
    id: string,
    email: string,
    full_name?: string,
    avatar_url?: string,
  },
  subscription: {
    id: string,
    user_id: string,
    plan_id: string,
    status: string,
    plans?: {
      id: string,
      name: string,
      monthly_credits: number,
    }
  } | null,
  userCredits: {
    user_id: string,
    available_credits: number,
    used_this_period: number,
    rollover_credits: number,
  } | null,
  credits: {
    available: number,
    used_this_period: number,
    plan_allocation: number,
    percent_consumed: number,
    plan: string,
  }
}
```

### 6. Create Token Refresh API Endpoint (REQUIRED)

The extension will automatically refresh tokens when they expire. Create this endpoint:

**File:** `src/app/api/auth/refresh/route.ts`

```typescript
import { createClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const { refresh_token } = await request.json();

    if (!refresh_token) {
      return NextResponse.json(
        { error: "Refresh token is required" },
        { status: 400 }
      );
    }

    const supabase = await createClient();

    // Use the refresh token to get a new session
    const { data, error } = await supabase.auth.refreshSession({
      refresh_token,
    });

    if (error || !data.session) {
      return NextResponse.json(
        { error: "Invalid or expired refresh token" },
        { status: 401 }
      );
    }

    return NextResponse.json({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at,
    });
  } catch (error) {
    console.error("Token refresh error:", error);
    return NextResponse.json(
      { error: "An unexpected error occurred" },
      { status: 500 }
    );
  }
}
```

## Token Refresh Behavior

The extension automatically handles token refresh:

1. **Proactive Refresh**: When making API calls, the extension checks if the token will expire within 5 minutes. If so, it automatically refreshes before making the request.

2. **401 Recovery**: If an API call returns 401 Unauthorized, the extension attempts to refresh the token and retry the request once.

3. **Refresh Failure**: If token refresh fails (invalid/expired refresh token), the user is prompted to sign in again.

4. **Token Expiry**: Supabase access tokens typically expire after 1 hour. Refresh tokens have a longer lifespan (configurable in Supabase settings, default is 1 week).

## Testing

1. Install the extension in Chrome (load unpacked from `dist/` folder)
2. Note the extension ID from `chrome://extensions`
3. Update your website's `NEXT_PUBLIC_EXTENSION_ID` environment variable
4. **Test Case 1 - Not logged in:**
   - Click "Sign In" in the extension popup
   - Should redirect to login page
   - Log in on the website
   - Should redirect back to /extension/auth and send token
   - Extension should show your account info
5. **Test Case 2 - Already logged in:**
   - Log in on the website first
   - Click "Sign In" in the extension popup
   - Should immediately send token (no login required!)
   - Extension should show your account info

## Security Notes

- The extension only accepts messages from allowed origins (configured in `manifest.json` under `externally_connectable`)
- Tokens are stored in `chrome.storage.local` (only accessible to the extension)
- The website should verify the extension ID before sending sensitive data
- Always use HTTPS in production
