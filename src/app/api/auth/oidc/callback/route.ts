import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { login } from '@/lib/auth';
import {
  getOIDCConfig,
  getAdminUserEmails,
  discoverProvider,
  exchangeCode,
  decryptState,
  mapOIDCRole,
  getPublicOrigin,
} from '@/lib/oidc';
import { getStorageProvider } from '@/lib/storage/factory';
import { logger } from '@/lib/logger';

export async function GET(request: Request) {
  const origin = getPublicOrigin(request);

  try {
    const cookieStore = await cookies();
    const stateCookie = cookieStore.get('oidc-state')?.value;

    if (!stateCookie) {
      return NextResponse.redirect(`${origin}/login?error=oidc_state_missing`);
    }

    // Decrypt and validate state
    let oidcState;
    try {
      oidcState = await decryptState(stateCookie);
    } catch (decryptError) {
      logger.warn('OIDC state decryption failed', { route: 'GET /api/auth/oidc/callback', error: decryptError instanceof Error ? decryptError.message : 'Unknown' });
      cookieStore.delete('oidc-state');
      return NextResponse.redirect(`${origin}/login?error=oidc_state_invalid`);
    }

    // Exchange code for tokens
    const oidcConfig = getOIDCConfig();
    const config = await discoverProvider(oidcConfig);

    // Reconstruct callback URL with public origin for token exchange
    const internalUrl = new URL(request.url);
    const callbackUrl = new URL(
      `${internalUrl.pathname}${internalUrl.search}`,
      origin
    );

    const claims = await exchangeCode(
      config,
      callbackUrl,
      oidcState.code_verifier,
      oidcState.state,
      oidcState.nonce
    );

    if (!claims) {
      logger.warn('OIDC callback: no claims returned from token exchange', { route: 'oidc/callback' });
      return NextResponse.redirect(`${origin}/login?error=oidc_no_claims`);
    }

    const adminUsers = getAdminUserEmails();
    // Map role from claims
    const role = mapOIDCRole(
      claims,
      oidcConfig.adminGroups,
      adminUsers
    );

    // Create local JWT session (same as password login)
    const username = claims.email || claims.preferred_username;
    const groups = claims.groups || [];
    await login(role, groups, username);

    // Persist the user row here — not from /api/auth/me, which is hit on
    // every page load and would let a stale role overwrite a fresh one
    // every few seconds.
    if (username) {
      try {
        const provider = await getStorageProvider();
        if (provider) {
          await provider.upsertUser(username, role);
        }
      } catch (err) {
        logger.warn('upsertUser failed during OIDC callback', {
          route: 'GET /api/auth/oidc/callback',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Clean up state cookie
    cookieStore.delete('oidc-state');

    // Redirect based on role
    return NextResponse.redirect(
      `${origin}${role === 'admin' ? '/admin' : '/'}`
    );
  } catch (error) {
    logger.error('OIDC callback error', error, { route: 'GET /api/auth/oidc/callback' });
    const errorCode = error instanceof Error && error.message.includes('config') ? 'oidc_config' : 'oidc_failed';
    return NextResponse.redirect(`${origin}/login?error=${errorCode}`);
  }
}
