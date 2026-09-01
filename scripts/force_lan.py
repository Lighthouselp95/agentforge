"""Force Syncthing to use LAN IP for remote device on BOTH machines"""
import os
import time
import subprocess
from smb.SMBConnection import SMBConnection
import io
import xml.etree.ElementTree as ET

REMOTE_ID = 'I6NHULL-36HZWWM-YDRMGJO-UDMMX22-GISRVA5-CQEGABA-J342J7Z-2PVGVQ6'
LOCAL_ID = 'F6SETC4-SLED6OL-CPWSSPD-M5T4KH7-KRCCDZR-DEBTQ6I-KRQSQUF-UIEQOA3'
REMOTE_LAN = 'tcp://192.168.3.15:22000'
LOCAL_LAN = 'tcp://192.168.3.14:22000'

# Step 1: Stop local Syncthing
print('=== Stopping local Syncthing ===')
subprocess.run(['powershell', '-Command', 'Stop-Process -Name syncthing -Force -ErrorAction SilentlyContinue'], capture_output=True, timeout=10)
time.sleep(3)

# Step 2: Edit local config.xml - set remote device address to LAN
local_config = os.path.expanduser('~/AppData/Local/Syncthing/config.xml')
with open(local_config, 'r', encoding='utf-8') as f:
    config = f.read()

# Find the remote device block and update address
import re
# Replace <address>dynamic</address> inside the remote device block
old_block = f'<device id="{REMOTE_ID}"'
# Simple approach: replace all <address>dynamic</address> for remote device
# Find the device block for remote
pattern = rf'(<device id="{REMOTE_ID}"[^>]*>.*?<address>)(.*?)(</address>)'
match = re.search(pattern, config, re.DOTALL)
if match:
    old_addr = match.group(2)
    config = config[:match.start(2)] + REMOTE_LAN + config[match.end(2):]
    print(f'Local: changed remote address from "{old_addr}" to "{REMOTE_LAN}"')
else:
    print('Local: remote device address not found')

ET.fromstring(config)
with open(local_config, 'w', encoding='utf-8') as f:
    f.write(config)
print('Local config saved')

# Step 3: Edit remote config.xml via SMB
print('\n=== Updating remote config ===')
conn = SMBConnection('DANG', 'a', 'thispc', 'Desktop-1ik02mt', use_ntlm_v2=True, is_direct_tcp=True)
if not conn.connect('192.168.3.15', 445, timeout=10):
    print('SMB FAILED')
    exit(1)
print('SMB Connected!')

f = io.BytesIO()
size, _ = conn.retrieveFile('C', '/Users/Dang/AppData/Local/Syncthing/config.xml', f)
rconfig = f.getvalue().decode('utf-8')
print(f'Remote config loaded: {size} bytes')

# Update local device address in remote config to LAN
pattern = rf'(<device id="{LOCAL_ID}"[^>]*>.*?<address>)(.*?)(</address>)'
match = re.search(pattern, rconfig, re.DOTALL)
if match:
    old_addr = match.group(2)
    rconfig = rconfig[:match.start(2)] + LOCAL_LAN + rconfig[match.end(2):]
    print(f'Remote: changed local address from "{old_addr}" to "{LOCAL_LAN}"')
else:
    print('Remote: local device address not found')

ET.fromstring(rconfig)
conn.storeFile('C', '/Users/Dang/AppData/Local/Syncthing/config.xml', io.BytesIO(rconfig.encode('utf-8')))
print('Remote config saved')

# Delete lock files
try:
    os.remove(os.path.expanduser('~/AppData/Local/Syncthing/syncthing.lock'))
except:
    pass

conn.close()

# Step 4: Restart local Syncthing
print('\n=== Starting local Syncthing ===')
subprocess.run(['powershell', '-Command', 'Start-Process syncthing -ArgumentList "serve" -WindowStyle Hidden'], capture_output=True, timeout=10)
print('Local Syncthing started')

print('\n=== DONE ===')
print('Both configs updated to use LAN IPs:')
print(f'  Local -> Remote: {REMOTE_LAN}')
print(f'  Remote -> Local: {LOCAL_LAN}')
print('Restart Syncthing on remote machine now!')
