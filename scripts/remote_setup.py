"""Auto-configure Syncthing on remote machine 192.168.3.15 via SMB"""
from smb.SMBConnection import SMBConnection
import os, io

IP = '192.168.3.15'
USER = 'DANG'
PWD = 'abc123'
SERVER = 'Desktop-1ik02mt'

conn = SMBConnection(USER, PWD, 'thispc', SERVER, use_ntlm_v2=True, is_direct_tcp=True)
conn.connect(IP, 445, timeout=15)
print('Connected!')

# Find user on remote machine
print('\n=== Finding remote user ===')
entries = conn.listPath('C', '/Users')
remote_user = None
for e in entries:
    if e.filename not in ('.', '..') and e.isDirectory:
        print(f'  {e.filename}')
        if e.filename not in ('Public', 'Default', 'Default User', 'All Users'):
            remote_user = e.filename
print(f'Target: {remote_user}')

# Check if opencode exists
print('\n=== Checking opencode dirs ===')
for sub in ['.config/opencode', '.local/share/opencode', '.local/state/opencode']:
    path = f'/Users/{remote_user}/{sub}'
    try:
        items = conn.listPath('C', path)
        count = len([i for i in items if i.filename not in ('.', '..')])
        print(f'  EXISTS: {sub} ({count} items)')
    except:
        print(f'  MISSING: {sub}')

# Create necessary dirs
print('\n=== Creating directories ===')
dirs_to_create = [
    f'/Users/{remote_user}/.config/opencode',
    f'/Users/{remote_user}/.config/opencode/plugins',
    f'/Users/{remote_user}/.config/opencode/age',
    f'/Users/{remote_user}/.local/share/opencode',
    f'/Users/{remote_user}/.local/share/opencode/storage',
    f'/Users/{remote_user}/.local/state/opencode',
]
for d in dirs_to_create:
    try:
        conn.createDirectory('C', d)
        print(f'  Created: {d}')
    except:
        pass  # Already exists

# Download opencode config from this machine
local_config = os.path.expanduser('~/.config/opencode/opencode.jsonc')
local_auth = os.path.expanduser('~/.local/share/opencode/auth.json')

print('\n=== Uploading opencode.jsonc ===')
try:
    with open(local_config, 'rb') as f:
        remote_path = f'/Users/{remote_user}/.config/opencode/opencode.jsonc'
        conn.storeFile('C', remote_path, f)
        size = os.path.getsize(local_config)
        print(f'  Uploaded: {remote_path} ({size/(1024*1024):.1f}MB)')
except Exception as e:
    print(f'  ERROR: {e}')

print('\n=== Uploading auth.json ===')
try:
    with open(local_auth, 'rb') as f:
        remote_path = f'/Users/{remote_user}/.local/share/opencode/auth.json'
        conn.storeFile('C', remote_path, f)
        size = os.path.getsize(local_auth)
        print(f'  Uploaded: {remote_path} ({size/1024:.1f}KB)')
except Exception as e:
    print(f'  ERROR: {e}')

# Find Syncthing config path and check
print('\n=== Checking Syncthing on remote ===')
st_config_paths = [
    f'/Users/{remote_user}/AppData/Local/Syncthing/config.xml',
]
for p in st_config_paths:
    try:
        f = io.BytesIO()
        size, _ = conn.retrieveFile('C', p, f)
        content = f.getvalue().decode('utf-8')
        # Extract API key
        import re
        api_match = re.search(r'<apikey>(.*?)</apikey>', content)
        device_match = re.search(r'device id="(.*?)"', content)
        if api_match:
            print(f'  Syncthing API Key: {api_match.group(1)}')
        if device_match:
            print(f'  Device ID: {device_match.group(1)}')
    except Exception as e:
        print(f'  {p}: {e}')

conn.close()
print('\n=== DONE ===')
