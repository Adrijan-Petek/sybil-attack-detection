import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json(
    {
      error: 'Base onchain fetch is not configured.',
      hint: 'Set BASE_RPC_URL (or plug in an indexer) and implement transfer/event fetching.',
      requiredEnv: ['BASE_RPC_URL'],
    },
    { status: 501 },
  );
}

