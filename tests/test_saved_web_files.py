import json
from pathlib import Path

from seudaily import saved_web_files as saved


def test_originals_are_stored_in_source_directories_and_cached(tmp_path,monkeypatch):
    monkeypatch.setattr(saved,'root',lambda:tmp_path/'web-files')
    item=saved.save('https://cdn.example/file','通知.pdf',b'original','.pdf',source_url='https://jwc.seu.edu.cn/notice',markdown='正文')
    assert item['source']=={'id':'jwc.seu.edu.cn','name':'教务处'}
    assert Path(item['path']).parent==tmp_path/'web-files/files/jwc.seu.edu.cn'
    assert Path(item['path']).read_bytes()==b'original'
    assert saved.cached(item['url'])==item
    again=saved.save(item['url'],'通知.pdf',b'original','.pdf',source_url=item['sourceUrl'],markdown='正文')
    assert again['path']==item['path']


def test_legacy_flat_metadata_remains_readable(tmp_path,monkeypatch):
    monkeypatch.setattr(saved,'root',lambda:tmp_path/'web-files')
    item=saved.save('https://example.org/page','网页.md',b'body','.md')
    original=Path(item['path']);flat=original.parent.parent/original.name
    original.rename(flat);item['path']=str(flat);item.pop('source')
    import hashlib
    metadata=saved.root()/'metadata'/(hashlib.sha256(item['url'].encode()).hexdigest()+'.json')
    metadata.write_text(json.dumps(item))
    assert saved.cached(item['url'])==item
