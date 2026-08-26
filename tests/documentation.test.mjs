import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const documents = [
  "docs/MIGRATION.md",
  "docs/SECURITY.md",
  "docs/TROUBLESHOOTING.md",
];

function read(relativePath) {
  return readFileSync(join(repositoryRoot, relativePath), "utf8");
}

test("packages and links the complete user-documentation inventory", () => {
  const packageJson = JSON.parse(read("package.json"));
  const readme = read("README.md");

  assert.ok(packageJson.files.includes("docs/"));
  assert.deepEqual(
    readdirSync(join(repositoryRoot, "docs")).sort(),
    documents.map((path) => path.slice("docs/".length)).sort(),
  );
  for (const path of documents) {
    const stats = statSync(join(repositoryRoot, path));
    assert.equal(stats.isFile(), true, path);
    assert.equal(stats.mode & 0o111, 0, path);
    assert.match(read(path), /^# /, path);
    assert.match(readme, new RegExp(`\\(${path.replace(".", "\\.")}\\)`));
  }
});

test("keeps every repository-local documentation link resolvable", () => {
  for (const sourcePath of ["README.md", ...documents]) {
    const source = read(sourcePath);
    const links = source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g);
    for (const match of links) {
      const target = match[1];
      assert.ok(target, `${sourcePath}: empty link`);
      if (
        target.startsWith("https://") ||
        target.startsWith("http://") ||
        target.startsWith("#") ||
        target.startsWith("mailto:")
      ) {
        continue;
      }
      const withoutFragment = target.split("#", 1)[0];
      assert.ok(withoutFragment, `${sourcePath}: empty relative target`);
      const absoluteTarget = resolve(
        repositoryRoot,
        dirname(sourcePath),
        withoutFragment,
      );
      assert.equal(
        statSync(absoluteTarget).isFile(),
        true,
        `${sourcePath}: ${target}`,
      );
    }
  }
});

test("documents fixed-version migration, recovery, and security boundaries portably", () => {
  const migration = read("docs/MIGRATION.md");
  const troubleshooting = read("docs/TROUBLESHOOTING.md");
  const security = read("docs/SECURITY.md");
  const allDocumentation = [
    read("README.md"),
    migration,
    troubleshooting,
    security,
  ].join("\n");

  assert.match(migration, /`0\.1\.0` scaffold/);
  assert.match(migration, /manually copied V3 setup/);
  assert.match(migration, /manifest-managed version/);
  assert.match(migration, /Never delete .*upgrade\.json/s);
  assert.match(troubleshooting, /\| `2` \| Unknown command or invalid CLI arguments/);
  assert.match(troubleshooting, /UNTRUSTED_INSTALLATION/);
  assert.match(troubleshooting, /do not run `git reset --hard`/);
  assert.match(security, /It is not a privilege boundary/);
  assert.match(security, /never pushes/i);
  assert.match(security, /NO-GO/);
  assert.match(security, /Real dual-version end-to-end acceptance/);
  assert.doesNotMatch(allDocumentation, /\/Users\/|zhanglong|cctest/i);
  assert.doesNotMatch(allDocumentation, /@latest/);
});
