import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

function read(relativePath) {
  return readFileSync(join(repositoryRoot, relativePath), "utf8");
}

test("ships complete MIT license and third-party notices", () => {
  const packageJson = JSON.parse(read("package.json"));
  const packageLock = JSON.parse(read("package-lock.json"));
  const license = read("LICENSE");
  const notices = read("THIRD_PARTY_NOTICES.md");

  assert.equal(packageJson.license, "MIT");
  assert.equal(packageJson.author, "frankzhang2026");
  assert.deepEqual(packageJson.repository, {
    type: "git",
    url: "git+https://github.com/frankzhangtx/npm-orchestrator-plugin.git",
  });
  assert.equal(
    packageJson.homepage,
    "https://github.com/frankzhangtx/npm-orchestrator-plugin#readme",
  );
  assert.deepEqual(packageJson.bugs, {
    url: "https://github.com/frankzhangtx/npm-orchestrator-plugin/issues",
  });
  assert.ok(packageJson.files.includes("LICENSE"));
  assert.ok(packageJson.files.includes("THIRD_PARTY_NOTICES.md"));
  assert.deepEqual(packageJson.dependencies, { "jsonc-parser": "3.3.1" });
  assert.deepEqual(packageJson.peerDependencies, {
    "@opencode-ai/plugin": ">=1.14.22 <1.16.0",
  });
  assert.equal(
    packageLock.packages["node_modules/jsonc-parser"].version,
    "3.3.1",
  );
  assert.equal(
    packageLock.packages["node_modules/jsonc-parser"].license,
    "MIT",
  );
  assert.equal(
    packageLock.packages["node_modules/@opencode-ai/plugin"].license,
    "MIT",
  );
  assert.equal(
    packageLock.packages["node_modules/typescript"].license,
    "Apache-2.0",
  );
  assert.equal(
    packageLock.packages["node_modules/@types/node"].license,
    "MIT",
  );

  assert.match(license, /^MIT License/);
  assert.match(license, /Copyright \(c\) 2026 frankzhang2026/);
  assert.match(license, /Permission is hereby granted, free of charge/);

  assert.match(notices, /jsonc-parser 3\.3\.1/);
  assert.match(notices, /Copyright \(c\) Microsoft/);
  assert.match(notices, /@opencode-ai\/plugin/);
  assert.match(notices, />=1\.14\.22 <1\.16\.0/);
  assert.match(notices, /Superpowers v6\.2\.0/);
  assert.match(notices, /Copyright \(c\) 2025 Jesse Vincent/);
  assert.match(notices, /TypeScript `5\.8\.2` \(Apache-2\.0\)/);
  assert.match(notices, /`@types\/node` `22\.13\.9` \(MIT\)/);
  assert.match(notices, /not bundled into this package tarball/i);
});

test("keeps release authorization fail-closed and outside the package files", () => {
  const packageJson = JSON.parse(read("package.json"));
  const authorization = read("release/0.2.0-authorization.md");
  const releaseNotes = read("release/0.2.0-release-notes.md");

  assert.doesNotMatch(packageJson.files.join("\n"), /release\//);
  assert.match(authorization, /Status: NOT AUTHORIZED/);
  assert.match(authorization, /npm whoami.*E401 Unauthorized/s);
  assert.match(authorization, /npm publish <approved-0\.2\.0-tarball\.tgz>/);
  assert.match(authorization, /does not authorize any of\s+them/);
  assert.match(
    authorization,
    /3c80aa6b72ccd14bfd15d0ecf4de13e92f8661c356d1659b3737e2b37b8a8d94/,
  );
  assert.doesNotMatch(authorization, /PENDING REBUILD AFTER LICENSE CHANGES/);
  assert.match(releaseNotes, /Status: draft/);
  assert.match(releaseNotes, /real-model three-question task closure/i);
});
