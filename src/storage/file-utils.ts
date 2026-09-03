import {
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  renameSync,
  copyFileSync,
  unlinkSync,
  existsSync
} from 'fs';

export function atomicWriteFile(targetPath: string, content: string): void {
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;

  // Write to temporary file with explicit fsync to guarantee flush to physical disk
  const fd = openSync(tmpPath, 'w');
  try {
    writeSync(fd, content, 0, 'utf-8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  // Atomic replacement with retry loop for Windows EPERM/EBUSY locking
  let renamed = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      renameSync(tmpPath, targetPath);
      renamed = true;
      break;
    } catch (e: any) {
      if (attempt === 4) {
        // Fallback: copyFileSync + unlinkSync
        try {
          copyFileSync(tmpPath, targetPath);
          renamed = true;
        } catch (copyErr: any) {
          throw new Error(`Failed to commit atomic write to ${targetPath}: ${e.message} / ${copyErr.message}`);
        }
      }
    }
  }

  if (existsSync(tmpPath)) {
    try { unlinkSync(tmpPath); } catch {}
  }
}
