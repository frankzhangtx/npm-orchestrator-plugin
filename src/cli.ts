#!/usr/bin/env node

import process from "node:process";

import { INSTALLER_COMMANDS } from "./commands/index.js";

function printHelp(): void {
  process.stdout.write(`OpenCode Android Orchestrator\n\n`);
  process.stdout.write(`Usage:\n`);
  process.stdout.write(`  opencode-android-orchestrator <command> [directory]\n\n`);
  process.stdout.write(`Commands:\n`);
  process.stdout.write(`  init       Install project-local orchestration resources\n`);
  process.stdout.write(`  doctor     Diagnose an existing installation\n`);
  process.stdout.write(`  upgrade    Upgrade unchanged managed resources\n`);
  process.stdout.write(`  uninstall  Remove unchanged managed resources\n`);
}

const [command] = process.argv.slice(2);

if (command === undefined || command === "--help" || command === "-h") {
  printHelp();
} else if ((INSTALLER_COMMANDS as readonly string[]).includes(command)) {
  process.stderr.write(
    `Command "${command}" is scaffolded but not implemented yet.\n`,
  );
  process.exitCode = 1;
} else {
  process.stderr.write(`Unknown command: ${command}\n\n`);
  printHelp();
  process.exitCode = 2;
}
