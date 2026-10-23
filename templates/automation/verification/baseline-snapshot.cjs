"use strict";

// A source snapshot is not a passing test run. It protects existing definitions
// until RED can collect real case identities, including parameterized cases.
const fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process");
const { createHash } = require("node:crypto");
const hash = value => createHash("sha256").update(value).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function fail(message, issues = []) {
  const error = new Error(message); error.code = "SNAPSHOT_TEST_DEFINITION_CHANGED"; error.issues = issues; throw error;
}
function enabled(contract) {
  return contract.verification?.scope?.version === 3 && (contract.verification.scope.baseline ?? "snapshot") === "snapshot";
}

// This deliberately recognizes a small, auditable additive edit. It does not
// pretend that a source parser can enumerate JUnit's dynamic runtime identities.
function tokens(source) {
  if (/\\u+[0-9a-fA-F]{4}/.test(source)) fail("Unicode escapes require explicit review of existing test definitions");
  const result = [];
  for (let index = 0; index < source.length;) {
    const start = index, value = source[index];
    if (/\s/.test(value)) { index++; continue; }
    if (source.startsWith("//", index)) { index = source.indexOf("\n", index); if (index < 0) break; continue; }
    if (source.startsWith("/*", index)) {
      let depth = 1; index += 2;
      while (depth && index < source.length) {
        if (source.startsWith("/*", index)) { depth++; index += 2; }
        else if (source.startsWith("*/", index)) { depth--; index += 2; }
        else index++;
      }
      if (depth) fail("Unclosed comment in test source");
      continue;
    }
    if (source.startsWith('"""', index)) {
      const end = source.indexOf('"""', index + 3);
      if (end < 0) fail("Unclosed multiline string in test source");
      index = end + 3;
    } else if (value === '"' || value === "'" || value === "`") {
      index++;
      while (index < source.length && source[index] !== value) {
        if (source[index] === "\\" && value !== "`") index++;
        index++;
      }
      if (index >= source.length) fail("Unclosed literal in test source");
      index++;
    } else if (/[A-Za-z_$0-9]/.test(value)) {
      index++;
      while (index < source.length && /[A-Za-z_$0-9]/.test(source[index])) index++;
    } else index++;
    result.push({ value: source.slice(start, index), start, end: index });
  }
  return result;
}
function splitClass(source) {
  const parsed = tokens(source), values = parsed.map(item => item.value), classIndex = values.indexOf("class");
  if (classIndex < 0 || values.slice(0, classIndex).includes("object")) fail("Only an additive edit to an existing Java/Kotlin test class can be established without running its baseline");
  const open = values.indexOf("{", classIndex);
  if (open < 0 || values.slice(classIndex, open).some(value => [":", "extends", "implements"].includes(value)))
    fail("Cannot establish inherited test definitions from a source snapshot alone");
  let depth = 1, close = open + 1;
  for (; close < values.length && depth; close++) {
    if (values[close] === "{") depth++;
    if (values[close] === "}") depth--;
  }
  if (depth) fail("Unbalanced test class");
  close--;
  const imports = [], header = [];
  for (let index = 0; index < open; index++) {
    if (values[index] !== "import") { header.push(values[index]); continue; }
    const declaration = [values[index++]];
    while (index < open) {
      const gap = source.slice(parsed[index - 1].end, parsed[index].start);
      if (/\r|\n/.test(gap)) break;
      declaration.push(values[index]);
      if (values[index++] === ";") break;
    }
    index--;
    imports.push(declaration);
  }
  return { header, imports, body: values.slice(open + 1, close), tail: values.slice(close), all: values };
}
function appendedMethods(values, extension) {
  let index = 0;
  const names = [];
  const consumePair = (left, right) => {
    if (values[index++] !== left) fail(`Expected ${left} in appended test definition`);
    let depth = 1;
    while (index < values.length && depth) {
      const next = values[index++]; if (next === left) depth++; if (next === right) depth--;
    }
    if (depth) fail("Unbalanced appended test definition");
  };
  while (index < values.length) {
    if (values[index++] !== "@") fail("Append only complete @Test methods to an existing test class; existing definitions remain frozen until RED");
    let annotation = values[index++];
    while (values[index] === ".") { index++; annotation += "." + values[index++]; }
    if (!["Test", "org.junit.Test", "org.junit.jupiter.api.Test"].includes(annotation)) fail("Only ordinary @Test methods can be established as additive test changes");
    if (values[index] === "(") consumePair("(", ")");
    if (values[index] === "public") index++;
    if (values[index++] !== (extension === ".kt" ? "fun" : "void")) fail("Appended tests must be ordinary non-overriding, zero-argument methods");
    const name = values[index++];
    if (!/^(?:[A-Za-z_$][A-Za-z_$0-9]*|`[^`]+`)$/.test(name ?? "")) fail("Invalid appended test method name");
    if (values[index++] !== "(" || values[index++] !== ")") fail("Appended tests must have no parameters");
    if (extension === ".kt" && values[index] === ":") {
      index++; if (values[index++] !== "Unit") fail("Appended tests must return Unit");
    }
    if (extension === ".java" && values[index] === "throws") {
      index++;
      while (index < values.length && values[index] !== "{") {
        if (!/^[A-Za-z_$][A-Za-z_$0-9]*$/.test(values[index]) && ![".", ","].includes(values[index])) fail("Invalid test exception declaration");
        index++;
      }
    }
    consumePair("{", "}");
    if (values[index] === ";") index++;
    names.push(name);
  }
  if (!names.length || new Set(names).size !== names.length) fail("No unique appended test methods were found");
  return names;
}
function validateTestAdditions(before, after, file) {
  const extension = path.extname(file);
  if (![".java", ".kt"].includes(extension)) fail("Existing test fixtures and resources cannot change before RED in snapshot mode");
  const old = splitClass(before), current = splitClass(after);
  if (!same(old.header, current.header) || !same(old.tail, current.tail) ||
      !same(old.body, current.body.slice(0, old.body.length)))
    fail("Existing test definitions changed; keep their code and append the approved @Test methods before the class closing brace");
  const key = value => JSON.stringify(value);
  if (!old.imports.every(item => current.imports.some(value => key(item) === key(value)))) fail("Existing test imports changed");
  const addedImports = current.imports.filter(item => !old.imports.some(value => key(item) === key(value)));
  for (const declaration of addedImports) {
    const values = declaration.filter(value => value !== ";"), name = values.at(-1);
    if (values.includes("*") || values.includes("as") || !/^[A-Za-z_$][A-Za-z_$0-9]*$/.test(name ?? "") || old.all.includes(name))
      fail("A new import could change an existing test definition's name resolution");
  }
  const added = current.body.slice(old.body.length);
  if (!added.length) {
    if (addedImports.length) fail("Imports alone are not an approved additive test change");
    return { addedMethods: [], formattingOnly: true };
  }
  const names = appendedMethods(added, extension);
  if (names.some(name => old.body.includes(name))) fail("An appended method may replace or shadow an existing test definition");
  return { addedMethods: names.map(name => name.startsWith("`") ? name.slice(1, -1) : name), formattingOnly: false };
}
function describeTestSource(source, file) {
  if (![".java", ".kt"].includes(path.extname(file))) return null;
  try {
    const parsed = tokens(source), shape = splitClass(source), values = parsed.map(item => item.value);
    if (shape.tail.slice(1).some(value => value !== ";")) fail("Multiple top-level test declarations cannot be mapped safely from a source snapshot");
    if (shape.imports.some(declaration => declaration.includes("as"))) fail("Aliased test annotations require explicit identity review");
    const classIndex = values.indexOf("class"), simpleName = values[classIndex + 1];
    if (!/^[A-Za-z_$][A-Za-z_$0-9]*$/.test(simpleName ?? "")) fail("Unsupported test class name");
    const packageIndex = values.indexOf("package");
    let packageName = "";
    if (packageIndex >= 0) {
      for (let index = packageIndex + 1; index < classIndex; index++) {
        if (values[index] === ";" || /[\r\n]/.test(source.slice(parsed[index - 1].end, parsed[index].start))) break;
        if (values[index] !== "." && !/^[A-Za-z_$][A-Za-z_$0-9]*$/.test(values[index])) fail("Unsupported test package");
        packageName += values[index];
      }
    }
    const methods = [], body = shape.body;
    let depth = 0;
    for (let index = 0; index < body.length; index++) {
      if (body[index] === "{") { depth++; continue; }
      if (body[index] === "}") { depth--; continue; }
      if (body[index] !== "@") continue;
      let annotation = body[++index];
      while (body[index + 1] === ".") { index += 2; annotation += "." + body[index]; }
      if (!["Test", "org.junit.Test", "org.junit.jupiter.api.Test"].includes(annotation)) {
        if (/(?:Test|TestFactory|TestTemplate)$/.test(annotation)) fail("Non-ordinary test annotations cannot be mapped safely from a source snapshot");
        continue;
      }
      if (depth) fail("Nested test declarations cannot be mapped safely from a source snapshot");
      if (body[index + 1] === "(") {
        let parentheses = 0;
        do { index++; if (body[index] === "(") parentheses++; if (body[index] === ")") parentheses--; }
        while (index + 1 < body.length && parentheses);
        if (parentheses) fail("Unbalanced test annotation");
      }
      const signature = [];
      while (index + 1 < body.length && !["{", "=", ";"].includes(body[index + 1])) signature.push(body[++index]);
      const keyword = signature.findIndex(token => token === "fun" || token === "void");
      const name = signature[keyword + 1];
      if (keyword < 0 || signature[keyword + 2] !== "(" || !/^(?:[A-Za-z_$][A-Za-z_$0-9]*|`[^`]+`)$/.test(name ?? ""))
        fail("Cannot establish ordinary test method identity");
      methods.push(name.startsWith("`") ? name.slice(1, -1) : name);
    }
    return { path: file, mapping: "ordinary-tests", className: packageName ? `${packageName}.${simpleName}` : simpleName, methods };
  } catch (error) { return { path: file, mapping: "unsupported", reason: error.message }; }
}
function assertTestSnapshotPreserved(root, baseline, current) {
  const changes = [];
  for (const original of baseline.testSnapshot) {
    const candidate = current.find(item => item.path === original.path);
    if (!candidate) fail("An existing test source or fixture was removed or renamed before RED", [{ path: original.path, change: "deleted" }]);
    if (candidate.mode !== original.mode) fail("An existing test file mode changed before RED", [{ path: original.path, change: "mode" }]);
    if (candidate.sha256 === original.sha256) continue;
    const result = cp.spawnSync("git", ["-C", root, "show", `${baseline.binding.baselineHead}:${original.path}`], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    if (result.status !== 0 || hash(result.stdout) !== original.sha256) fail("The original test source cannot be recovered from the sealed baseline", [{ path: original.path }]);
    try {
      const edit = validateTestAdditions(result.stdout, fs.readFileSync(path.join(root, original.path), "utf8"), original.path);
      const definition = describeTestSource(fs.readFileSync(path.join(root, original.path), "utf8"), original.path);
      changes.push({ path: original.path, beforeSha256: original.sha256, afterSha256: candidate.sha256, className: definition?.className, ...edit });
    } catch (error) {
      error.issues = [{ path: original.path, beforeSha256: original.sha256, afterSha256: candidate.sha256, ...error.issues?.[0] }]; throw error;
    }
  }
  for (const item of current) if (!baseline.testSnapshot.some(original => original.path === item.path)) {
    const definition = describeTestSource(fs.readFileSync(path.join(root, item.path), "utf8"), item.path);
    if (definition?.mapping === "unsupported") fail("Cannot establish the new test source's generated case identities without widening the approved scope", [{ path: item.path, reason: definition.reason }]);
    changes.push({ path: item.path, beforeSha256: null, afterSha256: item.sha256, addedFile: true,
      ...(definition ? { className: definition.className, addedMethods: definition.methods } : {}) });
  }
  return changes;
}
module.exports = { enabled, validateTestAdditions, assertTestSnapshotPreserved, describeTestSource };
