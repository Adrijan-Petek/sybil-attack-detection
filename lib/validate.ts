import type { LogEntry } from './analyze';

export type ValidationIssue = { level: 'error' | 'warn'; message: string };

export type ValidationReport = {
  ok: boolean;
  issues: ValidationIssue[];
  stats: {
    rows: number;
    validRows: number;
    droppedRows: number;
    missingRequired: number;
    invalidTimestamps: number;
    emptyActors: number;
    emptyTargets: number;
    emptyActions: number;
    emptyPlatforms: number;
  };
};

export function validateLogs(logs: LogEntry[]): ValidationReport {
  const issues: ValidationIssue[] = [];
  let missingRequired = 0;
  let invalidTimestamps = 0;
  let emptyActors = 0;
  let emptyTargets = 0;
  let emptyActions = 0;
  let emptyPlatforms = 0;
  let validRows = 0;
  let droppedRows = 0;

  for (const row of logs) {
    const ts = String(row.timestamp || '').trim();
    const actor = String(row.actor || '').trim();
    const target = String(row.target || '').trim();
    const action = String(row.action || '').trim();
    const platform = String(row.platform || '').trim();

    if (!ts || !actor || !target || !action || !platform) missingRequired++;
    if (!actor) emptyActors++;
    if (!target) emptyTargets++;
    if (!action) emptyActions++;
    if (!platform) emptyPlatforms++;

    const ms = new Date(ts).getTime();
    if (!Number.isFinite(ms)) invalidTimestamps++;
    const isValid = Boolean(ts && actor && target && action && platform && Number.isFinite(ms));
    if (isValid) validRows++;
    else droppedRows++;
  }

  if (logs.length === 0) issues.push({ level: 'error', message: 'No rows loaded.' });
  if (missingRequired > 0) issues.push({ level: 'warn', message: `Missing required fields in ${missingRequired} row(s). Required: timestamp, platform, action, actor, target.` });
  if (invalidTimestamps > 0) issues.push({ level: 'warn', message: `Invalid timestamp in ${invalidTimestamps} row(s). Use ISO8601 like 2024-01-01T00:00:00Z.` });

  // Warnings that often indicate weak results but not necessarily invalid.
  if (emptyActions > 0 && emptyActions < logs.length) issues.push({ level: 'warn', message: `Empty action in ${emptyActions} row(s).` });
  if (emptyPlatforms > 0 && emptyPlatforms < logs.length) issues.push({ level: 'warn', message: `Empty platform in ${emptyPlatforms} row(s).` });

  const ok = logs.length > 0 && validRows > 0;
  return {
    ok,
    issues,
    stats: {
      rows: logs.length,
      validRows,
      droppedRows,
      missingRequired,
      invalidTimestamps,
      emptyActors,
      emptyTargets,
      emptyActions,
      emptyPlatforms,
    },
  };
}

export function sanitizeLogs(logs: LogEntry[]): { logs: LogEntry[]; report: ValidationReport } {
  const valid: LogEntry[] = [];
  for (const row of logs) {
    const timestamp = String(row.timestamp || '').trim();
    const actor = String(row.actor || '').trim();
    const target = String(row.target || '').trim();
    const action = String(row.action || '').trim();
    const platform = String(row.platform || '').trim();
    const ms = new Date(timestamp).getTime();
    if (!timestamp || !actor || !target || !action || !platform) continue;
    if (!Number.isFinite(ms)) continue;
    valid.push({ ...row, timestamp, actor, target, action, platform });
  }

  const report = validateLogs(logs);
  if (report.stats.droppedRows > 0) {
    report.issues = [
      ...report.issues,
      { level: 'warn', message: `Dropped ${report.stats.droppedRows} invalid row(s) before analysis.` },
    ];
  }
  if (valid.length === 0) {
    report.ok = false;
    report.issues = [{ level: 'error', message: 'No valid rows to analyze after cleaning.' }];
  }
  return { logs: valid, report };
}
