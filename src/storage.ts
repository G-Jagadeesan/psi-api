import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { AggregatedReport, NormalizedReport, Strategy } from './types.js';
import { validateTargetUrl } from './psiClient.js';

const DEFAULT_DATA_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'data',
);

export function getDataDir(): string {
  return process.env.PSI_DATA_DIR
    ? path.resolve(process.env.PSI_DATA_DIR)
    : DEFAULT_DATA_DIR;
}

export function dataDirForHost(url: string, dataDir = getDataDir()): string {
  let hostname = 'unknown-host';
  try {
    hostname = new URL(url).hostname || hostname;
  } catch {
    /* keep the placeholder */
  }
  return path.join(dataDir, hostname.replace(/[^a-zA-Z0-9._-]/g, '_'));
}

/** `data/<host>/<2026-09-29T10-30-00Z>-mobile` - sortable and filesystem safe. */
export function makeReportId(
  url: string,
  strategy: Strategy,
  date = new Date(),
): string {
  const iso = date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
  return `${iso}-${strategy}`;
}

function assertReportId(reportId: string): void {
  if (
    !reportId ||
    reportId.includes('/') ||
    reportId.includes('\\') ||
    reportId.includes('..') ||
    reportId.startsWith('.')
  ) {
    throw new Error(`invalid reportId: ${reportId}`);
  }
}

export function reportDir(reportId: string, url: string, dataDir = getDataDir()): string {
  assertReportId(reportId);
  return path.join(dataDirForHost(url, dataDir), reportId);
}

export interface SaveResult {
  reportId: string;
  dir: string;
}

export async function saveReport(
  report: AggregatedReport,
  runs: NormalizedReport[],
  dataDir = getDataDir(),
): Promise<SaveResult> {
  const { url, warnings } = validateTargetUrl(report.url);
  void warnings;
  const dir = reportDir(report.reportId, url, dataDir);
  await mkdir(dir, { recursive: true });

  await writeFile(path.join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(path.join(dir, 'runs.json'), `${JSON.stringify(runs, null, 2)}\n`, 'utf8');

  return { reportId: report.reportId, dir };
}

export async function loadReport(
  reportId: string,
  dataDir = getDataDir(),
): Promise<AggregatedReport | null> {
  assertReportId(reportId);

  let hosts: string[];
  try {
    hosts = (await readdir(dataDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return null;
  }

  for (const host of hosts) {
    const file = path.join(dataDir, host, reportId, 'report.json');
    try {
      const contents = await readFile(file, 'utf8');
      return JSON.parse(contents) as AggregatedReport;
    } catch {
      /* not here, keep looking */
    }
  }
  return null;
}

export async function loadRuns(
  reportId: string,
  dataDir = getDataDir(),
): Promise<NormalizedReport[] | null> {
  assertReportId(reportId);

  let hosts: string[];
  try {
    hosts = (await readdir(dataDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return null;
  }

  for (const host of hosts) {
    const file = path.join(dataDir, host, reportId, 'runs.json');
    try {
      const contents = await readFile(file, 'utf8');
      return JSON.parse(contents) as NormalizedReport[];
    } catch {
      /* not here, keep looking */
    }
  }
  return null;
}

/** Host directory for a URL, used for the append-only optimization log. */
export function hostDirFor(url: string, dataDir = getDataDir()): string {
  return dataDirForHost(url, dataDir);
}
