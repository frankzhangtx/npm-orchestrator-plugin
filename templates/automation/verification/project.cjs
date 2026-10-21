"use strict";
// Shared validation for discovery, installation, doctor and managed Shell.
const { lstatSync } = require("node:fs");
const { dirname, isAbsolute, resolve } = require("node:path");
exports.validateProjectCapabilities = validateProjectCapabilities;
const fail = (message) => { throw new Error(`Invalid Android capability model: ${message}`); };
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const modulePath = (v) => typeof v === "string" && /^:(?:[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)*)?$/.test(v);
const types = ["application", "library", "dynamic-feature", "test", "asset-pack", "jvm-library"];
function keys(value, expected) {
    if (!object(value) || Object.keys(value).length !== expected.length || !expected.every(k => Object.hasOwn(value, k)))
        fail("unexpected fields");
}
function safePath(root, value, pattern = false) {
    if (typeof value !== "string" || !value || isAbsolute(value) || !/^[A-Za-z0-9._/*-]+$/.test(value))
        fail("unsafe repository path");
    const text = value;
    const bare = pattern && text.endsWith("/**") ? text.slice(0, -3) : text;
    if (bare.includes("*") || (bare !== "." && bare.split("/").some(p => !p || p === "." || p === ".." || [".git", ".gradle", ".automation-plugin", ".opencode"].includes(p))))
        fail("unsafe repository path");
    let path = resolve(root, bare);
    for (; path !== resolve(root); path = dirname(path)) {
        try {
            if (lstatSync(path).isSymbolicLink()) fail("symbolic-link source or module path");
        } catch (error) { if (error.code !== "ENOENT") throw error; }
        if (dirname(path) === path)
            fail("path outside repository");
    }
    return text;
}
const under = (parent, child) => parent === "." || child === parent || child.startsWith(`${parent}/`);
const base = (p) => p.endsWith("/**") ? p.slice(0, -3) : p;
const overlap = (a, b) => a === b || (a.endsWith("/**") && under(base(a), base(b))) || (b.endsWith("/**") && under(base(b), base(a)));
/** Validate persisted portable snapshots independently of Gradle output parsing. */
function validateProjectCapabilities(value, root) {
    keys(value, ["version", "buildRoot", "modules"]);
    if (value.version !== 1 || !Array.isArray(value.modules) || !value.modules.length)
        fail("unsupported or empty model");
    const buildRoot = safePath(root, value.buildRoot);
    const modules = value.modules;
    const ids = new Set();
    for (const raw of modules) {
        keys(raw, ["gradlePath", "directory", "buildFile", "type", "namespace", "applicationId", "dependencies", "sources", "tasks"]);
        if (!modulePath(raw.gradlePath) || ids.has(raw.gradlePath))
            fail("duplicate or invalid module identity");
        ids.add(raw.gradlePath);
        if (!types.includes(raw.type))
            fail("unsupported module type");
        for (const name of ["namespace", "applicationId"])
            if (raw[name] !== null && (typeof raw[name] !== "string" || !raw[name]))
                fail("invalid module identifier");
        const directory = safePath(root, raw.directory), buildFile = safePath(root, raw.buildFile);
        if (!under(buildRoot, directory) || !under(buildRoot, buildFile))
            fail("module outside selected build");
        if (!Array.isArray(raw.dependencies) || !raw.dependencies.every(modulePath) || new Set(raw.dependencies).size !== raw.dependencies.length)
            fail("invalid dependencies");
        if (!Array.isArray(raw.sources) || !Array.isArray(raw.tasks))
            fail("missing sources or tasks");
        const names = new Set();
        for (const source of raw.sources) {
            keys(source, ["name", "kind", "paths"]);
            if (typeof source.name !== "string" || !/^[A-Za-z0-9_.-]+$/.test(source.name) || names.has(source.name))
                fail("invalid source set");
            names.add(source.name);
            if (!["production", "test"].includes(source.kind) || !Array.isArray(source.paths))
                fail("invalid source classification");
            for (const p of source.paths) {
                const path = safePath(root, p, true);
                if (!under(buildRoot, base(path)) || base(path) === buildRoot || /(^|\/)(build|automation|scripts)(\/|$)/.test(path))
                    fail("generated or protected source root");
            }
        }
        const tasks = new Set();
        for (const task of raw.tasks) {
            keys(task, ["path", "kind", "variant"]);
            const prefix = raw.gradlePath === ":" ? ":" : `${raw.gradlePath}:`;
            if (typeof task.path !== "string" || !task.path.startsWith(prefix) || !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(task.path.slice(prefix.length)) || tasks.has(task.path))
                fail("invalid task identity");
            tasks.add(task.path);
            if (!["unit", "assemble", "lint", "device"].includes(task.kind) || (task.variant !== null && (typeof task.variant !== "string" || !/^[A-Za-z0-9]+$/.test(task.variant))))
                fail("invalid task capability");
        }
    }
    const model = value;
    const reached = new Set(model.modules.filter(m => m.type !== "jvm-library").map(m => m.gradlePath));
    if (!reached.size)
        fail("a standalone JVM build is unsupported");
    for (let changed = true; changed;) {
        changed = false;
        for (const m of model.modules) {
            for (const dep of m.dependencies) {
                if (!ids.has(dep))
                    fail("unresolved project dependency");
                if (reached.has(m.gradlePath) && !reached.has(dep)) {
                    reached.add(dep);
                    changed = true;
                }
            }
        }
    }
    if (reached.size !== model.modules.length)
        fail("unrelated JVM module");
    const production = model.modules.flatMap(m => m.sources.filter(s => s.kind === "production").flatMap(s => s.paths));
    const tests = model.modules.flatMap(m => m.sources.filter(s => s.kind === "test").flatMap(s => s.paths));
    if (production.some(p => tests.some(t => overlap(p, t))))
        fail("production and test roots overlap");
    const protectedFiles = model.modules.map(m => m.buildFile);
    if ([...production, ...tests].some(p => protectedFiles.some(f => overlap(p, f))))
        fail("source roots contain build configuration");
    return model;
}

exports.safePath = safePath;

function buildProtectedPaths(buildRoot) {
    const prefix = buildRoot === "." ? "" : buildRoot + "/";
    return ["gradle/**", "gradlew", "gradlew.bat", "settings.gradle", "settings.gradle.kts",
        "build.gradle", "build.gradle.kts", "gradle.properties", "local.properties", "buildSrc/**", "build-logic/**"]
        .map(p => prefix + p);
}
exports.buildProtectedPaths = buildProtectedPaths;

// The argument is always a repository/worktree root. Resolve the same portable
// build selection inside that checkout; never retain an absolute source path.
function gradleBuildRoot(config, root) {
    validateConfigurationModel(config, root);
    return resolve(root, config.androidProject?.capabilities?.buildRoot ?? ".");
}
exports.gradleBuildRoot = gradleBuildRoot;

function validateConfigurationModel(config, root) {
    if (config.androidProject?.capabilities === undefined) return;
    const model = validateProjectCapabilities(config.androidProject.capabilities, root);
    const prefix = model.buildRoot === "." ? "" : model.buildRoot + "/";
    if (![prefix + "settings.gradle", prefix + "settings.gradle.kts"].includes(config.androidProject.settingsFile))
        fail("settings file differs from selected build");
    // Legacy root snapshots retain their original policy. Nested builds require
    // protection of their wrapper, settings, local environment and build logic.
    if (model.buildRoot !== "." && buildProtectedPaths(model.buildRoot).some(p => !config.protectedPaths.includes(p)))
        fail("selected build configuration is not protected");
    const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const paths = kind => [...new Set(model.modules.flatMap(m => m.sources.filter(s => s.kind === kind).flatMap(s => s.paths)))];
    for (const [key, kind] of [["productionPaths", "production"], ["testPaths", "test"]])
        if (!equal(config.androidProject[key], paths(kind))) fail("source paths differ from capability snapshot");
    const modules = model.modules.map(m => ({gradlePath:m.gradlePath, directory:m.directory, buildFile:m.buildFile,
        dsl:m.buildFile.endsWith(".kts") ? "kotlin" : "groovy", type:m.type, namespace:m.namespace, applicationId:m.applicationId}));
    if (!equal(config.androidProject.modules, modules)) fail("module identities differ from capability snapshot");
    const groups = {fullUnitTestTasks:"unit", focusedTestTasks:"unit", assembleTasks:"assemble", lintTasks:"lint", deviceTestTasks:"device"};
    for (const [group, kind] of Object.entries(groups)) {
        const allowed = new Set(model.modules.flatMap(m => m.tasks.filter(t => t.kind === kind).map(t => t.path)));
        if (!config.gradleVerification[group].every(t => allowed.has(t))) fail("verification task was not discovered: " + group);
    }
    for (const m of model.modules) {
        const required = m.tasks.filter(t => t.kind === "unit");
        if (required.some(t => !config.gradleVerification.fullUnitTestTasks.includes(t.path)))
            fail("full verification omits module: " + m.gradlePath);
        const builds = m.tasks.filter(t => t.kind === "assemble");
        if (!builds.length || builds.some(t => !config.gradleVerification.assembleTasks.includes(t.path)))
            fail("build verification omits module: " + m.gradlePath);
    }
    const sources = [...paths("production"), ...paths("test")];
    if (sources.some(p => config.protectedPaths.some(f => overlap(p, f.endsWith("/") ? f + "**" : f)))) fail("source paths overlap protected configuration");
}
exports.validateConfigurationModel = validateConfigurationModel;

// The capability matrix is an allowlist, not a command to build every variant.
// A sealed scope policy selects commands from it for this candidate only.
function validateVerificationScope(scope) {
    keys(scope, ["version", "mode", "variants", "maxManualRetries"]);
    if (!(scope.version === 1 && scope.mode === "affected" || scope.version === 2 && scope.mode === "affected-tests") || !["debug", "all"].includes(scope.variants) ||
        !Number.isInteger(scope.maxManualRetries) || scope.maxManualRetries < 0 || scope.maxManualRetries > 3)
        fail("invalid verification scope policy");
}
function concreteBuilds(module) {
    const builds = module.tasks.filter(t => t.kind === "assemble");
    if (module.type === "jvm-library") return builds.filter(t => t.variant === null);
    return builds.filter(t => t.variant !== null && (module.tasks.some(unit => unit.kind === "unit" && unit.variant === t.variant) || !builds.some(other => other !== t && other.variant &&
        other.variant !== t.variant && (other.variant.startsWith(t.variant) || other.variant.endsWith(t.variant)))));
}
function sourceMatchesVariant(source, variant) {
    if (source.name === "testFixtures") return true;
    let name = source.name.replace(/^(?:androidTest|test)(?=[A-Z]|$)/, "");
    if (["", "main", "testFixtures"].includes(name)) return true;
    const words = value => (value.match(/[A-Z]?[a-z0-9]+|[A-Z]+(?![a-z])/g) ?? []).map(w => w.toLowerCase());
    const wanted = words(name), actual = words(variant);
    return wanted.length > 0 && actual.some((_, i) => wanted.every((word, j) => actual[i + j] === word));
}
function selectVerification(config, contract, root, changedPaths, baseline = false, comparisonHead = "HEAD") {
    const scope = contract.verification?.scope;
    validateVerificationScope(scope);
    validateConfigurationModel(config, root);
    if (!config.androidProject?.capabilities) fail("impact verification requires refreshed Gradle capability discovery");
    const model = config.androidProject.capabilities;
    const { matchesPath } = require("./contract.cjs");
    const selected = new Map(), production = new Set(), consumers = new Set(), reasons = [];
    const add = (id, source) => {
        if (!selected.has(id)) selected.set(id, new Set());
        if (source) selected.get(id).add(source);
    };
    const paths = [...new Set(baseline ? contract.allowedPaths : changedPaths)].sort();
    for (const file of paths) {
        if (file === contract.planPath || file === `automation/tasks/${contract.id}.json`) continue;
        if (!baseline && !contract.allowedPaths.some(pattern => matchesPath(pattern, file))) fail(`changed path outside approved scope: ${file}`);
        const matches = model.modules.flatMap(m => m.sources.filter(s => s.paths.some(pattern =>
            baseline ? overlap(pattern, file) || matchesPath(file, base(pattern)) : matchesPath(pattern, file))).map(s => ({ m, s })));
        if (!matches.length) fail(`cannot map changed or approved path to a source set: ${file}`);
        for (const { m, s } of matches) {
            if (s.name.startsWith("androidTest") && !contract.deviceTestsRequired) fail(`device source changes require approved device tests: ${file}`);
            add(m.gradlePath, s.name);
            if (s.kind === "production" || s.name === "testFixtures") production.add(m.gradlePath);
            reasons.push({ path: file, module: m.gradlePath, sourceSet: s.name, kind: s.kind });
        }
    }
    // Library/API/resource changes affect consumers, including transitive ones.
    for (let changed = true; changed;) {
        changed = false;
        for (const m of model.modules) if (m.dependencies.some(dep => production.has(dep))) {
            if (!production.has(m.gradlePath)) { production.add(m.gradlePath); changed = true; }
            if (!consumers.has(m.gradlePath)) reasons.push({ module: m.gradlePath, reason: "depends on changed production", dependencies: m.dependencies.filter(dep => production.has(dep)) });
            consumers.add(m.gradlePath); add(m.gradlePath, null);
        }
    }
    const tasks = { fullUnitTestTasks: [], assembleTasks: [], lintTasks: [], deviceTestTasks: [] };
    const selectedVariants = {};
    for (const m of model.modules.filter(m => selected.has(m.gradlePath))) {
        const builds = concreteBuilds(m);
        if (!builds.length) fail(`no concrete build tasks for impacted module: ${m.gradlePath}`);
        let variants = builds.map(t => t.variant);
        if (m.type !== "jvm-library") {
            const all = variants;
            if (scope.variants === "debug") variants = variants.filter(v => v && /Debug$/.test(v));
            const sources = [...selected.get(m.gradlePath)].map(name => m.sources.find(s => s.name === name));
            if (sources.length) {
                for (const source of sources) if (!variants.some(v => sourceMatchesVariant(source, v)))
                    fail(`source set ${m.gradlePath}:${source.name} is not covered by ${scope.variants}; approve an all-variant scope or narrow allowed paths`);
                if (!consumers.has(m.gradlePath)) variants = variants.filter(v => sources.some(s => sourceMatchesVariant(s, v)));
            }
            if (!variants.length) fail(`no ${scope.variants} variants for impacted module ${m.gradlePath}; discovered ${all.join(", ")}`);
        }
        selectedVariants[m.gradlePath] = variants;
        tasks.fullUnitTestTasks.push(...m.tasks.filter(t => t.kind === "unit" && (m.type === "jvm-library" || variants.includes(t.variant))).map(t => t.path));
        if (production.has(m.gradlePath)) tasks.assembleTasks.push(...builds.filter(t => variants.includes(t.variant)).map(t => t.path));
        if (config.lintEnabled && m.type !== "jvm-library") {
            const lint = m.tasks.filter(t => t.kind === "lint" && variants.includes(t.variant));
            if (lint.length !== variants.length) fail(`missing variant-specific lint capability: ${m.gradlePath}`);
            tasks.lintTasks.push(...lint.map(t => t.path));
        }
        if (contract.deviceTestsRequired && m.type !== "jvm-library") {
            const devices = m.tasks.filter(t => t.kind === "device" && variants.includes(t.variant));
            if (devices.length !== variants.length) fail(`missing variant-specific device capability: ${m.gradlePath}`);
            tasks.deviceTestTasks.push(...devices.map(t => t.path));
        }
    }
    // Declared behavioral tests and explicit acceptance evidence remain mandatory.
    tasks.fullUnitTestTasks.push(...contract.targetTests.map(t => t.gradleTask));
    const groups = { build: "assembleTasks", lint: "lintTasks", device: "deviceTestTasks" };
    for (const evidence of contract.verification.criteriaEvidence ?? []) if (groups[evidence.kind])
        tasks[groups[evidence.kind]].push(...evidence.references);
    for (const [group, values] of Object.entries(tasks)) {
        tasks[group] = [...new Set(values)].sort();
        if (tasks[group].some(t => !config.gradleVerification[group].includes(t))) fail(`selected task outside configured capabilities: ${group}`);
    }
    if (!tasks.fullUnitTestTasks.length) fail("no unit tests cover this candidate");
    const plan = { version: scope.version, mode: scope.mode, variants: scope.variants, baseline, changedPaths: paths,
        affectedModules: [...selected.keys()].sort(), selectedVariants, reasons, tasks };
    if (scope.version === 2) {
        plan.testSelection = require('./test-selection.cjs').selectTests(config, contract, root, paths, plan, baseline, sourceMatchesVariant, comparisonHead);
        if (plan.testSelection.mode === 'selected') plan.tasks.fullUnitTestTasks = [];
    }
    return plan;
}
exports.validateVerificationScope = validateVerificationScope;
exports.selectVerification = selectVerification;
exports.concreteBuilds = concreteBuilds;
exports.sourceMatchesVariant = sourceMatchesVariant;

// Shared actual-runtime diagnostics. PATH java is only a launcher candidate;
// it is never substituted for the wrapper's build JVM attestation.
function parseBuildRuntime(output) {
    const lines = output.split(/\r?\n/).filter(line => line.startsWith("ORCHESTRATOR_BUILD_RUNTIME="));
    if (lines.length !== 1) throw new Error("Gradle did not produce exactly one actual build JVM record");
    const value = JSON.parse(lines[0].slice("ORCHESTRATOR_BUILD_RUNTIME=".length));
    if (value.version !== 1 || typeof value.gradleVersion !== "string" || !/^\d+\.\d+/.test(value.gradleVersion) ||
        typeof value.javaVersion !== "string" || !/^(?:1\.)?\d+/.test(value.javaVersion) ||
        typeof value.javaHome !== "string" || !isAbsolute(value.javaHome) || typeof value.javaVendor !== "string" ||
        !Array.isArray(value.plugins) || !Array.isArray(value.tests)) throw new Error("Invalid actual Gradle/JVM record");
    const java = Number(value.javaVersion.replace(/^1\./, "").match(/^\d+/)[0]);
    if (/^6\.7(?:\.|$)/.test(value.gradleVersion) && (java < 8 || java > 15))
        throw new Error("Gradle 6.7 requires an actual build JVM from Java 8 through 15");
    for (const item of value.tests) if (!modulePath(item.task) || typeof item.executable !== "string" || !isAbsolute(item.executable))
        throw new Error("Invalid test JVM record");
    return value;
}
function inspectBuildRuntime(root, runner) {
    const fs = require("node:fs"), path = require("node:path");
    const executable = path.join(root, "gradlew");
    const args = ["help", "--no-configuration-cache", "--console=plain", "--quiet", "--project-dir", root,
        "--init-script", path.join(__dirname, "runtime.init.gradle")];
    if (process.env.AUTOMATION_WORKER_TOKEN) args.push("--no-daemon");
    const result = runner ? runner(executable, args) : require("node:child_process").spawnSync(executable, args,
        { cwd: root, encoding: "utf8", timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
    if (result.status !== 0 || result.error) throw new Error(`Cannot verify the wrapper's actual Gradle/JVM: ${String(result.error ?? result.stderr ?? '').slice(-2000)}`);
    return parseBuildRuntime(result.stdout);
}
function buildEnvironmentBinding(root, runtime) {
    const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
    const hash = value => crypto.createHash("sha256").update(value).digest("hex");
    const env = Object.fromEntries(["PATH", "JAVA_HOME", "JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS", "GRADLE_OPTS", "GRADLE_USER_HOME", "ANDROID_HOME", "ANDROID_SDK_ROOT"]
        .map(key => [key, process.env[key] ?? null]));
    const home = process.env.GRADLE_USER_HOME ?? path.join(require("node:os").homedir(), ".gradle");
    const files = [path.join(home, "gradle.properties"), path.join(home, "init.gradle"), path.join(home, "init.gradle.kts"),
        path.join(root, "gradle.properties"), path.join(root, "local.properties"), path.join(root, "gradle/gradle-daemon-jvm.properties")];
    const init = path.join(home, "init.d");
    if (fs.existsSync(init)) files.push(...fs.readdirSync(init).sort().filter(name => /\.gradle(?:\.kts)?$/.test(name)).map(name => path.join(init, name)));
    const homes = [process.env.JAVA_HOME, runtime?.javaHome].filter(Boolean);
    for (const javaHome of homes) files.push(path.join(javaHome, "bin/java"), path.join(javaHome, "release"));
    if (runtime) files.push(...runtime.tests.map(test => test.executable));
    const inputs = [...new Set(files)].sort().map(file => [file, fs.existsSync(file) ? hash(fs.readFileSync(file)) : null]);
    return hash(JSON.stringify({ env, inputs }));
}
exports.parseBuildRuntime = parseBuildRuntime;
exports.inspectBuildRuntime = inspectBuildRuntime;
exports.buildEnvironmentBinding = buildEnvironmentBinding;
function assertIsolatedBuildEnvironment(root) {
    const fs = require("node:fs"), path = require("node:path");
    const local = path.join(root, "local.properties");
    if (!fs.existsSync(local)) return;
    if (fs.lstatSync(local).isSymbolicLink()) throw new Error("Isolated builds require a regular local.properties file");
    const lines = fs.readFileSync(local, "utf8").split(/\r?\n/).filter(line => line.trim() && !/^\s*[#!]/.test(line));
    if (!lines.every(line => /^\s*sdk\.dir\s*[=:]/.test(line) && !/\\$/.test(line)))
        throw new Error("ISOLATED_ENVIRONMENT_UNDECLARED: local.properties contains non-SDK inputs. Configure them through reviewed tracked build configuration or use an explicitly approved fixed-branch task; ignored files are not copied to worktrees.");
}
exports.assertIsolatedBuildEnvironment = assertIsolatedBuildEnvironment;
if (require.main === module) {
    try {
        const config = JSON.parse(require("node:fs").readFileSync(process.argv[2], "utf8"));
        const root = gradleBuildRoot(config, process.argv[3]);
        if (process.argv[4] === "--build-root") console.log(root);
        if (process.argv[4] === "--select-baseline") {
            const contract = JSON.parse(require("node:fs").readFileSync(process.argv[5], "utf8"));
            console.log(JSON.stringify(selectVerification(config, contract, process.argv[3], [], true)));
        }
    }
    catch (error) { console.error(error.message); process.exitCode = 1; }
}
