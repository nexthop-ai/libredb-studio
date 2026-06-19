/**
 * PUT /api/storage/[collection]
 * Updates a single storage collection for the authenticated user.
 * Only works when server storage is enabled.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getStorageProvider } from '@/lib/storage/factory';
import { STORAGE_COLLECTIONS, type StorageCollection, type StorageData } from '@/lib/storage/types';
import type { DatabaseConnection } from '@/lib/types';
import { createErrorResponse } from '@/lib/api/errors';

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ collection: string }> }
) {
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

    const { collection } = await params;

    if (!STORAGE_COLLECTIONS.includes(collection as StorageCollection)) {
      return NextResponse.json(
        { error: `Invalid collection: ${collection}` },
        { status: 400 }
      );
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON in request body' },
        { status: 400 }
      );
    }

    if (body.data === undefined || body.data === null) {
      return NextResponse.json(
        { error: 'Missing required field: data' },
        { status: 400 }
      );
    }

    const col = collection as StorageCollection;

    if (col === 'connections') {
      // Connections live in their own table, keyed by group rather than user.
      await provider.setDbConnections(body.data as DatabaseConnection[]);
    } else {
      // Everything else is part of the per-user data blob. Read-modify-write
      // the single collection so the rest of the blob is preserved; connections
      // are stripped since they are stored separately.
      const userId = await provider.userExists(session.username);
      if(!userId){
        return createErrorResponse(`user ${session.username} does not exists`, { route: 'PUT /api/storage/[collection]' });
      }
      const current = await provider.getUserData(userId);
      delete current.connections;
      const next = { ...current, [col]: body.data } as StorageData;
      await provider.setUserData(userId, next);
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return createErrorResponse(error, { route: 'PUT /api/storage/[collection]' });
  }
}
