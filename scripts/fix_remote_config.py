"""Fix Syncthing config.xml on remote machine - write clean XML via SMB"""
from smb.SMBConnection import SMBConnection
import io
import xml.etree.ElementTree as ET

IP = '192.168.3.15'
USER = 'DANG'
PWD = 'a'
SERVER = 'Desktop-1ik02mt'
LOCAL_DEVICE_ID = 'F6SETC4-SLED6OL-CPWSSPD-M5T4KH7-KRCCDZR-DEBTQ6I-KRQSQUF-UIEQOA3'
REMOTE_DEVICE_ID = 'I6NHULL-36HZWWM-YDRMGJO-UDMMX22-GISRVA5-CQEGABA-J342J7Z-2PVGVQ6'

conn = SMBConnection(USER, PWD, 'thispc', SERVER, use_ntlm_v2=True, is_direct_tcp=True)
if not conn.connect(IP, 445, timeout=10):
    print('FAILED')
    exit(1)
print('Connected!')

# Read current config to extract API key and unique settings
f = io.BytesIO()
size, _ = conn.retrieveFile('C', '/Users/Dang/AppData/Local/Syncthing/config.xml', f)
current = f.getvalue().decode('utf-8')

import re
api_match = re.search(r'<apikey>(.*?)</apikey>', current)
apikey = api_match.group(1) if api_match else 'kmi3psfKhhb9XVVno7H6ZcrUYdT3CCjX'
print(f'API Key: {apikey}')

# Build clean config - using simple string, no triple quotes with backslashes
lines = []
lines.append('<?xml version="1.0" encoding="UTF-8"?>')
lines.append('<configuration version="38">')

# Folder: opencode-config
lines.append('    <folder id="opencode-config" label="opencode-config" path="C:\\Users\\Dang\\.config\\opencode" type="sendreceive" rescanIntervalS="3600" fsWatcherEnabled="true" fsWatcherDelayS="10" ignorePerms="false" autoNormalize="true">')
lines.append('        <filesystemType>basic</filesystemType>')
lines.append('        <device id="' + REMOTE_DEVICE_ID + '" introducedBy=""><encryptionPassword></encryptionPassword></device>')
lines.append('        <device id="' + LOCAL_DEVICE_ID + '" introducedBy=""><encryptionPassword></encryptionPassword></device>')
lines.append('        <minDiskFree unit="%">1</minDiskFree>')
lines.append('        <versioning><cleanupIntervalS>3600</cleanupIntervalS><fsPath></fsPath><fsType>basic</fsType></versioning>')
lines.append('        <copiers>0</copiers><pullerMaxPendingKiB>0</pullerMaxPendingKiB><hashers>0</hashers>')
lines.append('        <order>random</order><ignoreDelete>false</ignoreDelete>')
lines.append('        <scanProgressIntervalS>0</scanProgressIntervalS><pullerPauseS>0</pullerPauseS><pullerDelayS>1</pullerDelayS>')
lines.append('        <maxConflicts>10</maxConflicts><disableSparseFiles>false</disableSparseFiles>')
lines.append('        <paused>false</paused><markerName>.stfolder</markerName>')
lines.append('        <copyOwnershipFromParent>false</copyOwnershipFromParent>')
lines.append('        <modTimeWindowS>0</modTimeWindowS><maxConcurrentWrites>16</maxConcurrentWrites>')
lines.append('        <disableFsync>false</disableFsync><blockPullOrder>standard</blockPullOrder>')
lines.append('        <copyRangeMethod>standard</copyRangeMethod><caseSensitiveFS>false</caseSensitiveFS>')
lines.append('        <junctionsAsDirs>false</junctionsAsDirs>')
lines.append('        <syncOwnership>false</syncOwnership><sendOwnership>false</sendOwnership>')
lines.append('        <syncXattrs>false</syncXattrs><sendXattrs>false</sendXattrs><blockIndexing>true</blockIndexing>')
lines.append('        <xattrFilter><maxSingleEntrySize>1024</maxSingleEntrySize><maxTotalSize>4096</maxTotalSize></xattrFilter>')
lines.append('    </folder>')

# Folder: opencode-data
lines.append('    <folder id="opencode-data" label="opencode-data" path="C:\\Users\\Dang\\.local\\share\\opencode" type="sendreceive" rescanIntervalS="3600" fsWatcherEnabled="true" fsWatcherDelayS="10" ignorePerms="false" autoNormalize="true">')
lines.append('        <filesystemType>basic</filesystemType>')
lines.append('        <device id="' + REMOTE_DEVICE_ID + '" introducedBy=""><encryptionPassword></encryptionPassword></device>')
lines.append('        <device id="' + LOCAL_DEVICE_ID + '" introducedBy=""><encryptionPassword></encryptionPassword></device>')
lines.append('        <minDiskFree unit="%">1</minDiskFree>')
lines.append('        <versioning><cleanupIntervalS>3600</cleanupIntervalS><fsPath></fsPath><fsType>basic</fsType></versioning>')
lines.append('        <copiers>0</copiers><pullerMaxPendingKiB>0</pullerMaxPendingKiB><hashers>0</hashers>')
lines.append('        <order>random</order><ignoreDelete>false</ignoreDelete>')
lines.append('        <scanProgressIntervalS>0</scanProgressIntervalS><pullerPauseS>0</pullerPauseS><pullerDelayS>1</pullerDelayS>')
lines.append('        <maxConflicts>10</maxConflicts><disableSparseFiles>false</disableSparseFiles>')
lines.append('        <paused>false</paused><markerName>.stfolder</markerName>')
lines.append('        <copyOwnershipFromParent>false</copyOwnershipFromParent>')
lines.append('        <modTimeWindowS>0</modTimeWindowS><maxConcurrentWrites>16</maxConcurrentWrites>')
lines.append('        <disableFsync>false</disableFsync><blockPullOrder>standard</blockPullOrder>')
lines.append('        <copyRangeMethod>standard</copyRangeMethod><caseSensitiveFS>false</caseSensitiveFS>')
lines.append('        <junctionsAsDirs>false</junctionsAsDirs>')
lines.append('        <syncOwnership>false</syncOwnership><sendOwnership>false</sendOwnership>')
lines.append('        <syncXattrs>false</syncXattrs><sendXattrs>false</sendXattrs><blockIndexing>true</blockIndexing>')
lines.append('        <xattrFilter><maxSingleEntrySize>1024</maxSingleEntrySize><maxTotalSize>4096</maxTotalSize></xattrFilter>')
lines.append('    </folder>')

# Devices
lines.append('    <device id="' + LOCAL_DEVICE_ID + '" name="DESKTOP-GSFUM4A" compression="metadata" introducer="false" skipIntroductionRemovals="false" introducedBy="">')
lines.append('        <address>dynamic</address>')
lines.append('    </device>')
lines.append('    <device id="' + REMOTE_DEVICE_ID + '" name="DESKTOP-1IK02MT" compression="metadata" introducer="false" skipIntroductionRemovals="false" introducedBy="">')
lines.append('        <address>dynamic</address>')
lines.append('    </device>')

# GUI
lines.append('    <gui enabled="true" tls="false" sendBasicAuthPrompt="false">')
lines.append('        <address>127.0.0.1:8384</address>')
lines.append('        <metricsWithoutAuth>false</metricsWithoutAuth>')
lines.append('        <apikey>' + apikey + '</apikey>')
lines.append('        <theme>default</theme>')
lines.append('    </gui>')
lines.append('    <ldap></ldap>')

# Options
lines.append('    <options>')
for opt in [
    ('listenAddress', 'default'), ('globalAnnounceServer', 'default'),
    ('globalAnnounceEnabled', 'true'), ('localAnnounceEnabled', 'true'),
    ('localAnnouncePort', '21027'), ('localAnnounceMCAddr', '[ff12::8384]:21027'),
    ('maxSendKbps', '0'), ('maxRecvKbps', '0'), ('reconnectionIntervalS', '20'),
    ('relaysEnabled', 'true'), ('relayReconnectIntervalM', '10'),
    ('startBrowser', 'true'), ('natEnabled', 'true'),
    ('natLeaseMinutes', '60'), ('natRenewalMinutes', '30'), ('natTimeoutSeconds', '10'),
    ('urAccepted', '3'), ('urSeen', '3'), ('urUniqueID', 'K2buwCNW'),
    ('urURL', 'https://data.syncthing.net/newdata'), ('urPostInsecurely', 'false'),
    ('urInitialDelayS', '1800'), ('autoUpgradeIntervalH', '12'),
    ('upgradeToPreReleases', 'false'), ('keepTemporariesH', '24'),
    ('progressUpdateIntervalS', '5'), ('limitBandwidthInLan', 'false'),
]:
    lines.append('        <' + opt[0] + '>' + opt[1] + '</' + opt[0] + '>')
# minHomeDiskFree needs attribute
lines.append('        <minHomeDiskFree unit="%">1</minHomeDiskFree>')
for opt in [
    ('releasesURL', 'https://upgrades.syncthing.net/meta.json'),
    ('overwriteRemoteDeviceNamesOnConnect', 'false'),
    ('tempIndexMinBlocks', '10'),
    ('unackedNotificationID', 'authenticationUserAndPassword'),
    ('trafficClass', '0'), ('setLowPriority', 'true'),
    ('maxFolderConcurrency', '0'),
    ('crashReportingURL', 'https://crash.syncthing.net/newcrash'),
    ('crashReportingEnabled', 'true'),
    ('stunKeepaliveStartS', '180'), ('stunKeepaliveMinS', '20'),
    ('stunServer', 'default'),
    ('maxConcurrentIncomingRequestKiB', '0'),
    ('announceLANAddresses', 'true'), ('sendFullIndexOnUpgrade', 'false'),
    ('auditEnabled', 'false'), ('auditFile', ''),
    ('connectionLimitEnough', '0'), ('connectionLimitMax', '0'),
    ('connectionPriorityTcpLan', '10'), ('connectionPriorityQuicLan', '20'),
    ('connectionPriorityTcpWan', '30'), ('connectionPriorityQuicWan', '40'),
    ('connectionPriorityRelay', '50'), ('connectionPriorityUpgradeThreshold', '0'),
]:
    lines.append('        <' + opt[0] + '>' + opt[1] + '</' + opt[0] + '>')
lines.append('    </options>')

# Defaults
lines.append('    <defaults>')
lines.append('        <folder id="" label="" path="" type="sendreceive" rescanIntervalS="3600" fsWatcherEnabled="true" fsWatcherDelayS="10" fsWatcherTimeoutS="0" ignorePerms="false" autoNormalize="true">')
lines.append('            <filesystemType>basic</filesystemType>')
lines.append('            <device id="' + REMOTE_DEVICE_ID + '" introducedBy=""><encryptionPassword></encryptionPassword></device>')
lines.append('            <minDiskFree unit="%">1</minDiskFree>')
lines.append('            <versioning><cleanupIntervalS>3600</cleanupIntervalS><fsPath></fsPath><fsType>basic</fsType></versioning>')
lines.append('            <copiers>0</copiers><pullerMaxPendingKiB>0</pullerMaxPendingKiB><hashers>0</hashers>')
lines.append('            <order>random</order><ignoreDelete>false</ignoreDelete>')
lines.append('            <scanProgressIntervalS>0</scanProgressIntervalS><pullerPauseS>0</pullerPauseS><pullerDelayS>1</pullerDelayS>')
lines.append('            <maxConflicts>10</maxConflicts><disableSparseFiles>false</disableSparseFiles>')
lines.append('            <paused>false</paused><markerName>.stfolder</markerName>')
lines.append('            <copyOwnershipFromParent>false</copyOwnershipFromParent>')
lines.append('            <modTimeWindowS>0</modTimeWindowS><maxConcurrentWrites>16</maxConcurrentWrites>')
lines.append('            <disableFsync>false</disableFsync><blockPullOrder>standard</blockPullOrder>')
lines.append('            <copyRangeMethod>standard</copyRangeMethod><caseSensitiveFS>false</caseSensitiveFS>')
lines.append('            <junctionsAsDirs>false</junctionsAsDirs>')
lines.append('            <syncOwnership>false</syncOwnership><sendOwnership>false</sendOwnership>')
lines.append('            <syncXattrs>false</syncXattrs><sendXattrs>false</sendXattrs><blockIndexing>true</blockIndexing>')
lines.append('            <xattrFilter><maxSingleEntrySize>1024</maxSingleEntrySize><maxTotalSize>4096</maxTotalSize></xattrFilter>')
lines.append('        </folder>')
lines.append('        <device id="" compression="metadata" introducer="false" skipIntroductionRemovals="false" introducedBy="">')
lines.append('            <address>dynamic</address>')
lines.append('        </device>')
lines.append('        <ignores></ignores>')
lines.append('    </defaults>')
lines.append('</configuration>')

config = '\n'.join(lines)

# Validate XML
try:
    ET.fromstring(config)
    print(f'XML valid! ({len(config)} bytes)')
except ET.ParseError as e:
    print(f'XML INVALID: {e}')
    exit(1)

# Write config
config_path = '/Users/Dang/AppData/Local/Syncthing/config.xml'
conn.storeFile('C', config_path, io.BytesIO(config.encode('utf-8')))
print(f'Written to: {config_path}')

# Delete old lock
try:
    conn.deleteFiles('C', '/Users/Dang/AppData/Local/Syncthing/syncthing.lock')
    print('Deleted lock file')
except:
    pass

# Also ensure directories exist
for sub in ['.config/opencode', '.local/share/opencode', '.local/state/opencode']:
    try:
        conn.createDirectory('C', f'/Users/Dang/{sub}')
    except:
        pass

conn.close()
print('\nDone! Config is clean XML. Restart Syncthing on remote machine now.')
