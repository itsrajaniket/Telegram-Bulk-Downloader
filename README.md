# TeleForge: Telegram Bulk Video Downloader 🚀

TeleForge is a local, lightweight, and modern web application that runs on your PC. It connects securely to your Telegram account using the official Telegram APIs (via Telethon), scans any channel, group, or direct chat for video files, and allows you to download them in bulk with control over speed, concurrency, and target folders.

---

## ✨ Features

- **🔒 Secure Local Authentication**
  - Logs in directly from your computer using your own `api_id` and `api_hash` from [my.telegram.org](https://my.telegram.org).
  - Supports standard Telegram Phone OTP codes and Two-Factor Authentication (2FA) password verification.
  - Saves your session locally so you don’t need to log in every time you start the app.
- **📁 Interactive Group & Channel Browser**
  - Instantly scans all your chats, channels, groups, and contacts.
  - Lists dialogs along with their member count and unread count.
- **🔍 Real-Time Video Scanner**
  - Streams scanned media dynamically in real-time as it parses the chat.
  - Shows file names, size, resolution (width/height), date, duration, and original message text/captions.
- **⚡ Advanced Download Manager**
  - **Auto-Resume & Network Drop Protection:** Automatically retries downloading chunks up to 5 times if your Wi-Fi flickers or drops temporarily, resuming from the exact byte offset where it stopped.
  - **Disk Space Pre-flight Check:** Prevents downloading files if your local drive does not have enough storage space to fit the queued files.
  - **Duplicate Detection:** Checks if files already exist in the target folder with matching sizes to skip re-downloads automatically.
  - **Dynamic Queue Control:** Pause, Resume, or Cancel downloads individually or in bulk.
  - **Speed Throttling:** Custom speed limits (in KB/s) to save bandwidth for other tasks.
  - **Concurrency Tuning:** Set parallel downloads (1 to 10 files at once) to bypass Telegram's single-file throttling.
- **📜 Download History Log**
  - Keeps track of all downloaded files, their file size, completion time, and saved path.
  - Clear the log with one click.
- **🎨 Modern Glassmorphic UI**
  - Beautiful, interactive dashboard featuring dark-mode glassmorphism, responsive sidebar navigation, real-time logging terminal, and interactive status bars.

---

## 🛠️ Tech Stack

- **Backend:** 
  - [FastAPI](https://fastapi.tiangolo.com/) (Python ASGI Web framework)
  - [Uvicorn](https://www.uvicorn.org/) (Lightning-fast ASGI server)
  - [Telethon](https://docs.telethon.dev/) (Pure Python 3 MTProto Telegram client library)
  - [WebSockets](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API) (For real-time progress updates, terminal streaming, and messaging)
- **Frontend:**
  - HTML5, Vanilla CSS3 (Custom styles and variables), Vanilla ES6 JavaScript (No npm build step required to run).

---

## 📂 Project Structure

```text
bulkdownload/
├── backend/
│   ├── sessions/             # Stores encrypted local Telegram session files
│   ├── history.json          # Keeps records of downloaded files
│   ├── main.py               # FastAPI server & download manager worker
│   ├── telegram_client.py    # Downloader client class handling Telethon interactions
│   └── requirements.txt      # Python dependencies
├── frontend/
│   ├── index.html            # Core HTML layout
│   ├── style.css             # Glassmorphic UI styling
│   └── app.js                # WebSocket & UI state logic
├── .gitignore                # Ensures session keys and history are not pushed to Git
└── README.md                 # Project documentation (this file)
```

---

## 🚀 Getting Started

### Prerequisites
Make sure you have [Python 3.10+](https://www.python.org/downloads/) installed.

### 1. Obtain your Telegram API Credentials
To interact with the Telegram API, you need your own App credentials:
1. Go to [my.telegram.org](https://my.telegram.org) and log in with your phone number.
2. Select **API development tools**.
3. Create a new application (the name doesn't matter).
4. Copy your **App api_id** and **App api_hash**.

### 2. Install Backend Dependencies
Open your terminal in the project directory and run:
```bash
pip install -r backend/requirements.txt
```

### 3. Run the FastAPI Server
Navigate into the `backend` folder and start the server:
```bash
cd backend
python -m uvicorn main:app --host 127.0.0.1 --port 8000
```
The server will start running on `http://127.0.0.1:8000`.

### 4. Run the Frontend
Simply open the `frontend/index.html` file in any modern browser (Chrome, Edge, Firefox, Brave, etc.) to start using the application.

---

## 💡 Pro-Tips for Maximum Speed

- **Telegram Speed Throttling:** Telegram limits download speeds of individual files for non-Premium users to around `120 KB/s - 500 KB/s`.
- **Parallel Downloads:** To maximize your internet speed, go to the **Settings** panel in the app and set **Concurrent Downloads** to `3` or `5`. Downloading multiple files in parallel allows you to bypass individual file throttling and utilize your full bandwidth!

---

## ⚠️ Security Notice

> [!WARNING]
> Your `.session` files (saved under `backend/sessions/`) contain the active authorization keys to your Telegram account. 
> - **Never** commit these session files to a public Git repository.
> - A `.gitignore` file is included in this repository to prevent session files, history databases, and local caches from being tracked or shared.
