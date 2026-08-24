import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parse } from "jsonc-parser";

import {
  ORCHESTRATOR_PACKAGE_NAME,
  ORCHESTRATOR_PACKAGE_VERSION,
  ORCHESTRATOR_PLUGIN_REFERENCE,
  SUPERPOWERS_PLUGIN_REFERENCE,
  OpenCodeConfigMergeError,
  mergeOpenCodeConfigText,
  planOpenCodeConfigMerge,
  pluginPackageIdentity,
} from "../dist/index.js";

function assertMergeError(code, operation) {
  assert.throws(operation, (error) => {
    assert.ok(error instanceof OpenCodeConfigMergeError);
    assert.equal(error.code, code);
    return true;
  });
}

function withTemporaryDirectory(prefix, operation) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  try {
    return operation(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("merges the fixed plugins without removing existing configuration", () => {
  const source = `${JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      plugin: [
        "opencode-scheduler@1.3.0",
        SUPERPOWERS_PLUGIN_REFERENCE,
      ],
      theme: "system",
    },
    null,
    2,
  )}\n`;

  const result = mergeOpenCodeConfigText(source);
  const config = JSON.parse(result.content);

  assert.equal(result.changed, true);
  assert.deepEqual(result.addedPluginReferences, [
    ORCHESTRATOR_PLUGIN_REFERENCE,
  ]);
  assert.equal(config.$schema, "https://opencode.ai/config.json");
  assert.equal(config.theme, "system");
  assert.deepEqual(config.plugin, [
    "opencode-scheduler@1.3.0",
    SUPERPOWERS_PLUGIN_REFERENCE,
    ORCHESTRATOR_PLUGIN_REFERENCE,
  ]);
});

test("is byte-for-byte idempotent once the required plugins exist", () => {
  const initial = mergeOpenCodeConfigText("{}\n");
  const repeated = mergeOpenCodeConfigText(initial.content);

  assert.equal(repeated.changed, false);
  assert.deepEqual(repeated.addedPluginReferences, []);
  assert.equal(repeated.content, initial.content);
});

test("preserves JSONC comments, trailing commas, order, and plugin options", () => {
  const source = `{
    // Keep this project setting.
    "theme": "system",
    "plugin": [
        ["custom-plugin@2.0.0", { "enabled": true }], // keep options
        "${SUPERPOWERS_PLUGIN_REFERENCE}",
    ],
}
`;

  const result = mergeOpenCodeConfigText(source);
  const config = parse(result.content);

  assert.match(result.content, /\/\/ Keep this project setting\./);
  assert.match(result.content, /\/\/ keep options/);
  assert.match(result.content, /"enabled": true/);
  assert.ok(
    result.content.includes(`"${ORCHESTRATOR_PLUGIN_REFERENCE}",\n    ],`),
  );
  assert.deepEqual(config.plugin, [
    ["custom-plugin@2.0.0", { enabled: true }],
    SUPERPOWERS_PLUGIN_REFERENCE,
    ORCHESTRATOR_PLUGIN_REFERENCE,
  ]);
});

test("treats an exact plugin tuple reference as already installed", () => {
  const source = `${JSON.stringify(
    {
      plugin: [
        [SUPERPOWERS_PLUGIN_REFERENCE, { enabled: true }],
        [ORCHESTRATOR_PLUGIN_REFERENCE, { mode: "safe" }],
      ],
    },
    null,
    2,
  )}\n`;

  const result = mergeOpenCodeConfigText(source);

  assert.equal(result.changed, false);
  assert.equal(result.content, source);
  assert.deepEqual(result.addedPluginReferences, []);
});

test("preserves CRLF, tabs, and the absence of a final newline", () => {
  const source = "{\r\n\t\"theme\": \"system\"\r\n}";
  const result = mergeOpenCodeConfigText(source);

  assert.equal(result.content.endsWith("\n"), false);
  assert.equal(result.content.replaceAll("\r\n", "").includes("\n"), false);
  assert.match(result.content, /\r\n\t"plugin": \[\r\n\t\t"superpowers/);
});

test("rejects a different reference for either managed plugin", () => {
  for (const reference of [
    `${ORCHESTRATOR_PACKAGE_NAME}@0.0.9`,
    "superpowers@6.2.0",
  ]) {
    assertMergeError("PLUGIN_VERSION_CONFLICT", () =>
      mergeOpenCodeConfigText(
        JSON.stringify({ plugin: [reference] }),
      ),
    );
  }
});

test("rejects duplicate plugins by package identity", () => {
  assertMergeError("DUPLICATE_PLUGIN", () =>
    mergeOpenCodeConfigText(
      JSON.stringify({
        plugin: ["custom-plugin@1.0.0", "custom-plugin@2.0.0"],
      }),
    ),
  );
});

test("rejects invalid JSONC structures instead of repairing them", () => {
  assertMergeError("INVALID_JSONC", () =>
    mergeOpenCodeConfigText('{ "plugin": [ }'),
  );
  assertMergeError("ROOT_NOT_OBJECT", () =>
    mergeOpenCodeConfigText("[]"),
  );
  assertMergeError("DUPLICATE_PROPERTY", () =>
    mergeOpenCodeConfigText('{ "theme": "a", "theme": "b" }'),
  );
  assertMergeError("PLUGIN_NOT_ARRAY", () =>
    mergeOpenCodeConfigText('{ "plugin": "custom-plugin@1.0.0" }'),
  );
  assertMergeError("INVALID_PLUGIN_ENTRY", () =>
    mergeOpenCodeConfigText('{ "plugin": [["custom-plugin@1.0.0"]] }'),
  );
});

test("plans a new opencode.json without writing it", () => {
  withTemporaryDirectory("orchestrator-new-config-", (directory) => {
    const plan = planOpenCodeConfigMerge(directory);

    assert.equal(plan.existed, false);
    assert.equal(plan.configFormat, "json");
    assert.equal(plan.configPath, join(directory, "opencode.json"));
    assert.equal(plan.originalContent, "{}\n");
    assert.equal(plan.changed, true);
    assert.equal(existsSync(plan.configPath), false);
  });
});

test("plans an existing opencode.jsonc without modifying it", () => {
  withTemporaryDirectory("orchestrator-jsonc-config-", (directory) => {
    const configPath = join(directory, "opencode.jsonc");
    const source = '{\n  // retained\n  "theme": "system",\n}\n';
    writeFileSync(configPath, source);

    const plan = planOpenCodeConfigMerge(directory);

    assert.equal(plan.existed, true);
    assert.equal(plan.configFormat, "jsonc");
    assert.equal(plan.configPath, configPath);
    assert.equal(plan.originalContent, source);
    assert.equal(readFileSync(configPath, "utf8"), source);
    assert.match(plan.content, /\/\/ retained/);
  });
});

test("refuses ambiguous, symbolic-link, and non-file config paths", () => {
  withTemporaryDirectory("orchestrator-ambiguous-config-", (directory) => {
    writeFileSync(join(directory, "opencode.json"), "{}\n");
    writeFileSync(join(directory, "opencode.jsonc"), "{}\n");
    assertMergeError("AMBIGUOUS_CONFIG", () =>
      planOpenCodeConfigMerge(directory),
    );
  });

  withTemporaryDirectory("orchestrator-symlink-config-", (directory) => {
    const target = join(directory, "target.json");
    writeFileSync(target, "{}\n");
    symlinkSync(target, join(directory, "opencode.json"));
    assertMergeError("CONFIG_SYMLINK", () =>
      planOpenCodeConfigMerge(directory),
    );
  });

  withTemporaryDirectory("orchestrator-directory-config-", (directory) => {
    mkdirSync(join(directory, "opencode.json"));
    assertMergeError("CONFIG_NOT_FILE", () =>
      planOpenCodeConfigMerge(directory),
    );
  });
});

test("keeps package identity parsing and pinned constants aligned", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );

  assert.equal(pluginPackageIdentity("custom-plugin@1.2.3"), "custom-plugin");
  assert.equal(
    pluginPackageIdentity("@scope/custom-plugin@1.2.3"),
    "@scope/custom-plugin",
  );
  assert.equal(ORCHESTRATOR_PACKAGE_NAME, packageJson.name);
  assert.equal(ORCHESTRATOR_PACKAGE_VERSION, packageJson.version);
  assert.equal(
    ORCHESTRATOR_PLUGIN_REFERENCE,
    `${packageJson.name}@${packageJson.version}`,
  );
});
