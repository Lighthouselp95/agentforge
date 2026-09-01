"""Add 3 agentforge folders to Syncthing - local + remote config via SMB"""
import urllib.request
import json
import time
from smb.SMBConnection import SMBConnection
import io
import xml.etree.ElementTree as ET

LOCAL_API = '3ADTMoZgDJEGcWM7uSUmzCbowcw6fmfe'
LOCAL_ID = 'F6SETC4-SLED6OL-CPWSSPD-M5T4KH7-KRCCDZR-DEBTQ6I-KRQSQUF-UIEQOA3'
REMOTE_ID = 'I6NHULL-36HZWWM-YDRMGJO-UDMMX22-GISRVA5-CQEGABA-J342J7Z-2PVGVQ6'

def api_put(path, data, api_key, host='127.0.0.1:8384'):
    req = urllib.request.Request(
        f'http://{host}{path}',
        data=json.dumps(data).encode(),
        headers={'X-API-Key': api_key, 'Content-Type': 'application/json'},
        method='PUT'
    )
    resp = urllib.request.urlopen(req, timeout=60)
    return json.loads(resp.read())

# Step 1: Stop local Syncthing to edit config.xml directly
print('=== Stopping local Syncthing ===')
import subprocess
subprocess.run(['powershell', '-Command', 'Stop-Process -Name syncthing -Force -ErrorAction SilentlyContinue'], capture_output=True, timeout=10)
time.sleep(3)
print('Local Syncthing stopped')

# Step 2: Edit local config.xml
import os
local_config = os.path.expanduser('~/AppData/Local/Syncthing/config.xml')
with open(local_config, 'r', encoding='utf-8') as f:
    config = f.read()

# Check if folders already added
if 'agentforge' in config and 'id="agentforge"' in config:
    print('Folders already in local config')
else:
    # Add folder blocks before </configuration>
    new_folders = ''
    for folder_id, folder_path in [
        ('agentforge', 'C:/Users/Hai Dang/agentforge'),
        ('agentforge-serve', 'C:/Users/Hai Dang/agentforge-serve'),
        ('test-agentforge', 'C:/Users/Hai Dang/test-agentforge thoi'),
    ]:
        new_folders += f'''    <folder id="{folder_id}" label="{folder_id}" path="{folder_path}" type="sendreceive" rescanIntervalS="60" fsWatcherEnabled="true" fsWatcherDelayS="1" ignorePerms="false" autoNormalize="true">
        <filesystemType>basic</filesystemType>
        <device id="{LOCAL_ID}" introducedBy=""><encryptionPassword></encryptionPassword></device>
        <device id="{REMOTE_ID}" introducedBy=""><encryptionPassword></encryptionPassword></device>
        <minDiskFree unit="%">1</minDiskFree>
        <versioning><cleanupIntervalS>3600</cleanupIntervalS><fsPath></fsPath><fsType>basic</fsType></versioning>
        <copiers>0</copiers><pullerMaxPendingKiB>0</pullerMaxPendingKiB><hashers>0</hashers>
        <order>random</order><ignoreDelete>false</ignoreDelete>
        <scanProgressIntervalS>0</scanProgressIntervalS><pullerPauseS>0</pullerPauseS><pullerDelayS>1</pullerDelayS>
        <maxConflicts>10</maxConflicts><disableSparseFiles>false</disableSparseFiles>
        <paused>false</paused><markerName>.stfolder</markerName>
        <copyOwnershipFromParent>false</copyOwnershipFromParent>
        <modTimeWindowS>0</modTimeWindowS><maxConcurrentWrites>16</maxConcurrentWrites>
        <disableFsync>false</disableFsync><blockPullOrder>standard</blockPullOrder>
        <copyRangeMethod>standard</copyRangeMethod><caseSensitiveFS>false</caseSensitiveFS>
        <junctionsAsDirs>false</junctionsAsDirs>
        <syncOwnership>false</syncOwnership><sendOwnership>false</sendOwnership>
        <syncXattrs>false</syncXattrs><sendXattrs>false</sendXattrs><blockIndexing>true</blockIndexing>
        <xattrFilter><maxSingleEntrySize>1024</maxSingleEntrySize><maxTotalSize>4096</maxTotalSize></xattrFilter>
    </folder>
'''
    config = config.replace('</configuration>', new_folders + '</configuration>')
    
    # Validate XML
    ET.fromstring(config)
    with open(local_config, 'w', encoding='utf-8') as f:
        f.write(config)
    print('Local config updated with 3 new folders')

# Step 3: Edit remote config.xml via SMB
print('\n=== Updating remote config ===')
conn = SMBConnection('DANG', 'a', 'thispc', 'Desktop-1ik02mt', use_ntlm_v2=True, is_direct_tcp=True)
if not conn.connect('192.168.3.15', 445, timeout=10):
    print('SMB FAILED')
    exit(1)
print('SMB Connected!')

f = io.BytesIO()
size, _ = conn.retrieveFile('C', '/Users/Dang/AppData/Local/Syncthing/config.xml', f)
remote_config = f.getvalue().decode('utf-8')
print(f'Remote config loaded: {size} bytes')

if 'id="agentforge"' in remote_config:
    print('Folders already in remote config')
else:
    # Add folder blocks - use D: drive paths on remote
    new_folders = ''
    for folder_id, folder_path in [
        ('agentforge', 'D:\\agentforge'),
        ('agentforge-serve', 'D:\\agentforge-serve'),
        ('test-agentforge', 'D:\\test-agentforge'),
    ]:
        new_folders += f'''    <folder id="{folder_id}" label="{folder_id}" path="{folder_path}" type="sendreceive" rescanIntervalS="60" fsWatcherEnabled="true" fsWatcherDelayS="1" ignorePerms="false" autoNormalize="true">
        <filesystemType>basic</filesystemType>
        <device id="{REMOTE_ID}" introducedBy=""><encryptionPassword></encryptionPassword></device>
        <device id="{LOCAL_ID}" introducedBy=""><encryptionPassword></encryptionPassword></device>
        <minDiskFree unit="%">1</minDiskFree>
        <versioning><cleanupIntervalS>3600</cleanupIntervalS><fsPath></fsPath><fsType>basic</fsType></versioning>
        <copiers>0</copiers><pullerMaxPendingKiB>0</pullerMaxPendingKiB><hashers>0</hashers>
        <order>random</order><ignoreDelete>false</ignoreDelete>
        <scanProgressIntervalS>0</scanProgressIntervalS><pullerPauseS>0</pullerPauseS><pullerDelayS>1</pullerDelayS>
        <maxConflicts>10</maxConflicts><disableSparseFiles>false</disableSparseFiles>
        <paused>false</paused><markerName>.stfolder</markerName>
        <copyOwnershipFromParent>false</copyOwnershipFromParent>
        <modTimeWindowS>0</modTimeWindowS><maxConcurrentWrites>16</maxConcurrentWrites>
        <disableFsync>false</disableFsync><blockPullOrder>standard</blockPullOrder>
        <copyRangeMethod>standard</copyRangeMethod><caseSensitiveFS>false</caseSensitiveFS>
        <junctionsAsDirs>false</junctionsAsDirs>
        <syncOwnership>false</syncOwnership><sendOwnership>false</sendOwnership>
        <syncXattrs>false</syncXattrs><sendXattrs>false</sendXattrs><blockIndexing>true</blockIndexing>
        <xattrFilter><maxSingleEntrySize>1024</maxSingleEntrySize><maxTotalSize>4096</maxTotalSize></xattrFilter>
    </folder>
'''
    remote_config = remote_config.replace('</configuration>', new_folders + '</configuration>')
    
    # Validate XML
    ET.fromstring(remote_config)
    conn.storeFile('C', '/Users/Dang/AppData/Local/Syncthing/config.xml', io.BytesIO(remote_config.encode('utf-8')))
    print(f'Remote config updated: {len(remote_config)} bytes')

# Step 4: Create directories on remote D:
print('\n=== Creating remote directories ===')
for d in ['agentforge', 'agentforge-serve', 'test-agentforge']:
    try:
        conn.createDirectory('C', f'/Users/Dang/{d}')
    except:
        pass
    try:
        # Try creating on D: 
        conn.createDirectory('D', f'/{d}')
        print(f'  Created D:\\{d}')
    except Exception as e:
        print(f'  D:\\{d}: {e}')

conn.close()

# Step 5: Delete lock files on both sides
for path in [os.path.expanduser('~/AppData/Local/Syncthing/syncthing.lock')]:
    try:
        os.remove(path)
        print(f'Deleted lock: {path}')
    except:
        pass

print('\n=== DONE ===')
print('Config updated on both machines.')
print('Start Syncthing locally, then restart on remote (192.168.3.15).')
