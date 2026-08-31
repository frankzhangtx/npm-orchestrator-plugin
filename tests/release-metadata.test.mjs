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

  assert.equal(packageJson.version, "0.5.0");
  assert.equal(packageLock.version, "0.5.0");
  assert.equal(packageLock.packages[""].version, "0.5.0");
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

test("keeps the published release outcome auditable and outside package files", () => {
  const packageJson = JSON.parse(read("package.json"));
  const authorization = read("release/0.2.0-authorization.md");
  const releaseNotes = read("release/0.2.0-release-notes.md");

  assert.doesNotMatch(packageJson.files.join("\n"), /release\//);
  assert.doesNotMatch(packageJson.files.join("\n"), /tests\//);
  assert.match(authorization, /Status: PUBLISHED/);
  assert.match(
    authorization,
    /npm whoami[\s\S]*returned\s+`frankzhang2026`/,
  );
  assert.match(
    authorization,
    /contains `0\.1\.0` and `0\.2\.0`[\s\S]*`latest` pointing to `0\.2\.0`/i,
  );
  assert.match(authorization, /Human tarball review \| PASS/);
  assert.match(
    authorization,
    /- \[x\] The npm CLI browser authentication method/,
  );
  assert.match(
    authorization,
    /- \[x\] The user issued a new, explicit authorization/,
  );
  assert.match(authorization, /npm publish <sha256-9c1b326b\.\.\.916bdc-0\.2\.0-tarball\.tgz>/);
  assert.match(authorization, /No Git tag or GitHub release was created/);
  assert.match(
    authorization,
    /9c1b326bc2ecf9f28d1a4a9d723ee1b44acdb912f101f17b21dc07449c916bdc/,
  );
  assert.doesNotMatch(authorization, /PENDING REBUILD AFTER LICENSE CHANGES/);
  assert.match(releaseNotes, /Status: published/);
  assert.match(releaseNotes, /fixed Registry artifact is byte-identical/i);
  assert.match(releaseNotes, /real-model three-question task closure/i);
});

test("records the verified 0.3.0 Registry publication", () => {
  const packageJson = JSON.parse(read("package.json"));
  const authorization = read("release/0.3.0-authorization.md");
  const releaseNotes = read("release/0.3.0-release-notes.md");

  assert.doesNotMatch(packageJson.files.join("\n"), /release\//);
  assert.doesNotMatch(packageJson.files.join("\n"), /tests\//);
  assert.match(authorization, /Status: PUBLISHED/);
  assert.match(authorization, /explicitly instructed publication[\s\S]*`0\.3\.0`/i);
  assert.match(
    authorization,
    /npm whoami[\s\S]*returned\s+`frankzhang2026`/,
  );
  assert.match(
    authorization,
    /contains\s+`0\.1\.0`, `0\.2\.0`, and `0\.3\.0`[\s\S]*`latest` pointing to `0\.3\.0`/i,
  );
  assert.match(
    authorization,
    /4a54255edd486266fd1b7f98a68b7ee03375e203/,
  );
  assert.match(
    authorization,
    /d09d7bd38915cc555fca5d77ca0accb571616788edeee87f42e1cee7da742cfe/,
  );
  assert.match(
    authorization,
    /84b55b436a9ae99d3dde69b9d82d25b59b42d541/,
  );
  assert.match(
    authorization,
    /sha512-whkfJQN7ynvWYg5olieGm\+lHoj\/wkiKl13bRQqbohVFO\/OE8rvaIljDxn2u3xPRc7ZiJ19tIYC\+hrOJ7zeHkVw==/,
  );
  assert.match(authorization, /first browser-auth publish attempt was cancelled/i);
  assert.match(authorization, /successful retry used Safari/i);
  assert.match(authorization, /fixed-version Registry download was byte-identical/i);
  assert.match(authorization, /No Git tag or GitHub release was created/);
  assert.doesNotMatch(
    authorization,
    /https:\/\/www\.npmjs\.com\/auth\/cli\/|one-time password:|npm token:/i,
  );

  assert.match(releaseNotes, /Status: published/);
  assert.match(releaseNotes, /Registry download is byte-identical/i);
  assert.match(releaseNotes, /default module scope was `all`/i);
  assert.match(releaseNotes, /No Git tag or GitHub release was created/);
});

test("records the verified 0.4.0 Registry publication", () => {
  const packageJson = JSON.parse(read("package.json"));
  const authorization = read("release/0.4.0-authorization.md");
  const releaseNotes = read("release/0.4.0-release-notes.md");

  assert.doesNotMatch(packageJson.files.join("\n"), /release\//);
  assert.doesNotMatch(packageJson.files.join("\n"), /tests\//);
  assert.match(authorization, /Status: PUBLISHED/);
  assert.match(authorization, /explicitly instructed publication[\s\S]*`0\.4\.0`/i);
  assert.match(
    authorization,
    /npm whoami[\s\S]*returned\s+`frankzhang2026`/,
  );
  assert.match(
    authorization,
    /contains `0\.1\.0`,[\s\S]*`0\.4\.0`[\s\S]*`latest` pointing to `0\.4\.0`/i,
  );
  assert.match(
    authorization,
    /ae22486d62cdfb5a8aa6a9fcafe41087546124a7/,
  );
  assert.match(
    authorization,
    /dcb50806f173ceab97d1ac393363724ded56f37e4e54f754cdf04a96bb10a299/,
  );
  assert.match(
    authorization,
    /1ee666a298126e52d3e022a11723f57c0781e73a/,
  );
  assert.match(
    authorization,
    /sha512-R4fHYMkVdMxKmaNQk4KNqRDYEbyK\/GOpzDHrbM21w1leqjEJ\+VmfLs26klmXd95VnY7TiFP\/NDLtz0x\/z7qp5w==/,
  );
  assert.match(authorization, /fixed-version Registry download was[\s\S]*byte-identical/i);
  assert.match(authorization, /No Git tag or GitHub release was created/);
  assert.doesNotMatch(
    authorization,
    /https:\/\/www\.npmjs\.com\/(?:auth|login)\/|one-time password:|npm token:/i,
  );

  assert.match(releaseNotes, /Status: published/);
  assert.match(releaseNotes, /Registry download is byte-identical/i);
  assert.match(releaseNotes, /\.automation-worktree-allowlist/);
  assert.match(releaseNotes, /No Git tag or GitHub release was created/);
});

test("records the verified 0.5.0 Registry publication", () => {
  const packageJson = JSON.parse(read("package.json"));
  const authorization = read("release/0.5.0-authorization.md");
  const releaseNotes = read("release/0.5.0-release-notes.md");

  assert.doesNotMatch(packageJson.files.join("\n"), /release\//);
  assert.doesNotMatch(packageJson.files.join("\n"), /tests\//);
  assert.match(authorization, /Status: PUBLISHED/);
  assert.match(
    authorization,
    /explicitly instructed continuation[\s\S]*`0\.5\.0`/i,
  );
  assert.match(
    authorization,
    /npm whoami[\s\S]*returned\s+`frankzhang2026`/,
  );
  assert.match(
    authorization,
    /contains `0\.1\.0`,[\s\S]*`0\.5\.0`[\s\S]*`latest`[\s\S]*`0\.5\.0`/i,
  );
  assert.match(
    authorization,
    /2160328670162beafec617145b2ba6279673e215/,
  );
  assert.match(
    authorization,
    /6a755b5cb5ae9f3444269aae586a233cf538b5fa8b5d63eab5d7f279b2ed09f1/,
  );
  assert.match(
    authorization,
    /5f63d3a63eb613bda20405414422d67c8f6f38b4/,
  );
  assert.match(
    authorization,
    /sha512-QWW\+f881CoK7e35A6dGyy3njxLvUszeY6HesJvTZyEik4zBVD2OHoERGJXDXBiimh34PoIdJ7qrUmJG0lFE3Hw==/,
  );
  assert.match(
    authorization,
    /fixed-version\s+Registry download was[\s\S]*byte-identical/i,
  );
  assert.match(authorization, /No Git tag or GitHub release was created/);
  assert.doesNotMatch(
    authorization,
    /https:\/\/www\.npmjs\.com\/(?:auth|login)\/|one-time password:|npm token:/i,
  );

  assert.match(releaseNotes, /Status: published/);
  assert.match(releaseNotes, /registered Android debug verification tasks/i);
  assert.match(releaseNotes, /\.automation-worktree-allowlist/);
  assert.match(releaseNotes, /134 Node tests/);
  assert.match(releaseNotes, /42-case Shell lifecycle\s+suite/);
  assert.match(releaseNotes, /Registry download is byte-identical/i);
  assert.match(releaseNotes, /No Git tag or GitHub release was created/);
});
