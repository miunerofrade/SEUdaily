from pathlib import Path
import pytest
from seudaily.knowledge_index import operate, split_text


def test_recursive_long_chinese_paragraphs_keep_page_locations():
    text = '## 第 3 页\n\n' + '这是很长的中文段落，必须拆分但要保留上下文。' * 200
    chunks = split_text(text)
    assert len(chunks) > 1
    assert all(len(chunk['text']) <= 1000 for chunk in chunks)
    assert all(chunk['page'] == 3 for chunk in chunks)
    assert ''.join(str(chunk['ordinal']) for chunk in chunks) == ''.join(map(str, range(len(chunks))))
    assert chunks[0]['text'].startswith('## 第 3 页')
    assert split_text('') == []


def test_lancedb_retries_are_idempotent_and_queries_filter_document_scope(tmp_path: Path):
    shared = {'root': str(tmp_path), 'space': 'a' * 64}
    rows = [
        {'id': 'first:0', 'documentId': 'b' * 64, 'text': '第一份文件', 'page': 2, 'ordinal': 0, 'vector': [1.0, 0.0]},
        {'id': 'second:0', 'documentId': 'c' * 64, 'text': '第二份文件', 'page': 0, 'ordinal': 0, 'vector': [0.0, 1.0]},
    ]
    for _ in range(2):
        assert operate({**shared, 'operation': 'index', 'rows': rows})['count'] == 2
    matches = operate({**shared, 'operation': 'search', 'vector': [1.0, 0.0], 'documentIds': ['b' * 64], 'limit': 5})['matches']
    assert len(matches) == 1
    assert matches[0]['page'] == 2
    assert 'vector' not in matches[0]
    assert operate({**shared, 'operation': 'search', 'vector': [1.0, 0.0], 'documentIds': []})['matches'] == []
    operate({**shared, 'operation': 'delete', 'documentId': 'b' * 64})
    assert operate({**shared, 'operation': 'search', 'vector': [1.0, 0.0], 'documentIds': ['b' * 64]})['matches'] == []
    with pytest.raises(ValueError, match='维度'):
        operate({**shared, 'operation': 'index', 'rows': [{**rows[0], 'vector': [1.0, 0.0, 0.0]}]})
