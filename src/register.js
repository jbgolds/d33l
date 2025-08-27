'use strict';

const { resolveConfig, startDailyScheduler } = require('./index');

(function autostart() {
  const disable = String(process.env.LLMS_AUTOSTART_DISABLE || '').toLowerCase();
  if (disable === '1' || disable === 'true') {
    return;
  }
  try {
    const config = resolveConfig({});
    if (!config.publicUrl) {
      // Silent no-op if not configured yet
      return;
    }
    const mode = (Number.isFinite(config.intervalHours) && config.intervalHours > 0)
      ? `every ${config.intervalHours}h`
      : `daily at ${config.runAt}`;
    (console.info?.bind(console) || console.log)(`llms-fetcher/register: starting scheduler (${mode}) for ${config.publicUrl}`);
    startDailyScheduler(config, console);
  } catch (err) {
    (console.error?.bind(console) || console.log)(`llms-fetcher/register error: ${err && err.message}`);
  }
})();

