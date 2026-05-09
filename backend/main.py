import os
import sys
import asyncio
import base64
import io
import time
import json
import uuid
import random
import shutil
import numpy as np
from pathlib import Path
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.responses import StreamingResponse
from pydantic import BaseModel
from PIL import Image, ImageDraw, ImageFilter, ImageOps
from dotenv import load_dotenv
import httpx
import subprocess
import socket
from urllib.parse import urlparse
TEST_DELAY_ENABLED = True       
TEST_DELAY_MIN = 1               
TEST_DELAY_MAX = 1  


# 需要添加延迟的路径前缀（POST 请求）
TEST_DELAY_PATHS = [
    "/enhance", "/process-masks", "/process-upload", "/debug-segment",
    "/apply-material", "/finalize",
    "/api/v2/segment", "/api/v2/render", "/api/v2/preprocess",
    "/api/v2/apply-material", "/api/v2/finalize", "/api/v2/render-all",
    "/api/v2/split-mask",
]

load_dotenv()

# ── Prompt configuration (runtime-editable via /api/monitor/prompts) ────────
PROMPT_CONFIG = {
    "enhance":        "Realistic render",
    "clean":          "empty room",
    "refine":         "Remove all black outlines and black boundary lines between color regions. Make each colored area fill seamlessly to their edges without any black gaps, borders, or outlines. The result should have clean, sharp color boundaries where colors meet directly with no black separation lines.",
    "applyMaterial":  "use image2 as a reference, repaint all wall in image 1",
    "finalize":       "realistic render",
    "ceilingMaterial": "将图一的天花换成图二的材质样式，平铺材质球的颜色和纹理，不要参考黑色区域",
    "wallMaterial":   "将图一的墙面换成图二的材质样式，平铺材质球的颜色和纹理，不要参考黑色区域",
}
# Keep a copy of defaults so the monitor UI can offer a "reset" button
DEFAULT_PROMPT_CONFIG = dict(PROMPT_CONFIG)


# ── SAM3 remote API ──────────────────────────────────────────────────────────
SAM3_API = os.getenv("SAM3_API", "https://sh-llm-api.tinttex.cn:8443/sam3/segment")

# ── ComfyUI API ──────────────────────────────────────────────────────────────
COMFYUI_HOST = os.getenv("COMFYUI_HOST", "http://127.0.0.1:8188")

# ── ComfyUI Watchdog config ──────────────────────────────────────────────────
COMFYUI_PATH = os.getenv("COMFYUI_PATH", r"D:\ComfyUI-aki-v2")
COMFYUI_HEALTH_INTERVAL = int(os.getenv("COMFYUI_HEALTH_INTERVAL", "30"))
COMFYUI_UNHEALTHY_THRESHOLD = int(os.getenv("COMFYUI_UNHEALTHY_THRESHOLD", "3"))
COMFYUI_RESTART_COOLDOWN = int(os.getenv("COMFYUI_RESTART_COOLDOWN", "120"))
COMFYUI_AUTO_RESTART = os.getenv("COMFYUI_AUTO_RESTART", "true").lower() == "true"

comfyui_watchdog_state = {
    "enabled": COMFYUI_AUTO_RESTART,
    "status": "unknown",  # unknown / healthy / unhealthy / restarting / cooldown
    "consecutive_failures": 0,
    "last_check_time": None,
    "last_healthy_time": None,
    "last_restart_time": None,
    "restart_count": 0,
    "last_error": None,
}

_watchdog_task = None
_restart_in_progress = False

# ── Materials path ───────────────────────────────────────────────────────────
# Relative to this file's directory (backend/) → ../public/materials
_materials_rel = os.getenv("MATERIALS_PATH", "../public/materials")
MATERIALS_DIR = (Path(__file__).parent / _materials_rel).resolve()
MATERIALS_DIR.mkdir(parents=True, exist_ok=True)

# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def test_delay_middleware(request: Request, call_next):
    """测试用中间件：在工作流接口返回前增加随机延迟。"""
    response = await call_next(request)
    if (
        TEST_DELAY_ENABLED
        and request.method == "POST"
        and request.url.path in TEST_DELAY_PATHS
    ):
        delay = random.uniform(TEST_DELAY_MIN, TEST_DELAY_MAX)
        print(f"【测试延迟】{request.url.path} 延迟 {delay:.1f}s ...")
        await asyncio.sleep(delay)
        print(f"【测试延迟】{request.url.path} 延迟结束")
    return response


# Serve material images so the frontend can show thumbnails
app.mount("/materials", StaticFiles(directory=str(MATERIALS_DIR)), name="materials")


@app.exception_handler(ValueError)
async def value_error_handler(request: Request, exc: ValueError):
    return JSONResponse(status_code=400, content={"detail": str(exc)})

# ── Debug images path ─────────────────────────────────────────────────────────
# Exposes backend/debug/ as /debug-imgs so the frontend debug panel can load them
DEBUG_DIR = (Path(__file__).parent / "debug").resolve()
DEBUG_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/debug-imgs", StaticFiles(directory=str(DEBUG_DIR)), name="debug_imgs")

# ── Session cleanup config ───────────────────────────────────────────────────
# 超过保留期的会话图片（蒙版 / 预处理 / 阶段性 / 最终结果）会被自动清理以节省空间
SESSION_RETENTION_DAYS = int(os.getenv("SESSION_RETENTION_DAYS", "7"))
SESSION_CLEANUP_INTERVAL = int(os.getenv("SESSION_CLEANUP_INTERVAL", "3600"))  # 秒
_cleanup_task = None
_last_cleanup_info: dict = {
    "last_run_time": None,
    "removed_count": 0,
    "removed_ids": [],
    "error": None,
}


# ── Monitor (SSE real-time event push) ────────────────────────────────────────

class MonitorSession:
    """管理实时监控事件，支持多任务历史"""
    HISTORY_FILE = os.path.join(os.path.dirname(__file__), "debug", "monitor_history.json")

    def __init__(self):
        self.tasks: list[dict] = []  # 每个 task = {"id": str, "events": list, "startTime": float, "status": str}
        self.current_task: dict | None = None
        self.subscribers: list[asyncio.Queue] = []
        self.current_request_id: str | None = None
        self.current_endpoint: str | None = None  # "preprocess" or "render-all"
        self._load_history()  # 启动时加载历史

    def _load_history(self):
        """从文件加载历史任务"""
        try:
            if os.path.exists(self.HISTORY_FILE):
                with open(self.HISTORY_FILE, "r", encoding="utf-8") as f:
                    data = json.load(f)
                self.tasks = data.get("tasks", [])
                # 将所有 running 状态的任务标记为 error（因为是上次异常退出的）
                for t in self.tasks:
                    if t.get("status") == "running":
                        t["status"] = "error"
                    elif t.get("status") == "idle":
                        t["status"] = "completed"
                print(f"[Monitor] Loaded {len(self.tasks)} tasks from history")
        except Exception as e:
            print(f"[Monitor] Failed to load history: {e}")
            self.tasks = []

    def _save_history(self):
        """保存所有任务到文件"""
        try:
            os.makedirs(os.path.dirname(self.HISTORY_FILE), exist_ok=True)
            with open(self.HISTORY_FILE, "w", encoding="utf-8") as f:
                json.dump({"tasks": self.tasks}, f, ensure_ascii=False)
        except Exception as e:
            print(f"[Monitor] Failed to save history: {e}")

    def start_task(self):
        """开始一个新任务（一个任务包含 preprocess + render-all）"""
        task = {
            "id": str(uuid.uuid4())[:8],
            "events": [],
            "startTime": time.time(),
            "status": "running"  # running / idle / completed / error
        }
        # 为每个任务创建独立的 debug 子目录
        task_debug_dir = os.path.join(os.path.dirname(__file__), "debug", task["id"])
        os.makedirs(task_debug_dir, exist_ok=True)
        task["debug_dir"] = task_debug_dir
        self.tasks.append(task)
        # 限制历史数量，保留最近 50 个任务
        if len(self.tasks) > 50:
            self.tasks = self.tasks[-50:]
        self.current_task = task
        self._save_history()
        return task

    def get_debug_dir(self) -> str:
        """获取当前任务的 debug 目录路径"""
        if self.current_task and "debug_dir" in self.current_task:
            return self.current_task["debug_dir"]
        # fallback 到默认 debug 目录
        default = os.path.join(os.path.dirname(__file__), "debug")
        os.makedirs(default, exist_ok=True)
        return default

    def reset(self):
        """清空所有历史任务"""
        self.tasks.clear()
        self.current_task = None
        self.current_request_id = None
        self.current_endpoint = None
        self._save_history()

    def emit(self, stage: str, status: str, image_path: str = None, duration: float = None, extra: dict = None):
        # 自动为 image_path 添加 task_id 前缀
        if image_path and self.current_task and not image_path.startswith(self.current_task["id"]):
            image_path = f"{self.current_task['id']}/{image_path}"
        event = {
            "id": len(self.current_task["events"]) if self.current_task else 0,
            "taskId": self.current_task["id"] if self.current_task else None,
            "requestId": self.current_request_id,
            "endpoint": self.current_endpoint,  # "preprocess" or "render-all"
            "stage": stage,
            "status": status,  # "start", "done", "error"
            "timestamp": time.time(),
            "duration": duration,
            "imagePath": image_path,
        }
        if extra:
            event.update(extra)
        if self.current_task:
            self.current_task["events"].append(event)
            # 防抖保存：每10个事件或状态变更时保存
            evt_count = len(self.current_task.get("events", []))
            if evt_count % 10 == 0 or status in ("error", "warning"):
                self._save_history()
        for q in self.subscribers:
            q.put_nowait(event)

    def _emit_task_status(self, status: str):
        """发送任务状态变更事件到前端"""
        if not self.current_task:
            return
        event = {
            "id": len(self.current_task["events"]),
            "taskId": self.current_task["id"],
            "requestId": self.current_request_id,
            "endpoint": self.current_endpoint,
            "stage": "_task_status",
            "status": status,
            "timestamp": time.time(),
            "duration": None,
            "imagePath": None,
        }
        self.current_task["events"].append(event)
        self._save_history()
        for q in self.subscribers:
            q.put_nowait(event)

    def start_request(self, endpoint: str):
        """开始一个请求（preprocess 或 render-all）"""
        # 清理之前卡住的任务（如果上一个任务还是 running 状态，强制标记为 error）
        if self.current_task and self.current_task["status"] == "running":
            print(f"[monitor] WARNING: 上一个任务 {self.current_task['id']} 仍为 running，强制标记为 error")
            self.current_task["status"] = "error"
            self._emit_task_status("error")

        if endpoint == "render-all" and self.current_task and self.current_task["status"] == "idle":
            # render-all 复用当前 idle 任务，恢复为 running
            self.current_task["status"] = "running"
            self._emit_task_status("running")
        else:
            # 其他情况创建新任务
            # 如果之前有 idle 的任务，先标记为 completed（因为不会再有 render-all 了）
            if self.current_task and self.current_task["status"] == "idle":
                self.current_task["status"] = "completed"
                self._emit_task_status("completed")
            self.start_task()
        self.current_request_id = f"{self.current_task['id']}-{endpoint}"
        self.current_endpoint = endpoint
        self.emit(f"{endpoint}", "start")

    def end_request(self, endpoint: str, duration: float):
        self.emit(f"{endpoint}", "done", duration=duration)
        if self.current_task:
            if endpoint == "render-all":
                self.current_task["status"] = "completed"
                self._emit_task_status("completed")
            else:
                # preprocess 等其他请求完成后进入 idle 状态，等待后续请求
                self.current_task["status"] = "idle"
                self._emit_task_status("idle")
        self.current_request_id = None
        self.current_endpoint = None
        self._save_history()

monitor = MonitorSession()


# ── Session cleanup helpers ──────────────────────────────────────────────────
def cleanup_old_sessions(retention_days: int | None = None) -> dict:
    """删除 debug/<task_id>/ 下超过保留天数的子目录，并同步清理 monitor_history.json。

    参考目录识别规则：
      - 仅处理 DEBUG_DIR 的直接子目录（每个 task 一个目录）
      - 以目录最新修改时间 mtime 为准（任务写入最后一张图后即计时）
      - 保护当前正在运行中的任务目录，不论 mtime 多远都不删
      - 保留非目录文件（如 monitor_history.json）
    """
    days = SESSION_RETENTION_DAYS if retention_days is None else retention_days
    cutoff_time = time.time() - max(0, days) * 86400
    removed_ids: list[str] = []
    errors: list[str] = []

    if not DEBUG_DIR.exists():
        info = {
            "last_run_time": time.time(),
            "removed_count": 0,
            "removed_ids": [],
            "error": None,
            "retention_days": days,
        }
        _last_cleanup_info.update(info)
        return info

    # 保护当前正在运行的任务（避免运行中被误杀）
    active_id = None
    if monitor.current_task and monitor.current_task.get("status") == "running":
        active_id = monitor.current_task.get("id")

    for entry in DEBUG_DIR.iterdir():
        if not entry.is_dir():
            continue
        if active_id and entry.name == active_id:
            continue
        try:
            mtime = entry.stat().st_mtime
            if mtime < cutoff_time:
                shutil.rmtree(entry, ignore_errors=True)
                # 若目录仍存在（Windows 文件锁定等），记录异常
                if entry.exists():
                    errors.append(f"{entry.name}: still exists after rmtree")
                else:
                    removed_ids.append(entry.name)
        except Exception as e:
            errors.append(f"{entry.name}: {e}")

    # 同步删除 monitor_history.json 中对应的任务记录
    if removed_ids:
        try:
            removed_set = set(removed_ids)
            monitor.tasks = [t for t in monitor.tasks if t.get("id") not in removed_set]
            if monitor.current_task and monitor.current_task.get("id") in removed_set:
                monitor.current_task = None
            monitor._save_history()
        except Exception as e:
            errors.append(f"prune history: {e}")

    info = {
        "last_run_time": time.time(),
        "removed_count": len(removed_ids),
        "removed_ids": removed_ids,
        "error": "; ".join(errors) if errors else None,
        "retention_days": days,
    }
    _last_cleanup_info.update(info)
    if removed_ids or errors:
        print(f"[Cleanup] retention={days}d removed={len(removed_ids)} errs={len(errors)} ids={removed_ids}")
    return info


async def session_cleanup_loop():
    """定时清理过期会话文件。"""
    # 启动后延迟几秒再跑首次，让服务完全就绪
    await asyncio.sleep(5)
    while True:
        try:
            cleanup_old_sessions()
        except Exception as e:
            print(f"[Cleanup] loop error: {e}")
        await asyncio.sleep(max(60, SESSION_CLEANUP_INTERVAL))


@app.get("/monitor")
async def monitor_page():
    from fastapi.responses import HTMLResponse
    monitor_file = os.path.join(os.path.dirname(__file__), "monitor.html")
    with open(monitor_file, "r", encoding="utf-8") as f:
        return HTMLResponse(content=f.read())


@app.get("/api/monitor/stream")
async def monitor_stream():
    queue = asyncio.Queue()
    monitor.subscribers.append(queue)

    async def event_generator():
        try:
            # 先发送所有任务的所有事件作为初始状态
            for task in monitor.tasks:
                for evt in task["events"]:
                    yield f"data: {json.dumps(evt, ensure_ascii=False)}\n\n"
            # 然后持续等待新事件
            while True:
                event = await queue.get()
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            monitor.subscribers.remove(queue)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"}
    )


@app.get("/api/monitor/state")
async def monitor_state():
    return {
        "tasks": [
            {
                "id": t["id"],
                "startTime": t["startTime"],
                "status": t["status"],
                "eventCount": len(t["events"])
            } for t in monitor.tasks
        ],
        "currentTaskId": monitor.current_task["id"] if monitor.current_task else None
    }


@app.get("/api/monitor/task/{task_id}")
async def monitor_task(task_id: str):
    for t in monitor.tasks:
        if t["id"] == task_id:
            return {"task": t}
    raise HTTPException(404, detail="Task not found")


@app.delete("/api/monitor/history")
async def clear_monitor_history():
    monitor.reset()
    return {"status": "ok"}


@app.get("/api/monitor/debug/{filepath:path}")
async def monitor_debug_image(filepath: str):
    from fastapi.responses import FileResponse
    file_path = os.path.join(os.path.dirname(__file__), "debug", filepath)
    if not os.path.exists(file_path):
        raise HTTPException(404, detail=f"File not found: {filepath}")
    return FileResponse(file_path)


# Prime psutil so first interval=0 call returns meaningful data
try:
    import psutil as _psutil
    _psutil.cpu_percent(interval=None)
except ImportError:
    _psutil = None


@app.get("/api/monitor/system-stats")
async def monitor_system_stats():
    """Proxy to ComfyUI /system_stats to avoid CORS, plus CPU via psutil if available."""
    result = {}
    # Try to get CPU usage from psutil
    try:
        if _psutil is not None:
            result["cpu_percent"] = _psutil.cpu_percent(interval=0)
        else:
            result["cpu_percent"] = None
    except Exception:
        result["cpu_percent"] = None
    # Fetch ComfyUI system_stats
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{COMFYUI_HOST}/system_stats")
            resp.raise_for_status()
            comfy_data = resp.json()
            result["comfyui"] = comfy_data
    except Exception as e:
        result["comfyui"] = None
        result["error"] = str(e)
    return result


# ── Prompt settings API ───────────────────────────────────────────────────────

@app.get("/api/monitor/prompts")
async def get_prompts():
    """Return current runtime prompts + defaults for reset."""
    return {"prompts": PROMPT_CONFIG, "defaults": DEFAULT_PROMPT_CONFIG}


@app.put("/api/monitor/prompts")
async def update_prompts(body: dict):
    """Partially update runtime prompt config. Only known keys accepted."""
    updated = []
    for k, v in body.items():
        if k in PROMPT_CONFIG and isinstance(v, str):
            PROMPT_CONFIG[k] = v
            updated.append(k)
    return {"status": "ok", "updated": updated, "prompts": PROMPT_CONFIG}


# ── ComfyUI Watchdog ─────────────────────────────────────────────────────────

async def check_comfyui_health() -> bool:
    """检查 ComfyUI 是否健康响应"""
    t0 = time.time()
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{COMFYUI_HOST}/system_stats")
        dur = time.time() - t0
        print(f"【用时测试】 ├─ ComfyUI健康检查: {dur:.2f}s")
        return resp.status_code == 200
    except Exception as e:
        comfyui_watchdog_state["last_error"] = str(e)
        dur = time.time() - t0
        print(f"【用时测试】 ├─ ComfyUI健康检查(失败): {dur:.2f}s - {e}")
        return False


async def _is_comfyui_local() -> bool:
    """判断 ComfyUI 是否运行在本机"""
    parsed = urlparse(COMFYUI_HOST)
    host = parsed.hostname or "127.0.0.1"
    if host in ("127.0.0.1", "localhost", "0.0.0.0"):
        return True
    try:
        local_ips = [addr[4][0] for addr in await asyncio.to_thread(socket.getaddrinfo, socket.gethostname(), None)]
        return host in local_ips
    except Exception:
        return False


async def restart_comfyui() -> bool:
    """重启 ComfyUI 进程"""
    global _restart_in_progress
    if _restart_in_progress:
        print("🔄 [看门狗] 已有重启任务进行中，跳过")
        return False
    _restart_in_progress = True
    try:
        return await _do_restart_comfyui()
    finally:
        _restart_in_progress = False


async def _do_restart_comfyui() -> bool:
    """实际执行重启逻辑（内部使用）"""
    comfyui_watchdog_state["status"] = "restarting"
    comfyui_watchdog_state["last_restart_time"] = time.time()
    comfyui_watchdog_state["restart_count"] += 1

    print(f"\U0001f504 [看门狗] 正在重启 ComfyUI... (第 {comfyui_watchdog_state['restart_count']} 次)")

    # 发送 SSE 事件通知前端
    for q in monitor.subscribers:
        q.put_nowait({
            "id": 0,
            "taskId": None,
            "requestId": None,
            "endpoint": None,
            "stage": "_watchdog",
            "status": "restarting",
            "timestamp": time.time(),
            "duration": None,
            "imagePath": None,
            "message": f"ComfyUI 正在重启 (第 {comfyui_watchdog_state['restart_count']} 次)",
        })

    try:
        parsed = urlparse(COMFYUI_HOST)
        port = parsed.port or 8188
        host = parsed.hostname or "127.0.0.1"

        if not await _is_comfyui_local():
            print(f"\u26a0\ufe0f [看门狗] ComfyUI 在远程主机 {host}，无法自动重启")
            comfyui_watchdog_state["last_error"] = f"远程主机 {host} 无法自动重启"
            comfyui_watchdog_state["status"] = "unhealthy"
            return False

        # 1. 终止占用端口的进程
        try:
            result = await asyncio.to_thread(
                subprocess.run,
                f'cmd /c "for /f \"tokens=5\" %a in (\'netstat -ano ^| findstr :{port} ^| findstr LISTENING\') do taskkill /F /PID %a"',
                shell=True, capture_output=True, text=True, timeout=10
            )
            print(f"\U0001f504 [看门狗] 终止旧进程: {result.stdout.strip()}")
        except Exception as e:
            print(f"\u26a0\ufe0f [看门狗] 终止旧进程失败: {e}")

        await asyncio.sleep(3)  # 等待进程完全退出

        # 2. 查找启动方式
        # 秋叶整合版：优先找 .bat，否则直接用内置 python 启动 main.py
        startup_scripts = ["run_nvidia_gpu.bat", "run.bat", "启动.bat", "main.bat"]
        startup_script = None
        for script in startup_scripts:
            script_path = os.path.join(COMFYUI_PATH, script)
            if os.path.exists(script_path):
                startup_script = script_path
                break

        if startup_script:
            await asyncio.to_thread(
                subprocess.Popen,
                f'cmd /c cd /d "{COMFYUI_PATH}" && "{startup_script}"',
                shell=True,
                creationflags=subprocess.CREATE_NEW_CONSOLE,
            )
            print(f"\u2705 [看门狗] 已启动 ComfyUI: {startup_script}")
        else:
            # 秋叶整合版通常自带 python，直接运行 ComfyUI/main.py
            embedded_python = os.path.join(COMFYUI_PATH, "python", "python.exe")
            comfyui_main = os.path.join(COMFYUI_PATH, "ComfyUI", "main.py")
            if os.path.exists(embedded_python) and os.path.exists(comfyui_main):
                await asyncio.to_thread(
                    subprocess.Popen,
                    [embedded_python, comfyui_main, "--listen", "0.0.0.0", "--port", str(port)],
                    cwd=os.path.join(COMFYUI_PATH, "ComfyUI"),
                    creationflags=subprocess.CREATE_NEW_CONSOLE,
                )
                print(f"\u2705 [看门狗] 已启动 ComfyUI: {embedded_python} {comfyui_main}")
            else:
                bat_files = [f for f in os.listdir(COMFYUI_PATH) if f.endswith('.bat')] if os.path.isdir(COMFYUI_PATH) else []
                print(f"\u274c [看门狗] 未找到 ComfyUI 启动脚本，搜索路径: {COMFYUI_PATH}")
                print(f"   可用 .bat 文件: {bat_files}")
                comfyui_watchdog_state["last_error"] = f"未找到启动脚本 in {COMFYUI_PATH}"
                comfyui_watchdog_state["status"] = "unhealthy"
                return False

        # 3. 进入冷却期
        comfyui_watchdog_state["status"] = "cooldown"
        comfyui_watchdog_state["consecutive_failures"] = 0
        return True

    except Exception as e:
        print(f"\u274c [看门狗] 重启 ComfyUI 失败: {e}")
        comfyui_watchdog_state["last_error"] = str(e)
        comfyui_watchdog_state["status"] = "unhealthy"
        return False


async def comfyui_watchdog_loop():
    """ComfyUI 健康监控后台任务"""
    print(f"\U0001f415 [看门狗] ComfyUI 健康监控已启动 (间隔: {COMFYUI_HEALTH_INTERVAL}s, 阈值: {COMFYUI_UNHEALTHY_THRESHOLD}次, 冷却: {COMFYUI_RESTART_COOLDOWN}s)")

    while True:
        try:
            now = time.time()
            comfyui_watchdog_state["last_check_time"] = now

            skip_check = False

            # 冷却期中不检查
            if comfyui_watchdog_state["status"] == "cooldown":
                last_restart = comfyui_watchdog_state.get("last_restart_time", 0)
                if now - last_restart < COMFYUI_RESTART_COOLDOWN:
                    remaining = int(COMFYUI_RESTART_COOLDOWN - (now - last_restart))
                    print(f"\U0001f415 [看门狗] 冷却中... 剩余 {remaining}s")
                    skip_check = True
                else:
                    comfyui_watchdog_state["status"] = "unknown"

            # 重启中不检查
            if comfyui_watchdog_state["status"] == "restarting":
                skip_check = True

            if not skip_check:
                # 执行健康检查
                healthy = await check_comfyui_health()

                if healthy:
                    if comfyui_watchdog_state["status"] != "healthy":
                        print(f"\u2705 [看门狗] ComfyUI 健康状态恢复正常")
                    comfyui_watchdog_state["status"] = "healthy"
                    comfyui_watchdog_state["consecutive_failures"] = 0
                    comfyui_watchdog_state["last_healthy_time"] = now
                    comfyui_watchdog_state["last_error"] = None
                else:
                    comfyui_watchdog_state["consecutive_failures"] += 1
                    failures = comfyui_watchdog_state["consecutive_failures"]
                    print(f"\u26a0\ufe0f [看门狗] ComfyUI 健康检查失败 ({failures}/{COMFYUI_UNHEALTHY_THRESHOLD})")

                    if failures >= COMFYUI_UNHEALTHY_THRESHOLD:
                        comfyui_watchdog_state["status"] = "unhealthy"

                        if comfyui_watchdog_state["enabled"]:
                            print(f"\U0001f504 [看门狗] 连续 {failures} 次失败，触发自动重启")
                            await restart_comfyui()
                        else:
                            print(f"\u274c [看门狗] 自动重启已禁用，请手动处理")

        except asyncio.CancelledError:
            print("\U0001f415 [看门狗] 监控任务已停止")
            break
        except Exception as e:
            print(f"\u274c [看门狗] 监控循环异常: {e}")

        await asyncio.sleep(COMFYUI_HEALTH_INTERVAL)


@app.on_event("startup")
async def startup_watchdog():
    global _watchdog_task
    _watchdog_task = asyncio.create_task(comfyui_watchdog_loop())


@app.on_event("startup")
async def startup_session_cleanup():
    """启动时启动会话文件清理循环，并立即跑一次。"""
    global _cleanup_task
    try:
        cleanup_old_sessions()
    except Exception as e:
        print(f"[Cleanup] startup run failed: {e}")
    _cleanup_task = asyncio.create_task(session_cleanup_loop())


@app.on_event("shutdown")
async def shutdown_watchdog():
    global _watchdog_task
    if _watchdog_task:
        _watchdog_task.cancel()
        try:
            await _watchdog_task
        except asyncio.CancelledError:
            pass
        _watchdog_task = None


@app.on_event("shutdown")
async def shutdown_session_cleanup():
    global _cleanup_task
    if _cleanup_task:
        _cleanup_task.cancel()
        try:
            await _cleanup_task
        except asyncio.CancelledError:
            pass
        _cleanup_task = None


@app.get("/api/monitor/session-cleanup")
async def get_session_cleanup_status():
    """查看会话文件清理配置与上次执行情况。"""
    return {
        "retention_days": SESSION_RETENTION_DAYS,
        "interval_seconds": SESSION_CLEANUP_INTERVAL,
        "last_run": _last_cleanup_info,
    }


@app.post("/api/monitor/session-cleanup")
async def trigger_session_cleanup(request: Request):
    """手动触发一次会话文件清理，可传 retention_days 临时覆盖保留天数。"""
    try:
        body = await request.json()
    except Exception:
        body = {}
    retention = body.get("retention_days") if isinstance(body, dict) else None
    if retention is not None:
        try:
            retention = int(retention)
        except Exception:
            raise HTTPException(status_code=400, detail="retention_days 必须为整数")
    info = cleanup_old_sessions(retention)
    return info


@app.get("/api/monitor/comfyui-watchdog")
async def get_comfyui_watchdog():
    """获取 ComfyUI 看门狗状态"""
    return {
        **comfyui_watchdog_state,
        "config": {
            "comfyui_host": COMFYUI_HOST,
            "comfyui_path": COMFYUI_PATH,
            "health_interval": COMFYUI_HEALTH_INTERVAL,
            "unhealthy_threshold": COMFYUI_UNHEALTHY_THRESHOLD,
            "restart_cooldown": COMFYUI_RESTART_COOLDOWN,
            "auto_restart": COMFYUI_AUTO_RESTART,
        }
    }


@app.post("/api/monitor/comfyui-restart")
async def manual_restart_comfyui(request: Request):
    """手动触发 ComfyUI 重启"""
    # 安全检查：只允许内网访问
    client_ip = request.client.host if request.client else "unknown"
    allowed = client_ip in ("127.0.0.1", "::1", "localhost") or \
              client_ip.startswith("192.168.") or \
              client_ip.startswith("10.") or \
              any(client_ip.startswith(f"172.{i}.") for i in range(16, 32))
    if not allowed:
        raise HTTPException(status_code=403, detail="只允许内网访问此接口")

    if comfyui_watchdog_state["status"] == "restarting":
        return {"success": False, "message": "ComfyUI 正在重启中，请稍候"}
    if comfyui_watchdog_state["status"] == "cooldown":
        return {"success": False, "message": "ComfyUI 重启冷却中，请稍候"}

    success = await restart_comfyui()
    return {"success": success, "message": "重启命令已发送" if success else "重启失败"}


# ── Model loading ─────────────────────────────────────────────────────────────
_model_loaded = True  # Remote API, always ready


# ── Helpers ───────────────────────────────────────────────────────────────────

def load_image(source: str) -> Image.Image:
    """Accept HTTP(S) URL, relative path, data URI, or raw base64."""
    source = source.strip()
    print(f"[load_image] 输入数据前100字符: {source[:100]}")
    try:
        # ── URL ──────────────────────────────────────────────────────
        if source.startswith(("http://", "https://")):
            monitor.emit("图片下载(URL)", "start")
            _t = time.time()
            resp = httpx.get(source, timeout=30, follow_redirects=True)
            resp.raise_for_status()
            img = Image.open(io.BytesIO(resp.content))
            _dur = time.time()-_t
            print(f"【用时测试】  ├─ 图片下载(URL): {_dur:.2f}s")
            monitor.emit("图片下载(URL)", "done", duration=_dur)
            return img
        # ── Relative path (e.g. "/materials/xxx.png") ────────────────
        if source.startswith("/"):
            # Map relative URL path to local public directory
            local_path = (Path(__file__).parent / ".." / "public" / source.lstrip("/")).resolve()
            print(f"[load_image] 本地路径: {local_path}")
            if local_path.exists():
                _t = time.time()
                img = Image.open(local_path)
                _dur = time.time()-_t
                print(f"【用时测试】  ├─ 本地文件加载: {_dur:.2f}s ({local_path.name})")
                monitor.emit("本地文件加载", "done", duration=_dur)
                return img
            else:
                raise ValueError(f"Local file not found: {local_path}")
        # ── Data URI (e.g. "data:image/png;base64,...") ─────────────
        if source.startswith("data:"):
            source = source.split(",", 1)[1]
        # ── Raw base64 ──────────────────────────────────────────────
        # Fix padding if needed
        missing_padding = len(source) % 4
        if missing_padding:
            source += '=' * (4 - missing_padding)
        _t = time.time()
        raw = base64.b64decode(source)
        _dur = time.time()-_t
        print(f"【用时测试】  ├─ base64解码: {_dur:.2f}s")
        monitor.emit("base64解码", "done", duration=_dur)
        return Image.open(io.BytesIO(raw))
    except httpx.HTTPStatusError as e:
        monitor.emit("图片加载", "error", extra={"message": f"下载图片失败 (HTTP {e.response.status_code}): {e}"})
        raise ValueError(f"Failed to download image (HTTP {e.response.status_code}): {e}")
    except httpx.RequestError as e:
        monitor.emit("图片加载", "error", extra={"message": f"下载图片失败: {e}"})
        raise ValueError(f"Failed to download image: {e}")
    except Exception as e:
        monitor.emit("图片加载", "error", extra={"message": f"无效的图片数据: {e}"})
        raise ValueError(f"Invalid image data: {e}")


# Keep backward-compatible alias
base64_to_image = load_image


def image_to_base64(img: Image.Image, fmt: str = "PNG") -> str:
    _t = time.time()
    buf = io.BytesIO()
    if fmt.upper() == "JPEG" and img.mode == "RGBA":
        img = img.convert("RGB")
    img.save(buf, format=fmt)
    result = base64.b64encode(buf.getvalue()).decode()
    _dur = time.time()-_t
    print(f"【用时测试】  ├─ base64编码({fmt}): {_dur:.2f}s")
    monitor.emit("base64编码", "done", duration=_dur)
    return result


def snap_to_64(w: int, h: int, target: int = 1024) -> tuple[int, int]:
    """Scale (w, h) so the longer side ≈ target, both sides multiples of 64."""
    scale = target / max(w, h)
    nw = round(w * scale / 64) * 64
    nh = round(h * scale / 64) * 64
    return max(nw, 64), max(nh, 64)


async def call_flux2(prompt: str, images: list[Image.Image]) -> Image.Image:
    """
    Call ComfyUI (http://192.168.31.44:8188) with the YZZ2 workflow.
    images[0] is the main image (scene), images[1] (optional) is the reference material.
    Width/height are read from the uploaded image via GetImageSize node (366).
    """
    import uuid

    print(f"[comfyui] calling  prompt='{prompt[:60]}...'  images={len(images)}")

    base_url = COMFYUI_HOST.rstrip("/")
    client_id = str(uuid.uuid4())

    async with httpx.AsyncClient(timeout=300) as client:
        # ── 1. Upload images ─────────────────────────────────────────────────
        async def upload_image(img: Image.Image, filename: str) -> str:
            _tu = time.time()
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            buf.seek(0)
            resp = await client.post(
                f"{base_url}/upload/image",
                files={"image": (filename, buf, "image/png")},
                data={"overwrite": "true"},
            )
            resp.raise_for_status()
            data = resp.json()
            print(f"【用时测试】  ├─ ComfyUI上传图片({filename}): {time.time()-_tu:.2f}s")
            return data["name"]

        main_name = await upload_image(images[0], "wallchanger_main.png")
        ref_name = await upload_image(images[1], "wallchanger_ref.png") if len(images) > 1 else main_name

        # ── 2. Build workflow from YZZ template ──────────────────────────────
        workflow = {
            "172": {
                "inputs": {"sampler_name": "euler"},
                "class_type": "KSamplerSelect",
                "_meta": {"title": "KSamplerSelect"}
            },
            "173": {
                "inputs": {
                    "cfg": 1,
                    "model": ["179", 0],
                    "positive": ["202", 0],
                    "negative": ["203", 0]
                },
                "class_type": "CFGGuider",
                "_meta": {"title": "CFGGuider"}
            },
            "175": {
                "inputs": {"width": ["366", 0], "height": ["366", 1], "batch_size": 1},
                "class_type": "EmptyFlux2LatentImage",
                "_meta": {"title": "Empty Flux 2 Latent"}
            },
            "176": {
                "inputs": {"steps": 2, "width": ["366", 0], "height": ["366", 1]},
                "class_type": "Flux2Scheduler",
                "_meta": {"title": "Flux2Scheduler"}
            },
            "177": {
                "inputs": {"samples": ["191", 0], "vae": ["181", 0]},
                "class_type": "VAEDecode",
                "_meta": {"title": "VAE Decode"}
            },
            "179": {
                "inputs": {
                    "unet_name": "Flux2\\flux-2-klein-9b-fp8.safetensors",
                    "weight_dtype": "default"
                },
                "class_type": "UNETLoader",
                "_meta": {"title": "Load Diffusion Model"}
            },
            "180": {
                "inputs": {
                    "clip_name": "qwen_3_8b_fp8mixed.safetensors",
                    "type": "flux2",
                    "device": "default"
                },
                "class_type": "CLIPLoader",
                "_meta": {"title": "Load CLIP"}
            },
            "181": {
                "inputs": {"vae_name": "flux2-vae.safetensors"},
                "class_type": "VAELoader",
                "_meta": {"title": "Load VAE"}
            },
            "184": {
                "inputs": {
                    "conditioning": ["193", 0],
                    "latent": ["195", 0]
                },
                "class_type": "ReferenceLatent",
                "_meta": {"title": "ReferenceLatent"}
            },
            "185": {
                "inputs": {"noise_seed": 9527},
                "class_type": "RandomNoise",
                "_meta": {"title": "RandomNoise"}
            },
            "191": {
                "inputs": {
                    "noise": ["185", 0],
                    "guider": ["173", 0],
                    "sampler": ["172", 0],
                    "sigmas": ["176", 0],
                    "latent_image": ["175", 0]
                },
                "class_type": "SamplerCustomAdvanced",
                "_meta": {"title": "SamplerCustomAdvanced"}
            },
            "193": {
                "inputs": {"text": prompt, "clip": ["180", 0]},
                "class_type": "CLIPTextEncode",
                "_meta": {"title": "CLIP Text Encode (Positive Prompt)"}
            },
            "194": {
                "inputs": {"image": main_name},
                "class_type": "LoadImage",
                "_meta": {"title": "图像1"}
            },
            "195": {
                "inputs": {"pixels": ["194", 0], "vae": ["181", 0]},
                "class_type": "VAEEncode",
                "_meta": {"title": "VAE Encode"}
            },
            "196": {
                "inputs": {
                    "conditioning": ["197", 0],
                    "latent": ["195", 0]
                },
                "class_type": "ReferenceLatent",
                "_meta": {"title": "ReferenceLatent"}
            },
            "197": {
                "inputs": {"conditioning": ["193", 0]},
                "class_type": "ConditioningZeroOut",
                "_meta": {"title": "ConditioningZeroOut"}
            },
            "198": {
                "inputs": {
                    "filename_prefix": "Klein双图编辑",
                    "images": ["177", 0]
                },
                "class_type": "SaveImage",
                "_meta": {"title": "Save Image"}
            },
            "199": {
                "inputs": {"images": ["177", 0]},
                "class_type": "PreviewImage",
                "_meta": {"title": "Preview Image"}
            },
            "200": {
                "inputs": {"image": ref_name},
                "class_type": "LoadImage",
                "_meta": {"title": "图像2"}
            },
            "202": {
                "inputs": {
                    "conditioning": ["184", 0],
                    "latent": ["204", 0]
                },
                "class_type": "ReferenceLatent",
                "_meta": {"title": "ReferenceLatent"}
            },
            "203": {
                "inputs": {
                    "conditioning": ["196", 0],
                    "latent": ["204", 0]
                },
                "class_type": "ReferenceLatent",
                "_meta": {"title": "ReferenceLatent"}
            },
            "204": {
                "inputs": {"pixels": ["367", 0], "vae": ["181", 0]},
                "class_type": "VAEEncode",
                "_meta": {"title": "VAE Encode"}
            },
            "366": {
                "inputs": {"image": ["368", 0]},
                "class_type": "GetImageSize",
                "_meta": {"title": "Get Image Size"}
            },
            "367": {
                "inputs": {
                    "upscale_method": "nearest-exact",
                    "megapixels": 0.5,
                    "resolution_steps": 1,
                    "image": ["200", 0]
                },
                "class_type": "ImageScaleToTotalPixels",
                "_meta": {"title": "ImageScaleToTotalPixels"}
            },
            "368": {
                "inputs": {
                    "upscale_method": "nearest-exact",
                    "megapixels": 0.5,
                    "resolution_steps": 1,
                    "image": ["194", 0]
                },
                "class_type": "ImageScaleToTotalPixels",
                "_meta": {"title": "ImageScaleToTotalPixels"}
            }
        }

        # ── 3. Queue prompt ──────────────────────────────────────────────────
        _tq = time.time()
        payload = {"prompt": workflow, "client_id": client_id}
        resp = await client.post(f"{base_url}/prompt", json=payload)
        resp.raise_for_status()
        prompt_id = resp.json()["prompt_id"]
        print(f"[comfyui] queued prompt_id={prompt_id}")
        print(f"【用时测试】  ├─ ComfyUI提交工作流(call_flux2): {time.time()-_tq:.2f}s")

        # ── 4. Poll for completion ───────────────────────────────────────────
        _tp = time.time()
        for _ in range(600):  # up to ~5 minutes
            await asyncio.sleep(0.5)
            hist_resp = await client.get(f"{base_url}/history/{prompt_id}")
            hist_resp.raise_for_status()
            history = hist_resp.json()
            if prompt_id in history:
                outputs = history[prompt_id].get("outputs", {})
                break
        else:
            monitor.emit("ComfyUI执行", "error", extra={"message": "ComfyUI call_flux2 执行超时"})
            raise HTTPException(504, detail="ComfyUI timed out waiting for result")
        print(f"【用时测试】  ├─ ComfyUI工作流执行等待(call_flux2): {time.time()-_tp:.2f}s")

        # ── 5. Find output image (SaveImage node 198) ────────────────────────
        _td = time.time()
        images_out = outputs.get("198", {}).get("images")
        if not images_out:
            # Fallback: find any node with images output
            for node_out in outputs.values():
                imgs = node_out.get("images")
                if imgs:
                    images_out = imgs
                    break
        if not images_out:
            monitor.emit("ComfyUI执行", "error", extra={"message": "ComfyUI 未返回任何输出图片"})
            raise HTTPException(500, detail="ComfyUI returned no output images")

        img_info = images_out[0]
        img_resp = await client.get(
            f"{base_url}/view",
            params={"filename": img_info["filename"], "subfolder": img_info.get("subfolder", ""), "type": img_info.get("type", "output")},
        )
        img_resp.raise_for_status()
        print(f"【用时测试】  ├─ ComfyUI结果下载(call_flux2): {time.time()-_td:.2f}s")

    result = Image.open(io.BytesIO(img_resp.content))
    print(f"[comfyui] received {result.size} mode={result.mode}")
    return result


async def call_sam3_remote(image: Image.Image, prompts: list[str], confidence: float = 0.3) -> dict:
    """Call remote SAM3 API and return masks + mask image."""
    _t0 = time.time()
    print(f"[sam3-remote] calling API with prompts={prompts}, confidence={confidence}")

    # Convert PIL to bytes
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    buf.seek(0)

    # Build multipart form
    files = {"image": ("image.png", buf, "image/png")}
    data = {
        "prompts": ",".join(prompts),
        "confidence": str(confidence),
    }

    _ta = time.time()
    async with httpx.AsyncClient(timeout=120, verify=False) as client:
        resp = await client.post(SAM3_API, files=files, data=data)
        resp.raise_for_status()
        result = resp.json()
    print(f"【用时测试】  ├─ SAM3 API调用: {time.time()-_ta:.2f}s")

    # Convert hex string to base64 PNG
    _tp = time.time()
    hex_str = result["mask_base64"]
    if not hex_str:
        monitor.emit("SAM3分割", "error", extra={"message": "SAM3 返回空蒙版 - 未检测到任何分割"})
        raise HTTPException(500, detail="SAM3 returned empty mask - no segments detected")

    png_bytes = bytes.fromhex(hex_str)
    mask_b64 = base64.b64encode(png_bytes).decode()

    # Map response format to local format
    segments = result["label_map"]["segments"]
    masks = [{"id": s["id"], "label": s["label"], "color": s["color_rgb"]} for s in segments]
    print(f"【用时测试】  ├─ SAM3结果解析: {time.time()-_tp:.2f}s")

    print(f"[sam3-remote] received {len(masks)} masks")
    print(f"【用时测试】  ├─ SAM3总耗时: {time.time()-_t0:.2f}s")
    return {"masks": masks, "mask_only_b64": mask_b64}


def composite_regions(
    base: Image.Image,
    mask: Image.Image,
    region_colors: list[list[int]],
    region_results: list[Image.Image],
    feather_radius: int = 3,
) -> Image.Image:
    """
    Composite multiple region results onto base using mask colours.
    For each pixel whose mask colour matches a region, copy from that region's
    result image. Feather edges with a Gaussian blur on per-region alpha masks.
    """
    w, h = base.size
    mask_resized = mask.resize((w, h), Image.NEAREST) if mask.size != (w, h) else mask
    mask_arr = np.array(mask_resized.convert("RGB"))  # (H, W, 3)
    out = np.array(base.convert("RGBA"))

    tolerance = 15

    for colors, result_img in zip(region_colors, region_results):
        result_resized = result_img.resize((w, h), Image.LANCZOS) if result_img.size != (w, h) else result_img
        result_arr = np.array(result_resized.convert("RGBA"))

        # Build binary mask for this region
        tc = np.array(colors, dtype=np.int16)
        diff = np.abs(mask_arr.astype(np.int16) - tc)
        region_mask = np.all(diff <= tolerance, axis=2)  # (H, W) bool

        # Feather edges: convert bool mask to float alpha, blur, then blend
        alpha = region_mask.astype(np.float32)
        if feather_radius > 0:
            alpha_img = Image.fromarray((alpha * 255).astype(np.uint8), mode="L")
            alpha_img = alpha_img.filter(ImageFilter.GaussianBlur(radius=feather_radius))
            alpha = np.array(alpha_img).astype(np.float32) / 255.0

        # Blend: out = result * alpha + out * (1 - alpha)
        a3 = alpha[:, :, np.newaxis]
        out = (result_arr * a3 + out * (1 - a3)).astype(np.uint8)

    return Image.fromarray(out)


def generate_unique_color(
    existing: list[list[int]],
    min_dist: int = 80,
    lo: int = 28,
    hi: int = 228,
    max_tries: int = 300,
) -> list[int]:
    """
    Generate a random RGB colour that is at least `min_dist` (Euclidean, RGB space)
    away from every colour in `existing`. Values are drawn from [lo, hi).
    Falls back to [255, 128, 0] (orange) if no candidate is found within `max_tries`.
    """
    import random
    for _ in range(max_tries):
        c = [random.randint(lo, hi - 1) for _ in range(3)]
        if all(
            sum((c[i] - e[i]) ** 2 for i in range(3)) ** 0.5 >= min_dist
            for e in existing
        ):
            return c
    return [255, 128, 0]


def split_mask_by_line(
    mask_arr: np.ndarray,
    target_color: list[int],
    x1: int, y1: int,
    x2: int, y2: int,
    existing_colors: list[list[int]],
    tolerance: int = 15,
) -> tuple[np.ndarray, list[int]] | None:
    """
    Split pixels matching `target_color` in `mask_arr` (H×W×3 uint8) using a
    half-plane defined by the directed line (x1,y1)→(x2,y2).

    Cross product  dx*(py-y1) - dy*(px-x1):
      >= 0  → side A: keep target_color
      <  0  → side B: recolor to new_color

    Returns (updated_arr, new_color) or None if the line doesn't split the region
    (all pixels fall on the same side).
    """
    tc = np.array(target_color, dtype=np.int16)
    diff = np.abs(mask_arr.astype(np.int16) - tc)
    region_mask = np.all(diff <= tolerance, axis=2)   # (H, W) bool

    if not region_mask.any():
        return None

    h, w = mask_arr.shape[:2]
    ys, xs = np.where(region_mask)

    dx = x2 - x1
    dy = y2 - y1
    cross = dx * (ys.astype(np.int64) - y1) - dy * (xs.astype(np.int64) - x1)

    side_b = cross < 0
    if not side_b.any() or side_b.all():
        return None   # degenerate — line doesn't split the region

    new_color = generate_unique_color(existing_colors)

    result = mask_arr.copy()
    b_ys = ys[side_b]
    b_xs = xs[side_b]
    result[b_ys, b_xs] = new_color

    return result, new_color


# ── Request / Response models ─────────────────────────────────────────────────


class ProcessUploadRequest(BaseModel):
    image: str      # raw base64 (no data URI prefix)
    width: int
    height: int
    promptEnhance: str = "Realistic render"

class ProcessMasksRequest(BaseModel):
    enhancedImage: str  # raw base64 JPEG returned by /enhance
    promptClean: str = "empty room"
    promptRefine: str = "Remove all black outlines and black boundary lines between color regions. Make each colored area fill seamlessly to their edges without any black gaps, borders, or outlines. The result should have clean, sharp color boundaries where colors meet directly with no black separation lines."

class DebugSegmentRequest(BaseModel):
    image: str  # raw base64 (original image, no preprocessing)

class MaskInfo(BaseModel):
    id: int
    label: str
    color: list[int]

class ApplyMaterialRequest(BaseModel):
    originalImage: str      # raw base64
    materialFilename: str
    promptApplyMaterial: str = "use image2 as a reference, repaint all wall in image 1"

class FinalizeRequest(BaseModel):
    compositeImage: str     # raw base64
    promptFinalize: str = "realistic render"


# ── V2 models ────────────────────────────────────────────────────────────────

DEFAULT_PROMPT_REFINE = "Remove all black outlines and black boundary lines between color regions. Make each colored area fill seamlessly to their edges without any black gaps, borders, or outlines. The result should have clean, sharp color boundaries where colors meet directly with no black separation lines."

class SegmentRequest(BaseModel):
    image: str                          # raw base64
    promptEnhance: str = "Realistic render"
    promptClean: str = "empty room"
    promptRefine: str = DEFAULT_PROMPT_REFINE

class RegionItem(BaseModel):
    maskColor: list[int]                # [R, G, B] matching mask colour
    materialImage: str                  # raw base64 of material texture
    prompt: str = "use image2 as a reference, repaint all wall in image 1"

class CoordRegionItem(BaseModel):
    x: int                              # pixel X on original image
    y: int                              # pixel Y on original image
    referenceImage: str                 # raw base64 of material texture
    prompt: str = "use image2 as a reference, repaint all wall in image 1"

class RenderRequest(BaseModel):
    image: str                          # raw base64 (original / enhanced)
    refinedMask: str                    # raw base64 PNG from /api/v2/segment
    items: list[CoordRegionItem]        # click point + reference image + prompt
    promptFinalize: str = "realistic render"

class SplitMaskRequest(BaseModel):
    maskImage: str                      # raw base64 PNG — current refined mask
    targetColor: list[int]             # [R, G, B] — which region to split
    x1: int                            # line start X (mask image pixel coords)
    y1: int                            # line start Y
    x2: int                            # line end X
    y2: int                            # line end Y
    existingColors: list[list[int]] = []  # all current mask colours (for collision avoidance)


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok", "model_loaded": _model_loaded}


@app.get("/api/materials")
def get_materials():
    items = []
    for f in sorted(MATERIALS_DIR.iterdir()):
        if f.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}:
            items.append({
                "name": f.stem,
                "filename": f.name,
                "url": f"/materials/{f.name}",
            })
    return items


@app.post("/enhance")
async def enhance(req: ProcessUploadRequest):
    """Step 1: Light blur + Flux 'Realistic render' → returns enhanced image for display."""
    _t0 = time.time()
    _t = time.time()
    original = base64_to_image(req.image)
    _te = time.time()
    original = ImageOps.exif_transpose(original)
    print(f"【用时测试】  ├─ EXIF修正: {time.time()-_te:.2f}s")
    if original.size != (req.width, req.height):
        print(f"[enhance] resizing {original.size} → {req.width}x{req.height}")
        _tr = time.time()
        original = original.resize((req.width, req.height), Image.LANCZOS)
        print(f"【用时测试】  ├─ 图片resize: {time.time()-_tr:.2f}s")
    print(f"[enhance] input size={original.size} mode={original.mode}")

    _tb = time.time()
    blurred = original.filter(ImageFilter.GaussianBlur(radius=0.5))
    print(f"【用时测试】  ├─ 图片模糊处理: {time.time()-_tb:.2f}s")
    enhanced = await call_flux2(PROMPT_CONFIG["enhance"], [blurred])
    _ts = time.time()
    enhanced.save(os.path.join(monitor.get_debug_dir(), "enhanced.png"))
    print(f"【用时测试】  ├─ 调试文件保存: {time.time()-_ts:.2f}s")
    print(f"[enhance] done size={enhanced.size}")

    result = {"enhancedImage": image_to_base64(enhanced, "JPEG")}
    print(f"【用时测试】enhance 总耗时: {time.time()-_t0:.2f}s")
    return result


@app.post("/process-masks")
async def process_masks(req: ProcessMasksRequest):
    """Steps 2-4: Flux2 clean → remote SAM3 → Flux2 refine → returns masks."""
    _t0 = time.time()
    enhanced = base64_to_image(req.enhancedImage)
    print(f"[process-masks] input size={enhanced.size}")

    # Step 2: Flux2 clean
    cleaned = await call_flux2(PROMPT_CONFIG["clean"], [enhanced])
    _ts = time.time()
    cleaned.save(os.path.join(monitor.get_debug_dir(), "cleaned.png"))
    print(f"【用时测试】  ├─ 调试文件保存(cleaned): {time.time()-_ts:.2f}s")
    print(f"[process-masks] cleaned size={cleaned.size}")

    # Step 3: Remote SAM3 segmentation
    seg = await call_sam3_remote(
        image=cleaned,
        prompts=["wall"],
        confidence=0.3,
    )
    print(f"[process-masks] SAM3 found {len(seg['masks'])} masks")
    masks = seg["masks"]

    mask_img = base64_to_image(seg["mask_only_b64"])
    _ts = time.time()
    mask_img.save(os.path.join(monitor.get_debug_dir(), "mask_raw.png"))
    print(f"【用时测试】  ├─ 调试文件保存(mask_raw): {time.time()-_ts:.2f}s")

    # Step 4: Flux2 refine mask
    refined = await call_flux2(PROMPT_CONFIG["refine"], [mask_img])
    _ts = time.time()
    refined.save(os.path.join(monitor.get_debug_dir(), "mask_refined.png"))
    print(f"【用时测试】  ├─ 调试文件保存(mask_refined): {time.time()-_ts:.2f}s")

    result = {
        "refinedMask": image_to_base64(refined, "PNG"),
        "rawMask": image_to_base64(mask_img, "PNG"),
        "masks": masks,
    }
    print(f"【用时测试】process-masks 总耗时: {time.time()-_t0:.2f}s")
    return result


@app.post("/process-upload")
async def process_upload(req: ProcessUploadRequest):
    """Legacy single-call endpoint — calls enhance + process_masks internally."""
    _t0 = time.time()
    enh = await enhance(req)
    masks_req = ProcessMasksRequest(enhancedImage=enh["enhancedImage"])
    result = await process_masks(masks_req)
    print(f"【用时测试】process-upload 总耗时: {time.time()-_t0:.2f}s")
    return {**enh, **result, "width": req.width, "height": req.height}


@app.post("/debug-segment")
async def debug_segment(req: DebugSegmentRequest):
    """Debug mode: skip enhance/clean/refine, just run SAM3 on original image."""
    _t0 = time.time()
    original = base64_to_image(req.image)
    _te = time.time()
    original = ImageOps.exif_transpose(original)
    print(f"【用时测试】  ├─ EXIF修正: {time.time()-_te:.2f}s")
    print(f"[debug-segment] input size={original.size}")

    seg = await call_sam3_remote(
        image=original,
        prompts=["wall"],
        confidence=0.3,
    )
    print(f"[debug-segment] SAM3 found {len(seg['masks'])} masks")
    masks = seg["masks"]

    mask_img = base64_to_image(seg["mask_only_b64"])
    _ts = time.time()
    mask_img.save(os.path.join(monitor.get_debug_dir(), "mask_raw.png"))
    print(f"【用时测试】  ├─ 调试文件保存: {time.time()-_ts:.2f}s")

    mask_b64 = image_to_base64(mask_img, "PNG")
    print(f"【用时测试】debug-segment 总耗时: {time.time()-_t0:.2f}s")
    return {
        "refinedMask": mask_b64,
        "rawMask": mask_b64,
        "masks": masks,
    }


@app.post("/apply-material")
async def apply_material(req: ApplyMaterialRequest):
    _t0 = time.time()
    original = base64_to_image(req.originalImage)

    material_path = MATERIALS_DIR / req.materialFilename
    if not material_path.exists():
        monitor.emit("材质加载", "error", extra={"message": f"材质文件未找到: {req.materialFilename}"})
        raise HTTPException(404, detail=f"Material not found: {req.materialFilename}")

    material = Image.open(material_path)

    result_img = await call_flux2(
        PROMPT_CONFIG["applyMaterial"],
        [original, material],
    )

    _ts = time.time()
    result_img.save(os.path.join(monitor.get_debug_dir(), "apply_material_result.png"))
    print(f"【用时测试】  ├─ 调试文件保存: {time.time()-_ts:.2f}s")

    result = {"resultImage": image_to_base64(result_img, "PNG")}
    print(f"【用时测试】apply-material 总耗时: {time.time()-_t0:.2f}s")
    return result


@app.post("/finalize")
async def finalize(req: FinalizeRequest):
    _t0 = time.time()
    composite = base64_to_image(req.compositeImage)
    blurred = composite.filter(ImageFilter.GaussianBlur(radius=1))

    final_img = await call_flux2(PROMPT_CONFIG["finalize"], [blurred])

    result = {"finalImage": image_to_base64(final_img, "PNG")}
    print(f"【用时测试】finalize 总耗时: {time.time()-_t0:.2f}s")
    return result


# ── V2 Endpoints (headless pipeline) ────────────────────────────────────────

@app.post("/api/v2/segment")
async def v2_segment(req: SegmentRequest):
    """
    Headless pipeline step 1:
    Upload image → enhance → clean → SAM3 → refine → return masks.
    """
    _t0 = time.time()
    # Decode & normalise
    original = base64_to_image(req.image)
    _te = time.time()
    original = ImageOps.exif_transpose(original)
    print(f"【用时测试】  ├─ EXIF修正: {time.time()-_te:.2f}s")
    print(f"[v2/segment] input size={original.size}")

    # Enhance
    _tb = time.time()
    blurred = original.filter(ImageFilter.GaussianBlur(radius=0.5))
    print(f"【用时测试】  ├─ 图片模糊处理: {time.time()-_tb:.2f}s")
    enhanced = await call_flux2(PROMPT_CONFIG["enhance"], [blurred])
    _ts = time.time()
    enhanced.save(os.path.join(monitor.get_debug_dir(), "enhanced.png"))
    print(f"【用时测试】  ├─ 调试文件保存(enhanced): {time.time()-_ts:.2f}s")

    # Clean
    cleaned = await call_flux2(PROMPT_CONFIG["clean"], [enhanced])
    _ts = time.time()
    cleaned.save(os.path.join(monitor.get_debug_dir(), "cleaned.png"))
    print(f"【用时测试】  ├─ 调试文件保存(cleaned): {time.time()-_ts:.2f}s")

    # SAM3 segment
    seg = await call_sam3_remote(image=cleaned, prompts=["wall"], confidence=0.3)
    masks = seg["masks"]
    mask_img = base64_to_image(seg["mask_only_b64"])
    _ts = time.time()
    mask_img.save(os.path.join(monitor.get_debug_dir(), "mask_raw.png"))
    print(f"【用时测试】  ├─ 调试文件保存(mask_raw): {time.time()-_ts:.2f}s")

    # Refine mask
    refined = await call_flux2(PROMPT_CONFIG["refine"], [mask_img])
    _ts = time.time()
    refined.save(os.path.join(monitor.get_debug_dir(), "mask_refined.png"))
    print(f"【用时测试】  ├─ 调试文件保存(mask_refined): {time.time()-_ts:.2f}s")

    result = {
        "enhancedImage": image_to_base64(enhanced, "JPEG"),
        "refinedMask": image_to_base64(refined, "PNG"),
        "rawMask": image_to_base64(mask_img, "PNG"),
        "masks": masks,
    }
    print(f"【用时测试】v2/segment 总耗时: {time.time()-_t0:.2f}s")
    return result


@app.post("/api/v2/render")
async def v2_render(req: RenderRequest):
    """
    Headless pipeline step 2:
    Upload image + list of {x, y, referenceImage, prompt} →
    resolve each (x,y) to a mask colour → parallel apply materials →
    composite → finalize → return final image.
    """
    _t0 = time.time()
    base_img = base64_to_image(req.image)
    mask_img = base64_to_image(req.refinedMask)
    print(f"[v2/render] base={base_img.size}  items={len(req.items)}")

    # Resolve each click point to the mask colour at that pixel
    mask_rgb = mask_img.convert("RGB")
    mask_w, mask_h = mask_rgb.size
    base_w, base_h = base_img.size

    def sample_mask_color(x: int, y: int) -> list[int]:
        # Scale coordinate from base image space to mask image space
        mx = round(x * mask_w / base_w)
        my = round(y * mask_h / base_h)
        mx = max(0, min(mx, mask_w - 1))
        my = max(0, min(my, mask_h - 1))
        r, g, b = mask_rgb.getpixel((mx, my))
        return [r, g, b]

    # Deduplicate: multiple points on the same colour only generate one call
    # Use the last item's prompt/referenceImage for a given colour
    color_key: dict[tuple, CoordRegionItem] = {}
    for item in req.items:
        color = tuple(sample_mask_color(item.x, item.y))
        color_key[color] = item
        print(f"[v2/render] ({item.x},{item.y}) → mask colour {color}")

    # Parallel apply-material for each unique region
    async def apply_one(color: tuple, item: CoordRegionItem) -> tuple[list[int], Image.Image]:
        mat = base64_to_image(item.referenceImage)
        result = await call_flux2(PROMPT_CONFIG["applyMaterial"], [base_img, mat])
        return list(color), result

    tasks = [apply_one(c, it) for c, it in color_key.items()]
    results = await asyncio.gather(*tasks)

    region_colors = [r[0] for r in results]
    region_results = [r[1] for r in results]

    # Composite all regions onto base
    _tc = time.time()
    composited = composite_regions(base_img, mask_img, region_colors, region_results)
    print(f"【用时测试】  ├─ 区域合成: {time.time()-_tc:.2f}s")
    _ts = time.time()
    composited.save(os.path.join(monitor.get_debug_dir(), "v2_composite.png"))
    print(f"【用时测试】  ├─ 调试文件保存(v2_composite): {time.time()-_ts:.2f}s")

    # Finalize
    blurred = composited.filter(ImageFilter.GaussianBlur(radius=1))
    final_img = await call_flux2(PROMPT_CONFIG["finalize"], [blurred])
    _ts = time.time()
    final_img.save(os.path.join(monitor.get_debug_dir(), "v2_final.png"))
    print(f"【用时测试】  ├─ 调试文件保存(v2_final): {time.time()-_ts:.2f}s")

    result = {"finalImage": image_to_base64(final_img, "PNG")}
    print(f"【用时测试】v2/render 总耗时: {time.time()-_t0:.2f}s")
    return result


class PreprocessRequest(BaseModel):
    image: str  # raw base64


class PreprocessRequest(BaseModel):
    image: str  # raw base64


class ApplyMaterialV2Request(BaseModel):
    enforcedImage: str   # raw base64 PNG — EnforcedResult from preprocess
    maskImage: str       # raw base64 PNG — B&W mask for the target region
    materialImage: str   # raw base64 PNG — material reference texture


class FinalizeV2Request(BaseModel):
    compositeImage: str  # raw base64 PNG — all regions composited


class RenderAllItem(BaseModel):
    x: int                    # 用户点击位置 X 坐标（相对于 enforcedImage 的像素坐标）
    y: int                    # 用户点击位置 Y 坐标
    materialImage: str        # 材质参考图 raw base64
    prompt: str = "based on image 2, change all wall material in image 1."  # 该区域的替换提示词（预留）


class RenderAllRequest(BaseModel):
    enforcedImage: str        # preprocess 返回的 enforcedResult, raw base64
    masks: list[str]          # preprocess 返回的 masks[] B&W蒙版数组, 每个元素为 raw base64 PNG
    items: list[RenderAllItem]  # 要替换的区域列表


def detect_mask_type(mask: Image.Image) -> str:
    """
    Detect mask type from image colors.
    B&W mask (white non-black pixels) → "wall"
    Black-red mask (red non-black pixels) → "ceiling"
    """
    rgb = mask.convert("RGB")
    arr = np.array(rgb)
    # Find non-black pixels (any channel > 128)
    non_black = arr.max(axis=2) > 128
    if not non_black.any():
        return "wall"  # all black, default to wall

    # Sample non-black pixel colors
    non_black_pixels = arr[non_black]
    avg_r = float(non_black_pixels[:, 0].mean())
    avg_g = float(non_black_pixels[:, 1].mean())
    avg_b = float(non_black_pixels[:, 2].mean())

    # If red channel is dominant and green/blue are low → ceiling (red mask)
    if avg_r > 128 and avg_g < 80 and avg_b < 80:
        return "ceiling"
    return "wall"


async def call_comfyui_apply_material(
    enforced: Image.Image,
    mask: Image.Image,
    material: Image.Image,
) -> Image.Image:
    """
    Call the 区域洗图 ComfyUI workflow.
    Nodes:
      "72"  → enforced image (scene)
      "502" → material reference
      "553" → B&W mask image
    Output node "500" → masked result with alpha channel.
    """
    import uuid, json
    _t0 = time.time()

    workflow_path = Path(__file__).parent / "comfyui_apply_material_workflow.json"
    with open(workflow_path, "r", encoding="utf-8") as f:
        workflow = json.load(f)

    base_url = COMFYUI_HOST.rstrip("/")
    client_id = str(uuid.uuid4())

    async with httpx.AsyncClient(timeout=600) as client:
        async def upload(img: Image.Image, name: str) -> str:
            _tu = time.time()
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            buf.seek(0)
            resp = await client.post(
                f"{base_url}/upload/image",
                files={"image": (name, buf, "image/png")},
                data={"overwrite": "true"},
            )
            resp.raise_for_status()
            print(f"【用时测试】  ├─ ComfyUI上传图片({name}, apply_material): {time.time()-_tu:.2f}s")
            return resp.json()["name"]

        monitor.emit("ComfyUI上传", "start")
        enforced_name = await upload(enforced, "wc_enforced.png")
        material_name = await upload(material, "wc_material.png")
        mask_name     = await upload(mask,     "wc_mask.png")
        print(f"[comfyui-apply] uploaded enforced={enforced_name} material={material_name} mask={mask_name}")
        monitor.emit("ComfyUI上传", "done")

        workflow["72"]["inputs"]["image"]  = enforced_name
        workflow["502"]["inputs"]["image"] = material_name
        workflow["553"]["inputs"]["image"] = mask_name

        # Auto-detect mask type from image colors
        mask_type = detect_mask_type(mask)
        print(f"[comfyui-apply] detected mask_type={mask_type}")

        if mask_type == "ceiling":
            workflow["501:491"]["inputs"]["text"] = PROMPT_CONFIG["ceilingMaterial"]
        else:
            workflow["501:491"]["inputs"]["text"] = PROMPT_CONFIG["wallMaterial"]

        _tq = time.time()
        resp = await client.post(f"{base_url}/prompt", json={"prompt": workflow, "client_id": client_id})
        prompt_resp_data = resp.json()

        # 先打印 ComfyUI 返回的完整错误信息
        if resp.status_code != 200:
            print(f"[comfyui-apply] ERROR: ComfyUI returned {resp.status_code}: {json.dumps(prompt_resp_data, indent=2, ensure_ascii=False)[:2000]}")

        resp.raise_for_status()

        # 检查 ComfyUI 错误
        if "error" in prompt_resp_data:
            error_msg = prompt_resp_data.get("error", "Unknown error")
            node_errors = prompt_resp_data.get("node_errors", {})
            print(f"[comfyui-apply] ERROR: ComfyUI prompt error: {error_msg}")
            if node_errors:
                print(f"[comfyui-apply] ERROR: node_errors: {node_errors}")
            raise Exception(f"Invalid prompt: {error_msg}")

        prompt_id = prompt_resp_data.get("prompt_id")
        if not prompt_id:
            print(f"[comfyui-apply] ERROR: No prompt_id in response: {prompt_resp_data}")
            raise Exception("ComfyUI did not return prompt_id")
        print(f"[comfyui-apply] queued prompt_id={prompt_id}")
        _tq_dur = time.time()-_tq
        print(f"【用时测试】  ├─ ComfyUI提交工作流(apply_material): {_tq_dur:.2f}s")
        monitor.emit("ComfyUI提交工作流", "done", duration=_tq_dur)

        monitor.emit("ComfyUI执行", "start")
        _tp = time.time()
        for _ in range(1200):
            await asyncio.sleep(0.5)
            hist = (await client.get(f"{base_url}/history/{prompt_id}")).json()
            if prompt_id in hist:
                outputs = hist[prompt_id].get("outputs", {})
                break
        else:
            monitor.emit("ComfyUI执行", "error", extra={"message": "ComfyUI apply-material 执行超时"})
            raise HTTPException(504, detail="ComfyUI apply-material timed out")
        _tp_dur = time.time()-_tp
        print(f"【用时测试】  ├─ ComfyUI工作流执行等待(apply_material): {_tp_dur:.2f}s")
        monitor.emit("ComfyUI执行", "done", duration=_tp_dur)

        # --- DEBUG: inspect ComfyUI outputs ---
        print(f"[comfyui-apply] DEBUG: outputs keys = {list(outputs.keys())}")
        if "status" in hist.get(prompt_id, {}):
            _status = hist[prompt_id]["status"]
            print(f"[comfyui-apply] DEBUG: execution status = {_status}")
        # --- END DEBUG ---

        imgs = outputs.get("500", {}).get("images", [])
        if not imgs:
            monitor.emit("ComfyUI执行", "error", extra={"message": "ComfyUI apply-material 未返回图片"})
            raise HTTPException(500, detail="ComfyUI apply-material returned no image")

        _td = time.time()
        r = await client.get(
            f"{base_url}/view",
            params={"filename": imgs[0]["filename"], "subfolder": imgs[0].get("subfolder", ""), "type": imgs[0].get("type", "output")},
        )
        r.raise_for_status()
        _td_dur = time.time()-_td
        print(f"【用时测试】  ├─ ComfyUI结果下载(apply_material): {_td_dur:.2f}s")
        monitor.emit("结果下载", "done", duration=_td_dur, image_path="apply_material_result.png")

    result = Image.open(io.BytesIO(r.content))
    print(f"[comfyui-apply] result size={result.size} mode={result.mode}")
    print(f"【用时测试】  ├─ call_comfyui_apply_material总耗时: {time.time()-_t0:.2f}s")
    return result


async def call_comfyui_finalize(composite: Image.Image) -> Image.Image:
    """
    Call the 重洗 ComfyUI workflow.
    Node "72" → composite image.
    Output node "500" → final polished image.
    """
    import uuid, json
    _t0 = time.time()

    workflow_path = Path(__file__).parent / "comfyui_finalize_workflow.json"
    with open(workflow_path, "r", encoding="utf-8") as f:
        workflow = json.load(f)

    base_url = COMFYUI_HOST.rstrip("/")
    client_id = str(uuid.uuid4())

    async with httpx.AsyncClient(timeout=600) as client:
        monitor.emit("Finalize上传", "start")
        _tu = time.time()
        buf = io.BytesIO()
        composite.save(buf, format="PNG")
        buf.seek(0)
        resp = await client.post(
            f"{base_url}/upload/image",
            files={"image": ("wc_composite.png", buf, "image/png")},
            data={"overwrite": "true"},
        )
        resp.raise_for_status()
        comp_name = resp.json()["name"]
        print(f"[comfyui-finalize] uploaded composite={comp_name}")
        _tu_dur = time.time()-_tu
        print(f"【用时测试】  ├─ ComfyUI上传图片(finalize): {_tu_dur:.2f}s")
        monitor.emit("Finalize上传", "done", duration=_tu_dur)

        workflow["72"]["inputs"]["image"] = comp_name

        _tq = time.time()
        resp = await client.post(f"{base_url}/prompt", json={"prompt": workflow, "client_id": client_id})
        prompt_resp_data = resp.json()

        # 先打印 ComfyUI 返回的完整错误信息
        if resp.status_code != 200:
            print(f"[comfyui-finalize] ERROR: ComfyUI returned {resp.status_code}: {json.dumps(prompt_resp_data, indent=2, ensure_ascii=False)[:2000]}")

        resp.raise_for_status()

        # 检查 ComfyUI 错误
        if "error" in prompt_resp_data:
            error_msg = prompt_resp_data.get("error", "Unknown error")
            node_errors = prompt_resp_data.get("node_errors", {})
            print(f"[comfyui-finalize] ERROR: ComfyUI prompt error: {error_msg}")
            if node_errors:
                print(f"[comfyui-finalize] ERROR: node_errors: {node_errors}")
            raise Exception(f"Invalid prompt: {error_msg}")

        prompt_id = prompt_resp_data.get("prompt_id")
        if not prompt_id:
            print(f"[comfyui-finalize] ERROR: No prompt_id in response: {prompt_resp_data}")
            raise Exception("ComfyUI did not return prompt_id")
        print(f"[comfyui-finalize] queued prompt_id={prompt_id}")
        _tq_dur = time.time()-_tq
        print(f"【用时测试】  ├─ ComfyUI提交工作流(finalize): {_tq_dur:.2f}s")
        monitor.emit("Finalize提交工作流", "done", duration=_tq_dur)

        monitor.emit("Finalize执行", "start")
        _tp = time.time()
        for _ in range(1200):
            await asyncio.sleep(0.5)
            hist = (await client.get(f"{base_url}/history/{prompt_id}")).json()
            if prompt_id in hist:
                outputs = hist[prompt_id].get("outputs", {})
                break
        else:
            monitor.emit("Finalize执行", "error", extra={"message": "ComfyUI finalize 执行超时"})
            raise HTTPException(504, detail="ComfyUI finalize timed out")
        _tp_dur = time.time()-_tp
        print(f"【用时测试】  ├─ ComfyUI工作流执行等待(finalize): {_tp_dur:.2f}s")
        monitor.emit("Finalize执行", "done", duration=_tp_dur)

        # --- DEBUG: inspect ComfyUI outputs ---
        print(f"[comfyui-finalize] DEBUG: outputs keys = {list(outputs.keys())}")
        if "status" in hist.get(prompt_id, {}):
            _status = hist[prompt_id]["status"]
            print(f"[comfyui-finalize] DEBUG: execution status = {_status}")
        # --- END DEBUG ---

        imgs = outputs.get("500", {}).get("images", [])
        if not imgs:
            monitor.emit("Finalize执行", "error", extra={"message": "ComfyUI finalize 未返回图片"})
            raise HTTPException(500, detail="ComfyUI finalize returned no image")

        _td = time.time()
        r = await client.get(
            f"{base_url}/view",
            params={"filename": imgs[0]["filename"], "subfolder": imgs[0].get("subfolder", ""), "type": imgs[0].get("type", "output")},
        )
        r.raise_for_status()
        _td_dur = time.time()-_td
        print(f"【用时测试】  ├─ ComfyUI结果下载(finalize): {_td_dur:.2f}s")
        monitor.emit("Finalize结果下载", "done", duration=_td_dur)

    result = Image.open(io.BytesIO(r.content))
    print(f"[comfyui-finalize] result size={result.size} mode={result.mode}")
    print(f"【用时测试】  ├─ call_comfyui_finalize总耗时: {time.time()-_t0:.2f}s")
    return result


async def call_comfyui_mask_workflow(image: Image.Image) -> tuple[Image.Image, list[Image.Image], list[Image.Image]]:
    """
    Call the 多乐士 ComfyUI mask-detection workflow.
    Returns (enforced_result, wall_masks, ceiling_masks).
    """
    import uuid
    import json
    _t0 = time.time()

    workflow_path = Path(__file__).parent / "comfyui_mask_workflow.json"
    with open(workflow_path, "r", encoding="utf-8") as f:
        workflow = json.load(f)

    base_url = COMFYUI_HOST.rstrip("/")
    client_id = str(uuid.uuid4())

    # ── 诊断日志：检查输入图像状态 ──
    print(f"[comfyui-mask] 输入图像 mode={image.mode}, size={image.size}")
    if image.mode == "RGBA":
        print(f"[comfyui-mask] 检测到RGBA模式，转换为RGB")
        image = image.convert("RGB")

    async with httpx.AsyncClient(timeout=600) as client:
        # Upload image
        monitor.emit("ComfyUI上传", "start")
        _tu = time.time()
        buf = io.BytesIO()
        image.save(buf, format="PNG")
        buf.seek(0)
        print(f"[comfyui-mask] 上传图片大小: {buf.getbuffer().nbytes} bytes")
        resp = await client.post(
            f"{base_url}/upload/image",
            files={"image": ("wallchanger_input.png", buf, "image/png")},
            data={"overwrite": "true"},
        )
        resp.raise_for_status()
        uploaded_name = resp.json()["name"]
        print(f"[comfyui-mask] uploaded as {uploaded_name}")
        _tu_dur = time.time()-_tu
        print(f"【用时测试】  ├─ ComfyUI上传图片(mask_workflow): {_tu_dur:.2f}s")
        monitor.emit("ComfyUI上传", "done", duration=_tu_dur)

        # Patch LoadImage node "72"
        workflow["72"]["inputs"]["image"] = uploaded_name

        # Queue prompt
        _tq = time.time()
        payload = {"prompt": workflow, "client_id": client_id}
        resp = await client.post(f"{base_url}/prompt", json=payload)
        prompt_resp_data = resp.json()
        if "error" in prompt_resp_data:
            print(f"[comfyui-mask] ERROR: ComfyUI prompt submission error: {prompt_resp_data['error']}")
        if "node_errors" in prompt_resp_data and prompt_resp_data["node_errors"]:
            print(f"[comfyui-mask] ERROR: ComfyUI node_errors: {prompt_resp_data['node_errors']}")
        resp.raise_for_status()
        prompt_id = prompt_resp_data["prompt_id"]
        print(f"[comfyui-mask] queued prompt_id={prompt_id}")
        _tq_dur = time.time()-_tq
        print(f"【用时测试】  ├─ ComfyUI提交工作流(mask_workflow): {_tq_dur:.2f}s")
        monitor.emit("ComfyUI提交工作流", "done", duration=_tq_dur)

        # Poll for completion
        monitor.emit("ComfyUI执行", "start")
        _tp = time.time()
        for _ in range(1200):  # up to ~10 minutes
            await asyncio.sleep(0.5)
            hist_resp = await client.get(f"{base_url}/history/{prompt_id}")
            hist_resp.raise_for_status()
            history = hist_resp.json()
            if prompt_id in history:
                outputs = history[prompt_id].get("outputs", {})
                break
        else:
            monitor.emit("ComfyUI执行", "error", extra={"message": "ComfyUI mask workflow 执行超时"})
            raise HTTPException(504, detail="ComfyUI mask workflow timed out")
        _tp_dur = time.time()-_tp
        print(f"【用时测试】  ├─ ComfyUI工作流执行等待(mask_workflow): {_tp_dur:.2f}s")
        monitor.emit("ComfyUI执行", "done", duration=_tp_dur)

        _td = time.time()
        async def download_image(img_info: dict) -> Image.Image:
            r = await client.get(
                f"{base_url}/view",
                params={
                    "filename": img_info["filename"],
                    "subfolder": img_info.get("subfolder", ""),
                    "type": img_info.get("type", "output"),
                },
            )
            r.raise_for_status()
            return Image.open(io.BytesIO(r.content))

        # --- DEBUG: inspect ComfyUI outputs ---
        print(f"[comfyui-mask] DEBUG: outputs keys = {list(outputs.keys())}")
        print(f"[comfyui-mask] DEBUG: node 500 output = {outputs.get('500', 'NOT FOUND')}")
        print(f"[comfyui-mask] DEBUG: node 554 output = {outputs.get('554', 'NOT FOUND')}")
        print(f"[comfyui-mask] DEBUG: node 564 output = {outputs.get('564', 'NOT FOUND')}")
        if "status" in history.get(prompt_id, {}):
            _status = history[prompt_id]["status"]
            print(f"[comfyui-mask] DEBUG: execution status = {_status}")
            if _status.get("status_str") == "error":
                _msgs = _status.get("messages", [])
                print(f"[comfyui-mask] ERROR: 工作流执行失败! messages={_msgs}")
        # 检查是否有节点执行错误
        if prompt_id in history:
            _node_errors = history[prompt_id].get("status", {}).get("messages", [])
            for msg in _node_errors:
                if isinstance(msg, list) and len(msg) >= 2 and "error" in str(msg[0]).lower():
                    print(f"[comfyui-mask] NODE ERROR: {msg}")
        # --- END DEBUG ---

        # ── 诊断：下载中间调试图片 ──
        _diag_dir = monitor.get_debug_dir()
        # Node "569" → SAM3输入图 (经Flux2处理后的图)
        _sam3_input_imgs = outputs.get("569", {}).get("images", [])
        if _sam3_input_imgs:
            _sam3_in = await download_image(_sam3_input_imgs[0])
            _sam3_in_path = os.path.join(_diag_dir, "debug_sam3_input.png")
            _sam3_in.save(_sam3_in_path)
            print(f"[comfyui-mask] ✅ 已保存 SAM3输入图: {_sam3_in_path}  (size={_sam3_in.size})")
        else:
            print(f"[comfyui-mask] ⚠️ 未找到SAM3输入图 (node 569) - Flux2可能执行失败!")
        # Node "571" → Flux2第2步输出
        _flux2_imgs = outputs.get("571", {}).get("images", [])
        if _flux2_imgs:
            _flux2_out = await download_image(_flux2_imgs[0])
            _flux2_out_path = os.path.join(_diag_dir, "debug_flux2_pass2.png")
            _flux2_out.save(_flux2_out_path)
            print(f"[comfyui-mask] ✅ 已保存 Flux2第2步输出图: {_flux2_out_path}  (size={_flux2_out.size})")
        else:
            print(f"[comfyui-mask] ⚠️ 未找到Flux2第2步输出图 (node 571)")

        # Node "554" → EnforcedResult (SaveImage output)
        enforced_imgs = outputs.get("554", {}).get("images", [])
        if not enforced_imgs:
            monitor.emit("结果下载", "error", extra={"message": "ComfyUI 未返回 EnforcedResult 图片 (node 554)"})
            raise HTTPException(500, detail="ComfyUI returned no EnforcedResult image (node 554)")
        enforced_result = await download_image(enforced_imgs[0])
        print(f"[comfyui-mask] EnforcedResult size={enforced_result.size}")

        # Node "500" → Wall Mask images (batch, one per wall region)
        wall_mask_imgs_info = outputs.get("500", {}).get("images", [])
        if not wall_mask_imgs_info:
            monitor.emit("结果下载", "error", extra={"message": "ComfyUI 未返回墙面蒙版图片"})
            raise HTTPException(500, detail="ComfyUI returned no wall mask images")
        wall_mask_images = []
        for info in wall_mask_imgs_info:
            m = await download_image(info)
            wall_mask_images.append(m)
        print(f"[comfyui-mask] received {len(wall_mask_images)} wall mask(s)")
        # ── 诊断：检查 wall mask 是否全黑 ──
        for i, wm in enumerate(wall_mask_images):
            arr = np.array(wm)
            _max_val = arr.max()
            _mean_val = arr.mean()
            print(f"[comfyui-mask] wall_mask[{i}] size={wm.size} mode={wm.mode} max_pixel={_max_val} mean_pixel={_mean_val:.2f}")
            if _max_val == 0:
                print(f"[comfyui-mask] ⚠️ WARNING: wall_mask[{i}] 全黑！SAM3可能未识别到墙体")

        # Node "564" → Ceiling Mask images (may be empty if no ceiling detected)
        ceiling_mask_imgs_info = outputs.get("564", {}).get("images", [])
        ceiling_mask_images = []
        for info in ceiling_mask_imgs_info:
            m = await download_image(info)
            ceiling_mask_images.append(m)
        print(f"[comfyui-mask] received {len(ceiling_mask_images)} ceiling mask(s)")
        _td_dur = time.time()-_td
        print(f"【用时测试】  ├─ ComfyUI结果下载(mask_workflow, {len(wall_mask_images)+len(ceiling_mask_images)+1}张图片): {_td_dur:.2f}s")
        # Save mask result thumbnail: force-load pixel data and convert to RGB
        # to avoid lazy-loading / mode issues when converting from JPEG to PNG
        _mask_thumb_path = None
        try:
            enforced_result.load()  # force decode from BytesIO before it can be GC'd
            enforced_result.convert("RGB").save(
                os.path.join(monitor.get_debug_dir(), "mask_result.png"), format="PNG"
            )
            _mask_thumb_path = "mask_result.png"
        except Exception as _e:
            print(f"[comfyui-mask] WARNING: Failed to save mask_result.png: {_e}")
        monitor.emit("结果下载", "done", duration=_td_dur, image_path=_mask_thumb_path)

    print(f"【用时测试】  ├─ call_comfyui_mask_workflow总耗时: {time.time()-_t0:.2f}s")
    return enforced_result, wall_mask_images, ceiling_mask_images


@app.post("/api/v2/preprocess")
async def v2_preprocess(req: PreprocessRequest):
    """
    New preprocessing endpoint: upload image → ComfyUI 多乐士 workflow
    → returns EnforcedResult image + list of B&W mask images.
    Replaces the old enhance + process-masks pipeline.
    """
    _t0 = time.time()
    monitor.start_request("preprocess")
    monitor.emit("preprocess_请求开始", "done", duration=0)
    _success = False
    try:
        original = base64_to_image(req.image)
        original.save(os.path.join(monitor.get_debug_dir(), "original_input.png"))
        monitor.emit("图片接收", "done", image_path="original_input.png")
        _te = time.time()
        original = ImageOps.exif_transpose(original)
        _te_dur = time.time()-_te
        print(f"【用时测试】  ├─ EXIF修正: {_te_dur:.2f}s")
        monitor.emit("EXIF修正", "done", duration=_te_dur)
        print(f"[v2/preprocess] input size={original.size}")

        enforced_result, wall_masks, ceiling_masks = await call_comfyui_mask_workflow(original)

        # Save debug copies
        _ts = time.time()
        debug_dir = monitor.get_debug_dir()
        enforced_result.save(os.path.join(debug_dir, "enforced_result.png"))
        for i, m in enumerate(wall_masks):
            m.save(os.path.join(debug_dir, f"bw_mask_wall_{i}.png"))
        for i, m in enumerate(ceiling_masks):
            m.save(os.path.join(debug_dir, f"bw_mask_ceiling_{i}.png"))

        # Save to dedicated frontend debug folder (not mixed with session dirs)
        fe_debug_dir = os.path.join(os.path.dirname(__file__), "debug", "debug frontend")
        os.makedirs(fe_debug_dir, exist_ok=True)
        enforced_result.save(os.path.join(fe_debug_dir, "enforced_result.png"))
        for i, m in enumerate(wall_masks):
            m.save(os.path.join(fe_debug_dir, f"bw_mask_wall_{i}.png"))
        for i, m in enumerate(ceiling_masks):
            m.save(os.path.join(fe_debug_dir, f"bw_mask_ceiling_{i}.png"))
        print(f"[debug frontend] saved {1+len(wall_masks)+len(ceiling_masks)} files to {fe_debug_dir}")

        _ts_dur = time.time()-_ts
        print(f"【用时测试】  ├─ 调试文件保存({1+len(wall_masks)+len(ceiling_masks)}个文件): {_ts_dur:.2f}s")
        monitor.emit("调试保存", "done", duration=_ts_dur)

        _tb64 = time.time()
        result = {
            "enforcedResult": image_to_base64(enforced_result, "PNG"),
            "masks": [
                *[image_to_base64(m, "PNG") for m in wall_masks],
                *[image_to_base64(m, "PNG") for m in ceiling_masks],
            ],
        }
        _tb64_dur = time.time()-_tb64
        monitor.emit("base64编码", "done", duration=_tb64_dur)
        _total = time.time()-_t0
        print(f"【用时测试】preprocess 总耗时: {_total:.2f}s")
        monitor.end_request("preprocess", _total)
        _success = True
        return result
    except HTTPException as e:
        monitor.emit("preprocess", "error", duration=time.time()-_t0, extra={"message": e.detail})
        raise
    except Exception as e:
        monitor.emit("preprocess", "error", duration=time.time()-_t0, extra={"message": str(e)})
        raise HTTPException(500, detail=str(e))
    finally:
        if not _success and monitor.current_task:
            monitor.current_task["status"] = "error"
            monitor._emit_task_status("error")


@app.post("/api/v2/render")
@app.post("/api/v2/apply-material")
async def v2_render_region(req: "ApplyMaterialV2Request"):
    """
    Apply a material to one wall region using the 区域洗图 ComfyUI workflow.
    Inputs:
      - enforcedImage: base64 PNG — the EnforcedResult from preprocess
      - maskImage:     base64 PNG — the B&W mask for the target region
      - materialImage: base64 PNG — the material reference texture
    Returns:
      - resultImage: base64 PNG with alpha channel (masked region only)
    This endpoint is synchronous — only one call runs at a time on the ComfyUI side.
    """
    _t0 = time.time()
    enforced = base64_to_image(req.enforcedImage)
    mask     = base64_to_image(req.maskImage)
    material = base64_to_image(req.materialImage)
    print(f"[v2/render] enforced={enforced.size} mask={mask.size} material={material.size}")

    result = await call_comfyui_apply_material(enforced, mask, material)
    _ts = time.time()
    result.save(os.path.join(monitor.get_debug_dir(), "apply_material_result.png"))
    print(f"【用时测试】  ├─ 调试文件保存: {time.time()-_ts:.2f}s")

    resp = {"resultImage": image_to_base64(result, "PNG")}
    print(f"【用时测试】v2/apply-material 总耗时: {time.time()-_t0:.2f}s")
    return resp


@app.post("/api/v2/finalize")
async def v2_finalize(req: "FinalizeV2Request"):
    """
    Final polish pass using the 重洗 ComfyUI workflow.
    Input:  compositeImage — base64 PNG of all regions composited together
    Output: finalImage — base64 PNG
    """
    _t0 = time.time()
    composite = base64_to_image(req.compositeImage)
    print(f"[v2/finalize] composite={composite.size}")

    final = await call_comfyui_finalize(composite)
    _ts = time.time()
    final.save(os.path.join(monitor.get_debug_dir(), "v2_final.png"))
    print(f"【用时测试】  ├─ 调试文件保存: {time.time()-_ts:.2f}s")

    result = {"finalImage": image_to_base64(final, "PNG")}
    print(f"【用时测试】v2/finalize 总耗时: {time.time()-_t0:.2f}s")
    return result


@app.post("/api/v2/render-all")
async def v2_render_all(req: RenderAllRequest):
    """
    Batch render: match masks by coordinate, apply materials, composite, and finalize.
    For each item, finds the mask where (x,y) is white, applies the material via ComfyUI,
    composites RGBA results onto the base image, then runs the finalize workflow.
    Returns the final polished image.
    """
    _t0 = time.time()
    monitor.start_request("render-all")
    monitor.emit("renderall_请求开始", "done", duration=0)
    _success = False
    try:
        if not req.items:
            monitor.emit("坐标匹配", "error", extra={"message": "items 列表为空"})
            raise HTTPException(400, detail="items list is empty")

        enforced_pil = base64_to_image(req.enforcedImage)
        enforced_pil.save(os.path.join(monitor.get_debug_dir(), "original_input.png"))
        # Note: start_request("render-all") already emitted "render-all" start
        base_image = enforced_pil.convert("RGB")
        _tm = time.time()
        masks_pil = [base64_to_image(m) for m in req.masks]
        _tm_dur = time.time()-_tm
        print(f"【用时测试】  ├─ 解码所有薙版图片({len(masks_pil)}张): {_tm_dur:.2f}s")
        monitor.emit("解码蒙版", "done", duration=_tm_dur, image_path="original_input.png")
        print(f"[v2/render-all] base={base_image.size} masks={len(masks_pil)} items={len(req.items)}")

        # 为每个 item 匹配蒙版，并去重（同一蒙版取最后一个 item）
        region_map = {}  # mask_index -> item
        for item in req.items:
            matched_idx = None
            for i, mask in enumerate(masks_pil):
                rgb = mask.convert("RGB")
                cx = max(0, min(item.x, rgb.width - 1))
                cy = max(0, min(item.y, rgb.height - 1))
                r, g, b = rgb.getpixel((cx, cy))
                if max(r, g, b) > 128:
                    matched_idx = i
                    break
            if matched_idx is not None:
                region_map[matched_idx] = item  # 后面的覆盖前面的（去重）
                print(f"[v2/render-all] point ({item.x},{item.y}) → mask #{matched_idx}")
            else:
                print(f"[v2/render-all] WARNING: point ({item.x},{item.y}) matched no mask, skipping")
                monitor.emit("坐标匹配", "warning", extra={"message": f"点({item.x},{item.y})未匹配到任何蒙版，已跳过"})

        if not region_map:
            monitor.emit("坐标匹配", "error", extra={"message": "没有任何点击点匹配到蒙版区域"})
            raise HTTPException(400, detail="No items matched any mask region")

        # ── 生成坐标调试图 ──
        debug_img = enforced_pil.copy().convert("RGBA")
        colors = ["#FF0000", "#0000FF", "#00FF00", "#FF00FF", "#FFFF00", "#00FFFF"]
        overlay_colors = [
            (255, 0, 0, 80),    # 红色半透明
            (0, 0, 255, 80),    # 蓝色半透明
            (0, 255, 0, 80),    # 绿色半透明
            (255, 0, 255, 80),  # 紫色半透明
            (255, 255, 0, 80),  # 黄色半透明
            (0, 255, 255, 80),  # 青色半透明
        ]
        # 叠加每个 mask 的半透明彩色层
        for idx, mask_img in enumerate(masks_pil):
            color = overlay_colors[idx % len(overlay_colors)]
            # 用 RGB 最大值作为 alpha 遮罩，兼容红色天花蒙版
            rgb_arr = np.array(mask_img.convert("RGB"))
            mask_gray = Image.fromarray(rgb_arr.max(axis=2).astype(np.uint8), mode="L")
            overlay = Image.new("RGBA", debug_img.size, (0, 0, 0, 0))
            colored = Image.new("RGBA", debug_img.size, color)
            overlay = Image.composite(colored, overlay, mask_gray)
            debug_img = Image.alpha_composite(debug_img, overlay)
        # 画坐标点
        draw = ImageDraw.Draw(debug_img)
        for i, item in enumerate(req.items):
            x, y = item.x, item.y
            color = colors[i % len(colors)]
            r = 15
            draw.ellipse([x-r, y-r, x+r, y+r], fill=color, outline="white", width=2)
            draw.text((x+r+5, y-10), f"#{i}", fill="white")
        debug_dir = monitor.get_debug_dir()
        debug_img.convert("RGB").save(os.path.join(debug_dir, "coordinate_debug.png"))

        # ── 保存每个 item 的 materialImage ──
        for i, item in enumerate(req.items):
            try:
                mat_img = base64_to_image(item.materialImage)
                mat_img.save(os.path.join(debug_dir, f"material_{i}.png"))
            except Exception:
                pass

        # ── 构建 points 信息 ──
        points_info = []
        for i, item in enumerate(req.items):
            matched = any(idx for idx, it in region_map.items() if it is item)
            points_info.append({"x": item.x, "y": item.y, "matched": matched, "materialImage": f"material_{i}.png"})

        monitor.emit("坐标匹配", "done",
            image_path="coordinate_debug.png",
            extra={
                "matchedRegions": len(region_map),
                "debugImages": {
                    "coordinateMap": "coordinate_debug.png",
                    "materials": [f"material_{i}.png" for i in range(len(req.items))]
                },
                "points": points_info
            }
        )

        # 逐区域渲染
        success_count = 0
        for i_region, (mask_idx, item) in enumerate(region_map.items()):
            try:
                _tr = time.time()
                monitor.emit(f"区域渲染#{i_region}", "start")
                enforced = base64_to_image(req.enforcedImage)
                mask = masks_pil[mask_idx]
                material = base64_to_image(item.materialImage)
                print(f"[v2/render-all] rendering mask #{mask_idx} material={material.size}")

                result_rgba = await call_comfyui_apply_material(enforced, mask, material)

                # Ensure RGBA mode for alpha compositing
                if result_rgba.mode != "RGBA":
                    result_rgba = result_rgba.convert("RGBA")

                # Resize result to match base if needed
                if result_rgba.size != base_image.size:
                    result_rgba = result_rgba.resize(base_image.size, Image.LANCZOS)

                # Alpha-composite onto base
                _tcomp = time.time()
                base_image.paste(result_rgba, (0, 0), result_rgba.split()[3])
                _tcomp_dur = time.time()-_tcomp
                print(f"【用时测试】  ├─ Alpha合成(mask #{mask_idx}): {_tcomp_dur:.2f}s")
                success_count += 1
                print(f"[v2/render-all] mask #{mask_idx} composited successfully")
                _tr_dur = time.time()-_tr
                print(f"【用时测试】  ├─ 区域渲染(mask #{mask_idx})总耗时: {_tr_dur:.2f}s")
                monitor.emit(f"区域渲染#{i_region}", "done", duration=_tr_dur, image_path="apply_material_result.png")

            except Exception as e:
                print(f"[v2/render-all] mask #{mask_idx} FAILED: {e}")
                monitor.emit(f"区域渲染#{i_region}", "error", extra={"message": f"mask #{mask_idx} 渲染失败: {e}"})
                continue

        if success_count == 0:
            monitor.emit("区域渲染", "error", extra={"message": "所有区域渲染均失败"})
            raise HTTPException(500, detail="All region renders failed")

        print(f"[v2/render-all] {success_count}/{len(region_map)} regions rendered, running finalize...")
        _ts = time.time()
        base_image.save(os.path.join(monitor.get_debug_dir(), "v2_render_all_composite.png"))
        _ts_dur = time.time()-_ts
        print(f"【用时测试】  ├─ 调试文件保存(composite): {_ts_dur:.2f}s")
        monitor.emit("Alpha合成", "done", duration=_ts_dur, image_path="v2_render_all_composite.png")

        # Finalize
        final = await call_comfyui_finalize(base_image)
        _ts = time.time()
        final.save(os.path.join(monitor.get_debug_dir(), "v2_render_all_final.png"))
        print(f"【用时测试】  ├─ 调试文件保存(final): {time.time()-_ts:.2f}s")
        monitor.emit("调试保存", "done", image_path="v2_render_all_final.png")

        result = {"finalImage": image_to_base64(final, "PNG")}
        _total = time.time()-_t0
        print(f"【用时测试】v2/render-all 总耗时: {_total:.2f}s")
        monitor.end_request("render-all", _total)
        _success = True
        return result
    except HTTPException as e:
        monitor.emit("render-all", "error", duration=time.time()-_t0, extra={"message": e.detail})
        raise
    except Exception as e:
        monitor.emit("render-all", "error", duration=time.time()-_t0, extra={"message": str(e)})
        raise HTTPException(500, detail=str(e))
    finally:
        if not _success and monitor.current_task:
            monitor.current_task["status"] = "error"
            monitor._emit_task_status("error")


@app.post("/api/v2/split-mask")
def v2_split_mask(req: SplitMaskRequest):
    """
    Split one mask region into two sub-regions using a directed line.

    The line (x1,y1)→(x2,y2) divides the target region via half-plane
    classification (cross product). Side A keeps targetColor; side B gets a
    newly generated colour that avoids collision with existingColors.

    Returns the updated mask image and the new colour assigned to side B.
    Returns 422 if the line doesn't actually split the region.
    """
    _t0 = time.time()
    mask_img = base64_to_image(req.maskImage).convert("RGB")
    mask_arr = np.array(mask_img)

    _tp = time.time()
    all_colors = list(req.existingColors) or [req.targetColor]
    result = split_mask_by_line(
        mask_arr,
        req.targetColor,
        req.x1, req.y1,
        req.x2, req.y2,
        all_colors,
    )
    print(f"【用时测试】  ├─ 蓙版分割计算: {time.time()-_tp:.2f}s")

    if result is None:
        monitor.emit("蓙版分割", "error", extra={"message": "分割线未分割目标区域，所有像素在同一侧或目标颜色未找到"})
        raise HTTPException(
            422,
            detail="Line does not split the target region — all pixels fall on the same side, or target colour not found in mask.",
        )

    updated_arr, new_color = result
    updated_img = Image.fromarray(updated_arr.astype(np.uint8))
    _ts = time.time()
    updated_img.save(os.path.join(monitor.get_debug_dir(), "v2_split_mask.png"))
    print(f"【用时测试】  ├─ 调试文件保存: {time.time()-_ts:.2f}s")

    print(f"[v2/split-mask] target={req.targetColor} → new={new_color}")
    resp = {
        "maskImage": image_to_base64(updated_img, "PNG"),
        "newColor": new_color,
    }
    print(f"【用时测试】v2/split-mask 总耗时: {time.time()-_t0:.2f}s")
    return resp
