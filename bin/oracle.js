#!/usr/bin/env bun
import 'dotenv/config';
import { Command, InvalidArgumentError } from 'commander';
import chalk from 'chalk';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ensureSessionStorage, initializeSession, updateSessionMetadata, readSessionMetadata, listSessionsMetadata, filterSessionsByRange, createSessionLogWriter, readSessionLog, wait, SESSIONS_DIR } from '../src/sessionManager.js';
import { runOracle, MODEL_CONFIGS, parseIntOption, renderPromptMarkdown } from '../src/oracle.js';

const SCRIPT_PATH = fileURLToPath(import.meta.url);

const program = new Command();
program
  .name('oracle')
  .description('One-shot GPT-5 Pro / GPT-5.1 tool for hard questions that benefit from large file context and server-side search.')
  .option('-p, --prompt <text>', 'User prompt to send to the model.')
  .option('-f, --file <paths...>', 'Paths to files or directories to append to the prompt; repeat or supply a space-separated list.', collectPaths, [])
  .option('-m, --model <model>', 'Model to target (gpt-5-pro | gpt-5.1).', validateModel, 'gpt-5-pro')
  .option('--search', 'Allow the model to make server-side web_search tool calls.', true)
  .option('--max-input <tokens>', 'Override the max input token budget (defaults to the model limit).', parseIntOption)
  .option('--system <text>', 'Override the default system prompt.')
  .option('--max-output <tokens>', 'Hard limit for output tokens (optional).', parseIntOption)
  .option('--files-report', 'Show token usage per attached file (also prints automatically when files exceed the token budget).', false)
  .option('--preview', 'Preview the request and token usage without making an API call.', false)
  .option('--preview-json', 'When using --preview, also dump the full JSON payload.', false)
  .option('--silent', 'Hide the model answer and only print stats.', false)
  .option('--exec-session <id>', 'Internal flag used for detached session execution.')
  .option('--session <id>', 'Attach to a running or completed session and stream its output.')
  .option('--status', 'List recent sessions (last 24h by default).', false)
  .option('--status-hours <hours>', 'Look back this many hours for --status (default 24).', parseFloatOption, 24)
  .option('--status-all', 'Show all stored sessions regardless of age.', false)
  .option('--status-limit <count>', 'Maximum sessions to show (max 1000).', parseIntOption, 100)
  .option('--render-markdown', 'Emit the assembled markdown bundle for prompt + files and exit.', false)
  .showHelpAfterError('(use --help for usage)');

program.addHelpText(
  'after',
  `
Tips:
  • This CLI is tuned for tough questions where GPT-5 needs rich context. Attach source files for best results but keep the total size below the ~196k-token window.
  • Use --files-report to see how many tokens each attachment consumes before paying for a run.
  • Non-preview runs spawn a detached session that keeps going even if your terminal closes.

Examples:
  $ oracle --prompt "Summarize risks" --file docs/risk.md --files-report --preview
    (inspect the token budget and attached files without hitting the API)

  $ oracle --prompt "Explain bug" --file src/ --files-report
    (launches a background session; note the Session ID in the output)

  $ oracle --status
    (lists recent sessions; add --status-hours 72 or --status-all to widen the range)

  $ oracle --session <sessionId>
    (attach to an existing request, follow the live stream if still running, or replay the saved transcript)
`,
);

function collectPaths(value, previous) {
  if (!value) {
    return previous;
  }
  const nextValues = Array.isArray(value) ? value : [value];
  return previous.concat(nextValues.flatMap((entry) => entry.split(',')).map((entry) => entry.trim()).filter(Boolean));
}

function parseFloatOption(value) {
  const parsed = Number.parseFloat(value);
  if (Number.isNaN(parsed)) {
    throw new InvalidArgumentError('Value must be a number.');
  }
  return parsed;
}

function validateModel(value) {
  if (!MODEL_CONFIGS[value]) {
    throw new InvalidArgumentError(`Unsupported model "${value}". Choose one of: ${Object.keys(MODEL_CONFIGS).join(', ')}`);
  }
  return value;
}

async function main() {
  const options = program.parse(process.argv).opts();

  if (process.argv.length <= 2) {
    program.outputHelp();
    return;
  }

  if (options.session) {
    await attachSession(options.session);
    return;
  }

  if (options.status) {
    await showStatus({ hours: options.statusHours, includeAll: options.statusAll, limit: options.statusLimit });
    return;
  }

  if (options.execSession) {
    await executeSession(options.execSession);
    return;
  }

  if (options.renderMarkdown) {
    if (!options.prompt) {
      throw new Error('Prompt is required when using --render-markdown.');
    }
    const markdown = await renderPromptMarkdown(options, { cwd: process.cwd() });
    console.log(markdown);
    return;
  }

  if (options.preview) {
    if (!options.prompt) {
      throw new Error('Prompt is required when using --preview.');
    }
    await runOracle(options, { log: console.log, write: (chunk) => process.stdout.write(chunk) });
    return;
  }

  if (!options.prompt) {
    throw new Error('Prompt is required when starting a new session.');
  }

  await ensureSessionStorage();
  const sessionMeta = await initializeSession(options, process.cwd());
  spawnDetachedSession(sessionMeta.id);
  console.log(chalk.bold(`Session ${sessionMeta.id} started`));
  console.log(`Follow progress with: oracle --session ${sessionMeta.id}`);
  console.log('Use --status to review recent sessions.');
}

function spawnDetachedSession(sessionId) {
  const child = spawn(process.execPath, [SCRIPT_PATH, '--exec-session', sessionId], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

async function executeSession(sessionId) {
  const metadata = await readSessionMetadata(sessionId);
  if (!metadata) {
    console.error(chalk.red(`No session found with ID ${sessionId}`));
    process.exitCode = 1;
    return;
  }
  const options = { ...metadata.options, sessionId }; // include sessionId for logging
  options.file = metadata.options.file ?? [];
  options.preview = false;
  options.silent = false;
  options.prompt = metadata.options.prompt;
  const { logLine, writeChunk, stream } = createSessionLogWriter(sessionId);
  try {
    await updateSessionMetadata(sessionId, { status: 'running', startedAt: new Date().toISOString() });
    const result = await runOracle(options, {
      cwd: metadata.cwd,
      log: logLine,
      write: writeChunk,
      sessionId,
    });
    await updateSessionMetadata(sessionId, {
      status: 'completed',
      completedAt: new Date().toISOString(),
      usage: result.usage,
      elapsedMs: result.elapsedMs,
    });
  } catch (error) {
    logLine(`ERROR: ${error?.message ?? error}`);
    await updateSessionMetadata(sessionId, {
      status: 'error',
      completedAt: new Date().toISOString(),
      errorMessage: error?.message ?? String(error),
    });
  } finally {
    stream.end();
  }
}

async function showStatus({ hours, includeAll, limit }) {
  const metas = await listSessionsMetadata();
  const { entries, truncated, total } = filterSessionsByRange(metas, { hours, includeAll, limit });
  if (!entries.length) {
    console.log('No sessions found for the requested range.');
    return;
  }
  console.log(chalk.bold('Recent Sessions'));
  for (const entry of entries) {
    const status = (entry.status || 'unknown').padEnd(9);
    const model = (entry.model || 'n/a').padEnd(10);
    const created = entry.createdAt.replace('T', ' ').replace('Z', '');
    console.log(`${created} | ${status} | ${model} | ${entry.id}`);
  }
  if (truncated) {
    console.log(
      chalk.yellow(
        `Showing ${entries.length} of ${total} sessions from the requested range. Delete older entries in ${SESSIONS_DIR} to free space or rerun with --status-limit/--status-all.`,
      ),
    );
  }
}

async function attachSession(sessionId) {
  const metadata = await readSessionMetadata(sessionId);
  if (!metadata) {
    console.error(chalk.red(`No session found with ID ${sessionId}`));
    process.exitCode = 1;
    return;
  }
  console.log(chalk.bold(`Session ${sessionId}`));
  console.log(`Created: ${metadata.createdAt}`);
  console.log(`Status: ${metadata.status}`);
  console.log(`Model: ${metadata.model}`);

  let lastLength = 0;
  const printNew = async () => {
    const text = await readSessionLog(sessionId);
    const nextChunk = text.slice(lastLength);
    if (nextChunk.length > 0) {
      process.stdout.write(nextChunk);
      lastLength = text.length;
    }
  };

  await printNew();

  while (true) {
    const latest = await readSessionMetadata(sessionId);
    if (!latest) {
      break;
    }
    if (latest.status === 'completed' || latest.status === 'error') {
      await printNew();
      if (latest.status === 'error' && latest.errorMessage) {
        console.log(`\nSession failed: ${latest.errorMessage}`);
      }
      if (latest.usage) {
        const usage = latest.usage;
        console.log(`\nFinished (tok i/o/r/t: ${usage.inputTokens}/${usage.outputTokens}/${usage.reasoningTokens}/${usage.totalTokens})`);
      }
      break;
    }
    await wait(1000);
    await printNew();
  }
}

await main().catch((error) => {
  console.error(chalk.red('✖'), error?.message || error);
  process.exitCode = 1;
});
