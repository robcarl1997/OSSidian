#!/usr/bin/env node
// Debug harness for Obsidian-clone Electron app.
//
// Usage:
//   node scripts/debug-cli.mjs <command> [args...]
//
// Commands form a single session: each invocation launches Electron, runs the
// commands in sequence, and exits. Commands are separated by `--`.
//
// Examples:
//   node scripts/debug-cli.mjs eval "document.title"
//   node scripts/debug-cli.mjs wait ".cm-content" -- press "Ctrl+d" -- eval "window.scrollY"
//   node scripts/debug-cli.mjs screenshot /tmp/state.png
//
// Available commands:
//   eval <js>            — evaluate JS in renderer, print result
//   evalHandle <js>      — evaluate JS, print as JSON
//   click <selector>     — click DOM selector
//   press <key>          — press keyboard key (e.g. "Ctrl+d", "Escape", "j")
//   type <text>          — type literal text
//   wait <selector>      — wait for selector to appear
//   waitMs <ms>          — sleep N milliseconds
//   screenshot <path>    — save full-window PNG
//   logs                 — print all main+renderer console logs collected so far
//   focus <selector>     — focus selector
//   reload               — reload renderer
//
// Set DEBUG_CLI_HEADLESS=1 to skip showing the window where supported.

import { _electron as electron } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

// Parse argv into an array of [cmd, ...args] groups separated by '--'
function parseCommands(argv) {
  const groups = [];
  let cur = [];
  for (const a of argv) {
    if (a === '--') {
      if (cur.length) groups.push(cur);
      cur = [];
    } else {
      cur.push(a);
    }
  }
  if (cur.length) groups.push(cur);
  return groups;
}

const commands = parseCommands(process.argv.slice(2));
if (commands.length === 0) {
  console.error('No commands given. See scripts/debug-cli.mjs header for usage.');
  process.exit(1);
}

const logs = [];

const app = await electron.launch({
  args: ['.'],
  cwd: projectRoot,
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
});

// Capture main process stdout/stderr
app.process().stdout.on('data', (d) => logs.push(`[main:out] ${d.toString().trimEnd()}`));
app.process().stderr.on('data', (d) => logs.push(`[main:err] ${d.toString().trimEnd()}`));

const window = await app.firstWindow();

window.on('console', (msg) => logs.push(`[renderer:${msg.type()}] ${msg.text()}`));
window.on('pageerror', (err) => logs.push(`[renderer:error] ${err.message}\n${err.stack}`));

// Wait for the app shell (body always exists; .cm-editor may not if no note open)
await window.waitForSelector('body', { timeout: 15000 });

async function runCommand(group) {
  const [cmd, ...rest] = group;
  switch (cmd) {
    case 'eval': {
      const js = rest.join(' ');
      const result = await window.evaluate(`(async () => { return (${js}); })()`);
      console.log(JSON.stringify(result));
      break;
    }
    case 'evalHandle': {
      const js = rest.join(' ');
      const result = await window.evaluate(`(async () => { return (${js}); })()`);
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case 'click':
      await window.click(rest.join(' '));
      break;
    case 'press':
      await window.keyboard.press(rest.join(' '));
      break;
    case 'type':
      await window.keyboard.type(rest.join(' '));
      break;
    case 'wait':
      await window.waitForSelector(rest.join(' '));
      break;
    case 'waitMs':
      await new Promise((r) => setTimeout(r, parseInt(rest[0], 10)));
      break;
    case 'screenshot':
      await window.screenshot({ path: rest[0], fullPage: false });
      console.log(`saved ${rest[0]}`);
      break;
    case 'focus':
      await window.focus(rest.join(' '));
      break;
    case 'reload':
      await window.reload();
      await window.waitForSelector('.cm-editor', { timeout: 15000 });
      break;
    case 'logs':
      for (const l of logs) console.log(l);
      break;
    default:
      console.error(`unknown command: ${cmd}`);
  }
}

let exitCode = 0;
try {
  for (const group of commands) {
    await runCommand(group);
  }
} catch (e) {
  console.error('[debug-cli] command failed:', e.message);
  console.error('--- recent logs ---');
  for (const l of logs.slice(-30)) console.error(l);
  exitCode = 3;
}

await app.close();
process.exit(exitCode);
