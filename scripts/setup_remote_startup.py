"""Setup Syncthing auto-start on remote machine via SMB"""
from smb.SMBConnection import SMBConnection
import io

conn = SMBConnection('DANG', 'a', 'thispc', 'Desktop-1ik02mt', use_ntlm_v2=True, is_direct_tcp=True)
conn.connect('192.168.3.15', 445, timeout=10)
print('SMB Connected!')

# Find syncthing exe path on remote
import io
try:
    f = io.BytesIO()
    # Check common paths
    for path in [
        '/Users/Dang/AppData/Local/Microsoft/WinGet/Links/syncthing.exe',
        '/Users/Dang/AppData/Local/Syncthing/syncthing.exe',
    ]:
        try:
            info = conn.getAttributes('C', path)
            print(f'Found: {path} ({info.file_size} bytes)')
        except:
            pass
except:
    pass

# Write PowerShell setup script to Desktop
ps1_content = b'$stPath = "C:\\Users\\Dang\\AppData\\Local\\Microsoft\\WinGet\\Links\\syncthing.exe"\r\n'
ps1_content += b'if (!(Test-Path $stPath)) { $stPath = "C:\\Users\\Dang\\AppData\\Local\\Syncthing\\syncthing.exe" }\r\n'
ps1_content += b'if (!(Test-Path $stPath)) { $stPath = (Get-Command syncthing -ErrorAction SilentlyContinue).Source }\r\n'
ps1_content += b'if (!(Test-Path $stPath)) { Write-Host "Syncthing not found!"; exit 1 }\r\n'
ps1_content += b'Write-Host "Syncthing: $stPath"\r\n'
ps1_content += b'schtasks /create /tn "Syncthing" /tr "`"$stPath`" serve" /sc onlogon /rl limited /f\r\n'
ps1_content += b'Write-Host "Startup task created!"\r\n'

conn.storeFile('C', '/Users/Dang/Desktop/setup_syncthing_startup.ps1', io.BytesIO(ps1_content))
print('Written: Desktop/setup_syncthing_startup.ps1')

conn.close()
print('Done! Run on remote: powershell -ExecutionPolicy Bypass Desktop\\setup_syncthing_startup.ps1')
