import chalk from 'chalk';
import {
  MODEL_CONFIGS,
  TOKENIZER_OPTIONS,
  DEFAULT_SYSTEM_PROMPT,
  buildPrompt,
  readFiles,
  getFileTokenStats,
  printFileTokenStats,
  type RunOracleOptions,
} from '../oracle.js';
import { assembleBrowserPrompt, type BrowserPromptArtifacts } from '../browser/prompt.js';
import type { BrowserAttachment } from '../browser/types.js';
import { buildTokenEstimateSuffix, formatAttachmentLabel } from '../browser/promptSummary.js';

interface DryRunDeps {
  readFilesImpl?: typeof readFiles;
  assembleBrowserPromptImpl?: typeof assembleBrowserPrompt;
}

export async function runDryRunSummary(
  {
    engine,
    runOptions,
    cwd,
    version,
    log,
  }: {
    engine: 'api' | 'browser' | 'gemini';
    runOptions: RunOracleOptions;
    cwd: string;
    version: string;
    log: (message: string) => void;
  },
  deps: DryRunDeps = {},
): Promise<void> {
  if (engine === 'api') {
    await runApiDryRun({ runOptions, cwd, version, log }, deps);
    return;
  }
  await runBrowserDryRun({ runOptions, cwd, version, log }, deps);
}

async function runApiDryRun(
  {
    runOptions,
    cwd,
    version,
    log,
  }: {
    runOptions: RunOracleOptions;
    cwd: string;
    version: string;
    log: (message: string) => void;
  },
  deps: DryRunDeps,
): Promise<void> {
  const readFilesImpl = deps.readFilesImpl ?? readFiles;
  const files = await readFilesImpl(runOptions.file ?? [], { cwd });
  const systemPrompt = runOptions.system?.trim() || DEFAULT_SYSTEM_PROMPT;
  const combinedPrompt = buildPrompt(runOptions.prompt ?? '', files, cwd);
  const tokenizer = MODEL_CONFIGS[runOptions.model].tokenizer;
  const estimatedInputTokens = tokenizer(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: combinedPrompt },
    ],
    TOKENIZER_OPTIONS,
  );
  const headerLine = `[dry-run] Oracle (${version}) would call ${runOptions.model} with ~${estimatedInputTokens.toLocaleString()} tokens and ${files.length} files.`;
  log(chalk.cyan(headerLine));
  if (files.length === 0) {
    log(chalk.dim('[dry-run] No files matched the provided --file patterns.'));
    return;
  }
  const inputBudget = runOptions.maxInput ?? MODEL_CONFIGS[runOptions.model].inputLimit;
  const stats = getFileTokenStats(files, {
    cwd,
    tokenizer,
    tokenizerOptions: TOKENIZER_OPTIONS,
    inputTokenBudget: inputBudget,
  });
  printFileTokenStats(stats, { inputTokenBudget: inputBudget, log });
}

async function runBrowserDryRun(
  {
    runOptions,
    cwd,
    version,
    log,
  }: {
    runOptions: RunOracleOptions;
    cwd: string;
    version: string;
    log: (message: string) => void;
  },
  deps: DryRunDeps,
): Promise<void> {
  const assemblePromptImpl = deps.assembleBrowserPromptImpl ?? assembleBrowserPrompt;
  const artifacts = await assemblePromptImpl(runOptions, { cwd });
  const suffix = buildTokenEstimateSuffix(artifacts);
  const headerLine = `[dry-run] Oracle (${version}) would launch browser mode (${runOptions.model}) with ~${artifacts.estimatedInputTokens.toLocaleString()} tokens${suffix}.`;
  log(chalk.cyan(headerLine));
  logBrowserFileSummary(artifacts, log);
}

function logBrowserFileSummary(artifacts: BrowserPromptArtifacts, log: (message: string) => void) {
  if (artifacts.attachments.length > 0) {
    log(chalk.bold('[dry-run] Attachments to upload:'));
    artifacts.attachments.forEach((attachment: BrowserAttachment) => {
      log(`  • ${formatAttachmentLabel(attachment)}`);
    });
    return;
  }
  if (artifacts.inlineFileCount > 0) {
    log(chalk.bold('[dry-run] Inline file content:'));
    log(`  • ${artifacts.inlineFileCount} file${artifacts.inlineFileCount === 1 ? '' : 's'} pasted directly into the composer.`);
    return;
  }
  log(chalk.dim('[dry-run] No files attached.'));
}
