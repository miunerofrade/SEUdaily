#local_asr_worker.py
import os
import subprocess
import warnings
import sys
import json
from pathlib import Path

from cvstream.subprocess_utils import hidden_process_options

os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"
os.environ["OMP_NUM_THREADS"] = "1"
warnings.filterwarnings("ignore")

def format_time(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds - int(seconds)) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

class LocalASRWorker:
    def __init__(self, model_path: str, export_base_dir: str):
        self.model_path = model_path
        self.export_base_dir = Path(export_base_dir)
        self.temp_video_path = self._determine_temp_path()
        self.current_process = None  
        self.cleanup_temp_media = True

    def _determine_temp_path(self):
        if os.path.exists("R:\\"): return "R:/temp_video.mp4"
        local_temp_dir = Path("./temp_workspace")
        local_temp_dir.mkdir(exist_ok=True)
        return str(local_temp_dir / "temp_video.mp4")

    def extract_media(self, video_url: str, referer_url: str, audio_only: bool = False):
        if os.path.exists(self.temp_video_path):
            try: os.remove(self.temp_video_path)
            except OSError: pass

        ffmpeg_cmd = ['ffmpeg', '-headers', f'Referer: {referer_url}\r\n', '-i', video_url]
        if audio_only: ffmpeg_cmd.extend(['-vn', '-c:a', 'copy'])
        else: ffmpeg_cmd.extend(['-c', 'copy'])
        ffmpeg_cmd.extend(['-y', self.temp_video_path])
       
        self.current_process = subprocess.Popen(
            ffmpeg_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            **hidden_process_options(),
        )
        stdout, stderr = self.current_process.communicate()
        
        if self.current_process.returncode != 0 and self.current_process.returncode != -9: 
            raise RuntimeError(f"FFmpeg 处理失败: {stderr.decode('utf-8', 'ignore')}")

    def transcribe_and_export(self, task_name: str, generate_srt: bool = False):
        if not os.path.exists(self.temp_video_path):
            raise FileNotFoundError(f"未找到待处理媒体: {self.temp_video_path}")
            
        task_dir = Path(self.export_base_dir)
        task_dir.mkdir(parents=True, exist_ok=True)
        txt_file = task_dir / f"{task_name}_transcript.txt"
        

        cmd = [
            sys.executable, "-m", "cvstream.asr.local",
            "--model", self.model_path,
            "--video", self.temp_video_path,
            "--txt", str(txt_file)
        ]
        
        
        self.current_process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            **hidden_process_options(),
        )
        
        
        for line in self.current_process.stdout:
            line = line.strip()
            if line:
                try:
                    data = json.loads(line)
                    yield data  
                except json.JSONDecodeError:
                    pass

        self.current_process.wait()
        if self.current_process.returncode != 0 and self.current_process.returncode != -9:
            stderr_output = self.current_process.stderr.read()
            raise RuntimeError(f"ASR 子进程异常: {stderr_output}")

        self._cleanup()
        yield {"task_name": task_name, "txt_path": str(txt_file), "progress": 1.0, "done": True}

    def abort(self):
        """【新增】：强杀当前正在运行的 FFmpeg 或 ASR 进程，并清理残骸"""
        if self.current_process and self.current_process.poll() is None:
            self.current_process.kill()
        self._cleanup()

    def _cleanup(self):
        if self.cleanup_temp_media and os.path.exists(self.temp_video_path):
            try: os.remove(self.temp_video_path)
            except OSError: pass


if __name__ == "__main__":
    import argparse
    import sys
    import os  
    import json
    from faster_whisper import WhisperModel

    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--video", required=True)
    parser.add_argument("--txt", required=True)
    parser.add_argument("--srt", required=False)
    
    args = parser.parse_args()

    try:
        model = WhisperModel(args.model, device="cuda", compute_type="float16")
        
        segments, info = model.transcribe(
            args.video, beam_size=5, language="zh", vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=800, threshold=0.3)
        )
        
        total_duration = info.duration
        
        with open(args.txt, "w", encoding="utf-8") as f_txt:
            for seg in segments:
                f_txt.write(seg.text.strip() + "\n\n")
                f_txt.flush()
                
                progress = min(seg.end / total_duration, 1.0) if total_duration > 0 else 0
                print(json.dumps({"progress": progress, "text": seg.text.strip()}), flush=True)
        
        os._exit(0) 
    except Exception as e:
        sys.stderr.write(str(e))
        os._exit(1)
