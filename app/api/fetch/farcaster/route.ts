import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json(
    {
      error: 'Farcaster fetch is not configured.',
      hint: 'Set NEYNAR_API_KEY (or add a Farcaster hub integration) and implement the fetcher.',
      requiredEnv: ['NEYNAR_API_KEY'],
    },
    { status: 501 },
  );
}

