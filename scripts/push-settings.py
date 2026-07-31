#!/usr/bin/env python3
"""
Pushes the values in local.settings.json to the Function App's application
settings.

Values are handed to `az` through a temporary file rather than command-line
arguments, so they never appear in the process list, and nothing is echoed to
the terminal — only setting NAMES are printed.

AzureWebJobsStorage and FUNCTIONS_WORKER_RUNTIME are deliberately skipped:
Azure sets those when the Function App is created, and overwriting
AzureWebJobsStorage with the local development value would break the app.

Usage:
    python3 scripts/push-settings.py <resource-group> <function-app-name>
"""
import json
import os
import subprocess
import sys
import tempfile

SKIP = {"AzureWebJobsStorage", "FUNCTIONS_WORKER_RUNTIME"}
PLACEHOLDER_PREFIX = "<"

if len(sys.argv) != 3:
    sys.exit(__doc__)

resource_group, app_name = sys.argv[1], sys.argv[2]

project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
settings_path = os.path.join(project_root, "local.settings.json")
if not os.path.exists(settings_path):
    sys.exit(f"Missing {settings_path}")

values = json.load(open(settings_path, encoding="utf-8")).get("Values", {})

payload, skipped = [], []
for name, value in values.items():
    value = str(value)
    if name in SKIP:
        continue
    if not value or value.startswith(PLACEHOLDER_PREFIX):
        skipped.append(name)
        continue
    payload.append({"name": name, "value": value, "slotSetting": False})

if not payload:
    sys.exit("Nothing to push — every value is empty or still a placeholder.")

print("Pushing settings:", ", ".join(sorted(item["name"] for item in payload)))
if skipped:
    print("Skipped (unset or placeholder):", ", ".join(sorted(skipped)))

handle = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
try:
    json.dump(payload, handle)
    handle.close()
    result = subprocess.run(
        [
            "az", "functionapp", "config", "appsettings", "set",
            "--resource-group", resource_group,
            "--name", app_name,
            "--settings", f"@{handle.name}",
            "--output", "none",
        ],
        capture_output=True,
        text=True,
    )
finally:
    os.unlink(handle.name)

if result.returncode != 0:
    # az echoes the payload on some failures; show only the first line.
    sys.exit(f"az failed ({result.returncode}): {result.stderr.strip().splitlines()[:1]}")

print(f"Applied {len(payload)} setting(s) to {app_name}.")
