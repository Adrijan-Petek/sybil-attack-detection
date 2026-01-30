import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json(
    {
      error: 'Talent Protocol fetch is not configured.',
      hint: 'Provide a Talent API integration or export your data and use Upload / Import from URLs.',
    },
    { status: 501 },
  );
}

