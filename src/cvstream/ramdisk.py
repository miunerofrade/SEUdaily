# ramdisk.py
import os
import ctypes
import shutil
import glob

def check_and_install_imdisk():
    """前置检查系统驱动，支持 exe 安装包和解压后的 bat 安装脚本"""
    if shutil.which("imdisk"):
        return True, "驱动已就绪"
    
    res_dir = os.path.join(os.getcwd(), "res")
    if not os.path.exists(res_dir):
        os.makedirs(res_dir, exist_ok=True)
        
    installer_path = None
    
    exe_installers = glob.glob(os.path.join(res_dir, "ImDiskTk*.exe"))
    if exe_installers:
        installer_path = exe_installers[0]
    else:
        for root, dirs, files in os.walk(res_dir):
            if "install.bat" in files:
                installer_path = os.path.join(root, "install.bat")
                break
    
    if not installer_path:
        download_url = "https://sourceforge.net/projects/imdisk-toolkit/"
        return False, f"系统未安装驱动，且 res 目录下未找到安装文件。\n请前往 {download_url} 下载压缩包，解压后放入 res 文件夹重试。"
        
    if installer_path.endswith(".bat"):
        work_dir = os.path.dirname(installer_path)
        ret = ctypes.windll.shell32.ShellExecuteW(None, "runas", "cmd.exe", f'/c "{installer_path}"', work_dir, 1)
    else:
        ret = ctypes.windll.shell32.ShellExecuteW(None, "runas", installer_path, "", None, 1)
    
    if ret > 32:
        return False, "系统缺失底层驱动。已为您自动唤起安装向导（黑框或安装界面），请完成后再次点击开启内存盘。"
    else:
        return False, f"自动触发安装失败 (错误码: {ret})，请前往 res 文件夹手动双击安装。"


def setup_ramdisk(letter="R:", size="1G"):
    """使用 Windows 原生 ShellExecuteW 触发 UAC 挂载内存盘"""
    is_ready, msg = check_and_install_imdisk()
    if not is_ready:
        return False, msg

    if os.path.exists(f"{letter}\\"):
        return True, "已存在"

    params = f'-a -s {size} -m {letter} -p "/fs:ntfs /q /y"'
    ret = ctypes.windll.shell32.ShellExecuteW(None, "runas", "imdisk", params, None, 0)
    
    if ret > 32:
        return True, "提权弹窗已发送"
    else:
        return False, f"API 调用失败，错误码: {ret}"


def remove_ramdisk(letter="R:"):
    """卸载内存盘"""
    if not shutil.which("imdisk"):
        return True, "未安装驱动，无需卸载"
        
    if not os.path.exists(f"{letter}\\"):
        return True, "已卸载"
        
    params = f'-D -m {letter}'
    ret = ctypes.windll.shell32.ShellExecuteW(None, "runas", "imdisk", params, None, 0)
    
    if ret > 32:
        return True, "卸载请求已发送"
    else:
        return False, f"卸载失败，错误码: {ret}"