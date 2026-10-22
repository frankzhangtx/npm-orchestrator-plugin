import json
import os
from pathlib import Path
import signal
import subprocess

batch = Path(__file__).resolve().parent
lock = json.loads((batch / "wordpress/.git/automation-runtime/locks/trial-driver.lock").read_text())
pid = lock["pid"]
started = subprocess.check_output(["ps", "-p", str(pid), "-o", "lstart="], text=True).strip()
command = subprocess.check_output(["ps", "-p", str(pid), "-o", "command="], text=True).strip()
assert started == lock["started"]
assert "trial-run" in command and str(batch / "trial-rc2/specification.json") in command
(batch / "trial-rc2/operator-stop.json").write_text(json.dumps({
    "pid": pid, "started": started,
    "reason": "Package fixture exposed capacity-scan cleanup race; stop rc2 and validate final rc3 within original candidate budget.",
    "signal": "SIGTERM",
}, indent=2) + "\n")
os.kill(pid, signal.SIGTERM)
print("Requested bounded driver cleanup", pid)
