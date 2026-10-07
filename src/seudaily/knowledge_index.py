"""Internal local RAG primitives; cloud embedding is handled by the backend."""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .cancellation import raise_if_cancelled
from .optional_runtime import ensure_dependencies


def split_text(text: str) -> list[dict[str, Any]]:
    ensure_dependencies("knowledge")
    from langchain_text_splitters import RecursiveCharacterTextSplitter

    splitter = RecursiveCharacterTextSplitter(
        chunk_size=1000, chunk_overlap=150,
        separators=["\n\n", "\n", "。", "！", "？", ";", "；", ". ", "，", ", ", " ", ""],
    )
    # Keep the parser's page markers attached to every piece from that page.
    sections = re.split(r"(?m)(?=^## 第 \d+ 页\s*$)", text)
    chunks: list[dict[str, Any]] = []
    for section in sections:
        match = re.match(r"## 第 (\d+) 页\s*\n", section)
        page = int(match.group(1)) if match else 0
        for piece in splitter.split_text(section):
            raise_if_cancelled()
            chunks.append({"text": piece, "page": page, "ordinal": len(chunks)})
    return chunks


def operate(payload: dict[str, Any]) -> dict[str, Any]:
    ensure_dependencies("knowledge")
    operation = payload["operation"]
    if operation == "split":
        return {"chunks": split_text(payload["text"])}
    import lancedb
    import pyarrow as pa

    root = Path(payload["root"])
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    space = payload["space"]
    if not re.fullmatch(r"[0-9a-f]{64}", space):
        raise ValueError("索引配置无效")
    db = lancedb.connect(str(root))
    name = "chunks_" + space
    vector = payload.get("vector")
    if operation == "index":
        rows = payload["rows"]
        if not rows:
            return {"count": 0}
        dimension = len(rows[0]["vector"])
        schema = pa.schema([
            pa.field("id", pa.string()), pa.field("documentId", pa.string()),
            pa.field("text", pa.string()), pa.field("page", pa.int32()),
            pa.field("ordinal", pa.int32()), pa.field("vector", pa.list_(pa.float32(), dimension)),
        ])
        try:
            table = db.open_table(name)
        except ValueError:
            table = db.create_table(name, schema=schema)
        if table.schema.field("vector").type.list_size != dimension:
            raise ValueError("向量维度发生变化，请更换索引配置并重建")
        raise_if_cancelled()
        table.merge_insert("id").when_matched_update_all().when_not_matched_insert_all().execute(rows)
        return {"count": len(rows)}
    try:
        table = db.open_table(name)
    except ValueError:
        return {"matches": []}
    if operation == "delete":
        document_id = payload["documentId"]
        if not re.fullmatch(r"[0-9a-f]{64}", document_id):
            raise ValueError("文档编号无效")
        table.delete(f"documentId = '{document_id}'")
        return {"deleted": True}
    if operation == "search":
        allowed = payload["documentIds"]
        if not allowed or any(not re.fullmatch(r"[0-9a-f]{64}", item) for item in allowed):
            return {"matches": []}
        condition = "documentId IN (" + ",".join("'" + item + "'" for item in allowed) + ")"
        matches = (table.search(vector).distance_type("cosine").where(condition, prefilter=True)
                   .limit(payload.get("limit", 5)).to_list())
        for item in matches:
            item.pop("vector", None)
        return {"matches": matches}
    raise ValueError("未知索引操作")
