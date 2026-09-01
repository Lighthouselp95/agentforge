"""Copy config/data from local opencode to remote 192.168.3.15 using smbprotocol"""
import os, uuid, shutil, time
from smbprotocol.connection import Connection
from smbprotocol.session import Session
from smbprotocol.tree import TreeConnect
from smbprotocol.open import Open, CreateDisposition, FileAttributes, CreateOptions, ImpersonationLevel

IP = '192.168.3.15'
USER = 'DANG'
PWD = 'a'
SHARE = rf'\\{IP}\C'

# Local opencode paths
LOCAL_CONFIG = os.path.expanduser('~/.config/opencode')
LOCAL_SHARE = os.path.expanduser('~/.local/share/opencode')
LOCAL_STATE = os.path.expanduser('~/.local/state/opencode')

# Remote user - need to find it
# First connect and list Users directory

def connect():
    conn = Connection(uuid.uuid4(), IP, 445)
    conn.connect()
    session = Session(conn, USER, PWD)
    session.connect()
    tree = TreeConnect(session, SHARE)
    tree.connect()
    return conn, session, tree

print('Connecting...')
conn, session, tree = connect()
print('Connected!')

# Discover remote username by listing Users/
print('\n=== Discovering remote users ===')
fd = Open(tree, 'Users')
fd.create(
    ImpersonationLevel.Impersonation,
    0x00120089,
    None,
    CreateDisposition.FILE_OPEN,
    1,  # FILE_DIRECTORY_FILE
    FileAttributes.FILE_ATTRIBUTE_DIRECTORY,
)
entries = fd.query_directory('*', FileAttributes.FILE_ATTRIBUTE_DIRECTORY)
remote_user = None
for item in entries:
    name = item['file_name']
    if name in ('.', '..'):
        continue
    print(f'  User: {name}')
    if name not in ('Public', 'Default', 'Default User', 'All Users'):
        remote_user = name
fd.close()

if not remote_user:
    print('ERROR: No suitable user found!')
    conn.disconnect()
    exit(1)

print(f'\nTarget user: {remote_user}')
REMOTE_BASE = rf'\\{IP}\C\Users\{remote_user}'

# Check what already exists
for sub in ['.config/opencode', '.local/share/opencode', '.local/state/opencode']:
    path = f'Users/{remote_user}/{sub}'
    try:
        fd = Open(tree, path)
        fd.create(ImpersonationLevel.Impersonation, 0x00120089, None,
                  CreateDisposition.FILE_OPEN, 1, FileAttributes.FILE_ATTRIBUTE_DIRECTORY)
        items = fd.query_directory('*', FileAttributes.FILE_ATTRIBUTE_DIRECTORY)
        count = len([i for i in items if i['file_name'] not in ('.', '..')])
        print(f'  EXISTS: {sub} ({count} items)')
        fd.close()
    except Exception as e:
        print(f'  MISSING: {sub} ({e})')

# Helper to ensure remote dir exists
def ensure_remote_dir(tree, remote_path):
    parts = remote_path.replace('\\', '/').split('/')
    current = ''
    for part in parts:
        current = f'{current}/{part}' if current else part
        try:
            fd = Open(tree, current)
            fd.create(ImpersonationLevel.Impersonation, 0x00120089, None,
                      CreateDisposition.FILE_OPEN, 1, FileAttributes.FILE_ATTRIBUTE_DIRECTORY)
            fd.close()
        except:
            try:
                fd = Open(tree, current)
                fd.create(ImpersonationLevel.Impersonation, 0x00120000, None,
                          CreateDisposition.FILE_CREATE, 1, FileAttributes.FILE_ATTRIBUTE_DIRECTORY)
                fd.close()
                print(f'  Created dir: {current}')
            except Exception as e:
                print(f'  WARN: Cannot create {current}: {e}')

def upload_file(tree, local_path, remote_dir, filename):
    remote_path = f'{remote_dir}/{filename}'
    size = os.path.getsize(local_path)
    
    fd = Open(tree, remote_path)
    fd.create(
        ImpersonationLevel.Impersonation,
        0x00120089,  # READ
        None,
        CreateDisposition.FILE_OVERWRITE_IF,
        0,  # FILE_NON_DIRECTORY_FILE
        FileAttributes.FILE_ATTRIBUTE_NORMAL,
    )
    
    with open(local_path, 'rb') as f:
        offset = 0
        chunk_size = 1024 * 64  # 64KB chunks
        while True:
            data = f.read(chunk_size)
            if not data:
                break
            fd.write(offset, data)
            offset += len(data)
            if size > 1024*1024:
                pct = (offset / size) * 100
                print(f'\r  {filename}: {pct:.1f}% ({offset}/{size})', end='', flush=True)
    
    fd.close()
    if size > 1024*1024:
        print()
    return size

def upload_tree(local_dir, remote_dir, tree, depth=0):
    """Recursively upload directory"""
    prefix = '  ' * depth
    for item in os.listdir(local_dir):
        local_path = os.path.join(local_dir, item)
        if os.path.isdir(local_path):
            # Skip unnecessary subdirs
            if item in ('log', 'tool-output', 'snapshot', 'repos'):
                print(f'{prefix}[SKIP DIR] {item}')
                continue
            print(f'{prefix}[DIR] {item}')
            remote_sub = f'{remote_dir}/{item}'
            ensure_remote_dir(tree, remote_sub)
            upload_tree(local_path, remote_sub, tree, depth+1)
        else:
            size = os.path.getsize(local_path)
            if size > 500 * 1024 * 1024:  # Skip files > 500MB (db files)
                print(f'{prefix}[SKIP LARGE] {item} ({size/(1024*1024):.1f}MB)')
                continue
            print(f'{prefix}[FILE] {item} ({size/(1024*1024):.1f}MB)')
            try:
                upload_file(tree, local_path, remote_dir, item)
            except Exception as e:
                print(f'{prefix}  ERROR: {e}')

# Main upload
print('\n=== Uploading .config/opencode ===')
remote_config = f'Users/{remote_user}/.config/opencode'
ensure_remote_dir(tree, remote_config)
upload_tree(LOCAL_CONFIG, remote_config, tree)

print('\n=== Uploading .local/share/opencode (core files only) ===')
remote_share = f'Users/{remote_user}/.local/share/opencode'
ensure_remote_dir(tree, remote_share)
# Only upload essential files, not huge logs/tool-output
for item in os.listdir(LOCAL_SHARE):
    local_path = os.path.join(LOCAL_SHARE, item)
    if os.path.isdir(local_path):
        if item in ('log', 'tool-output', 'snapshot', 'repos'):
            print(f'  [SKIP DIR] {item}')
            continue
        print(f'  [DIR] {item}')
        remote_sub = f'{remote_share}/{item}'
        ensure_remote_dir(tree, remote_sub)
        upload_tree(local_path, remote_sub, tree, 1)
    else:
        size = os.path.getsize(local_path)
        if size > 500 * 1024 * 1024:
            print(f'  [SKIP LARGE] {item} ({size/(1024*1024):.0f}MB)')
            continue
        print(f'  [FILE] {item} ({size/(1024*1024):.1f}MB)')
        try:
            upload_file(tree, local_path, remote_share, item)
        except Exception as e:
            print(f'  ERROR: {e}')

print('\n=== Uploading .local/state/opencode ===')
remote_state = f'Users/{remote_user}/.local/state/opencode'
ensure_remote_dir(tree, remote_state)
upload_tree(LOCAL_STATE, remote_state, tree)

# Upload database too (the big one)
print('\n=== Uploading opencode.db ===')
db_path = os.path.join(LOCAL_SHARE, 'opencode.db')
if os.path.exists(db_path):
    size = os.path.getsize(db_path)
    print(f'  opencode.db: {size/(1024*1024*1024):.2f} GB')
    try:
        upload_file(tree, db_path, remote_share, 'opencode.db')
        print('  DONE!')
    except Exception as e:
        print(f'  ERROR: {e}')
else:
    print('  opencode.db not found')

tree.disconnect()
session.disconnect()
conn.disconnect()
print('\n=== ALL DONE ===')
