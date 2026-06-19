/**
 * GET /api/storage/groups
 * Returns the access groups the authenticated user belongs to, used to let the
 * user pick which group a new db connection should be placed into.
 * Only works when server storage is enabled.
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getStorageProvider } from '@/lib/storage/factory';
import { createErrorResponse } from '@/lib/api/errors';

export async function GET() {
  try {
    const provider = await getStorageProvider();
    if (!provider) {
      return NextResponse.json(
        { error: 'Server storage is not enabled' },
        { status: 404 }
      );
    }

    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const userId = await provider.userExists(session.username);
    if (!userId) {
      return createErrorResponse(`user ${session.username} does not exists`, {
        route: 'GET /api/storage/groups',
      });
    }

    const groups = await provider.getGroupsByUserId(userId);
    return NextResponse.json({ groups });
  } catch (error) {
    return createErrorResponse(error, { route: 'GET /api/storage/groups' });
  }
}
