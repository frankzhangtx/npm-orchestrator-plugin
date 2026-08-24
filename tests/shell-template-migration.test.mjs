import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const templatesRoot = fileURLToPath(new URL("../templates/", import.meta.url));
const automationRoot = join(templatesRoot, "scripts", "automation");

const expectedHashes = new Map([
  [
    "scripts/automation/abort-task.sh",
    "a581f47327b0929eb22eb044e02e466f9caded17f2b0c2b78128a130a6f66c41",
  ],
  [
    "scripts/automation/accept-and-integrate.sh",
    "23b0397dbff45da94cf0eff6c466c1a7af07457568bbaab02320235592c91707",
  ],
  [
    "scripts/automation/acceptance-report.sh",
    "a80456ed8c6ba110bf078263022f4903d4a783d483fc073d2685da0e33514fd3",
  ],
  [
    "scripts/automation/approve-and-run.sh",
    "46bac28a4bc4ea31adb1a9760ca39d6d31d8da7c7117d053fc8b2146debb562d",
  ],
  [
    "scripts/automation/begin-review.sh",
    "02f0b9551e81c2f540e1bb3fc223cd6efef7ca1a84d86f2ccd87fbdf1fb45e9d",
  ],
  [
    "scripts/automation/block-task.sh",
    "86dd3c6b5f906724b530a8799c14c2d90d05176b152b67d9d435bd205cd1b893",
  ],
  [
    "scripts/automation/claim-task.sh",
    "b7301e94f8895c23ac75d1622d497049366d13d0b355cb2ff1d37f1ece64ffdb",
  ],
  [
    "scripts/automation/integration-scope-gate.sh",
    "1ba0d1cf566ff1015ce3070296cc83202aa26f4c4a17c483c3cdc7e1f56b5b50",
  ],
  [
    "scripts/automation/lib.sh",
    "0f3e3184cb4871198d116dad48193f6f8c21dd299548665e0b1e9ecf9d43ea58",
  ],
  [
    "scripts/automation/orchestrate-task.sh",
    "f77a4e602fdf75a6b8c8bbf591da4b3c64017ffacd4756b5d8d37fa61e6e6f91",
  ],
  [
    "scripts/automation/preflight.sh",
    "2d89f888c709ef5e365c3038fe729ec0b320769357a6345981055aafe43ea949",
  ],
  [
    "scripts/automation/prepare-contract-review.sh",
    "c50a0a67515ea89d613b97e4e6fd625551a2c7a08ae93881e955df94c4c10430",
  ],
  [
    "scripts/automation/quality-gate.sh",
    "65eeb266f707a61fa7992a1002457359eff95210c3af7a5ce39a60e82424ae01",
  ],
  [
    "scripts/automation/queue-task.sh",
    "25ddd03d9a02291c945cade4c425d25647a9474a0a91b0de3c651c808e71c341",
  ],
  [
    "scripts/automation/record-red.sh",
    "aed319b7231a5b27e9062510e95fad849e565c6ddb3a63d1bdebe6e8e5ff7198",
  ],
  [
    "scripts/automation/resume-review-fix.sh",
    "9d56ad22c5bcf9d56f085f3b7b41680ff891f0d2f0a332f46027fb7279647bd5",
  ],
  [
    "scripts/automation/resume-review.sh",
    "dd0a73af218c4a1b7e9cf5266574b0f943fb12c61ec1e652d1fea2a6e9187592",
  ],
  [
    "scripts/automation/scope-gate.sh",
    "9dbebfa969bf19acc748b367dba8355e6e658c003651f4add95db1142ddf6ddd",
  ],
  [
    "scripts/automation/select-task.sh",
    "9e6726efe0035734c77c66426b2c778bbf7f069b3e1d73b57b01db43516731c2",
  ],
  [
    "scripts/automation/shadow-run.sh",
    "69cb91662e034d789eb40f4d7c73c03c6e9b56fd0ef069027031965ac9c5c2fe",
  ],
  [
    "scripts/automation/show-acceptance-review.sh",
    "56ee3a37712d42d106cf26ee1ae266a7ad3b74c593ff926fcb1f7f0038029e3f",
  ],
  [
    "scripts/automation/status.sh",
    "16aa708b9c92c0c4d298b6678537281ebcfa079ecc4a6321dc022a4739fe996c",
  ],
  [
    "scripts/automation/submit-review.sh",
    "9efe0ad028014aaa6be42ee93eb568d091b67321370f32626ad569afb6b46f46",
  ],
  [
    "scripts/automation/tests/run-tests.sh",
    "1afc99abe485a2dc73b9486a4e6dfb1790c768611db2c91de5c454dbc5bc10be",
  ],
  [
    "scripts/automation/transition-state.sh",
    "294d5d0e1c217d9efe3bf48d6f4d0eca1abec7a2216b27ec41da479766b5f7b7",
  ],
  [
    "scripts/automation/validate-contract.sh",
    "cd0d16e84e916ad8971fcc262879d84f9842c077023ede7797da6413c892bf48",
  ],
  [
    "scripts/automation/verify-integration.sh",
    "2d85a0dfdea8f4b452daf91277702ab3a5a19ed8ab350bf6c23e363d1ceb28b2",
  ],
  [
    "scripts/automation/verify-task.sh",
    "93ef720c5061daaaa6b8049532600e587eed638ba6cd15a46e9ab0fc48956d6b",
  ],
]);

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

function templatePath(path) {
  return relative(templatesRoot, path).split(sep).join("/");
}

test("ships exactly the 28 audited V3 automation shell files", () => {
  const actualPaths = listFiles(automationRoot).map(templatePath).sort();
  assert.deepEqual(actualPaths, [...expectedHashes.keys()].sort());
});

test("preserves audited shell bytes and executable modes", () => {
  for (const [path, expectedHash] of expectedHashes) {
    const absolutePath = join(templatesRoot, path);
    const contents = readFileSync(absolutePath);
    const actualHash = createHash("sha256").update(contents).digest("hex");

    assert.equal(actualHash, expectedHash, path);
    assert.equal(statSync(absolutePath).mode & 0o777, 0o755, path);
  }
});

test("all migrated automation files are valid Bash scripts", () => {
  for (const path of expectedHashes.keys()) {
    const absolutePath = join(templatesRoot, path);
    const contents = readFileSync(absolutePath, "utf8");
    const syntaxCheck = spawnSync("bash", ["-n", absolutePath], {
      encoding: "utf8",
      shell: false,
    });

    assert.match(contents, /^#!\/usr\/bin\/env bash\n/, path);
    assert.equal(
      syntaxCheck.status,
      0,
      `${path}: ${syntaxCheck.stderr.trim()}`,
    );
    assert.doesNotMatch(contents, /\r\n/, path);
    assert.doesNotMatch(
      contents,
      /\b(?:launchctl|launchd|npm publish|git push)\b/,
      path,
    );
    assert.doesNotMatch(
      contents,
      /\/Users\/|zhanglong|cctest|opencode-scheduler/i,
      path,
    );
  }
});
