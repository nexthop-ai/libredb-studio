import { getSession } from '@/lib/auth';
import { NextResponse } from 'next/server';
import { getStorageProvider } from '@/lib/storage/factory';

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }
  const provider = await getStorageProvider();

  if (!provider) {
      return NextResponse.json(
        { error: 'Server storage is not enabled' },
        { status: 404 }
      );
    }

  await provider.upsertUser(session.username, session.role);
  return NextResponse.json({ authenticated: true, user: session });
}
