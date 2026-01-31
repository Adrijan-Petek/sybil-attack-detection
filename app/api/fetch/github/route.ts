import { NextResponse } from 'next/server';
import { rateLimit } from '../../../../lib/rateLimit';

type GithubStargazer = {
  starred_at?: string;
  user?: { login?: string | null } | null;
};

async function fetchAllPages<T>(url: string, init: RequestInit, maxPages: number): Promise<T[]> {
  const results: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const paged = new URL(url);
    paged.searchParams.set('per_page', '100');
    paged.searchParams.set('page', String(page));
    const res = await fetch(paged.toString(), init);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GitHub API error ${res.status}: ${text || res.statusText}`);
    }
    const data = (await res.json()) as T[];
    results.push(...data);
    if (data.length < 100) break;
  }
  return results;
}

export async function GET(req: Request) {
  const rl = rateLimit(req, { key: 'fetch_github', max: 30, windowMs: 60_000 });
  if (!rl.allowed) return NextResponse.json({ error: 'Rate limited. Try again later.' }, { status: 429 });

  const { searchParams } = new URL(req.url);
  const repo = (searchParams.get('repo') || '').trim(); // owner/name
  const maxPages = Math.min(Math.max(Number.parseInt(searchParams.get('maxPages') || '3', 10) || 3, 1), 20);

  if (!repo || !repo.includes('/')) {
    return NextResponse.json({ error: 'Missing or invalid `repo` (expected owner/name).' }, { status: 400 });
  }

  const token = process.env.GITHUB_TOKEN;
  const headers: HeadersInit = {
    Accept: 'application/vnd.github+json, application/vnd.github.v3.star+json',
    'User-Agent': 'sybil-shield',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const apiUrl = `https://api.github.com/repos/${repo}/stargazers`;
  const stargazers = await fetchAllPages<GithubStargazer>(apiUrl, { headers, cache: 'no-store' }, maxPages);

  const logs = stargazers
    .map((s) => ({
      timestamp: s.starred_at || new Date().toISOString(),
      platform: 'github',
      action: 'star',
      actor: (s.user?.login || '').trim(),
      target: repo,
      meta: JSON.stringify({ repo }),
    }))
    .filter((l) => l.actor);

  return NextResponse.json({
    repo,
    fetchedAt: new Date().toISOString(),
    stargazers: logs.length,
    logs,
  });
}
