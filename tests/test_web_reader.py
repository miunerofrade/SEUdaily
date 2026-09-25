from __future__ import annotations

import io
import socket
from email.message import Message
from pathlib import Path

import pytest

import cvstream.web_reader as web_reader


def _text_pdf_bytes(text: str) -> bytes:
    content = f"BT /F1 18 Tf 72 720 Td ({text}) Tj ET".encode("ascii")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length " + str(len(content)).encode("ascii") + b" >>\nstream\n" + content + b"\nendstream",
    ]
    output = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets: list[int] = []
    for index, obj in enumerate(objects, start=1):
        offsets.append(len(output))
        output.extend(f"{index} 0 obj\n".encode("ascii"))
        output.extend(obj)
        output.extend(b"\nendobj\n")
    xref_offset = len(output)
    output.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    output.extend(b"0000000000 65535 f \n")
    for offset in offsets:
        output.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    output.extend(
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n".encode("ascii")
    )
    return bytes(output)


class _FakeResponse(io.BytesIO):
    def __init__(self, payload: bytes, url: str, content_type: str) -> None:
        super().__init__(payload)
        self._url = url
        self.headers = Message()
        self.headers["Content-Type"] = content_type
        self.headers["Content-Length"] = str(len(payload))

    def geturl(self) -> str:
        return self._url

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback) -> None:
        self.close()


class _FakeOpener:
    def __init__(self, responses: dict[str, tuple[bytes, str]]) -> None:
        self.responses = responses
        self.opened: list[str] = []

    def open(self, request, timeout: int):  # type: ignore[no-untyped-def]
        url = request.full_url
        self.opened.append(url)
        payload, content_type = self.responses[url]
        return _FakeResponse(payload, url, content_type)


@pytest.fixture
def public_dns(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        web_reader.socket,
        "getaddrinfo",
        lambda host, port, type: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", port))],
    )


def test_reads_normal_web_page_without_downloading_attachment(
    monkeypatch: pytest.MonkeyPatch,
    public_dns: None,
) -> None:
    url = "https://example.edu/notice.html"
    attachment_url = "https://example.edu/files/details.pdf"
    html = f"""
    <html><head><title>普通通知</title></head><body>
      <main class="article-content"><p>{'这是足够长的网页正文。' * 15}</p>
      <a href="{attachment_url}">补充材料.pdf</a></main>
    </body></html>
    """.encode()
    opener = _FakeOpener({url: (html, "text/html; charset=utf-8")})
    monkeypatch.setattr(web_reader, "build_opener", lambda *handlers: opener)

    result = web_reader.read_web_page(url, query="正文说了什么", include_attachments="auto")

    assert result["status"] == "completed"
    assert result["article"]["title"] == "普通通知"
    assert "这是足够长的网页正文" in result["content"]
    assert result["attachments"][0]["parsed"] is False
    assert opener.opened == [url]


@pytest.mark.parametrize("host", ["jwc.seu.edu.cn", "cse.seu.edu.cn", "tyx.seu.edu.cn", "any-campus-service.seu.edu.cn"])
def test_empty_webplus_page_automatically_parses_pdf_and_cleans_temp_file(
    host: str,
    monkeypatch: pytest.MonkeyPatch,
    public_dns: None,
) -> None:
    url = f"https://{host}/2026/0921/example/page.psp"
    attachment_url = f"https://{host}/_upload/article/files/demo.pdf"
    html = f"""
    <html><body>
      <h1 class="Article_Title">附件通知</h1>
      <div class="wp_articlecontent Article_Content">
        <div class="wp_pdf_player" pdfsrc="{attachment_url}"
             sudyfile-attr="{{'title':'测试附件.pdf'}}"></div>
      </div>
    </body></html>
    """.encode()
    opener = _FakeOpener({
        url: (html, "text/html; charset=utf-8"),
        attachment_url: (_text_pdf_bytes("Attachment parser works"), "application/pdf"),
    })
    monkeypatch.setattr(web_reader, "build_opener", lambda *handlers: opener)
    parsed_paths: list[Path] = []
    real_parse = web_reader.parse_document

    def recording_parse(path: str, **kwargs):  # type: ignore[no-untyped-def]
        parsed_paths.append(Path(path))
        return real_parse(path, **kwargs)

    monkeypatch.setattr(web_reader, "parse_document", recording_parse)

    result = web_reader.read_web_page(url, query="这个链接的附件说了什么？")

    assert result["content"] == ""
    assert result["article"]["title"] == "附件通知"
    assert result["contentSource"] == "attachment"
    assert result["metrics"]["parsedAttachmentCount"] == 1
    assert result["attachments"][0]["name"] == "测试附件.pdf"
    assert "Attachment parser works" in result["attachments"][0]["markdown"]
    assert opener.opened == [url, attachment_url]
    assert parsed_paths and all(not path.exists() for path in parsed_paths)


def test_attachment_mode_none_never_downloads(
    monkeypatch: pytest.MonkeyPatch,
    public_dns: None,
) -> None:
    url = "https://example.edu/empty.html"
    html = b'<html><body><div class="article-content"><a href="/a.pdf">A.pdf</a></div></body></html>'
    opener = _FakeOpener({url: (html, "text/html")})
    monkeypatch.setattr(web_reader, "build_opener", lambda *handlers: opener)

    result = web_reader.read_web_page(url, query="附件内容", include_attachments="none")

    assert result["attachments"][0]["parsed"] is False
    assert opener.opened == [url]


@pytest.mark.parametrize(
    "url, message",
    [
        ("file:///etc/passwd", "HTTP"),
        ("http://localhost/page", "本机"),
        ("https://example.edu/page?access_token=secret", "凭据"),
    ],
)
def test_rejects_unsafe_urls(url: str, message: str) -> None:
    with pytest.raises(ValueError, match=message):
        web_reader.validate_public_url(url)


def test_rejects_host_resolving_to_private_network(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        web_reader.socket,
        "getaddrinfo",
        lambda host, port, type: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", port))],
    )

    with pytest.raises(ValueError, match="私网"):
        web_reader.validate_public_url("https://example.edu/page")


def test_semantic_main_is_preferred_over_navigation(
    monkeypatch: pytest.MonkeyPatch,
    public_dns: None,
) -> None:
    url = "https://example.edu/docs"
    html = b"""
    <html><head><title>Docs</title></head><body>
      <nav>Navigation only</nav>
      <main id="content"><h1>HTTP guide</h1><p>Main documentation text.</p></main>
      <footer>Footer only</footer>
    </body></html>
    """
    opener = _FakeOpener({url: (html, "text/html")})
    monkeypatch.setattr(web_reader, "build_opener", lambda *handlers: opener)

    result = web_reader.read_web_page(url, include_attachments="none")

    assert result["content"] == "HTTP guide Main documentation text."


def test_void_element_inside_template_does_not_hide_following_main_content(
    monkeypatch: pytest.MonkeyPatch,
    public_dns: None,
) -> None:
    url = "https://example.edu/docs-with-template"
    html = b"""
    <html><body>
      <template><input><img src="placeholder.png"></template>
      <main id="content"><h1>Visible guide</h1><p>Readable content.</p></main>
    </body></html>
    """
    opener = _FakeOpener({url: (html, "text/html")})
    monkeypatch.setattr(web_reader, "build_opener", lambda *handlers: opener)

    result = web_reader.read_web_page(url, include_attachments="none")

    assert result["content"] == "Visible guide Readable content."


@pytest.mark.parametrize("host", ["jwc.seu.edu.cn", "cse.seu.edu.cn"])
def test_allows_trusted_campus_host_on_internal_dns(
    host: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        web_reader.socket,
        "getaddrinfo",
        lambda hostname, port, type: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.64.84.122", port))],
    )

    assert web_reader.validate_public_url(f"https://{host}/page.htm") == f"https://{host}/page.htm"
