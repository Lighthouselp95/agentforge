"""Check remote machine user profiles and opencode directories"""
from smb.SMBConnection import SMBConnection

IP = '192.168.3.15'
USER = 'DANG'
PWD = 'a'
SERVER = 'Desktop-1ik02mt'

conn = SMBConnection(USER, PWD, 'thispc', SERVER, use_ntlm_v2=True, is_direct_tcp=True)
conn.connect(IP, 445, timeout=10)
print('Connected!')

# List Users directory on C drive  
print('\n=== C: root ===')
entries = conn.listPath('C', '/')
for e in entries:
    if e.filename not in ('.', '..'):
        tag = '[DIR]' if e.isDirectory else '[FILE]'
        print(f'  {tag} {e.filename}')

# Try listing Users
print('\n=== C:\\Users ===')
try:
    entries = conn.listPath('C', '/Users')
    for e in entries:
        if e.filename not in ('.', '..'):
            tag = '[DIR]' if e.isDirectory else '[FILE]'
            print(f'  {tag} {e.filename}')
except Exception as ex:
    print(f'  Error: {ex}')
    # Try Windows-style path
    try:
        entries = conn.listPath('C', 'Users')
        for e in entries:
            if e.filename not in ('.', '..'):
                tag = '[DIR]' if e.isDirectory else '[FILE]'
                print(f'  {tag} {e.filename}')
    except Exception as ex2:
        print(f'  Error2: {ex2}')

# Check each user for opencode dirs
try:
    users_entries = conn.listPath('C', '/Users')
except:
    users_entries = conn.listPath('C', 'Users')

for e in users_entries:
    if e.filename in ('.', '..') or not e.isDirectory:
        continue
    user = e.filename
    for subdir in ['/.config/opencode', '/.local/share/opencode', '/.local/state/opencode']:
        path = f'/Users/{user}{subdir}'
        try:
            items = conn.listPath('C', path)
            files = [i.filename for i in items if i.filename not in ('.', '..')]
            print(f'\n  C:{path}: {len(files)} items')
            for f in files[:10]:
                print(f'    {f}')
            if len(files) > 10:
                print(f'    ... and {len(files)-10} more')
        except:
            pass

conn.close()
