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

  // Serverless-friendly TTL (in hours) for on-demand freshness checks
  const ttlHours = Number(cli.ttlHours || env.LLMS_TTL_HOURS || (pkgCfg && pkgCfg.ttlHours) || 24);

  return { publicUrl, outputDir, outputFile, runAt, userAgent, timeoutMs, intervalHours, ttlHours };
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
    const req = client.get({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + (parsed.search || ''),
      headers: {
        'User-Agent': userAgent,
        'Accept': 'text/plain, */*'
      }
    }, (res) => {
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
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('Request timed out'));
    });

    req.on('error', reject);
  });
}

function fetchTextFileWithMetadata(fileUrl, { userAgent, timeoutMs, etag, lastModified }) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(fileUrl);
    } catch (err) {
      reject(new Error(`Invalid URL: ${fileUrl}`));
      return;
    }
    const client = parsed.protocol === 'https:' ? https : http;
    const headers = {
      'User-Agent': userAgent,
      'Accept': 'text/plain, */*'
    };
    if (etag) headers['If-None-Match'] = etag;
    if (lastModified) headers['If-Modified-Since'] = lastModified;
    const req = client.get({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + (parsed.search || ''),
      headers
    }, (res) => {
      const status = res.statusCode || 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location) {
        fetchTextFileWithMetadata(new URL(location, parsed).toString(), { userAgent, timeoutMs, etag, lastModified })
          .then(resolve)
          .catch(reject);
        return;
      }
      if (status === 304) {
        // Not modified, return without body
        resolve({ statusCode: 304, text: '', etag: etag || null, lastModified: lastModified || null });
        res.resume();
        return;
      }
      if (status !== 200) {
        reject(new Error(`Request failed with status ${status}`));
        res.resume();
        return;
      }
      const chunks = [];
      res.on('data', (d) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          statusCode: 200,
          text,
          etag: res.headers.etag || null,
          lastModified: res.headers['last-modified'] || null,
        });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Request timed out')));
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
  ensureFreshLlmsFile,
};

function metadataFilePath(outputDir) {
  return path.resolve(process.cwd(), outputDir, '.llms.meta.json');
}

function readJsonSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeJsonSafe(filePath, data) {
  try {
    ensureDirectoryExists(path.dirname(filePath));
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch {}
}

async function ensureFreshLlmsFile(config, log = console) {
  const { publicUrl, outputDir, outputFile, userAgent, timeoutMs, ttlHours } = config;
  if (!publicUrl) throw new Error('publicUrl is required');
  const sourceUrl = joinUrl(publicUrl, '/llms.txt');
  const outPath = path.resolve(process.cwd(), outputDir, outputFile);
  const metaPath = metadataFilePath(outputDir);

  const meta = readJsonSafe(metaPath) || {};
  const lastFetchedAtMs = typeof meta.lastFetchedAtMs === 'number' ? meta.lastFetchedAtMs : 0;
  const ttlMs = Math.max(0, Math.floor((Number.isFinite(ttlHours) ? ttlHours : 24) * 60 * 60 * 1000));
  const now = Date.now();

  const fileExists = fs.existsSync(outPath);
  if (fileExists && lastFetchedAtMs && now - lastFetchedAtMs < ttlMs) {
    return outPath;
  }

  try {
    const resp = await fetchTextFileWithMetadata(sourceUrl, {
      userAgent,
      timeoutMs,
      etag: meta.etag,
      lastModified: meta.lastModified,
    });
    if (resp.statusCode === 304) {
      // Unchanged, just update timestamp
      writeJsonSafe(metaPath, {
        etag: meta.etag || null,
        lastModified: meta.lastModified || null,
        lastFetchedAtMs: now,
      });
      return outPath;
    }
    ensureDirectoryExists(outputDir);
    fs.writeFileSync(outPath, resp.text, 'utf8');
    writeJsonSafe(metaPath, {
      etag: resp.etag || null,
      lastModified: resp.lastModified || null,
      lastFetchedAtMs: now,
    });
    return outPath;
  } catch (err) {
    // If fetch fails but we have an existing file, keep serving it
    if (fileExists) {
      log.warn?.(`llms-fetcher ensureFresh: ${err && err.message} (serving cached)`);
      return outPath;
    }
    throw err;
  }
}

