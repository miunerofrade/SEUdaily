from __future__ import annotations

import math
import os
import shutil
import tempfile
import time
from pathlib import Path

import cv2
import img2pdf

from .cancellation import raise_if_cancelled


class PPTExtractor:
    def __init__(self, video_path: str, output_dir: str, task_name: str,
                 interval_sec: int = 10, diff_threshold: float = 2.0):
        if not math.isfinite(interval_sec) or interval_sec <= 0:
            raise ValueError("intervalSec 必须为有限正数")
        self.video_path = video_path
        self.output_dir = Path(output_dir)
        self.task_name = task_name
        self.interval_sec = interval_sec
        self.diff_threshold = diff_threshold
        # Allocate on extraction, with a unique name to avoid cross-task cleanup.
        self.temp_dir: Path | None = None

    def _get_time(self):
        return time.strftime('%H:%M:%S')

    def extract_and_build_pdf(self, ignore_bottom_right_ratio=0.25):
        raise_if_cancelled()
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.temp_dir = Path(tempfile.mkdtemp(prefix=".temp_ppt_", dir=self.output_dir))
        cap = None
        temporary_pdf = None
        try:
            yield f"[{self._get_time()}] 初始化视觉引擎，加载源: {Path(self.video_path).name}"
            cap = cv2.VideoCapture(self.video_path)
            if not cap.isOpened():
                raise RuntimeError("OpenCV 无法打开视频文件")
            fps = cap.get(cv2.CAP_PROP_FPS)
            total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
            if not math.isfinite(fps) or fps <= 0 or total_frames <= 0:
                raise ValueError("无法读取有效视频元数据")
            frame_step = max(1, int(fps * self.interval_sec))
            width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
            total_pixels = width * height
            if total_pixels <= 0:
                raise ValueError("视频分辨率无效")
            yield f"[{self._get_time()}] 分辨率: {width}x{height}，每 {self.interval_sec} 秒抽帧"
            previous = None
            saved_images = []
            for current_frame in range(0, total_frames, frame_step):
                raise_if_cancelled()
                cap.set(cv2.CAP_PROP_POS_FRAMES, current_frame)
                success, frame = cap.read()
                raise_if_cancelled()
                if not success:
                    break
                gray = cv2.GaussianBlur(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), (5, 5), 0)
                ratio = 100.0
                if previous is not None:
                    diff = cv2.absdiff(gray, previous)
                    _, threshold = cv2.threshold(diff, 15, 255, cv2.THRESH_BINARY)
                    ratio = cv2.countNonZero(threshold) / total_pixels * 100
                if previous is None or ratio > self.diff_threshold:
                    image = self.temp_dir / f"slide_{len(saved_images) + 1:04d}.jpg"
                    success, encoded = cv2.imencode('.jpg', frame)
                    if not success:
                        raise RuntimeError("PPT 切片编码失败")
                    encoded.tofile(str(image))
                    saved_images.append(str(image))
                    previous = gray
                    yield f"[{self._get_time()}] 捕获第 {len(saved_images)} 页 (变动率: {ratio:.2f}%)"
            if not saved_images:
                raise RuntimeError("未提取到有效幻灯片")
            raise_if_cancelled()
            with tempfile.NamedTemporaryFile(dir=self.output_dir, suffix=".pdf", delete=False) as target:
                temporary_pdf = Path(target.name)
                # Stream to disk instead of building another complete PDF in memory.
                img2pdf.convert(saved_images, outputstream=target)
            raise_if_cancelled()
            pdf_path = self.output_dir / f"{self.task_name}_PPT.pdf"
            os.replace(temporary_pdf, pdf_path)
            yield f"[{self._get_time()}] PDF 归档成功: {pdf_path.name}"
        finally:
            if cap is not None:
                cap.release()
            if temporary_pdf is not None:
                temporary_pdf.unlink(missing_ok=True)
            if self.temp_dir is not None:
                shutil.rmtree(self.temp_dir, ignore_errors=True)
