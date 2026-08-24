import assert from "node:assert/strict";
import test from "node:test";

import {
  checkOpenCodeVersion,
  formatDoctorReport,
  parseOpenCodeVersion,
  runDoctor,
} from "../dist/index.js";

test("extracts OpenCode semantic versions from command output", () => {
  assert.deepEqual(parseOpenCodeVersion("opencode version v1.15.13\n"), {
    major: 1,
    minor: 15,
    patch: 13,
    prerelease: [],
    normalized: "1.15.13",
  });
  assert.equal(parseOpenCodeVersion("not a version"), null);
});

test("classifies certified, warned, and unsupported OpenCode versions", () => {
  assert.equal(checkOpenCodeVersion("1.14.22").support, "certified");
  assert.equal(checkOpenCodeVersion("1.15.13").support, "certified");
  assert.equal(
    checkOpenCodeVersion("OpenCode 1.15.7").support,
    "supported-uncertified",
  );
  assert.equal(checkOpenCodeVersion("1.14.21").support, "unsupported");
  assert.equal(checkOpenCodeVersion("1.16.0").support, "unsupported");
  assert.equal(checkOpenCodeVersion("unknown").support, "invalid");
});

test("doctor passes a certified OpenCode executable", () => {
  const report = runDoctor({
    runCommand: (executable, args) => {
      assert.equal(executable, "opencode");
      assert.deepEqual(args, ["--version"]);
      return {
        status: 0,
        stdout: "1.15.13\n",
        stderr: "",
        error: null,
      };
    },
  });

  assert.equal(report.ok, true);
  assert.equal(report.checks[0].status, "pass");
  assert.match(formatDoctorReport(report), /Result: OK/);
});

test("doctor warns for an in-range uncertified OpenCode version", () => {
  const report = runDoctor({
    runCommand: () => ({
      status: 0,
      stdout: "1.15.7",
      stderr: "",
      error: null,
    }),
  });

  assert.equal(report.ok, true);
  assert.equal(report.checks[0].status, "warn");
});

test("doctor fails when OpenCode cannot be executed", () => {
  const report = runDoctor({
    runCommand: () => ({
      status: null,
      stdout: "",
      stderr: "",
      error: "spawn opencode ENOENT",
    }),
  });

  assert.equal(report.ok, false);
  assert.equal(report.checks[0].status, "fail");
  assert.match(formatDoctorReport(report), /spawn opencode ENOENT/);
});
