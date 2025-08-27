# llms-fetcher

Lightweight, framework-agnostic tool to fetch `llms.txt` daily from your public site and save it locally (default: `public/llms.txt`). Works with any Node.js project.

## Install

```bash
npm install llms-fetcher --save-dev
```

or

```bash
pnpm add -D llms-fetcher
```

## Configure

You must provide your site's public base URL so the fetcher can request `<publicUrl>/llms.txt`.

Options can come from (highest precedence first):

1. CLI flags
2. Environment variables
3. `package.json` `llmsFetcher` field
4. Defaults

### package.json

```json
{
  "llmsFetcher": {
    "publicUrl": "https://example.com",
    "outputDir": "public",
    "outputFile": "llms.txt",
    "runAt": "02:00",
    "timeoutMs": 20000,
    "userAgent": "my-app-llms-fetcher/1.0"
  }
}
```

## Zero-commands autostart (recommended)

If you want it fully automatic after configuration:

- Use Node preload once (no code changes): set environment var in your process manager

```bash
NODE_OPTIONS="--require llms-fetcher/register" node server.js
```

or configure it in your hosting platform's env config.

- Or add a one-line import in your server entry:

```js
require('llms-fetcher/register');
```

This starts the scheduler at runtime and keeps it live. By default it runs daily at `runAt`. To use interval-based scheduling instead, set:

```bash
LLMS_INTERVAL_HOURS=6
```

Disable autostart when needed:

```bash
LLMS_AUTOSTART_DISABLE=true
```

Notes:
- Autostart requires a long-running Node process. For fully serverless (short-lived) environments, prefer running the one-off command via a platform scheduler.

### Environment

- `LLMS_PUBLIC_URL`
- `LLMS_OUTPUT_DIR` (default: `public`)
- `LLMS_OUTPUT_FILE` (default: `llms.txt`)
- `LLMS_RUN_AT` (default: `02:00`)
- `LLMS_TIMEOUT_MS` (default: `20000`)
- `LLMS_USER_AGENT` (default: `llms-fetcher/0.1`)

### CLI

```bash
npx llms-fetcher run --public-url https://example.com --output-dir public --output-file llms.txt
npx llms-fetcher watch --public-url https://example.com --run-at 03:30
```

Flags:
- `--public-url, -u`
- `--output-dir, -o`
- `--output-file, -f`
- `--run-at, -t` (HH:MM 24h)
- `--interval-hours` (number; immediate run + every N hours)
- `--user-agent`
- `--timeout-ms`
- `--ttl-hours` (serverless freshness TTL)
- `--dry-run` (for `run` mode)

## Usage

### One-off fetch (CI or postbuild)

```bash
npx llms-fetcher run --public-url https://example.com
```

### Long-running daily scheduler (PM2, systemd, Docker)

```bash
npx llms-fetcher watch --public-url https://example.com --run-at 02:00
# or interval-based
npx llms-fetcher watch --public-url https://example.com --interval-hours 6
```

### Programmatic API

```js
const { resolveConfig, startDailyScheduler, saveLlmsTextToFile } = require('llms-fetcher');

const cfg = resolveConfig();
startDailyScheduler(cfg);

// or one-off
await saveLlmsTextToFile({
  sourceUrl: cfg.publicUrl.replace(/\/$/, '') + '/llms.txt',
  outputDir: cfg.outputDir,
  outputFile: cfg.outputFile,
  userAgent: cfg.userAgent,
  timeoutMs: cfg.timeoutMs,
});
```

### Serverless-friendly on-demand freshness

Use `ensure` (CLI) or `ensureFreshLlmsFile` (API) to lazily refresh the file based on TTL and conditional requests. This avoids long-running timers and works in serverless environments.

CLI (call at a safe point in your request/cron):

```bash
npx llms-fetcher ensure --public-url https://example.com --ttl-hours 12
```

API (e.g., at the start of a route handler):

```js
const { resolveConfig, ensureFreshLlmsFile } = require('llms-fetcher');
const cfg = resolveConfig();
await ensureFreshLlmsFile(cfg);
// then read from `${cfg.outputDir}/${cfg.outputFile}`
```

## Notes

- No runtime dependencies. Uses Node.js `http`/`https`.
- Designed to be framework-agnostic. Output defaults to `public/llms.txt`, common across frameworks (Next.js, Vite, SvelteKit, etc.).
- You can run the one-off command in CI after deployment to ensure the latest `llms.txt` is present.

## License

MIT

# d33l

test