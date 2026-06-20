#!/usr/bin/env node
import { captureOverview, serializeOverviewText } from "./index.js";

interface CliOptions {
  url: string;
  json: boolean;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const tree = await captureOverview(options.url);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(tree, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${serializeOverviewText(tree)}\n`);
}

function parseArgs(args: string[]): CliOptions {
  let json = false;
  let url = "";

  for (const arg of args) {
    if (arg === "--json") {
      json = true;
      continue;
    }

    if (!url) {
      url = arg;
      continue;
    }

    throw new Error(`Unexpected argument: ${arg}`);
  }

  if (!url) {
    throw new Error("Usage: npm run overview -- <url> [--json]");
  }

  return { url, json };
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
