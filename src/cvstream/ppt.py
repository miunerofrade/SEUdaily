import os
import cv2
import numpy as np
import img2pdf
import shutil
import time
from pathlib import Path

class PPTExtractor:
    def __init__(self, video_path: str, output_dir: str, task_name: str, 
                 interval_sec: int = 10, diff_threshold: float = 2.0):
        self.video_path = video_path
        self.output_dir = Path(output_dir)
        self.task_name = task_name
        self.interval_sec = interval_sec
         
        self.diff_threshold = diff_threshold 
        
        self.temp_dir = self.output_dir / f".temp_ppt_{self.task_name}"
        self.temp_dir.mkdir(parents=True, exist_ok=True)

    def _get_time(self):
        return time.strftime('%H:%M:%S')

    def extract_and_build_pdf(self, ignore_bottom_right_ratio=0.25):
        """
        保持接口签名不变，但内部逻辑已针对纯 PPT 画面重写。
        参数 ignore_bottom_right_ratio 将被静默忽略。
        """
        yield f"[{self._get_time()}] 🎬 初始化视觉引擎 (纯净画面模式), 加载源: {Path(self.video_path).name}"
        
        cap = cv2.VideoCapture(self.video_path)
        if not cap.isOpened():
            yield f"[{self._get_time()}] ❌ OpenCV 无法打开视频文件。"
            return

        fps = cap.get(cv2.CAP_PROP_FPS)
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        if fps <= 0 or total_frames <= 0:
            yield f"[{self._get_time()}] ❌ 无法读取视频元数据。"
            cap.release()
            return

        duration_sec = total_frames / fps
        frame_step = int(fps * self.interval_sec)
        
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        total_pixels = width * height
        
        yield f"[{self._get_time()}] 📊 分辨率: {width}x{height}, 步长: 每{self.interval_sec}秒/帧"

        prev_gray = None
        slide_count = 0
        saved_images = []
        current_frame = 0

        while current_frame < total_frames:
             
            cap.set(cv2.CAP_PROP_POS_FRAMES, current_frame)
            ret, frame = cap.read()
            if not ret:
                break
                
             
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            gray = cv2.GaussianBlur(gray, (5, 5), 0)

            is_new_slide = False
            if prev_gray is None:
                is_new_slide = True 
            else:
                
                diff = cv2.absdiff(gray, prev_gray)
                
                _, thresh = cv2.threshold(diff, 15, 255, cv2.THRESH_BINARY)
                changed_pixels = cv2.countNonZero(thresh)
                ratio = (changed_pixels / total_pixels) * 100
                
                if ratio > self.diff_threshold:
                    is_new_slide = True

            if is_new_slide:
                slide_count += 1
                img_name = self.temp_dir / f"slide_{slide_count:04d}.jpg"
                
                cv2.imencode('.jpg', frame)[1].tofile(str(img_name))
                
                saved_images.append(str(img_name))
                prev_gray = gray
                
                yield f"[{self._get_time()}] 📸 捕获新页面 -> 第 {slide_count} 页 (变动率: {ratio if 'ratio' in locals() else 100:.2f}%)"

            current_frame += frame_step

        cap.release()
        
        if not saved_images:
            yield f"[{self._get_time()}] ⚠️ 画面完全静止，取消 PDF 生成。"
        else:
            yield f"[{self._get_time()}] 📑 画面扫描完毕，共提取 {slide_count} 页，正在合并 PDF..."
            pdf_path = self.output_dir / f"{self.task_name}_PPT.pdf"
            
            try:
                saved_images.sort() 
                with open(pdf_path, "wb") as f:
                    f.write(img2pdf.convert(saved_images))
                yield f"[{self._get_time()}] ✅ PDF 归档成功: {pdf_path.name}"
            except Exception as e:
                yield f"[{self._get_time()}] ❌ PDF 生成失败: {e}"

        yield f"[{self._get_time()}] 🧹 清理临时切片缓存..."
        if self.temp_dir.exists():
            shutil.rmtree(self.temp_dir, ignore_errors=True)