from smbprotocol.connection import Connection
from smbprotocol.session import Session
from smbprotocol.tree import TreeConnect
import uuid

ip = '192.168.3.15'
user = 'DANG'
pwd = 'a'

shares_to_try = [
    rf'\\{ip}\C',
    rf'\\{ip}\c',
    rf'\\{ip}\D',
    rf'\\{ip}\d',
    rf'\\{ip}\C$',
    rf'\\{ip}\IPC$',
    rf'\\Desktop-1ik02mt\C',
    rf'\\Desktop-1ik02mt\D',
]

for share in shares_to_try:
    try:
        conn = Connection(uuid.uuid4(), ip, 445)
        conn.connect()
        session = Session(conn, user, pwd)
        session.connect()
        tree = TreeConnect(session, share)
        tree.connect()
        print(f'OK: {share}')
        tree.disconnect()
        session.disconnect()
        conn.disconnect()
    except Exception as e:
        err = str(e)[:150]
        print(f'FAIL: {share} => {type(e).__name__}: {err}')
