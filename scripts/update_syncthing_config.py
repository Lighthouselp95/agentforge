"""Edit Syncthing config.xml to add remote device and sync folders"""
import xml.etree.ElementTree as ET
import os, shutil

CONFIG = os.path.expanduser('~/AppData/Local/Syncthing/config.xml')
REMOTE_ID = 'I6NHULL-36HZWWM-YDRMGJO-UDMMX22-GISRVA5-CQEGABA-J342J7Z-2PVGVQ6'
LOCAL_ID = 'F6SETC4-SLED6OL-CPWSSPD-M5T4KH7-KRCCDZR-DEBTQ6I-KRQSQUF-UIEQOA3'

# Backup
shutil.copy2(CONFIG, CONFIG + '.bak')

# Parse
tree = ET.parse(CONFIG)
root = tree.getroot()

# 1. Add remote device
remote_device = ET.SubElement(root, 'device')
remote_device.set('id', REMOTE_ID)
remote_device.set('name', 'Desktop-1ik02mt')
remote_device.set('compression', 'metadata')
remote_device.set('introducer', 'false')
remote_device.set('skipIntroductionRemovals', 'false')
remote_device.set('introducedBy', '')
addr = ET.SubElement(remote_device, 'address')
addr.text = 'tcp://100.82.72.66:22000'
for tag, val in [('paused','false'),('autoAcceptFolders','true'),('maxSendKbps','0'),('maxRecvKbps','0'),('maxRequestKiB','0'),('untrusted','false'),('remoteGUIPort','0'),('numConnections','0')]:
    el = ET.SubElement(remote_device, tag)
    el.text = val

# 2. Add folder: opencode-config
def add_folder(folder_id, label, path, devices, ignore_patterns=None):
    folder = ET.SubElement(root, 'folder')
    folder.set('id', folder_id)
    folder.set('label', label)
    folder.set('path', path)
    folder.set('type', 'sendreceive')
    folder.set('rescanIntervalS', '60')
    folder.set('fsWatcherEnabled', 'true')
    folder.set('fsWatcherDelayS', '1')
    folder.set('fsWatcherTimeoutS', '0')
    folder.set('ignorePerms', 'true')
    folder.set('autoNormalize', 'true')
    folder.set('paused', 'false')
    folder.set('caseSensitiveFS', 'false')
    
    fst = ET.SubElement(folder, 'filesystemType')
    fst.text = 'basic'
    
    for dev_id in devices:
        dev = ET.SubElement(folder, 'device')
        dev.set('id', dev_id)
        dev.set('introducedBy', '')
        enc = ET.SubElement(dev, 'encryptionPassword')
        enc.text = ''
    
    mdf = ET.SubElement(folder, 'minDiskFree')
    mdf.set('unit', '%')
    mdf.text = '1'
    
    ver = ET.SubElement(folder, 'versioning')
    ver.set('cleanupIntervalS', '3600')
    ET.SubElement(ver, 'fsPath').text = ''
    ET.SubElement(ver, 'fsType').text = 'basic'
    
    for tag, val in [('copiers','0'),('pullerMaxPendingKiB','0'),('hashers','0'),('order','random'),('ignoreDelete','false'),('scanProgressIntervalS','0'),('pullerPauseS','0'),('pullerDelayS','1'),('maxConflicts','10'),('markerName','.stfolder')]:
        el = ET.SubElement(folder, tag)
        el.text = val
    
    if ignore_patterns:
        ignores = ET.SubElement(folder, 'ignore')
        for pat in ignore_patterns:
            line = ET.SubElement(ignores, 'line')
            line.text = pat

add_folder('opencode-config', 'opencode-config',
    'C:/Users/Hai Dang/.config/opencode',
    [LOCAL_ID, REMOTE_ID])

add_folder('opencode-data', 'opencode-data',
    'C:/Users/Hai Dang/.local/share/opencode',
    [LOCAL_ID, REMOTE_ID],
    ignore_patterns=[
        'log/**',
        'tool-output/**',
        'snapshot/**',
        'repos/**',
        '*.bak*',
    ])

# 3. Disable TLS for easier local access
gui = root.find('gui')
if gui is not None:
    gui.set('tls', 'false')

# Write back
ET.indent(tree, space='    ')
tree.write(CONFIG, xml_declaration=True, encoding='UTF-8')
print('Config updated!')
print('  + Device: Desktop-1ik02mt')
print('  + Folder: opencode-config')
print('  + Folder: opencode-data')
print('  + TLS: disabled (HTTP)')
