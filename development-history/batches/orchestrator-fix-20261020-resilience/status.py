import datetime
import json
import sys
from pathlib import Path

root = Path(__file__).resolve().parent
print(datetime.datetime.now().astimezone().isoformat())
rc3 = "--rc3" in sys.argv
for name in (["rc3-full-tests.log", "rc3-driver-fixture.log"] if rc3 else ["full-tests.log", "candidate-driver-fixture.log"]):
    path = root / name
    if path.exists():
        lines = path.read_text(errors="replace").splitlines()
        print(name, "lines", len(lines), "bytes", path.stat().st_size)
        print("\n".join(lines[-4:]))
trial = root / ("trial-rc3" if rc3 else "trial-rc2")
path = trial / "trial.json"
if path.exists():
    data = json.loads(path.read_text())
    print("trial", {key: data.get(key) for key in ["phase", "intent", "result", "error"]})
events = trial / "planner-events.jsonl"
if events.exists():
    lines = events.read_text().splitlines()
    print("planner events", len(lines))
    for line in lines[-3:]:
        try:
            item = json.loads(line)
            part = item.get("part", {})
            state = part.get("state", {})
            print(item.get("type"), part.get("tool"), state.get("status"), str(state.get("error", ""))[:350])
        except json.JSONDecodeError:
            pass
runtime = root / "wordpress/.git/automation-runtime"
queue = runtime / "inbox/queue.json"
if queue.exists():
    data = json.loads(queue.read_text())
    print("queue", {"paused": data.get("paused"), "fault": data.get("fault")})
    for item in data["items"]:
        print("task", {key: item.get(key) for key in ["key", "state", "waitingReason", "taskRoot"]})
    active = data.get("active")
    if active:
        supervision = active.get("supervision") or {}
        print("active", {key: active.get(key) for key in ["key", "pid"]},
              {key: supervision.get(key) for key in ["stage", "state", "stopReason", "deadline", "stageDeadline"]})
