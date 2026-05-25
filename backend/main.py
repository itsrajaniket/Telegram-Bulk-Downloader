import os
import json
import logging
import shutil
import asyncio
from typing import List, Dict, Any
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from telegram_client import downloader_client, HISTORY_FILE

# Setup logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("backend_main")

# WebSocket active connections
active_connections: List[WebSocket] = []

# Broadcast system log messages to WebSocket clients
class WebSocketLogHandler(logging.Handler):
    def __init__(self):
        super().__init__()
        
    def emit(self, record):
        log_entry = self.format(record)
        level = record.levelname
        # Trigger WebSocket broadcast asynchronously
        if active_connections:
            message = {
                "type": "log",
                "message": log_entry,
                "timestamp": datetime_now_str(),
                "level": level
            }
            # We must use the current event loop to schedule sending
            try:
                loop = asyncio.get_running_loop()
                if loop.is_running():
                    loop.create_task(broadcast_ws_message(message))
            except RuntimeError:
                pass

def datetime_now_str():
    from datetime import datetime
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

# Hook up logging handler
log_handler = WebSocketLogHandler()
log_handler.setFormatter(logging.Formatter("[%(name)s] %(message)s"))
logging.getLogger().addHandler(log_handler)

app = FastAPI(title="Telegram Bulk Video Downloader")

# CORS middleware for local frontend development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Models for request verification
class AuthStartRequest(BaseModel):
    api_id: int
    api_hash: str
    phone: str

class AuthVerifyCodeRequest(BaseModel):
    code: str

class AuthVerifyPasswordRequest(BaseModel):
    password: str

# Queue systems
pending_queue: List[Dict[str, Any]] = []
active_tasks: Dict[str, asyncio.Task] = {}

async def broadcast_ws_message(message: dict):
    """Sends a JSON message to all connected WebSockets."""
    closed_connections = []
    for conn in active_connections:
        try:
            await conn.send_json(message)
        except Exception:
            closed_connections.append(conn)
    for conn in closed_connections:
        if conn in active_connections:
            active_connections.remove(conn)

async def download_manager_loop():
    """Background loop that manages queued downloads based on concurrency limit."""
    logger.info("Download manager loop started.")
    while True:
        try:
            await asyncio.sleep(0.5)
            
            # 1. Clean up finished tasks from active_tasks
            finished_ids = []
            for video_id, task in list(active_tasks.items()):
                if task.done():
                    finished_ids.append(video_id)
                    # Retrieve result if needed (forces raising errors if any uncaught)
                    try:
                        task.result()
                    except Exception as e:
                        logger.error(f"Task for video {video_id} failed: {e}")
            
            for video_id in finished_ids:
                active_tasks.pop(video_id, None)
                
            # 2. Check if we have slots and items in the queue
            while len(active_tasks) < downloader_client.concurrent_limit and pending_queue:
                item = pending_queue.pop(0)
                video_id = item["video_id"]
                
                # If already cancelled, skip
                task_info = downloader_client.download_tasks.get(video_id)
                if task_info and task_info.get("status") == "cancelled":
                    continue

                # Prepare status callback for WebSocket update
                async def status_callback(vid=video_id, status_data=None):
                    # Broadcast download progress to all frontend clients
                    await broadcast_ws_message({
                        "type": "download_progress",
                        "video_id": vid,
                        **status_data
                    })
                    # Update status in the downloader client tracker
                    if vid in downloader_client.download_tasks:
                        downloader_client.download_tasks[vid]["status"] = status_data.get("status")

                # Create downloading task
                task = asyncio.create_task(
                    downloader_client.download_video(
                        chat_id=item["chat_id"],
                        msg_id=item["msg_id"],
                        save_dir=item["save_dir"],
                        video_id=video_id,
                        status_callback=status_callback
                    )
                )
                
                downloader_client.download_tasks[video_id] = {
                    "status": "queued",
                    "task": task
                }
                active_tasks[video_id] = task
                
                logger.info(f"Started downloading video ID {video_id}")
                
        except Exception as e:
            logger.error(f"Error in download manager loop: {e}", exc_info=True)

@app.on_event("startup")
async def startup_event():
    # Start the background download worker
    asyncio.create_task(download_manager_loop())

# HTTP Endpoints
@app.get("/api/auth/status")
async def get_auth_status():
    return await downloader_client.get_client_status()

@app.post("/api/auth/send-code")
async def send_code(req: AuthStartRequest):
    logger.info(f"Initiating login for phone {req.phone} with API ID {req.api_id}")
    res = await downloader_client.start_auth(req.api_id, req.api_hash, req.phone)
    if res.get("status") == "error":
        raise HTTPException(status_code=400, detail=res.get("message"))
    return res

@app.post("/api/auth/verify-code")
async def verify_code(req: AuthVerifyCodeRequest):
    logger.info("Verifying OTP code...")
    res = await downloader_client.verify_otp(req.code)
    if res.get("status") == "error":
        raise HTTPException(status_code=400, detail=res.get("message"))
    return res

@app.post("/api/auth/verify-password")
async def verify_password(req: AuthVerifyPasswordRequest):
    logger.info("Verifying 2FA password...")
    res = await downloader_client.verify_password(req.password)
    if res.get("status") == "error":
        raise HTTPException(status_code=400, detail=res.get("message"))
    return res

@app.post("/api/auth/logout")
async def logout():
    logger.info("Logging out from Telegram...")
    # Clear queues
    pending_queue.clear()
    for task in active_tasks.values():
        task.cancel()
    active_tasks.clear()
    downloader_client.download_tasks.clear()
    
    return await downloader_client.logout()

@app.get("/api/dialogs")
async def get_dialogs():
    res = await downloader_client.get_dialogs()
    if res.get("status") == "error":
        raise HTTPException(status_code=400, detail=res.get("message"))
    return res.get("dialogs", [])

@app.get("/api/history")
async def get_history():
    """Returns the download history."""
    try:
        if os.path.exists(HISTORY_FILE):
            with open(HISTORY_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        return []
    except Exception as e:
        logger.error(f"Error reading history: {e}")
        return []

@app.post("/api/history/clear")
async def clear_history():
    """Clears the download history."""
    try:
        with open(HISTORY_FILE, "w", encoding="utf-8") as f:
            json.dump([], f)
        return {"status": "success"}
    except Exception as e:
        logger.error(f"Error clearing history: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/folders/browse")
async def browse_folders(path: str = ""):
    """Returns subdirectories and logical paths on the host system."""
    try:
        user_home = os.path.expanduser("~")
        
        # Prepare logical default folders for easy pick
        common_folders = [
            {"name": "Home", "path": user_home},
            {"name": "Downloads", "path": os.path.join(user_home, "Downloads")},
            {"name": "Desktop", "path": os.path.join(user_home, "Desktop")},
            {"name": "Documents", "path": os.path.join(user_home, "Documents")},
        ]
        
        # Strip trailing slashes or backslashes
        target_path = path.strip()
        
        # If no path specified, list common folders and root drives
        if not target_path:
            drives = []
            if os.name == 'nt':
                # Windows Logical Drives list
                import string
                from ctypes import windll
                bitmask = windll.kernel32.GetLogicalDrives()
                for letter in string.ascii_uppercase:
                    if bitmask & 1:
                        drives.append(f"{letter}:\\")
                    bitmask >>= 1
            else:
                drives.append("/")
                
            return {
                "current_path": "",
                "parent_path": "",
                "folders": [],
                "drives": drives,
                "common": common_folders
            }
            
        # Ensure path exists
        if not os.path.exists(target_path):
            raise HTTPException(status_code=400, detail="Path does not exist")
            
        if not os.path.isdir(target_path):
            raise HTTPException(status_code=400, detail="Path is not a directory")

        # Scan subdirectories
        folders = []
        try:
            for entry in os.scandir(target_path):
                if entry.is_dir() and not entry.name.startswith("."):
                    folders.append({
                        "name": entry.name,
                        "path": entry.path
                    })
        except PermissionError:
            raise HTTPException(status_code=403, detail="Permission Denied")

        # Sort folders alphabetically
        folders.sort(key=lambda x: x["name"].lower())
        
        # Determine parent path
        parent_path = os.path.dirname(target_path.rstrip(os.path.sep))
        if parent_path == target_path:  # We are at root drive
            parent_path = ""

        return {
            "current_path": target_path,
            "parent_path": parent_path,
            "folders": folders,
            "drives": [],
            "common": common_folders
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error browsing folders: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# WebSocket Handler
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    active_connections.append(websocket)
    logger.info("WebSocket client connected.")
    
    try:
        while True:
            data = await websocket.receive_text()
            try:
                msg = json.loads(data)
                action = msg.get("action")
                
                if action == "scan":
                    chat_id = msg.get("chat_id")
                    logger.info(f"Requested scan for chat: {chat_id}")
                    
                    # Define streaming scan callback
                    async def scan_cb(scan_data):
                        await websocket.send_json({
                            "type": "scan",
                            **scan_data
                        })
                    
                    # Start scanning (we run it in background to avoid blocking WebSocket read loop)
                    asyncio.create_task(
                        downloader_client.scan_chat_videos(chat_id, scan_cb)
                    )
                    
                elif action == "download":
                    videos = msg.get("videos", [])
                    save_dir = msg.get("save_dir")
                    
                    # Validate folder
                    if not save_dir or not os.path.exists(save_dir) or not os.path.isdir(save_dir):
                        logger.error(f"Invalid download folder: {save_dir}")
                        await websocket.send_json({
                            "type": "error",
                            "message": "Invalid download directory path selected."
                        })
                        continue
                        
                    # Calculate required space
                    total_required_bytes = sum([v.get("size", 0) for v in videos])
                    
                    try:
                        usage = shutil.disk_usage(save_dir)
                        if usage.free < total_required_bytes:
                            free_mb = usage.free / (1024*1024)
                            req_mb = total_required_bytes / (1024*1024)
                            logger.error(f"Not enough disk space. Required: {req_mb:.1f} MB, Free: {free_mb:.1f} MB")
                            await websocket.send_json({
                                "type": "error",
                                "message": f"Not enough disk space. You need {req_mb:.1f} MB but only have {free_mb:.1f} MB available on {save_dir}."
                            })
                            continue
                    except Exception as e:
                        logger.warning(f"Could not check disk space: {e}")
                        
                    logger.info(f"Queuing {len(videos)} videos to download directory: {save_dir}")
                    
                    # Add downloads to our pending queue
                    for video in videos:
                        video_id = f"{video['chat_id']}_{video['msg_id']}"
                        
                        # Avoid duplicating queued/active downloads
                        if video_id in active_tasks:
                            continue
                        if any(item["video_id"] == video_id for item in pending_queue):
                            continue
                        
                        downloader_client.download_tasks[video_id] = {
                            "status": "queued",
                            "task": None
                        }
                        
                        pending_queue.append({
                            "video_id": video_id,
                            "chat_id": video["chat_id"],
                            "msg_id": video["msg_id"],
                            "save_dir": save_dir
                        })
                        
                        # Send initial queued state
                        await websocket.send_json({
                            "type": "download_progress",
                            "video_id": video_id,
                            "status": "queued",
                            "progress": 0.0,
                            "downloaded_bytes": 0,
                            "speed": 0,
                            "eta": -1
                        })
                        
                elif action == "pause_download":
                    video_id = msg.get("video_id")
                    if video_id in downloader_client.download_tasks:
                        downloader_client.download_tasks[video_id]["status"] = "paused"
                        logger.info(f"Paused download for {video_id}")
                        await websocket.send_json({
                            "type": "download_progress",
                            "video_id": video_id,
                            "status": "paused"
                        })
                        
                elif action == "resume_download":
                    video_id = msg.get("video_id")
                    if video_id in downloader_client.download_tasks:
                        downloader_client.download_tasks[video_id]["status"] = "downloading"
                        logger.info(f"Resumed download for {video_id}")
                        await websocket.send_json({
                            "type": "download_progress",
                            "video_id": video_id,
                            "status": "downloading"
                        })
                        
                elif action == "cancel_download":
                    video_id = msg.get("video_id")
                    logger.info(f"Cancelling download for {video_id}")
                    
                    # Check in pending queue and remove it if present
                    for idx, item in enumerate(pending_queue):
                        if item["video_id"] == video_id:
                            pending_queue.pop(idx)
                            break
                            
                    # Check in active downloads
                    if video_id in downloader_client.download_tasks:
                        downloader_client.download_tasks[video_id]["status"] = "cancelled"
                    if video_id in active_tasks:
                        active_tasks[video_id].cancel()
                        
                    await websocket.send_json({
                        "type": "download_progress",
                        "video_id": video_id,
                        "status": "cancelled"
                    })
                    
                elif action == "update_settings":
                    speed_limit = int(msg.get("speed_limit", 0))
                    concurrent_limit = int(msg.get("concurrent_limit", 3))
                    
                    # Update configuration parameters
                    downloader_client.global_speed_limit = speed_limit
                    downloader_client.concurrent_limit = max(1, min(10, concurrent_limit))
                    
                    logger.info(f"Settings updated: speed_limit={speed_limit}KB/s, concurrent_limit={concurrent_limit}")
                    
            except Exception as e:
                logger.error(f"Error handling WebSocket message: {e}")
                
    except WebSocketDisconnect:
        logger.info("WebSocket client disconnected.")
        if websocket in active_connections:
            active_connections.remove(websocket)

# Mount frontend build files (fallback for local production distribution)
frontend_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "frontend"))
if os.path.exists(frontend_path):
    app.mount("/", StaticFiles(directory=frontend_path, html=True), name="frontend")
