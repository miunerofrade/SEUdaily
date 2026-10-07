"""Durable originals for files that the web tools actually read; URL cache avoids downloads."""
from __future__ import annotations
import hashlib
import json
import os
import tempfile
from pathlib import Path

def root() -> Path:
    return Path('.seudaily/web-files').resolve()

def atomic(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
        temporary=Path(stream.name)
        stream.write(data); stream.flush(); os.fsync(stream.fileno())
    try: os.replace(temporary,path)
    finally: temporary.unlink(missing_ok=True)

def cached(url: str) -> dict | None:
    try:
        data=json.loads((root()/'metadata'/(hashlib.sha256(url.encode()).hexdigest()+'.json')).read_text(encoding='utf-8'))
        path=Path(data['path'])
        if path.is_symlink() or not path.resolve().is_relative_to(root()/'files'): return None
        if hashlib.sha256(path.read_bytes()).hexdigest()!=data['sha256']:return None
        return data
    except (OSError,ValueError,KeyError):return None

def save(url: str,name: str,content: bytes,extension: str,*,markdown: str | None=None,source_url: str='') -> dict:
    digest=hashlib.sha256(content).hexdigest()
    path=root()/'files'/(digest+extension)
    if not path.exists():atomic(path,content)
    data={'url':url,'name':name,'path':str(path),'sha256':digest,'sizeBytes':len(content),'sourceUrl':source_url or url}
    if markdown is not None:data.update(markdown=markdown,charCount=len(markdown),parsed=True)
    atomic(root()/'metadata'/(hashlib.sha256(url.encode()).hexdigest()+'.json'),json.dumps(data,ensure_ascii=False).encode())
    return data

def body(url: str,title: str,text: str) -> None:
    if text.strip():save(url,title+'.md',('# '+title+'\n\n来源：'+url+'\n\n'+text).encode(),'.md')
