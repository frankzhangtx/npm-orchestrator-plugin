"use strict";

// One V4/V5 validator is used by both the queue and the installed shell entry.
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string" && value.length > 0 && !/[\u0000\r\n]/.test(value);
const fields = (value, required, optional = []) => object(value) && required.every(key => Object.hasOwn(value, key)) &&
  Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const identity = value => JSON.stringify([value.taskPath, value.className, value.name]);
function matchesPath(pattern, path) {
  const expression = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0001").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")
    .replace(/\u0001\//g, "(?:.*/)?").replace(/\u0001/g, ".*");
  return new RegExp(`^${expression}${pattern.endsWith("/") ? ".*" : ""}$`).test(path);
}
function validateContract(contract, config) {
  assert(fields(contract, ["schemaVersion", "id", "title", "designApproved", "planPath", "ambiguityPolicy",
    "maxFixLoops", "maxChangedFiles", "allowedPaths", "forbiddenPaths", "allowedWorkflowSkills",
    "acceptanceCriteria", "nonGoals", "targetTests", "deviceTestsRequired", "testPolicy", "verification"],
    contract.schemaVersion === 8 ? ["testPolicyReason", "recovery", "execution", "stageRecovery", "continuity"] : contract.schemaVersion === 7 ? ["testPolicyReason", "recovery", "execution", "stageRecovery"] : contract.schemaVersion === 6 ? ["testPolicyReason", "recovery", "execution"] : contract.schemaVersion === 5 ? ["testPolicyReason", "recovery"] : ["testPolicyReason"]), "Invalid inventory contract fields");
  assert([4, 5, 6, 7, 8].includes(contract.schemaVersion) && /^TASK-[A-Z0-9-]+$/.test(contract.id), "Invalid inventory contract identity");
  if (contract.schemaVersion >= 5) require("./recovery.cjs").validateRecoveryPolicy(contract.recovery);
  if (contract.schemaVersion >= 6) require("./recovery.cjs").validateExecutionPolicy(contract.execution);
  if (contract.schemaVersion >= 7) require("./recovery.cjs").validateStageRecoveryPolicy(contract.stageRecovery);
  if (contract.schemaVersion === 8) {
    const policy = contract.continuity;
    assert(fields(policy, ["version", "isolatedAutoIntegration", "planningRefresh", "planningInputs"]) && policy.version === 1 &&
      typeof policy.isolatedAutoIntegration === "boolean" && ["reject", "completedQueueTasks"].includes(policy.planningRefresh), "Invalid continuity policy");
    assert(Array.isArray(policy.planningInputs) && policy.planningInputs.length > 0 && policy.planningInputs.length <= 128 &&
      new Set(policy.planningInputs).size === policy.planningInputs.length && policy.planningInputs.every(p =>
        typeof p === "string" && p.length <= 512 && /^[A-Za-z0-9._/?*-]+$/.test(p) &&
        !p.startsWith("/") && !p.includes("..") && p.split("/").every(part => part && part !== "." && part !== ".git")), "Invalid planning inputs");
  }
  assert(text(contract.title) && contract.designApproved === true && contract.ambiguityPolicy === "BLOCKED", "An approved bounded design is required");
  assert(contract.planPath === `docs/plans/${contract.id}.md`, "Invalid task plan path");
  assert(Number.isInteger(contract.maxFixLoops) && contract.maxFixLoops >= 0 && contract.maxFixLoops <= 1, "Invalid fix-loop limit");
  assert(Number.isInteger(contract.maxChangedFiles) && contract.maxChangedFiles >= 1 && contract.maxChangedFiles <= 12, "Invalid file limit");
  for (const key of ["allowedPaths", "forbiddenPaths", "acceptanceCriteria", "nonGoals"])
    assert(Array.isArray(contract[key]) && contract[key].length > 0 && contract[key].every(text), `Invalid ${key}`);
  for (const path of [...contract.allowedPaths, ...contract.forbiddenPaths])
    assert(/^[A-Za-z0-9._/?*-]+$/.test(path) && !path.startsWith("/") && !path.includes(".."), "Unsafe contract path");
  for (const path of config.protectedPaths) {
    assert(!contract.allowedPaths.some(pattern => matchesPath(pattern, path)), `Allowed paths overlap protected path: ${path}`);
    assert(contract.forbiddenPaths.some(pattern => matchesPath(pattern, path)), `Forbidden paths must cover: ${path}`);
  }
  assert(JSON.stringify(contract.allowedWorkflowSkills) === JSON.stringify(["test-driven-development", "systematic-debugging", "verification-before-completion"].map(name => `android-orchestrator-${name}`)), "Invalid workflow skill allowlist");
  assert(typeof contract.deviceTestsRequired === "boolean" && contract.testPolicy === "required", "Inventory verification requires tests");
  assert(!contract.deviceTestsRequired || config.gradleVerification.deviceTestTasks?.length > 0,
    "Device tests are required by this contract but no device test tasks are available");
  assert(config.unitTestsEnabled !== false, "Inventory verification requires unitTestsEnabled=true");
  assert(!Object.hasOwn(contract, "testPolicyReason") || typeof contract.testPolicyReason === "string", "Invalid test policy reason");
  assert(Array.isArray(contract.targetTests) && contract.targetTests.length > 0, "Focused tests are required");
  const targets = new Set();
  for (const target of contract.targetTests) {
    assert(fields(target, ["gradleTask", "filter"]) && /^(?::[A-Za-z0-9_.-]+)+$/.test(target.gradleTask), "Inventory verification requires a fully qualified Test task path");
    assert(config.gradleVerification.focusedTestTasks.includes(target.gradleTask), "Focused test task is not configured");
    assert(typeof target.filter === "string" && /^[A-Za-z0-9_.#$*-]+$/.test(target.filter), "Unsafe test filter");
    const key = JSON.stringify([target.gradleTask, target.filter]);
    assert(!targets.has(key), "Focused test targets must be unique"); targets.add(key);
  }
  const verification = contract.verification;
  assert(fields(verification, ["version", "maxPreparationFixes", "cases", "inventory"]) && verification.version === 2, "Inventory verification requires verification version 2 with explicit inventory policy");
  assert(Number.isInteger(verification.maxPreparationFixes) && verification.maxPreparationFixes >= 0 && verification.maxPreparationFixes <= 1, "Invalid preparation retry budget");
  const policy = verification.inventory;
  assert(fields(policy, ["mode", "existingSkips", "emptyBaseline"]) && policy.mode === "focusedBaseline" &&
    ["reject", "preserve"].includes(policy.existingSkips) && ["reject", "allow"].includes(policy.emptyBaseline), "Invalid inventory coverage, existing-skip or empty-baseline policy");
  assert(Array.isArray(verification.cases) && verification.cases.length > 0, "Behavior cases are required");
  const ids = new Set(), identities = new Set();
  for (const item of verification.cases) {
    assert(fields(item, ["id", "criterion", "intent", "before", "after", "source", "test"], ["expectedFailure"]), "Invalid behavior case fields");
    assert(typeof item.id === "string" && /^[A-Z][A-Z0-9-]{2,63}$/.test(item.id) && !ids.has(item.id), "Behavior IDs must be unique and stable"); ids.add(item.id);
    assert(Number.isInteger(item.criterion) && item.criterion >= 1 && item.criterion <= contract.acceptanceCriteria.length && item.after === "pass", "Invalid behavior criterion or GREEN expectation");
    assert(fields(item.test, ["target", "className", "name"]) && Number.isInteger(item.test.target) && item.test.target >= 0 &&
      item.test.target < contract.targetTests.length && text(item.test.className) && text(item.test.name), "Invalid exact test identity (include each parameter instance)");
    const key = identity({ taskPath: contract.targetTests[item.test.target].gradleTask, ...item.test });
    assert(!identities.has(key), "Behavior identities overlap across target filters"); identities.add(key);
    if (item.intent === "preserve") assert(item.before === "pass" && ["existingTest", "baselineCapture", "measuredFact"].includes(item.source) && !Object.hasOwn(item, "expectedFailure"), "Preserved behavior must pass on a measured baseline");
    else if (item.intent === "change") assert(item.before === "fail" && item.source === "userRequirement" && object(item.expectedFailure), "Changed behavior requires an approved expected failure");
    else assert(item.intent === "observe" && item.before === "observe" && ["userRequirement", "existingTest", "baselineCapture", "measuredFact"].includes(item.source), "Invalid observed behavior");
    if (Object.hasOwn(item, "expectedFailure")) {
      const failure = item.expectedFailure;
      assert(fields(failure, ["type", "origin"], ["messageIncludes"]) && text(failure.type) && text(failure.origin) && failure.origin.length >= 12 &&
        (!Object.hasOwn(failure, "messageIncludes") || (text(failure.messageIncludes) && failure.messageIncludes.length >= 3)), "Invalid expected failure");
    }
  }
  assert(verification.cases.some(item => item.intent === "change"), "At least one changed behavior must provide genuine RED");
  assert(!/replace with|TASK-EXAMPLE|\btodo\b|\btbd\b|placeholder/i.test(JSON.stringify(contract)), "Contract contains placeholders");
}
module.exports = { validateContract, identity, matchesPath, assert };
if (require.main === module) {
  try { const fs = require("node:fs"); validateContract(JSON.parse(fs.readFileSync(process.argv[2], "utf8")), JSON.parse(fs.readFileSync(process.argv[3], "utf8"))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
