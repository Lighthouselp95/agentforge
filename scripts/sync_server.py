"""Simple HTTP server to serve opencode files for LAN sync"""
import http.server
import os
import json
import urllib.parse

PORT = 18932
USER = os.path.expanduser('~')
BASE = USER

# Files to serve
SERVE_FILES = {
    '/config/opencode.jsonc': os.path.join(BASE, '.config', 'opencode', 'opencode.jsonc'),
    '/config/CHANGELOG.md': os.path.join(BASE, '.config', 'opencode', 'CHANGELOG.md'),
    '/data/auth.json': os.path.join(BASE, '.local', 'share', 'opencode', 'auth.json'),
    '/data/opencode.db': os.path.join(BASE, '.local', 'share', 'opencode', 'opencode.db'),
    '/data/opencode.db-shm': os.path.join(BASE, '.local', 'share', 'opencode', 'opencode.db-shm'),
    '/data/opencode.db-wal': os.path.join(BASE, '.local', 'share', 'opencode', 'opencode.db-wal'),
}

# Serve config/plugins/age directories recursively
SERVE_DIRS = {
    '/config/plugins': os.path.join(BASE, '.config', 'opencode', 'plugins'),
    '/config/age': os.path.join(BASE, '.config', 'opencode', 'age'),
    '/data/storage': os.path.join(BASE, '.local', 'share', 'opencode', 'storage'),
}

class SyncHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        path = urllib.parse.unquote(self.path)
        
        # List all files
        if path == '/':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            files = {}
            for k, v in SERVE_FILES.items():
                if os.path.exists(v):
                    files[k] = os.path.getsize(v)
            self.wfile.write(json.dumps(files, indent=2).encode())
            return
        
        # Serve specific file
        if path in SERVE_FILES:
            filepath = SERVE_FILES[path]
            if os.path.exists(filepath):
                size = os.path.getsize(filepath)
                self.send_response(200)
                self.send_header('Content-Type', 'application/octet-stream')
                self.send_header('Content-Length', str(size))
                self.end_headers()
                with open(filepath, 'rb') as f:
                    while chunk := f.read(1024*64):
                        self.wfile.write(chunk)
                print(f'  Served: {path} ({size/(1024*1024):.1f}MB)')
                return
        
        # Serve from directories
        for prefix, local_dir in SERVE_DIRS.items():
            if path.startswith(prefix + '/'):
                rel = path[len(prefix):]
                filepath = os.path.join(local_dir, rel.lstrip('/'))
                if os.path.exists(filepath) and os.path.isfile(filepath):
                    size = os.path.getsize(filepath)
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/octet-stream')
                    self.send_header('Content-Length', str(size))
                    self.end_headers()
                    with open(filepath, 'rb') as f:
                        while chunk := f.read(1024*64):
                            self.wfile.write(chunk)
                    print(f'  Served: {path} ({size}B)')
                    return
        
        self.send_response(404)
        self.end_headers()
        self.wfile.write(b'Not found')

    def log_message(self, format, *args):
        print(f'[{self.address_string()}] {format % args}')

print(f'=== Opencode Sync Server ===')
print(f'Port: {PORT}')
print(f'Files ready to serve:')
for k, v in SERVE_FILES.items():
    if os.path.exists(v):
        print(f'  {k} ({os.path.getsize(v)/(1024*1024):.1f}MB)')
    else:
        print(f'  {k} (MISSING)')
print(f'\nWaiting for connections...')

server = http.server.HTTPServer(('0.0.0.0', PORT), SyncHandler)
server.serve_forever()
