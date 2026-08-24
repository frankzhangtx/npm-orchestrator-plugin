#!/usr/bin/env node

import process from "node:process";

import { INSTALLER_COMMANDS } from "./commands/index.js";
import { formatDoctorReport, runDoctor } from "./doctor/index.js";

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

function printDoctorHelp(): void {
  process.stdout.write(`OpenCode Android Orchestrator doctor\n\n`);
  process.stdout.write(`Usage:\n`);
  process.stdout.write(
    `  opencode-android-orchestrator doctor [directory] [--json]\n`,
  );
}

const [command, ...commandArguments] = process.argv.slice(2);

if (command === undefined || command === "--help" || command === "-h") {
  printHelp();
} else if (command === "doctor") {
  if (commandArguments.includes("--help") || commandArguments.includes("-h")) {
    printDoctorHelp();
    process.exitCode = 0;
  } else {
    const unknownOptions = commandArguments.filter(
      (argument) => argument.startsWith("-") && argument !== "--json",
    );
    const targetDirectories = commandArguments.filter(
      (argument) => !argument.startsWith("-"),
    );
    if (unknownOptions.length > 0 || targetDirectories.length > 1) {
      process.stderr.write(
        `Unexpected doctor argument(s): ${[
          ...unknownOptions,
          ...targetDirectories.slice(1),
        ].join(", ")}\n`,
      );
      process.exitCode = 2;
    } else {
      const report = runDoctor({
        targetDirectory: targetDirectories[0] ?? process.cwd(),
      });
      if (commandArguments.includes("--json")) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        process.stdout.write(formatDoctorReport(report));
      }
      process.exitCode = report.ok ? 0 : 1;
    }
  }
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
