import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describeLocalPackage, verifyPackageSource, type LocalPackageSource } from "./package-source.js";

/** Installs once in an artifact-specific directory; failures remain inspectable. */
export function installLocalPackage(artifactPath: string, installationBase: string, offline = false): LocalPackageSource {
  const artifact = realpathSync(artifactPath), bytes = readFileSync(artifact);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const base = resolve(installationBase), target = join(base, sha256);
  const record = join(target, "candidate.json");
  if (existsSync(target)) {
    if (!existsSync(record)) throw new Error(`Incomplete local installation retained at ${target}; use a new installation base after inspecting it`);
    const source = JSON.parse(readFileSync(record, "utf8")) as LocalPackageSource;
    if (source.sha256 !== sha256) throw new Error("Existing candidate identity differs");
    verifyPackageSource(source);
    return source;
  }
  mkdirSync(base, { recursive: true });
  mkdirSync(target);
  const frozen = join(target, "package.tgz");
  copyFileSync(artifact, frozen);
  writeFileSync(join(target, "package.json"), JSON.stringify({ private: true, name: "orchestrator-local-candidate", version: "0.0.0" }) + "\n", { flag: "wx" });
  writeFileSync(join(target, "transaction.json"), JSON.stringify({ state: "installing", sha256, artifact: frozen }) + "\n", { flag: "wx" });
  const result = spawnSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...(offline ? ["--offline"] : []), "--prefix", target, frozen], { encoding: "utf8", timeout: 300000, maxBuffer: 8 * 1024 * 1024 });
  writeFileSync(join(target, "installation.log"), result.stdout + result.stderr);
  if (result.error || result.status !== 0) throw new Error(`Local package installation failed; inspect ${target}/installation.log: ${result.error?.message ?? result.status}`);
  const packageRoot = join(target, "node_modules/@frankzhang2026/opencode-android-orchestrator");
  const source = describeLocalPackage(frozen, packageRoot, target);
  if (source.sha256 !== sha256 || source.name !== "@frankzhang2026/opencode-android-orchestrator") throw new Error("Installed artifact identity differs");
  writeFileSync(`${packageRoot}.source.json`, JSON.stringify(source, null, 2) + "\n", { flag: "wx" });
  verifyPackageSource(source);
  writeFileSync(record, JSON.stringify(source, null, 2) + "\n", { flag: "wx" });
  writeFileSync(join(target, "transaction.json"), JSON.stringify({ state: "installed", sha256, artifact: frozen, lockSha256: createHash("sha256").update(readFileSync(join(target, "package-lock.json"))).digest("hex") }) + "\n");
  return source;
}
