import time
import re
import json
import shutil
from pathlib import Path
from .ppt import PPTExtractor

def sanitize_filename(name):
    if not name: return ""
    cleaned = re.sub(r'[\\/*?:"<>|]', "-", str(name))
    cleaned = re.sub(r'\s+', ' ', cleaned).strip()
    return cleaned

def format_ms_to_srt(ms: int) -> str:
    seconds = ms / 1000.0
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms_rem = int((seconds - int(seconds)) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms_rem:03d}"

def process_official_json(json_data: dict, task_dir: Path, task_name: str):
    txt_path = task_dir / f"{task_name}_transcript.txt" 
    data_dict = json_data.get("data")
    if not data_dict: raise ValueError("JSON 中未找到 'data' 字段")
    assembly_list = data_dict.get("afterAssemblyList", [])
    if not assembly_list: raise ValueError("字幕列表为空")
    full_text = [item.get("res", "").strip() for item in assembly_list if item.get("res", "").strip()]
    with open(txt_path, "w", encoding="utf-8") as f:
        f.write("\n\n".join(full_text))
    return str(txt_path)

def fetch_dates_only(page):
    try:
        page.locator(".tecl-info").wait_for(state="visible", timeout=15000)
        js_parser = """
        () => {
            const items = Array.from(document.querySelectorAll('.list-item.student'));
            let playlist = [];
            items.forEach((el) => {
                const infoEl = el.querySelector('.bottom-left.sle');
                if (!infoEl) return;
                const match = infoEl.innerText.match(/(\\d{4}-\\d{2}-\\d{2})/);
                if (match) playlist.push({ date: match[1] });
            });
            return playlist; 
        }
        """
        page.locator(".list-item.student").first.wait_for(state="visible", timeout=15000)
        playlist = page.evaluate(js_parser)
        if not playlist: return []
        return sorted(list(set([item['date'] for item in playlist])), reverse=True)
    except Exception as e:
        return []


def find_mp4_url(data):
    """递归遍历 JSON，寻找包含 auth_key 的 .mp4 URL"""
    if isinstance(data, str):
        if ".mp4" in data and "auth_key" in data:
            return data
    elif isinstance(data, dict):
        for v in data.values():
            res = find_mp4_url(v)
            if res: return res
    elif isinstance(data, list):
        for item in data:
            res = find_mp4_url(item)
            if res: return res
    return None

class RouteIsolationCapture:
    """P3 兜底：纯被动物理嗅探器（去除了所有节省带宽的 abort 逻辑）"""
    def __init__(self, page):
        self.page = page
        self.captured_url = None

    def route_handler(self, route):
        url = route.request.url
        if ".mp4" in url or ".m3u8" in url:
            if not self.captured_url and "auth_key" in url:
                self.captured_url = url
            
        route.continue_()

    def activate(self):
        self.captured_url = None
        self.page.route("**/*", self.route_handler)

    def deactivate(self):
        try:
            self.page.unroute("**/*", self.route_handler)
        except:
            pass


def execute_video_task(page, target_url, asr_worker, export_base_dir, stop_event, target_date=None, target_sequence=None, need_subtitle=True, need_ppt=False, keep_media=False):
    def get_time(): return time.strftime('%H:%M:%S')
    
    captured_subtitles = {}
    active_lesson_seq = [-1] 

    def handle_subtitles(response):
        if response.request.method == "OPTIONS" or not response.ok: return
        if "/course/ai/translate/" in response.url:
            try:
                seq = active_lesson_seq[0]
                if seq != -1 and seq not in captured_subtitles:
                    captured_subtitles[seq] = response.json()
            except: pass

    page.on("response", handle_subtitles)
    yield f"[{get_time()}] 正在扫描课程播放列表全局数据..."
    
    # 预定义变量，确保在 try/except 外部也可见
    is_all_dates = False
    target_items = []
    date_formatted = ""
    course_name = "未知课程"
    teacher_name = "未知教师"
    existing_keys = set()  # 已有字幕的 (date, period_seq) 集合
    
    try:
        page.locator(".tecl-info").wait_for(state="visible", timeout=15000)
        raw_course_name = page.locator(".tecl-info .top").inner_text()
        course_name = sanitize_filename(raw_course_name)

        teacher_name = "未命名教师"
        try:
            teacher_locator = page.locator(".tecl-info .bottom .sle").first
            teacher_locator.wait_for(state="attached", timeout=5000) 
            raw_teacher = teacher_locator.get_attribute("title") or teacher_locator.inner_text()
            teacher_name = sanitize_filename(raw_teacher)
        except Exception:
            yield f"[{get_time()}] ⚠️ 老师信息提取失败，退回默认命名。"

        js_parser = """
        () => {
            const items = Array.from(document.querySelectorAll('.list-item.student'));
            let playlist = [];
            items.forEach((el, index) => {
                if (el.classList.contains('can-not-play')) return;
                const infoEl = el.querySelector('.bottom-left.sle');
                const titleEl = el.querySelector('.title.sle');
                if (!infoEl) return;
                const rawInfo = infoEl.innerText;
                const match = rawInfo.match(/(\\d{4}-\\d{2}-\\d{2})\\s+(\\d{2}:\\d{2})/);
                const titleText = titleEl ? titleEl.innerText.trim() : "";
                let periodSeq = index + 1; 
                const seqMatch = titleText.match(/第(\\d+)节/);
                if (seqMatch) periodSeq = parseInt(seqMatch[1], 10);
                if (match) {
                    playlist.push({
                        index: index,              
                        lesson_sequence: index + 1,
                        date: match[1],            
                        time: match[2],            
                        title: titleText,
                        period_seq: periodSeq      
                    });
                }
            });
            return playlist; 
        }
        """
        
        page.locator(".list-item.student").first.wait_for(state="visible", timeout=15000)
        playlist = page.evaluate(js_parser)

        if not playlist: raise ValueError("无法解析播放列表时间数据。")

        all_dates = sorted(list(set([item['date'] for item in playlist])))

        is_all_dates = (target_date == "全部日期") and target_sequence is None

        if target_sequence is not None:
            selected_items = [
                item for item in playlist
                if item.get("lesson_sequence") == target_sequence
            ]
            if not selected_items:
                yield f"[{get_time()}] 未找到课时序号 [{target_sequence}]，已取消抓取。"
                return
            target_items = selected_items
            target_date = selected_items[0]["date"]
            date_formatted = target_date.replace('-', '')
            yield f"[{get_time()}] 已精确锁定课时序号: {target_sequence} ({target_date})"
        elif not target_date or target_date == "自动获取最新":
            target_date = all_dates[-1] 
            yield f"[{get_time()}] 未指定特定日期，系统自动锁定最新课程日: {target_date}"
        elif is_all_dates:
            yield f"[{get_time()}] 选择全部日期模式，准备遍历所有 {len(all_dates)} 个课程日..."
        else:
            yield f"[{get_time()}] 校验用户指定抓取日期: {target_date}"
            if target_date not in all_dates:
                yield f"[{get_time()}] ❌ 严重错误: 当前课程不存在 [{target_date}] 的记录。"
                yield f"[{get_time()}] 🛑 拦截生效，已取消后续所有抓取动作以避免资源浪费。"
                return  

        if target_sequence is not None:
            pass
        elif is_all_dates:
            target_items = sorted(playlist, key=lambda x: (x['date'], x['time'], x['period_seq']))
        else:
            target_items = [item for item in playlist if item['date'] == target_date]
            target_items.sort(key=lambda x: (x['time'], x['period_seq']))
            date_formatted = target_date.replace('-', '')

        # 预扫描已有字幕文件，避免重复工作
        base_path = Path(export_base_dir)
        course_sub_dir = base_path / "subtitle" / course_name
        if course_sub_dir.exists():
            for date_dir in course_sub_dir.iterdir():
                if date_dir.is_dir():
                    for f in date_dir.glob("*_transcript.txt"):
                        try:
                            fname = f.stem.replace("_transcript", "")
                            parts = fname.split("-", 1)
                            if len(parts) == 2:
                                d_key = parts[0]
                                seq_key = int(parts[1])
                                existing_keys.add((d_key, seq_key))
                        except:
                            pass
            if existing_keys:
                yield f"[{get_time()}] 扫描到 {len(existing_keys)} 个已有字幕文件，将跳过对应课时。"
        else:
            course_sub_dir.mkdir(parents=True, exist_ok=True) 
        yield f"[{get_time()}] 课程 [{course_name}] | 主讲老师: {teacher_name}"
        if is_all_dates:
            yield f"[{get_time()}] 全部日期模式，共 {len(target_items)} 节课，准备顺序执行..."
        else:
            yield f"[{get_time()}] {target_date} 共有 {len(target_items)} 节课，准备顺序执行..."

    except Exception as e:
        yield f"[{get_time()}] 播放列表初始化失败: {e}"
        return

    base_path = Path(export_base_dir)
    if is_all_dates:
        # 全部日期模式：不创建 ALL 目录，每个课时写入自身日期的目录
        sub_dir = base_path / "subtitle" / course_name
        media_dir = base_path / "media" / course_name
        sub_dir.mkdir(parents=True, exist_ok=True)
        yield f"[{get_time()}] 产物分类目录已确认:"
        yield f"   - 字幕根目录: {sub_dir} (按日期自动归档)"
    else:
        sub_dir = base_path / "subtitle" / course_name / f"{date_formatted}-{teacher_name}"
        media_dir = base_path / "media" / course_name / f"{date_formatted}-{teacher_name}"

        sub_dir.mkdir(parents=True, exist_ok=True)
        yield f"[{get_time()}] 产物分类目录已确认:"
        yield f"   - 字幕归档: {sub_dir}"
        if need_ppt or keep_media:
            media_dir.mkdir(parents=True, exist_ok=True)
            yield f"   - 媒体归档: {media_dir}"
    yield f"[{get_time()}] ----------------------------------------"
    
    yield f"[{get_time()}] [阶段 1/2] 启动原子化网络侦听，精准抽取目标课时流..."
    

    route_capturer = RouteIsolationCapture(page)
    route_capturer.activate()

    for item in target_items:
        if stop_event.is_set():
            yield f"[{get_time()}] 接收到打断指令，停止执行后续任务..."
            asr_worker.abort()
            route_capturer.deactivate()
            return  
        
        seq = item['period_seq']
        idx = item['index']
        date_key = item['date'].replace('-', '')
        
        # 全部日期模式：预扫描跳过已有字幕的课时
        if is_all_dates and (date_key, seq) in existing_keys:
            yield f"[{get_time()}] [跳过] 第 {seq} 节 ({item['date']}) 已有字幕文件。"
            continue
        
        active_lesson_seq[0] = idx if is_all_dates else seq
        
        try:
            yield f"[{get_time()}] 正在刺激第 {seq} 节节点响应..."
            container = page.locator(".list-item.student").nth(idx)
            click_target = container.locator(".title").first
            click_target.scroll_into_view_if_needed()
            page.wait_for_timeout(500)  
            
            final_url = None
            route_capturer.captured_url = None 

            try:
                with page.expect_response(lambda r: "course_vod_urls_new" in r.url and r.ok, timeout=6000) as resp_info:
                    click_target.evaluate("node => node.click()")
                    
                json_data = resp_info.value.json()
                final_url = find_mp4_url(json_data)
                
                if final_url:
                    yield f"[{get_time()}] [DEBUG] 第 {seq} 节 P0(点击) 捕获成功。"
            except Exception as e:
                yield f"[{get_time()}] [DEBUG] 课时处于激活死区 (或请求超时)，强制重载页面状态..."
                try:
                    with page.expect_response(lambda r: "course_vod_urls_new" in r.url and r.ok, timeout=10000) as resp_info:
                        page.reload(wait_until="commit")
                        
                    json_data = resp_info.value.json()
                    final_url = find_mp4_url(json_data)
                    if final_url:
                        yield f"[{get_time()}] [DEBUG] 第 {seq} 节 P0(重载) 捕获成功。"
                except Exception as reload_e:
                    yield f"[{get_time()}] [DEBUG] P0 彻底失效: {reload_e}"


            if not final_url:
                yield f"[{get_time()}] [DEBUG] 启动 P3 物理嗅探兜底..."
                click_target.evaluate("node => node.click()") 
                page.wait_for_timeout(3000) 
                
                if route_capturer.captured_url:
                    final_url = route_capturer.captured_url
                    yield f"[{get_time()}] [DEBUG] 第 {seq} 节 P3(嗅探) 捕获成功。"

            item['final_url'] = final_url

            if final_url and need_subtitle:
                yield f"[{get_time()}] [DEBUG] 等待字幕请求加载 (尝试规避约 5s 防盗页)..."
                wait_time = 0
                lookup_key = idx if is_all_dates else seq
                while wait_time < 8000:
                    if lookup_key in captured_subtitles:
                        yield f"[{get_time()}] [DEBUG] 官方字幕拦截成功！"
                        break
                    page.wait_for_timeout(500)
                    wait_time += 500
            
            if not final_url:
                yield f"[{get_time()}] ❌ 第 {seq} 节获取流失败，未找到有效链接。"
            
        except Exception as e:
            yield f"[{get_time()}] 第 {seq} 节节点触发异常: {e}"


    route_capturer.deactivate()
    yield f"[{get_time()}] ----------------------------------------"

    if stop_event.is_set():
        yield f"[{get_time()}] 提取完成但收到打断指令，取消后续处理。"
        return
     
    yield f"[{get_time()}] [阶段 2/2] 进入单线程持久化队列，执行本地 I/O 处理..."
    for item in target_items:
        # 全部日期模式：使用 item 自身日期作为子目录，写入对应日期的目录
        if is_all_dates:
            item_date_key = item['date'].replace('-', '')
            item_sub_dir = base_path / "subtitle" / course_name / f"{item_date_key}-{teacher_name}"
            item_sub_dir.mkdir(parents=True, exist_ok=True)
            task_name = f"{item_date_key}-{item['period_seq']}"
        else:
            item_sub_dir = sub_dir
            task_name = f"{date_formatted}-{item['period_seq']}"
        
        yield f"\n[{get_time()}] 任务调度 -> 开始处理第 {item['period_seq']} 节 [{task_name}]..."

        expected_files = [
            item_sub_dir / f"{task_name}_transcript.txt",
            media_dir / f"{task_name}.mp4",
            media_dir / f"{task_name}.m4a",
            media_dir / f"{task_name}_PPT.pdf"
        ]
        
        if any(f.exists() for f in expected_files):
            yield f"[{get_time()}] 检测到部分产物已存在，执行增量跳过策略。"
            if (item_sub_dir / f"{task_name}_transcript.txt").exists():
                continue

        sub_json = captured_subtitles.get(item['index'] if is_all_dates else item['period_seq'])
        got_official_sub = False
        
        if need_subtitle and sub_json:
            yield f"[{get_time()}] 挂载官方字幕数据，执行写入..."
            try:
                process_official_json(sub_json, item_sub_dir, task_name)
                got_official_sub = True 
                yield f"[{get_time()}] 官方字幕写入成功。"
            except Exception as e:
                yield f"[{get_time()}] 官方字幕写入失败: {e}"

        # 全部日期模式下仅抓取官方字幕，跳过媒体/PPT 处理
        if is_all_dates:
            if not got_official_sub:
                yield f"[{get_time()}] [全部日期模式] 未捕获到官方字幕，跳过。"
            yield f"[{get_time()}] ----------------------------------------"
            continue

        final_url = item.get('final_url')
        need_media = need_ppt or keep_media or (need_subtitle and not got_official_sub)
        audio_only_mode = (not need_ppt) and (not keep_media) and (need_subtitle and not got_official_sub)

        if need_media:
            if final_url:
                msg = "轻量级提取 (仅音频)" if audio_only_mode else "全量抓取 (音视频)"
                yield f"[{get_time()}] 启动媒体处理引擎 {msg}..."
                
                try:
                    asr_worker.export_base_dir = item_sub_dir 
                    asr_worker.extract_media(final_url, target_url, audio_only=audio_only_mode)
                    
                    ext = ".m4a" if audio_only_mode else ".mp4"
                    dest_media_path = media_dir / f"{task_name}{ext}"

                    if keep_media:
                        media_dir.mkdir(parents=True, exist_ok=True)  
                        if dest_media_path.exists(): dest_media_path.unlink()
                        shutil.copy2(asr_worker.temp_video_path, dest_media_path)

                    if need_subtitle and not got_official_sub:
                        yield f"[{get_time()}] 启动本地 ASR 音频转写..."
                        for progress_data in asr_worker.transcribe_and_export(task_name):
                            if "progress" in progress_data:
                                yield f"[ASR_PROGRESS] {json.dumps(progress_data)}"
                    
                    if need_ppt:
                        media_dir.mkdir(parents=True, exist_ok=True)
                        yield f"[{get_time()}] 初始化 PPT 视觉抽帧队列..."
                        try:
                            source_video_path = dest_media_path if dest_media_path.exists() else asr_worker.temp_video_path
                            ppt_worker = PPTExtractor(
                                video_path=str(source_video_path), 
                                output_dir=str(media_dir),  
                                task_name=task_name,
                                interval_sec=10,
                                diff_threshold=1.0 
                            )
                            yield from ppt_worker.extract_and_build_pdf(ignore_bottom_right_ratio=0.25)
                        except Exception as e:
                            yield f"[{get_time()}] PPT 提取级联崩溃: {e}"
                    
                    asr_worker._cleanup() 

                except Exception as e:
                    yield f"[{get_time()}] 媒体处理异常终止: {e}"

                if stop_event.is_set():
                    yield f"[{get_time()}] 任务打断，清理当前残骸..."
                    asr_worker.abort()
                    for f in expected_files:
                        if f.exists():
                            try: f.unlink()
                            except: pass
                    return
            else:
                yield f"[{get_time()}] 未检测到有效流，跳过媒体任务。"

        yield f"[{get_time()}] ----------------------------------------"

    yield f"\n[{get_time()}] 队列耗尽，所有阶段任务已安全完结。"
