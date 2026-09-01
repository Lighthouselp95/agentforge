"""Configure Syncthing on remote machine via SMB"""
from smb.SMBConnection import SMBConnection
import io, re, os, time

IP = '192.168.3.15'
USER = 'DANG'
PWD = 'a'
SERVER = 'Desktop-1ik02mt'
LOCAL_API = '3ADTMoZgDJEGcWM7uSUmzCbowcw6fmfe'
LOCAL_DEVICE_ID = 'F6SETC4-SLED6OL-CPWSSPD-M5T4KH7-KRCCDZR-DEBTQ6I-KRQSQUF-UIEQOA3'

conn = SMBConnection(USER, PWD, 'thispc', SERVER, use_ntlm_v2=True, is_direct_tcp=True)
if not conn.connect(IP, 445, timeout=10):
    print('SMB FAILED')
    exit(1)
print('SMB Connected!')

# Find remote user
remote_user = None
for e in conn.listPath('C', '/Users'):
    if e.filename not in ('.', '..', 'Public', 'Default', 'Default User', 'All Users') and e.isDirectory:
        remote_user = e.filename
        break
print(f'Remote user: {remote_user}')

# Read Syncthing config
st_path = f'/Users/{remote_user}/AppData/Local/Syncthing/config.xml'
f = io.BytesIO()
size, _ = conn.retrieveFile('C', st_path, f)
config = f.getvalue().decode('utf-8')
print(f'Config loaded ({size} bytes)')

# Extract current values
api_match = re.search(r'<apikey>(.*?)</apikey>', config)
device_match = re.search(r'device id="(.*?)"', config)
remote_device_id = device_match.group(1) if device_match else 'UNKNOWN'
print(f'Remote device ID: {remote_device_id[:30]}...')

# Backup original
backup_path = f'/Users/{remote_user}/AppData/Local/Syncthing/config.xml.bak'
conn.storeFile('C', backup_path, io.BytesIO(config.encode('utf-8')))
print('Backup created')

# Fix: remove all stale devices except default and remote
# Remove <device id="I6NHULL..." .../> lines (self-reference from old config)
config = re.sub(r'<device id="I6NHULL-[^"]*"[^/]*/>\s*', '', config)

# Remove stale <folder> blocks and rebuild
config = re.sub(r'<folder id="opencode-[^"]*"[^>]*>.*?</folder>', '', config, flags=re.DOTALL)

# Remove empty <folderIgnored>` etc
config = re.sub(r'<folderIgnored[^/]*/>', '', config)

# Now add the correct folder entries before </configuration>
folders_xml = f'''
  <folder id="opencode-config" label="opencode-config" path="C:\\Users\\{remote_user}\\.config\\opencode" type="sendreceive" rescanIntervalS="60" fsWatcherEnabled="true" fsWatcherDelayS="1" ignorePerms="true">
    <device id="{remote_device_id}" introducedBy=""/>
    <device id="{LOCAL_DEVICE_ID}" introducedBy="{remote_device_id}"/>
    <versioning>
      <cleaner></cleaner>
      <params></params>
      <type></type>
    </versioning>
    <minDiskFree>
      <value>0</value>
      <unit>%</unit>
    </minDiskFree>
  </folder>
  <folder id="opencode-data" label="opencode-data" path="C:\\Users\\{remote_user}\\.local\\share\\opencode" type="sendreceive" rescanIntervalS="60" fsWatcherEnabled="true" fsWatcherDelayS="1" ignorePerms="true">
    <device id="{remote_device_id}" introducedBy=""/>
    <device id="{LOCAL_DEVICE_ID}" introducedBy="{remote_device_id}"/>
    <versioning>
      <cleaner></cleaner>
      <params></params>
      <type></type>
    </versioning>
    <minDiskFree>
      <value>0</value>
      <unit>%</unit>
    </minDiskFree>
  </folder>'''

config = config.replace('</configuration>', folders_xml + '\n</configuration>')

# Also add remote device if not present
if LOCAL_DEVICE_ID[:10] not in config:
    device_xml = f'  <device id="{LOCAL_DEVICE_ID}" name="DESKTOP-GSFUM4A" addresses="dynamic" compression="metadata" paused="false" autoAcceptFolders="false" maxRecvBps="0" maxSendBps="0" untrusted=false>\n    <address>dynamic</address>\n  </device>'
    config = config.replace('</configuration>', device_xml + '\n</configuration>')
    print('Added local device to remote config')

# Write back
conn.storeFile('C', st_path, io.BytesIO(config.encode('utf-8')))
print('Config updated!')

# Create opencode directories on remote
for sub in ['.config/opencode', '.config/opencode/plugins', '.config/opencode/age',
            '.local/share/opencode', '.local/share/opencode/storage', '.local/state/opencode']:
    try:
        conn.createDirectory('C', f'/Users/{remote_user}/{sub}')
    except:
        pass
print('Directories ensured')

conn.close()
print('\nDone! Restart Syncthing on remote machine.')
print(f'  SMB path: \\\\{IP}\\C\\Users\\{remote_user}\\AppData\\Local\\Syncthing\\')
