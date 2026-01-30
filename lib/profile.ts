// lib/profile.ts - Profile link scanning functions

function sanitizeUrlCandidate(candidate: string): string {
  return candidate.trim().replace(/[)\]}>,.]+$/g, '');
}

function isValidHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function normalizeLinks(links: string[]): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const raw of links) {
    const candidate = sanitizeUrlCandidate(raw);
    if (!candidate) continue;
    if (!isValidHttpUrl(candidate)) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    deduped.push(candidate);
  }
  return deduped;
}

export function extractLinks(bio: string): string[] {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return normalizeLinks(bio.match(urlRegex) || []);
}

export function isSuspiciousDomain(url: string): boolean {
  const suspiciousDomains = [
    'bit.ly',
    'tinyurl.com',
    't.co',
    'goo.gl',
    'rebrand.ly',
    'cutt.ly',
    'is.gd',
    's.id',
    'shorturl.at',
    'talent.app',
    'spam.example.com',
  ]; // Add more as needed
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    const domain = hostname.startsWith('www.') ? hostname.slice(4) : hostname;
    return suspiciousDomains.some((blocked) => domain === blocked || domain.endsWith(`.${blocked}`));
  } catch {
    return false;
  }
}

export function sharedLinkCount(actors: string[], linksMap: Map<string, string[]>): number {
  const allLinks = new Set<string>();
  actors.forEach(actor => {
    const links = linksMap.get(actor) || [];
    links.forEach(link => allLinks.add(link));
  });
  return allLinks.size;
}

export function linkDiversityScore(links: string[]): number {
  if (links.length === 0) return 1;
  const domains = new Set(links.map(link => {
    try {
      return new URL(link).hostname;
    } catch {
      return link;
    }
  }));
  return domains.size / links.length;
}

export function updateProfileAnomalyScore(actor: string, links: string[], followerCount?: number, followingCount?: number): number {
  let score = 0;
  if (followerCount !== undefined && followingCount !== undefined && followingCount > 0) {
    if (followerCount / followingCount < 0.1) score += 0.5;
  }
  if (links.some(link => isSuspiciousDomain(link))) score += 0.3;
  if (linkDiversityScore(links) < 0.5) score += 0.2;
  return Math.min(score, 1);
}

export function computeSharedLinksByActor(linksByActor: Map<string, string[]>): Map<string, string[]> {
  const actorsByLink = new Map<string, Set<string>>();
  for (const [actor, links] of linksByActor.entries()) {
    for (const link of normalizeLinks(links)) {
      const existing = actorsByLink.get(link) ?? new Set<string>();
      existing.add(actor);
      actorsByLink.set(link, existing);
    }
  }

  const sharedLinksByActor = new Map<string, string[]>();
  for (const [actor, links] of linksByActor.entries()) {
    const shared = normalizeLinks(links).filter((link) => (actorsByLink.get(link)?.size ?? 0) > 1);
    sharedLinksByActor.set(actor, shared);
  }
  return sharedLinksByActor;
}
