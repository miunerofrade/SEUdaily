"""Media extraction and isolated, cancellable cloud recognition."""
from __future__ import annotations

import math
import multiprocessing
import os
import subprocess
import tempfile
import time
from pathlib import Path
from urllib.parse import urlsplit

from seudaily.cancellation import raise_if_cancelled
from seudaily.subprocess_utils import hidden_process_options
from seudaily.ramdisk import TemporaryWorkspace
from seudaily.vpn import campus_proxy


def _timeout(config: dict, name: str, default: float) -> float:
    value = float(config.get(name, default))
    if not math.isfinite(value) or value <= 0:
        raise ValueError(f"{name} 必须为有限正数")
    return value


class MediaWorker:
    """Download media without requiring an ASR engine or API credentials."""

    def __init__(self, config, export_base_dir):
        self.config = config
        self.export_base_dir = Path(export_base_dir)
        self.workspace = TemporaryWorkspace()
        self.temp_audio_path = ""
        self.temp_video_path = ""
        self.current_process = None

    def extract_media(self, video_url: str, referer_url: str, audio_only: bool = False):
        raise_if_cancelled()
        timeout = _timeout(self.config, "media_timeout_seconds", 1800)
        self._cleanup()
        scratch = self.workspace.open()
        self.temp_audio_path = str(scratch / "audio.mp3")
        self.temp_video_path = str(scratch / "video.mp4")
        command = ["ffmpeg", "-nostdin"]
        if urlsplit(video_url).scheme.lower() in {"http", "https"}:
            proxy = campus_proxy()
            host = (urlsplit(video_url).hostname or '').lower()
            referer_host = (urlsplit(referer_url).hostname or '').lower()
            if proxy and (host.endswith('.seu.edu.cn') or referer_host == 'cvs.seu.edu.cn'):
                command.extend(['-http_proxy', proxy])
            command.extend(["-headers", f"Referer: {referer_url}\r\n"])
        command.extend(["-i", video_url])
        if not audio_only:
            command.extend(["-c", "copy", "-y", self.temp_video_path])
        command.extend(["-vn", "-acodec", "libmp3lame", "-ar", "16000", "-ac", "1", "-q:a", "9", "-y", self.temp_audio_path])
        deadline = time.monotonic() + timeout
        try:
            # FFmpeg diagnostics can contain signed URLs; unused output is discarded.
            self.current_process = subprocess.Popen(
                command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **hidden_process_options()
            )
            while True:
                raise_if_cancelled()
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("媒体下载超过处理时限")
                try:
                    self.current_process.communicate(timeout=min(0.2, remaining))
                    break
                except subprocess.TimeoutExpired:
                    continue
            raise_if_cancelled()
            if self.current_process.returncode != 0:
                raise RuntimeError(f"FFmpeg 媒体处理失败（退出码 {self.current_process.returncode}）")
            expected = [Path(self.temp_audio_path)]
            if not audio_only:
                expected.append(Path(self.temp_video_path))
            if any(not path.is_file() or path.stat().st_size == 0 for path in expected):
                raise RuntimeError("FFmpeg 未生成有效媒体文件")
        except BaseException:
            self.abort()
            raise
        finally:
            self.current_process = None

    def abort(self):
        if self.current_process and self.current_process.poll() is None:
            self.current_process.kill()
            self.current_process.wait(timeout=5)
        self._cleanup()

    def _cleanup(self):
        # Imported audio belongs to the user; only our workspace is disposable.
        self.workspace.close()


def _recognize_file(connection, audio_path: str, api_key: str, model: str) -> None:
    """Spawn target: isolate SDK threads, sockets, globals and blocking calls."""
    try:
        import dashscope
        from dashscope.audio.asr import Recognition

        dashscope.api_key = api_key
        no_proxy = os.environ.get("no_proxy", "")
        os.environ["no_proxy"] = ",".join(filter(None, [no_proxy, "dashscope.aliyuncs.com"]))
        recognition = Recognition(
            model=model, format="wav" if Path(audio_path).suffix.lower() == ".wav" else "mp3",
            sample_rate=16000, callback=None,
        )
        # stop() in asynchronous mode returns None; call() returns the result.
        result = recognition.call(audio_path)
        if result.status_code != 200:
            raise RuntimeError(f"云端拒绝处理 ({result.status_code}): {result.message}")
        sentences = result.get_sentence() or []
        text = "".join(sentence.get("text", "") for sentence in sentences).strip()
        if not text:
            raise RuntimeError("云端未返回有效转写文本")
        connection.send({"text": text})
    except Exception as exc:
        connection.send({"error": str(exc)})
    finally:
        connection.close()


def _stop_child(process) -> None:
    if process.is_alive():
        process.terminate()
    process.join(timeout=1)
    if process.is_alive():
        process.kill()
        process.join(timeout=1)


class CloudASRWorker(MediaWorker):
    def __init__(self, config, export_base_dir):
        super().__init__(config, export_base_dir)
        self.api_key = config.get("asr_api_key", "").strip()
        self.model_version = config.get("asr_model_version", "paraformer-realtime-v2")

    def transcribe_and_export(self, task_name: str):
        raise_if_cancelled()
        if not Path(self.temp_audio_path).is_file():
            raise FileNotFoundError(f"未找到待处理音频: {self.temp_audio_path}")
        if not self.api_key:
            raise ValueError("未配置 ASR API 密钥。")
        from seudaily.optional_runtime import ensure_dependencies
        ensure_dependencies("asr")
        timeout = _timeout(self.config, "asr_timeout_seconds", 900)
        yield {"progress": 0.1, "text": f"正在初始化云端转写 (请求模型: {self.model_version})..."}
        context = multiprocessing.get_context("spawn")
        receiver, sender = context.Pipe(duplex=False)
        process = context.Process(
            target=_recognize_file, args=(sender, self.temp_audio_path, self.api_key, self.model_version),
            daemon=True,
        )
        started = False
        try:
            raise_if_cancelled()
            process.start()
            started = True
            sender.close()
            deadline = time.monotonic() + timeout
            while True:
                raise_if_cancelled()
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("云端 ASR 超过处理时限")
                if receiver.poll(min(0.2, remaining)):
                    try:
                        result = receiver.recv()
                    except EOFError as exc:
                        raise RuntimeError("ASR 子进程未返回结果") from exc
                    break
                if not process.is_alive():
                    raise RuntimeError(f"ASR 子进程异常退出 ({process.exitcode})")
            raise_if_cancelled()
            if result.get("error"):
                raise RuntimeError(f"ASR 云端引擎崩溃: {result['error']}")
            text = result["text"]
            task_dir = Path(self.export_base_dir)
            task_dir.mkdir(parents=True, exist_ok=True)
            txt_file = task_dir / f"{task_name}_transcript.txt"
            # Replace atomically so cancellation/failure cannot poison incremental caches.
            temporary = None
            try:
                with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=task_dir, delete=False) as handle:
                    temporary = Path(handle.name)
                    handle.write(text)
                raise_if_cancelled()
                os.replace(temporary, txt_file)
            finally:
                if temporary is not None:
                    temporary.unlink(missing_ok=True)
            yield {"task_name": task_name, "txt_path": str(txt_file), "progress": 1.0, "done": True}
        finally:
            receiver.close()
            sender.close()
            if started:
                _stop_child(process)
                process.close()
