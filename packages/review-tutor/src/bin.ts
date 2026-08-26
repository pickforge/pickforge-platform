#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { nodeCliDeps, runCli } from "./cli.ts";

/**
 * The installed `review-tutor` is a symlink into this file, so it can never
 * compare argv[1] with its own URL; this entry exists only to be run.
 */
process.exitCode = await runCli(
  process.argv.slice(2),
  nodeCliDeps(fileURLToPath(import.meta.url)),
);
