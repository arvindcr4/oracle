import chalk from 'chalk';
import { createDefaultClientFactory } from '../oracle/client.js';
import { getStoredResponses, getResponseById, updateResponseStatus } from '../oracle/responseStore.js';
import { extractTextOutput } from '../oracle/run.js';
import { formatElapsed } from '../oracle/format.js';
import type { OracleResponse } from '../oracle/types.js';

export interface RetrieveResponseOptions {
  responseId?: string;
  list?: boolean;
  apiKey?: string;
  verbose?: boolean;
}

export async function retrieveResponse(options: RetrieveResponseOptions): Promise<void> {
  const log = console.log;

  if (options.list) {
    const responses = await getStoredResponses();
    if (responses.length === 0) {
      log('No stored responses found.');
      return;
    }

    log(chalk.bold('Stored Oracle Responses:'));
    log('');

    for (const response of responses) {
      const date = new Date(response.timestamp).toLocaleString();
      const status = response.status || 'unknown';
      const statusColor = status === 'completed' ? chalk.green : status === 'failed' ? chalk.red : chalk.yellow;

      log(`${chalk.cyan(response.id)}`);
      log(`  Model: ${response.model}`);
      log(`  Status: ${statusColor(status)}`);
      log(`  Date: ${date}`);
      log(`  Prompt: ${chalk.dim(response.prompt)}...`);
      log('');
    }
    return;
  }

  if (!options.responseId) {
    log(chalk.red('Please provide a response ID with --response-id or use --list to see stored responses'));
    process.exit(1);
  }

  const storedResponse = await getResponseById(options.responseId);
  if (!storedResponse) {
    log(chalk.red(`Response ID ${options.responseId} not found in stored responses.`));
    log(chalk.dim('Use --list to see available response IDs.'));
    process.exit(1);
  }

  const apiKey = options.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    log(chalk.red('Missing OPENAI_API_KEY. Set it via the environment or --api-key'));
    process.exit(1);
  }

  const clientFactory = createDefaultClientFactory();
  const client = clientFactory(apiKey);

  log(chalk.blue(`Retrieving response ${options.responseId}...`));

  try {
    const startTime = Date.now();
    const response = await client.responses.retrieve(options.responseId) as OracleResponse;

    if (response.status !== storedResponse.status) {
      await updateResponseStatus(options.responseId, response.status || 'unknown');
    }

    const elapsedMs = Date.now() - startTime;
    log(chalk.green(`Response retrieved in ${formatElapsed(elapsedMs)}`));
    log('');

    if (response.status !== 'completed') {
      log(chalk.yellow(`Response status: ${response.status}`));
      if (response.error) {
        log(chalk.red(`Error: ${response.error.message}`));
      }
      if (response.incomplete_details) {
        log(chalk.yellow(`Incomplete reason: ${response.incomplete_details.reason}`));
      }
    } else {
      const text = extractTextOutput(response);
      log(chalk.bold('Response:'));
      log(text || chalk.dim('(no text output)'));
    }

    if (options.verbose && response.usage) {
      log('');
      log(chalk.dim('Usage:'));
      log(chalk.dim(`  Input tokens: ${response.usage.input_tokens || 0}`));
      log(chalk.dim(`  Output tokens: ${response.usage.output_tokens || 0}`));
      log(chalk.dim(`  Reasoning tokens: ${response.usage.reasoning_tokens || 0}`));
      log(chalk.dim(`  Total tokens: ${response.usage.total_tokens || 0}`));
    }
  } catch (error) {
    log(chalk.red(`Failed to retrieve response: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }
}