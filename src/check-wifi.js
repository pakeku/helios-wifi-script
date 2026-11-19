const { execFile } = require('child_process');
const fs = require('fs/promises');
const path = require('path');

require('dotenv').config({
  path: path.join(__dirname, '..', '.env'),
  quiet: true,
});

const { Resend } = require('resend');

const SSID = 'Helios-Hannover-AP';
const STATE_PATH = path.join(__dirname, '..', 'data', 'wifi-state.json');
const DEFAULT_TO = 'support@heliosinstruments.zendesk.com';
const TIME_ZONE = 'Europe/Berlin';

const COLOR = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  brightGreen: '\x1b[92m',
};

const LEVEL_COLOR = {
  up: COLOR.green,
  back: COLOR.brightGreen,
  queued: COLOR.yellow,
  down: COLOR.red,
  warn: COLOR.yellow,
  error: COLOR.red,
  info: COLOR.cyan,
  ok: COLOR.green,
  dim: COLOR.dim,
};

const LEVEL_LABEL = {
  up: 'UP',
  back: 'ONLINE',
  queued: 'QUEUED',
  down: 'DOWN',
  warn: 'WARN',
  error: 'ERROR',
  info: 'INFO',
  ok: 'SENT',
};

function paint(level, text, stream) {
  const output = stream || process.stdout;
  if (!output.isTTY) return text;
  const color = LEVEL_COLOR[level] || COLOR.reset;
  return `${color}${text}${COLOR.reset}`;
}

function writeLine(level, message, { stamped = false, error = false } = {}) {
  const stream = error ? process.stderr : process.stdout;
  const body = paint(level, message, stream);
  const line = stamped ? `${paint('dim', `[${stamp()}] `, stream)}${body}` : body;
  if (error) console.error(line);
  else console.log(line);
}

function logStatus(level, message) {
  const label = (LEVEL_LABEL[level] || 'INFO').padEnd(6, ' ');
  const stream = level === 'error' ? process.stderr : process.stdout;
  const line = `${paint('dim', `[${stamp()}] `, stream)}${paint(level, `${label} ${message}`, stream)}`;
  if (level === 'error') console.error(line);
  else console.log(line);
}

function parseMinutes(raw) {
  const usage = [
    'Usage: npm run check-wifi -- <minutes>',
    'minutes is a whole number from 1 to 10.',
    'Example: npm run check-wifi -- 1',
  ].join('\n');

  if (raw === undefined) {
    return { ok: false, error: usage };
  }

  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 10) {
    return {
      ok: false,
      error: `Invalid interval "${raw}". Use a whole number from 1 to 10.\n${usage}`,
    };
  }

  return { ok: true, minutes: Number(raw) };
}

function formatWhen(iso) {
  if (!iso) {
    return 'unknown (no successful check has been recorded yet)';
  }

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return 'unknown (saved time could not be read)';
  }

  const formatted = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE,
    dateStyle: 'full',
    timeStyle: 'long',
  }).format(date);

  return `${formatted} (${TIME_ZONE})`;
}

function stamp() {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(new Date());
}

function freshState() {
  return {
    lastUpAt: null,
    consecutiveFailures: 0,
    downEmailSent: false,
  };
}

function classifyScan(stdout, stderr) {
  const output = `${stdout || ''}\n${stderr || ''}`;

  if (/location permission|access is denied|error 5/i.test(output)) {
    return {
      ok: false,
      reason:
        'Windows blocked the Wi-Fi scan because Location services are off. Turn location on for this PC. This check was not treated as the access point being down.',
    };
  }

  if (/no wireless interface|wlansvc is not running|not recognized/i.test(output)) {
    return {
      ok: false,
      reason:
        'This PC could not run a Wi-Fi scan. This check was not treated as the access point being down.',
    };
  }

  const listed = /currently visible/i.test(output) || /^\s*SSID\s+\d+\s*:/m.test(output);
  if (!listed) {
    return {
      ok: false,
      reason:
        'The Wi-Fi scan did not return a network list. This check was not treated as the access point being down.',
    };
  }

  const ssids = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*SSID\s+\d+\s*:\s*(.*)$/);
    if (!match) continue;
    const name = match[1].trim();
    if (name) ssids.push(name);
  }

  return { ok: true, up: ssids.includes(SSID) };
}

// First miss is queued. The down email waits for a second miss in a row.
// The back-online email is sent on the first check that sees the SSID again.
function evaluate(state, scan, nowIso) {
  if (!scan.ok) {
    return { state, send: null, level: 'warn', log: scan.reason };
  }

  if (scan.up) {
    if (state.downEmailSent) {
      return {
        state: {
          lastUpAt: nowIso,
          consecutiveFailures: 0,
          downEmailSent: false,
        },
        send: 'up',
        level: 'back',
        log: `${SSID} is back online. Sending email.`,
      };
    }

    return {
      state: {
        lastUpAt: nowIso,
        consecutiveFailures: 0,
        downEmailSent: false,
      },
      send: null,
      level: 'up',
      log: `${SSID} is up.`,
    };
  }

  const consecutiveFailures = state.consecutiveFailures + 1;

  if (state.downEmailSent) {
    return {
      state: { ...state, consecutiveFailures },
      send: null,
      level: 'down',
      log: `${SSID} is still down. Alert already sent.`,
    };
  }

  if (consecutiveFailures < 2) {
    return {
      state: { ...state, consecutiveFailures },
      send: null,
      level: 'queued',
      log: `${SSID} was not visible. Queued (${consecutiveFailures}/2).`,
    };
  }

  return {
    state: {
      ...state,
      consecutiveFailures,
      downEmailSent: true,
    },
    send: 'down',
    level: 'down',
    log: `${SSID} missed two checks. Sending down email.`,
  };
}

function downMessage({ lastUpAt, checkedAt, minutes }) {
  const interval = `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const text = [
    `${SSID} looks down. It failed two checks in a row.`,
    '',
    `Last seen up: ${formatWhen(lastUpAt)}`,
    `Checked at: ${formatWhen(checkedAt)}`,
    `Check interval: ${interval}`,
  ].join('\n');

  return {
    subject: `${SSID} is down`,
    text,
  };
}

function upMessage({ lastUpAt, checkedAt }) {
  const text = [
    `Hey, ${SSID} has come back online.`,
    '',
    `Back online: ${formatWhen(checkedAt)}`,
    `Last seen up before the outage: ${formatWhen(lastUpAt)}`,
  ].join('\n');

  return {
    subject: `${SSID} is back online`,
    text,
  };
}

function htmlFromText(text) {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return escaped
    .split('\n\n')
    .map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function scanNetworks() {
  return new Promise((resolve) => {
    execFile(
      'netsh',
      ['wlan', 'show', 'networks'],
      { timeout: 20000, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        resolve({
          stdout: stdout || '',
          stderr: stderr || error?.message || '',
        });
      },
    );
  });
}

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const failures = parsed.consecutiveFailures;

    return {
      lastUpAt: typeof parsed.lastUpAt === 'string' ? parsed.lastUpAt : null,
      consecutiveFailures: Number.isInteger(failures) && failures > 0 ? failures : 0,
      downEmailSent: parsed.downEmailSent === true,
    };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      writeLine('warn', `Could not read the saved Wi-Fi state. Starting fresh. ${error.message}`, { error: true });
    }
    return freshState();
  }
}

async function saveState(state) {
  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
  await fs.writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

function errorText(error) {
  if (!error) return 'Unknown email error';
  if (typeof error === 'string') return error;
  if (error.message) return error.message;
  return JSON.stringify(error);
}

async function sendMail(resend, { from, to, subject, text }) {
  const { error } = await resend.emails.send({
    from,
    to: [to],
    subject,
    text,
    html: htmlFromText(text),
  });

  if (error) {
    throw new Error(errorText(error));
  }
}

function sleep(ms, shouldStop) {
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (shouldStop() || Date.now() - started >= ms) {
        clearInterval(timer);
        resolve();
      }
    }, 500);
  });
}

async function runOnce(state, { resend, from, to, minutes }) {
  const scanned = await scanNetworks();
  const scan = classifyScan(scanned.stdout, scanned.stderr);
  const nowIso = new Date().toISOString();
  const decision = evaluate(state, scan, nowIso);

  logStatus(decision.level, decision.log);

  if (!decision.send) {
    try {
      await saveState(decision.state);
    } catch (error) {
      logStatus('warn', `Could not save Wi-Fi state: ${error.message}`);
    }
    return decision.state;
  }

  const message = decision.send === 'up'
    ? upMessage({ lastUpAt: state.lastUpAt, checkedAt: nowIso })
    : downMessage({ lastUpAt: state.lastUpAt, checkedAt: nowIso, minutes });

  try {
    await sendMail(resend, { from, to, ...message });
    logStatus('ok', `Email sent to ${to}.`);
  } catch (error) {
    logStatus('error', `Email failed, will retry on the next check: ${errorText(error)}`);
    const kept = {
      lastUpAt: state.lastUpAt,
      consecutiveFailures: scan.up ? state.consecutiveFailures : decision.state.consecutiveFailures,
      downEmailSent: state.downEmailSent,
    };
    try {
      await saveState(kept);
    } catch (saveError) {
      logStatus('warn', `Could not save Wi-Fi state: ${saveError.message}`);
    }
    return kept;
  }

  try {
    await saveState(decision.state);
  } catch (error) {
    logStatus('warn', `Could not save Wi-Fi state: ${error.message}`);
  }

  return decision.state;
}

async function main() {
  const parsed = parseMinutes(process.argv[2]);
  if (!parsed.ok) {
    writeLine('error', parsed.error, { error: true });
    process.exit(1);
  }

  const apiKey = (process.env.RESEND_KEY || '').trim();
  const from = (process.env.EMAIL_FROM || '').trim();
  const to = (process.env.EMAIL_TO || '').trim() || DEFAULT_TO;

  if (!apiKey || !from) {
    writeLine('error', 'Add RESEND_KEY and EMAIL_FROM to .env in the project root.', { error: true });
    writeLine('error', `Down and recovery emails go to ${to}.`, { error: true });
    writeLine('error', 'EMAIL_FROM must be a sender on a domain you have verified in Resend.', { error: true });
    process.exit(1);
  }

  const resend = new Resend(apiKey);
  const stop = { stopping: false };
  const requestStop = () => {
    if (stop.stopping) return;
    stop.stopping = true;
    writeLine('info', 'Stopping after the current check.');
  };

  process.on('SIGINT', requestStop);
  process.on('SIGTERM', requestStop);

  let state = await loadState();
  const every = `${parsed.minutes} minute${parsed.minutes === 1 ? '' : 's'}`;
  writeLine('info', `Watching ${SSID} every ${every}. Ctrl+C stops it.`);
  writeLine('info', `Emails go to ${to} after two missed checks, then again when it comes back.`);
  if (state.lastUpAt) {
    writeLine('info', `Last recorded up time: ${formatWhen(state.lastUpAt)}`);
  }

  while (!stop.stopping) {
    state = await runOnce(state, {
      resend,
      from,
      to,
      minutes: parsed.minutes,
    });

    if (stop.stopping) break;
    await sleep(parsed.minutes * 60 * 1000, () => stop.stopping);
  }
}

if (require.main === module) {
  main().catch((error) => {
    writeLine('error', errorText(error), { error: true });
    process.exit(1);
  });
}

module.exports = {
  SSID,
  classifyScan,
  evaluate,
  parseMinutes,
  downMessage,
  upMessage,
  formatWhen,
};
