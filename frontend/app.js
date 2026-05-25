// Global Application State
const state = {
    isAuthenticated: false,
    user: null,
    chats: [],
    scannedVideos: [], // Master list of videos found in the current scan
    selectedVideoIds: new Set(),
    downloads: {}, // Map of video_id -> download progress object
    currentChat: null,
    currentDownloadFolder: "",
    socket: null,
    wsConnected: false,
    
    // Directory explorer state
    explorerCurrentPath: "",
    explorerParentPath: "",
    explorerSelectedPath: "",
    explorerFolders: [],
    explorerDrives: [],
    explorerCommon: [],
    explorerTargetInputId: "", // ID of input element to update after directory select
};

// Config Constants
const API_BASE = `${window.location.protocol}//${window.location.hostname}:${window.location.port || '8000'}`;
const WS_BASE = `ws://${window.location.hostname}:${window.location.port || '8000'}/ws`;

// --------------------------------------------------
// Utility Functions
// --------------------------------------------------

function logToConsole(message, level = "INFO") {
    const term = document.getElementById("logs-terminal-output");
    if (!term) return;
    
    const line = document.createElement("div");
    line.className = `log-line ${level}`;
    const timestamp = new Date().toLocaleTimeString();
    line.textContent = `[${timestamp}] ${message}`;
    term.appendChild(line);
    term.scrollTop = term.scrollHeight;
}

function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function formatDuration(seconds) {
    if (!seconds) return "00:00";
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    let ret = "";
    if (hrs > 0) {
        ret += (hrs < 10 ? "0" : "") + hrs + ":";
    }
    ret += (mins < 10 ? "0" : "") + mins + ":";
    ret += (secs < 10 ? "0" : "") + secs;
    return ret;
}

function formatEta(seconds) {
    if (seconds === -1 || !isFinite(seconds)) return "--:--";
    return formatDuration(seconds);
}

function getAvatarColor(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    const h = Math.abs(hash % 360);
    return `linear-gradient(135deg, hsl(${h}, 65%, 45%) 0%, hsl(${h}, 65%, 30%) 100%)`;
}

// --------------------------------------------------
// Navigation Panel Swapping
// --------------------------------------------------

function initNavigation() {
    const navItems = document.querySelectorAll(".nav-item");
    const panels = document.querySelectorAll(".content-panel");
    
    navItems.forEach(item => {
        item.addEventListener("click", () => {
            if (item.classList.contains("disabled")) return;
            
            const targetPanelId = item.getAttribute("data-panel");
            
            navItems.forEach(nav => nav.classList.remove("active"));
            panels.forEach(panel => panel.classList.remove("active"));
            
            item.classList.add("active");
            document.getElementById(targetPanelId).classList.add("active");
        });
    });

    // Back to chats button from scanner
    document.getElementById("btn-back-to-chats").addEventListener("click", () => {
        document.getElementById("nav-btn-chats").click();
    });
}

function enableNavItems(enabled) {
    const items = ["nav-btn-chats", "nav-btn-scanner", "nav-btn-downloads", "nav-btn-history"];
    items.forEach(id => {
        const el = document.getElementById(id);
        if (enabled) {
            el.classList.remove("disabled");
        } else {
            el.classList.add("disabled");
        }
    });
}

// --------------------------------------------------
// WebSocket & API Integration
// --------------------------------------------------

function initWebSocket() {
    logToConsole("[System] Connecting to engine WebSocket...", "system");
    state.socket = new WebSocket(WS_BASE);
    
    state.socket.onopen = () => {
        state.wsConnected = true;
        logToConsole("[System] WebSocket connected successfully.", "system");
        checkAuthStatus();
    };
    
    state.socket.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handleWebSocketMessage(data);
        } catch (e) {
            console.error("Failed to parse WebSocket message:", e);
        }
    };
    
    state.socket.onclose = () => {
        state.wsConnected = false;
        logToConsole("[System] WebSocket disconnected. Retrying in 3 seconds...", "ERROR");
        setTimeout(initWebSocket, 3000);
    };
}

function handleWebSocketMessage(data) {
    if (data.type === "log") {
        logToConsole(data.message, data.level);
    } else if (data.type === "scan") {
        handleScanEvent(data);
    } else if (data.type === "download_progress") {
        handleDownloadProgress(data);
    } else if (data.type === "error") {
        alert(data.message);
        logToConsole(`[Engine Error] ${data.message}`, "ERROR");
    }
}

// --------------------------------------------------
// Authentication Flow Manager
// --------------------------------------------------

async function checkAuthStatus() {
    try {
        const res = await fetch(`${API_BASE}/api/auth/status`);
        const status = await res.json();
        updateAuthState(status);
    } catch (e) {
        logToConsole(`Failed to check session status: ${e.message}`, "ERROR");
    }
}

function updateAuthState(auth) {
    const dot = document.getElementById("status-dot");
    const text = document.getElementById("status-text");
    const btnLogout = document.getElementById("btn-logout");
    
    if (auth.status === "authenticated") {
        state.isAuthenticated = true;
        state.user = auth.user;
        
        dot.className = "status-indicator-dot connected";
        text.textContent = auth.user.first_name + (auth.user.username ? ` (@${auth.user.username})` : "");
        btnLogout.style.display = "block";
        
        enableNavItems(true);
        loadChats();
        
        // Redirect to chats page automatically if currently on auth page
        const activeNav = document.querySelector(".nav-item.active");
        if (activeNav && activeNav.id === "nav-btn-auth") {
            document.getElementById("nav-btn-chats").click();
        }
    } else {
        state.isAuthenticated = false;
        state.user = null;
        
        dot.className = "status-indicator-dot disconnected";
        text.textContent = "Disconnected";
        btnLogout.style.display = "none";
        
        enableNavItems(false);
        // Reset panels to auth
        document.getElementById("nav-btn-auth").click();
    }
}

function initAuthForms() {
    // Step 1: Submit API Details
    document.getElementById("auth-form-step1").addEventListener("submit", async (e) => {
        e.preventDefault();
        const apiId = parseInt(document.getElementById("input-api-id").value);
        const apiHash = document.getElementById("input-api-hash").value.trim();
        const phone = document.getElementById("input-phone").value.trim();
        
        const btn = document.getElementById("btn-submit-step1");
        btn.disabled = true;
        btn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Initializing client...`;
        
        try {
            const res = await fetch(`${API_BASE}/api/auth/send-code`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ api_id: apiId, api_hash: apiHash, phone: phone })
            });
            
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.detail || "Authentication request failed");
            }
            
            const data = await res.json();
            if (data.status === "otp_required") {
                document.getElementById("display-phone").textContent = phone;
                document.getElementById("auth-form-step1").classList.remove("active");
                document.getElementById("auth-form-step2").classList.add("active");
            }
        } catch (err) {
            alert(err.message);
            logToConsole(err.message, "ERROR");
        } finally {
            btn.disabled = false;
            btn.innerHTML = `Send Authorization Code <i class="fa-solid fa-paper-plane"></i>`;
        }
    });

    // Step 2: Submit OTP Code
    document.getElementById("auth-form-step2").addEventListener("submit", async (e) => {
        e.preventDefault();
        const code = document.getElementById("input-otp").value.trim();
        
        const btn = document.getElementById("btn-submit-step2");
        btn.disabled = true;
        
        try {
            const res = await fetch(`${API_BASE}/api/auth/verify-code`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ code })
            });
            
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.detail || "OTP Verification failed");
            }
            
            const data = await res.json();
            if (data.status === "authenticated") {
                updateAuthState(data);
            } else if (data.status === "2fa_required") {
                document.getElementById("auth-form-step2").classList.remove("active");
                document.getElementById("auth-form-step3").classList.add("active");
            }
        } catch (err) {
            alert(err.message);
            logToConsole(err.message, "ERROR");
        } finally {
            btn.disabled = false;
        }
    });

    // Step 3: Submit 2FA Password
    document.getElementById("auth-form-step3").addEventListener("submit", async (e) => {
        e.preventDefault();
        const password = document.getElementById("input-password").value;
        
        const btn = document.getElementById("btn-submit-step3");
        btn.disabled = true;
        
        try {
            const res = await fetch(`${API_BASE}/api/auth/verify-password`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ password })
            });
            
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.detail || "2FA Password verification failed");
            }
            
            const data = await res.json();
            if (data.status === "authenticated") {
                updateAuthState(data);
            }
        } catch (err) {
            alert(err.message);
            logToConsole(err.message, "ERROR");
        } finally {
            btn.disabled = false;
        }
    });

    // Form navigation buttons
    document.getElementById("btn-back-step2").addEventListener("click", () => {
        document.getElementById("auth-form-step2").classList.remove("active");
        document.getElementById("auth-form-step1").classList.add("active");
    });
    
    document.getElementById("btn-back-step3").addEventListener("click", () => {
        document.getElementById("auth-form-step3").classList.remove("active");
        document.getElementById("auth-form-step2").classList.add("active");
    });

    // Toggle 2FA Password visibility
    document.getElementById("btn-toggle-pass").addEventListener("click", () => {
        const input = document.getElementById("input-password");
        const icon = document.getElementById("btn-toggle-pass").querySelector("i");
        if (input.type === "password") {
            input.type = "text";
            icon.className = "fa-solid fa-eye-slash";
        } else {
            input.type = "password";
            icon.className = "fa-solid fa-eye";
        }
    });

    // Logout Trigger
    document.getElementById("btn-logout").addEventListener("click", async () => {
        if (!confirm("Are you sure you want to log out and delete local session data?")) return;
        try {
            const res = await fetch(`${API_BASE}/api/auth/logout`, { method: "POST" });
            const data = await res.json();
            updateAuthState(data);
            logToConsole("[System] Logged out successfully.", "system");
        } catch (e) {
            logToConsole(`Logout failed: ${e.message}`, "ERROR");
        }
    });
}

// --------------------------------------------------
// Chats Browser & Selector
// --------------------------------------------------

async function loadChats() {
    const grid = document.getElementById("chat-grid-container");
    grid.innerHTML = `<div class="loading-state"><i class="fa-solid fa-circle-notch fa-spin"></i> Loading dialogs...</div>`;
    
    try {
        const res = await fetch(`${API_BASE}/api/dialogs`);
        if (!res.ok) throw new Error("Failed to fetch chats");
        state.chats = await res.json();
        renderChats();
    } catch (e) {
        grid.innerHTML = `<div class="placeholder-state"><i class="fa-solid fa-triangle-exclamation"></i><p>Error loading chats: ${e.message}</p></div>`;
        logToConsole(`Error loading chats: ${e.message}`, "ERROR");
    }
}

function renderChats() {
    const grid = document.getElementById("chat-grid-container");
    const searchVal = document.getElementById("search-chats-input").value.toLowerCase();
    const filterType = document.querySelector(".filter-pills .pill.active").getAttribute("data-filter");
    
    // Filter chats in memory
    const filtered = state.chats.filter(chat => {
        // Search query
        const matchSearch = chat.name.toLowerCase().includes(searchVal) || chat.username.toLowerCase().includes(searchVal);
        // Chat type pill filter
        let matchType = true;
        if (filterType === "group") {
            matchType = chat.type === "group" || chat.type === "channel" && chat.member_count !== null; // channels can be groups too, but telethon categorizes supergroups as channels sometimes
        } else if (filterType === "channel") {
            matchType = chat.type === "channel";
        }
        
        return matchSearch && matchType;
    });
    
    if (filtered.length === 0) {
        grid.innerHTML = `<div class="placeholder-state"><i class="fa-solid fa-box-open"></i><p>No chats found matching filters.</p></div>`;
        return;
    }
    
    grid.innerHTML = "";
    filtered.forEach(chat => {
        const card = document.createElement("div");
        card.className = "chat-card";
        
        // Avatar
        const avatar = document.createElement("div");
        avatar.className = "chat-avatar";
        avatar.style.background = getAvatarColor(chat.name);
        avatar.textContent = chat.name ? chat.name.substring(0, 2) : "??";
        
        // Content Info
        const info = document.createElement("div");
        info.className = "chat-info";
        
        const name = document.createElement("div");
        name.className = "chat-name";
        name.textContent = chat.name;
        
        const meta = document.createElement("div");
        meta.className = "chat-meta";
        
        const type = document.createElement("span");
        type.className = "chat-type-badge";
        type.textContent = chat.type;
        meta.appendChild(type);
        
        if (chat.member_count) {
            const members = document.createElement("span");
            members.className = "chat-members";
            members.textContent = `${chat.member_count.toLocaleString()} members`;
            meta.appendChild(members);
        }
        
        info.appendChild(name);
        info.appendChild(meta);
        
        card.appendChild(avatar);
        card.appendChild(info);
        
        if (chat.unread_count > 0) {
            const badge = document.createElement("div");
            badge.className = "chat-badge";
            badge.textContent = chat.unread_count;
            card.appendChild(badge);
        }
        
        card.addEventListener("click", () => startScan(chat));
        grid.appendChild(card);
    });
}

function initChatsListeners() {
    // Search input
    document.getElementById("search-chats-input").addEventListener("input", renderChats);
    
    // Filter pills
    document.querySelectorAll(".filter-pills .pill").forEach(pill => {
        pill.addEventListener("click", (e) => {
            document.querySelectorAll(".filter-pills .pill").forEach(p => p.classList.remove("active"));
            pill.classList.add("active");
            renderChats();
        });
    });

    // Custom chat scanner
    document.getElementById("btn-custom-chat-scan").addEventListener("click", () => {
        const val = document.getElementById("input-custom-chat").value.trim();
        if (!val) return;
        startScan({ id: val, name: val, type: "custom" });
    });
}

// --------------------------------------------------
// Media Scanner & Video Grid
// --------------------------------------------------

function startScan(chat) {
    state.currentChat = chat;
    state.scannedVideos = [];
    state.selectedVideoIds.clear();
    updateSelectionStats();
    
    // Switch to scanner panel
    document.getElementById("nav-btn-scanner").click();
    
    // Update headers
    document.getElementById("scanner-title").textContent = `Scanning: ${chat.name}`;
    document.getElementById("scanner-subtitle").textContent = `Connecting to chat and scanning messages...`;
    
    // Show stats indicator
    const indicator = document.getElementById("scan-indicator");
    indicator.style.display = "flex";
    document.getElementById("scan-stat-scanned").textContent = "0";
    document.getElementById("scan-stat-found").textContent = "0";
    
    const container = document.getElementById("video-grid-container");
    container.innerHTML = `<div class="loading-state"><i class="fa-solid fa-circle-notch fa-spin"></i> Initializing scan...</div>`;
    
    // Send scan action to WebSocket
    if (state.wsConnected && state.socket) {
        state.socket.send(JSON.stringify({
            action: "scan",
            chat_id: chat.id
        }));
    } else {
        container.innerHTML = `<div class="placeholder-state"><i class="fa-solid fa-triangle-exclamation"></i><p>Disconnected from socket server. Cannot scan.</p></div>`;
    }
}

function handleScanEvent(data) {
    if (data.event === "video_found") {
        state.scannedVideos.push(data.video);
        document.getElementById("scan-stat-scanned").textContent = data.scanned;
        document.getElementById("scan-stat-found").textContent = state.scannedVideos.length;
        
        // Remove loading state if it is showing
        const container = document.getElementById("video-grid-container");
        if (container.querySelector(".loading-state") || container.querySelector(".placeholder-state")) {
            container.innerHTML = "";
        }
        
        renderVideoCard(data.video);
    } else if (data.event === "scan_progress") {
        document.getElementById("scan-stat-scanned").textContent = data.scanned;
        document.getElementById("scan-stat-found").textContent = data.found_count;
    } else if (data.event === "scan_completed") {
        logToConsole(`[Scanner] Completed scanning. Found ${data.found_count} videos out of ${data.scanned} total messages.`, "INFO");
        
        document.getElementById("scan-indicator").style.display = "none";
        document.getElementById("scanner-subtitle").textContent = `Scan complete. Found ${data.found_count} videos total.`;
        
        if (state.scannedVideos.length === 0) {
            document.getElementById("video-grid-container").innerHTML = `<div class="placeholder-state"><i class="fa-solid fa-film"></i><p>No video files found in this chat.</p></div>`;
        }
        
        // Trigger a fresh filter/render pass
        filterAndRenderVideos();
    }
}

function renderVideoCard(video) {
    // Only render if video passes current filters
    if (!matchesFilters(video)) return;
    
    const container = document.getElementById("video-grid-container");
    const videoId = `${video.chat_id}_${video.msg_id}`;
    
    // Check if card already exists to avoid duplication
    if (document.getElementById(`video-card-${videoId}`)) return;
    
    const card = document.createElement("div");
    card.id = `video-card-${videoId}`;
    card.className = "video-card" + (state.selectedVideoIds.has(videoId) ? " selected" : "");
    
    // Thumbnail container
    const thumbContainer = document.createElement("div");
    thumbContainer.className = "video-thumbnail-container";
    
    const fallbackIcon = document.createElement("i");
    fallbackIcon.className = "fa-solid fa-file-video video-icon-fallback";
    thumbContainer.appendChild(fallbackIcon);
    
    const sizeBadge = document.createElement("span");
    sizeBadge.className = "video-size-badge";
    sizeBadge.textContent = formatBytes(video.size, 1);
    thumbContainer.appendChild(sizeBadge);
    
    if (video.duration) {
        const durationBadge = document.createElement("span");
        durationBadge.className = "video-duration-badge";
        durationBadge.textContent = formatDuration(video.duration);
        thumbContainer.appendChild(durationBadge);
    }
    
    const checkbox = document.createElement("div");
    checkbox.className = "video-select-checkbox";
    checkbox.innerHTML = `<i class="fa-solid fa-check"></i>`;
    thumbContainer.appendChild(checkbox);
    
    // Meta data body
    const body = document.createElement("div");
    body.className = "video-meta-body";
    
    const name = document.createElement("div");
    name.className = "video-name";
    // Prioritize filename as original
    name.textContent = video.filename;
    name.title = video.filename;
    
    const row = document.createElement("div");
    row.className = "video-info-row";
    
    const dateEl = document.createElement("span");
    const d = new Date(video.date);
    dateEl.textContent = d.toLocaleDateString();
    row.appendChild(dateEl);
    
    body.appendChild(name);
    body.appendChild(row);
    
    card.appendChild(thumbContainer);
    card.appendChild(body);
    
    // Select Click Listener
    card.addEventListener("click", () => {
        if (state.selectedVideoIds.has(videoId)) {
            state.selectedVideoIds.delete(videoId);
            card.classList.remove("selected");
        } else {
            state.selectedVideoIds.add(videoId);
            card.classList.add("selected");
        }
        updateSelectionStats();
    });
    
    container.appendChild(card);
}

function matchesFilters(video) {
    const searchVal = document.getElementById("filter-search-media").value.toLowerCase();
    const typeVal = document.getElementById("filter-media-type").value;
    
    // Min/Max Size
    const minSizeMB = parseInt(document.getElementById("filter-size-min").value);
    const maxSizeMB = parseInt(document.getElementById("filter-size-max").value);
    
    const sizeMB = video.size / (1024 * 1024);
    
    // Check search query
    const matchSearch = video.filename.toLowerCase().includes(searchVal) || (video.caption || "").toLowerCase().includes(searchVal);
    
    // Check size range
    let matchSize = sizeMB >= minSizeMB;
    if (maxSizeMB < 2000) { // 2000 represents 2GB+ (unlimited)
        matchSize = matchSize && sizeMB <= maxSizeMB;
    }
    
    // Check video format
    let matchFormat = true;
    if (typeVal === "mp4") {
        matchFormat = video.mime_type && video.mime_type.startsWith("video/") && video.mime_type !== "application/x-tgmsg";
    } else if (typeVal === "doc") {
        matchFormat = !video.mime_type || !video.mime_type.startsWith("video/") || video.mime_type === "application/x-tgmsg";
    }
    
    return matchSearch && matchSize && matchFormat;
}

function filterAndRenderVideos() {
    const container = document.getElementById("video-grid-container");
    container.innerHTML = "";
    
    const filtered = state.scannedVideos.filter(matchesFilters);
    
    if (filtered.length === 0) {
        container.innerHTML = `<div class="placeholder-state"><i class="fa-solid fa-box-open"></i><p>No video files match your filters.</p></div>`;
        return;
    }
    
    filtered.forEach(renderVideoCard);
    updateSelectionStats();
}

function updateSelectionStats() {
    let totalBytes = 0;
    let count = 0;
    
    state.scannedVideos.forEach(v => {
        const id = `${v.chat_id}_${v.msg_id}`;
        if (state.selectedVideoIds.has(id) && matchesFilters(v)) {
            totalBytes += v.size;
            count++;
        }
    });
    
    document.getElementById("selection-count-text").textContent = `${count} files selected (${formatBytes(totalBytes)})`;
    
    // Toggle queue button state
    const btn = document.getElementById("btn-queue-downloads");
    btn.disabled = count === 0 || !state.currentDownloadFolder;
}

function initScannerListeners() {
    // Filter controls
    document.getElementById("filter-search-media").addEventListener("input", filterAndRenderVideos);
    document.getElementById("filter-media-type").addEventListener("change", filterAndRenderVideos);
    
    // Size ranges
    const rangeMin = document.getElementById("filter-size-min");
    const rangeMax = document.getElementById("filter-size-max");
    const labelMin = document.getElementById("size-min-label");
    const labelMax = document.getElementById("size-max-label");
    
    const updateSizeLabels = () => {
        const minVal = parseInt(rangeMin.value);
        const maxVal = parseInt(rangeMax.value);
        
        // Ensure values don't cross
        if (minVal > maxVal) {
            rangeMin.value = maxVal;
        }
        
        labelMin.textContent = rangeMin.value + " MB";
        labelMax.textContent = maxVal >= 2000 ? "2+ GB" : maxVal + " MB";
        
        filterAndRenderVideos();
    };
    
    rangeMin.addEventListener("input", updateSizeLabels);
    rangeMax.addEventListener("input", updateSizeLabels);

    // Select All
    document.getElementById("btn-select-all").addEventListener("click", () => {
        state.scannedVideos.forEach(v => {
            if (matchesFilters(v)) {
                const id = `${v.chat_id}_${v.msg_id}`;
                state.selectedVideoIds.add(id);
                const el = document.getElementById(`video-card-${id}`);
                if (el) el.classList.add("selected");
            }
        });
        updateSelectionStats();
    });

    // Deselect All
    document.getElementById("btn-deselect-all").addEventListener("click", () => {
        state.scannedVideos.forEach(v => {
            const id = `${v.chat_id}_${v.msg_id}`;
            state.selectedVideoIds.delete(id);
            const el = document.getElementById(`video-card-${id}`);
            if (el) el.classList.remove("selected");
        });
        updateSelectionStats();
    });

    // Queue Selected Downloads
    document.getElementById("btn-queue-downloads").addEventListener("click", () => {
        if (!state.currentDownloadFolder) {
            alert("Please choose a download folder first.");
            return;
        }
        
        const videosToQueue = [];
        state.scannedVideos.forEach(v => {
            const id = `${v.chat_id}_${v.msg_id}`;
            if (state.selectedVideoIds.has(id) && matchesFilters(v)) {
                videosToQueue.push({
                    chat_id: v.chat_id,
                    msg_id: v.msg_id,
                    filename: v.filename,
                    size: v.size
                });
            }
        });
        
        if (videosToQueue.length === 0) return;
        
        // Send download request via WS
        state.socket.send(JSON.stringify({
            action: "download",
            videos: videosToQueue,
            save_dir: state.currentDownloadFolder
        }));
        
        // Clear selection
        state.selectedVideoIds.clear();
        updateSelectionStats();
        
        // Go to downloads tab
        document.getElementById("nav-btn-downloads").click();
    });

    // Pick folders modal triggers
    document.getElementById("btn-pick-folder").addEventListener("click", () => {
        openDirectoryExplorer("selected-folder-path-display");
    });
}

// --------------------------------------------------
// Directory Explorer Modal
// --------------------------------------------------

async function openDirectoryExplorer(targetLabelId) {
    state.explorerTargetInputId = targetLabelId;
    state.explorerSelectedPath = "";
    document.getElementById("folder-modal").classList.add("active");
    document.getElementById("btn-confirm-folder").disabled = true;
    
    // Load root browsing paths
    await browsePath("");
}

async function browsePath(dirPath) {
    try {
        const res = await fetch(`${API_BASE}/api/folders/browse?path=${encodeURIComponent(dirPath)}`);
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.detail || "Explorer permission error");
        }
        
        const data = await res.json();
        
        state.explorerCurrentPath = data.current_path;
        state.explorerParentPath = data.parent_path;
        state.explorerFolders = data.folders;
        state.explorerDrives = data.drives;
        state.explorerCommon = data.common;
        
        renderDirectoryExplorer();
    } catch (e) {
        logToConsole(`Explorer path access error: ${e.message}`, "WARNING");
        alert(e.message);
    }
}

function renderDirectoryExplorer() {
    const sidebar = document.getElementById("folder-sidebar-presets");
    const list = document.getElementById("folder-explorer-list");
    const breadcrumbs = document.getElementById("folder-breadcrumbs");
    
    // Render presets (Drives and Common locations)
    sidebar.innerHTML = "";
    
    if (state.explorerCommon.length > 0) {
        const title = document.createElement("div");
        title.className = "sidebar-section-title";
        title.textContent = "Common Places";
        sidebar.appendChild(title);
        
        state.explorerCommon.forEach(item => {
            const btn = document.createElement("button");
            btn.className = "explorer-preset-btn";
            btn.innerHTML = `<i class="fa-solid fa-folder"></i> ${item.name}`;
            btn.addEventListener("click", () => browsePath(item.path));
            sidebar.appendChild(btn);
        });
    }
    
    if (state.explorerDrives.length > 0) {
        const title = document.createElement("div");
        title.className = "sidebar-section-title";
        title.textContent = "Drives";
        sidebar.appendChild(title);
        
        state.explorerDrives.forEach(drive => {
            const btn = document.createElement("button");
            btn.className = "explorer-preset-btn";
            btn.innerHTML = `<i class="fa-solid fa-hard-drive"></i> ${drive}`;
            btn.addEventListener("click", () => browsePath(drive));
            sidebar.appendChild(btn);
        });
    }
    
    // Render breadcrumbs
    breadcrumbs.innerHTML = "";
    
    const rootCrumb = document.createElement("span");
    rootCrumb.className = "crumb";
    rootCrumb.textContent = "My PC";
    rootCrumb.addEventListener("click", () => browsePath(""));
    breadcrumbs.appendChild(rootCrumb);
    
    if (state.explorerCurrentPath) {
        // Split path depending on OS
        const separator = state.explorerCurrentPath.includes("\\") ? "\\" : "/";
        const parts = state.explorerCurrentPath.split(separator).filter(p => p !== "");
        
        let pathAccumulator = "";
        
        parts.forEach((part, i) => {
            // Re-add separator
            if (i === 0 && state.explorerCurrentPath.startsWith(separator)) {
                pathAccumulator += separator;
            }
            
            // Check drive letter syntax
            if (part.endsWith(":") && i === 0) {
                pathAccumulator = part + separator;
            } else {
                pathAccumulator += (pathAccumulator.endsWith(separator) || !pathAccumulator ? "" : separator) + part;
            }
            
            const sepSpan = document.createElement("span");
            sepSpan.className = "separator";
            sepSpan.innerHTML = `<i class="fa-solid fa-chevron-right"></i>`;
            breadcrumbs.appendChild(sepSpan);
            
            const crumb = document.createElement("span");
            crumb.className = "crumb" + (i === parts.length - 1 ? " active" : "");
            crumb.textContent = part;
            
            const targetPath = pathAccumulator;
            crumb.addEventListener("click", () => browsePath(targetPath));
            breadcrumbs.appendChild(crumb);
        });
    }
    
    // Render directory rows
    list.innerHTML = "";
    
    // Add UP directory option
    if (state.explorerCurrentPath) {
        const row = document.createElement("div");
        row.className = "explorer-row up-row";
        row.innerHTML = `<i class="fa-solid fa-arrow-turn-up"></i> <strong>.. (Parent Directory)</strong>`;
        row.addEventListener("click", () => browsePath(state.explorerParentPath));
        list.appendChild(row);
    }
    
    if (state.explorerFolders.length === 0) {
        const row = document.createElement("div");
        row.className = "explorer-row empty-row";
        row.textContent = "This folder is empty";
        list.appendChild(row);
    } else {
        state.explorerFolders.forEach(folder => {
            const row = document.createElement("div");
            row.className = "explorer-row" + (state.explorerSelectedPath === folder.path ? " selected" : "");
            row.innerHTML = `<i class="fa-solid fa-folder"></i> <span>${folder.name}</span>`;
            
            row.addEventListener("click", () => {
                state.explorerSelectedPath = folder.path;
                document.getElementById("modal-selected-path-display").textContent = folder.name;
                document.getElementById("btn-confirm-folder").disabled = false;
                
                // Highlight row
                document.querySelectorAll(".explorer-list-view .explorer-row").forEach(r => r.classList.remove("selected"));
                row.classList.add("selected");
            });
            
            row.addEventListener("dblclick", () => {
                browsePath(folder.path);
            });
            
            list.appendChild(row);
        });
    }
}

function initDirectoryExplorer() {
    const modal = document.getElementById("folder-modal");
    
    const closeModal = () => modal.classList.remove("active");
    
    document.getElementById("btn-close-modal").addEventListener("click", closeModal);
    document.getElementById("folder-modal-overlay").addEventListener("click", closeModal);
    document.getElementById("btn-cancel-folder").addEventListener("click", closeModal);
    
    document.getElementById("btn-confirm-folder").addEventListener("click", () => {
        if (!state.explorerSelectedPath) return;
        
        const path = state.explorerSelectedPath;
        state.currentDownloadFolder = path;
        
        // Update both labels on UI
        document.getElementById("selected-folder-path-display").textContent = path;
        document.getElementById("settings-default-dir").value = path;
        
        updateSelectionStats();
        closeModal();
    });
}

// --------------------------------------------------
// Download Manager Queue UI
// --------------------------------------------------

function handleDownloadProgress(data) {
    const videoId = data.video_id;
    
    // Find matching scanned video object to display original filename
    const scanRef = state.scannedVideos.find(v => `${v.chat_id}_${v.msg_id}` === videoId);
    const displayName = scanRef ? scanRef.filename : `Video ID: ${videoId}`;
    const fileSize = scanRef ? scanRef.size : 0;
    
    // Update local state map
    if (!state.downloads[videoId]) {
        state.downloads[videoId] = {
            id: videoId,
            name: displayName,
            size: fileSize,
            progress: 0.0,
            downloaded_bytes: 0,
            speed: 0,
            eta: -1,
            status: "queued"
        };
    }
    
    // Sync attributes if provided
    const item = state.downloads[videoId];
    if (data.status) item.status = data.status;
    if (data.progress !== undefined) item.progress = data.progress;
    if (data.downloaded_bytes !== undefined) item.downloaded_bytes = data.downloaded_bytes;
    if (data.speed !== undefined) item.speed = data.speed;
    if (data.eta !== undefined) item.eta = data.eta;
    if (data.error) {
        item.error = data.error;
        logToConsole(`[Downloader] Download error on ${displayName}: ${data.error}`, "ERROR");
    }
    
    // Update visual badge and overall queue progress calculations
    updateGlobalDownloadMetrics();
    renderDownloadItemCard(item);
}

function renderDownloadItemCard(item) {
    const queueList = document.getElementById("downloads-queue-list");
    
    // Remove placeholder if present
    if (queueList.querySelector(".placeholder-state")) {
        queueList.innerHTML = "";
    }
    
    let el = document.getElementById(`download-item-${item.id}`);
    if (!el) {
        el = document.createElement("div");
        el.id = `download-item-${item.id}`;
        el.className = "download-item-card";
        queueList.appendChild(el);
    }
    
    // Determine status icons and class mappings
    let statusClass = item.status;
    let iconHTML = `<i class="fa-solid fa-spinner fa-spin"></i>`;
    
    if (item.status === "queued") {
        iconHTML = `<i class="fa-regular fa-clock"></i>`;
    } else if (item.status === "downloading") {
        iconHTML = `<i class="fa-solid fa-circle-arrow-down"></i>`;
    } else if (item.status === "completed") {
        iconHTML = `<i class="fa-solid fa-check-double"></i>`;
    } else if (item.status === "paused") {
        iconHTML = `<i class="fa-solid fa-pause"></i>`;
    } else if (item.status === "cooldown") {
        iconHTML = `<i class="fa-solid fa-hourglass-half"></i>`;
    } else if (item.status === "cancelled") {
        iconHTML = `<i class="fa-solid fa-ban"></i>`;
    } else if (item.status === "error") {
        iconHTML = `<i class="fa-solid fa-circle-exclamation"></i>`;
    }
    
    // Actions layout based on status
    let actionButtonsHTML = "";
    if (item.status === "downloading" || item.status === "queued" || item.status === "cooldown") {
        actionButtonsHTML += `
            <button class="download-action-btn btn-pause" title="Pause Download"><i class="fa-solid fa-pause"></i></button>
            <button class="download-action-btn btn-cancel" title="Cancel Download"><i class="fa-solid fa-xmark"></i></button>
        `;
    } else if (item.status === "paused") {
        actionButtonsHTML += `
            <button class="download-action-btn btn-resume" title="Resume Download"><i class="fa-solid fa-play"></i></button>
            <button class="download-action-btn btn-cancel" title="Cancel Download"><i class="fa-solid fa-xmark"></i></button>
        `;
    } else {
        actionButtonsHTML += `
            <button class="download-action-btn btn-del" title="Remove"><i class="fa-regular fa-trash-can"></i></button>
        `;
    }
    
    // Layout inner content
    el.innerHTML = `
        <div class="download-status-icon ${statusClass}">
            ${iconHTML}
        </div>
        <div class="download-item-details">
            <div class="download-item-header">
                <span class="download-item-name" title="${item.name}">${item.name}</span>
                <span class="download-item-percentage">${item.progress.toFixed(1)}%</span>
            </div>
            
            <div class="progress-bar-track" style="margin: 0.15rem 0;">
                <div class="progress-bar-fill" style="width: ${item.progress}%; background: ${item.status === 'error' ? 'var(--danger)' : 'var(--primary-gradient)'}"></div>
            </div>
            
            <div class="download-item-meta">
                <span>${formatBytes(item.downloaded_bytes)} / ${formatBytes(item.size)}</span>
                ${item.status === 'downloading' ? `
                    <span>• Speed: <strong>${formatBytes(item.speed)}/s</strong></span>
                    <span>• ETA: <strong>${formatEta(item.eta)}</strong></span>
                ` : ''}
                ${item.status === 'cooldown' ? `
                    <span class="text-warning"><i class="fa-solid fa-triangle-exclamation"></i> Rate Limit. Waiting...</span>
                ` : ''}
                ${item.status === 'error' ? `
                    <span class="text-danger"><i class="fa-solid fa-circle-exclamation"></i> Error: ${item.error || 'Failed'}</span>
                ` : ''}
                ${item.status === 'completed' ? `
                    <span class="text-success"><i class="fa-solid fa-circle-check"></i> Complete</span>
                ` : ''}
            </div>
        </div>
        <div class="download-item-actions">
            ${actionButtonsHTML}
        </div>
    `;
    
    // Hook individual button clicks
    const btnPause = el.querySelector(".btn-pause");
    const btnResume = el.querySelector(".btn-resume");
    const btnCancel = el.querySelector(".btn-cancel");
    const btnDel = el.querySelector(".btn-del");
    
    if (btnPause) {
        btnPause.addEventListener("click", () => {
            state.socket.send(JSON.stringify({ action: "pause_download", video_id: item.id }));
        });
    }
    if (btnResume) {
        btnResume.addEventListener("click", () => {
            state.socket.send(JSON.stringify({ action: "resume_download", video_id: item.id }));
        });
    }
    if (btnCancel) {
        btnCancel.addEventListener("click", () => {
            state.socket.send(JSON.stringify({ action: "cancel_download", video_id: item.id }));
        });
    }
    if (btnDel) {
        btnDel.addEventListener("click", () => {
            el.remove();
            delete state.downloads[item.id];
            updateGlobalDownloadMetrics();
            
            // If empty, restore placeholder
            if (Object.keys(state.downloads).length === 0) {
                queueList.innerHTML = `
                    <div class="placeholder-state">
                        <i class="fa-solid fa-circle-down"></i>
                        <p>No active downloads. Scans files, select them, and queue them here.</p>
                    </div>
                `;
            }
        });
    }
}

function updateGlobalDownloadMetrics() {
    const list = Object.values(state.downloads);
    
    // Count active
    const downloadingItems = list.filter(item => item.status === "downloading" || item.status === "cooldown");
    const activeCount = downloadingItems.length;
    const completedCount = list.filter(item => item.status === "completed").length;
    const totalCount = list.length;
    
    // Update Badge
    const badge = document.getElementById("active-download-badge");
    const activeWaitCount = list.filter(item => ["downloading", "cooldown", "queued", "paused"].includes(item.status)).length;
    if (activeWaitCount > 0) {
        badge.style.display = "block";
        badge.textContent = activeWaitCount;
    } else {
        badge.style.display = "none";
    }
    
    // Calculate global speed (sum of speeds of active downloads)
    let totalSpeed = 0;
    downloadingItems.forEach(item => {
        totalSpeed += item.speed;
    });
    document.getElementById("global-speed-display").textContent = `${(totalSpeed / (1024 * 1024)).toFixed(1)} MB/s`;
    
    // Calculate global ETA
    let totalBytesRemaining = 0;
    list.forEach(item => {
        if (["downloading", "queued", "paused", "cooldown"].includes(item.status)) {
            totalBytesRemaining += (item.size - item.downloaded_bytes);
        }
    });
    
    const globalEta = totalSpeed > 0 ? totalBytesRemaining / totalSpeed : -1;
    document.getElementById("global-eta-display").textContent = formatEta(globalEta);
    
    // Calculate overall progress bar percentage
    let totalQueueSize = 0;
    let totalQueueDownloaded = 0;
    list.forEach(item => {
        totalQueueSize += item.size;
        totalQueueDownloaded += item.downloaded_bytes;
    });
    
    const progressPercent = totalQueueSize > 0 ? (totalQueueDownloaded / totalQueueSize) * 100 : 0;
    document.getElementById("overall-progress-percentage").textContent = Math.round(progressPercent) + "%";
    document.getElementById("overall-progress-fill").style.width = progressPercent + "%";
    
    // Update Counter value
    document.getElementById("global-active-count").textContent = `${completedCount} / ${totalCount}`;
}

function initDownloadManagerListeners() {
    // Global actions
    document.getElementById("btn-global-pause").addEventListener("click", () => {
        Object.values(state.downloads).forEach(item => {
            if (["downloading", "queued", "cooldown"].includes(item.status)) {
                state.socket.send(JSON.stringify({ action: "pause_download", video_id: item.id }));
            }
        });
    });
    
    document.getElementById("btn-global-cancel").addEventListener("click", () => {
        if (!confirm("Are you sure you want to cancel all active and queued downloads?")) return;
        Object.values(state.downloads).forEach(item => {
            if (["downloading", "queued", "paused", "cooldown"].includes(item.status)) {
                state.socket.send(JSON.stringify({ action: "cancel_download", video_id: item.id }));
            }
        });
    });

    document.getElementById("btn-clear-completed").addEventListener("click", () => {
        Object.values(state.downloads).forEach(item => {
            if (item.status === "completed" || item.status === "cancelled" || item.status === "error") {
                const el = document.getElementById(`download-item-${item.id}`);
                if (el) el.remove();
                delete state.downloads[item.id];
            }
        });
        updateGlobalDownloadMetrics();
        
        // Restore placeholder if empty
        const queueList = document.getElementById("downloads-queue-list");
        if (Object.keys(state.downloads).length === 0) {
            queueList.innerHTML = `
                <div class="placeholder-state">
                    <i class="fa-solid fa-circle-down"></i>
                    <p>No active downloads. Scans files, select them, and queue them here.</p>
                </div>
            `;
        }
    });
}

// --------------------------------------------------
// Engine Settings Panel
// --------------------------------------------------

function initSettings() {
    const selectSpeed = document.getElementById("settings-speed-limit");
    const rangeConcur = document.getElementById("settings-concurrency");
    const concurVal = document.getElementById("settings-concurrency-value");
    
    const sendSettingsUpdate = () => {
        const speed = parseInt(selectSpeed.value);
        const concur = parseInt(rangeConcur.value);
        
        concurVal.textContent = `${concur} concurrent downloads`;
        
        if (state.wsConnected && state.socket) {
            state.socket.send(JSON.stringify({
                action: "update_settings",
                speed_limit: speed,
                concurrent_limit: concur
            }));
            logToConsole(`[System] Engine settings updated: speed=${speed}KB/s, concurrent=${concur}`, "system");
        }
    };
    
    selectSpeed.addEventListener("change", sendSettingsUpdate);
    rangeConcur.addEventListener("input", sendSettingsUpdate);
    
    // Pick folders from settings page
    document.getElementById("btn-settings-pick-folder").addEventListener("click", () => {
        openDirectoryExplorer("settings-default-dir");
    });
}

// --------------------------------------------------
// History Panel Logic
// --------------------------------------------------

async function loadHistory() {
    const container = document.getElementById("history-list-container");
    container.innerHTML = `<div class="loading-state"><i class="fa-solid fa-circle-notch fa-spin"></i> Loading history...</div>`;
    
    try {
        const res = await fetch(`${API_BASE}/api/history`);
        if (!res.ok) throw new Error("Failed to load history");
        const history = await res.json();
        
        if (history.length === 0) {
            container.innerHTML = `<div class="placeholder-state"><i class="fa-solid fa-clock-rotate-left"></i><p>No history yet.</p></div>`;
            return;
        }
        
        container.innerHTML = "";
        history.forEach(item => {
            const el = document.createElement("div");
            el.className = "download-item-card";
            el.innerHTML = `
                <div class="download-status-icon completed">
                    <i class="fa-solid fa-check-double"></i>
                </div>
                <div class="download-item-details">
                    <div class="download-item-header">
                        <span class="download-item-name" title="${item.filename}">${item.filename}</span>
                    </div>
                    <div class="download-item-meta">
                        <span>${formatBytes(item.size)}</span>
                        <span>• Date: ${new Date(item.date).toLocaleString()}</span>
                        <span>• Path: ${item.path}</span>
                    </div>
                </div>
            `;
            container.appendChild(el);
        });
        
    } catch (e) {
        container.innerHTML = `<div class="placeholder-state"><i class="fa-solid fa-triangle-exclamation"></i><p>Error: ${e.message}</p></div>`;
    }
}

function initHistoryListeners() {
    document.getElementById("nav-btn-history").addEventListener("click", loadHistory);
    document.getElementById("btn-refresh-history").addEventListener("click", loadHistory);
    
    document.getElementById("btn-clear-history").addEventListener("click", async () => {
        if (!confirm("Are you sure you want to clear your download history? This cannot be undone.")) return;
        try {
            const res = await fetch(`${API_BASE}/api/history/clear`, { method: "POST" });
            if (!res.ok) throw new Error("Failed to clear history");
            loadHistory();
        } catch(e) {
            alert(e.message);
        }
    });
}

// --------------------------------------------------
// Collapsible System Logs Drawer Console
// --------------------------------------------------

function initLogsConsole() {
    const footer = document.getElementById("app-footer");
    const toggleBtn = document.getElementById("btn-toggle-logs");
    const clearBtn = document.getElementById("btn-clear-logs");
    const term = document.getElementById("logs-terminal-output");
    
    toggleBtn.addEventListener("click", (e) => {
        // Prevent click if clicking the clear trash button
        if (e.target.closest("#btn-clear-logs")) return;
        
        footer.classList.toggle("collapsed");
    });
    
    clearBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        term.innerHTML = `<div class="log-line system">[System] Console cleared.</div>`;
    });
    
    // Default collapsed on boot
    footer.classList.add("collapsed");
}

// --------------------------------------------------
// Application Bootloader
// --------------------------------------------------

window.addEventListener("DOMContentLoaded", () => {
    logToConsole("[System] Application loader started...", "system");
    
    // Init components
    initNavigation();
    initAuthForms();
    initChatsListeners();
    initScannerListeners();
    initDirectoryExplorer();
    initDownloadManagerListeners();
    initSettings();
    initHistoryListeners();
    initLogsConsole();
    
    // Connect WebSocket
    initWebSocket();
});
