#!/usr/bin/env node

import process from "node:process";

import { INSTALLER_COMMANDS } from "./commands/index.js";
import { formatDoctorReport, runDoctor } from "./doctor/index.js";
import {
  formatProjectInitializationResult,
  runProjectInitialization,
  type ProjectInitializationOptions,
} from "./installer/init.js";
import {
  formatProjectUpgradeResult,
  runProjectUpgrade,
  type ProjectUpgradeOptions,
} from "./installer/upgrade.js";
import {
  formatProjectUninstallResult,
  runProjectUninstall,
} from "./installer/uninstall.js";

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

function printInitHelp(): void {
  process.stdout.write(`OpenCode Android Orchestrator init\n\n`);
  process.stdout.write(`Usage:\n`);
  process.stdout.write(
    `  opencode-android-orchestrator init [directory] [--primary-module <gradle-path>] [--json]\n`,
  );
}

function printDoctorHelp(): void {
  process.stdout.write(`OpenCode Android Orchestrator doctor\n\n`);
  process.stdout.write(`Usage:\n`);
  process.stdout.write(
    `  opencode-android-orchestrator doctor [directory] [--json]\n`,
  );
}

function printUpgradeHelp(): void {
  process.stdout.write(`OpenCode Android Orchestrator upgrade\n\n`);
  process.stdout.write(`Usage:\n`);
  process.stdout.write(
    `  opencode-android-orchestrator upgrade [directory] [--primary-module <gradle-path>] [--json]\n`,
  );
}

function printUninstallHelp(): void {
  process.stdout.write(`OpenCode Android Orchestrator uninstall\n\n`);
  process.stdout.write(`Usage:\n`);
  process.stdout.write(
    `  opencode-android-orchestrator uninstall [directory] [--json]\n`,
  );
}

function errorDetails(error: unknown): readonly string[] {
  if (
    typeof error === "object" &&
    error !== null &&
    "details" in error &&
    Array.isArray(error.details) &&
    error.details.every((detail) => typeof detail === "string")
  ) {
    return error.details as readonly string[];
  }
  return [];
}

function printCommandError(error: unknown): void {
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
      ? ` [${error.code}]`
      : "";
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error${code}: ${message}\n`);
  for (const detail of errorDetails(error)) {
    process.stderr.write(`  ${detail}\n`);
  }
}

const [command, ...commandArguments] = process.argv.slice(2);

if (command === undefined || command === "--help" || command === "-h") {
  printHelp();
} else if (command === "init") {
  if (commandArguments.includes("--help") || commandArguments.includes("-h")) {
    printInitHelp();
    process.exitCode = 0;
  } else {
    let targetDirectory: string | undefined;
    let primaryModule: string | undefined;
    let json = false;
    const unexpected: string[] = [];

    for (let index = 0; index < commandArguments.length; index += 1) {
      const argument = commandArguments[index] ?? "";
      if (argument === "--json") {
        json = true;
      } else if (argument === "--primary-module") {
        const value = commandArguments[index + 1];
        if (value === undefined || value.startsWith("-")) {
          unexpected.push(argument);
        } else {
          primaryModule = value;
          index += 1;
        }
      } else if (argument.startsWith("--primary-module=")) {
        const value = argument.slice("--primary-module=".length);
        if (value.length === 0) {
          unexpected.push(argument);
        } else {
          primaryModule = value;
        }
      } else if (argument.startsWith("-")) {
        unexpected.push(argument);
      } else if (targetDirectory === undefined) {
        targetDirectory = argument;
      } else {
        unexpected.push(argument);
      }
    }

    if (unexpected.length > 0) {
      process.stderr.write(
        `Unexpected init argument(s): ${unexpected.join(", ")}\n`,
      );
      process.exitCode = 2;
    } else {
      const options: ProjectInitializationOptions = {};
      if (primaryModule !== undefined) {
        options.primaryModule = primaryModule;
      }
      try {
        const result = runProjectInitialization(
          targetDirectory ?? process.cwd(),
          options,
        );
        process.stdout.write(
          json
            ? `${JSON.stringify(result, null, 2)}\n`
            : formatProjectInitializationResult(result),
        );
        process.exitCode = 0;
      } catch (error) {
        printCommandError(error);
        process.exitCode = 1;
      }
    }
  }
} else if (command === "upgrade") {
  if (commandArguments.includes("--help") || commandArguments.includes("-h")) {
    printUpgradeHelp();
    process.exitCode = 0;
  } else {
    let targetDirectory: string | undefined;
    let primaryModule: string | undefined;
    let json = false;
    const unexpected: string[] = [];

    for (let index = 0; index < commandArguments.length; index += 1) {
      const argument = commandArguments[index] ?? "";
      if (argument === "--json") {
        json = true;
      } else if (argument === "--primary-module") {
        const value = commandArguments[index + 1];
        if (value === undefined || value.startsWith("-")) {
          unexpected.push(argument);
        } else {
          primaryModule = value;
          index += 1;
        }
      } else if (argument.startsWith("--primary-module=")) {
        const value = argument.slice("--primary-module=".length);
        if (value.length === 0) {
          unexpected.push(argument);
        } else {
          primaryModule = value;
        }
      } else if (argument.startsWith("-")) {
        unexpected.push(argument);
      } else if (targetDirectory === undefined) {
        targetDirectory = argument;
      } else {
        unexpected.push(argument);
      }
    }

    if (unexpected.length > 0) {
      process.stderr.write(
        `Unexpected upgrade argument(s): ${unexpected.join(", ")}\n`,
      );
      process.exitCode = 2;
    } else {
      const options: ProjectUpgradeOptions = {};
      if (primaryModule !== undefined) {
        options.primaryModule = primaryModule;
      }
      try {
        const result = runProjectUpgrade(
          targetDirectory ?? process.cwd(),
          options,
        );
        process.stdout.write(
          json
            ? `${JSON.stringify(result, null, 2)}\n`
            : formatProjectUpgradeResult(result),
        );
        process.exitCode = 0;
      } catch (error) {
        printCommandError(error);
        process.exitCode = 1;
      }
    }
  }
} else if (command === "uninstall") {
  if (commandArguments.includes("--help") || commandArguments.includes("-h")) {
    printUninstallHelp();
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
        `Unexpected uninstall argument(s): ${[
          ...unknownOptions,
          ...targetDirectories.slice(1),
        ].join(", ")}\n`,
      );
      process.exitCode = 2;
    } else {
      try {
        const result = runProjectUninstall(
          targetDirectories[0] ?? process.cwd(),
        );
        process.stdout.write(
          commandArguments.includes("--json")
            ? `${JSON.stringify(result, null, 2)}\n`
            : formatProjectUninstallResult(result),
        );
        process.exitCode = 0;
      } catch (error) {
        printCommandError(error);
        process.exitCode = 1;
      }
    }
  }
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
        checkDependencies: true,
        checkInstallation: true,
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
