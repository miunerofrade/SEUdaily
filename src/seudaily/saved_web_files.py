"""Durable originals for files that the web tools actually read; URL cache avoids downloads."""
from __future__ import annotations
import hashlib
import json
import os
import re
import tempfile
from pathlib import Path
from urllib.parse import urlsplit
from functools import cache

PROTOCOL = json.loads(Path(__file__).with_name('web_files_protocol.json').read_text(encoding='utf-8'))

def root() -> Path:
    runtime = Path('.seudaily').resolve()
    directory = (runtime / PROTOCOL['directory']).resolve()
    if not directory.is_relative_to(runtime): raise ValueError('网页资料目录越界')
    return directory

def metadata_path(url: str) -> Path:
    return root() / PROTOCOL['metadataDirectory'] / (hashlib.sha256(url.encode()).hexdigest() + '.json')

def atomic(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
        temporary=Path(stream.name)
        stream.write(data); stream.flush(); os.fsync(stream.fileno())
    try: os.replace(temporary,path)
    finally: temporary.unlink(missing_ok=True)

def cached(url: str) -> dict | None:
    try:
        files = root() / PROTOCOL['filesDirectory']
        metadata = metadata_path(url)
        if metadata.is_symlink() or not metadata.parent.resolve().is_relative_to(root()) or not files.resolve().is_relative_to(root()): return None
        data = json.loads(metadata.read_text(encoding='utf-8'))
        if not isinstance(data, dict) or any(not isinstance(data.get(key), str) for key in ('name', 'path', 'sha256')): return None
        if not re.fullmatch(PROTOCOL['sha256Pattern'], data['sha256']) or data.get('url', url) != url: return None
        path = Path(data['path'])
        if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(files.resolve()): return None
        if hashlib.sha256(path.read_bytes()).hexdigest() != data['sha256']: return None
        return data
    except (OSError, ValueError, KeyError): return None

@cache
def source_names() -> dict[str,str]:
    config=json.loads(Path(__file__).with_name('notice_categories.json').read_text(encoding='utf-8'))
    return {source['host']:source['name'] for source in config.values()}

def source_identity(url: str, name: str='') -> dict:
    host=(urlsplit(url).hostname or '').lower()
    key=host if re.fullmatch(PROTOCOL['sourceIdPattern'],host) else hashlib.sha256(host.encode()).hexdigest() if host else PROTOCOL['fallbackSource']['id']
    return {'id':key,'name':name or source_names().get(host,host) or PROTOCOL['fallbackSource']['name']}

def save(url: str,name: str,content: bytes,extension: str,*,markdown: str | None=None,source_url: str='',source_name: str='',notice: dict | None=None) -> dict:
    digest=hashlib.sha256(content).hexdigest()
    source=source_identity(source_url or url,source_name)
    if notice is None:
        site={'jwc.seu.edu.cn':'jwc','cse.seu.edu.cn':'cse'}.get(source['id'])
        match=re.search(r'a(\d+)/page\.',source_url or url)
        if site and match:
            try: notice=json.loads((root().parent/site/'articles'/f"seu-{site}-{match.group(1)}.json").read_text(encoding='utf-8'))
            except (OSError,ValueError): pass
    notice=notice or {}
    notice_url=source_url or url
    notice_id=notice.get('id','')
    if not re.fullmatch(PROTOCOL['noticeIdPattern'],notice_id): notice_id=hashlib.sha256(notice_url.encode()).hexdigest()
    section_id=notice.get('category',PROTOCOL['fallbackSection'])
    if not re.fullmatch(PROTOCOL['sectionIdPattern'],section_id): section_id=PROTOCOL['fallbackSection']
    identity={'id':notice_id,'title':notice.get('title') or name.rsplit('.',1)[0],'url':notice_url}
    path=root()/PROTOCOL['filesDirectory']/source['id']/section_id/notice_id/(digest+extension)
    if not path.exists():atomic(path,content)
    data={'url':url,'name':name,'path':str(path),'sha256':digest,'sizeBytes':len(content),'sourceUrl':source_url or url,'source':source,'notice':identity,'sectionId':section_id}
    if markdown is not None:data.update(markdown=markdown,charCount=len(markdown),parsed=True)
    atomic(metadata_path(url),json.dumps(data,ensure_ascii=False).encode())
    return data

def body(url: str,title: str,text: str,*,source_name: str='',notice: dict | None=None) -> None:
    if text.strip():save(url,title+'.md',('# '+title+'\n\n来源：'+url+'\n\n'+text).encode(),'.md',source_name=source_name,notice=notice)
