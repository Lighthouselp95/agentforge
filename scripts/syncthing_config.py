"""Configure Syncthing for opencode sync via REST API"""
import json
import urllib.request
import os

API_KEY = "3ADTMoZgDJEGcWM7uSUmzCbowcw6fmfe"
BASE = "http://127.0.0.1:8384"
REMOTE_DEVICE_ID = "I6NHULL-36HZWWM-YDRMGJO-UDMMX22-GISRVA5-CQEGABA-J342J7Z-2PVGVQ6"
REMOTE_ADDR = "tcp://192.168.3.15:22000"
USER = os.path.expanduser('~')

def api(method, path, data=None):
    url = f"{BASE}{path}"
    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("X-API-Key", API_KEY)
    if body:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read()) if resp.read else {}
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        print(f"  Error {e.code}: {body[:200]}")
        return None

# 1. Add remote device
print("=== 1. Adding remote device ===")
result = api("PUT", f"/rest/config/devices/{REMOTE_DEVICE_ID}", {
    "deviceID": REMOTE_DEVICE_ID,
    "name": "Desktop-1ik02mt",
    "addresses": [REMOTE_ADDR],
})
print(f"  Result: {result}")

# 2. Add sync folder for .config/opencode
print("\n=== 2. Adding folder: opencode-config ===")
config_path = os.path.join(USER, '.config', 'opencode')
result = api("PUT", "/rest/config/folders/opencode-config", {
    "id": "opencode-config",
    "label": "opencode-config",
    "path": config_path.replace("\\", "/"),
    "type": "sendreceive",
    "fs": {"caseSensitiveNames": False},
    "devices": [
        {"deviceID": "F6SETC4-SLED6OL-CPWSSPD-M5T4KH7-KRCCDZR-DEBTQ6I-KRQSQUF-UIEQOA3"},
        {"deviceID": REMOTE_DEVICE_ID},
    ],
    "rescanIntervalS": 60,
    "fsWatcherEnabled": True,
    "fsWatcherDelayS": 1,
    "ignorePerms": False,
    "autoNormalize": True,
    "versioning": {"type": ""},
})
print(f"  Result: {result}")

# 3. Add sync folder for .local/share/opencode
print("\n=== 3. Adding folder: opencode-data ===")
share_path = os.path.join(USER, '.local', 'share', 'opencode')
result = api("PUT", "/rest/config/folders/opencode-data", {
    "id": "opencode-data",
    "label": "opencode-data",
    "path": share_path.replace("\\", "/"),
    "type": "sendreceive",
    "fs": {"caseSensitiveNames": False},
    "devices": [
        {"deviceID": "F6SETC4-SLED6OL-CPWSSPD-M5T4KH7-KRCCDZR-DEBTQ6I-KRQSQUF-UIEQOA3"},
        {"deviceID": REMOTE_DEVICE_ID},
    ],
    "rescanIntervalS": 300,
    "fsWatcherEnabled": True,
    "fsWatcherDelayS": 5,
    "ignorePerms": False,
    "autoNormalize": True,
    "versioning": {"type": ""},
    "ignoreDelete": False,
    # Exclude large temp files
    "ignorePatterns": [
        {"pattern": "log/**"},
        {"pattern": "tool-output/**"},
        {"pattern": "snapshot/**"},
        {"pattern": "repos/**"},
        {"pattern": "*.bak*"},
        {"pattern": "opencode.db-shm"},
    ],
})
print(f"  Result: {result}")

# 4. Restart to apply
print("\n=== 4. Restarting Syncthing ===")
result = api("POST", "/rest/system/restart", {})
print(f"  Restarted")

print("\n=== DONE ===")
print(f"Remote device: Desktop-1ik02mt ({REMOTE_DEVICE_ID[:20]}...)")
print(f"Folder 1: opencode-config -> {config_path}")
print(f"Folder 2: opencode-data -> {share_path}")
