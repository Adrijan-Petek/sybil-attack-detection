import type { EdgeDefinition, ElementDefinition, NodeDefinition } from 'cytoscape';
import { computeSharedLinksByActor, extractLinks, isSuspiciousDomain, linkDiversityScore, normalizeLinks, updateProfileAnomalyScore } from './profile';
import { computeHandlePatternScores, isLikelyPhishingUrl } from './scam';

export type LogEntry = {
  timestamp: string;
  actor: string;
  target: string;
  action: string;
  platform: string;
  bio?: string;
  links?: string[];
  followerCount?: number;
  followingCount?: number;
  amount?: number;
  txHash?: string;
  blockNumber?: number;
  meta?: string;
  targetType?: string;
  actorCreatedAt?: string;
  verified?: boolean;
  location?: string;
};

export type DetailedCluster = {
  clusterId: number;
  members: string[];
  density: number;
  conductance: number;
  externalEdges: number;
};

export type WaveResult = {
  windowStart: string;
  windowEnd: string;
  action: string;
  target: string;
  actors: string[];
  zScore: number;
};

export type AnalysisSettings = {
  threshold: number;
  minClusterSize: number;
  timeBinMinutes: number;
  waveMinCount: number;
  waveMinActors: number;
  positiveActions: string[];
  churnActions: string[];
};

export type ActorScorecard = {
  actor: string;
  sybilScore: number;
  churnScore: number;
  coordinationScore: number;
  noveltyScore: number;
  clusterIsolationScore: number;
  lowDiversityScore: number;
  profileAnomalyScore: number;
  links: string[];
  suspiciousLinks: string[];
  sharedLinks: string[];
  linkDiversity: number;
  reciprocalRate: number;
  burstRate: number;
  newAccountScore: number;
  bioSimilarityScore: number;
  handlePatternScore: number;
  phishingLinkScore: number;
  reasons: string[];
};

export type AnalysisResult = {
  elements: ElementDefinition[];
  clusters: DetailedCluster[];
  waves: WaveResult[];
  scorecards: ActorScorecard[];
};

export type AnalyzeProgress =
  | { stage: 'start'; pct: number }
  | { stage: 'profiles'; pct: number }
  | { stage: 'graph'; pct: number }
  | { stage: 'clusters'; pct: number }
  | { stage: 'waves'; pct: number }
  | { stage: 'scorecards'; pct: number }
  | { stage: 'done'; pct: number };

export function analyzeLogs(input: { logs: LogEntry[]; settings: AnalysisSettings; onProgress?: (p: AnalyzeProgress) => void }): AnalysisResult {
  const { logs, settings, onProgress } = input;
  const report = (p: AnalyzeProgress) => onProgress?.(p);
  report({ stage: 'start', pct: 0 });

  if (logs.length === 0) return { elements: [], clusters: [], waves: [], scorecards: [] };

  const allTimes = logs.map((l) => new Date(l.timestamp).getTime()).filter((t) => Number.isFinite(t));
  const datasetStartMs = allTimes.length > 0 ? Math.min(...allTimes) : Date.now();

  // Collect profile data
  const actorProfiles: Record<
    string,
    { bio?: string; links?: string[]; followerCount?: number; followingCount?: number; actorCreatedAt?: string; verified?: boolean; location?: string }
  > = {};
  logs.forEach((log) => {
    if (!actorProfiles[log.actor]) actorProfiles[log.actor] = {};
    if (log.bio) actorProfiles[log.actor].bio = log.bio;
    if (log.links) actorProfiles[log.actor].links = normalizeLinks(log.links);
    if (log.followerCount !== undefined) actorProfiles[log.actor].followerCount = log.followerCount;
    if (log.followingCount !== undefined) actorProfiles[log.actor].followingCount = log.followingCount;
    if (log.actorCreatedAt) actorProfiles[log.actor].actorCreatedAt = log.actorCreatedAt;
    if (log.verified !== undefined) actorProfiles[log.actor].verified = log.verified;
    if (log.location) actorProfiles[log.actor].location = log.location;
  });

  const linksByActor = new Map<string, string[]>();
  Object.entries(actorProfiles).forEach(([actor, profile]) => {
    const fromProfile = profile.links ?? [];
    const fromBio = profile.bio ? extractLinks(profile.bio) : [];
    linksByActor.set(actor, normalizeLinks([...fromProfile, ...fromBio]));
  });
  const sharedLinksByActor = computeSharedLinksByActor(linksByActor);

  const normalizedBioByActor = new Map<string, string>();
  const bioCount = new Map<string, number>();
  Object.entries(actorProfiles).forEach(([actor, profile]) => {
    const bio = (profile.bio || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!bio) return;
    normalizedBioByActor.set(actor, bio);
    bioCount.set(bio, (bioCount.get(bio) || 0) + 1);
  });
  report({ stage: 'profiles', pct: 15 });

  // Build graph from positive actions
  const nodes = new Set<string>();
  const edges: EdgeDefinition[] = [];
  const positiveOut = new Map<string, Set<string>>();
  const positiveIn = new Map<string, Set<string>>();

  logs.forEach((log) => {
    nodes.add(log.actor);
    nodes.add(log.target);
    if (settings.positiveActions.includes(log.action)) {
      edges.push({ data: { source: log.actor, target: log.target, type: 'interaction' } });
      if (!positiveOut.has(log.actor)) positiveOut.set(log.actor, new Set());
      if (!positiveIn.has(log.target)) positiveIn.set(log.target, new Set());
      positiveOut.get(log.actor)!.add(log.target);
      positiveIn.get(log.target)!.add(log.actor);
    }
  });

  const nodeElements: NodeDefinition[] = Array.from(nodes).map((id) => ({ data: { id, label: id } }));
  const elements: ElementDefinition[] = [...nodeElements, ...edges];
  report({ stage: 'graph', pct: 30 });

  // Build adjacency for undirected connected components
  const graph: Record<string, string[]> = {};
  nodes.forEach((node) => (graph[node] = []));
  edges.forEach((edge) => {
    const s = edge.data?.source as string;
    const t = edge.data?.target as string;
    if (!s || !t) return;
    graph[s].push(t);
    graph[t].push(s);
  });

  const visited = new Set<string>();
  const clusters: DetailedCluster[] = [];
  let clusterId = 0;

  const dfs = (start: string, component: string[]) => {
    const stack = [start];
    visited.add(start);
    while (stack.length > 0) {
      const node = stack.pop()!;
      component.push(node);
      for (const neighbor of graph[node] || []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        stack.push(neighbor);
      }
    }
  };

  for (const node of nodes) {
    if (visited.has(node)) continue;
    const component: string[] = [];
    dfs(node, component);
    if (component.length < settings.minClusterSize) continue;

    const memberSet = new Set(component);
    const internalEdges = component.reduce((sum, n) => sum + (graph[n] || []).filter((neigh) => memberSet.has(neigh)).length, 0) / 2;
    const possibleEdges = (component.length * (component.length - 1)) / 2;
    const density = possibleEdges > 0 ? internalEdges / possibleEdges : 0;
    const externalEdges = component.reduce((sum, n) => sum + (graph[n] || []).filter((neigh) => !memberSet.has(neigh)).length, 0);
    const totalEdges = internalEdges + externalEdges;
    const conductance = totalEdges > 0 ? externalEdges / totalEdges : 0;

    clusters.push({
      clusterId: clusterId++,
      members: component,
      density,
      conductance,
      externalEdges,
    });
  }
  report({ stage: 'clusters', pct: 45 });

  // Timing coordination (bin -> action -> target -> {count, actors})
  const binSizeMs = Math.max(1, settings.timeBinMinutes) * 60 * 1000;
  const timeBins: Record<string, Record<string, Record<string, { count: number; actors: Set<string> }>>> = {};
  logs.forEach((log) => {
    const date = new Date(log.timestamp);
    const bin = Math.floor(date.getTime() / binSizeMs) * binSizeMs;
    const binKey = new Date(bin).toISOString();
    if (!timeBins[binKey]) timeBins[binKey] = {};
    if (!timeBins[binKey][log.action]) timeBins[binKey][log.action] = {};
    if (!timeBins[binKey][log.action][log.target]) timeBins[binKey][log.action][log.target] = { count: 0, actors: new Set() };
    timeBins[binKey][log.action][log.target].count++;
    timeBins[binKey][log.action][log.target].actors.add(log.actor);
  });

  const waves: WaveResult[] = [];
  Object.entries(timeBins).forEach(([time, actions]) => {
    Object.entries(actions).forEach(([action, targets]) => {
      Object.entries(targets).forEach(([target, info]) => {
        if (info.count >= settings.waveMinCount && info.actors.size >= settings.waveMinActors) {
          waves.push({
            windowStart: time,
            windowEnd: new Date(new Date(time).getTime() + binSizeMs).toISOString(),
            action,
            target,
            actors: Array.from(info.actors),
            zScore: info.count / Math.max(1, settings.waveMinCount),
          });
        }
      });
    });
  });
  report({ stage: 'waves', pct: 60 });

  // Actor stats for scoring
  type ActorStats = {
    actor: string;
    totalActions: number;
    churnActions: number;
    burstActions: number;
    uniqueTargets: Set<string>;
    connections: number;
    clusterSize: number;
    positiveOut: number;
    positiveIn: number;
    mutualPositive: number;
    firstSeenMs?: number;
  };

  const actorStats: Record<string, ActorStats> = {};
  nodes.forEach((node) => {
    actorStats[node] = {
      actor: node,
      totalActions: 0,
      churnActions: 0,
      burstActions: 0,
      uniqueTargets: new Set(),
      connections: graph[node]?.length ?? 0,
      clusterSize: 0,
      positiveOut: positiveOut.get(node)?.size ?? 0,
      positiveIn: positiveIn.get(node)?.size ?? 0,
      mutualPositive: 0,
    };
  });

  logs.forEach((log) => {
    const s = actorStats[log.actor];
    if (!s) return;
    s.totalActions++;
    s.uniqueTargets.add(log.target);
    if (settings.churnActions.includes(log.action)) s.churnActions++;
    const ts = new Date(log.timestamp).getTime();
    if (Number.isFinite(ts)) s.firstSeenMs = s.firstSeenMs === undefined ? ts : Math.min(s.firstSeenMs, ts);
  });

  clusters.forEach((cluster) => {
    cluster.members.forEach((member) => {
      if (actorStats[member]) actorStats[member].clusterSize = cluster.members.length;
    });
  });

  // reciprocity
  nodes.forEach((actor) => {
    const outSet = positiveOut.get(actor) ?? new Set<string>();
    let mutual = 0;
    outSet.forEach((t) => {
      const back = positiveOut.get(t);
      if (back?.has(actor)) mutual++;
    });
    actorStats[actor].mutualPositive = mutual;
  });

  // wave bins by actor
  const waveBinsByActor = new Map<string, Set<string>>();
  Object.entries(timeBins).forEach(([binKey, actions]) => {
    Object.entries(actions).forEach(([action, targets]) => {
      Object.entries(targets).forEach(([target, info]) => {
        if (info.count >= settings.waveMinCount && info.actors.size >= settings.waveMinActors) {
          const waveKey = `${binKey}:${action}:${target}`;
          info.actors.forEach((actor) => {
            if (!waveBinsByActor.has(actor)) waveBinsByActor.set(actor, new Set());
            waveBinsByActor.get(actor)!.add(waveKey);
          });
        }
      });
    });
  });
  Object.keys(actorStats).forEach((actor) => {
    actorStats[actor].burstActions = waveBinsByActor.get(actor)?.size ?? 0;
  });

  const handlePatterns = computeHandlePatternScores(Array.from(nodes));

  const scorecards: ActorScorecard[] = Object.values(actorStats).map((stats) => {
    const coordinationScore = stats.totalActions > 0 ? Math.min(stats.burstActions / stats.totalActions, 1) : 0;
    const churnScore = stats.churnActions;
    const clusterIsolationScore = stats.clusterSize > 0 ? 1 - stats.connections / stats.clusterSize : 0;
    const createdAt = actorProfiles[stats.actor]?.actorCreatedAt;
    const createdMs = createdAt ? new Date(createdAt).getTime() : undefined;
    const firstSeenMs = stats.firstSeenMs ?? datasetStartMs;
    const ageDays = createdMs && Number.isFinite(createdMs) ? (firstSeenMs - createdMs) / (24 * 60 * 60 * 1000) : undefined;
    const newAccountScore = ageDays !== undefined && ageDays >= 0 && ageDays < 7 ? 1 : 0;
    const lowDiversityScore = stats.totalActions > 0 ? 1 - stats.uniqueTargets.size / stats.totalActions : 0;

    const profile = actorProfiles[stats.actor] || {};
    const links = linksByActor.get(stats.actor) ?? normalizeLinks(profile.links || (profile.bio ? extractLinks(profile.bio) : []));
    const suspiciousLinks = links.filter((link) => isSuspiciousDomain(link));
    const phishingLinks = links.filter((link) => isLikelyPhishingUrl(link));
    const sharedLinks = sharedLinksByActor.get(stats.actor) ?? [];
    const linkDiversity = linkDiversityScore(links);
    const reciprocalRate = stats.positiveOut > 0 ? stats.mutualPositive / stats.positiveOut : 0;
    const burstRate = stats.totalActions > 0 ? Math.min(stats.burstActions / stats.totalActions, 1) : 0;
    const bio = normalizedBioByActor.get(stats.actor);
    const bioSimilarityScore = bio ? Math.min(((bioCount.get(bio) || 1) - 1) / 5, 1) : 0;
    const handlePatternScore = handlePatterns.scoreByHandle.get(stats.actor) ?? 0;
    const phishingLinkScore = phishingLinks.length > 0 ? Math.min(phishingLinks.length / 2, 1) : 0;
    const profileAnomalyScore = updateProfileAnomalyScore(stats.actor, links, profile.followerCount, profile.followingCount);

    const sybilScore =
      0.30 * coordinationScore +
      0.20 * Math.min(churnScore / 10, 1) +
      0.15 * clusterIsolationScore +
      0.10 * newAccountScore +
      0.10 * lowDiversityScore +
      0.15 * profileAnomalyScore;

    const reasons: string[] = [];
    if (sybilScore > settings.threshold) reasons.push(`Score ${sybilScore.toFixed(2)} ≥ threshold ${settings.threshold.toFixed(2)}`);
    if (coordinationScore >= 0.5) reasons.push(`High coordination (${coordinationScore.toFixed(2)})`);
    if (churnScore >= 5) reasons.push(`High churn (${churnScore})`);
    if (clusterIsolationScore >= 0.5 && stats.clusterSize >= settings.minClusterSize) reasons.push(`Cluster isolation (${clusterIsolationScore.toFixed(2)}) in cluster size ${stats.clusterSize}`);
    if (lowDiversityScore >= 0.7) reasons.push(`Low target diversity (${lowDiversityScore.toFixed(2)})`);
    if (suspiciousLinks.length > 0) reasons.push(`Suspicious link domains (${suspiciousLinks.length})`);
    if (phishingLinks.length > 0) reasons.push(`Phishing-like URLs (${phishingLinks.length})`);
    if (sharedLinks.length > 0) reasons.push(`Shared links with others (${sharedLinks.length})`);
    if (bioSimilarityScore >= 0.4) reasons.push(`Repeated bio text (${bioSimilarityScore.toFixed(2)})`);
    if (handlePatternScore >= 0.4) reasons.push(`Handle pattern similarity (${handlePatternScore.toFixed(2)})`);
    if (newAccountScore === 1) reasons.push('New account (<7 days)');

    return {
      actor: stats.actor,
      sybilScore,
      churnScore,
      coordinationScore,
      noveltyScore: newAccountScore,
      clusterIsolationScore,
      lowDiversityScore,
      profileAnomalyScore,
      links,
      suspiciousLinks,
      sharedLinks,
      linkDiversity,
      reciprocalRate,
      burstRate,
      newAccountScore,
      bioSimilarityScore,
      handlePatternScore,
      phishingLinkScore,
      reasons,
    };
  });

  report({ stage: 'scorecards', pct: 90 });
  report({ stage: 'done', pct: 100 });
  return { elements, clusters, waves, scorecards };
}

