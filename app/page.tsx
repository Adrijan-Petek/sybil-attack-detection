'use client';

import dynamic from 'next/dynamic';
import { useMemo, useState } from 'react';
import type { EdgeDefinition, ElementDefinition, NodeDefinition, NodeSingular } from 'cytoscape';
import { computeSharedLinksByActor, extractLinks, isSuspiciousDomain, linkDiversityScore, normalizeLinks, updateProfileAnomalyScore } from '../lib/profile';
import Papa from 'papaparse';

// Dynamically import CytoscapeComponent to avoid SSR issues
const CytoscapeComponent = dynamic(() => import('react-cytoscapejs'), { ssr: false });

interface LogEntry {
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
}

interface DetailedCluster {
  clusterId: number;
  members: string[];
  density: number;
  conductance: number;
  externalEdges: number;
}

interface WaveResult {
  windowStart: string;
  windowEnd: string;
  action: string;
  target: string;
  actors: string[];
  zScore: number;
}

interface ActorScorecard {
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
}

interface ActorStats {
  actor: string;
  totalActions: number;
  churnActions: number;
  burstActions: number;
  uniqueTargets: Set<string>;
  connections: number;
  clusterSize: number;
}

type CsvRow = Record<string, string | undefined>;

interface AnalysisSettings {
  threshold: number;
  minClusterSize: number;
  timeBinMinutes: number;
  waveMinCount: number;
  positiveActions: string[];
  churnActions: string[];
}

export default function Home() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [elements, setElements] = useState<ElementDefinition[]>([]);
  const [clusters, setClusters] = useState<DetailedCluster[]>([]);
  const [waves, setWaves] = useState<WaveResult[]>([]);
  const [scorecards, setScorecards] = useState<ActorScorecard[]>([]);
  const [settings, setSettings] = useState<AnalysisSettings>({
    threshold: 0.6,
    minClusterSize: 6,
    timeBinMinutes: 5,
    waveMinCount: 10,
    positiveActions: ['follow', 'star', 'transfer', 'fork'],
    churnActions: ['unfollow', 'unstar'],
  });
  const [fileUploaded, setFileUploaded] = useState(false);
  const [showAllActors, setShowAllActors] = useState(false);
  const [githubRepo, setGithubRepo] = useState('');
  const [githubMaxPages, setGithubMaxPages] = useState(3);
  const [sourceStatus, setSourceStatus] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [importUrlsText, setImportUrlsText] = useState('');
  const [farcasterId, setFarcasterId] = useState('');
  const [baseAddress, setBaseAddress] = useState('');
  const [talentId, setTalentId] = useState('');

  const logSummary = useMemo(() => {
    const uniqueActors = new Set<string>();
    const uniqueTargets = new Set<string>();
    const byPlatform: Record<string, number> = {};
    const byAction: Record<string, number> = {};
    for (const l of logs) {
      uniqueActors.add(l.actor);
      uniqueTargets.add(l.target);
      byPlatform[l.platform] = (byPlatform[l.platform] || 0) + 1;
      byAction[l.action] = (byAction[l.action] || 0) + 1;
    }
    return {
      total: logs.length,
      uniqueActors: uniqueActors.size,
      uniqueTargets: uniqueTargets.size,
      byPlatform,
      byAction,
    };
  }, [logs]);

  const parseLinksField = (value: unknown): string[] | undefined => {
    if (value === null || value === undefined) return undefined;
    if (Array.isArray(value)) return normalizeLinks(value.map(String));
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return undefined;
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return normalizeLinks(parsed.map(String));
        if (typeof parsed === 'string') return normalizeLinks([parsed]);
      } catch {
        // ignore
      }
      const parts = trimmed.split(/[,\s]+/).filter(Boolean);
      return normalizeLinks(parts);
    }
    return undefined;
  };

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      setSourceError(null);
      const fileType = file.name.split('.').pop()?.toLowerCase();
      if (fileType === 'csv') {
        Papa.parse(file, {
          header: true,
          complete: (results: Papa.ParseResult<CsvRow>) => {
            try {
              const data: LogEntry[] = results.data.flatMap((row) => {
                const timestamp = (row.timestamp ?? '').trim();
                const actor = (row.actor ?? '').trim();
                const target = (row.target ?? '').trim();
                const action = (row.action ?? '').trim();
                const platform = (row.platform ?? '').trim();
                if (!timestamp || !actor || !target || !action || !platform) return [];
                return [
                  {
                    timestamp,
                    actor,
                    target,
                    action,
                    platform,
                    bio: row.bio,
                    links: parseLinksField(row.links),
                    followerCount: row.followerCount ? parseInt(row.followerCount) : undefined,
                    followingCount: row.followingCount ? parseInt(row.followingCount) : undefined,
                  },
                ];
              });
              if (data.length === 0 || !data[0].timestamp) {
                alert('Invalid CSV format. Please ensure it has columns: timestamp, actor, target, action, platform');
                return;
              }
              setLogs(data);
              setFileUploaded(true);
              setSourceStatus(`Loaded ${data.length.toLocaleString()} rows from CSV`);
            } catch (error) {
              console.error('Error parsing CSV:', error);
              alert('Error parsing CSV. Check console for details.');
            }
          },
          error: (error) => {
            console.error('PapaParse error:', error);
            alert('Error reading CSV file.');
          },
        });
      } else if (fileType === 'json') {
        const reader = new FileReader();
        reader.onload = (e) => {
          try {
            const raw = JSON.parse(e.target?.result as string);
            const data: LogEntry[] = (Array.isArray(raw) ? raw : []).flatMap((row): LogEntry[] => {
              if (typeof row !== 'object' || row === null) return [];
              const record = row as Record<string, unknown>;
              const followerRaw = record.followerCount;
              const followingRaw = record.followingCount;
              return [
                {
                  timestamp: String(record.timestamp ?? ''),
                  actor: String(record.actor ?? ''),
                  target: String(record.target ?? ''),
                  action: String(record.action ?? ''),
                  platform: String(record.platform ?? ''),
                  bio: typeof record.bio === 'string' ? record.bio : undefined,
                  links: parseLinksField(record.links),
                  followerCount: typeof followerRaw === 'number' ? followerRaw : typeof followerRaw === 'string' ? parseInt(followerRaw) : undefined,
                  followingCount: typeof followingRaw === 'number' ? followingRaw : typeof followingRaw === 'string' ? parseInt(followingRaw) : undefined,
                },
              ];
            });
            if (!Array.isArray(data) || data.length === 0 || !data[0].timestamp) {
              alert('Invalid JSON format. Please ensure it is an array of objects with timestamp, actor, target, action, platform');
              return;
            }
            setLogs(data);
            setFileUploaded(true);
            setSourceStatus(`Loaded ${data.length.toLocaleString()} rows from JSON`);
          } catch (error) {
            console.error('Error parsing JSON:', error);
            alert('Error parsing JSON. Check console for details.');
          }
        };
        reader.readAsText(file);
      } else {
        alert('Please upload a CSV or JSON file.');
      }
    }
  };

  const startAnalysis = () => {
    processData(logs);
  };

  const appendLogs = (newLogs: LogEntry[], label: string) => {
    if (newLogs.length === 0) {
      setSourceStatus(`${label}: no events returned`);
      return;
    }
    setLogs((prev) => [...prev, ...newLogs]);
    setFileUploaded(true);
    setSourceStatus(`${label}: added ${newLogs.length.toLocaleString()} events`);
  };

  const fetchGithubStargazers = async () => {
    try {
      setSourceError(null);
      setSourceStatus('Fetching GitHub stargazers...');
      const repo = githubRepo.trim();
      if (!repo || !repo.includes('/')) {
        setSourceError('GitHub repo must be in the format owner/name');
        setSourceStatus(null);
        return;
      }
      const url = new URL('/api/fetch/github', window.location.origin);
      url.searchParams.set('repo', repo);
      url.searchParams.set('maxPages', String(githubMaxPages));
      const res = await fetch(url.toString());
      const json = (await res.json()) as { logs?: LogEntry[]; error?: string };
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      appendLogs(json.logs || [], `GitHub ${repo}`);
    } catch (e) {
      setSourceStatus(null);
      setSourceError(e instanceof Error ? e.message : 'Failed to fetch GitHub data');
    }
  };

  const fetchSource = async (path: string, params: Record<string, string>, label: string) => {
    try {
      setSourceError(null);
      setSourceStatus(`Fetching ${label}...`);
      const url = new URL(path, window.location.origin);
      Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
      const res = await fetch(url.toString());
      const json = (await res.json()) as { logs?: LogEntry[]; error?: string; hint?: string };
      if (!res.ok) throw new Error([json.error, json.hint].filter(Boolean).join(' — ') || `Request failed (${res.status})`);
      appendLogs(json.logs || [], label);
    } catch (e) {
      setSourceStatus(null);
      setSourceError(e instanceof Error ? e.message : `Failed to fetch ${label}`);
    }
  };

  const importFromUrls = async () => {
    try {
      setSourceError(null);
      setSourceStatus('Importing URLs...');
      const urls = importUrlsText
        .split(/\r?\n|,/g)
        .map((u) => u.trim())
        .filter(Boolean);
      if (urls.length === 0) {
        setSourceError('Paste one or more CSV/JSON URLs to import.');
        setSourceStatus(null);
        return;
      }
      const res = await fetch('/api/import/url', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ urls }),
      });
      const json = (await res.json()) as { logs?: LogEntry[]; error?: string; results?: { ok: boolean; count?: number }[] };
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      appendLogs(json.logs || [], `Imported URLs (${urls.length})`);
    } catch (e) {
      setSourceStatus(null);
      setSourceError(e instanceof Error ? e.message : 'Failed to import URLs');
    }
  };

  const processData = (data: LogEntry[]) => {
    try {
      // Collect profile data
      const actorProfiles: { [actor: string]: { bio?: string; links?: string[]; followerCount?: number; followingCount?: number } } = {};
      data.forEach((log) => {
        if (!actorProfiles[log.actor]) {
          actorProfiles[log.actor] = {};
        }
        if (log.bio) actorProfiles[log.actor].bio = log.bio;
        if (log.links) actorProfiles[log.actor].links = normalizeLinks(log.links);
        if (log.followerCount !== undefined) actorProfiles[log.actor].followerCount = log.followerCount;
        if (log.followingCount !== undefined) actorProfiles[log.actor].followingCount = log.followingCount;
      });

      const linksByActor = new Map<string, string[]>();
      Object.entries(actorProfiles).forEach(([actor, profile]) => {
        const fromProfile = profile.links ?? [];
        const fromBio = profile.bio ? extractLinks(profile.bio) : [];
        linksByActor.set(actor, normalizeLinks([...fromProfile, ...fromBio]));
      });
      const sharedLinksByActor = computeSharedLinksByActor(linksByActor);

      // Build graph from positive actions
      const nodes = new Set<string>();
      const edges: EdgeDefinition[] = [];
      data.forEach((log) => {
        nodes.add(log.actor);
        nodes.add(log.target);
        if (settings.positiveActions.includes(log.action)) {
          edges.push({
            data: { source: log.actor, target: log.target, type: 'interaction' },
          });
        }
      });

      const nodeElements: NodeDefinition[] = Array.from(nodes).map((id) => ({
        data: { id, label: id },
      }));

      setElements([...nodeElements, ...edges]);

      // Detect clusters
      const graph: { [key: string]: string[] } = {};
      nodes.forEach((node) => (graph[node] = []));
      edges.forEach((edge) => {
        graph[edge.data.source].push(edge.data.target);
        graph[edge.data.target].push(edge.data.source);
      });

      const visited = new Set<string>();
      const clustersList: DetailedCluster[] = [];
      let clusterId = 0;
      for (const node of nodes) {
        if (!visited.has(node)) {
          const component: string[] = [];
          dfs(node, graph, visited, component);
          if (component.length >= settings.minClusterSize) {
            // Calculate density, conductance
            const internalEdges = component.reduce((sum, n) => sum + graph[n].filter(neigh => component.includes(neigh)).length, 0) / 2;
            const possibleEdges = (component.length * (component.length - 1)) / 2;
            const density = possibleEdges > 0 ? internalEdges / possibleEdges : 0;
            const externalEdges = component.reduce((sum, n) => sum + graph[n].filter(neigh => !component.includes(neigh)).length, 0);
            const totalEdges = internalEdges + externalEdges;
            const conductance = totalEdges > 0 ? externalEdges / totalEdges : 0;
            clustersList.push({
              clusterId: clusterId++,
              members: component,
              density,
              conductance,
              externalEdges,
            });
          }
        }
      }
      setClusters(clustersList);

      // Timing coordination
      const timeBins: { [key: string]: { [action: string]: { count: number; actors: Set<string>; targets: Set<string> } } } = {};
      data.forEach((log) => {
        const date = new Date(log.timestamp);
        const binSizeMs = Math.max(1, settings.timeBinMinutes) * 60 * 1000;
        const bin = Math.floor(date.getTime() / binSizeMs) * binSizeMs;
        const binKey = new Date(bin).toISOString();
        if (!timeBins[binKey]) timeBins[binKey] = {};
        if (!timeBins[binKey][log.action]) timeBins[binKey][log.action] = { count: 0, actors: new Set(), targets: new Set() };
        timeBins[binKey][log.action].count++;
        timeBins[binKey][log.action].actors.add(log.actor);
        timeBins[binKey][log.action].targets.add(log.target);
      });

      const suspiciousWaves: WaveResult[] = [];
      Object.entries(timeBins).forEach(([time, actions]) => {
        Object.entries(actions).forEach(([action, { count, actors, targets }]) => {
          if (count >= settings.waveMinCount) {
            const windowEnd = new Date(new Date(time).getTime() + Math.max(1, settings.timeBinMinutes) * 60 * 1000).toISOString();
            suspiciousWaves.push({
              windowStart: time,
              windowEnd,
              action,
              target: Array.from(targets)[0] || '', // assuming one target per wave
              actors: Array.from(actors),
              zScore: count / Math.max(1, settings.waveMinCount), // simplified
            });
          }
        });
      });
      setWaves(suspiciousWaves);

      // Actor scorecards
      const actorStats: Record<string, ActorStats> = {};
      nodes.forEach((node) => {
        actorStats[node] = {
          actor: node,
          totalActions: 0,
          churnActions: 0,
          burstActions: 0,
          uniqueTargets: new Set(),
          connections: graph[node].length,
          clusterSize: 0,
        };
      });

      data.forEach((log) => {
        actorStats[log.actor].totalActions++;
        actorStats[log.actor].uniqueTargets.add(log.target);
        if (settings.churnActions.includes(log.action)) {
          actorStats[log.actor].churnActions++;
        }
      });

      // Assign cluster sizes
      clustersList.forEach((cluster) => {
        cluster.members.forEach((member) => {
          actorStats[member].clusterSize = cluster.members.length;
        });
      });

      // Coordination score: fraction in bursts
      Object.values(timeBins).forEach((actions) => {
        Object.values(actions).forEach(({ actors }) => {
          actors.forEach((actor) => {
            if (actorStats[actor]) actorStats[actor].burstActions++;
          });
        });
      });

      const scorecardsList: ActorScorecard[] = Object.values(actorStats).map((stats) => {
        const coordinationScore = stats.totalActions > 0 ? stats.burstActions / stats.totalActions : 0;
        const churnScore = stats.churnActions;
        const clusterIsolationScore = stats.clusterSize > 0 ? 1 - (stats.connections / stats.clusterSize) : 0;
        const newAccountScore = 0; // placeholder, no age data
        const lowDiversityScore = stats.totalActions > 0 ? 1 - (stats.uniqueTargets.size / stats.totalActions) : 0;
        const profile = actorProfiles[stats.actor] || {};
        const links = linksByActor.get(stats.actor) ?? normalizeLinks(profile.links || (profile.bio ? extractLinks(profile.bio) : []));
        const suspiciousLinks = links.filter((link) => isSuspiciousDomain(link));
        const sharedLinks = sharedLinksByActor.get(stats.actor) ?? [];
        const linkDiversity = linkDiversityScore(links);
        const profileAnomalyScore = updateProfileAnomalyScore(stats.actor, links, profile.followerCount, profile.followingCount);
        const sybilScore = 0.30 * coordinationScore + 0.20 * Math.min(churnScore / 10, 1) + 0.15 * clusterIsolationScore + 0.10 * newAccountScore + 0.10 * lowDiversityScore + 0.15 * profileAnomalyScore;
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
        };
      });
      setScorecards(scorecardsList);
    } catch (error) {
      console.error('Error processing data:', error);
      alert('Error processing data. Check console for details.');
    }
  };

  const dfs = (node: string, graph: { [key: string]: string[] }, visited: Set<string>, component: string[]) => {
    visited.add(node);
    component.push(node);
    for (const neighbor of graph[node]) {
      if (!visited.has(neighbor)) {
        dfs(neighbor, graph, visited, component);
      }
    }
  };

  const exportEvidence = () => {
    const profileLinks = Object.fromEntries(
      scorecards.map((s) => [
        s.actor,
        {
          links: s.links,
          suspiciousLinks: s.suspiciousLinks,
          sharedLinks: s.sharedLinks,
          linkDiversity: s.linkDiversity,
        },
      ]),
    );
    const evidence = {
      clusters,
      waves,
      scorecards: scorecards.filter(s => s.sybilScore > settings.threshold),
      profileLinks,
      settings,
    };
    const blob = new Blob([JSON.stringify(evidence, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'evidence-pack.json';
    a.click();
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="bg-white border-b">
        <div className="mx-auto max-w-6xl px-4 py-4 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Sybil Attack Detection</h1>
            <p className="text-sm text-slate-600">Detect coordinated clusters and churn across social + onchain signals</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setLogs([]);
                setElements([]);
                setClusters([]);
                setWaves([]);
                setScorecards([]);
                setFileUploaded(false);
                setSourceStatus(null);
                setSourceError(null);
              }}
              className="px-3 py-2 rounded border bg-white text-sm hover:bg-slate-50"
            >
              Reset
            </button>
            <button
              onClick={exportEvidence}
              disabled={logs.length === 0}
              className="px-3 py-2 rounded bg-slate-900 text-white text-sm disabled:opacity-50"
            >
              Export evidence
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 space-y-4">
            <section className="bg-white border rounded-lg p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="font-semibold">Data sources</h2>
                  <p className="text-sm text-slate-600 mt-1">Upload logs or fetch from supported platforms.</p>
                </div>
                <button
                  onClick={startAnalysis}
                  disabled={!fileUploaded || logs.length === 0}
                  className="px-4 py-2 rounded bg-emerald-600 text-white text-sm disabled:opacity-50 hover:bg-emerald-700"
                >
                  Run analysis
                </button>
              </div>

              <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="border rounded-lg p-3">
                  <div className="text-sm font-medium">Upload CSV/JSON</div>
                  <div className="text-xs text-slate-600 mt-1">
                    Required: <code>timestamp, actor, target, action, platform</code>
                  </div>
                  <input type="file" accept=".csv,.json" onChange={handleFileUpload} className="mt-3 w-full text-sm" />
                </div>

                <div className="border rounded-lg p-3">
                  <div className="text-sm font-medium">GitHub stargazers</div>
                  <div className="text-xs text-slate-600 mt-1">
                    Pulls timestamped <code>star</code> events for a repo.
                  </div>
                  <div className="mt-2 flex gap-2">
                    <input
                      value={githubRepo}
                      onChange={(e) => setGithubRepo(e.target.value)}
                      placeholder="owner/repo"
                      className="flex-1 border rounded px-2 py-1 text-sm"
                    />
                    <input
                      type="number"
                      min={1}
                      max={20}
                      value={githubMaxPages}
                      onChange={(e) => setGithubMaxPages(Math.min(20, Math.max(1, Number.parseInt(e.target.value || '3', 10) || 3)))}
                      className="w-20 border rounded px-2 py-1 text-sm"
                      title="Max pages (100 per page)"
                    />
                    <button onClick={fetchGithubStargazers} className="px-3 py-1.5 rounded bg-blue-600 text-white text-sm hover:bg-blue-700">
                      Fetch
                    </button>
                  </div>
                  <div className="text-xs text-slate-500 mt-2">
                    Optional: set <code>GITHUB_TOKEN</code> to raise rate limits.
                  </div>
                </div>

                <div className="border rounded-lg p-3">
                  <div className="text-sm font-medium">Farcaster (connector)</div>
                  <div className="text-xs text-slate-600 mt-1">Requires a configured API backend (e.g., Neynar).</div>
                  <div className="mt-2 flex gap-2">
                    <input
                      value={farcasterId}
                      onChange={(e) => setFarcasterId(e.target.value)}
                      placeholder="fid or username"
                      className="flex-1 border rounded px-2 py-1 text-sm"
                    />
                    <button
                      onClick={() => fetchSource('/api/fetch/farcaster', { id: farcasterId.trim() }, 'Farcaster')}
                      className="px-3 py-1.5 rounded bg-slate-700 text-white text-sm hover:bg-slate-800"
                    >
                      Fetch
                    </button>
                  </div>
                </div>

                <div className="border rounded-lg p-3">
                  <div className="text-sm font-medium">Base (connector)</div>
                  <div className="text-xs text-slate-600 mt-1">Requires an RPC/indexer backend to pull transfers/events.</div>
                  <div className="mt-2 flex gap-2">
                    <input
                      value={baseAddress}
                      onChange={(e) => setBaseAddress(e.target.value)}
                      placeholder="0x wallet address"
                      className="flex-1 border rounded px-2 py-1 text-sm"
                    />
                    <button
                      onClick={() => fetchSource('/api/fetch/base', { address: baseAddress.trim() }, 'Base')}
                      className="px-3 py-1.5 rounded bg-slate-700 text-white text-sm hover:bg-slate-800"
                    >
                      Fetch
                    </button>
                  </div>
                </div>
              </div>

              <div className="mt-3 border rounded-lg p-3">
                <div className="text-sm font-medium">Import from URLs</div>
                <div className="text-xs text-slate-600 mt-1">Paste direct links to <code>.csv</code> or <code>.json</code> exports (one per line).</div>
                <textarea
                  value={importUrlsText}
                  onChange={(e) => setImportUrlsText(e.target.value)}
                  placeholder="https://example.com/logs.csv\nhttps://example.com/logs.json"
                  className="mt-2 w-full border rounded px-2 py-1 text-sm h-20"
                />
                <div className="mt-2">
                  <button onClick={importFromUrls} className="px-3 py-1.5 rounded bg-slate-900 text-white text-sm hover:bg-slate-800">
                    Import URLs
                  </button>
                </div>
                <div className="text-xs text-slate-500 mt-2">
                  Safety: blocks localhost/private IP URLs and limits downloads to ~2MB per file.
                </div>
              </div>

              <div className="mt-3 border rounded-lg p-3">
                <div className="text-sm font-medium">Talent Protocol (connector)</div>
                <div className="text-xs text-slate-600 mt-1">If you have exports, use Import from URLs / Upload.</div>
                <div className="mt-2 flex gap-2">
                  <input
                    value={talentId}
                    onChange={(e) => setTalentId(e.target.value)}
                    placeholder="handle / profile id"
                    className="flex-1 border rounded px-2 py-1 text-sm"
                  />
                  <button
                    onClick={() => fetchSource('/api/fetch/talent', { id: talentId.trim() }, 'Talent')}
                    className="px-3 py-1.5 rounded bg-slate-700 text-white text-sm hover:bg-slate-800"
                  >
                    Fetch
                  </button>
                </div>
              </div>

              {(sourceStatus || sourceError) && (
                <div className="mt-3">
                  {sourceStatus && <div className="text-sm text-slate-700">{sourceStatus}</div>}
                  {sourceError && <div className="text-sm text-red-700">{sourceError}</div>}
                </div>
              )}

              <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
                <div className="text-slate-600">
                  Events: <span className="font-medium text-slate-900">{logSummary.total.toLocaleString()}</span>
                </div>
                <div className="text-slate-600">
                  Actors: <span className="font-medium text-slate-900">{logSummary.uniqueActors.toLocaleString()}</span>
                </div>
                <div className="text-slate-600">
                  Targets: <span className="font-medium text-slate-900">{logSummary.uniqueTargets.toLocaleString()}</span>
                </div>
              </div>
            </section>

            <section className="bg-white border rounded-lg p-4">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <h2 className="font-semibold">Graph</h2>
                  <p className="text-sm text-slate-600 mt-1">Red nodes are above your threshold.</p>
                </div>
                <div className="text-sm text-slate-600">
                  Threshold: <span className="font-medium text-slate-900">{settings.threshold.toFixed(2)}</span>
                </div>
              </div>
              <div className="mt-3" style={{ width: '100%', height: '520px' }}>
                <CytoscapeComponent
                  elements={elements}
                  style={{ width: '100%', height: '100%' }}
                  stylesheet={[
                    {
                      selector: 'node',
                      style: {
                        'background-color': (ele: NodeSingular) => {
                          const scorecard = scorecards.find(s => s.actor === ele.data('id'));
                          return scorecard && scorecard.sybilScore > settings.threshold ? 'rgb(220 38 38)' : 'rgb(37 99 235)';
                        },
                        label: 'data(label)',
                        'text-valign': 'center',
                        'text-halign': 'center',
                        'font-size': '10px',
                        color: 'rgb(15 23 42)',
                        'text-outline-color': 'white',
                        'text-outline-width': 1,
                      },
                    },
                    {
                      selector: 'edge[type="interaction"]',
                      style: {
                        width: 2,
                        'line-color': 'rgb(16 185 129)',
                      },
                    },
                  ]}
                  layout={{ name: 'cose' }}
                />
              </div>
            </section>

            <section className="bg-white border rounded-lg p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="font-semibold">Results</h2>
                  <p className="text-sm text-slate-600 mt-1">Clusters, waves, and actor scorecards.</p>
                </div>
              </div>

              <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="border rounded-lg p-3">
                  <div className="text-sm font-medium">Clusters</div>
                  <ul className="mt-2 text-sm text-slate-700 list-disc pl-4">
                    {clusters.length === 0 && <li className="list-none text-slate-500">No clusters yet.</li>}
                    {clusters.map((cluster) => (
                      <li key={cluster.clusterId}>
                        #{cluster.clusterId}: {cluster.members.length} members (density {cluster.density.toFixed(2)}, conductance {cluster.conductance.toFixed(2)})
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="border rounded-lg p-3">
                  <div className="text-sm font-medium">Waves</div>
                  <ul className="mt-2 text-sm text-slate-700 list-disc pl-4">
                    {waves.length === 0 && <li className="list-none text-slate-500">No waves yet.</li>}
                    {waves.map((wave, i) => (
                      <li key={i}>
                        {wave.action} on {wave.target} ({wave.actors.length} actors) @ {wave.windowStart}
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="border rounded-lg p-3 md:col-span-2">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-medium">Actor scorecards</div>
                    <label className="text-sm text-slate-700">
                      <input type="checkbox" className="mr-2" checked={showAllActors} onChange={(e) => setShowAllActors(e.target.checked)} />
                      Show all actors
                    </label>
                  </div>
                  <ul className="mt-2 text-sm text-slate-800 space-y-3 max-h-96 overflow-y-auto">
                    {(showAllActors ? scorecards : scorecards.filter(s => s.sybilScore > settings.threshold))
                      .slice()
                      .sort((a, b) => b.sybilScore - a.sybilScore)
                      .map((scorecard) => (
                      <li key={scorecard.actor} className="border rounded p-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="font-medium">{scorecard.actor}</div>
                          <div className="text-sm">
                            Score <span className="font-semibold">{scorecard.sybilScore.toFixed(2)}</span>
                          </div>
                        </div>
                        <div className="mt-1 text-xs text-slate-600">
                          Churn {scorecard.churnScore} · Coord {scorecard.coordinationScore.toFixed(2)} · Isolation {scorecard.clusterIsolationScore.toFixed(2)} · Diversity {scorecard.lowDiversityScore.toFixed(2)}
                        </div>
                        {scorecard.links.length > 0 && (
                          <div className="mt-2 text-xs text-slate-700">
                            Links ({scorecard.links.length}, diversity {scorecard.linkDiversity.toFixed(2)}):{' '}
                            {scorecard.links.map((link) => (
                              <a
                                key={link}
                                href={link}
                                target="_blank"
                                rel="noreferrer"
                                className={scorecard.suspiciousLinks.includes(link) ? 'text-red-700 underline mr-2' : 'text-blue-700 underline mr-2'}
                              >
                                {link}
                              </a>
                            ))}
                          </div>
                        )}
                        {scorecard.sharedLinks.length > 0 && (
                          <div className="mt-1 text-xs text-slate-700">Shared links: {scorecard.sharedLinks.length}</div>
                        )}
                      </li>
                    ))}
                    {scorecards.length === 0 && <li className="text-slate-500">Run analysis to generate scorecards.</li>}
                  </ul>
                </div>
              </div>
            </section>
          </div>

          <aside className="space-y-4">
            <section className="bg-white border rounded-lg p-4">
              <h2 className="font-semibold">Settings</h2>
              <p className="text-sm text-slate-600 mt-1">Tune thresholds and action semantics.</p>
              <div className="mt-4 space-y-3">
                <label className="text-sm text-slate-700 block">
                  Threshold (0–1)
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={settings.threshold}
                    onChange={(e) => setSettings((s) => ({ ...s, threshold: Number.parseFloat(e.target.value) }))}
                    className="mt-1 block border rounded px-2 py-1 w-full text-sm"
                  />
                </label>
                <label className="text-sm text-slate-700 block">
                  Min cluster size
                  <input
                    type="number"
                    min={2}
                    step={1}
                    value={settings.minClusterSize}
                    onChange={(e) => setSettings((s) => ({ ...s, minClusterSize: Math.max(2, Number.parseInt(e.target.value || '0')) }))}
                    className="mt-1 block border rounded px-2 py-1 w-full text-sm"
                  />
                </label>
                <label className="text-sm text-slate-700 block">
                  Time bin (minutes)
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={settings.timeBinMinutes}
                    onChange={(e) => setSettings((s) => ({ ...s, timeBinMinutes: Math.max(1, Number.parseInt(e.target.value || '0')) }))}
                    className="mt-1 block border rounded px-2 py-1 w-full text-sm"
                  />
                </label>
                <label className="text-sm text-slate-700 block">
                  Wave min count (per bin)
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={settings.waveMinCount}
                    onChange={(e) => setSettings((s) => ({ ...s, waveMinCount: Math.max(1, Number.parseInt(e.target.value || '0')) }))}
                    className="mt-1 block border rounded px-2 py-1 w-full text-sm"
                  />
                </label>
                <label className="text-sm text-slate-700 block">
                  Positive actions (graph edges)
                  <input
                    type="text"
                    value={settings.positiveActions.join(', ')}
                    onChange={(e) =>
                      setSettings((s) => ({
                        ...s,
                        positiveActions: e.target.value
                          .split(',')
                          .map((v) => v.trim())
                          .filter(Boolean),
                      }))
                    }
                    className="mt-1 block border rounded px-2 py-1 w-full text-sm"
                  />
                </label>
                <label className="text-sm text-slate-700 block">
                  Churn actions
                  <input
                    type="text"
                    value={settings.churnActions.join(', ')}
                    onChange={(e) =>
                      setSettings((s) => ({
                        ...s,
                        churnActions: e.target.value
                          .split(',')
                          .map((v) => v.trim())
                          .filter(Boolean),
                      }))
                    }
                    className="mt-1 block border rounded px-2 py-1 w-full text-sm"
                  />
                </label>
              </div>
            </section>

            <section className="bg-white border rounded-lg p-4">
              <h2 className="font-semibold">What to analyze next</h2>
              <ul className="mt-2 text-sm text-slate-700 list-disc pl-4">
                <li>GitHub: repo stargazers (timestamped)</li>
                <li>Farcaster/Base/Talent: add connectors (next)</li>
                <li>Upload your own action logs (best coverage)</li>
              </ul>
            </section>
          </aside>
        </div>
      </main>
    </div>
  );
}
