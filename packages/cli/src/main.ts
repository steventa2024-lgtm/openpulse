#!/usr/bin/env node
import { CliError, createProgram } from './program.js';

try {
  await createProgram().parseAsync(process.argv);
} catch (error) {
  if (error instanceof CliError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
  throw error;
}
