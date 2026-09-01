from smbprotocol.connection import Connection
from smbprotocol.session import Session
from smbprotocol.tree import TreeConnect
from smbprotocol.open import Open, CreateDisposition, FileAttributes, CreateOptions, ImpersonationLevel, AccessMask
from smbprotocol.structure import BytesField, UInt32Field
import uuid

ip = '192.168.3.15'
user = 'DANG'
pwd = 'a'
share = rf'\\{ip}\C'

conn = Connection(uuid.uuid4(), ip, 445)
conn.connect()
session = Session(conn, user, pwd)
session.connect()
tree = TreeConnect(session, share)
tree.connect()

print(f'Connected to {share}')

# List directory using SMB2 QueryDirectory
fd = Open(tree, '')
fd.create(
    ImpersonationLevel.Impersonation,
    AccessMask.FILE_LIST_DIRECTORY,
    0,
    CreateDisposition.FILE_OPEN,
    CreateOptions.FILE_DIRECTORY_FILE,
    FileAttributes.FILE_ATTRIBUTE_DIRECTORY,
    None,
)

# Query directory
from smbprotocol.open import DirectoryInfo
info = fd.query_directory('*', FileAttributes.FILE_ATTRIBUTE_DIRECTORY)
for item in info:
    name = item['file_name']
    attr = item['file_attributes']
    ft = item['last_write_time']
    size = item['end_of_file']
    print(f'  {name} | size={size} | attr={attr}')

fd.close()
tree.disconnect()
session.disconnect()
conn.disconnect()
