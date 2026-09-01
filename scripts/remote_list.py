"""Copy config data from remote machine 192.168.3.15 share C using pysmb"""
import os
import sys
from smb.SMBConnection import SMBConnection

IP = '192.168.3.15'
USER = 'DANG'
PWD = 'a'
SERVER = 'Desktop-1ik02mt'
LOCAL_DEST = r'C:\temp_remote_copy'

def connect():
    conn = SMBConnection(USER, PWD, 'thispc', SERVER, use_ntlm_v2=True, is_direct_tcp=True)
    ok = conn.connect(IP, 445, timeout=10)
    if not ok:
        print('Connection failed!')
        sys.exit(1)
    print('Connected!')
    return conn

def list_shares(conn):
    shares = conn.listShares()
    for s in shares:
        print(f'  Share: {s.name} | type={s.type} | remark={s.comments}')

def list_dir(conn, share, path='/'):
    entries = conn.listPath(share, path)
    for e in entries:
        name = e.filename
        if name in ('.', '..'):
            continue
        tag = '[DIR]' if e.isDirectory else '[FILE]'
        print(f'  {tag} {name} ({e.file_size})')

def download_tree(conn, share, remote_path, local_path, depth=0):
    os.makedirs(local_path, exist_ok=True)
    prefix = '  ' * depth
    entries = conn.listPath(share, remote_path)
    for e in entries:
        name = e.filename
        if name in ('.', '..'):
            continue
        remote = f'{remote_path}/{name}' if remote_path != '/' else f'/{name}'
        local = os.path.join(local_path, name)
        if e.isDirectory:
            print(f'{prefix}[DIR] {name}')
            download_tree(conn, share, remote, local, depth+1)
        else:
            print(f'{prefix}[FILE] {name} ({e.file_size} bytes)')
            try:
                with open(local, 'wb') as f:
                    conn.retrieveFile(share, remote, f)
                print(f'{prefix}  -> saved')
            except Exception as ex:
                print(f'{prefix}  -> ERROR: {ex}')

if __name__ == '__main__':
    conn = connect()
    
    # List shares
    print('\n=== Shares ===')
    list_shares(conn)
    
    # List C drive root
    print('\n=== C: root ===')
    list_dir(conn, 'C', '/')
    
    conn.close()
    print('\nDone.')
