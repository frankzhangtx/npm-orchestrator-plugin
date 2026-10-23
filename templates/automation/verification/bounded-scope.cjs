"use strict";

// V3 approves exact commands. Capability discovery validates that envelope;
// neither source impact nor acceptance evidence may append commands to it.
const fail = message => { throw new Error(`Invalid bounded verification scope: ${message}`); };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const fields = (value, required, optional = []) => object(value) && required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const taskPath = value => typeof value === "string" && /^(?::[A-Za-z0-9_.-]+)+$/.test(value);
const exactFilter = value => typeof value === "string" && /^[A-Za-z0-9_.#$-]+$/.test(value);
const taskGroups = { assembleTasks: "assemble", lintTasks: "lint", deviceTestTasks: "device" };
const base = path => path.endsWith("/**") ? path.slice(0, -3) : path;
const under = (parent, child) => parent === "." || child === parent || child.startsWith(`${parent}/`);
const overlap = (a, b) => a === b || a.endsWith("/**") && under(base(a), base(b)) || b.endsWith("/**") && under(base(b), base(a));
function validateTargets(targets, label, allowEmpty = true) {
    if (!Array.isArray(targets) || (!allowEmpty && !targets.length) || targets.length > 128 ||
        targets.some(target => !fields(target, ["gradleTask", "filter"]) || !taskPath(target.gradleTask) || !exactFilter(target.filter)))
        fail(`${label} require exact test class or method filters and fully qualified task paths; wildcards are not allowed`);
    if (new Set(targets.map(target => JSON.stringify([target.gradleTask, target.filter]))).size !== targets.length)
        fail(`${label} contain duplicate targets`);
}
function validateBoundedScope(scope) {
    const baseline = scope?.baseline === undefined ? "snapshot" : scope.baseline;
    const buildMode = scope?.buildMode === undefined ? "incremental" : scope.buildMode;
    if (!fields(scope, ["version", "mode", "maxManualRetries", "regressionTests", "tasks"], ["baseline", "buildMode"]) ||
        scope.version !== 3 || scope.mode !== "bounded" || !Number.isInteger(scope.maxManualRetries) ||
        scope.maxManualRetries < 0 || scope.maxManualRetries > 3 ||
        !["snapshot", "execute"].includes(baseline) ||
        !["incremental", "clean"].includes(buildMode)) fail("invalid policy fields");
    validateTargets(scope.regressionTests, "regressionTests");
    if (!fields(scope.tasks, Object.keys(taskGroups))) fail("all explicit task groups are required");
    for (const [group, tasks] of Object.entries(scope.tasks)) {
        if (!Array.isArray(tasks) || tasks.length > 128 || tasks.some(task => !taskPath(task)) || new Set(tasks).size !== tasks.length)
            fail(`invalid or duplicate ${group}`);
    }
    return { ...scope, baseline, buildMode };
}
function selectBoundedVerification(config, contract, changedPaths, baseline, helpers) {
    const scope = validateBoundedScope(contract.verification.scope);
    validateTargets(contract.targetTests, "targetTests", false);
    const { matchesPath } = require("./contract.cjs");
    const { concreteBuilds, sourceMatchesVariant } = helpers;
    const model = config.androidProject.capabilities;
    const selected = new Map(), selectedVariants = {}, reasons = [];
    const explicit = [];
    const resolveTask = (taskPath, kind, group) => {
        const matches = model.modules.flatMap(module => module.tasks.filter(task => task.path === taskPath && task.kind === kind).map(task => ({ module, task })));
        if (matches.length !== 1 || !config.gradleVerification[group].includes(taskPath)) fail(`task is not a configured ${kind} capability: ${taskPath}`);
        const entry = matches[0], { module, task } = entry;
        const builds = concreteBuilds(module);
        if (module.type === "jvm-library" ? task.variant !== null : task.variant === null || !builds.some(build => build.variant === task.variant))
            fail(`task must select a concrete variant: ${taskPath}`);
        if (kind === "assemble" && !builds.some(build => build.path === taskPath)) fail(`aggregate build task is not allowed: ${taskPath}`);
        if (!explicit.some(item => item.task.path === taskPath)) explicit.push(entry);
        return entry;
    };
    for (const target of [...contract.targetTests, ...scope.regressionTests]) resolveTask(target.gradleTask, "unit", "focusedTestTasks");
    for (const [group, kind] of Object.entries(taskGroups)) for (const task of scope.tasks[group]) resolveTask(task, kind, group);
    if (scope.tasks.lintTasks.length && !config.lintEnabled) fail("lint tasks require lintEnabled=true");
    if (scope.tasks.deviceTestTasks.length && !contract.deviceTestsRequired) fail("device tasks require deviceTestsRequired=true");
    if (contract.deviceTestsRequired && !scope.tasks.deviceTestTasks.length) fail("deviceTestsRequired needs explicit device tasks");

    const taskForSource = (entry, source) => entry.module.type === "jvm-library" || sourceMatchesVariant(source, entry.task.variant);
    // Validate the whole approved source envelope, including at runtime. A small
    // current diff cannot excuse an unverified source set in the sealed contract.
    const envelope = [...new Set(contract.allowedPaths)].sort();
    for (const file of envelope) {
        if (file === contract.planPath || file === `automation/tasks/${contract.id}.json`) continue;
        const matches = model.modules.flatMap(module => module.sources.filter(source => source.paths.some(pattern =>
            overlap(pattern, file) || matchesPath(file, base(pattern)))).map(source => ({ module, source })));
        if (!matches.length) fail(`cannot map approved path to a source set: ${file}`);
        for (const { module, source } of matches) {
            if (module.type === "jvm-library" && !["main", "test", "testFixtures"].includes(source.name))
                fail(`cannot establish task coverage for custom JVM source set ${module.gradlePath}:${source.name}; capability discovery must map it explicitly before approval`);
            const available = explicit.filter(entry => entry.module.gradlePath === module.gradlePath && taskForSource(entry, source));
            const deviceSource = source.name.startsWith("androidTest");
            const covering = available.filter(entry => deviceSource ? entry.task.kind === "device" :
                source.kind === "test" && source.name !== "testFixtures" ? entry.task.kind === "unit" :
                    ["unit", "assemble", "device"].includes(entry.task.kind));
            if (!covering.length) fail(`source set ${module.gradlePath}:${source.name} is not covered by explicit tasks; revise the approved scope`);
            if (deviceSource && !contract.deviceTestsRequired) fail(`device source requires approved device tests: ${file}`);
            if (module.type !== "jvm-library") {
                const variants = new Set(covering.map(entry => entry.task.variant));
                for (const variant of variants) {
                    if (config.lintEnabled && !available.some(entry => entry.task.kind === "lint" && entry.task.variant === variant))
                        fail(`enabled lint requires an explicit ${module.gradlePath}:${variant} lint task`);
                    if (contract.deviceTestsRequired && !available.some(entry => entry.task.kind === "device" && entry.task.variant === variant))
                        fail(`required device verification needs an explicit ${module.gradlePath}:${variant} device task`);
                }
            }
        }
    }
    const paths = [...new Set(baseline ? envelope : changedPaths)].sort();
    for (const file of paths) {
        if (file === contract.planPath || file === `automation/tasks/${contract.id}.json`) continue;
        if (!baseline && !contract.allowedPaths.some(pattern => matchesPath(pattern, file))) fail(`changed path outside approved scope: ${file}`);
        const matches = model.modules.flatMap(module => module.sources.filter(source => source.paths.some(pattern =>
            baseline ? overlap(pattern, file) || matchesPath(file, base(pattern)) : matchesPath(pattern, file))).map(source => ({ module, source })));
        if (!matches.length) fail(`cannot map changed path to a source set: ${file}`);
        for (const { module, source } of matches) {
            if (!selected.has(module.gradlePath)) selected.set(module.gradlePath, new Set());
            selected.get(module.gradlePath).add(source.name);
            reasons.push({ path: file, module: module.gradlePath, sourceSet: source.name, kind: source.kind });
        }
    }
    for (const { module, task } of explicit) {
        selectedVariants[module.gradlePath] ??= [];
        if (!selectedVariants[module.gradlePath].includes(task.variant)) selectedVariants[module.gradlePath].push(task.variant);
    }
    for (const values of Object.values(selectedVariants)) values.sort();
    // Informational dependencies of the explicitly selected modules. These are
    // not consumers and never become extra verification task selections.
    const buildDependencies = new Set();
    const visitDependencies = module => {
        for (const dependency of module.dependencies) if (!buildDependencies.has(dependency)) {
            buildDependencies.add(dependency);
            visitDependencies(model.modules.find(item => item.gradlePath === dependency));
        }
    };
    for (const { module } of explicit) visitDependencies(module);
    const evidenceGroups = { build: "assembleTasks", lint: "lintTasks", device: "deviceTestTasks" };
    for (const evidence of contract.verification.criteriaEvidence ?? []) {
        const group = evidenceGroups[evidence.kind];
        if (group && evidence.references.some(task => !scope.tasks[group].includes(task)))
            fail(`criterion evidence references a task outside the explicit ${group} envelope`);
    }
    return { version: 3, mode: "bounded", baseline, scopePolicy: scope, changedPaths: paths,
        targetTests: contract.targetTests.map(target => ({ ...target })),
        cleanTasks: scope.buildMode === "clean" ? require("./bounded-execution.cjs").cleanTasks(contract) : [],
        affectedModules: [...selected.keys()].sort(), selectedVariants, reasons, buildDependencies: [...buildDependencies].sort(),
        tasks: { fullUnitTestTasks: [], ...Object.fromEntries(Object.entries(scope.tasks).map(([key, values]) => [key, [...values]])) },
        testSelection: { mode: "selected", targets: scope.regressionTests.map(target => ({ ...target })),
            reasons: ["Only the approved regression targets; no module, variant or consumer fallback."], sourceFiles: paths } };
}
module.exports = { validateBoundedScope, selectBoundedVerification, validateTargets };
