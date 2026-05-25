import os
import json
import asyncio
import logging
import mimetypes
from datetime import datetime
from telethon import TelegramClient, utils, errors
from telethon.tl.types import (
    MessageMediaDocument,
    DocumentAttributeVideo,
    DocumentAttributeFilename,
    InputMessagesFilterVideo,
    InputPeerChannel,
    InputPeerChat,
    InputPeerUser,
    PeerChannel,
    PeerChat,
    PeerUser
)

logger = logging.getLogger(__name__)

# Directory where Telethon session files will be saved
SESSION_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "sessions"))
os.makedirs(SESSION_DIR, exist_ok=True)

# File to store download history
HISTORY_FILE = os.path.abspath(os.path.join(os.path.dirname(__file__), "history.json"))
if not os.path.exists(HISTORY_FILE):
    with open(HISTORY_FILE, "w", encoding="utf-8") as f:
        json.dump([], f)

class TelegramDownloaderClient:
    def __init__(self):
        self.client = None
        self.phone = None
        self.api_id = None
        self.api_hash = None
        self.phone_code_hash = None
        self.download_tasks = {}  # {msg_unique_id: {"status": "running/paused/cancelled", "task": Task}}
        self.active_downloads_count = 0
        self.global_speed_limit = 0  # in KB/s, 0 = unlimited
        self.concurrent_limit = 3

    async def get_client_status(self):
        """Checks if the client is connected and authorized."""
        if not self.client:
            # Check if there is an existing session file
            session_files = [f for f in os.listdir(SESSION_DIR) if f.endswith(".session")]
            if session_files:
                # We have a session, let's load config if exists
                # For now, we will return unauthorized if not initialized
                return {"status": "disconnected", "reason": "session_exists_but_not_initialized"}
            return {"status": "unauthorized"}
        
        try:
            if not self.client.is_connected():
                await self.client.connect()
            
            authorized = await self.client.is_user_authorized()
            if authorized:
                me = await self.client.get_me()
                return {
                    "status": "authenticated",
                    "user": {
                        "id": me.id,
                        "first_name": me.first_name,
                        "last_name": me.last_name or "",
                        "username": me.username or "",
                        "phone": me.phone
                    }
                }
            return {"status": "unauthorized"}
        except Exception as e:
            logger.error(f"Error checking client status: {e}")
            return {"status": "disconnected", "error": str(e)}

    async def start_auth(self, api_id: int, api_hash: str, phone: str):
        """Initializes client and sends OTP code request."""
        self.api_id = api_id
        self.api_hash = api_hash
        self.phone = phone
        
        # Format session name based on phone
        session_name = os.path.join(SESSION_DIR, f"tg_{phone.strip('+')}")
        
        # Disconnect existing if any
        if self.client:
            try:
                await self.client.disconnect()
            except Exception:
                pass
                
        self.client = TelegramClient(session_name, api_id, api_hash)
        await self.client.connect()
        
        try:
            send_code_result = await self.client.send_code_request(phone)
            self.phone_code_hash = send_code_result.phone_code_hash
            return {"status": "otp_required"}
        except errors.SessionPasswordNeededError:
            # This shouldn't happen at code request, but if it does:
            return {"status": "2fa_required"}
        except Exception as e:
            logger.error(f"Error starting auth: {e}")
            return {"status": "error", "message": str(e)}

    async def verify_otp(self, code: str):
        """Verifies OTP and signs in."""
        if not self.client or not self.phone or not self.phone_code_hash:
            return {"status": "error", "message": "Auth session not initialized"}
            
        try:
            await self.client.sign_in(self.phone, code, phone_code_hash=self.phone_code_hash)
            me = await self.client.get_me()
            return {
                "status": "authenticated",
                "user": {
                    "id": me.id,
                    "first_name": me.first_name,
                    "last_name": me.last_name or "",
                    "username": me.username or "",
                    "phone": me.phone
                }
            }
        except errors.SessionPasswordNeededError:
            return {"status": "2fa_required"}
        except errors.PhoneCodeInvalidError:
            return {"status": "error", "message": "Invalid OTP code"}
        except errors.PhoneCodeExpiredError:
            return {"status": "error", "message": "OTP code expired. Please request a new one."}
        except Exception as e:
            logger.error(f"Error verifying OTP: {e}")
            return {"status": "error", "message": str(e)}

    async def verify_password(self, password: str):
        """Verifies 2FA password."""
        if not self.client:
            return {"status": "error", "message": "Auth session not initialized"}
            
        try:
            await self.client.sign_in(password=password)
            me = await self.client.get_me()
            return {
                "status": "authenticated",
                "user": {
                    "id": me.id,
                    "first_name": me.first_name,
                    "last_name": me.last_name or "",
                    "username": me.username or "",
                    "phone": me.phone
                }
            }
        except errors.PasswordHashInvalidError:
            return {"status": "error", "message": "Invalid 2FA password"}
        except Exception as e:
            logger.error(f"Error verifying 2FA: {e}")
            return {"status": "error", "message": str(e)}

    async def logout(self):
        """Logs out and deletes the session."""
        if self.client:
            if await self.client.is_user_authorized():
                await self.client.log_out()
            await self.client.disconnect()
            self.client = None
            
        # Clean up files in session directory
        try:
            for f in os.listdir(SESSION_DIR):
                if f.endswith(".session") or f.endswith(".session-journal"):
                    os.remove(os.path.join(SESSION_DIR, f))
        except Exception as e:
            logger.error(f"Error cleaning up session files: {e}")
            
        return {"status": "unauthorized"}

    async def get_dialogs(self):
        """Fetches all chats/groups/channels the user is in."""
        if not self.client or not await self.client.is_user_authorized():
            return {"status": "error", "message": "Not authenticated"}
            
        try:
            dialogs = []
            async for dialog in self.client.iter_dialogs():
                entity = dialog.entity
                
                # Determine type
                chat_type = "user"
                if dialog.is_channel:
                    chat_type = "channel"
                elif dialog.is_group:
                    chat_type = "group"
                
                # Try getting member count
                member_count = None
                if dialog.is_channel or dialog.is_group:
                    try:
                        # FullChannel contains participants count
                        full = await self.client.get_entity(entity)
                        if hasattr(full, 'participants_count'):
                            member_count = full.participants_count
                    except Exception:
                        pass
                
                dialogs.append({
                    "id": dialog.id,
                    "name": dialog.name,
                    "username": getattr(entity, 'username', None) or "",
                    "type": chat_type,
                    "member_count": member_count,
                    "unread_count": dialog.unread_count
                })
            return {"status": "success", "dialogs": dialogs}
        except Exception as e:
            logger.error(f"Error fetching dialogs: {e}")
            return {"status": "error", "message": str(e)}

    async def scan_chat_videos(self, chat_id, progress_callback):
        """Scans a chat for video items and streams results back via progress_callback."""
        if not self.client or not await self.client.is_user_authorized():
            raise Exception("Client not authenticated")

        try:
            entity = await self.client.get_entity(chat_id)
        except Exception as e:
            logger.error(f"Failed to get entity for scan: {e}")
            # Try parsing if it's integer
            try:
                entity = await self.client.get_entity(int(chat_id))
            except Exception:
                raise Exception(f"Could not find group/channel: {chat_id}")

        scanned_count = 0
        videos_found = []

        # Iterate over messages in reverse chronological order
        async for msg in self.client.iter_messages(entity):
            scanned_count += 1
            
            # Check if there is media and if it's a document (videos are MessageMediaDocument)
            if msg.media and isinstance(msg.media, MessageMediaDocument):
                doc = msg.media.document
                
                # Check mime type or attributes for video
                is_video = False
                duration = 0
                width = 0
                height = 0
                
                # Check attributes
                for attr in doc.attributes:
                    if isinstance(attr, DocumentAttributeVideo):
                        is_video = True
                        duration = attr.duration
                        width = attr.w
                        height = attr.h
                        break
                        
                # Fallback to mime type check
                if not is_video and doc.mime_type and doc.mime_type.startswith("video/"):
                    is_video = True

                if is_video:
                    # Find filename
                    filename = None
                    for attr in doc.attributes:
                        if isinstance(attr, DocumentAttributeFilename):
                            filename = attr.file_name
                            break
                    
                    # Fallback filename if not present
                    if not filename:
                        ext = mimetypes.guess_extension(doc.mime_type) or ".mp4"
                        filename = f"video_{msg.date.strftime('%Y%m%d_%H%M%S')}_{msg.id}{ext}"
                    
                    video_info = {
                        "msg_id": msg.id,
                        "chat_id": chat_id,
                        "filename": filename,
                        "size": doc.size,
                        "date": msg.date.isoformat(),
                        "duration": duration,
                        "width": width,
                        "height": height,
                        "caption": msg.message or "",
                        "mime_type": doc.mime_type
                    }
                    videos_found.append(video_info)
                    
                    # Yield video found immediately to keep UI highly responsive
                    await progress_callback({
                        "event": "video_found",
                        "video": video_info,
                        "scanned": scanned_count
                    })
                    
            # Yield scan progress periodically
            if scanned_count % 50 == 0:
                await progress_callback({
                    "event": "scan_progress",
                    "scanned": scanned_count,
                    "found_count": len(videos_found)
                })
                
        # Send completed event
        await progress_callback({
            "event": "scan_completed",
            "scanned": scanned_count,
            "found_count": len(videos_found)
        })

    async def download_video(self, chat_id, msg_id, save_dir, video_id, status_callback):
        """Downloads a single video file using chunked requests and throttling."""
        if not self.client or not await self.client.is_user_authorized():
            await status_callback(video_id, {"status": "error", "error": "Not authenticated"})
            return

        try:
            entity = await self.client.get_entity(chat_id)
        except Exception:
            try:
                entity = await self.client.get_entity(int(chat_id))
            except Exception as e:
                await status_callback(video_id, {"status": "error", "error": f"Failed to access chat: {e}"})
                return

        try:
            msg = await self.client.get_messages(entity, ids=int(msg_id))
            if not msg or not msg.media or not isinstance(msg.media, MessageMediaDocument):
                await status_callback(video_id, {"status": "error", "error": "Message does not contain a video"})
                return
                
            doc = msg.media.document
            
            # Extract filename (Ensure it is exactly matching original filename)
            filename = None
            for attr in doc.attributes:
                if isinstance(attr, DocumentAttributeFilename):
                    filename = attr.file_name
                    break
            
            if not filename:
                ext = mimetypes.guess_extension(doc.mime_type) or ".mp4"
                filename = f"video_{msg.date.strftime('%Y%m%d_%H%M%S')}_{msg.id}{ext}"
            
            # Secure filename to avoid path traversal
            filename = os.path.basename(filename)
            dest_path = os.path.join(save_dir, filename)
            
            # Handle duplicates by adding suffix, but keep original name recognizable
            base, ext = os.path.splitext(filename)
            counter = 1
            while os.path.exists(dest_path):
                # If file exists and size is matching, check if we should skip
                if os.path.getsize(dest_path) == doc.size:
                    await status_callback(video_id, {
                        "status": "completed",
                        "progress": 100.0,
                        "downloaded_bytes": doc.size,
                        "speed": 0,
                        "eta": 0,
                        "skipped": True,
                        "dest_path": dest_path
                    })
                    return
                # Otherwise adjust name
                dest_path = os.path.join(save_dir, f"{base}_{counter}{ext}")
                counter += 1

            # Prepare temp download path
            temp_path = dest_path + ".part"
            
            # Start downloading
            await status_callback(video_id, {
                "status": "downloading",
                "progress": 0.0,
                "downloaded_bytes": 0,
                "speed": 0,
                "eta": -1
            })

            file_size = doc.size
            chunk_size = 1024 * 1024  # 1 MB chunks (multiple of 4096)
            downloaded = 0
            
            # Start timer for speed calculations
            start_time = asyncio.get_event_loop().time()
            last_report_time = start_time
            last_downloaded = 0
            retries = 0

            with open(temp_path, "wb") as f:
                # Use Telethon's iter_download async generator to stream chunks from Telegram
                while downloaded < file_size:
                    # Check task status (for pause/cancel support)
                    task_info = self.download_tasks.get(video_id)
                    if task_info and task_info.get("status") == "paused":
                        await status_callback(video_id, {"status": "paused"})
                        # Wait until resumed or cancelled
                        while task_info and task_info.get("status") == "paused":
                            await asyncio.sleep(0.5)
                            task_info = self.download_tasks.get(video_id)
                        
                        if not task_info or task_info.get("status") == "cancelled":
                            break
                        # Restart speed timers
                        start_time = asyncio.get_event_loop().time()
                        last_report_time = start_time
                        last_downloaded = downloaded

                    if not task_info or task_info.get("status") == "cancelled":
                        break

                    try:
                        # Start downloading from the current offset
                        async for chunk in self.client.iter_download(
                            doc,
                            offset=downloaded,
                            chunk_size=chunk_size
                        ):
                            # Check pause/cancel state in loop
                            task_info = self.download_tasks.get(video_id)
                            if not task_info or task_info.get("status") == "cancelled" or task_info.get("status") == "paused":
                                break

                            # Implement speed limit if active
                            if self.global_speed_limit > 0:
                                limit_bytes_per_sec = self.global_speed_limit * 1024
                                expected_time = len(chunk) / limit_bytes_per_sec
                                current_time = asyncio.get_event_loop().time()
                                actual_elapsed = current_time - last_report_time
                                if actual_elapsed < expected_time:
                                    await asyncio.sleep(expected_time - actual_elapsed)

                            # Write chunk to file
                            f.write(chunk)
                            downloaded += len(chunk)

                            # Calculate progress & speed
                            current_time = asyncio.get_event_loop().time()
                            elapsed_since_report = current_time - last_report_time
                            
                            # Report status every 0.8s or when done
                            if elapsed_since_report >= 0.8 or downloaded == file_size:
                                bytes_diff = downloaded - last_downloaded
                                speed = bytes_diff / elapsed_since_report if elapsed_since_report > 0 else 0
                                progress = (downloaded / file_size) * 100
                                eta = (file_size - downloaded) / speed if speed > 0 else -1
                                
                                await status_callback(video_id, {
                                    "status": "downloading",
                                    "progress": round(progress, 1),
                                    "downloaded_bytes": downloaded,
                                    "speed": round(speed),
                                    "eta": round(eta) if eta >= 0 else -1
                                })
                                
                                last_report_time = current_time
                                last_downloaded = downloaded

                            # Reset retries on successful chunk read
                            retries = 0

                    except errors.FloodWaitError as fwe:
                        logger.warning(f"FloodWaitError: must wait {fwe.seconds} seconds.")
                        await status_callback(video_id, {
                            "status": "cooldown",
                            "cooldown_seconds": fwe.seconds,
                            "message": f"Rate limited. Cooling down for {fwe.seconds}s..."
                        })
                        await asyncio.sleep(fwe.seconds)
                        start_time = asyncio.get_event_loop().time()
                        last_report_time = start_time
                        last_downloaded = downloaded

                    except Exception as ex:
                        retries += 1
                        if retries > 5:
                            logger.error(f"Max retries reached for chunk at offset {downloaded}: {ex}")
                            raise ex
                        logger.warning(f"Error downloading chunk at offset {downloaded}: {ex}. Retrying {retries}/5 in 3 seconds...")
                        await asyncio.sleep(3)

            # Check if download finished or was cancelled
            task_info = self.download_tasks.get(video_id)
            if task_info and task_info.get("status") == "cancelled":
                if os.path.exists(temp_path):
                    os.remove(temp_path)
                await status_callback(video_id, {"status": "cancelled"})
                return

            # Rename temp file to final destination
            if os.path.exists(temp_path):
                os.rename(temp_path, dest_path)

            # Save to history
            history_entry = {
                "id": video_id,
                "filename": filename,
                "size": file_size,
                "date": datetime.now().isoformat(),
                "path": dest_path
            }
            try:
                with open(HISTORY_FILE, "r", encoding="utf-8") as f:
                    history = json.load(f)
                history.insert(0, history_entry)
                with open(HISTORY_FILE, "w", encoding="utf-8") as f:
                    json.dump(history, f, indent=2)
            except Exception as e:
                logger.error(f"Failed to write history: {e}")

            await status_callback(video_id, {
                "status": "completed",
                "progress": 100.0,
                "downloaded_bytes": file_size,
                "speed": 0,
                "eta": 0,
                "dest_path": dest_path
            })

        except Exception as e:
            logger.error(f"Error downloading video {video_id}: {e}", exc_info=True)
            if 'temp_path' in locals() and os.path.exists(temp_path):
                try:
                    os.remove(temp_path)
                except Exception:
                    pass
            await status_callback(video_id, {"status": "error", "error": str(e)})

# Create global shared instance of the Downloader Client
downloader_client = TelegramDownloaderClient()
