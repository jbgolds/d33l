#!/usr/bin/env node
'use strict';

const path = require('path');
const { resolveConfig, startDailyScheduler, saveLlmsTextToFile } = require('../src/index');

function parseArgs(argv) {
  const args = argv.slice(2);
  const cli = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--public-url' || a === '-u') cli.publicUrl = args[++i];
    else if (a === '--output-dir' || a === '-o') cli.outputDir = args[++i];
    else if (a === '--output-file' || a === '-f') cli.outputFile = args[++i];
    else if (a === '--run-at' || a === '-t') cli.runAt = args[++i];
    else if (a === '--user-agent') cli.userAgent = args[++i];
    else if (a === '--timeout-ms') cli.timeoutMs = args[++i];
    else if (a === '--dry-run') cli.dryRun = true;
    else if (a === 'run' || a === 'watch' || a === 'help' || a === '--help' || a === '-h') cli._.push(a);
    else if (a.startsWith('-')) {
      console.error(`Unknown flag: ${a}`);
      process.exit(1);
    } else {
      cli._.push(a);
    }
  }
  return cli;
}

function printHelp() {
  console.log(`llms-fetcher - fetch and save llms.txt daily

Usage:
  llms-fetcher run [--public-url <url>] [--output-dir <dir>] [--output-file <name>]
  llms-fetcher watch [--run-at HH:MM] [--public-url <url>] [--output-dir <dir>] [--output-file <name>]

Config sources (by precedence): flags > env > package.json llmsFetcher > defaults

Environment variables:
  LLMS_PUBLIC_URL, LLMS_OUTPUT_DIR, LLMS_OUTPUT_FILE, LLMS_RUN_AT, LLMS_USER_AGENT, LLMS_TIMEOUT_MS
`);
}

async function main() {
  const cli = parseArgs(process.argv);
  if (cli._.includes('help') || cli._.includes('--help') || cli._.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  const mode = cli._.find((v) => v === 'run' || v === 'watch') || 'run';
  const config = resolveConfig({ cli });
  if (!config.publicUrl) {
    console.error('Error: publicUrl is required. Pass --public-url or set LLMS_PUBLIC_URL or package.json llmsFetcher.publicUrl');
    process.exit(1);
  }

  const sourceUrl = (() => {
    try {
      const u = new URL(config.publicUrl);
      u.pathname = (u.pathname.endsWith('/') ? u.pathname.slice(0, -1) : u.pathname) + '/llms.txt';
      return u.toString();
    } catch {
      return String(config.publicUrl).replace(/\/$/, '') + '/llms.txt';
    }
  })();

  if (mode === 'run') {
    if (cli.dryRun) {
      console.log(`Dry run: would fetch ${sourceUrl} -> ${path.resolve(process.cwd(), config.outputDir, config.outputFile)}`);
      process.exit(0);
    }
    try {
      const savedPath = await saveLlmsTextToFile({
        sourceUrl,
        outputDir: config.outputDir,
        outputFile: config.outputFile,
        userAgent: config.userAgent,
        timeoutMs: config.timeoutMs,
      });
      console.log(`Saved ${sourceUrl} -> ${savedPath}`);
      process.exit(0);
    } catch (err) {
      console.error(`llms-fetcher error: ${err && err.message}`);
      process.exit(1);
    }
  } else {
    console.log(`Scheduling daily fetch at ${config.runAt} for ${sourceUrl}`);
    startDailyScheduler(config, console);
  }
}

main();

