# asr_cloud.py
import os
import subprocess
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

try:
    import dashscope
    from dashscope.audio.asr import Recognition, RecognitionCallback
except ImportError:
    dashscope = None
    RecognitionCallback = object  # 🌟 兜底：如果没装 SDK，让它继承基础 object，防止类定义时崩溃

class MyRecognitionCallback(RecognitionCallback):
    def on_open(self) -> None: pass
    def on_close(self) -> None: pass
    def on_event(self, result) -> None: pass

class CloudASRWorker:
    def _determine_temp_path(self, ext):
        if os.path.exists("R:\\"): return f"R:/temp_media.{ext}"
        local_temp_dir = Path("./temp_workspace")
        local_temp_dir.mkdir(exist_ok=True)
        return str(local_temp_dir / f"temp_media.{ext}")

    def __init__(self, config, export_base_dir):
        self.config = config
        self.export_base_dir = Path(export_base_dir)
        self.api_key = config.get("asr_api_key", "").strip()
        
        # 🌟 核心修改：读取 UI 中选定的具体 ASR 模型版本
        self.model_version = config.get("asr_model_version", "paraformer-realtime-v2")
        
        self.temp_audio_path = self._determine_temp_path("mp3")
        self.temp_video_path = self._determine_temp_path("mp4")
        self.current_process = None

    def extract_media(self, video_url: str, referer_url: str, audio_only: bool = False):
        self._cleanup()
        
        ffmpeg_cmd = ['ffmpeg', '-headers', f'Referer: {referer_url}\r\n', '-i', video_url]
        
        if not audio_only:
            ffmpeg_cmd.extend(['-c', 'copy', '-y', self.temp_video_path])
            
        ffmpeg_cmd.extend([
            '-vn', '-acodec', 'libmp3lame', 
            '-ar', '16000', '-ac', '1', '-q:a', '9', 
            '-y', self.temp_audio_path
        ])
        
        self.current_process = subprocess.Popen(ffmpeg_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.current_process.communicate()

    def transcribe_and_export(self, task_name: str):
        if not os.path.exists(self.temp_audio_path):
            raise FileNotFoundError(f"未找到待处理音频: {self.temp_audio_path}")
        if not self.api_key:
            raise ValueError("未配置 ASR API 密钥。")

        os.environ['no_proxy'] = 'dashscope.aliyuncs.com'

        task_dir = Path(self.export_base_dir)
        task_dir.mkdir(parents=True, exist_ok=True)
        txt_file = task_dir / f"{task_name}_transcript.txt"
        
        yield {"progress": 0.1, "text": f"正在初始化阿里云 WebSocket (请求模型: {self.model_version})..."}

        try:
            try:
                import dashscope
                from dashscope.audio.asr import Recognition
            except ImportError:
                raise RuntimeError("缺少阿里云官方 SDK！请在终端运行: uv pip install dashscope")
            
            dashscope.api_key = self.api_key
            file_ext = self.temp_audio_path.split('.')[-1].lower()
            file_format = 'wav' if file_ext == 'wav' else 'mp3'
            
            callback = MyRecognitionCallback()
            # 🌟 动态调用：将 UI 选定的模型传入官方 SDK
            recognition = Recognition(model=self.model_version,
                                      format=file_format,
                                      sample_rate=16000,
                                      callback=callback)
            
            recognition.start()
            file_size = os.path.getsize(self.temp_audio_path)
            sent_size = 0
            
            with open(self.temp_audio_path, 'rb') as f:
                for chunk in iter(lambda: f.read(3200), b''):
                    recognition.send_audio_frame(chunk)
                    sent_size += len(chunk)
                    
                    if sent_size % (1024 * 512) < 3200:
                        p_val = 0.1 + (sent_size / file_size) * 0.7
                        yield {"progress": p_val, "text": f"云端持续推流: {sent_size//(1024*1024)}MB / {file_size//(1024*1024)}MB (网络传输较慢，请耐心等待)"}
            
            yield {"progress": 0.85, "text": "音频传输完毕，等待云端完成最终推理 (可能需等候数分钟)..."}
            
            result = recognition.stop()
            
            if result.status_code == 200:
                sentences = result.get_sentence()
                if sentences: transcription = "".join([s.get("text", "") for s in sentences])
                else: transcription = result.output.get("sentence", [{}])[0].get("text", "")

                with open(txt_file, "w", encoding="utf-8") as f_txt:
                    f_txt.write(transcription.strip())
                
                yield {"progress": 0.95, "text": "云端转写收尾完成。"}
            else:
                raise RuntimeError(f"云端拒绝处理 ({result.status_code}): {result.message}")

        except Exception as e:
            raise RuntimeError(f"ASR 云端引擎崩溃: {str(e)}")
            
        yield {"task_name": task_name, "txt_path": str(txt_file), "progress": 1.0, "done": True}

    def abort(self):
        if self.current_process and self.current_process.poll() is None:
            self.current_process.kill()
        self._cleanup()

    def _cleanup(self):
        for path in [self.temp_audio_path, self.temp_video_path]:
            if os.path.exists(path):
                try: os.remove(path)
                except: pass