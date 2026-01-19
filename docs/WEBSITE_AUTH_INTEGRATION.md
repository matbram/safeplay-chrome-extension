# Website Authentication Integration for Chrome Extension

This document describes the changes required on the SafePlay website to complete the authentication integration with the Chrome extension.

## Overview

The Chrome extension has been updated to support user authentication. When a user signs in via the extension, they are redirected to the website login page. After successful login, the website needs to send the authentication token and user data back to the extension.

## Required Changes

### 1. Update `/api/user/profile` Route to Support Bearer Token Authentication

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

### 2. Add Extension Authentication Callback

After a user logs in on the website, if they came from the extension (indicated by query parameters), send the auth token back to the extension.

**Option A: Add to existing login success handler**

In your login page or auth callback, add this logic:

```typescript
// After successful login
useEffect(() => {
  async function handleExtensionAuth() {
    const params = new URLSearchParams(window.location.search);
    const extensionId = params.get('extension');
    const callback = params.get('callback');

    if (extensionId && callback === 'extension' && session) {
      try {
        // Get user profile data
        const profileResponse = await fetch('/api/user/profile');
        const profileData = await profileResponse.json();

        // Send auth data to extension
        chrome.runtime.sendMessage(extensionId, {
          type: 'AUTH_TOKEN',
          token: session.access_token,
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
          if (response?.success) {
            // Optionally show success message or close tab
            window.close();
          }
        });
      } catch (error) {
        console.error('Failed to send auth to extension:', error);
      }
    }
  }

  handleExtensionAuth();
}, [session]);
```

**Option B: Create a dedicated extension callback page**

**File:** `src/app/extension/page.tsx`

```typescript
'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

export default function ExtensionAuthPage() {
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [message, setMessage] = useState('Connecting to extension...');

  useEffect(() => {
    async function sendAuthToExtension() {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();

      if (!session) {
        // Redirect to login with extension callback
        const params = new URLSearchParams(window.location.search);
        const extensionId = params.get('extension') || '';
        window.location.href = `/login?extension=${extensionId}&callback=extension`;
        return;
      }

      const params = new URLSearchParams(window.location.search);
      const extensionId = params.get('extension');

      if (!extensionId) {
        setStatus('error');
        setMessage('No extension ID provided');
        return;
      }

      try {
        // Fetch profile data
        const profileResponse = await fetch('/api/user/profile');
        const profileData = await profileResponse.json();

        // Send to extension
        chrome.runtime.sendMessage(extensionId, {
          type: 'AUTH_TOKEN',
          token: session.access_token,
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
          if (response?.success) {
            setStatus('success');
            setMessage('Successfully connected! You can close this tab.');
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

    sendAuthToExtension();
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center">
        {status === 'loading' && (
          <>
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-red-500 mx-auto mb-4" />
            <p>{message}</p>
          </>
        )}
        {status === 'success' && (
          <>
            <div className="text-green-500 text-5xl mb-4">✓</div>
            <p className="text-green-600">{message}</p>
          </>
        )}
        {status === 'error' && (
          <>
            <div className="text-red-500 text-5xl mb-4">✗</div>
            <p className="text-red-600">{message}</p>
          </>
        )}
      </div>
    </div>
  );
}
```

### 3. Handle Logout Sync (Optional but Recommended)

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

### 4. Environment Variables

Add the extension ID to your environment:

```env
NEXT_PUBLIC_EXTENSION_ID=your-chrome-extension-id-here
```

## Extension Authentication Flow

1. User clicks "Sign In" in the extension popup
2. Extension opens: `https://your-website.com/login?extension={extensionId}&callback=extension`
3. User logs in on the website
4. Website detects the extension parameters and sends auth data via `chrome.runtime.sendMessage()`
5. Extension receives the token and stores it
6. Extension can now make authenticated API requests with `Authorization: Bearer {token}`

## Message Format

The extension expects this message format:

```typescript
{
  type: 'AUTH_TOKEN',
  token: string,           // Supabase access token
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

## Testing

1. Install the extension in Chrome (load unpacked from `dist/` folder)
2. Note the extension ID from `chrome://extensions`
3. Update your website's `NEXT_PUBLIC_EXTENSION_ID` environment variable
4. Click "Sign In" in the extension popup
5. Log in on the website
6. Verify the extension shows your account info

## Security Notes

- The extension only accepts messages from allowed origins (configured in `manifest.json` under `externally_connectable`)
- Tokens are stored in `chrome.storage.local` (only accessible to the extension)
- The website should verify the extension ID before sending sensitive data
