"""Offline regressions for cancellation, incremental capture and browser lifecycle."""
from __future__ import annotations

import importlib
import json
import subprocess
import sys
import threading
import time
from io import StringIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from seudaily.asr import cloud
from seudaily.browser_runtime import BrowserRuntime
from seudaily.cancellation import TaskCancelledError, set_current_cancel_event
from seudaily.capture import execute_video_task
from seudaily.service import CourseService


@pytest.fixture(autouse=True)
def clear_cancellation():
    set_current_cancel_event(None)
    yield
    set_current_cancel_event(None)


class FakeNode:
    def __init__(self, page, index=0):
        self.page = page
        self.index = index

    @property
    def first(self):
        return self

    def nth(self, index):
        return FakeNode(self.page, index)

    def locator(self, *_args, **_kwargs):
        return self

    def wait_for(self, **_kwargs):
        pass

    def scroll_into_view_if_needed(self):
        pass

    def inner_text(self):
        return "课程"

    def get_attribute(self, *_args):
        return "教师"

    def evaluate(self, *_args):
        if self.index in self.page.subtitle_indices:
            self.page.listener(SimpleNamespace(
                request=SimpleNamespace(method="GET"), ok=True,
                url="/course/ai/translate/1",
                json=lambda: {"data": {"afterAssemblyList": [{"res": f"字幕 {self.index}"}]}},
            ))


class FakePage:
    def __init__(self, count=2, subtitle_indices=(0, 1)):
        self.count = count
        self.video_url = "https://example.invalid/video.mp4?auth_key=test"
        self.subtitle_indices = subtitle_indices
        self.removed = []
        self.unroutes = 0

    def on(self, _event, listener):
        self.listener = listener

    def remove_listener(self, event, listener):
        self.removed.append((event, listener))

    def locator(self, *_args, **_kwargs):
        return FakeNode(self)

    def wait_for_timeout(self, *_args):
        pass

    def evaluate(self, *_args):
        return [{"index": index, "lesson_sequence": index + 1,
                 "date": "2026-09-01", "time": "10:00", "period_seq": index + 1}
                for index in range(self.count)]

    def route(self, *_args):
        pass

    def unroute(self, *_args):
        self.unroutes += 1

    def expect_response(self, *_args, **_kwargs):
        url = self.video_url
        class ResponseContext:
            def __enter__(self):
                return SimpleNamespace(value=SimpleNamespace(json=lambda: {
                    "url": url}))

            def __exit__(self, *_args):
                pass

        return ResponseContext()


class FakeMediaWorker:
    def __init__(self, tmp_path):
        self.temp_video_path = str(tmp_path / "input.mp4")
        Path(self.temp_video_path).write_bytes(b"video")
        self.extractions = 0
        self.cleanup_count = 0

    def extract_media(self, *_args, **_kwargs):
        self.extractions += 1

    def transcribe_and_export(self, _name):
        raise RuntimeError("offline ASR failure")

    def _cleanup(self):
        self.cleanup_count += 1

    def abort(self):
        self._cleanup()


def capture(page, media, export, **options):
    statuses = []
    logs = list(execute_video_task(page, "fake", media, export, threading.Event(),
                                  target_date="2026-09-01", capture_status=statuses, **options))
    return statuses, logs


def test_capture_tracks_each_period_independently(tmp_path):
    page = FakePage()
    statuses, _ = capture(page, FakeMediaWorker(tmp_path), tmp_path / "exports")
    assert page.unroutes == 1
    assert [status["officialSubtitleAvailable"] for status in statuses] == [True, True]
    assert len(list((tmp_path / "exports").rglob("*_transcript.txt"))) == 2


def test_capture_failures_belong_to_their_period(tmp_path):
    statuses, _ = capture(FakePage(subtitle_indices=(1,)), FakeMediaWorker(tmp_path), tmp_path / "exports")
    assert statuses[0]["failure"] == "offline ASR failure"
    assert statuses[0]["asrAttempted"] is True
    assert "failure" not in statuses[1]
    assert statuses[1]["officialSubtitleAvailable"] is True


def test_existing_transcript_allows_append_media_and_then_skips_complete_request(tmp_path):
    export = tmp_path / "exports"
    media = FakeMediaWorker(tmp_path)
    capture(FakePage(), media, export)
    statuses, _ = capture(FakePage(), media, export, need_subtitle=False, keep_media=True)
    assert media.extractions == 2
    assert [status["mediaSaved"] for status in statuses] == [True, True]
    assert len(list(export.rglob("*.mp4"))) == 2
    capture(FakePage(), media, export, keep_media=True)
    assert media.extractions == 2


def test_zero_byte_transcript_is_repaired(tmp_path):
    export = tmp_path / "exports"
    path = export / "subtitle" / "课程" / "20260901-教师" / "20260901-1_transcript.txt"
    path.parent.mkdir(parents=True)
    path.touch()
    capture(FakePage(count=1), FakeMediaWorker(tmp_path), export)
    assert path.read_text() == "字幕 0"


def test_capture_cancellation_removes_listeners_and_preserves_existing_media(tmp_path):
    page = FakePage(count=1, subtitle_indices=())
    media = FakeMediaWorker(tmp_path)
    export = tmp_path / "exports"
    existing = export / "media" / "课程" / "20260901-教师" / "20260901-1.mp4"
    existing.parent.mkdir(parents=True)
    existing.write_bytes(b"user media")
    event = threading.Event()
    def cancel_extraction(*_args, **_kwargs):
        event.set()
        raise TaskCancelledError("任务已取消")
    media.extract_media = cancel_extraction
    with pytest.raises(TaskCancelledError):
        list(execute_video_task(page, "fake", media, export, event, target_date="2026-09-01",
                                need_subtitle=True, need_ppt=True))
    assert existing.read_bytes() == b"user media"
    assert page.removed and page.unroutes
    assert media.cleanup_count == 1


def test_worker_pre_cancelled_mutation_never_dispatches(monkeypatch):
    from seudaily import worker
    calls = []
    messages = [{"type": "cancel", "requestId": "cancelled"},
                {"requestId": "cancelled", "action": "save-schedule-customizations", "payload": {}}]
    monkeypatch.setattr(worker.sys, "stdin", StringIO("\n".join(map(json.dumps, messages)) + "\n"))
    monkeypatch.setattr(worker, "migrate_runtime_directory", lambda *_: {"errors": [], "skipped": []})
    monkeypatch.setattr(worker, "dispatch", lambda request: calls.append(request))
    outputs = []
    monkeypatch.setattr(worker, "_write", outputs.append)
    worker.main()
    assert not calls
    assert outputs[0]["result"]["status"] == "cancelled"


def test_batch_capture_runs_on_browser_owner_thread(monkeypatch):
    runtime = BrowserRuntime()
    runtime._assert_thread()
    service = CourseService()
    seen = []
    def run(**_kwargs):
        runtime._assert_thread()
        seen.append(threading.get_ident())
        return {"status": "completed"}
    monkeypatch.setattr(service, "capture_course_session", run)
    result = service.capture_course_sessions(sessions=[
        {"courseName": name, "teacherName": "teacher", "weeklyPeriods": [1]} for name in ("A", "B")])
    assert result["effectiveConcurrency"] == 1
    assert result["completed"] == 2
    assert seen == [threading.get_ident()] * 2


def test_browser_restarts_when_cached_context_is_disconnected(monkeypatch):
    import seudaily.browser_runtime as browser_module
    runtime = BrowserRuntime()
    runtime._playwright = MagicMock()
    old_browser = MagicMock()
    old_browser.is_connected.return_value = False
    runtime._browser = old_browser
    old_context = MagicMock()
    runtime._contexts["course"] = old_context
    new_browser = MagicMock()
    context = new_browser.new_context.return_value
    context.pages = []
    monkeypatch.setattr(browser_module, "launch_browser", lambda *_args, **_kwargs: new_browser)
    try:
        with runtime.page("course", visible=False, context_options={}):
            pass
        old_browser.is_connected.assert_called_once()
        old_context.new_page.assert_not_called()
        context.new_page.assert_called_once()
    finally:
        runtime.close()


def test_focus_uses_alternate_api_key_value(monkeypatch):
    import seudaily.focus as focus
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    monkeypatch.setenv("SEUDAILY_LLM_API_KEY", "offline-test-key")
    client = MagicMock()
    monkeypatch.setattr(focus, "OpenAI", client)
    focus.FocusSemanticModel()
    assert client.call_args.kwargs["api_key"] == "offline-test-key"


def test_unavailable_asr_still_has_media_downloader():
    worker = CourseService()._build_asr_worker(engine="local", model_path=None, api_key=None, model="test")
    assert isinstance(worker, cloud.MediaWorker)
    with pytest.raises(RuntimeError, match="本地 ASR"):
        worker.transcribe_and_export("test")


@pytest.mark.parametrize("exitcode", [0, 7])
def test_ffmpeg_checks_output_and_exit_code(monkeypatch, tmp_path, exitcode):
    worker = cloud.MediaWorker({}, tmp_path)
    process = MagicMock(returncode=exitcode)
    process.poll.return_value = exitcode
    def execute(command, **_kwargs):
        if exitcode == 0:
            Path(worker.temp_video_path).write_bytes(b"video")
            Path(worker.temp_audio_path).write_bytes(b"audio")
        return process
    monkeypatch.setattr(cloud.subprocess, "Popen", execute)
    if exitcode:
        with pytest.raises(RuntimeError, match="退出码 7"):
            worker.extract_media("https://example.invalid/?auth_key=secret", "fake")
        assert worker.workspace.path is None
    else:
        worker.extract_media("fake", "fake")
        assert Path(worker.temp_audio_path).exists()
        worker._cleanup()


def test_ffmpeg_missing_output_is_not_success(monkeypatch, tmp_path):
    process = MagicMock(returncode=0)
    process.poll.return_value = 0
    monkeypatch.setattr(cloud.subprocess, "Popen", lambda *_args, **_kwargs: process)
    worker = cloud.MediaWorker({}, tmp_path)
    with pytest.raises(RuntimeError, match="未生成有效媒体"):
        worker.extract_media("fake", "fake")
    assert worker.workspace.path is None


@pytest.mark.parametrize("cancel", [False, True])
def test_ffmpeg_timeout_or_cancel_reaps_only_media_child(monkeypatch, tmp_path, cancel):
    event = threading.Event()
    set_current_cancel_event(event)
    process = MagicMock()
    process.poll.return_value = None
    def communicate(timeout):
        if cancel:
            event.set()
        raise subprocess.TimeoutExpired("ffmpeg", timeout)
    process.communicate.side_effect = communicate
    monkeypatch.setattr(cloud.subprocess, "Popen", lambda *_args, **_kwargs: process)
    worker = cloud.MediaWorker({"media_timeout_seconds": 0.01}, tmp_path)
    with pytest.raises(TaskCancelledError if cancel else TimeoutError):
        worker.extract_media("fake", "fake")
    process.kill.assert_called_once()
    process.wait.assert_called_once()
    assert worker.workspace.path is None


def _slow_recognition(connection, *_args):
    time.sleep(30)


def _successful_recognition(connection, *_args):
    connection.send({"text": "offline transcript"})
    connection.close()


def _failed_recognition(connection, *_args):
    connection.send({"error": "offline provider error"})
    connection.close()


@pytest.mark.parametrize("cancel", [False, True])
def test_asr_cancel_or_timeout_reaps_only_asr_child(monkeypatch, tmp_path, cancel):
    audio = tmp_path / "input.mp3"
    audio.write_bytes(b"owned input")
    event = threading.Event()
    set_current_cancel_event(event)
    monkeypatch.setattr(cloud, "_recognize_file", _slow_recognition)
    worker = cloud.CloudASRWorker({"asr_api_key": "test", "asr_timeout_seconds": 10 if cancel else 0.1}, tmp_path)
    worker.temp_audio_path = str(audio)
    stopped = []
    original = cloud._stop_child
    def stop(process):
        original(process)
        stopped.append(not process.is_alive())
    monkeypatch.setattr(cloud, "_stop_child", stop)
    timer = threading.Timer(0.15, event.set) if cancel else None
    if timer:
        timer.start()
    started = time.monotonic()
    try:
        with pytest.raises(TaskCancelledError if cancel else TimeoutError):
            list(worker.transcribe_and_export("test"))
    finally:
        if timer:
            timer.join()
    assert time.monotonic() - started < 2
    assert stopped == [True]
    assert audio.read_bytes() == b"owned input"
    assert not (tmp_path / "test_transcript.txt").exists()


@pytest.mark.parametrize("success", [False, True])
def test_asr_result_or_provider_failure_is_returned_and_child_reaped(monkeypatch, tmp_path, success):
    audio = tmp_path / "input.mp3"
    audio.write_bytes(b"audio")
    monkeypatch.setattr(cloud, "_recognize_file", _successful_recognition if success else _failed_recognition)
    worker = cloud.CloudASRWorker({"asr_api_key": "test"}, tmp_path)
    worker.temp_audio_path = str(audio)
    if success:
        events = list(worker.transcribe_and_export("test"))
        assert events[-1]["done"]
        assert (tmp_path / "test_transcript.txt").read_text() == "offline transcript"
    else:
        with pytest.raises(RuntimeError, match="offline provider error"):
            list(worker.transcribe_and_export("test"))
        assert not (tmp_path / "test_transcript.txt").exists()


def test_recognition_uses_synchronous_result_api(monkeypatch):
    recognition = MagicMock()
    recognition.call.return_value = SimpleNamespace(status_code=200, get_sentence=lambda: [{"text": "result"}])
    constructor = MagicMock(return_value=recognition)
    sdk = SimpleNamespace(api_key=None)
    monkeypatch.setitem(sys.modules, "dashscope", sdk)
    monkeypatch.setitem(sys.modules, "dashscope.audio.asr", SimpleNamespace(Recognition=constructor))
    connection = MagicMock()
    cloud._recognize_file(connection, "audio.mp3", "test", "model")
    recognition.call.assert_called_once_with("audio.mp3")
    recognition.stop.assert_not_called()
    connection.send.assert_called_once_with({"text": "result"})
    connection.close.assert_called_once()


@pytest.fixture
def fake_ppt_modules(monkeypatch):
    cap = MagicMock()
    cap.isOpened.return_value = False
    cv = SimpleNamespace(VideoCapture=lambda *_: cap)
    monkeypatch.setitem(sys.modules, "cv2", cv)
    monkeypatch.setitem(sys.modules, "img2pdf", SimpleNamespace(convert=MagicMock()))
    old = sys.modules.pop("seudaily.ppt", None)
    module = importlib.import_module("seudaily.ppt")
    yield module, cap, cv
    sys.modules.pop("seudaily.ppt", None)
    if old:
        sys.modules["seudaily.ppt"] = old


@pytest.mark.parametrize("interval", [0, -1, float("inf"), float("nan")])
def test_slides_reject_invalid_interval_before_dependency_import(interval, tmp_path):
    from seudaily.service import extract_slides
    with pytest.raises(ValueError, match="intervalSec"):
        extract_slides(video_path="fake", output_dir=str(tmp_path), task_name="test", interval_sec=interval)


def test_ppt_open_failure_releases_capture_and_temp_directory(fake_ppt_modules, tmp_path):
    module, cap, _ = fake_ppt_modules
    extractor = module.PPTExtractor("fake", str(tmp_path), "test")
    with pytest.raises(RuntimeError, match="无法打开"):
        list(extractor.extract_and_build_pdf())
    cap.release.assert_called_once()
    assert not extractor.temp_dir.exists()


def test_ppt_cancellation_releases_capture_and_preserves_existing_pdf(fake_ppt_modules, tmp_path):
    module, cap, cv = fake_ppt_modules
    event = threading.Event()
    set_current_cancel_event(event)
    cv.CAP_PROP_FPS = 1
    cv.CAP_PROP_FRAME_COUNT = 2
    cv.CAP_PROP_FRAME_WIDTH = 3
    cv.CAP_PROP_FRAME_HEIGHT = 4
    cv.CAP_PROP_POS_FRAMES = 5
    cap.isOpened.return_value = True
    cap.get.side_effect = lambda field: {1: 25, 2: 100, 3: 100, 4: 100}[field]
    def read():
        event.set()
        return True, object()
    cap.read.side_effect = read
    existing = tmp_path / "test_PPT.pdf"
    existing.write_bytes(b"existing")
    extractor = module.PPTExtractor("fake", str(tmp_path), "test")
    with pytest.raises(TaskCancelledError):
        list(extractor.extract_and_build_pdf())
    assert existing.read_bytes() == b"existing"
    cap.release.assert_called_once()
    assert not extractor.temp_dir.exists()


def test_visible_browser_creation_failure_still_closes_browser(monkeypatch):
    import seudaily.browser_runtime as browser_module
    runtime = BrowserRuntime()
    runtime._playwright = MagicMock()
    browser = MagicMock()
    browser.new_context.side_effect = RuntimeError("offline context failure")
    monkeypatch.setattr(browser_module, "launch_browser", lambda *_args, **_kwargs: browser)
    try:
        with pytest.raises(RuntimeError, match="context failure"):
            with runtime.page("course", visible=True, context_options={}):
                pass
        browser.close.assert_called_once()
    finally:
        runtime.close()


@pytest.mark.parametrize("cancel_during_pdf", [False, True])
def test_ppt_build_is_atomic_and_always_cleans_slices(fake_ppt_modules, tmp_path, monkeypatch, cancel_during_pdf):
    module, cap, cv = fake_ppt_modules
    event = threading.Event()
    set_current_cancel_event(event)
    cv.CAP_PROP_FPS = 1
    cv.CAP_PROP_FRAME_COUNT = 2
    cv.CAP_PROP_FRAME_WIDTH = 3
    cv.CAP_PROP_FRAME_HEIGHT = 4
    cv.CAP_PROP_POS_FRAMES = 5
    cv.COLOR_BGR2GRAY = 6
    cv.cvtColor = lambda *_args: object()
    cv.GaussianBlur = lambda *_args: object()
    encoded = SimpleNamespace(tofile=lambda name: Path(name).write_bytes(b"image"))
    cv.imencode = lambda *_args: (True, encoded)
    cap.isOpened.return_value = True
    cap.get.side_effect = lambda field: {1: 25, 2: 1, 3: 100, 4: 100}[field]
    cap.read.return_value = (True, object())
    def convert(_images, outputstream):
        outputstream.write(b"%PDF-test")
        if cancel_during_pdf:
            event.set()
    monkeypatch.setattr(module.img2pdf, "convert", convert)
    output = tmp_path / "test_PPT.pdf"
    output.write_bytes(b"previous PDF")
    extractor = module.PPTExtractor("fake", str(tmp_path), "test", interval_sec=0.001)
    if cancel_during_pdf:
        with pytest.raises(TaskCancelledError):
            list(extractor.extract_and_build_pdf())
        assert output.read_bytes() == b"previous PDF"
    else:
        list(extractor.extract_and_build_pdf())
        assert output.read_bytes() == b"%PDF-test"
    cap.release.assert_called_once()
    assert not extractor.temp_dir.exists()
    assert list(tmp_path.iterdir()) == [output]


def test_existing_video_with_expired_remote_url_can_fill_transcript_and_ppt(monkeypatch, tmp_path):
    export = tmp_path / "exports"
    video = export / "media" / "课程" / "20260901-教师" / "20260901-1.mp4"
    video.parent.mkdir(parents=True)
    video.write_bytes(b"owned video")
    page = FakePage(count=1, subtitle_indices=())
    page.video_url = None
    media = FakeMediaWorker(tmp_path)
    extraction_calls = []
    def extract(source, referer, audio_only):
        extraction_calls.append((source, audio_only))
    def transcribe(name):
        output = media.export_base_dir / f"{name}_transcript.txt"
        output.write_text("local video transcript")
        yield {"done": True, "txt_path": str(output)}
    media.extract_media = extract
    media.transcribe_and_export = transcribe
    slide_sources = []
    class Slides:
        def __init__(self, video_path, output_dir, task_name, **_kwargs):
            slide_sources.append(video_path)
            self.output = Path(output_dir) / f"{task_name}_PPT.pdf"
        def extract_and_build_pdf(self, **_kwargs):
            self.output.write_bytes(b"%PDF-local-video")
            yield "slides complete"
    monkeypatch.setitem(sys.modules, "seudaily.ppt", SimpleNamespace(PPTExtractor=Slides))
    statuses, _ = capture(page, media, export, keep_media=True, need_ppt=True)
    assert extraction_calls == [(str(video), True)]
    assert slide_sources == [str(video)]
    assert video.read_bytes() == b"owned video"
    assert list(export.rglob("*_transcript.txt"))[0].read_text() == "local video transcript"
    assert list(export.rglob("*_PPT.pdf"))[0].read_bytes() == b"%PDF-local-video"
    assert statuses[0]["asrCompleted"] is True


@pytest.mark.parametrize("remote", [False, True])
def test_ffmpeg_applies_referer_only_to_http_inputs(monkeypatch, tmp_path, remote):
    worker = cloud.MediaWorker({}, tmp_path)
    commands = []
    process = MagicMock(returncode=0)
    process.poll.return_value = 0
    def start(command, **_kwargs):
        commands.append(command)
        Path(worker.temp_audio_path).write_bytes(b"extracted audio")
        return process
    monkeypatch.setattr(cloud.subprocess, "Popen", start)
    source = "https://example.invalid/input.mp4" if remote else str(tmp_path / "owned-video.mp4")
    worker.extract_media(source, "https://example.invalid/referer", audio_only=True)
    assert ("-headers" in commands[0]) is remote
    assert commands[0][commands[0].index("-i") + 1] == source
    assert worker.temp_video_path not in commands[0]
    worker._cleanup()


@pytest.mark.parametrize(("options", "count"), [
    ({"target_sequence": 2}, 1),
    ({"target_date": "全部日期"}, 2),
    ({}, 2),
])
def test_capture_selection_handles_specific_sequence_all_dates_and_latest(tmp_path, options, count):
    page = FakePage()
    statuses = []
    export = tmp_path / "exports"
    list(execute_video_task(page, "fake", FakeMediaWorker(tmp_path), export,
                            threading.Event(), capture_status=statuses, **options))
    assert len(list(export.rglob("*_transcript.txt"))) == count
    assert len(statuses) == count
    assert page.unroutes == 1
