import json
import os
from pathlib import Path
import subprocess

batch = Path(__file__).resolve().parent
fixture = batch / "driver-fixtures/orchestrator-queue-test-r4HW7Q"
spec_path = fixture / "trial/specification.json"
spec = json.loads(spec_path.read_text())
root = Path(spec["repository"])
source = json.loads((batch / "candidate/install.json").read_text())["source"]
cli = str(Path(source["packageRoot"]) / "dist/cli.js")
env = dict(os.environ, PATH=str(fixture / "bin") + ":" + os.environ["PATH"], ANDROID_HOME=str(fixture))
queue_path = root / ".git/automation-runtime/inbox/queue.json"
queue = json.loads(queue_path.read_text())
assert queue["active"] is None and queue["paused"] is True
assert queue["fault"] == "Error: Cannot measure retained workspace disk usage"
assert next(x for x in queue["items"] if x["taskId"] == "TASK-TRIAL")["state"] == "COMPLETED"
(fixture / "pre-recovery-queue.json").write_text(json.dumps(queue, indent=2) + "\n")
for item in queue["items"]:
    if item.get("taskRoot") and Path(item["taskRoot"]).exists():
        subprocess.run(["du", "-sk", item["taskRoot"]], check=True)
subprocess.run(["node", cli, "queue", "clear-fault", str(root)], cwd=root, env=env, check=True, stdout=subprocess.DEVNULL)
with (fixture / "operator-recovery.log").open("w") as log:
    result = subprocess.run(["node", cli, "trial-recover", str(spec_path)], cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT)
print("recovery exit", result.returncode)
print({k: json.loads((fixture / "trial/trial.json").read_text()).get(k) for k in ["phase", "intent", "result", "error"]})
