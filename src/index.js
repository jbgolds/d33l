'use strict';

const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const http = require('http');
const https = require('https');

/**
 * Resolve configuration with the following precedence (highest to lowest):
 * - CLI flags
 * - Environment variables
 * - package.json "llmsFetcher" field
 * - Defaults
 */
function resolveConfig({ cli = {} } = {}) {
  const pkgCfg = readPackageConfig();
  const env = process.env;

  const publicUrl = cli.publicUrl || env.LLMS_PUBLIC_URL || (pkgCfg && pkgCfg.publicUrl) || '';
  const outputDir = cli.outputDir || env.LLMS_OUTPUT_DIR || (pkgCfg && pkgCfg.outputDir) || 'public';
  const outputFile = cli.outputFile || env.LLMS_OUTPUT_FILE || (pkgCfg && pkgCfg.outputFile) || 'llms.txt';
  const runAt = cli.runAt || env.LLMS_RUN_AT || (pkgCfg && pkgCfg.runAt) || '02:00';
  const userAgent = cli.userAgent || env.LLMS_USER_AGENT || (pkgCfg && pkgCfg.userAgent) || 'llms-fetcher/0.1';
  const timeoutMs = Number(cli.timeoutMs || env.LLMS_TIMEOUT_MS || (pkgCfg && pkgCfg.timeoutMs) || 20000);

  // Optional interval-based scheduling (in hours). If provided (> 0), it takes precedence over runAt.
  const intervalHours = Number(cli.intervalHours || env.LLMS_INTERVAL_HOURS || (pkgCfg && pkgCfg.intervalHours) || 0);

  return { publicUrl, outputDir, outputFile, runAt, userAgent, timeoutMs, intervalHours };
}

function readPackageConfig() {
  try {
    const pkgPath = path.join(process.cwd(), 'package.json');
    const json = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return json.llmsFetcher || null;
  } catch {
    return null;
  }
}

function ensureDirectoryExists(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function fetchTextFile(fileUrl, { userAgent, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(fileUrl);
    } catch (err) {
      reject(new Error(`Invalid URL: ${fileUrl}`));
      return;
    }

    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.get(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + (parsed.search || ''),
        headers: {
          'User-Agent': userAgent,
          'Accept': 'text/plain, */*'
        }
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // Follow simple redirects
          fetchTextFile(new URL(res.headers.location, parsed).toString(), { userAgent, timeoutMs })
            .then(resolve)
            .catch(reject);
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`Request failed with status ${res.statusCode}`));
          res.resume();
          return;
        }

        const chunks = [];
        res.on('data', (d) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('Request timed out'));
    });

    req.on('error', reject);
  });
}

async function saveLlmsTextToFile({ sourceUrl, outputDir, outputFile, userAgent, timeoutMs }) {
  const text = await fetchTextFile(sourceUrl, { userAgent, timeoutMs });
  ensureDirectoryExists(outputDir);
  const outPath = path.resolve(process.cwd(), outputDir, outputFile);
  fs.writeFileSync(outPath, text, 'utf8');
  return outPath;
}

function msUntilNextRunAt(runAt) {
  const [hh, mm] = String(runAt).split(':').map((s) => Number(s));
  if (Number.isNaN(hh) || Number.isNaN(mm)) {
    // Default to 24h if invalid time
    return 24 * 60 * 60 * 1000;
  }
  const now = new Date();
  const next = new Date(now);
  next.setHours(hh, mm, 0, 0);
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime() - now.getTime();
}

function startDailyScheduler(config, log = console) {
  const { publicUrl, outputDir, outputFile, runAt, userAgent, timeoutMs, intervalHours } = config;
  if (!publicUrl) {
    throw new Error('publicUrl is required');
  }
  const sourceUrl = joinUrl(publicUrl, '/llms.txt');

  async function runOnce() {
    try {
      const savedPath = await saveLlmsTextToFile({
        sourceUrl,
        outputDir,
        outputFile,
        userAgent,
        timeoutMs
      });
      log.info?.(`llms-fetcher: saved ${sourceUrl} -> ${savedPath}`) || log.log(`llms-fetcher: saved ${sourceUrl} -> ${savedPath}`);
    } catch (err) {
      log.error?.(`llms-fetcher error: ${err && err.message}`) || log.log(`llms-fetcher error: ${err && err.message}`);
    }
  }

  if (Number.isFinite(intervalHours) && intervalHours > 0) {
    // Interval-based scheduling: run immediately, then every intervalHours
    runOnce();
    const intervalMs = Math.max(1, Math.floor(intervalHours * 60 * 60 * 1000));
    setInterval(runOnce, intervalMs);
  } else {
    function scheduleNext() {
      const delay = msUntilNextRunAt(runAt);
      setTimeout(async () => {
        await runOnce();
        // After running, schedule next in 24h
        setInterval(runOnce, 24 * 60 * 60 * 1000);
      }, delay);
    }
    scheduleNext();
  }
  return { runOnce };
}

function joinUrl(base, pathSuffix) {
  try {
    const u = new URL(base);
    // Ensure no double slashes
    const pathname = (u.pathname.endsWith('/') ? u.pathname.slice(0, -1) : u.pathname) + pathSuffix;
    u.pathname = pathname;
    return u.toString();
  } catch {
    // Fallback naive join
    return String(base).replace(/\/$/, '') + pathSuffix;
  }
}

module.exports = {
  resolveConfig,
  startDailyScheduler,
  saveLlmsTextToFile,
};

