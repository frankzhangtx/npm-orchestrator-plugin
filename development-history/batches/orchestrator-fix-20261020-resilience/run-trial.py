import datetime
import hashlib
import json
from pathlib import Path
import subprocess

batch = Path(__file__).resolve().parent
root = batch / "wordpress"
evidence = batch / "trial-rc2"
evidence.mkdir(exist_ok=False)
source = json.loads((batch / "candidate/install.json").read_text())["source"]
original = Path("/Users/zhanglong/.cache/opencode/packages/@frankzhang2026/opencode-android-orchestrator@1.3.6/node_modules/@frankzhang2026/opencode-android-orchestrator")
original_queue = Path("/Users/zhanglong/files/program/wordpresslocal/WordPress/.git/automation-runtime/inbox/queue.json")
queue = json.loads(original_queue.read_text())
contract = next(item["contract"] for item in queue["items"] if item["taskId"] == "TASK-IMGCACHE-001")
policies = {key: contract[key] for key in ["recovery", "execution", "stageRecovery", "maxFixLoops", "deviceTestsRequired"]}
paths = [
    "WordPress/src/main/java/org/wordpress/android/util/DomainPhoneNumberUtils.kt",
    "WordPress/src/test/java/org/wordpress/android/util/DomainPhoneNumberUtilsTest.kt",
]
policies.update(
    continuity={"version": 1, "isolatedAutoIntegration": True, "planningRefresh": "reject", "planningInputs": paths},
    modelContinuation={"version": 1, "maxContinuations": 1, "maxCalls": 4, "maxElapsedMs": 2700000, "stepLimit": 96},
    verificationScope={"version": 1, "mode": "affected", "variants": "debug", "maxManualRetries": 1},
    maxPreparationFixes=1,
    inventory={"mode": "focusedBaseline", "existingSkips": "reject", "emptyBaseline": "reject"},
)
now = datetime.datetime.now(datetime.timezone.utc)
iso = lambda minutes: (now + datetime.timedelta(minutes=minutes)).isoformat()
run_id = "resilience-20261020-rc2"
task_id = "TASK-RESILIENCE-PHONE-20261020"
request = "修改 DomainPhoneNumberUtils.formatPhoneNumberandPrefix：前缀已带一个加号时不要重复添加，去掉前缀和号码的首尾空格，内部空格和连字符保留。保留原始 null/空串判定和点号分隔符，纯空白输入不视为 null。只修改 DomainPhoneNumberUtils.kt 与 DomainPhoneNumberUtilsTest.kt，新增对应的有意义测试并保留既有测试。失败断言在对应测试方法内直接抛出准确的 java.lang.AssertionError，不放进辅助方法，不使用会改变异常类型的字符串断言。不要修改构建配置或增加设备测试。"
spec = {
    "version": 1, "runId": run_id, "repository": str(root),
    "evidenceDirectory": str(evidence), "batchDirectory": str(batch / "trial-budget"),
    "originalHead": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip(),
    "originalBranch": "feature-0602-cases-opencode-test",
    "originalPackageRoot": str(original), "originalInstallationRoot": str(original.parents[2]),
    "targetBranch": "trial/resilience-20261020-rc2", "taskId": task_id,
    "request": request, "candidateSha256": source["sha256"],
    "allowedPaths": paths,
    "targetTests": [{"gradleTask": ":WordPress:testWordpressDebugUnitTest", "filter": "org.wordpress.android.util.DomainPhoneNumberUtilsTest"}],
    "policies": policies,
    "runScope": {"version": 1, "runId": run_id, "taskKeys": [task_id + "@1"], "expiresAt": iso(45), "cleanupExpiresAt": iso(60)},
}
spec_path = evidence / "specification.json"
spec_path.write_text(json.dumps(spec, ensure_ascii=False, indent=2) + "\n")
(evidence / "authorization-context.json").write_text(json.dumps({
    "source": "user requested continuation of interrupted resilience fix and real WordPress validation",
    "candidateBudget": 3, "businessTasksPerCandidate": 1,
    "priorCandidate": "1.3.7-rc.1 (2026-10-19, artifacts missing; no authority reused)",
    "originalWordPress": "preserve installation, blocked task and uncommitted edits",
    "requestSha256": hashlib.sha256(request.encode()).hexdigest(),
    "startedAt": now.isoformat(),
}, ensure_ascii=False, indent=2) + "\n")
with (evidence / "driver.log").open("w") as log:
    result = subprocess.run(
        ["node", str(Path(source["packageRoot"]) / "dist/cli.js"), "trial-run", str(spec_path)],
        cwd=root, stdout=log, stderr=subprocess.STDOUT,
    )
print("driver exit", result.returncode, "evidence", evidence)
raise SystemExit(result.returncode)
