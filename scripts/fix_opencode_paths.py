"""
Fix opencode DB paths for remote machine.
Run this on machine 192.168.3.15 AFTER sync completes and opencode is CLOSED.
Replaces all "C:/Users/Hai Dang" with "C:/Users/Dang" in opencode.db
"""
import sqlite3
import os
import shutil

OLD_PATH = "C:/Users/Hai Dang"
NEW_PATH = "C:/Users/Dang"

db_path = os.path.expanduser('~/.local/share/opencode/opencode.db')

# Backup
backup = db_path + '.bak_fix'
shutil.copy2(db_path, backup)
print(f"Backup: {backup}")

conn = sqlite3.connect(db_path)
cur = conn.cursor()

# Tables with path data
tables = {
    'project_directory': ['directory'],
    'project': ['worktree'],
    'session': ['directory', 'path'],
}

total = 0
for table, columns in tables.items():
    for col in columns:
        cur.execute(f"SELECT COUNT(*) FROM {table} WHERE {col} LIKE ?", (f'%{OLD_PATH}%',))
        count = cur.fetchone()[0]
        if count > 0:
            cur.execute(f"UPDATE {table} SET {col} = REPLACE({col}, ?, ?) WHERE {col} LIKE ?", 
                       (OLD_PATH, NEW_PATH, f'%{OLD_PATH}%'))
            print(f"  {table}.{col}: {count} rows updated")
            total += count

conn.commit()
conn.close()

print(f"\nDone! {total} rows updated.")
print(f"Restart opencode on this machine to see sessions.")
