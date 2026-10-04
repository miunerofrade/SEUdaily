"""Cross-process interface leases; OS locks disappear when a launcher exits."""
from __future__ import annotations

import errno
import os
from pathlib import Path
import time
from typing import IO


def lock_file(path: Path, *, blocking: bool = True) -> IO[bytes] | None:
    stream = path.open("a+b")
    if os.name == "nt":
        import msvcrt
        if path.stat().st_size == 0:
            stream.write(b"\0")
            stream.flush()
        while True:
            stream.seek(0)
            try:
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                return stream
            except OSError as error:
                if error.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                    stream.close()
                    raise
                if not blocking:
                    stream.close()
                    return None
                time.sleep(0.05)
    else:
        import fcntl
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        except BlockingIOError:
            stream.close()
            return None
        return stream


def has_clients(directory: Path) -> bool:
    active = False
    for path in directory.glob("*.lease"):
        stream = lock_file(path, blocking=False)
        if stream is None:
            active = True
        else:
            stream.close()
            path.unlink(missing_ok=True)
    return active
