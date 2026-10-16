"use strict";

// Presentation only. Execution gates must continue to read the original files.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const MAX_BYTES = 16 * 1024;
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const files = {
  baseline: "baseline.json", red: "red.json", testPreflight: "test-preflight.json",
  testManifest: "test-manifest.json", testSupplement: "test-supplement.json",
  baselineInventory: "baseline-inventory.json", greenInventory: "green-inventory.json",
  inventoryStatus: "inventory-status.json", baselineRecovery: "baseline-recovery.json",
  ready: "ready.json", review: "review.json", modelContinuation: "model-continuation.json",
  redRecovery: "stage-recovery/red.json", greenRecovery: "stage-recovery/green.json",
  reviewRecovery: "stage-recovery/review.json",
};
function preview(value, depth = 3) {
  if (typeof value === "string") return value.length > 320 ? value.slice(0, 320) + "…" : value;
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return { count: value.length, preview: value.slice(0, 3).map(v => depth ? preview(v, depth - 1) : null), truncated: value.length > 3 };
  if (!depth) return { fields: Object.keys(value).length };
  return Object.fromEntries(Object.entries(value).slice(0, 24).map(([k, v]) => [k.slice(0, 100), preview(v, depth - 1)]));
}
function resources(root, runtime, task) {
  const evidence = path.join(runtime, "evidence", task);
  const paths = {
    contract: path.join(root, "automation/tasks", task + ".json"),
    state: path.join(runtime, "state", task + ".json"),
    workspace: path.join(runtime, "workspaces", task + ".json"),
    origin: path.join(evidence, "origin.json"),
    ...Object.fromEntries(Object.entries(files).map(([k, v]) => [k, path.join(evidence, v)])),
  };
  const result = {};
  for (const [name, file] of Object.entries(paths)) {
    if (!fs.existsSync(file)) continue;
    const bytes = fs.readFileSync(file), value = JSON.parse(bytes.toString("utf8"));
    result[name] = { file, bytes, value, sha256: digest(bytes) };
  }
  if (!result.contract) throw new Error("Task contract is missing");
  const cycle = result.ready?.value?.codingCycle;
  if (Number.isSafeInteger(cycle) && cycle >= 0) {
    const file = path.join(evidence, `gate-attempts-cycle-${cycle}.json`);
    if (fs.existsSync(file)) {
      const bytes = fs.readFileSync(file);
      result.latestGate = { file, bytes, value: JSON.parse(bytes), sha256: digest(bytes) };
    }
  }
  return result;
}
function page(resources, name, sha, offsetText = "0") {
  if (!Object.hasOwn(resources, name)) throw new Error("Unknown evidence resource");
  const r = resources[name];
  if (!/^[a-f0-9]{64}$/.test(sha || "") || sha !== r.sha256) throw new Error("Evidence digest changed or missing; refresh status");
  const offset = Number(offsetText);
  if (!/^\d+$/.test(offsetText) || !Number.isSafeInteger(offset) || offset < 0 || offset > r.bytes.length) throw new Error("Invalid evidence offset");
  // Base64 pages preserve exact bytes, including UTF-8 split across boundaries.
  const end = Math.min(offset + 4096, r.bytes.length);
  return { format: "evidence-page-v1", name, sha256: sha, bytes: r.bytes.length, offset,
    encoding: "base64", content: r.bytes.subarray(offset, end).toString("base64"), nextOffset: end < r.bytes.length ? end : null };
}
function summary(root, runtime, task, live) {
  const all = resources(root, runtime, task);
  const value = name => all[name] ? preview(all[name].value) : null;
  const evidence = Object.fromEntries(Object.keys(files).map(name => [name, value(name)]));
  evidence.latestGate = value("latestGate");
  evidence.stageRecovery = { red: value("redRecovery"), green: value("greenRecovery"), review: value("reviewRecovery") };
  evidence.currentDiffSha256 = live.currentDiffSha256 || null;
  evidence.sealedDiffMatches = all.ready && live.currentDiffSha256 ? all.ready.value.diffSha256 === live.currentDiffSha256 : null;
  const queueFile = path.join(runtime, "inbox/queue.json");
  if (fs.existsSync(queueFile)) {
    const q = JSON.parse(fs.readFileSync(queueFile, "utf8"));
    const key = q.items?.filter(i => i.taskId === task).at(-1)?.key;
    const run = [...(q.runs || []), q.active].filter(r => r && key && r.key === key).at(-1);
    const s = run?.supervision;
    evidence.workerSupervision = s ? Object.fromEntries(["state", "stage", "deadline", "stageDeadline", "stopReason", "termAt", "killAt"].map(k => [k, s[k]])) : null;
  }
  const result = { format: "status-summary-v1", summaryOnly: true,
    contract: { id: task, title: preview(all.contract.value.title), schemaVersion: all.contract.value.schemaVersion },
    state: value("state"), workspace: value("workspace"), origin: value("origin"), runtime: live.runtime,
    evidenceDirectory: path.join(runtime, "evidence", task), evidence,
    evidenceIndex: Object.fromEntries(Object.entries(all).map(([name, r]) => [name, { bytes: r.bytes.length, sha256: r.sha256 }])),
    evidenceRead: `./scripts/automation/status.sh ${task} --evidence NAME SHA256 OFFSET (base64 bytes; follow nextOffset). Summaries are incomplete; gates use original evidence.` };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) {
    for (const name of Object.keys(evidence)) {
      if (all[name]) evidence[name] = { summaryOmitted: true, resource: name };
    }
    evidence.stageRecovery = { summaryOmitted: true };
    result.workspace = { summaryOmitted: true, resource: "workspace" };
    result.origin = { summaryOmitted: true, resource: "origin" };
  }
  return result;
}
function output(value) {
  const text = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("Status identity exceeds 16 KiB; no partial JSON returned");
  process.stdout.write(text);
}
if (require.main === module) {
  try {
    const [root, runtime, task, mode, ...args] = process.argv.slice(2);
    if (!/^TASK-[A-Z0-9-]+$/.test(task || "")) throw new Error("Invalid task ID");
    if (mode === "--evidence") {
      if (args.length < 2 || args.length > 3) throw new Error("Expected evidence name, SHA256 and optional byte offset");
      output(page(resources(root, runtime, task), ...args));
    } else {
      if (mode) throw new Error("Unknown status option");
      output(summary(root, runtime, task, JSON.parse(fs.readFileSync(0, "utf8"))));
    }
  } catch (error) { process.stderr.write(error.message + "\n"); process.exitCode = 1; }
}
module.exports = { MAX_BYTES, preview, resources, page, summary };
