let currentPlaylist = [];
let currentIndex = -1;
let isPlaying = false;
let currentVolume = 70;
let currentMuted = false; // 当前静音状态
let currentDuration = 0; // 当前歌曲总时长
let progressUpdateInterval = null; // 进度更新定时器
let syncStatusInterval = null; // 状态同步定时器（用于多客户端同步）
let currentPlayMode = 'sequence'; // 当前播放模式
let selectedPlaylistTracks = new Set(); // 播放列表选中的歌曲索引
let lastClickedPlaylistIndex = -1; // 上次点击的播放列表索引（用于Shift多选）
let taskListPollInterval = null; // 任务列表轮询定时器
let playOutput = 'server'; // 播放输出方式：server(服务器声卡), client(客户端浏览器)
let clientAudio = null; // 客户端 Audio 元素
let isStoppingClient = false; // 是否正在主动停止客户端播放

// 用户认证
let authToken = localStorage.getItem('authToken') || null;
let currentUser = null;
let needPassword = false;
let pendingAuthRequests = [];
let isLoginModalShowing = false;

const originalFetch = window.fetch.bind(window);
const NO_AUTH_URLS = [
    '/api/user/login',
    '/api/user/info',
    '/api/user/set-password'
];

window.fetch = function(url, options = {}) {
    if (!options.headers) {
        options.headers = {};
    }
    
    if (authToken) {
        if (options.headers instanceof Headers) {
            options.headers.set('Authorization', 'Bearer ' + authToken);
        } else if (typeof options.headers === 'object') {
            options.headers['Authorization'] = 'Bearer ' + authToken;
        }
    }
    
    return originalFetch(url, options).then(response => {
        if (response.status === 401) {
            const urlPath = url.startsWith('http') ? new URL(url).pathname : url;
            if (NO_AUTH_URLS.some(u => urlPath === u || urlPath.startsWith(u + '/'))) {
                return response;
            }
            
            authToken = null;
            localStorage.removeItem('authToken');
            currentUser = null;
            if (typeof updateUserCardUI === 'function') {
                updateUserCardUI();
            }
            
            const pending = {
                url,
                options: { ...options, headers: { ...options.headers } }
            };
            
            const promise = new Promise((resolve, reject) => {
                pending.resolve = resolve;
                pending.reject = reject;
            });
            
            pendingAuthRequests.push(pending);
            
            if (!isLoginModalShowing) {
                isLoginModalShowing = true;
                if (typeof showLoginModal === 'function') {
                    showLoginModal();
                }
            }
            
            return promise;
        }
        return response;
    });
};

const playModeIcons = {
    'sequence': 'fas fa-list',
    'random': 'fas fa-random',
    'single': 'fas fa-redo',
    'loop': 'fas fa-redo-alt'
};

const playModeTitles = {
    'sequence': '顺序播放',
    'random': '随机播放',
    'single': '单曲播放',
    'loop': '单曲循环'
};

async function apiRequest(endpoint, method = 'GET', data = null) {
    const options = {
        method,
        headers: {
            'Content-Type': 'application/json'
        }
    };
    
    if (data) {
        options.body = JSON.stringify(data);
    }
    
    const response = await fetch(endpoint, options);
    return await response.json();
}

// ========== 用户认证相关 ==========

function requireLogin() {
    if (currentUser) {
        return Promise.resolve();
    }
    
    return new Promise((resolve, reject) => {
        const pending = {
            url: '',
            options: {},
            resolve: () => resolve(),
            reject: (err) => reject(err || new Error('用户取消登录'))
        };
        pendingAuthRequests.push(pending);
        
        if (!isLoginModalShowing) {
            isLoginModalShowing = true;
            if (typeof showLoginModal === 'function') {
                showLoginModal();
            }
        }
    });
}

async function checkAuthStatus() {
    try {
        const result = await apiRequest('/api/user/info');
        if (result.success) {
            needPassword = result.needPassword;
            if (result.isLoggedIn) {
                currentUser = {
                    username: result.username,
                    nickname: result.nickname
                };
            } else {
                currentUser = null;
            }
            updateUserCardUI();
        }
    } catch (error) {
        console.error('检查登录状态失败:', error);
    }
}

function updateUserCardUI() {
    const userCard = document.getElementById('userCard');
    const nicknameEl = document.getElementById('userNickname');
    const statusEl = document.getElementById('userStatus');
    
    if (!userCard || !nicknameEl || !statusEl) return;
    
    if (currentUser) {
        userCard.classList.add('logged-in');
        nicknameEl.textContent = currentUser.nickname || currentUser.username || '用户';
        statusEl.textContent = '已登录';
    } else if (needPassword) {
        userCard.classList.remove('logged-in');
        nicknameEl.textContent = '未登录';
        statusEl.textContent = '点击登录';
    } else {
        userCard.classList.remove('logged-in');
        nicknameEl.textContent = '访客模式';
        statusEl.textContent = '点击设置密码';
    }
}

function handleUserCardClick() {
    if (currentUser) {
        showLoggedInModal();
    } else {
        showLoginModal();
    }
}

function showLoggedInModal() {
    const modal = document.getElementById('loginModal');
    if (!modal) return;
    
    document.getElementById('loginModalTitle').textContent = '个人中心';
    document.getElementById('loggedInForm').style.display = 'block';
    document.getElementById('loginForm').style.display = 'none';
    document.getElementById('setPasswordForm').style.display = 'none';
    document.getElementById('changePasswordForm').style.display = 'none';
    
    document.getElementById('infoUsername').textContent = currentUser.username || '-';
    document.getElementById('infoNickname').textContent = currentUser.nickname || '-';
    
    modal.classList.add('show');
}

function showLoginModal() {
    const modal = document.getElementById('loginModal');
    if (!modal) return;
    
    document.getElementById('loginModalTitle').textContent = '登录';
    document.getElementById('loggedInForm').style.display = 'none';
    document.getElementById('loginForm').style.display = 'block';
    document.getElementById('setPasswordForm').style.display = 'none';
    document.getElementById('changePasswordForm').style.display = 'none';
    
    if (!needPassword) {
        showSetPasswordForm();
    } else {
        document.getElementById('loginUsername').value = '';
        document.getElementById('loginPassword').value = '';
        document.getElementById('loginPassword').focus();
    }
    
    modal.classList.add('show');
}

function closeLoginModal() {
    const modal = document.getElementById('loginModal');
    if (modal) modal.classList.remove('show');
    if (pendingAuthRequests.length > 0) {
        const pendings = [...pendingAuthRequests];
        pendingAuthRequests = [];
        isLoginModalShowing = false;
        for (const pending of pendings) {
            if (pending.reject) {
                pending.reject(new Error('用户取消登录'));
            }
        }
    }
}

function showSetPasswordForm() {
    document.getElementById('loginModalTitle').textContent = '设置密码';
    document.getElementById('loggedInForm').style.display = 'none';
    document.getElementById('loginForm').style.display = 'none';
    document.getElementById('setPasswordForm').style.display = 'block';
    document.getElementById('changePasswordForm').style.display = 'none';
    document.getElementById('setUsername').value = 'admin';
    document.getElementById('setNickname').value = '';
    document.getElementById('newPassword').value = '';
    document.getElementById('confirmPassword').value = '';
    document.getElementById('newPassword').focus();
}

function showLoginForm() {
    document.getElementById('loginModalTitle').textContent = '登录';
    document.getElementById('loggedInForm').style.display = 'none';
    document.getElementById('loginForm').style.display = 'block';
    document.getElementById('setPasswordForm').style.display = 'none';
    document.getElementById('changePasswordForm').style.display = 'none';
    document.getElementById('loginUsername').focus();
}

function showLoggedInForm() {
    showLoggedInModal();
}

function showChangePasswordForm() {
    document.getElementById('loginModalTitle').textContent = '修改密码';
    document.getElementById('loggedInForm').style.display = 'none';
    document.getElementById('loginForm').style.display = 'none';
    document.getElementById('setPasswordForm').style.display = 'none';
    document.getElementById('changePasswordForm').style.display = 'block';
    document.getElementById('oldPasswordChange').value = '';
    document.getElementById('newPasswordChange').value = '';
    document.getElementById('confirmPasswordChange').value = '';
    document.getElementById('oldPasswordChange').focus();
}

async function doChangePassword() {
    const oldPassword = document.getElementById('oldPasswordChange').value;
    const newPassword = document.getElementById('newPasswordChange').value;
    const confirmPassword = document.getElementById('confirmPasswordChange').value;
    
    if (!oldPassword) {
        showNotification({ type: 'warning', message: '请输入原密码' });
        return;
    }
    
    if (!newPassword || newPassword.length < 4) {
        showNotification({ type: 'warning', message: '新密码长度不能少于4位' });
        return;
    }
    
    if (newPassword !== confirmPassword) {
        showNotification({ type: 'warning', message: '两次输入的新密码不一致' });
        return;
    }
    
    try {
        const result = await apiRequest('/api/user/set-password', 'POST', {
            oldPassword,
            newPassword
        });
        if (result.success) {
            showNotification({ type: 'success', message: '密码修改成功' });
            showLoggedInForm();
        } else {
            showNotification({ type: 'error', message: result.error || '修改失败' });
        }
    } catch (error) {
        if (error.message !== '未登录或登录已过期') {
            showNotification({ type: 'error', message: '修改失败' });
        }
    }
}

async function doLogin() {
    const username = document.getElementById('loginUsername').value.trim();
    const password = document.getElementById('loginPassword').value;
    
    if (!username || !password) {
        showNotification({ type: 'warning', message: '请输入用户名和密码' });
        return;
    }
    
    try {
        const result = await apiRequest('/api/user/login', 'POST', { username, password });
        if (result.success) {
            authToken = result.token;
            localStorage.setItem('authToken', authToken);
            currentUser = {
                username: result.username,
                nickname: result.nickname
            };
            updateUserCardUI();
            showNotification({ type: 'success', message: '登录成功' });
            
            const pendings = [...pendingAuthRequests];
            pendingAuthRequests = [];
            isLoginModalShowing = false;
            
            if (pendings.length > 0) {
                closeLoginModal();
                for (const pending of pendings) {
                    (async () => {
                        try {
                            if (!pending.url) {
                                pending.resolve();
                            } else {
                                const newOptions = {
                                    ...pending.options,
                                    headers: {
                                        ...pending.options.headers,
                                        'Authorization': 'Bearer ' + authToken
                                    }
                                };
                                const resp = await originalFetch(pending.url, newOptions);
                                pending.resolve(resp);
                            }
                        } catch (err) {
                            pending.reject(err);
                        }
                    })();
                }
            } else {
                closeLoginModal();
            }
        } else {
            showNotification({ type: 'error', message: result.error || '登录失败' });
        }
    } catch (error) {
        if (error.message !== '未登录或登录已过期') {
            showNotification({ type: 'error', message: '登录失败' });
        }
    }
}

async function doSetPassword() {
    const username = document.getElementById('setUsername').value.trim() || 'admin';
    const nickname = document.getElementById('setNickname').value.trim();
    const newPassword = document.getElementById('newPassword').value;
    const confirmPassword = document.getElementById('confirmPassword').value;
    
    if (!newPassword || newPassword.length < 4) {
        showNotification({ type: 'warning', message: '密码长度不能少于4位' });
        return;
    }
    
    if (newPassword !== confirmPassword) {
        showNotification({ type: 'warning', message: '两次输入的密码不一致' });
        return;
    }
    
    try {
        const result = await apiRequest('/api/user/set-password', 'POST', {
            username,
            nickname,
            newPassword
        });
        if (result.success) {
            showNotification({ type: 'success', message: '密码设置成功，请登录' });
            showLoginForm();
            document.getElementById('loginUsername').value = username;
            needPassword = true;
        } else {
            showNotification({ type: 'error', message: result.error || '设置失败' });
        }
    } catch (error) {
        showNotification({ type: 'error', message: '设置失败' });
    }
}

async function doLogout() {
    try {
        await apiRequest('/api/user/logout', 'POST');
    } catch (error) {
        // 忽略错误
    }
    authToken = null;
    localStorage.removeItem('authToken');
    currentUser = null;
    updateUserCardUI();
    showNotification({ type: 'success', message: '已退出登录' });
    closeLoginModal();
}

function confirmLogout() {
    closeLoginModal();
    const modal = document.getElementById('logoutModal');
    if (modal) modal.classList.add('show');
}

function closeLogoutModal() {
    const modal = document.getElementById('logoutModal');
    if (modal) modal.classList.remove('show');
}

// ========== 工具函数 ==========

function formatDuration(seconds) {
    if (!seconds || seconds === 0) return '--:--';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function updateNowPlaying(track) {
    const titleEl = document.getElementById('trackTitle');
    const artistEl = document.getElementById('trackArtist');
    const albumEl = document.getElementById('trackAlbum');
    
    if (track) {
        if (titleEl) titleEl.textContent = track.title;
        if (artistEl) artistEl.textContent = track.artist || '-';
        if (albumEl) albumEl.textContent = track.album || '-';
        // 更新下载按钮显示
        updateDownloadButton(track);
    } else {
        if (titleEl) titleEl.textContent = '未播放';
        if (artistEl) artistEl.textContent = '-';
        if (albumEl) albumEl.textContent = '-';
        // 隐藏下载按钮
        const downloadBtn = document.getElementById('downloadBtn');
        if (downloadBtn) downloadBtn.style.display = 'none';
    }
}

function updatePlayPauseButton() {
    const btn = document.getElementById('playPauseBtn');
    const icon = btn.querySelector('i');
    if (icon) {
        icon.className = isPlaying ? 'fas fa-pause' : 'fas fa-play';
    }
}

// 更新播放进度 UI（仅更新界面，不请求服务端）
function updateProgressUI(currentTime, duration) {
    if (!duration || duration <= 0) return;
    
    const percent = (currentTime / duration) * 100;
    currentDuration = duration;
    
    const progressBar = document.getElementById('progressBar');
    const currentTimeEl = document.getElementById('currentTime');
    const durationEl = document.getElementById('duration');
    
    if (progressBar) progressBar.style.width = `${percent}%`;
    if (currentTimeEl) currentTimeEl.textContent = formatDuration(currentTime);
    if (durationEl) durationEl.textContent = formatDuration(duration);
}

let onlineCacheComplete = false;

// 更新缓冲进度
function updateBufferProgress() {
    if (playOutput !== 'client') return;
    if (!clientAudio || !clientAudio.duration) return;

    const bufferEl = document.getElementById('bufferProgress');
    if (!bufferEl) return;

    try {
        if (clientAudio.buffered && clientAudio.buffered.length > 0) {
            const bufferedEnd = clientAudio.buffered.end(clientAudio.buffered.length - 1);
            const percent = (bufferedEnd / clientAudio.duration) * 100;
            bufferEl.style.width = `${Math.min(100, Math.max(0, percent))}%`;

            if (percent >= 99 && !onlineCacheComplete) {
                onlineCacheComplete = true;
                const track = currentIndex >= 0 ? currentPlaylist[currentIndex] : null;
                if (track && track.isOnline) {
                    const downloadBtn = document.getElementById('downloadBtn');
                    if (downloadBtn) {
                        downloadBtn.style.display = 'flex';
                        downloadBtn.title = '下载当前歌曲（已缓存）';
                    }
                }
            }
        }
    } catch (e) {
        // 忽略错误
    }
}

// 清除缓冲进度显示
function clearBufferProgress() {
    const bufferEl = document.getElementById('bufferProgress');
    if (bufferEl) {
        bufferEl.style.width = '0%';
    }
    onlineCacheComplete = false;
}

// 获取歌曲的 songId
function getSongId(track) {
    if (!track) return null;
    if (track.songId) return track.songId;
    if (track.songInfo && track.songInfo.songId) return track.songInfo.songId;
    if (track.path && track.path.startsWith('online://')) {
        const parts = track.path.split('/');
        if (parts.length >= 3) return parts[2];
    }
    return null;
}

// 更新下载按钮显示状态
async function updateDownloadButton(track) {
    const downloadBtn = document.getElementById('downloadBtn');
    if (!downloadBtn) return;

    if (!track) {
        downloadBtn.style.display = 'none';
        return;
    }

    // 本地文件：直接显示下载按钮
    if (!track.isOnline) {
        downloadBtn.style.display = 'flex';
        downloadBtn.title = '下载当前歌曲';
        return;
    }

    // 在线音乐：服务端播放直接显示，客户端播放需等待缓存完毕
    if (playOutput === 'server' || onlineCacheComplete) {
        downloadBtn.style.display = 'flex';
        downloadBtn.title = '下载当前歌曲';
    } else {
        downloadBtn.style.display = 'none';
    }
}

// 下载当前播放的歌曲
async function downloadCurrentTrack() {
    if (currentIndex < 0) return;
    
    const track = currentPlaylist[currentIndex];
    if (!track) return;
    
    // 本地文件：使用 /api/download 接口
    if (!track.isOnline) {
        const filePath = encodeURIComponent(track.path);
        window.open(`/api/download?path=${filePath}`, '_blank');
        return;
    }
    
    // 在线音乐
    const songId = getSongId(track);
    if (track.source && songId) {
        const cacheKey = `${track.source}_${songId}`;
        try {
            // 先检查缓存是否存在
            const result = await apiRequest('/api/cache', 'GET');
            const cached = result.success && result.cacheList 
                ? result.cacheList.some(item => item.cacheKey === cacheKey) 
                : false;
            
            if (cached) {
                // 已缓存，从缓存下载
                window.open(`/api/cache/${encodeURIComponent(cacheKey)}/download`, '_blank');
            } else {
                // 未缓存，提示用户
                showInfo('歌曲正在缓存中，请稍候再试...');
            }
        } catch (e) {
            showError('下载失败: ' + e.message);
        }
    }
}

// 更新播放进度
function updateProgress() {
    // 没有播放歌曲时才停止更新
    if (currentIndex < 0) {
        stopProgressUpdate();
        return;
    }
    
    // 客户端模式下，进度由 HTML5 Audio 的 timeupdate 事件处理
    if (playOutput === 'client') {
        return;
    }
    
    // 从服务端获取最新进度和状态
    apiRequest('/api/status')
        .then(status => {
            // 同步播放状态（解决多客户端同步问题）
            syncPlaybackStatus(status);
            
            if (status.progress) {
                const { currentTime, duration, percent } = status.progress;
                currentDuration = duration;
                
                // 更新进度条
                const progressBar = document.getElementById('progressBar');
                const currentTimeEl = document.getElementById('currentTime');
                const durationEl = document.getElementById('duration');
                
                progressBar.style.width = `${percent}%`;
                currentTimeEl.textContent = formatDuration(currentTime);
                durationEl.textContent = formatDuration(duration);
                
                // 检查是否播放结束（进度 100% 且不是最后一首）
                if (percent >= 99 && currentIndex < currentPlaylist.length - 1) {
                    // 等待一小段时间确保播放完成
                    setTimeout(() => {
                        apiRequest('/api/status').then(latestStatus => {
                            if (latestStatus.progress && latestStatus.progress.percent >= 100) {
                                // 播放已结束，自动播放下一首
                                playNext();
                            }
                        });
                    }, 2000);
                }
            }
        })
        .catch(err => {
            console.error('获取进度失败:', err);
        });
}

// 同步播放状态（用于多客户端同步）
function syncPlaybackStatus(status) {
    // 客户端模式下，不同步服务端播放状态（客户端自己控制播放）
    if (playOutput === 'client') {
        // 仅同步播放模式
        if (status.playMode && status.playMode !== currentPlayMode) {
            currentPlayMode = status.playMode;
            updatePlayModeButton();
        }
        return;
    }
    
    if (status.current) {
        const songChanged = status.currentIndex !== currentIndex;
        
        if (songChanged || status.isPlaying !== isPlaying) {
            currentIndex = status.currentIndex;
            isPlaying = status.isPlaying;
            updateNowPlaying(status.current);
            updatePlayPauseButton();
            renderPlaylist();
            
            // 同步进度条（歌曲切换或状态变化时）
            if (status.progress) {
                const { currentTime, duration, percent } = status.progress;
                currentDuration = duration;
                
                const progressBar = document.getElementById('progressBar');
                const currentTimeEl = document.getElementById('currentTime');
                const durationEl = document.getElementById('duration');
                
                progressBar.style.width = `${percent}%`;
                currentTimeEl.textContent = formatDuration(currentTime);
                durationEl.textContent = formatDuration(duration);
            }
        }
        
        if (status.playMode && status.playMode !== currentPlayMode) {
            currentPlayMode = status.playMode;
            updatePlayModeButton();
        }
    } else if (currentIndex >= 0) {
        currentIndex = -1;
        isPlaying = false;
        updateNowPlaying(null);
        updatePlayPauseButton();
        renderPlaylist();
        stopProgressUpdate();
    }
    
    // 以下状态始终同步，不受播放状态影响
    // 同步音量
    if (status.volume !== undefined) {
        const slider = document.getElementById('volumeSlider');
        const valueEl = document.getElementById('volumeValue');
        if (slider.value !== status.volume.toString()) {
            slider.value = status.volume;
            valueEl.textContent = `${status.volume}%`;
        }
    }
    
    // 同步静音状态
    if (status.muted !== undefined) {
        currentMuted = status.muted;
        const volumeIcon = document.querySelector('.volume-icon');
        if (volumeIcon) {
            updateVolumeIcon(parseInt(document.getElementById('volumeSlider').value), status.muted);
        }
    }
    
    // 同步声卡设备
    if (status.audioDevice !== undefined) {
        const deviceItems = document.querySelectorAll('.audio-device-item');
        deviceItems.forEach(item => {
            if (item.dataset.deviceId === status.audioDevice) {
                item.classList.add('active');
            } else {
                item.classList.remove('active');
            }
        });
    }
}

// 开始进度更新
function startProgressUpdate() {
    stopProgressUpdate(); // 先停止之前的定时器
    updateProgress(); // 立即更新一次
    progressUpdateInterval = setInterval(updateProgress, 1000); // 每秒更新一次
}

// 停止进度更新
function stopProgressUpdate(progress) {
    if (progressUpdateInterval) {
        clearInterval(progressUpdateInterval);
        progressUpdateInterval = null;
    }
    
    const progressBar = document.getElementById('progressBar');
    const currentTimeEl = document.getElementById('currentTime');
    const durationEl = document.getElementById('duration');
    
    // 如果传入了进度参数，保留当前进度；否则重置
    if (progress) {
        progressBar.style.width = `${progress.percent}%`;
        currentTimeEl.textContent = formatDuration(progress.currentTime);
        durationEl.textContent = formatDuration(progress.duration);
    } else {
        progressBar.style.width = '0%';
        currentTimeEl.textContent = '0:00';
        durationEl.textContent = '0:00';
    }
}

// 启动状态同步（用于多客户端同步）
function startStatusSync() {
    stopStatusSync(); // 先停止之前的定时器
    syncStatusWithServer(); // 立即同步一次
    syncStatusInterval = setInterval(syncStatusWithServer, 3000); // 每3秒同步一次
}

// 停止状态同步
function stopStatusSync() {
    if (syncStatusInterval) {
        clearInterval(syncStatusInterval);
        syncStatusInterval = null;
    }
}

// 与服务端同步状态
async function syncStatusWithServer() {
    try {
        const status = await apiRequest('/api/status');
        syncPlaybackStatus(status);
    } catch (error) {
        console.error('状态同步失败:', error);
    }
}

function renderPlaylist() {
    const playlistEl = document.getElementById('playlist');
    const countEl = document.getElementById('playlistCount');
    
    console.log('=== 开始渲染播放列表 ===');
    console.log('playlistEl:', playlistEl);
    console.log('countEl:', countEl);
    console.log('currentPlaylist.length:', currentPlaylist.length);
    
    countEl.textContent = `(${currentPlaylist.length} 首)`;
    
    if (currentPlaylist.length === 0) {
        console.log('播放列表为空,显示空状态');
        playlistEl.innerHTML = `
            <div class="playlist-empty">
                <i class="fas fa-music"></i>
                <p>暂无音乐</p>
                <p class="empty-hint">请上传音乐文件到 music/ 目录</p>
            </div>
        `;
        return;
    }
    
    console.log('开始渲染', currentPlaylist.length, '首音乐');
    playlistEl.innerHTML = '';
    currentPlaylist.forEach((track, index) => {
        const item = document.createElement('div');
        item.className = 'playlist-item';
        item.dataset.index = index;
        if (index === currentIndex) {
            item.classList.add('active');
        }
        if (selectedPlaylistTracks.has(index)) {
            item.classList.add('selected');
        }
        
        // 生成来源标签
        const sourceBadge = track.isOnline 
            ? `<span class="playlist-item-source online" title="${track.sourceName || '在线音乐'}">
                <i class="fas fa-globe"></i> ${track.sourceName || '在线'}
               </span>`
            : `<span class="playlist-item-source local" title="本地音乐">
                <i class="fas fa-hard-drive"></i> 本地
               </span>`;
        
        item.innerHTML = `
            <div class="playlist-item-checkbox">
                <input type="checkbox" 
                       ${selectedPlaylistTracks.has(index) ? 'checked' : ''} 
                       data-index="${index}">
            </div>
            <div class="playlist-item-index">
                ${index === currentIndex && isPlaying ? '<i class="fas fa-play playing-icon"></i>' : index + 1}
            </div>
            <div class="playlist-item-title">${track.title}${sourceBadge}</div>
            <div class="playlist-item-artist">${track.artist || '-'}</div>
            <div class="playlist-item-duration">${formatDuration(track.duration)}</div>
            <div class="playlist-item-actions">
                <button class="playlist-action-btn playlist-play-btn" onclick="event.stopPropagation(); playTrack(${index})" title="播放">
                    <i class="fas fa-play"></i>
                </button>
                <button class="playlist-action-btn playlist-download-btn" onclick="event.stopPropagation(); downloadTrack(${index})" title="下载">
                    <i class="fas fa-download"></i>
                </button>
                <button class="playlist-action-btn playlist-delete-btn" onclick="event.stopPropagation(); deleteTrack(${index})" title="删除">
                    <i class="fas fa-trash"></i>
                </button>
                <button class="playlist-action-btn playlist-menu-btn" onclick="event.stopPropagation(); togglePlaylistMenu(${index}, event)" title="更多">
                    <i class="fas fa-ellipsis-v"></i>
                </button>
            </div>
        `;
        
        setupPlaylistItemEvents(item, index);
        playlistEl.appendChild(item);
    });
    
    updatePlaylistBatchBar();
    
    console.log('播放列表渲染完成');
    
    // 滚动定位到当前播放的歌曲
    if (currentIndex >= 0) {
        const activeItem = playlistEl.querySelector('.playlist-item.active');
        if (activeItem) {
            // 使用 requestAnimationFrame 确保 DOM 已渲染完成
            requestAnimationFrame(() => {
                // 计算滚动位置，只在播放列表容器内滚动
                const containerRect = playlistEl.getBoundingClientRect();
                const itemRect = activeItem.getBoundingClientRect();
                
                // 计算元素相对于容器的位置
                const itemTop = itemRect.top - containerRect.top + playlistEl.scrollTop;
                const itemBottom = itemTop + itemRect.height;
                const containerHeight = containerRect.height;
                
                // 如果元素在可视区域外，则滚动到可视区域
                if (itemTop < playlistEl.scrollTop || itemBottom > playlistEl.scrollTop + containerHeight) {
                    playlistEl.scrollTo({
                        top: itemTop - containerHeight / 2 + itemRect.height / 2,
                        behavior: 'smooth'
                    });
                }
            });
        }
    }
}

// 更新状态信息（兼容旧代码）
function updateStatus(message) {
    // 状态栏已移除，消息通过 toast 提示显示
}

async function setMusicDir() {
    try {
        await requireLogin();
    } catch (e) {
        return;
    }
    const dir = document.getElementById('musicDirInput').value.trim();
    if (!dir) {
        updateStatus('❌ 请输入音乐文件夹路径');
        return;
    }
    
    try {
        updateStatus('🔍 正在扫描音乐文件...');
        const result = await apiRequest('/api/set-music-dir', 'POST', { dir });
        
        if (result.success) {
            currentPlaylist = result.playlist;
            currentIndex = -1;
            isPlaying = false;
            
            document.getElementById('currentDir').innerHTML = 
                `<span class="success">✅ 已加载 ${result.count} 首音乐</span>`;
            
            updateNowPlaying(null);
            updatePlayPauseButton();
            renderPlaylist();
            updateStatus(`✅ 已加载 ${result.count} 首音乐`);
        } else {
            throw new Error(result.error || '设置失败');
        }
    } catch (error) {
        document.getElementById('currentDir').innerHTML = 
            `<span class="error">❌ ${error.message}</span>`;
        updateStatus('❌ 设置音乐文件夹失败');
    }
}

// ==================== 客户端播放功能 ====================

// 初始化客户端 Audio 元素
function initClientAudio() {
    if (!clientAudio) {
        clientAudio = new Audio();
        clientAudio.volume = currentVolume / 100;
        clientAudio.muted = currentMuted;
        
        // 监听播放事件
        clientAudio.addEventListener('play', () => {
            isPlaying = true;
            updatePlayPauseButton();
            startProgressUpdate();
            // 同步状态到服务器
            syncClientPlaybackState('playing', clientAudio.currentTime, clientAudio.duration);
        });
        
        clientAudio.addEventListener('pause', () => {
            isPlaying = false;
            updatePlayPauseButton();
            stopProgressUpdate(clientAudio.currentTime);
            syncClientPlaybackState('paused', clientAudio.currentTime, clientAudio.duration);
        });
        
        clientAudio.addEventListener('ended', () => {
            isPlaying = false;
            updatePlayPauseButton();
            stopProgressUpdate();
            syncClientPlaybackState('ended', 0, clientAudio.duration);
            // 触发自动播放下一首
            handleClientPlaybackEnded();
        });
        
        clientAudio.addEventListener('timeupdate', () => {
            if (isPlaying && progressUpdateInterval) {
                // 使用客户端实际进度更新 UI
                updateProgressUI(clientAudio.currentTime, clientAudio.duration);
            }
        });
        
        // 缓冲进度更新
        clientAudio.addEventListener('progress', () => {
            updateBufferProgress();
        });
        
        clientAudio.addEventListener('error', (e) => {
            if (isStoppingClient) {
                isStoppingClient = false;
                return;
            }
            console.error('客户端播放错误:', e);
            showError('音频播放失败');
        });
    }
}

// 同步客户端播放状态到服务器
async function syncClientPlaybackState(state, currentTime, duration) {
    try {
        await apiRequest('/api/client-playback-state', 'POST', {
            state,
            currentTime,
            duration
        });
    } catch (error) {
        console.error('同步播放状态失败:', error);
    }
}

// 处理客户端播放结束后的自动播放逻辑
async function handleClientPlaybackEnded() {
    if (currentPlayMode === 'loop') {
        // 单曲循环：重新播放当前歌曲
        playTrack(currentIndex);
    } else if (currentPlayMode === 'single') {
        // 单曲播放：停止
        currentIndex = -1;
        updateNowPlaying(null);
        renderPlaylist();
    } else if (currentPlayMode === 'random') {
        // 随机播放
        if (currentPlaylist.length > 1) {
            let randomIndex;
            do {
                randomIndex = Math.floor(Math.random() * currentPlaylist.length);
            } while (randomIndex === currentIndex && currentPlaylist.length > 1);
            playTrack(randomIndex);
        }
    } else {
        // 顺序播放
        if (currentIndex < currentPlaylist.length - 1) {
            playTrack(currentIndex + 1);
        }
    }
}

// 客户端播放指定索引的歌曲
async function playTrackClient(index) {
    if (!clientAudio) {
        initClientAudio();
    }
    
    const track = currentPlaylist[index];
    currentIndex = index;
    
    // 停止当前播放
    clientAudio.pause();
    clientAudio.currentTime = 0;
    
    // 设置音频源
    clientAudio.src = `/api/stream/${index}`;
    
    // 更新 UI
    updateNowPlaying(track);
    renderPlaylist();
    
    // 开始播放
    try {
        await clientAudio.play();
        isPlaying = true;
        updatePlayPauseButton();
        startProgressUpdate();
    } catch (error) {
        console.error('客户端播放失败:', error);
        showError('播放失败');
    }
}

// 客户端暂停/继续
function togglePlayClient() {
    if (!clientAudio) return;
    
    if (isPlaying) {
        clientAudio.pause();
    } else {
        if (currentIndex === -1 && currentPlaylist.length > 0) {
            playTrackClient(0);
        } else {
            clientAudio.play();
        }
    }
}

// 客户端停止
function stopClient() {
    if (clientAudio) {
        isStoppingClient = true;
        clientAudio.pause();
        clientAudio.currentTime = 0;
        clientAudio.src = '';
    }
    currentIndex = -1;
    isPlaying = false;
    clearBufferProgress();
    updateNowPlaying(null);
    updatePlayPauseButton();
    renderPlaylist();
    stopProgressUpdate();
}

// 客户端音量控制
function changeVolumeClient(value) {
    currentVolume = parseInt(value);
    if (clientAudio) {
        clientAudio.volume = currentVolume / 100;
    }
    updateVolumeDisplay();
}

// 客户端静音切换
function toggleMuteClient() {
    currentMuted = !currentMuted;
    if (clientAudio) {
        clientAudio.muted = currentMuted;
    }
    updateMuteButton();
    updateVolumeDisplay();
}

// 客户端 seek
function seekClient(progress) {
    if (clientAudio && clientAudio.duration) {
        clientAudio.currentTime = progress * clientAudio.duration;
    }
}

// 切换播放输出方式
// 快捷切换播放输出方式（播放栏按钮）
async function togglePlayOutput() {
    const newOutput = playOutput === 'server' ? 'client' : 'server';
    await changePlayOutput(newOutput);
    updateOutputSwitchButton();
}

// 更新播放输出切换按钮的状态
function updateOutputSwitchButton() {
    const icon = document.getElementById('outputSwitchIcon');
    const text = document.getElementById('outputSwitchText');
    const btn = document.getElementById('outputSwitchBtn');
    
    if (!icon || !text || !btn) return;
    
    if (playOutput === 'server') {
        icon.className = 'fas fa-server';
        text.textContent = '服务器';
        btn.className = 'output-switch-btn active-server';
        btn.title = '当前：服务器声卡，点击切换到客户端浏览器';
    } else {
        icon.className = 'fas fa-laptop';
        text.textContent = '客户端';
        btn.className = 'output-switch-btn active-client';
        btn.title = '当前：客户端浏览器，点击切换到服务器声卡';
    }
}

async function changePlayOutput(output) {
    const originalOutput = playOutput;
    const radioButtons = document.querySelectorAll('input[name="playOutput"]');
    
    try {
        await requireLogin();
    } catch (e) {
        radioButtons.forEach(radio => {
            radio.checked = (radio.value === originalOutput);
        });
        return;
    }
    try {
        const result = await apiRequest('/api/play-output', 'POST', { output });
        if (result.success) {
            const oldOutput = playOutput;
            playOutput = output;
            console.log(`📱 播放输出已切换为：${output === 'server' ? '服务器声卡' : '客户端浏览器'}`);
            
            // 更新播放管理页面的单选按钮
            radioButtons.forEach(radio => {
                radio.checked = (radio.value === output);
            });
            
            // 更新播放栏快捷切换按钮
            updateOutputSwitchButton();
            
            // 如果当前正在播放，需要停止旧模式并重新以新模式播放
            if (isPlaying && currentIndex >= 0) {
                // 停止旧模式的播放
                if (oldOutput === 'client') {
                    // 旧模式是客户端，停止客户端音频
                    if (clientAudio) {
                        isStoppingClient = true;
                        clientAudio.pause();
                        clientAudio.src = '';
                    }
                } else {
                    // 旧模式是服务器，停止服务器播放
                    await apiRequest('/api/stop');
                }
                
                // 重新播放
                const currentIndex_saved = currentIndex;
                currentIndex = -1;
                isPlaying = false;
                stopProgressUpdate();
                
                // 延迟一下再播放，确保状态切换完成
                setTimeout(() => {
                    playTrack(currentIndex_saved);
                }, 200);
            }
            
            showNotification({
                type: 'info',
                message: `播放输出：${output === 'server' ? '服务器声卡' : '客户端浏览器'}`,
                duration: 2000
            });
        }
    } catch (error) {
        console.error('切换播放输出失败:', error);
        showError('切换失败');
        radioButtons.forEach(radio => {
            radio.checked = (radio.value === originalOutput);
        });
    }
}

// ==================== 缓存管理功能 ====================

// 格式化文件大小
function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + ' MB';
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

// 格式化日期
function formatCacheDate(timestamp) {
    if (!timestamp) return '未知';
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    
    if (diffMins < 1) return '刚刚';
    if (diffMins < 60) return `${diffMins}分钟前`;
    if (diffHours < 24) return `${diffHours}小时前`;
    if (diffDays < 7) return `${diffDays}天前`;
    return date.toLocaleDateString();
}

// 获取音源名称
function getSourceName(source) {
    const sourceMap = {
        'kw': '酷我',
        'kg': '酷狗',
        'tx': 'QQ',
        'wy': '网易云',
        'mg': '咪咕'
    };
    return sourceMap[source] || source;
}

// 刷新缓存列表
async function refreshCacheList() {
    try {
        const result = await apiRequest('/api/cache');
        if (result.success) {
            document.getElementById('cacheCount').textContent = result.count || 0;
            document.getElementById('cacheSize').textContent = formatFileSize(result.totalSize || 0);
            
            const cacheListEl = document.getElementById('cacheList');
            if (!result.cacheList || result.cacheList.length === 0) {
                cacheListEl.innerHTML = '<p class="empty-state">暂无缓存</p>';
                return;
            }
            
            cacheListEl.innerHTML = result.cacheList.map(item => `
                <div class="cache-item">
                    <div class="cache-item-info">
                        <div class="cache-item-title">${escapeHtml(item.title || '未知歌曲')}</div>
                        <div class="cache-item-meta">
                            <span class="cache-item-source">${getSourceName(item.source)}</span>
                            <span>${escapeHtml(item.artist || '未知艺术家')}</span>
                            <span>${formatFileSize(item.size || 0)}</span>
                            <span>${formatCacheDate(item.cachedAt)}</span>
                        </div>
                    </div>
                    <button class="cache-item-delete" onclick="deleteCacheItem('${item.cacheKey}', '${escapeHtml(item.title || '未知歌曲')}')" title="删除此缓存">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            `).join('');
        }
    } catch (error) {
        console.error('刷新缓存列表失败:', error);
    }
}

// 删除单个缓存
let pendingDeleteCacheKey = '';

async function deleteCacheItem(cacheKey, title) {
    try {
        await requireLogin();
    } catch (e) {
        return;
    }
    pendingDeleteCacheKey = cacheKey;
    document.getElementById('deleteCacheTitle').textContent = title || '未知歌曲';
    const modal = document.getElementById('deleteCacheModal');
    modal.classList.add('show');
    document.body.style.overflow = 'hidden';
}

function closeDeleteCacheModal() {
    const modal = document.getElementById('deleteCacheModal');
    modal.classList.remove('show');
    document.body.style.overflow = '';
    pendingDeleteCacheKey = '';
}

async function confirmDeleteCache() {
    if (!pendingDeleteCacheKey) return;
    
    try {
        const result = await apiRequest(`/api/cache/${encodeURIComponent(pendingDeleteCacheKey)}`, 'DELETE');
        if (result.success) {
            showNotification({
                type: 'success',
                message: '缓存已删除',
                duration: 2000
            });
            refreshCacheList();
            closeDeleteCacheModal();
        } else {
            showError('删除失败: ' + (result.error || '未知错误'));
        }
    } catch (error) {
        showError('删除失败: ' + error.message);
    }
}

// 清空所有缓存
async function clearAllCache() {
    try {
        await requireLogin();
    } catch (e) {
        return;
    }
    const modal = document.getElementById('clearCacheModal');
    modal.classList.add('show');
    document.body.style.overflow = 'hidden';
}

function closeClearCacheModal() {
    const modal = document.getElementById('clearCacheModal');
    modal.classList.remove('show');
    document.body.style.overflow = '';
}

async function confirmClearCache() {
    try {
        const result = await apiRequest('/api/cache', 'DELETE');
        if (result.success) {
            showNotification({
                type: 'success',
                message: '所有缓存已清空',
                duration: 2000
            });
            refreshCacheList();
            closeClearCacheModal();
        } else {
            showError('清空失败: ' + (result.error || '未知错误'));
        }
    } catch (error) {
        showError('清空失败: ' + error.message);
    }
}

// 缓存大小限制相关
let currentCacheLimit = 0;

function formatCacheLimit(sizeMB) {
    if (sizeMB <= 0) return '不限制';
    if (sizeMB >= 1024) return (sizeMB / 1024).toFixed(sizeMB % 1024 === 0 ? 0 : 1) + ' GB';
    return sizeMB + ' MB';
}

async function loadCacheLimit() {
    try {
        const result = await apiRequest('/api/cache-limit', 'GET');
        if (result.success) {
            currentCacheLimit = result.cacheLimitSize || 0;
            updateCacheLimitUI();
        }
    } catch (error) {
        console.error('加载缓存限制失败:', error);
    }
}

function updateCacheLimitUI() {
    const hintEl = document.getElementById('cacheLimitHint');
    const customEl = document.getElementById('cacheLimitCustom');
    const inputEl = document.getElementById('cacheLimitInput');
    
    if (hintEl) {
        hintEl.textContent = formatCacheLimit(currentCacheLimit);
    }
    
    // 更新单选按钮
    const radios = document.querySelectorAll('input[name="cacheLimit"]');
    let matched = false;
    radios.forEach(radio => {
        if (radio.value === 'custom') return;
        const val = parseInt(radio.value, 10);
        if (val === currentCacheLimit) {
            radio.checked = true;
            matched = true;
        }
    });
    
    if (!matched && currentCacheLimit > 0) {
        // 自定义值
        const customRadio = document.querySelector('input[name="cacheLimit"][value="custom"]');
        if (customRadio) customRadio.checked = true;
        if (customEl) customEl.style.display = 'flex';
        if (inputEl) inputEl.value = currentCacheLimit;
    } else {
        if (customEl) customEl.style.display = 'none';
    }
}

function setCacheLimitPreset(sizeMB) {
    const customEl = document.getElementById('cacheLimitCustom');
    if (customEl) customEl.style.display = 'none';
    saveCacheLimit(sizeMB);
}

function showCustomCacheLimit() {
    const customEl = document.getElementById('cacheLimitCustom');
    if (customEl) customEl.style.display = 'flex';
    const inputEl = document.getElementById('cacheLimitInput');
    if (inputEl) inputEl.focus();
}

async function saveCacheLimit(customValue) {
    try {
        await requireLogin();
    } catch (e) {
        return;
    }
    let limit;
    if (customValue !== undefined) {
        limit = customValue;
    } else {
        const inputEl = document.getElementById('cacheLimitInput');
        limit = parseInt(inputEl.value, 10);
        if (isNaN(limit) || limit < 0) {
            showError('请输入有效的缓存大小');
            return;
        }
    }
    
    try {
        const result = await apiRequest('/api/cache-limit', 'POST', { cacheLimitSize: limit });
        if (result.success) {
            currentCacheLimit = result.cacheLimitSize;
            updateCacheLimitUI();
            
            let msg = '缓存限制已设置为 ' + formatCacheLimit(currentCacheLimit);
            if (result.cleaned && result.removedCount > 0) {
                msg += `，已自动清理 ${result.removedCount} 个旧缓存`;
            }
            showNotification({
                type: 'success',
                message: msg,
                duration: 2500
            });
            
            // 刷新缓存列表
            refreshCacheList();
        } else {
            showError('设置失败: ' + (result.error || '未知错误'));
        }
    } catch (error) {
        showError('设置失败: ' + error.message);
    }
}

// ==================== 结束客户端播放功能 ====================

async function playTrack(index) {
    if (index < 0 || index >= currentPlaylist.length) return;
    
    const track = currentPlaylist[index];
    
    // 清除之前的缓冲进度
    clearBufferProgress();
    
    if (currentMuted && playOutput === 'server') {
        showInfo('⚠️ 当前处于静音状态，将无法听到声音');
    }
    
    try {
        if (playOutput === 'client') {
            await playTrackClient(index);
        } else {
            const result = await apiRequest(`/api/play/${index}`);
            
            if (result.success) {
                currentIndex = index;
                isPlaying = true;
                updateNowPlaying(result.current);
                updatePlayPauseButton();
                renderPlaylist();
                startProgressUpdate();
            } else {
                showError('播放失败');
            }
        }
    } catch (error) {
        console.error('播放失败:', error);
        showError('播放失败');
    }
}

async function togglePlay() {
    if (currentIndex === -1) {
        if (currentPlaylist.length > 0) {
            playTrack(0);
        } else {
            showInfo('请先上传音乐文件');
        }
        return;
    }
    
    try {
        if (playOutput === 'client') {
            togglePlayClient();
        } else {
            if (isPlaying) {
                await apiRequest('/api/pause');
                
                // 立即获取最新状态（包括当前播放位置）
                const status = await apiRequest('/api/status');
                
                // 更新状态
                isPlaying = false;
                updatePlayPauseButton();
                // 传入进度参数，保留当前进度
                stopProgressUpdate(status.progress);
            } else {
                if (currentMuted) {
                    showInfo('⚠️ 当前处于静音状态，将无法听到声音');
                }
                await apiRequest('/api/resume');
                isPlaying = true;
                startProgressUpdate();
                updateNowPlaying(currentPlaylist[currentIndex]);
            }
            updatePlayPauseButton();
        }
    } catch (error) {
        console.error('操作失败:', error);
        showError('操作失败');
    }
}

async function stop() {
    try {
        if (playOutput === 'client') {
            stopClient();
        } else {
            await apiRequest('/api/stop');
            currentIndex = -1;
            isPlaying = false;
            clearBufferProgress();
            updateNowPlaying(null);
            updatePlayPauseButton();
            renderPlaylist();
            stopProgressUpdate();
        }
    } catch (error) {
        console.error('停止失败:', error);
        showError('停止失败');
    }
}

async function playNext() {
    if (playOutput === 'client') {
        if (currentPlaylist.length === 0 || currentIndex === -1) {
            showError('没有可播放的歌曲');
            return;
        }
        if (currentPlayMode === 'random') {
            if (currentPlaylist.length > 1) {
                let randomIndex;
                do {
                    randomIndex = Math.floor(Math.random() * currentPlaylist.length);
                } while (randomIndex === currentIndex && currentPlaylist.length > 1);
                playTrack(randomIndex);
            }
        } else {
            if (currentIndex < currentPlaylist.length - 1) {
                playTrack(currentIndex + 1);
            } else {
                showError('已经是最后一首');
            }
        }
        return;
    }

    try {
        const result = await apiRequest('/api/next');
        if (result.success) {
            currentIndex = result.index;
            isPlaying = result.isPlaying;
            updateNowPlaying(result.current);
            updatePlayPauseButton();
            renderPlaylist();
            startProgressUpdate();
        } else {
            showError('已经是最后一首');
        }
    } catch (error) {
        console.error('下一首失败:', error);
        showError('下一首失败');
    }
}

async function playPrevious() {
    if (playOutput === 'client') {
        if (currentPlaylist.length === 0 || currentIndex === -1) {
            showError('没有可播放的歌曲');
            return;
        }
        if (currentPlayMode === 'random') {
            if (currentPlaylist.length > 1) {
                let randomIndex;
                do {
                    randomIndex = Math.floor(Math.random() * currentPlaylist.length);
                } while (randomIndex === currentIndex && currentPlaylist.length > 1);
                playTrack(randomIndex);
            }
        } else {
            if (currentIndex > 0) {
                playTrack(currentIndex - 1);
            } else {
                showError('已经是第一首');
            }
        }
        return;
    }

    try {
        const result = await apiRequest('/api/previous');
        if (result.success) {
            currentIndex = result.index;
            isPlaying = result.isPlaying;
            updateNowPlaying(result.current);
            updatePlayPauseButton();
            renderPlaylist();
            startProgressUpdate();
        } else {
            showError('已经是第一首');
        }
    } catch (error) {
        console.error('上一首失败:', error);
        showError('上一首失败');
    }
}

// 添加 prevTrack 和 nextTrack 别名
const prevTrack = playPrevious;
const nextTrack = playNext;

async function togglePlayMode() {
    const modes = ['sequence', 'random', 'single', 'loop'];
    const currentIndex_mode = modes.indexOf(currentPlayMode);
    const nextMode = modes[(currentIndex_mode + 1) % modes.length];
    
    try {
        const result = await apiRequest('/api/play-mode', 'POST', { mode: nextMode });
        if (result.success) {
            currentPlayMode = nextMode;
            updatePlayModeButton();
            showNotification({
                type: 'info',
                message: `播放模式：${playModeTitles[nextMode]}`,
                duration: 2000
            });
        }
    } catch (error) {
        console.error('切换播放模式失败:', error);
    }
}

function updatePlayModeButton() {
    const btn = document.getElementById('playModeBtn');
    if (btn) {
        const icon = btn.querySelector('i');
        if (icon) {
            icon.className = playModeIcons[currentPlayMode];
        }
        btn.title = playModeTitles[currentPlayMode];
    }
}

function downloadTrack(indexOrPath) {
    let filename;
    let downloadUrl;
    
    if (typeof indexOrPath === 'number') {
        // 通过播放列表索引下载
        if (indexOrPath < 0 || indexOrPath >= currentPlaylist.length) return;
        
        const track = currentPlaylist[indexOrPath];
        filename = track.filename || track.title;
        downloadUrl = `/api/download/${indexOrPath}`;
    } else {
        // 通过文件路径下载
        filename = indexOrPath.split('\\').pop() || indexOrPath.split('/').pop();
        downloadUrl = `/api/download?path=${encodeURIComponent(indexOrPath)}`;
    }
    
    showNotification({
        type: 'info',
        message: `正在下载：${filename}`,
        duration: 2000
    });
    
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function togglePlaylistMenu(index, event) {
    event.stopPropagation();
    
    const existingMenu = document.querySelector('.playlist-context-menu');
    if (existingMenu) {
        const existingIndex = existingMenu.dataset.menuIndex;
        existingMenu.remove();
        // 如果点击的是同一个菜单按钮，则只关闭
        if (existingIndex == index) return;
    }
    
    const track = currentPlaylist[index];
    const menu = document.createElement('div');
    menu.className = 'playlist-context-menu';
    menu.dataset.menuIndex = index;
    menu.innerHTML = `
        <div class="playlist-menu-item" onclick="event.stopPropagation(); playTrack(${index}); closePlaylistMenu();">
            <i class="fas fa-play"></i>
            <span>播放</span>
        </div>
        <div class="playlist-menu-item" onclick="event.stopPropagation(); downloadTrack(${index}); closePlaylistMenu();">
            <i class="fas fa-download"></i>
            <span>下载</span>
        </div>
        <div class="playlist-menu-item playlist-menu-item-danger" onclick="event.stopPropagation(); deleteTrack(${index}); closePlaylistMenu();">
            <i class="fas fa-trash"></i>
            <span>删除</span>
        </div>
    `;
    
    const rect = event.target.getBoundingClientRect();
    menu.style.top = `${rect.bottom + window.scrollY}px`;
    menu.style.left = `${rect.left + window.scrollX - 100}px`;
    
    document.body.appendChild(menu);
    
    setTimeout(() => {
        document.addEventListener('click', closePlaylistMenu, { once: true });
    }, 0);
}

function closePlaylistMenu() {
    const menu = document.querySelector('.playlist-context-menu');
    if (menu) {
        menu.remove();
    }
}

let selectedFiles = []; // 存储选中的文件

// ==================== 通知系统 ====================
function showNotification(options) {
    if (options.type === 'error' && options.message && 
        typeof options.message === 'string' && options.message.includes('用户取消登录')) {
        return;
    }
    
    const container = document.getElementById('notificationContainer');
    
    const notification = document.createElement('div');
    notification.className = `notification ${options.type || 'info'}`;
    
    const icons = {
        success: '✓',
        error: '✗',
        info: 'ℹ',
        warning: '⚠'
    };
    
    const icon = icons[options.type] || icons.info;
    
    // 支持标题的通知
    let content = '';
    if (options.title) {
        content = `
            <div class="notification-content">
                <div class="notification-icon">${icon}</div>
                <div class="notification-body">
                    <div class="notification-title">${options.title}</div>
                    <div class="notification-message">${options.message}</div>
                </div>
            </div>
        `;
    } else {
        content = `
            <div class="notification-content">
                <div class="notification-icon">${icon}</div>
                <div class="notification-message">${options.message}</div>
            </div>
        `;
    }
    
    notification.innerHTML = `
        ${content}
        <button class="notification-close" onclick="closeNotification(this.parentNode)">×</button>
    `;
    
    container.appendChild(notification);
    
    // 自动关闭时间（默认 3 秒）
    const duration = options.duration || 3000;
    
    if (duration > 0) {
        setTimeout(() => {
            if (notification.parentNode) {
                closeNotification(notification);
            }
        }, duration);
    }
    
    return notification;
}

function closeNotification(notificationEl) {
    if (!notificationEl || !notificationEl.parentNode) return;
    
    notificationEl.style.animation = 'slideOutRight 0.3s forwards';
    
    setTimeout(() => {
        if (notificationEl.parentNode) {
            notificationEl.parentNode.removeChild(notificationEl);
        }
    }, 300);
}

window.closeNotification = closeNotification;

// 便捷函数
function showSuccess(message, duration) {
    return showNotification({ type: 'success', message, duration });
}

function showError(message, duration) {
    if (typeof message === 'string' && message.includes('用户取消登录')) {
        return;
    }
    return showNotification({ type: 'error', message, duration });
}

function showInfo(message, duration) {
    return showNotification({ type: 'info', message, duration });
}

function showWarning(message, duration) {
    return showNotification({ type: 'warning', message, duration });
}

// 模态框相关函数
async function openUploadModal() {
    try {
        await requireLogin();
    } catch (e) {
        return;
    }
    // 清空之前选择的文件
    selectedFiles = [];
    updateFileList();
    document.getElementById('musicFileInput').value = '';
    
    const modal = document.getElementById('uploadModal');
    modal.classList.add('show');
    document.body.style.overflow = 'hidden'; // 防止背景滚动
    
    // 更新上传目标路径显示
    const uploadTargetPath = document.getElementById('uploadTargetPath');
    if (currentFolderPath) {
        uploadTargetPath.textContent = currentFolderPath;
    } else {
        uploadTargetPath.textContent = '根目录';
    }
}

function closeUploadModal() {
    const modal = document.getElementById('uploadModal');
    modal.classList.remove('show');
    document.body.style.overflow = ''; // 恢复滚动
    selectedFiles = [];
    updateFileList();
    document.getElementById('musicFileInput').value = '';
}

// 一键整理功能
let isOrganizing = false;

async function openOrganizeModal() {
    try {
        await requireLogin();
    } catch (e) {
        return;
    }
    const modal = document.getElementById('organizeModal');
    modal.classList.add('show');
    document.body.style.overflow = 'hidden';
}

function closeOrganizeModal() {
    const modal = document.getElementById('organizeModal');
    modal.classList.remove('show');
    document.body.style.overflow = '';
}

// 刮削功能
let scrapeTargetPath = '';

async function openScrapeModal(filePath) {
    try {
        await requireLogin();
    } catch (e) {
        return;
    }
    const modal = document.getElementById('scrapeModal');
    modal.classList.add('show');
    document.body.style.overflow = 'hidden';
    
    scrapeTargetPath = filePath || '';
    
    // 重置进度
    document.getElementById('scrapeProgress').style.display = 'none';
    document.getElementById('scrapeProgressBar').style.width = '0%';
    document.getElementById('scrapeProgressText').textContent = '';
    document.getElementById('scrapeResults').innerHTML = '';
    
    // 设置按钮状态
    const btn = document.getElementById('btnConfirmScrape');
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-cloud-download-alt"></i> 开始刮削';
    
    // 如果有文件路径，默认选单个文件
    if (filePath) {
        document.querySelector('input[name="scrapeType"][value="single"]').checked = true;
    }
}

function closeScrapeModal() {
    const modal = document.getElementById('scrapeModal');
    modal.classList.remove('show');
    document.body.style.overflow = '';
}

document.getElementById('btnConfirmScrape').addEventListener('click', async function() {
    const btn = document.getElementById('btnConfirmScrape');
    const scrapeType = document.querySelector('input[name="scrapeType"]:checked').value;
    
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 刮削中...';
    
    // 显示进度区域
    document.getElementById('scrapeProgress').style.display = 'block';
    document.getElementById('scrapeResults').innerHTML = '';
    
    try {
        if (scrapeType === 'single') {
            // 刮削单个文件
            if (!scrapeTargetPath) {
                showNotification({ type: 'error', message: '请先选择一个文件' });
                btn.disabled = false;
                btn.innerHTML = '<i class="fas fa-cloud-download-alt"></i> 开始刮削';
                return;
            }
            
            document.getElementById('scrapeProgressBar').style.width = '50%';
            document.getElementById('scrapeProgressText').textContent = '正在查询 MusicBrainz...';
            
            const response = await fetchWithAuth('/api/scrape-metadata', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: scrapeTargetPath })
            });
            
            const result = await response.json();
            
            document.getElementById('scrapeProgressBar').style.width = '100%';
            
            if (result.success) {
                document.getElementById('scrapeProgressText').textContent = '刮削成功！';
                const meta = result.metadata;
                document.getElementById('scrapeResults').innerHTML = `
                    <div class="scrape-result-item success">
                        <i class="fas fa-check-circle"></i>
                        <div>
                            <div><strong>${meta.title || '未知标题'}</strong></div>
                            <div style="font-size: 12px; opacity: 0.8;">
                                ${meta.artist || '未知艺术家'} · ${meta.album || '未知专辑'} ${meta.year ? '(' + meta.year + ')' : ''}
                            </div>
                        </div>
                    </div>
                `;
                showNotification({ type: 'success', message: '刮削成功，元数据已写入' });
                
                // 刷新当前文件显示
                setTimeout(() => {
                    closeScrapeModal();
                    refreshFolders();
                }, 2000);
            } else {
                document.getElementById('scrapeProgressText').textContent = '刮削失败';
                document.getElementById('scrapeResults').innerHTML = `
                    <div class="scrape-result-item error">
                        <i class="fas fa-times-circle"></i>
                        <span>${result.error || '未找到匹配的记录'}</span>
                    </div>
                `;
                showNotification({ type: 'error', message: result.error || '刮削失败' });
            }
        } else {
            // 刮削整个文件夹
            const folderPath = currentFolderPath;
            if (!folderPath) {
                showNotification({ type: 'error', message: '请先选择一个文件夹' });
                btn.disabled = false;
                btn.innerHTML = '<i class="fas fa-cloud-download-alt"></i> 开始刮削';
                return;
            }
            
            document.getElementById('scrapeProgressText').textContent = '正在刮削文件夹中的音乐文件...';
            
            const response = await fetch('/api/scrape-folder', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ folderPath })
            });
            
            const result = await response.json();
            
            document.getElementById('scrapeProgressBar').style.width = '100%';
            
            if (result.success) {
                document.getElementById('scrapeProgressText').textContent = 
                    `刮削完成！成功 ${result.successCount} 个，失败 ${result.failCount} 个，共 ${result.total} 个文件`;
                
                let resultsHtml = '';
                result.results.forEach(r => {
                    if (r.success) {
                        const meta = r.metadata;
                        resultsHtml += `
                            <div class="scrape-result-item success">
                                <i class="fas fa-check-circle"></i>
                                <div>
                                    <div><strong>${r.file}</strong></div>
                                    <div style="font-size: 12px; opacity: 0.8;">
                                        ${meta.title || '未知'} · ${meta.artist || '未知'} ${meta.album ? '· ' + meta.album : ''}
                                    </div>
                                </div>
                            </div>
                        `;
                    } else {
                        resultsHtml += `
                            <div class="scrape-result-item error">
                                <i class="fas fa-times-circle"></i>
                                <span>${r.file}: ${r.error || '失败'}</span>
                            </div>
                        `;
                    }
                });
                document.getElementById('scrapeResults').innerHTML = resultsHtml;
                
                showNotification({ type: 'success', message: `刮削完成！成功 ${result.successCount} 个，失败 ${result.failCount} 个` });
                
                // 刷新文件夹
                setTimeout(() => {
                    closeScrapeModal();
                    refreshFolders();
                }, 3000);
            } else {
                document.getElementById('scrapeProgressText').textContent = '刮削失败';
                showNotification({ type: 'error', message: result.error || '刮削失败' });
            }
        }
    } catch (error) {
        console.error('刮削失败:', error);
        document.getElementById('scrapeProgressText').textContent = '刮削失败: ' + error.message;
        showNotification({ type: 'error', message: '刮削失败: ' + error.message });
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-cloud-download-alt"></i> 开始刮削';
    }
});

// 编辑音乐属性功能
let isSavingMetadata = false;

async function openEditMetadataModal(filePath) {
    try {
        await requireLogin();
    } catch (e) {
        return;
    }
    const modal = document.getElementById('editMetadataModal');
    modal.classList.add('show');
    document.body.style.overflow = 'hidden';
    
    document.getElementById('editMetadataFilePath').value = filePath;
    
    // 提取文件名并显示
    const fileName = filePath.split(/[\\/]/).pop();
    document.getElementById('editMetadataFileName').value = fileName;
    
    // 清空表单，避免保留上一次编辑的数据
    document.getElementById('editMetadataTitle').value = '';
    document.getElementById('editMetadataArtist').value = '';
    document.getElementById('editMetadataAlbum').value = '';
    document.getElementById('editMetadataYear').value = '';
    document.getElementById('editMetadataTrack').value = '';
    document.getElementById('editMetadataGenre').value = '';
    document.getElementById('editMetadataComment').value = '';
    document.getElementById('editMetadataAlbumArtist').value = '';
    
    // 设置按钮为加载状态
    const btnSave = document.getElementById('btnConfirmEditMetadata');
    btnSave.disabled = true;
    btnSave.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 加载中...';
    
    try {
        // 获取当前文件元数据
        const response = await fetch(`/api/metadata?path=${encodeURIComponent(filePath)}`);
        const result = await response.json();
        
        if (result.success) {
            const meta = result.metadata;
            document.getElementById('editMetadataTitle').value = meta.title || '';
            document.getElementById('editMetadataArtist').value = meta.artist || '';
            document.getElementById('editMetadataAlbum').value = meta.album || '';
            document.getElementById('editMetadataYear').value = meta.year || '';
            document.getElementById('editMetadataTrack').value = meta.track || '';
            document.getElementById('editMetadataGenre').value = meta.genre || '';
            document.getElementById('editMetadataComment').value = meta.comment || '';
            document.getElementById('editMetadataAlbumArtist').value = meta.albumArtist || '';
        } else {
            showNotification({ type: 'error', message: result.error || '获取元数据失败' });
        }
    } catch (error) {
        showNotification({ type: 'error', message: '获取元数据失败: ' + error.message });
    } finally {
        btnSave.disabled = false;
        btnSave.innerHTML = '<i class="fas fa-save"></i> 保存';
    }
}

// 从文件名解析艺术家和歌曲名
function parseFileName() {
    const fileName = document.getElementById('editMetadataFileName').value;
    if (!fileName) {
        showNotification({ type: 'warning', message: '文件名为空' });
        return;
    }
    
    // 获取选择的解析格式
    const format = document.getElementById('parseFormatSelect').value;
    
    // 去掉文件扩展名
    const nameWithoutExt = fileName.replace(/\.[^/.]+$/, '');
    
    let artist = '';
    let title = '';
    
    // 按 "-" 分割
    const parts = nameWithoutExt.split(/\s*-\s*/);
    
    switch (format) {
        case 'artist-title':
            // 艺术家 - 歌曲名
            if (parts.length >= 2) {
                artist = parts[0].trim();
                title = parts.slice(1).join(' - ').trim();
            } else {
                title = nameWithoutExt.trim();
            }
            break;
            
        case 'title-artist':
            // 歌曲名 - 艺术家
            if (parts.length >= 2) {
                title = parts[0].trim();
                artist = parts.slice(1).join(' - ').trim();
            } else {
                title = nameWithoutExt.trim();
            }
            break;
            
        case 'title':
            // 仅歌曲名
            title = nameWithoutExt.trim();
            break;
            
        case 'auto':
        default:
            // 自动识别
            if (parts.length >= 2) {
                artist = parts[0].trim();
                title = parts.slice(1).join(' - ').trim();
                
                // 如果第一部分很短（<=2字符），可能是歌曲名在前
                if (artist.length <= 2 && title.length > 2) {
                    const temp = artist;
                    artist = title;
                    title = temp;
                }
            } else {
                title = nameWithoutExt.trim();
            }
            break;
    }
    
    // 填充到表单
    if (artist) {
        document.getElementById('editMetadataArtist').value = artist;
    }
    if (title) {
        document.getElementById('editMetadataTitle').value = title;
    }
    
    const formatNames = {
        'auto': '自动识别',
        'artist-title': '艺术家-歌曲名',
        'title-artist': '歌曲名-艺术家',
        'title': '仅歌曲名'
    };
    
    showNotification({ 
        type: 'success', 
        message: artist && title 
            ? `已解析（${formatNames[format]}）：艺术家 "${artist}"，歌曲 "${title}"` 
            : `已解析（${formatNames[format]}）：歌曲名 "${title}"`
    });
}

function closeEditMetadataModal() {
    const modal = document.getElementById('editMetadataModal');
    modal.classList.remove('show');
    document.body.style.overflow = '';
}

// 在编辑属性对话框中刮削当前文件
async function scrapeCurrentFile() {
    const filePath = document.getElementById('editMetadataFilePath').value;
    if (!filePath) return;
    
    const btn = document.getElementById('btnScrapeSingle');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 刮削中...';
    
    try {
        const response = await fetch('/api/scrape-metadata', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: filePath })
        });
        
        const result = await response.json();
        
        if (result.success) {
            const meta = result.metadata;
            
            // 自动填充表单
            if (meta.title) document.getElementById('editMetadataTitle').value = meta.title;
            if (meta.artist) document.getElementById('editMetadataArtist').value = meta.artist;
            if (meta.album) document.getElementById('editMetadataAlbum').value = meta.album;
            if (meta.year) document.getElementById('editMetadataYear').value = meta.year;
            if (meta.genre) document.getElementById('editMetadataGenre').value = meta.genre;
            
            showNotification({ type: 'success', message: '刮削成功，已自动填充表单' });
        } else {
            showNotification({ type: 'error', message: result.error || '未找到匹配的记录' });
        }
    } catch (error) {
        console.error('刮削失败:', error);
        showNotification({ type: 'error', message: '刮削失败: ' + error.message });
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-cloud-download-alt"></i> 刮削';
    }
}

// 转MP3功能
let isConverting = false;

async function openConvertToMp3Modal(filePath) {
    try {
        await requireLogin();
    } catch (e) {
        return;
    }
    const modal = document.getElementById('convertToMp3Modal');
    modal.classList.add('show');
    document.body.style.overflow = 'hidden';
    
    document.getElementById('convertFilePath').value = filePath;
    
    // 提取文件名
    const fileName = filePath.split(/[\\/]/).pop();
    const nameWithoutExt = fileName.replace(/\.[^/.]+$/, '');
    const outputName = nameWithoutExt + '.mp3';
    
    document.getElementById('convertFileName').textContent = fileName;
    document.getElementById('convertOutputName').textContent = outputName;
    
    // 重置按钮状态
    const btn = document.getElementById('btnConfirmConvert');
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-cog"></i> 开始转换';
}

function closeConvertToMp3Modal() {
    if (isConverting) return; // 转换中不允许关闭
    const modal = document.getElementById('convertToMp3Modal');
    modal.classList.remove('show');
    document.body.style.overflow = '';
}

document.getElementById('btnConfirmConvert').addEventListener('click', async function() {
    const btn = document.getElementById('btnConfirmConvert');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 添加中...';
    
    try {
        const filePath = document.getElementById('convertFilePath').value;
        const quality = document.getElementById('convertQuality').value;
        
        const response = await fetch('/api/batch-convert-mp3', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ files: [filePath], bitrate: quality })
        });
        
        const result = await response.json();
        
        if (result.success) {
            showNotification({ type: 'success', message: '已添加到后台队列' });
            closeConvertToMp3Modal();
        } else {
            showNotification({ type: 'error', message: result.error || '添加失败' });
            closeConvertToMp3Modal();
        }
    } catch (error) {
        showNotification({ type: 'error', message: '添加失败: ' + error.message });
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-cog"></i> 开始转换';
    }
});

document.getElementById('btnConfirmEditMetadata').addEventListener('click', async function() {
    if (isSavingMetadata) return;
    isSavingMetadata = true;
    
    const btn = document.getElementById('btnConfirmEditMetadata');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 保存中...';
    
    try {
        const filePath = document.getElementById('editMetadataFilePath').value;
        
        const payload = {
            path: filePath,
            title: document.getElementById('editMetadataTitle').value.trim(),
            artist: document.getElementById('editMetadataArtist').value.trim(),
            album: document.getElementById('editMetadataAlbum').value.trim(),
            year: document.getElementById('editMetadataYear').value.trim(),
            track: document.getElementById('editMetadataTrack').value.trim(),
            genre: document.getElementById('editMetadataGenre').value.trim(),
            comment: document.getElementById('editMetadataComment').value.trim(),
            albumArtist: document.getElementById('editMetadataAlbumArtist').value.trim()
        };
        
        const response = await fetch('/api/update-metadata', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });
        
        const result = await response.json();
        
        if (result.success) {
            showNotification({ type: 'success', message: '属性已更新' });
            closeEditMetadataModal();
            
            // 直接更新卡片，不刷新列表
            const escapedPath = filePath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            const fileItem = document.querySelector(`.folder-music-item[data-path="${escapedPath}"]`);
            
            if (fileItem) {
                // 更新标题
                const titleEl = fileItem.querySelector('.folder-music-title');
                if (titleEl) {
                    titleEl.textContent = payload.title || '未知标题';
                }
                
                // 更新艺术家
                const artistEl = fileItem.querySelector('.folder-music-artist');
                if (artistEl) {
                    artistEl.textContent = payload.artist || '未知艺术家';
                }
            }
        } else {
            showNotification({ type: 'error', message: result.error || '更新失败' });
        }
    } catch (error) {
        showNotification({ type: 'error', message: '更新失败: ' + error.message });
    } finally {
        isSavingMetadata = false;
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-save"></i> 保存';
    }
});

document.getElementById('btnConfirmOrganize').addEventListener('click', async function() {
    if (isOrganizing) return;
    isOrganizing = true;
    
    const btn = document.getElementById('btnConfirmOrganize');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 整理中...';
    
    try {
        const selectedType = document.querySelector('input[name="organizeType"]:checked').value;
        
        const response = await fetch('/api/organize', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ type: selectedType })
        });
        
        const result = await response.json();
        
        if (result.success) {
            showNotification({ type: 'success', message: `整理完成！已整理 ${result.organizedCount} 个文件` });
            closeOrganizeModal();
            refreshFolders();
        } else {
            showNotification({ type: 'error', message: result.error || '整理失败' });
        }
    } catch (error) {
        showNotification({ type: 'error', message: '整理失败: ' + error.message });
    } finally {
        isOrganizing = false;
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-magic"></i> 开始整理';
    }
});

function triggerFileSelect() {
    document.getElementById('musicFileInput').click();
}

// 文件选择处理
document.getElementById('musicFileInput').addEventListener('change', function(e) {
    const files = Array.from(e.target.files);
    if (files.length > 0) {
        files.forEach(file => {
            const existingIndex = selectedFiles.findIndex(f => f.name === file.name);
            if (existingIndex !== -1) {
                selectedFiles[existingIndex] = file;
            } else {
                selectedFiles.push(file);
            }
        });
        updateFileList();
    }
});

// 拖拽上传处理
const dropzone = document.getElementById('uploadDropzone');

dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
});

dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('dragover');
});

dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    
    const files = Array.from(e.dataTransfer.files);
    const musicFiles = files.filter(file => {
        const ext = file.name.toLowerCase().split('.').pop();
        return ['.mp3', '.flac', '.wav', '.m4a', '.ogg', '.wma'].includes('.' + ext);
    });
    
    if (musicFiles.length > 0) {
        musicFiles.forEach(file => {
            const existingIndex = selectedFiles.findIndex(f => f.name === file.name);
            if (existingIndex !== -1) {
                selectedFiles[existingIndex] = file;
            } else {
                selectedFiles.push(file);
            }
        });
        updateFileList();
    } else {
        showError('没有支持的音乐文件');
    }
});

// 点击拖拽区域触发文件选择
dropzone.addEventListener('click', () => {
    triggerFileSelect();
});

function updateFileList() {
    const fileListEl = document.getElementById('fileList');
    const uploadBtn = document.getElementById('uploadConfirmBtn');
    
    if (selectedFiles.length === 0) {
        fileListEl.innerHTML = '';
        uploadBtn.disabled = true;
        return;
    }
    
    uploadBtn.disabled = false;
    fileListEl.innerHTML = '';
    
    selectedFiles.forEach((file, index) => {
        const item = document.createElement('div');
        item.className = 'file-item';
        item.innerHTML = `
            <div class="file-item-icon">🎵</div>
            <div class="file-item-info">
                <div class="file-item-name">${file.name}</div>
                <div class="file-item-size">${formatFileSize(file.size)}</div>
            </div>
            <button class="file-item-remove" onclick="removeFile(${index})">×</button>
        `;
        fileListEl.appendChild(item);
    });
}

function removeFile(index) {
    selectedFiles.splice(index, 1);
    updateFileList();
    document.getElementById('musicFileInput').value = '';
}

function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

async function uploadMusic() {
    if (selectedFiles.length === 0) {
        showError('请选择要上传的音乐文件');
        return;
    }
    
    if (selectedFiles.length > 50) {
        showError('一次最多只能上传 50 个文件');
        return;
    }
    
    const maxSize = 500 * 1024 * 1024;
    const oversizedFiles = selectedFiles.filter(f => f.size > maxSize);
    if (oversizedFiles.length > 0) {
        showError(`文件过大：${oversizedFiles[0].name}（最大 500MB）`);
        return;
    }
    
    const totalSize = selectedFiles.reduce((sum, f) => sum + f.size, 0);
    if (totalSize > 2 * 1024 * 1024 * 1024) {
        showError('总文件大小超过限制（最大 2GB）');
        return;
    }
    
    const uploadBtn = document.getElementById('uploadConfirmBtn');
    uploadBtn.disabled = true;
    uploadBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 添加中...';
    
    const formData = new FormData();
    for (let i = 0; i < selectedFiles.length; i++) {
        formData.append('musicFiles', selectedFiles[i]);
    }
    formData.append('folderPath', currentFolderPath || '');
    
    try {
        const response = await fetchWithAuth('/api/upload-music-async', {
            method: 'POST',
            body: formData
        });
        
        const result = await response.json();
        
        if (result.success) {
            showSuccess(result.message);
            closeUploadModal();
            // 清空文件选择
            const fileInput = document.getElementById('musicFileInput');
            if (fileInput) fileInput.value = '';
            selectedFiles = [];
        } else {
            showError(result.error || '上传失败');
        }
    } catch (error) {
        showError('上传失败：' + error.message);
    } finally {
        uploadBtn.disabled = false;
        uploadBtn.innerHTML = '<i class="fas fa-upload"></i> 开始上传';
    }
}

// 搜索音乐
function searchMusic(keyword) {
    if (!keyword || keyword.trim() === '') {
        renderPlaylist();
        return;
    }
    
    const filtered = currentPlaylist.filter(track => {
        return track.title.toLowerCase().includes(keyword.toLowerCase());
    });
    
    const playlistEl = document.getElementById('playlist');
    const countEl = document.getElementById('playlistCount');
    
    countEl.textContent = `(${filtered.length} 首)`;
    
    if (filtered.length === 0) {
        playlistEl.innerHTML = '<div class="playlist-no-match"><i class="fas fa-search"></i><p>未找到匹配的音乐</p><p class="empty-hint">请尝试其他关键词搜索</p></div>';
        return;
    }
    
    playlistEl.innerHTML = '';
    filtered.forEach((track, index) => {
        const originalIndex = currentPlaylist.indexOf(track);
        const item = document.createElement('div');
        item.className = 'playlist-item';
        if (originalIndex === currentIndex) {
            item.classList.add('active');
        }
        
        item.innerHTML = `
            <div class="playlist-item-icon">
                ${originalIndex === currentIndex && isPlaying ? '<i class="fas fa-music playlist-item-playing"></i>' : '<i class="fas fa-music"></i>'}
            </div>
            <div class="playlist-item-info">
                <div class="playlist-item-title">${track.title}</div>
                <div class="playlist-item-path">${track.path}</div>
            </div>
            <div class="playlist-item-duration">${formatDuration(track.duration)}</div>
            <div class="playlist-item-actions">
                <button class="playlist-action-btn playlist-play-btn" onclick="event.stopPropagation(); playTrack(${originalIndex})" title="播放">
                    <i class="fas fa-play"></i>
                </button>
                <button class="playlist-action-btn playlist-delete-btn" onclick="event.stopPropagation(); deleteTrack(${originalIndex})" title="删除">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        `;
        
        item.ondblclick = () => playTrack(originalIndex);
        playlistEl.appendChild(item);
    });
}

// 设置双击或双触播放（支持触摸屏设备）
function setupPlaylistItemEvents(element, index) {
    // 双击播放（桌面端）
    element.ondblclick = (e) => {
        if (e.target.closest('.playlist-item-actions') || e.target.closest('.playlist-item-checkbox')) return;
        playTrack(index);
    };
    
    // 单击行：Ctrl复选 / Shift多选 / 聚焦+取消选中
    // mousedown中阻止Shift/Ctrl时的文本选中
    element.addEventListener('mousedown', (e) => {
        if (e.target.closest('.playlist-item-actions')) return;
        if (e.target.closest('.playlist-item-checkbox')) return;
        if (e.shiftKey || e.ctrlKey || e.metaKey) {
            e.preventDefault();
        }
    });
    
    element.onclick = (e) => {
        if (e.target.closest('.playlist-item-actions')) return;
        if (e.target.closest('.playlist-item-checkbox')) return;
        
        // 聚焦当前行
        document.querySelectorAll('.playlist-item.focused').forEach(el => el.classList.remove('focused'));
        element.classList.add('focused');
        
        if (e.shiftKey && lastClickedPlaylistIndex !== -1) {
            // Shift多选：选中从上次点击到当前的范围内所有项
            const startIndex = Math.min(lastClickedPlaylistIndex, index);
            const endIndex = Math.max(lastClickedPlaylistIndex, index);
            
            for (let i = startIndex; i <= endIndex; i++) {
                selectedPlaylistTracks.add(i);
                const item = document.querySelector(`.playlist-item[data-index="${i}"]`);
                if (item) {
                    item.classList.add('selected');
                    const cb = item.querySelector('.playlist-item-checkbox input[type="checkbox"]');
                    if (cb) cb.checked = true;
                }
            }
        } else if (e.ctrlKey || e.metaKey) {
            // Ctrl/Cmd复选：切换当前项，保留其他选中
            if (selectedPlaylistTracks.has(index)) {
                selectedPlaylistTracks.delete(index);
                element.classList.remove('selected');
                const cb = element.querySelector('.playlist-item-checkbox input[type="checkbox"]');
                if (cb) cb.checked = false;
            } else {
                selectedPlaylistTracks.add(index);
                element.classList.add('selected');
                const cb = element.querySelector('.playlist-item-checkbox input[type="checkbox"]');
                if (cb) cb.checked = true;
            }
        } else {
            // 取消所有选中
            selectedPlaylistTracks.clear();
            document.querySelectorAll('.playlist-item.selected').forEach(el => el.classList.remove('selected'));
            document.querySelectorAll('.playlist-item-checkbox input[type="checkbox"]').forEach(cb => cb.checked = false);
        }
        
        lastClickedPlaylistIndex = index;
        updatePlaylistBatchBar();
    };
    
    // 复选框点击：支持Shift多选
    const checkbox = element.querySelector('.playlist-item-checkbox input[type="checkbox"]');
    if (checkbox) {
        // 用mousedown拦截，阻止浏览器默认切换checkbox，由代码控制
        checkbox.addEventListener('mousedown', (e) => {
            e.preventDefault(); // 阻止浏览器自动切换checkbox
        });
        
        checkbox.addEventListener('click', (e) => {
            if (e.shiftKey && lastClickedPlaylistIndex !== -1) {
                // Shift多选：选中从上次点击到当前的范围内所有项
                const startIndex = Math.min(lastClickedPlaylistIndex, index);
                const endIndex = Math.max(lastClickedPlaylistIndex, index);
                
                for (let i = startIndex; i <= endIndex; i++) {
                    selectedPlaylistTracks.add(i);
                    const item = document.querySelector(`.playlist-item[data-index="${i}"]`);
                    if (item) {
                        item.classList.add('selected');
                        const cb = item.querySelector('.playlist-item-checkbox input[type="checkbox"]');
                        if (cb) cb.checked = true;
                    }
                }
            } else {
                // 普通点击：切换当前项
                if (selectedPlaylistTracks.has(index)) {
                    selectedPlaylistTracks.delete(index);
                    element.classList.remove('selected');
                    checkbox.checked = false;
                } else {
                    selectedPlaylistTracks.add(index);
                    element.classList.add('selected');
                    checkbox.checked = true;
                }
            }
            
            lastClickedPlaylistIndex = index;
            updatePlaylistBatchBar();
        });
    }
    
    // 触摸事件（移动端）：单击选中，双击播放
    let touchCount = 0;
    let lastTouchTime = 0;
    let singleTapTimer = null;
    const DOUBLE_TAP_THRESHOLD = 300;
    let isTouchingCheckbox = false;
    
    // 触摸开始
    element.addEventListener('touchstart', (e) => {
        if (e.target.closest('.playlist-item-actions')) return;
        
        const isCheckboxTouch = !!e.target.closest('.playlist-item-checkbox');
        if (isCheckboxTouch) {
            isTouchingCheckbox = true;
            // 移动端触摸checkbox：切换选中（不支持Shift）
            if (selectedPlaylistTracks.has(index)) {
                selectedPlaylistTracks.delete(index);
                element.classList.remove('selected');
                if (checkbox) checkbox.checked = false;
            } else {
                selectedPlaylistTracks.add(index);
                element.classList.add('selected');
                if (checkbox) checkbox.checked = true;
            }
            lastClickedPlaylistIndex = index;
            updatePlaylistBatchBar();
            return;
        }
        
        isTouchingCheckbox = false;
        
        const now = Date.now();
        
        if (singleTapTimer) {
            clearTimeout(singleTapTimer);
            singleTapTimer = null;
        }
        
        if (now - lastTouchTime < DOUBLE_TAP_THRESHOLD) {
            touchCount++;
            if (touchCount >= 2) {
                touchCount = 0;
                playTrack(index);
            }
        } else {
            touchCount = 1;
            singleTapTimer = setTimeout(() => {
                if (touchCount === 1 && !isTouchingCheckbox) {
                    // 单击：聚焦 + 取消所有选中
                    document.querySelectorAll('.playlist-item.focused').forEach(el => el.classList.remove('focused'));
                    element.classList.add('focused');
                    selectedPlaylistTracks.clear();
                    document.querySelectorAll('.playlist-item.selected').forEach(el => el.classList.remove('selected'));
                    document.querySelectorAll('.playlist-item-checkbox input[type="checkbox"]').forEach(cb => cb.checked = false);
                    updatePlaylistBatchBar();
                }
                touchCount = 0;
                singleTapTimer = null;
            }, DOUBLE_TAP_THRESHOLD);
        }
        lastTouchTime = now;
    }, { passive: true });
    
    // 触摸结束时处理checkbox的默认行为
    element.addEventListener('touchend', (e) => {
        if (isTouchingCheckbox && checkbox) {
            // 阻止checkbox的默认切换行为，因为我们已经在touchstart中处理了
            e.preventDefault();
        }
        isTouchingCheckbox = false;
    }, { passive: false });
}

async function refreshLibrary() {
    try {
        const playlistResult = await apiRequest('/api/playlist');
        if (playlistResult.playlist) {
            currentPlaylist = playlistResult.playlist;
        }
        
        const statusResult = await apiRequest('/api/status');
        if (statusResult.current) {
            currentIndex = statusResult.currentIndex;
            isPlaying = statusResult.isPlaying;
            updateNowPlaying(statusResult.current);
            updatePlayPauseButton();
            
            if (statusResult.isPlaying) {
                startProgressUpdate();
            } else {
                stopProgressUpdate();
            }
        } else {
            currentIndex = -1;
            isPlaying = false;
            updateNowPlaying(null);
            updatePlayPauseButton();
            stopProgressUpdate();
        }
        
        renderPlaylist();
        showSuccess('播放列表已刷新');
    } catch (error) {
        console.error('刷新失败:', error);
        showError('刷新失败');
    }
}

let pendingDeleteIndex = null;
let pendingDeletePath = null;
let pendingDeletePaths = [];
let pendingPlaylistBatchIndices = [];

// 打开删除弹窗
async function openDeleteModal(indexOrPath, isPath = false) {
    try {
        await requireLogin();
    } catch (e) {
        return;
    }
    const modal = document.getElementById('deleteModal');
    
    if (Array.isArray(indexOrPath)) {
        // 批量删除（从文件夹视图）
        pendingDeletePaths = indexOrPath;
        pendingDeletePath = null;
        pendingDeleteIndex = null;
        
        document.getElementById('deleteTrackName').textContent = `批量删除 ${indexOrPath.length} 个文件`;
        document.getElementById('deleteWarning').textContent = `此操作将同时删除服务器上的 ${indexOrPath.length} 个文件，无法恢复！`;
    } else if (isPath) {
        // 从文件夹视图删除（按路径）- 会删除物理文件
        pendingDeletePath = indexOrPath;
        pendingDeletePaths = [];
        pendingDeleteIndex = null;
        
        // 提取文件名显示
        const fileName = indexOrPath.split('/').pop().split('\\').pop();
        document.getElementById('deleteTrackName').textContent = fileName;
        document.getElementById('deleteWarning').textContent = '此操作将同时删除服务器上的文件，无法恢复！';
    } else {
        // 从播放列表删除（按索引）- 仅移除，不删除文件
        if (indexOrPath < 0 || indexOrPath >= currentPlaylist.length) return;
        
        pendingDeleteIndex = indexOrPath;
        pendingDeletePath = null;
        pendingDeletePaths = [];
        
        const track = currentPlaylist[indexOrPath];
        document.getElementById('deleteTrackName').textContent = track.title;
        document.getElementById('deleteWarning').textContent = '此操作将从播放列表中移除该歌曲。';
    }
    
    modal.classList.add('show');
    document.body.style.overflow = 'hidden';
}

// 关闭删除弹窗
function closeDeleteModal() {
    const modal = document.getElementById('deleteModal');
    modal.classList.remove('show');
    document.body.style.overflow = '';
    pendingDeleteIndex = null;
    pendingDeletePath = null;
    pendingDeletePaths = [];
    pendingPlaylistBatchIndices = [];
    delete modal.dataset.deleteType;
    delete modal.dataset.deleteIndices;
}

// 打开线程设置弹窗
async function openWorkerConfigModal() {
    const modal = document.getElementById('workerConfigModal');
    modal.classList.add('show');
    document.body.style.overflow = 'hidden';
    
    // 加载当前配置
    try {
        const response = await fetch('/api/worker-config');
        const result = await response.json();
        
        if (result.success) {
            document.getElementById('maxConvertWorkers').value = result.config.maxConvertWorkers;
            document.getElementById('maxUploadWorkers').value = result.config.maxUploadWorkers;
            document.getElementById('currentConvertWorkers').textContent = result.config.activeConvertWorkers;
            document.getElementById('totalConvertWorkers').textContent = result.config.maxConvertWorkers;
            document.getElementById('currentUploadWorkers').textContent = result.config.activeUploadWorkers;
            document.getElementById('totalUploadWorkers').textContent = result.config.maxUploadWorkers;
            document.getElementById('convertQueueLen').textContent = result.config.convertQueueLength;
            document.getElementById('uploadQueueLen').textContent = result.config.uploadQueueLength;
        }
    } catch (error) {
        console.error('加载线程配置失败:', error);
        showError('加载线程配置失败');
    }
}

// 关闭线程设置弹窗
function closeWorkerConfigModal() {
    const modal = document.getElementById('workerConfigModal');
    modal.classList.remove('show');
    document.body.style.overflow = '';
}

// 保存线程设置
async function saveWorkerConfig() {
    try {
        await requireLogin();
    } catch (e) {
        return;
    }
    const maxConvert = parseInt(document.getElementById('maxConvertWorkers').value, 10);
    const maxUpload = parseInt(document.getElementById('maxUploadWorkers').value, 10);
    
    // 验证输入
    if (maxConvert < 1 || maxConvert > 10) {
        showError('转换线程数必须在 1-10 之间');
        return;
    }
    
    if (maxUpload < 1 || maxUpload > 10) {
        showError('上传线程数必须在 1-10 之间');
        return;
    }
    
    const btnSave = document.getElementById('btnSaveWorkerConfig');
    btnSave.disabled = true;
    btnSave.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 保存中...';
    
    try {
        const response = await fetch('/api/worker-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                maxConvertWorkers: maxConvert,
                maxUploadWorkers: maxUpload
            })
        });
        
        const result = await response.json();
        
        if (result.success) {
            showSuccess('线程设置已保存');
            closeWorkerConfigModal();
        } else {
            showError(result.error || '保存失败');
        }
    } catch (error) {
        console.error('保存线程配置失败:', error);
        showError('保存线程配置失败');
    } finally {
        btnSave.disabled = false;
        btnSave.innerHTML = '<i class="fas fa-save"></i> 保存设置';
    }
}

// 确认删除
let isDeleting = false;
document.getElementById('btnConfirmDelete').addEventListener('click', async function() {
    if (isDeleting) return;
    isDeleting = true;
    
    const btnConfirm = document.getElementById('btnConfirmDelete');
    if (btnConfirm) {
        btnConfirm.disabled = true;
        btnConfirm.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 删除中...';
    }
    
    const modal = document.getElementById('deleteModal');
    const deleteType = modal.dataset.deleteType;
    
    if (deleteType === 'playlist-batch') {
        const indices = JSON.parse(modal.dataset.deleteIndices || '[]');
        await executePlaylistBatchDelete(indices);
        isDeleting = false;
        if (btnConfirm) {
            btnConfirm.disabled = false;
            btnConfirm.innerHTML = '<i class="fas fa-trash"></i> 确认删除';
        }
        return;
    }
    
    const deletePath = pendingDeletePath;
    const deleteIndex = pendingDeleteIndex;
    const deletePaths = [...pendingDeletePaths];
    
    closeDeleteModal();
    
    if (deletePaths.length > 0) {
        try {
            const response = await fetch('/api/batch-delete-files', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ files: deletePaths })
            });
            
            const result = await response.json();
            if (result.success) {
                showSuccess(result.message);
                deletePaths.forEach(path => {
                    const index = currentPlaylist.findIndex(t => t.path === path);
                    if (index !== -1) {
                        currentPlaylist.splice(index, 1);
                    }
                    // 从 folderCacheData 中删除文件
                    removeFileFromCache(path);
                });
                renderPlaylist();
                clearSelection();
                await loadFolderData(currentFolderPath, folderCurrentPage, FOLDER_PAGE_SIZE, folderSearchKeyword || undefined);
            } else {
                showError(result.error || '删除失败');
            }
        } catch (error) {
            if (error.isAuthCancelled) return;
            console.error('批量删除失败:', error);
            showError('删除失败');
        }
    } else if (deletePath) {
        const filePath = deletePath;
        
        try {
            const result = await apiRequest('/api/delete-file', 'DELETE', { filePath });
            
            if (result.success) {
                showSuccess(result.message);
                const playlistIndex = currentPlaylist.findIndex(t => t.path === filePath);
                if (playlistIndex !== -1) {
                    currentPlaylist.splice(playlistIndex, 1);
                    renderPlaylist();
                }
                // 从缓存中删除文件
                removeFileFromCache(filePath);
                await loadFolderData(currentFolderPath, folderCurrentPage, FOLDER_PAGE_SIZE, folderSearchKeyword || undefined);
            } else {
                showError(result.error || '删除失败');
            }
        } catch (error) {
            if (error.isAuthCancelled) return;
            console.error('删除失败:', error);
            showError('删除失败');
        }
    } else if (deleteIndex !== null) {
        const index = deleteIndex;
        const track = currentPlaylist[index];
        
        try {
            const result = await apiRequest(`/api/delete/${index}`, 'DELETE');
            
            if (result.success) {
                currentPlaylist.splice(index, 1);
                
                if (currentIndex === index) {
                    currentIndex = -1;
                    isPlaying = false;
                    updateNowPlaying(null);
                    updatePlayPauseButton();
                    stopProgressUpdate();
                } else if (currentIndex > index) {
                    currentIndex--;
                }
                
                renderPlaylist();
                showSuccess(`已删除 "${track.title}"`);
                folderCacheData = null;
            } else {
                showError(result.error || '删除失败');
            }
        } catch (error) {
            if (error.isAuthCancelled) return;
            console.error('删除失败:', error);
            showError('删除失败');
        }
    }
    
    isDeleting = false;
    if (btnConfirm) {
        btnConfirm.disabled = false;
        btnConfirm.innerHTML = '<i class="fas fa-trash"></i> 确认删除';
    }
});

window.closeDeleteModal = closeDeleteModal;

// 删除轨道
function deleteTrack(index) {
    openDeleteModal(index);
}

// 加载状态
async function loadStatus() {
    try {
        console.log('=== 开始加载状态 ===');
        const [status, playlistResult] = await Promise.all([
            apiRequest('/api/status'),
            apiRequest('/api/playlist')
        ]);
        
        console.log('状态响应:', status);
        console.log('播放列表响应:', playlistResult);
        console.log('播放列表数据:', playlistResult.playlist);
        console.log('播放列表长度:', playlistResult.playlist?.length);
        
        if (playlistResult.playlist && playlistResult.playlist.length > 0) {
            currentPlaylist = playlistResult.playlist;
            console.log('已更新 currentPlaylist, 长度:', currentPlaylist.length);
        } else {
            console.log('播放列表为空或未返回数据');
        }
        
        if (status.current) {
            currentIndex = status.currentIndex;
            isPlaying = status.isPlaying;
            updateNowPlaying(status.current);
            updatePlayPauseButton();
            
            if (status.isPlaying) {
                startProgressUpdate();
            } else {
                stopProgressUpdate();
            }
        } else {
            currentIndex = -1;
            isPlaying = false;
            updateNowPlaying(null);
            updatePlayPauseButton();
            stopProgressUpdate();
        }
        
        if (status.playMode) {
            currentPlayMode = status.playMode;
            updatePlayModeButton();
        }
        
        console.log('准备渲染播放列表, currentPlaylist 长度:', currentPlaylist.length);
        renderPlaylist();
    } catch (error) {
        console.error('加载状态失败:', error);
        showError('加载状态失败');
    }
}

// 加载音频设备列表
async function loadAudioDevices() {
    try {
        const result = await apiRequest('/api/audio-devices');
        console.log('=== 设备列表API响应 ===');
        console.log('result:', result);
        
        const deviceListEl = document.getElementById('deviceList');
        
        if (result.success && result.devices && result.devices.length > 0) {
            deviceListEl.innerHTML = '';
            result.devices.forEach(device => {
                const deviceItem = document.createElement('div');
                deviceItem.className = device.id === result.currentDevice ? 'device-item active' : 'device-item';
                deviceItem.dataset.deviceId = device.id;
                deviceItem.onclick = () => selectAudioDevice(device.id);
                
                deviceItem.innerHTML = `
                    <div class="device-checkbox">
                        <i class="fas fa-check"></i>
                    </div>
                    <i class="fas fa-volume-up device-item-icon"></i>
                    <div class="device-item-info">
                        <div class="device-item-name">${device.name}</div>
                        <div class="device-item-id">${device.id}</div>
                    </div>
                    <span class="device-status ${device.id === result.currentDevice ? 'active' : 'inactive'}">${device.id === result.currentDevice ? '已选中' : '未选中'}</span>
                `;
                
                deviceListEl.appendChild(deviceItem);
            });
            
            // 标记当前选中的设备
            console.log('=== 设备匹配调试 ===');
            console.log('当前设备ID:', result.currentDevice);
            console.log('当前设备ID长度:', result.currentDevice ? result.currentDevice.length : 0);
            
            const allItems = deviceListEl.querySelectorAll('.device-item');
            console.log('设备列表数量:', allItems.length);
            
            allItems.forEach((item, index) => {
                console.log(`设备${index}: ${item.dataset.deviceId}`);
                console.log(`设备${index}长度: ${item.dataset.deviceId.length}`);
                console.log(`匹配结果: ${item.dataset.deviceId === result.currentDevice}`);
            });
            
            if (result.currentDevice) {
                // 标记当前选中的设备
                let found = false;
                allItems.forEach(item => {
                    if (item.dataset.deviceId === result.currentDevice) {
                        item.classList.add('active');
                        found = true;
                        console.log('✅ 找到匹配的设备，已标记为选中');
                    }
                });
                // 如果没有找到匹配的设备（比如设备被移除了），默认选中第一个
                if (!found && allItems.length > 0) {
                    console.log('❌ 未找到匹配的设备，默认选中第一个');
                    allItems[0].classList.add('active');
                    selectAudioDevice(allItems[0].dataset.deviceId);
                }
            } else if (allItems.length > 0) {
                // 如果没有保存的设备，默认选中第一个并保存
                allItems[0].classList.add('active');
                selectAudioDevice(result.devices[0].id);
            }
        } else {
            throw new Error('未检测到声卡设备');
        }
    } catch (error) {
        console.error('加载声卡设备失败:', error);
        const deviceListEl = document.getElementById('deviceList');
        deviceListEl.innerHTML = `
                <div class="device-item">
                    <i class="fas fa-exclamation-triangle device-item-icon" style="color: #f59e0b;"></i>
                    <div>加载失败：${error.message}</div>
                </div>
            `;
    }
}

// 选择声卡设备
async function selectAudioDevice(deviceId) {
    try {
        await requireLogin();
    } catch (e) {
        return;
    }
    // 更新UI选中状态
    const deviceItems = document.querySelectorAll('.device-item');
    
    // 更新每个设备的状态
    deviceItems.forEach(item => {
        const isSelected = item.dataset.deviceId === deviceId;
        
        // 更新 active 类
        if (isSelected) {
            item.classList.add('active');
        } else {
            item.classList.remove('active');
        }
        
        // 更新状态标签
        const statusEl = item.querySelector('.device-status');
        if (statusEl) {
            if (isSelected) {
                statusEl.textContent = '已选中';
                statusEl.className = 'device-status active';
            } else {
                statusEl.textContent = '未选中';
                statusEl.className = 'device-status inactive';
            }
        }
    });
    
    // 调用 API 保存选中的设备（静默保存，不显示提示）
    try {
        await apiRequest('/api/audio-device', 'POST', { deviceId });
    } catch (error) {
        console.error('保存设备选择失败:', error);
    }
}

// 切换视图
function switchView(viewName) {
    // 隐藏所有视图
    const views = document.querySelectorAll('.view');
    views.forEach(view => view.classList.remove('active'));
    
    // 激活目标视图
    const targetView = document.getElementById(`view-${viewName}`);
    if (targetView) {
        targetView.classList.add('active');
    }
    
    // 更新侧边栏选中状态
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => item.classList.remove('active'));
    const activeNav = document.querySelector(`[data-view="${viewName}"]`);
    if (activeNav) {
        activeNav.classList.add('active');
    }
    
    // 如果切换到任务管理视图，加载任务列表
    if (viewName === 'task') {
        loadTaskList();
        startTaskListPoll();
        
        // 添加过滤器点击事件
        document.querySelectorAll('.filter-btn').forEach(btn => {
            btn.removeEventListener('click', handleTaskFilterClick);
            btn.addEventListener('click', handleTaskFilterClick);
        });
    } else {
        // 离开任务视图时停止轮询
        stopTaskListPoll();
    }
}

// 页面加载时启动任务通知轮询
document.addEventListener('DOMContentLoaded', () => {
    // 启动任务通知轮询
    startTaskNotificationPoll();
    
    // 加载保存的在线音源
    loadSavedOnlineSource();
});

// 加载保存的在线音源
async function loadSavedOnlineSource() {
    try {
        const response = await fetch('/api/online-sources');
        const result = await response.json();
        
        if (result.success && result.currentSource) {
            document.getElementById('onlineSourceSelect').value = result.currentSource;
        }
    } catch (error) {
        console.error('加载在线音源失败:', error);
    }
}

// 处理任务过滤器点击
function handleTaskFilterClick(event) {
    const filter = event.target.dataset.filter;
    
    // 更新选中状态
    document.querySelectorAll('.filter-btn').forEach(btn => btn.classList.remove('active'));
    event.target.classList.add('active');
    
    // 加载过滤后的任务列表
    loadTaskList(filter);
}

// 初始化侧边栏导航
function initSidebarNav() {
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => {
        item.addEventListener('click', () => {
            const viewName = item.getAttribute('data-view');
            if (viewName) {
                switchView(viewName);
            }
        });
    });
}

// 旧的关于模态框函数保持兼容（用于其他地方的调用）
function openAboutModal() {
    switchView('about');
}

function closeAboutModal() {
    // 不需要关闭，直接切换回音乐视图
    switchView('music');
}

// 打开更新模态框
async function openUpdateModal() {
    try {
        await requireLogin();
    } catch (e) {
        return;
    }
    // 检查是否为本地访问（127.0.0.1），如果是则禁用更新功能
    const currentHost = window.location.hostname;
    if (currentHost === '127.0.0.1' || currentHost === 'localhost') {
        showNotification({ type: 'info', message: '本地运行时禁用手动更新功能' });
        return;
    }
    
    const modal = document.getElementById('updateModal');
    if (!modal) {
        console.error('更新模态框未找到');
        return;
    }
    
    modal.classList.add('show');
    document.body.style.overflow = 'hidden';
    
    // 重置表单
    const updateFileInput = document.getElementById('updateFile');
    const btnUploadUpdate = document.getElementById('btnUploadUpdate');
    const updateFileName = document.getElementById('updateFileName');
    const updateStatus = document.getElementById('updateStatus');
    const uploadProgress = document.getElementById('updateUploadProgress');
    
    // 检查元素是否存在
    console.log('=== 打开更新模态框时检查元素 ===');
    console.log('updateFileInput:', !!updateFileInput);
    console.log('btnUploadUpdate:', !!btnUploadUpdate);
    console.log('updateFileName:', !!updateFileName);
    console.log('updateStatus:', !!updateStatus);
    console.log('uploadProgress:', !!uploadProgress);
    if (uploadProgress) {
        console.log('uploadProgress初始display:', uploadProgress.style.display);
        console.log('uploadProgress计算样式:', window.getComputedStyle(uploadProgress).display);
    }
    console.log('=== 元素检查完成 ===');
    
    if (!updateFileInput || !btnUploadUpdate || !updateFileName || !updateStatus || !uploadProgress) {
        console.error('更新模态框内部元素未找到');
        console.log('updateFileInput:', !!updateFileInput);
        console.log('btnUploadUpdate:', !!btnUploadUpdate);
        console.log('updateFileName:', !!updateFileName);
        console.log('updateStatus:', !!updateStatus);
        console.log('uploadProgress:', !!uploadProgress);
        return;
    }
    
    updateFileInput.value = '';
    btnUploadUpdate.disabled = true;
    btnUploadUpdate.innerHTML = '<i class="fas fa-upload"></i> 上传并更新';
    updateFileName.textContent = '';
    updateStatus.style.display = 'none';
    uploadProgress.style.display = 'none';
    
    // 确保上传事件已绑定
    ensureUploadEventBound();
}

// 确保上传事件只绑定一次
let uploadEventBound = false;

function ensureUploadEventBound() {
    if (uploadEventBound) return;
    
    const btnUploadUpdate = document.getElementById('btnUploadUpdate');
    const updateFileInput = document.getElementById('updateFile');
    
    if (!btnUploadUpdate || !updateFileInput) {
        console.error('无法绑定上传事件：元素未找到');
        return;
    }
    
    btnUploadUpdate.addEventListener('click', async () => {
        const file = updateFileInput.files[0];
        if (!file) return;
        
        if (btnUploadUpdate.disabled) return;
        
        const updateStatus = document.getElementById('updateStatus');
        const uploadProgress = document.getElementById('updateUploadProgress');
        const progressFill = document.getElementById('updateProgressFill');
        const progressText = document.getElementById('updateProgressText');
        
        // 检查元素是否存在
        if (!updateStatus || !uploadProgress || !progressFill || !progressText) {
            console.error('更新模态框元素未找到');
            console.log('updateStatus:', !!updateStatus);
            console.log('uploadProgress:', !!uploadProgress);
            console.log('progressFill:', !!progressFill);
            console.log('progressText:', !!progressText);
            return;
        }
        // 显示进度条
        uploadProgress.style.display = 'flex';
        btnUploadUpdate.disabled = true;
        btnUploadUpdate.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 处理中...';
        updateStatus.style.display = 'block';
        updateStatus.className = 'update-status';
        updateStatus.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 正在上传更新包...';
        
        
        // 设置初始进度为1%，确保用户能看到进度条容器
        progressFill.style.width = '1%';
        progressText.textContent = '准备上传...';
        
        try {
            await performUpdate(file, progressFill, progressText, updateStatus, uploadProgress);
            updateStatus.className = 'update-status success';
            updateStatus.innerHTML = '<i class="fas fa-check-circle"></i> 更新成功！服务器正在重启...';
            btnUploadUpdate.innerHTML = '<i class="fas fa-check"></i> 更新成功';
            
            setTimeout(() => {
                window.location.reload();
            }, 5000);
        } catch (error) {
            updateStatus.className = 'update-status error';
            updateStatus.innerHTML = `<i class="fas fa-exclamation-circle"></i> ${error.message}`;
            btnUploadUpdate.disabled = false;
            btnUploadUpdate.innerHTML = '<i class="fas fa-upload"></i> 上传并更新';
            uploadProgress.style.display = 'none';
        }
    });
    
    uploadEventBound = true;
}

// 执行更新操作
async function performUpdate(file, progressFill, progressText, updateStatus, uploadProgress) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();

        xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) {
                const percent = Math.round((e.loaded / e.total) * 100);
                progressFill.style.width = percent + '%';
                progressText.textContent = percent + '%';
            }
        });

        xhr.addEventListener('load', () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                if (uploadProgress) {
                    uploadProgress.style.display = 'none';
                }
                updateStatus.className = 'update-status success';
                updateStatus.innerHTML = '<i class="fas fa-check-circle"></i> 更新包上传成功！正在重启服务器...5秒后自动刷新页面';

                setTimeout(() => {
                    window.location.reload();
                }, 5000);

                resolve();
            } else {
                try {
                    const error = JSON.parse(xhr.responseText);
                    reject(new Error(error.error || '更新失败'));
                } catch {
                    reject(new Error('更新失败'));
                }
            }
        });

        xhr.addEventListener('error', () => {
            reject(new Error('网络错误'));
        });

        xhr.addEventListener('timeout', () => {
            reject(new Error('请求超时'));
        });

        const formData = new FormData();
        formData.append('file', file);

        xhr.open('POST', '/api/system-update');
        xhr.timeout = 120000; // 2分钟超时
        xhr.send(formData);
    });
}

// 关闭更新模态框
function closeUpdateModal() {
    const modal = document.getElementById('updateModal');
    modal.classList.remove('show');
    document.body.style.overflow = '';
}

// 初始化更新功能
function initUpdateFeature() {
    // 文件选择处理
    const updateFileInput = document.getElementById('updateFile');
    const btnUploadUpdate = document.getElementById('btnUploadUpdate');
    const updateFileName = document.getElementById('updateFileName');

    // 检查必要元素是否存在
    console.log('=== 更新功能初始化检查 ===');
    console.log('document.readyState:', document.readyState);
    console.log('updateFileInput:', updateFileInput);
    console.log('btnUploadUpdate:', btnUploadUpdate);
    console.log('updateFileName:', updateFileName);
    console.log('=== 检查结束 ===');

    if (!updateFileInput || !btnUploadUpdate || !updateFileName) {
        console.error('更新功能初始化失败：缺少必要的DOM元素');
        console.log('updateFileInput exists:', !!updateFileInput);
        console.log('btnUploadUpdate exists:', !!btnUploadUpdate);
        console.log('updateFileName exists:', !!updateFileName);
        
        // 列出所有带有 update 相关ID的元素
        const allElements = document.querySelectorAll('[id*="update"]');
        console.log('所有包含update的元素:', allElements);
        
        return;
    }

    // 绑定文件选择事件（只绑定一次）
    if (!updateFileInput._changeBound) {
        updateFileInput._changeBound = true;
        updateFileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                if (file.name.endsWith('.zip')) {
                    btnUploadUpdate.disabled = false;
                    updateFileName.textContent = file.name + ' (' + (file.size / 1024).toFixed(1) + ' KB)';
                    const updateStatus = document.getElementById('updateStatus');
                    if (updateStatus) {
                        updateStatus.style.display = 'none';
                    }
                } else {
                    updateFileName.textContent = '';
                    const updateStatus = document.getElementById('updateStatus');
                    if (updateStatus) {
                        updateStatus.style.display = 'block';
                        updateStatus.className = 'update-status error';
                        updateStatus.innerHTML = '<i class="fas fa-exclamation-circle"></i> 请选择ZIP格式的更新包！';
                    }
                    btnUploadUpdate.disabled = true;
                    updateFileInput.value = '';
                }
            }
        });
    }
}

// 页面加载时初始化更新功能
function setupUpdateFeature() {
    // 使用 DOMContentLoaded 事件确保DOM完全就绪
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            console.log('DOMContentLoaded 触发，初始化更新功能');
            initUpdateFeature();
            loadVersion();
        });
    } else if (document.readyState === 'interactive' || document.readyState === 'complete') {
        console.log('DOM已就绪，立即初始化更新功能');
        initUpdateFeature();
        loadVersion();
    } else {
        // 作为后备，添加一个短延迟
        setTimeout(() => {
            console.log('延迟初始化更新功能');
            initUpdateFeature();
            loadVersion();
        }, 500);
    }
}

// 加载当前版本信息
async function loadVersion() {
    try {
        const result = await apiRequest('/api/version');
        if (result.success) {
            const versionEl = document.getElementById('currentVersion');
            if (versionEl) {
                versionEl.textContent = result.version;
            }
        }
    } catch (error) {
        console.error('加载版本失败:', error);
    }
}

// 检查更新
async function checkUpdate() {
    const statusMsg = document.getElementById('updateStatusMsg');
    const btnCheck = document.getElementById('btnCheckUpdate');
    
    if (!statusMsg || !btnCheck) {
        console.error('检查更新元素未找到');
        return;
    }
    
    // 检查是否为本地访问（127.0.0.1），如果是则禁用更新功能
    const currentHost = window.location.hostname;
    if (currentHost === '127.0.0.1' || currentHost === 'localhost') {
        statusMsg.className = 'update-status-msg info';
        statusMsg.style.display = 'block';
        statusMsg.innerHTML = '<i class="fas fa-info-circle"></i> 本地运行时禁用自动更新功能';
        showNotification({ type: 'info', message: '本地运行时禁用自动更新功能' });
        return;
    }
    
    // 显示加载状态
    btnCheck.disabled = true;
    btnCheck.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 检查中...';
    statusMsg.className = 'update-status-msg info';
    statusMsg.style.display = 'block';
    statusMsg.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 正在检查更新...';
    
    try {
        const result = await apiRequest('/api/check-update');
        
        if (result.success) {
            if (result.hasUpdate) {
                statusMsg.className = 'update-status-msg warning';
                statusMsg.innerHTML = `
                    <div>发现新版本 <strong>${result.latestVersion}</strong>（当前版本：${result.currentVersion}）</div>
                    <div style="margin-top: 10px; display: flex; gap: 8px; justify-content: center; flex-wrap: wrap;">
                        <button onclick="autoUpdate()" class="btn-auto-update" id="btnAutoUpdate">
                            <i class="fas fa-download"></i> 立即更新
                        </button>
                        <a href="${result.downloadUrl}" target="_blank" class="btn-github-link">
                            <i class="fab fa-github"></i> GitHub 下载
                        </a>
                    </div>
                `;
            } else {
                statusMsg.className = 'update-status-msg success';
                statusMsg.innerHTML = '<i class="fas fa-check-circle"></i> 当前已是最新版本';
            }
        } else {
            statusMsg.className = 'update-status-msg error';
            statusMsg.innerHTML = `<i class="fas fa-exclamation-circle"></i> ${result.error || '检查更新失败'}`;
        }
    } catch (error) {
        statusMsg.className = 'update-status-msg error';
        statusMsg.innerHTML = `<i class="fas fa-exclamation-circle"></i> 检查更新失败: ${error.message}`;
    } finally {
        btnCheck.disabled = false;
        btnCheck.innerHTML = '<i class="fas fa-sync"></i> 检查更新';
    }
}

// 打开自动更新确认模态框
async function openAutoUpdateConfirmModal() {
    try {
        await requireLogin();
    } catch (e) {
        return;
    }
    const modal = document.getElementById('autoUpdateConfirmModal');
    if (modal) {
        modal.classList.add('show');
    }
}

// 关闭自动更新确认模态框
function closeAutoUpdateConfirmModal() {
    const modal = document.getElementById('autoUpdateConfirmModal');
    if (modal) {
        modal.classList.remove('show');
    }
}

// 自动更新
async function autoUpdate() {
    const btnAuto = document.getElementById('btnAutoUpdate');
    const statusMsg = document.getElementById('updateStatusMsg');
    
    if (!btnAuto || !statusMsg) return;
    
    openAutoUpdateConfirmModal();
}

// 执行自动更新
async function doAutoUpdate() {
    const btnAuto = document.getElementById('btnAutoUpdate');
    const statusMsg = document.getElementById('updateStatusMsg');
    const confirmBtn = document.getElementById('btnConfirmAutoUpdate');
    
    if (!btnAuto || !statusMsg) return;
    
    closeAutoUpdateConfirmModal();
    
    btnAuto.disabled = true;
    btnAuto.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 准备中...';
    statusMsg.className = 'update-status-msg info';
    statusMsg.innerHTML = `
        <div><i class="fas fa-spinner fa-spin"></i> 正在下载更新包，请稍候...</div>
        <div class="update-progress-container" style="margin-top: 12px;">
            <div class="update-progress-bar">
                <div class="update-progress-fill" id="updateProgressFill" style="width: 0%"></div>
            </div>
            <div class="update-progress-text" id="updateProgressText">0%</div>
        </div>
    `;
    
    // 连接 SSE 接收进度
    let eventSource = null;
    try {
        eventSource = new EventSource('/api/update-progress');
        
        eventSource.onmessage = (event) => {
            const data = JSON.parse(event.data);
            const progressFill = document.getElementById('updateProgressFill');
            const progressText = document.getElementById('updateProgressText');
            
            if (progressFill && progressText) {
                progressFill.style.width = `${data.percent || 0}%`;
                progressText.textContent = data.message || '';
            }
            
            // 根据阶段更新按钮文字
            if (data.type === 'download_start') {
                btnAuto.innerHTML = '<i class="fas fa-download"></i> 下载中...';
            } else if (data.type === 'download_complete') {
                btnAuto.innerHTML = '<i class="fas fa-check"></i> 验证中...';
            } else if (data.type === 'extract_start') {
                btnAuto.innerHTML = '<i class="fas fa-file-archive"></i> 解压中...';
            } else if (data.type === 'extract_complete') {
                btnAuto.innerHTML = '<i class="fas fa-cog fa-spin"></i> 安装中...';
            } else if (data.type === 'install_complete') {
                btnAuto.innerHTML = '<i class="fas fa-check"></i> 完成';
            }
        };
        
        const result = await apiRequest('/api/auto-update', 'POST');
        
        if (result.success) {
            statusMsg.className = 'update-status-msg success';
            statusMsg.innerHTML = `<i class="fas fa-check-circle"></i> 更新成功！已升级到 ${result.version}，页面将在 5 秒后刷新...`;
            btnAuto.innerHTML = '<i class="fas fa-check"></i> 更新成功';
            
            if (eventSource) {
                eventSource.close();
            }
            
            setTimeout(() => {
                window.location.reload();
            }, 5000);
        } else {
            statusMsg.className = 'update-status-msg error';
            statusMsg.innerHTML = `<i class="fas fa-exclamation-circle"></i> ${result.error || '更新失败'}`;
            btnAuto.disabled = false;
            btnAuto.innerHTML = '<i class="fas fa-download"></i> 立即更新';
            
            if (eventSource) {
                eventSource.close();
            }
        }
    } catch (error) {
        statusMsg.className = 'update-status-msg error';
        statusMsg.innerHTML = `<i class="fas fa-exclamation-circle"></i> 更新失败: ${error.message}`;
        btnAuto.disabled = false;
        btnAuto.innerHTML = '<i class="fas fa-download"></i> 立即更新';
        
        if (eventSource) {
            eventSource.close();
        }
    }
}

// 在脚本加载完成后立即调用
setupUpdateFeature();
initSidebarNav();

async function loadVolume() {
    try {
        const result = await apiRequest('/api/volume');
        if (result.success) {
            const slider = document.getElementById('volumeSlider');
            const valueEl = document.getElementById('volumeValue');
            slider.value = result.volume;
            valueEl.textContent = `${result.volume}%`;
            // 更新本地静音状态
            currentMuted = result.muted;
            // 更新音量图标（考虑静音状态）
            updateVolumeIcon(result.volume, result.muted);
        }
    } catch (error) {
        console.error('加载音量失败:', error);
    }
}

async function loadPlayOutput() {
    try {
        const result = await apiRequest('/api/play-output');
        if (result.success) {
            playOutput = result.playOutput;
            
            // 更新单选按钮状态
            const radioButtons = document.querySelectorAll('input[name="playOutput"]');
            radioButtons.forEach(radio => {
                radio.checked = (radio.value === playOutput);
            });
            
            // 更新播放栏快捷切换按钮状态
            updateOutputSwitchButton();
        }
    } catch (error) {
        console.error('加载播放输出方式失败:', error);
    }
}

async function changeVolume(volume) {
    try {
        const valueEl = document.getElementById('volumeValue');
        valueEl.textContent = `${volume}%`;
        
        if (playOutput === 'client') {
            changeVolumeClient(volume);
        } else {
            const response = await fetch('/api/volume', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ volume: parseInt(volume) })
            });
            
            const result = await response.json();
            if (result.success) {
                currentMuted = result.muted;
                updateVolumeIcon(parseInt(volume), result.muted);
            }
        }
    } catch (error) {
        console.error('设置音量失败:', error);
    }
}

function updateVolumeIcon(volume, muted) {
    const iconEl = document.querySelector('.volume-icon');
    if (!iconEl) return;
    
    // 移除所有音量相关的图标类
    iconEl.classList.remove('fa-volume-up', 'fa-volume-down', 'fa-volume-off');
    
    // 如果是静音状态，显示静音图标
    if (muted) {
        iconEl.classList.add('fa-volume-off');
    } else if (volume === 0) {
        iconEl.classList.add('fa-volume-off');
    } else if (volume < 50) {
        iconEl.classList.add('fa-volume-down');
    } else {
        iconEl.classList.add('fa-volume-up');
    }
}

async function toggleMute() {
    try {
        if (playOutput === 'client') {
            toggleMuteClient();
        } else {
            const result = await apiRequest('/api/mute', 'POST');
            if (result.success) {
                // 更新本地静音状态
                currentMuted = result.muted;
                // 更新图标
                const slider = document.getElementById('volumeSlider');
                updateVolumeIcon(parseInt(slider.value), result.muted);
            }
        }
    } catch (error) {
        console.error('静音切换失败:', error);
    }
}

async function testAudioDevice() {
    try {
        await requireLogin();
    } catch (e) {
        return;
    }
    // 获取当前选中的设备（从服务端）
    try {
        const devicesResult = await apiRequest('/api/audio-devices');
        const deviceId = devicesResult.currentDevice || 'default';
        
        showInfo('🔊 正在测试声卡...');
        
        const response = await fetch('/api/test-audio', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ deviceId: deviceId })
        });
        
        const result = await response.json();
        
        if (result.success) {
            showSuccess(`声卡测试成功：${result.message}`);
        } else {
            showError(`声卡测试失败：${result.message}`);
        }
    } catch (error) {
        console.error('测试声卡失败:', error);
        showError('声卡测试失败');
    }
}

// 进度条拖动功能
let isDragging = false;
let currentDragTime = 0;

function initProgressDrag() {
    const container = document.getElementById('progressBarContainer');
    if (!container) return;
    
    // 鼠标/触摸按下
    container.addEventListener('mousedown', startDrag);
    container.addEventListener('touchstart', startDrag, { passive: false });
    
    // 拖动
    document.addEventListener('mousemove', onDrag);
    document.addEventListener('touchmove', onDrag, { passive: false });
    
    // 释放
    document.addEventListener('mouseup', endDrag);
    document.addEventListener('touchend', endDrag);
}

function startDrag(e) {
    if (currentIndex < 0) return;
    
    e.preventDefault();
    isDragging = true;
    
    updateDragPosition(e);
}

function onDrag(e) {
    if (!isDragging) return;
    
    e.preventDefault();
    updateDragPosition(e);
}

function updateDragPosition(e) {
    const container = document.getElementById('progressBarContainer');
    const duration = currentDuration || 0;
    
    if (duration <= 0) return;
    
    const rect = container.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    let percent = (clientX - rect.left) / rect.width;
    percent = Math.max(0, Math.min(1, percent));
    
    const seekTime = percent * duration;
    currentDragTime = seekTime;
    
    // 实时更新进度条显示
    const progressBar = document.getElementById('progressBar');
    const currentTimeEl = document.getElementById('currentTime');
    
    progressBar.style.width = `${percent * 100}%`;
    currentTimeEl.textContent = formatDuration(seekTime);
}

async function endDrag(e) {
    if (!isDragging) return;
    
    isDragging = false;
    
    if (currentDragTime > 0 && currentIndex >= 0) {
        try {
            if (playOutput === 'client') {
                seekClient(currentDragTime / (currentDuration || 1));
            } else {
                await apiRequest(`/api/seek?time=${currentDragTime}`);
                
                // 如果正在播放，更新播放开始时间
                if (isPlaying) {
                    playbackStartTime = Date.now() - (currentDragTime * 1000);
                } else {
                    pausedElapsed = currentDragTime;
                }
            }
        } catch (error) {
            console.error('跳转失败:', error);
        }
    }
}

window.onload = async () => {
    // 检查登录状态
    checkAuthStatus();
    
    // 加载核心界面（播放状态、声卡、音量、播放输出方式、在线设置、缓存）
    await Promise.all([
        loadStatus(),
        loadAudioDevices(),
        loadVolume(),
        loadPlayOutput(),
        loadOnlineSettings(),
        refreshCacheList()
    ]);
    updatePlayModeButton();
    initProgressDrag();
    startStatusSync();
    
    // 后台异步加载播放列表和文件管理数据
    Promise.all([
        loadPlaylistData(),
        loadFolders()
    ]).then(() => {
        console.log('所有数据加载完成');
    }).catch(error => {
        console.error('后台加载失败:', error);
    });
    
    // 后台异步预加载排行榜数据（必须在在线设置加载完成后执行，以确保使用正确的 pageSize）
    preloadAllRanks().then(() => {
        console.log('排行榜数据预加载完成');
    }).catch(error => {
        console.error('排行榜预加载失败:', error);
    });
};

// 预加载播放列表数据
async function loadPlaylistData() {
    try {
        const playlistResult = await apiRequest('/api/playlist');
        if (playlistResult.playlist) {
            currentPlaylist = playlistResult.playlist;
            renderPlaylist();
        }
    } catch (error) {
        console.error('预加载播放列表失败:', error);
    }
}

// ========== 文件夹功能 ==========

// 当前文件夹路径
let currentFolderPath = '';
let currentFolders = [];
let currentFiles = [];
let folderCacheData = null;
let folderSearchKeyword = '';
let folderCurrentPage = 1;
let FOLDER_PAGE_SIZE = 20;
let folderTotalFiles = 0;
let folderTotalPages = 0;

async function loadFolderData(folderPath, page, pageSize, search) {
    const folderView = document.getElementById('folderView');
    
    try {
        folderView.innerHTML = `
            <div class="folder-loading">
                <div class="loading-spinner"></div>
                <p>正在加载文件夹...</p>
            </div>
        `;
        
        const params = new URLSearchParams({
            path: folderPath,
            page: page,
            pageSize: pageSize
        });
        
        if (search) {
            params.set('search', search);
        }
        
        const result = await apiRequest(`/api/folders?${params.toString()}`, 'GET');
        
        if (result.success) {
            currentFolders = result.folders || [];
            currentFiles = result.files || [];
            folderTotalFiles = result.totalFiles || 0;
            folderTotalPages = result.totalPages || 0;
            folderCurrentPage = result.page || 1;
            // 不再从服务器响应覆盖 FOLDER_PAGE_SIZE，使用 loadOnlineSettings 加载的值
            
            // 切换文件夹时清空选中状态
            clearSelection();
            
            renderFolderSections();
        } else {
            throw new Error(result.error || '加载失败');
        }
        
    } catch (error) {
        console.error('加载文件夹内容失败:', error);
        folderView.innerHTML = `
            <div class="folder-empty">
                <i class="fas fa-exclamation-triangle"></i>
                <p>加载失败</p>
            </div>
        `;
        showError('加载文件夹内容失败');
    }
}

// 处理文件夹搜索
function handleFolderSearch() {
    const searchInput = document.getElementById('folderSearchInput');
    const searchClear = document.getElementById('folderSearchClear');
    
    if (!searchInput) return;
    
    folderSearchKeyword = searchInput.value.trim();
    folderCurrentPage = 1;
    
    if (searchClear) {
        searchClear.style.display = folderSearchKeyword ? 'flex' : 'none';
    }
    
    loadFolderData(currentFolderPath, 1, FOLDER_PAGE_SIZE, folderSearchKeyword || undefined);
}

// 清除文件夹搜索
function clearFolderSearch() {
    const searchInput = document.getElementById('folderSearchInput');
    const searchClear = document.getElementById('folderSearchClear');
    
    if (searchInput) {
        searchInput.value = '';
    }
    if (searchClear) {
        searchClear.style.display = 'none';
    }
    
    folderSearchKeyword = '';
    folderCurrentPage = 1;
    loadFolderData(currentFolderPath, 1, FOLDER_PAGE_SIZE);
}

// 过滤文件
function filterFiles(files, keyword) {
    if (!keyword) return files;
    
    const lowerKeyword = keyword.toLowerCase();
    return files.filter(file => {
        return file.title.toLowerCase().includes(lowerKeyword) ||
               (file.artist && file.artist.toLowerCase().includes(lowerKeyword)) ||
               (file.album && file.album.toLowerCase().includes(lowerKeyword)) ||
               file.filename.toLowerCase().includes(lowerKeyword);
    });
}

// 高亮搜索文本
function highlightText(text, keyword) {
    if (!keyword || !text) return text;
    
    const regex = new RegExp(`(${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return text.replace(regex, '<span class="search-highlight">$1</span>');
}

// 加载文件夹列表（从服务器获取最新数据）
async function loadFolders() {
    const folderView = document.getElementById('folderView');
    
    try {
        // 初始化状态
        currentFolders = [];
        currentFiles = [];
        currentFolderPath = '';
        folderCurrentPage = 1;
        FOLDER_PAGE_SIZE = 20;
        folderSearchKeyword = '';
        
        // 更新面包屑导航
        updateBreadcrumb('');
        
        // 显示加载提示（服务端可能需要扫描）
        folderView.innerHTML = `
            <div class="folder-loading">
                <div class="loading-spinner"></div>
                <p>正在加载文件夹...</p>
                <div class="loading-progress">
                    <div class="loading-progress-bar" id="loadingProgressBar" style="width: 0%"></div>
                </div>
                <p class="loading-status" id="loadingStatus">准备中...</p>
            </div>
        `;
        
        // 获取缓存（服务端无缓存时会自动扫描生成），添加时间戳避免浏览器缓存
        const cacheResult = await apiRequest(`/api/folder-cache?_=${Date.now()}`, 'GET');
        
        if (cacheResult.success) {
            // 服务端总是会返回缓存数据
            folderCacheData = cacheResult.data;
            
            await loadFolderData('', 1, FOLDER_PAGE_SIZE);
            
            // 如果是首次加载，显示提示消息
            if (cacheResult.message) {
                showNotification({ type: 'info', message: cacheResult.message });
            }
        } else {
            showError(cacheResult.error || '加载失败');
        }
        
    } catch (error) {
        console.error('加载文件夹失败:', error);
        folderView.innerHTML = `
            <div class="folder-header">
                <button id="btnScanFolders" class="btn btn-primary btn-scan" onclick="scanFolders()">
                    <i class="fas fa-search"></i> 扫描文件
                </button>
                <div id="cacheStatus" class="cache-status"></div>
            </div>
            <p class="empty-state">加载失败</p>
        `;
        showError('加载文件夹失败');
    }
}

// 扫描文件夹并生成缓存
async function scanFolders() {
    try {
        await requireLogin();
    } catch (e) {
        return;
    }
    const btnScan = document.querySelector('.folder-scan-btn');
    const cacheStatus = document.getElementById('cacheStatus');
    
    if (!btnScan) return;
    
    btnScan.disabled = true;
    btnScan.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 扫描中...';
    
    try {
        const result = await apiRequest('/api/scan-folders', 'POST');
        
        if (result.success) {
            folderCacheData = {
                timestamp: Date.now(),
                folders: result.folders,
                files: result.files,
                totalFiles: result.totalScanned,
                totalFolders: result.totalFolders || 0
            };
            
            await loadFolderData('', 1, FOLDER_PAGE_SIZE);
            
            showNotification({ type: 'success', message: result.message });
        } else {
            showError(result.error || '扫描失败');
        }
    } catch (error) {
        console.error('扫描失败:', error);
        showError('扫描失败: ' + error.message);
    } finally {
        btnScan.disabled = false;
        btnScan.innerHTML = '<i class="fas fa-search"></i> 扫描文件';
    }
}

// 从缓存渲染文件夹
function renderFolderFromCache(folderPath) {
    if (!folderCacheData) {
        console.error('没有缓存数据');
        return;
    }
    
    const folderView = document.getElementById('folderView');
    let folders = [];
    let files = [];
    
    if (folderPath === '') {
        // 根目录
        folders = folderCacheData.folders || [];
        files = folderCacheData.files || [];
    } else {
        // 子目录：查找对应文件夹
        const targetFolder = findFolderInCache(folderCacheData.folders, folderPath);
        if (targetFolder) {
            folders = targetFolder.folders || [];
            files = targetFolder.files || [];
        }
    }
    
    currentFolders = folders;
    currentFiles = files;
    currentFolderPath = folderPath;
    folderCurrentPage = 1;
    
    renderFolderSections();
}

// 在缓存中查找文件夹
function findFolderInCache(folders, targetPath) {
    for (const folder of folders) {
        if (folder.path === targetPath) {
            return folder;
        }
        if (folder.folders && folder.folders.length > 0) {
            const found = findFolderInCache(folder.folders, targetPath);
            if (found) return found;
        }
    }
    return null;
}

// 从缓存中删除文件
function removeFileFromCache(filePath) {
    if (!folderCacheData) return;
    
    const fileName = filePath.split(/[\\/]/).pop();
    const parentPath = filePath.split(/[\\/]/).slice(0, -1).join('/').replace(/.*\/music\/?/, '');
    
    // 在根目录文件中查找
    if (folderCacheData.files) {
        const fileIndex = folderCacheData.files.findIndex(f => f.path === filePath);
        if (fileIndex !== -1) {
            folderCacheData.files.splice(fileIndex, 1);
            folderCacheData.totalFiles = (folderCacheData.totalFiles || 0) - 1;
            return;
        }
    }
    
    // 在子文件夹中查找并删除
    removeFileFromFolder(folderCacheData.folders, filePath, parentPath);
}

function removeFileFromFolder(folders, filePath, parentPath) {
    if (!folders) return;
    
    for (const folder of folders) {
        if (folder.path === parentPath && folder.files) {
            const fileIndex = folder.files.findIndex(f => f.path === filePath);
            if (fileIndex !== -1) {
                folder.files.splice(fileIndex, 1);
                folder.musicCount = (folder.musicCount || 0) - 1;
                if (folder.musicCount < 0) folder.musicCount = 0;
                return true;
            }
        }
        if (folder.folders && folder.folders.length > 0) {
            if (removeFileFromFolder(folder.folders, filePath, parentPath)) {
                // 更新父文件夹的音乐计数
                folder.musicCount = (folder.musicCount || 0) - 1;
                if (folder.musicCount < 0) folder.musicCount = 0;
                return true;
            }
        }
    }
    return false;
}

// 从缓存中删除文件夹
function removeFolderFromCache(folderPath) {
    if (!folderCacheData || !folderCacheData.folders) return;
    
    const folderIndex = folderCacheData.folders.findIndex(f => f.path === folderPath);
    if (folderIndex !== -1) {
        const removedFolder = folderCacheData.folders[folderIndex];
        folderCacheData.folders.splice(folderIndex, 1);
        folderCacheData.totalFolders = (folderCacheData.totalFolders || 0) - 1;
        folderCacheData.totalFiles = (folderCacheData.totalFiles || 0) - (removedFolder.musicCount || 0);
        return;
    }
    
    // 在子文件夹中查找
    removeFolderFromSubfolders(folderCacheData.folders, folderPath);
}

function removeFolderFromSubfolders(folders, folderPath) {
    if (!folders) return;
    
    for (let i = 0; i < folders.length; i++) {
        const folder = folders[i];
        if (folder.path === folderPath) {
            const removedFolder = folders[i];
            folders.splice(i, 1);
            folderCacheData.totalFolders = (folderCacheData.totalFolders || 0) - 1;
            folderCacheData.totalFiles = (folderCacheData.totalFiles || 0) - (removedFolder.musicCount || 0);
            return true;
        }
        if (folder.folders && folder.folders.length > 0) {
            if (removeFolderFromSubfolders(folder.folders, folderPath)) {
                // 更新父文件夹的计数
                folder.musicCount = (folder.musicCount || 0) - (removedFolder ? removedFolder.musicCount : 0);
                if (folder.musicCount < 0) folder.musicCount = 0;
                return true;
            }
        }
    }
    return false;
}

// 更新缓存中的文件夹名称
function renameFolderInCache(oldPath, newPath, newName) {
    if (!folderCacheData || !folderCacheData.folders) return;
    
    const folder = findFolderInCache(folderCacheData.folders, oldPath);
    if (folder) {
        folder.name = newName;
        folder.path = newPath;
        updateFolderPathsInSubfolders(folder.folders, oldPath, newPath);
    }
}

function updateFolderPathsInSubfolders(folders, oldParentPath, newParentPath) {
    if (!folders) return;
    
    folders.forEach(folder => {
        const relativeName = folder.path.replace(oldParentPath + '/', '');
        folder.path = newParentPath + '/' + relativeName;
        if (folder.folders && folder.folders.length > 0) {
            updateFolderPathsInSubfolders(folder.folders, oldParentPath, newParentPath);
        }
    });
}

// 更新缓存中的文件名称
function renameFileInCache(oldPath, newPath) {
    if (!folderCacheData) return;
    
    // 在根目录文件中查找
    if (folderCacheData.files) {
        const file = folderCacheData.files.find(f => f.path === oldPath);
        if (file) {
            file.path = newPath;
            file.title = newPath.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
            return;
        }
    }
    
    // 在子文件夹中查找
    renameFileInSubfolders(folderCacheData.folders, oldPath, newPath);
}

function renameFileInSubfolders(folders, oldPath, newPath) {
    if (!folders) return;
    
    for (const folder of folders) {
        if (folder.files) {
            const file = folder.files.find(f => f.path === oldPath);
            if (file) {
                file.path = newPath;
                file.title = newPath.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
                return true;
            }
        }
        if (folder.folders && folder.folders.length > 0) {
            if (renameFileInSubfolders(folder.folders, oldPath, newPath)) {
                return true;
            }
        }
    }
    return false;
}

// 更新文件夹文件计数
function updateFolderCountsAfterMove(folders, targetPath, delta) {
    if (!folders || folders.length === 0) return;
    
    folders.forEach(folder => {
        // 检查当前文件夹是否匹配目标路径
        if (folder.path === targetPath) {
            folder.musicCount = (folder.musicCount || 0) + delta;
            if (folder.musicCount < 0) folder.musicCount = 0;
        }
        
        // 递归检查子文件夹
        if (folder.folders && folder.folders.length > 0) {
            updateFolderCountsAfterMove(folder.folders, targetPath, delta);
        }
    });
}

// 刷新左侧导航栏的文件夹树
async function refreshFolderTree() {
    try {
        // 从服务器获取最新的缓存数据
        const cacheResult = await apiRequest(`/api/folder-cache?_=${Date.now()}`, 'GET');
        if (cacheResult.success && cacheResult.data) {
            folderCacheData = cacheResult.data;
            
            // 如果当前有打开的文件夹，刷新视图
            if (currentFolderPath) {
                await openFolder(currentFolderPath);
            } else {
                await loadFolders();
            }
        }
    } catch (error) {
        console.error('刷新文件夹树失败:', error);
    }
}

// 只刷新文件夹树（不重新加载当前视图）
async function refreshFolderTreeOnly() {
    try {
        // 从服务器获取最新的缓存数据
        const cacheResult = await apiRequest(`/api/folder-cache?_=${Date.now()}`, 'GET');
        if (cacheResult.success && cacheResult.data) {
            folderCacheData = cacheResult.data;
            
            // 重新渲染移动文件对话框中的文件夹树（如果对话框打开）
            const folderTreeEl = document.getElementById('folderTree');
            if (folderTreeEl) {
                buildFolderTree(folderTreeEl);
            }
        }
    } catch (error) {
        console.error('刷新文件夹树失败:', error);
    }
}

// 删除文件夹相关函数
async function openDeleteFolderModal(folderPath, folderName) {
    try {
        await requireLogin();
    } catch (e) {
        return;
    }
    const modal = document.getElementById('deleteFolderModal');
    const pathInput = document.getElementById('deleteFolderPath');
    const nameDisplay = document.getElementById('deleteFolderNameDisplay');
    
    pathInput.value = folderPath;
    nameDisplay.textContent = folderName;
    
    modal.classList.add('show');
    document.body.style.overflow = 'hidden';
}

function closeDeleteFolderModal() {
    const modal = document.getElementById('deleteFolderModal');
    modal.classList.remove('show');
    document.body.style.overflow = '';
}

// 确认删除文件夹
document.addEventListener('DOMContentLoaded', function() {
    const btnConfirmDelete = document.getElementById('btnConfirmDeleteFolder');
    if (btnConfirmDelete) {
        btnConfirmDelete.addEventListener('click', async function() {
            const folderPath = document.getElementById('deleteFolderPath').value;
            if (!folderPath) {
                showError('文件夹路径为空');
                return;
            }
            
            btnConfirmDelete.disabled = true;
            btnConfirmDelete.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 删除中...';
            
            try {
                const result = await apiRequest('/api/delete-folder', 'DELETE', { folderPath });
                
                if (result.success) {
                    showSuccess(result.message);
                    closeDeleteFolderModal();
                    // 从缓存中删除文件夹
                    removeFolderFromCache(folderPath);
                    await loadFolderData(currentFolderPath, folderCurrentPage, FOLDER_PAGE_SIZE, folderSearchKeyword || undefined);
                    refreshFolderTreeOnly();
                } else {
                    showError(result.error || '删除失败');
                }
            } catch (error) {
                console.error('删除文件夹失败:', error);
                showError('删除失败');
            } finally {
                btnConfirmDelete.disabled = false;
                btnConfirmDelete.innerHTML = '<i class="fas fa-trash"></i> 确认删除';
            }
        });
    }
});

// 重命名文件夹相关函数
async function openRenameFolderModal(folderPath, folderName) {
    try {
        await requireLogin();
    } catch (e) {
        return;
    }
    const modal = document.getElementById('renameFolderModal');
    const pathInput = document.getElementById('renameFolderPath');
    const nameInput = document.getElementById('renameFolderInput');
    
    pathInput.value = folderPath;
    nameInput.value = folderName;
    
    modal.classList.add('show');
    document.body.style.overflow = 'hidden';
    
    // 自动选中输入框文本
    setTimeout(() => {
        nameInput.focus();
        nameInput.select();
    }, 100);
}

function closeRenameFolderModal() {
    const modal = document.getElementById('renameFolderModal');
    modal.classList.remove('show');
    document.body.style.overflow = '';
}

// 解散文件夹相关函数
async function openDissolveFolderModal(folderPath, folderName) {
    try {
        await requireLogin();
    } catch (e) {
        return;
    }
    const modal = document.getElementById('dissolveFolderModal');
    const pathInput = document.getElementById('dissolveFolderPath');
    const nameDisplay = document.getElementById('dissolveFolderNameDisplay');
    
    pathInput.value = folderPath;
    nameDisplay.textContent = folderName;
    
    modal.classList.add('show');
    document.body.style.overflow = 'hidden';
}

function closeDissolveFolderModal() {
    const modal = document.getElementById('dissolveFolderModal');
    modal.classList.remove('show');
    document.body.style.overflow = '';
}

// 确认解散文件夹
document.addEventListener('DOMContentLoaded', function() {
    const btnConfirmDissolve = document.getElementById('btnConfirmDissolveFolder');
    if (btnConfirmDissolve) {
        btnConfirmDissolve.addEventListener('click', async function() {
            const folderPath = document.getElementById('dissolveFolderPath').value;
            if (!folderPath) {
                showError('文件夹路径为空');
                return;
            }
            
            btnConfirmDissolve.disabled = true;
            btnConfirmDissolve.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 解散中...';
            
            try {
                const result = await apiRequest('/api/dissolve-folder', 'POST', { folderPath });
                
                if (result.success) {
                    showSuccess(result.message);
                    closeDissolveFolderModal();
                    // 从缓存中删除文件夹
                    removeFolderFromCache(folderPath);
                    await loadFolderData(currentFolderPath, folderCurrentPage, FOLDER_PAGE_SIZE, folderSearchKeyword || undefined);
                    refreshFolderTreeOnly();
                } else {
                    showError(result.error || '解散失败');
                }
            } catch (error) {
                console.error('解散文件夹失败:', error);
                showError('解散失败');
            } finally {
                btnConfirmDissolve.disabled = false;
                btnConfirmDissolve.innerHTML = '<i class="fas fa-box-open"></i> 确认解散';
            }
        });
    }
});

// 打开重命名音乐文件对话框
async function openRenameFileModal(filePath, fileName) {
    try {
        await requireLogin();
    } catch (e) {
        return;
    }
    const modal = document.getElementById('renameFileModal');
    const pathInput = document.getElementById('renameFilePath');
    const nameInput = document.getElementById('renameFileInput');
    
    pathInput.value = filePath;
    // 去掉扩展名
    const nameWithoutExt = fileName.replace(/\.[^.]+$/, '');
    nameInput.value = nameWithoutExt;
    
    modal.classList.add('show');
    document.body.style.overflow = 'hidden';
    
    // 自动选中输入框文本
    setTimeout(() => {
        nameInput.focus();
        nameInput.select();
    }, 100);
}

// 关闭重命名音乐文件对话框
function closeRenameFileModal() {
    const modal = document.getElementById('renameFileModal');
    modal.classList.remove('show');
    document.body.style.overflow = '';
}

// 确认重命名文件夹
document.addEventListener('DOMContentLoaded', function() {
    const btnConfirmRename = document.getElementById('btnConfirmRenameFolder');
    if (btnConfirmRename) {
        btnConfirmRename.addEventListener('click', async function() {
            const folderPath = document.getElementById('renameFolderPath').value;
            const newName = document.getElementById('renameFolderInput').value.trim();
            
            if (!folderPath) {
                showError('文件夹路径为空');
                return;
            }
            
            if (!newName) {
                showError('文件夹名称不能为空');
                return;
            }
            
            // 检查非法字符
            const invalidChars = /[\\/:*?"<>|]/;
            if (invalidChars.test(newName)) {
                showError('文件夹名称包含非法字符');
                return;
            }
            
            btnConfirmRename.disabled = true;
            btnConfirmRename.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 重命名中...';
            
            try {
                const result = await apiRequest('/api/rename-folder', 'POST', { 
                    folderPath, 
                    newName 
                });
                
                if (result.success) {
                    showSuccess(result.message);
                    closeRenameFolderModal();
                    // 更新缓存中的文件夹名称
                    const parentPath = folderPath.substring(0, folderPath.lastIndexOf('/'));
                    const newPath = parentPath ? `${parentPath}/${newName}` : newName;
                    renameFolderInCache(folderPath, newPath, newName);
                    await loadFolderData(currentFolderPath, folderCurrentPage, FOLDER_PAGE_SIZE, folderSearchKeyword || undefined);
                    refreshFolderTreeOnly();
                } else {
                    showError(result.error || '重命名失败');
                }
            } catch (error) {
                console.error('重命名文件夹失败:', error);
                showError('重命名失败');
            } finally {
                btnConfirmRename.disabled = false;
                btnConfirmRename.innerHTML = '<i class="fas fa-save"></i> 确认重命名';
            }
        });
    }
    
    // 回车键确认重命名
    const renameInput = document.getElementById('renameFolderInput');
    if (renameInput) {
        renameInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                document.getElementById('btnConfirmRenameFolder').click();
            }
        });
    }
    
    // 确认重命名音乐文件
    const btnConfirmRenameFile = document.getElementById('btnConfirmRenameFile');
    if (btnConfirmRenameFile) {
        btnConfirmRenameFile.addEventListener('click', async function() {
            const filePath = document.getElementById('renameFilePath').value;
            const newName = document.getElementById('renameFileInput').value.trim();
            
            if (!filePath) {
                showError('文件路径为空');
                return;
            }
            
            if (!newName) {
                showError('文件名称不能为空');
                return;
            }
            
            // 检查非法字符
            const invalidChars = /[\\/:*?"<>|]/;
            if (invalidChars.test(newName)) {
                showError('文件名称包含非法字符');
                return;
            }
            
            btnConfirmRenameFile.disabled = true;
            btnConfirmRenameFile.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 重命名中...';
            
            try {
                const result = await apiRequest('/api/rename-file', 'POST', { 
                    filePath, 
                    newName 
                });
                
                if (result.success) {
                    showSuccess(result.message);
                    closeRenameFileModal();
                    // 更新缓存中的文件名称
                    const dir = filePath.substring(0, filePath.lastIndexOf('\\'));
                    const ext = filePath.substring(filePath.lastIndexOf('.'));
                    const newPath = dir ? `${dir}\\${newName}${ext}` : `${newName}${ext}`;
                    renameFileInCache(filePath, newPath);
                    await loadFolderData(currentFolderPath, folderCurrentPage, FOLDER_PAGE_SIZE, folderSearchKeyword || undefined);
                    refreshFolderTreeOnly();
                } else {
                    showError(result.error || '重命名失败');
                }
            } catch (error) {
                console.error('重命名音乐文件失败:', error);
                showError('重命名失败');
            } finally {
                btnConfirmRenameFile.disabled = false;
                btnConfirmRenameFile.innerHTML = '<i class="fas fa-save"></i> 确认重命名';
            }
        });
    }
    
    // 回车键确认重命名音乐文件
    const renameFileInput = document.getElementById('renameFileInput');
    if (renameFileInput) {
        renameFileInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                document.getElementById('btnConfirmRenameFile').click();
            }
        });
    }
});

// 初始化多选功能事件
function initSelectionBox() {
    const folderMusicList = document.getElementById('folderMusicList');
    if (!folderMusicList) return;
    
    // 只初始化一次全局事件
    if (!selectionBoxInitialized) {
        // 添加全局键盘事件监听器
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Control') {
                isCtrlPressed = true;
            }
        });
        document.addEventListener('keyup', (e) => {
            if (e.key === 'Control') {
                isCtrlPressed = false;
            }
        });
        selectionBoxInitialized = true;
    }
    
    // 每次渲染都重新绑定事件（因为DOM被替换了）
    folderMusicList.addEventListener('mousedown', handleMouseDownOnFile);
    // 阻止浏览器默认的checkbox toggle，由mousedown统一控制
    folderMusicList.addEventListener('click', function(e) {
        if (e.target.closest('.folder-music-checkbox')) {
            e.preventDefault();
        }
    });
}

// 鼠标点击文件处理
function handleMouseDownOnFile(e) {
    if (e.button !== 0) return;
    
    // 判断是否点击在文件项上
    const clickedItem = e.target.closest('.folder-music-item');
    if (!clickedItem) return;
    
    // 点击操作按钮区域时不处理选中
    if (e.target.closest('.folder-music-actions')) return;
    
    // 点击复选框时，阻止浏览器默认行为，统一由本函数处理选中逻辑
    const isCheckboxClick = !!e.target.closest('.folder-music-checkbox');
    if (isCheckboxClick) {
        e.preventDefault();
    }
    
    // 获取点击的文件项索引
    const allItems = Array.from(document.querySelectorAll('.folder-music-item'));
    const clickedIndex = allItems.indexOf(clickedItem);
    const clickedFilePath = clickedItem.dataset.path.replace(/\\\\/g, '\\');
    
    // 点击复选框时：切换当前项，保留其他选中状态
    if (isCheckboxClick) {
        if (selectedMusicFiles.has(clickedFilePath)) {
            selectedMusicFiles.delete(clickedFilePath);
            clickedItem.classList.remove('selected');
            const cb = clickedItem.querySelector('.folder-music-checkbox');
            if (cb) cb.checked = false;
        } else {
            selectedMusicFiles.add(clickedFilePath);
            clickedItem.classList.add('selected');
            const cb = clickedItem.querySelector('.folder-music-checkbox');
            if (cb) cb.checked = true;
        }
        updateBatchActions();
        lastClickedFileIndex = clickedIndex;
        return;
    }
    
    // 按住Shift键进行多选
    if (e.shiftKey && lastClickedFileIndex !== -1) {
        e.preventDefault();
        
        // 确定起始和结束索引
        const startIndex = Math.min(lastClickedFileIndex, clickedIndex);
        const endIndex = Math.max(lastClickedFileIndex, clickedIndex);
        
        // 选中范围内的所有文件
        for (let i = startIndex; i <= endIndex; i++) {
            const item = allItems[i];
            const filePath = item.dataset.path.replace(/\\\\/g, '\\');
            if (filePath) {
                selectedMusicFiles.add(filePath);
                item.classList.add('selected');
                const checkbox = item.querySelector('.folder-music-checkbox');
                if (checkbox) checkbox.checked = true;
            }
        }
        
        updateBatchActions();
        // 更新上次点击的索引
        lastClickedFileIndex = clickedIndex;
        return;
    }
    
    // 没有按住Shift键，正常处理
    // 清除之前的选中状态（除非按住Ctrl多选）
    if (!e.ctrlKey && !e.shiftKey) {
        document.querySelectorAll('.folder-music-item.selected').forEach(item => {
            item.classList.remove('selected');
            const checkbox = item.querySelector('.folder-music-checkbox');
            if (checkbox) checkbox.checked = false;
        });
        selectedMusicFiles.clear();
        updateBatchActions();
    }
    
    // 如果没有按住Ctrl键选中，则选中当前项
    if (!e.ctrlKey) {
        selectedMusicFiles.add(clickedFilePath);
        clickedItem.classList.add('selected');
        const checkbox = clickedItem.querySelector('.folder-music-checkbox');
        if (checkbox) checkbox.checked = true;
        updateBatchActions();
    } else {
        // 按住Ctrl键，切换选中状态
        if (selectedMusicFiles.has(clickedFilePath)) {
            selectedMusicFiles.delete(clickedFilePath);
            clickedItem.classList.remove('selected');
            const checkbox = clickedItem.querySelector('.folder-music-checkbox');
            if (checkbox) checkbox.checked = false;
        } else {
            selectedMusicFiles.add(clickedFilePath);
            clickedItem.classList.add('selected');
            const checkbox = clickedItem.querySelector('.folder-music-checkbox');
            if (checkbox) checkbox.checked = true;
        }
        updateBatchActions();
    }
    
    // 更新上次点击的索引
    lastClickedFileIndex = clickedIndex;
}

// 渲染文件夹分区
function renderFolderSections() {
    const folderView = document.getElementById('folderView');
    
    let html = '<div class="folder-content">';
    
    if (currentFolders.length > 0 && !folderSearchKeyword) {
        html += '<div class="folder-section" id="folderSection">';
        html += '<h3 class="folder-section-title"><i class="fas fa-folder"></i> 文件夹</h3>';
        html += '<div class="folder-grid" id="folderGrid">';
        
        currentFolders.forEach(folder => {
            html += createFolderCardHTML(folder);
        });
        
        html += '</div></div>';
    }
    
    if (currentFiles.length > 0) {
        html += '<div class="folder-section" id="fileSection">';
        if (folderSearchKeyword) {
            html += `<h3 class="folder-section-title"><i class="fas fa-music"></i> 搜索结果</h3>`;
        } else {
            html += '<h3 class="folder-section-title"><i class="fas fa-music"></i> 音乐文件</h3>';
        }
        html += '<div class="folder-music-list" id="folderMusicList">';
        
        currentFiles.forEach((track, index) => {
            const globalIndex = (folderCurrentPage - 1) * FOLDER_PAGE_SIZE + index;
            html += createFileItemHTML(track, globalIndex, folderSearchKeyword);
        });
        
        html += '</div></div>';
    }
    
    if (folderSearchKeyword && currentFiles.length === 0) {
        html += `
            <div class="no-search-results">
                <i class="fas fa-search"></i>
                <p>未找到匹配的文件</p>
                <p class="empty-hint">尝试使用其他关键词搜索</p>
            </div>
        `;
    } else if (currentFolders.length === 0 && currentFiles.length === 0) {
        html += `
            <div class="folder-empty">
                <i class="fas fa-folder-open"></i>
                <p>暂无内容</p>
                <p class="empty-hint">请在 music/ 目录下添加音乐文件或创建文件夹</p>
            </div>
        `;
    }
    
    html += '</div>';
    folderView.innerHTML = html;
    
    renderFolderPagination(folderTotalFiles, folderTotalPages);
    
    initSelectionBox();
}

function renderFolderPagination(totalItems, totalPages) {
    const paginationEl = document.getElementById('folderPagination');
    
    if (!paginationEl || totalPages <= 1) {
        if (paginationEl) {
            paginationEl.innerHTML = '';
        }
        return;
    }
    
    const startItem = (folderCurrentPage - 1) * FOLDER_PAGE_SIZE + 1;
    const endItem = Math.min(folderCurrentPage * FOLDER_PAGE_SIZE, totalItems);
    
    let html = '<div class="pagination-container">';
    
    html += '<div class="pagination-info">';
    html += `显示 ${startItem}-${endItem} 条，共 ${totalItems} 条`;
    html += '</div>';
    
    html += '<div class="pagination-controls-wrapper">';
    html += '<div class="pagination-controls">';
    
    html += `<button class="pagination-btn mobile-visible ${folderCurrentPage === 1 ? 'disabled' : ''}" 
        onclick="changeFolderPage(1)" ${folderCurrentPage === 1 ? 'disabled' : ''}>
        <i class="fas fa-angle-double-left"></i>
    </button>`;
    
    html += `<button class="pagination-btn mobile-visible ${folderCurrentPage === 1 ? 'disabled' : ''}" 
        onclick="changeFolderPage(${folderCurrentPage - 1})" ${folderCurrentPage === 1 ? 'disabled' : ''}>
        <i class="fas fa-angle-left"></i>
    </button>`;
    
    // 显示当前页码信息（移动端使用）
    html += `<span class="pagination-current-page">${folderCurrentPage} / ${totalPages}</span>`;
    
    // 桌面端显示页码数字
    const maxVisiblePages = 5;
    let startPage = Math.max(1, folderCurrentPage - Math.floor(maxVisiblePages / 2));
    let endPage = Math.min(totalPages, startPage + maxVisiblePages - 1);
    
    if (endPage - startPage < maxVisiblePages - 1) {
        startPage = Math.max(1, endPage - maxVisiblePages + 1);
    }
    
    if (startPage > 1) {
        html += `<button class="pagination-btn" onclick="changeFolderPage(1)">1</button>`;
        if (startPage > 2) {
            html += '<span class="pagination-ellipsis">...</span>';
        }
    }
    
    for (let i = startPage; i <= endPage; i++) {
        html += `<button class="pagination-btn ${i === folderCurrentPage ? 'active' : ''}" 
            onclick="changeFolderPage(${i})">${i}</button>`;
    }
    
    if (endPage < totalPages) {
        if (endPage < totalPages - 1) {
            html += '<span class="pagination-ellipsis">...</span>';
        }
        html += `<button class="pagination-btn" onclick="changeFolderPage(${totalPages})">${totalPages}</button>`;
    }
    
    html += `<button class="pagination-btn mobile-visible ${folderCurrentPage === totalPages ? 'disabled' : ''}" 
        onclick="changeFolderPage(${folderCurrentPage + 1})" ${folderCurrentPage === totalPages ? 'disabled' : ''}>
        <i class="fas fa-angle-right"></i>
    </button>`;
    
    html += `<button class="pagination-btn mobile-visible ${folderCurrentPage === totalPages ? 'disabled' : ''}" 
        onclick="changeFolderPage(${totalPages})" ${folderCurrentPage === totalPages ? 'disabled' : ''}>
        <i class="fas fa-angle-double-right"></i>
    </button>`;
    
    // 桌面端快速跳转输入框
    html += '<div class="pagination-jump desktop-visible">';
    html += `<input type="number" class="pagination-jump-input" id="folderJumpPage" 
        min="1" max="${totalPages}" placeholder="页码" value="${folderCurrentPage}">`;
    html += `<button class="pagination-jump-btn" onclick="jumpToFolderPage(${totalPages})">跳转</button>`;
    html += '</div>';
    
    html += '</div>';
    html += '</div>';
    
    html += '<div class="pagination-size">';
    html += `<span>每页</span>`;
    html += `<select class="pagination-size-select" onchange="changeFolderPageSize(this.value)">`;
    html += `<option value="10" ${FOLDER_PAGE_SIZE === 10 ? 'selected' : ''}>10</option>`;
    html += `<option value="20" ${FOLDER_PAGE_SIZE === 20 ? 'selected' : ''}>20</option>`;
    html += `<option value="30" ${FOLDER_PAGE_SIZE === 30 ? 'selected' : ''}>30</option>`;
    html += `<option value="50" ${FOLDER_PAGE_SIZE === 50 ? 'selected' : ''}>50</option>`;
    html += `<option value="100" ${FOLDER_PAGE_SIZE === 100 ? 'selected' : ''}>100</option>`;
    html += `</select>`;
    html += `<span>条</span>`;
    html += '</div>';
    
    html += '</div>';
    
    paginationEl.innerHTML = html;
}

async function changeFolderPage(page) {
    if (page < 1 || page > folderTotalPages) return;
    await loadFolderData(currentFolderPath, page, FOLDER_PAGE_SIZE, folderSearchKeyword || undefined);
    const folderView = document.getElementById('folderView');
    if (folderView) {
        folderView.scrollTop = 0;
    }
}

async function changeFolderPageSize(size) {
    FOLDER_PAGE_SIZE = parseInt(size);
    folderCurrentPage = 1;
    await loadFolderData(currentFolderPath, 1, FOLDER_PAGE_SIZE, folderSearchKeyword || undefined);
}

async function jumpToFolderPage(totalPages) {
    const input = document.getElementById('folderJumpPage');
    if (!input) return;
    
    let page = parseInt(input.value);
    if (isNaN(page)) page = 1;
    page = Math.max(1, Math.min(page, totalPages));
    
    input.value = page;
    await changeFolderPage(page);
}

// 添加文件夹到视图
function addFolderToView(folder) {
    const folderGrid = document.getElementById('folderGrid');
    if (folderGrid) {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = createFolderCardHTML(folder);
        folderGrid.appendChild(tempDiv.firstElementChild);
    }
}

// 添加文件到视图
function addFileToView(track, index) {
    const fileList = document.getElementById('fileList');
    if (fileList) {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = createFileItemHTML(track, index);
        fileList.appendChild(tempDiv.firstElementChild);
    }
}

// 创建文件夹卡片 HTML
function createFolderCardHTML(folder) {
    const escapedPath = folder.path.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const folderName = folder.name.replace(/'/g, "\\'");
    // 构建完整的目标路径（以 /music 开头）
    const fullTargetPath = folder.path.startsWith('/') ? folder.path : `/music/${folder.path}`;
    const escapedTargetPath = fullTargetPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    
    return `
        <div class="folder-card" 
             onclick="openFolder('${escapedPath}')"
             oncontextmenu="showFolderContextMenu(event, '${escapedPath}', '${folderName}')"
             ondragover="event.preventDefault(); event.dataTransfer.dropEffect='move'; this.classList.add('drag-over');"
             ondragleave="this.classList.remove('drag-over');"
             ondrop="event.preventDefault(); this.classList.remove('drag-over'); handleDropToFolder('${escapedTargetPath}', event);">
            <div class="folder-icon">
                <i class="fas fa-folder"></i>
            </div>
            <div class="folder-info">
                <div class="folder-name">${folder.name}</div>
                <div class="folder-meta">
                    <span><i class="fas fa-music"></i> ${folder.musicCount} 首</span>
                    ${folder.hasSubFolders ? '<span><i class="fas fa-folder"></i> 包含子文件夹</span>' : ''}
                </div>
            </div>
            <div class="folder-card-actions">
                <button onclick="event.stopPropagation(); playFolder('${escapedPath}')" class="folder-icon-btn folder-play-btn" title="播放此文件夹">
                    <i class="fas fa-play"></i>
                </button>
                <button onclick="event.stopPropagation(); addFolderToPlaylist('${escapedPath}')" class="folder-icon-btn folder-add-btn" title="加入播放列表">
                    <i class="fas fa-plus"></i>
                </button>
                <button onclick="event.stopPropagation(); moveFolder('${escapedPath}', '${folderName}')" class="folder-icon-btn folder-move-btn" title="移动">
                    <i class="fas fa-arrows-alt"></i>
                </button>
                <button onclick="event.stopPropagation(); downloadFolder('${escapedPath}')" class="folder-icon-btn folder-download-btn" title="下载">
                    <i class="fas fa-download"></i>
                </button>
                <button onclick="event.stopPropagation(); openConvertFolderToMp3Modal('${escapedPath}', '${folderName}')" class="folder-icon-btn folder-convert-btn" title="转MP3">
                    <i class="fas fa-exchange-alt"></i>
                </button>
                <button onclick="event.stopPropagation(); openRenameFolderModal('${escapedPath}', '${folderName}')" class="folder-icon-btn folder-rename-btn" title="重命名">
                    <i class="fas fa-edit"></i>
                </button>
                <button onclick="event.stopPropagation(); openDissolveFolderModal('${escapedPath}', '${folderName}')" class="folder-icon-btn folder-dissolve-btn" title="解散">
                    <i class="fas fa-box-open"></i>
                </button>
                <button onclick="event.stopPropagation(); openDeleteFolderModal('${escapedPath}', '${folderName}')" class="folder-icon-btn folder-delete-btn" title="删除">
                    <i class="fas fa-trash"></i>
                </button>
                <button onclick="event.stopPropagation(); toggleFolderCardMenu(event, '${escapedPath}', '${folderName}')" class="folder-icon-btn folder-card-menu-btn" title="更多操作">
                    <i class="fas fa-ellipsis-v"></i>
                </button>
            </div>
        </div>
    `;
}

// 创建文件项 HTML
function createFileItemHTML(track, index, searchKeyword = '') {
    const escapedPath = track.path.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const escapedFilename = (track.filename || track.title).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const highlightedTitle = highlightText(track.title, searchKeyword);
    const highlightedArtist = highlightText(track.artist, searchKeyword);
    
    return `
        <div class="folder-music-item" data-path="${escapedPath}" draggable="true" ondragstart="handleDragStart(event, '${escapedPath}')" oncontextmenu="showFileContextMenu(event, '${escapedPath}')">
            <input type="checkbox" class="folder-music-checkbox" data-path="${escapedPath}">
            <div class="folder-music-index">${index + 1}</div>
            <div class="folder-music-icon">
                <i class="fas fa-music"></i>
            </div>
            <div class="folder-music-info">
                <div class="folder-music-title">${highlightedTitle}</div>
                <div class="folder-music-artist">${highlightedArtist}</div>
            </div>
            <div class="folder-music-duration">${formatDuration(track.duration)}</div>
            <div class="folder-music-actions">
                <button onclick="playTrackFromFolder('${escapedPath}')" class="folder-music-action-btn folder-music-play-btn" title="播放">
                    <i class="fas fa-play"></i>
                </button>
                <button onclick="addToPlaylist('${escapedPath}')" class="folder-music-action-btn folder-music-add-btn" title="加入播放列表">
                    <i class="fas fa-plus"></i>
                </button>
                <button onclick="openRenameFileModal('${escapedPath}', '${escapedFilename}')" class="folder-music-action-btn folder-music-rename-btn" title="重命名">
                    <i class="fas fa-font"></i>
                </button>
                <button onclick="moveSingleFile('${escapedPath}')" class="folder-music-action-btn folder-music-move-btn" title="移动">
                    <i class="fas fa-arrows-alt"></i>
                </button>
                <button onclick="downloadTrack('${escapedPath}')" class="folder-music-action-btn folder-music-download-btn" title="下载文件">
                    <i class="fas fa-download"></i>
                </button>
                <button onclick="openEditMetadataModal('${escapedPath}')" class="folder-music-action-btn folder-music-edit-btn" title="编辑属性">
                    <i class="fas fa-edit"></i>
                </button>
                <button onclick="openConvertToMp3Modal('${escapedPath}')" class="folder-music-action-btn folder-music-convert-btn" title="转MP3">
                    <i class="fas fa-exchange-alt"></i>
                </button>
                <button onclick="openDeleteModal('${escapedPath}', true)" class="folder-music-action-btn folder-music-delete-btn" title="删除文件">
                    <i class="fas fa-trash"></i>
                </button>
                <button onclick="toggleFileMenu(event, '${escapedPath}')" class="folder-music-action-btn folder-music-menu-btn folder-music-menu-btn-mobile" title="更多">
                    <i class="fas fa-ellipsis-v"></i>
                </button>
            </div>
        </div>
    `;
}

// 关闭所有上下文菜单
function closeAllContextMenus() {
    closeFileContextMenu();
    closeFolderContextMenu();
    const folderMoreMenu = document.getElementById('folderMoreMenu');
    if (folderMoreMenu) folderMoreMenu.style.display = 'none';
    const batchMoreMenu = document.getElementById('batchMoreMenu');
    if (batchMoreMenu) batchMoreMenu.style.display = 'none';
    const topBarMoreMenu = document.getElementById('topBarMoreMenu');
    if (topBarMoreMenu) topBarMoreMenu.style.display = 'none';
}

// 文件操作菜单（右键 / 小屏幕更多按钮共用）
function showFileContextMenu(event, filePath, anchorRect) {
    event.preventDefault();
    event.stopPropagation();
    
    closeAllContextMenus();
    
    const menu = document.createElement('div');
    menu.className = 'folder-file-context-menu';
    menu.id = 'fileContextMenu';
    menu.innerHTML = `
        <div class="context-menu-item" onclick="event.stopPropagation(); playTrackFromFolder('${filePath.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'); closeFileContextMenu();">
            <i class="fas fa-play"></i>
            <span>播放</span>
        </div>
        <div class="context-menu-item" onclick="event.stopPropagation(); addToPlaylist('${filePath.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'); closeFileContextMenu();">
            <i class="fas fa-plus"></i>
            <span>加入播放列表</span>
        </div>
        <div class="context-menu-divider"></div>
        <div class="context-menu-item" onclick="event.stopPropagation(); downloadTrack('${filePath.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'); closeFileContextMenu();">
            <i class="fas fa-download"></i>
            <span>下载</span>
        </div>
        <div class="context-menu-item" onclick="event.stopPropagation(); moveSingleFile('${filePath.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'); closeFileContextMenu();">
            <i class="fas fa-arrows-alt"></i>
            <span>移动</span>
        </div>
        <div class="context-menu-item" onclick="event.stopPropagation(); openRenameFileModal('${filePath.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}', '${(filePath.split(/[\\/]/).pop() || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'); closeFileContextMenu();">
            <i class="fas fa-font"></i>
            <span>重命名</span>
        </div>
        <div class="context-menu-divider"></div>
        <div class="context-menu-item" onclick="event.stopPropagation(); openEditMetadataModal('${filePath.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'); closeFileContextMenu();">
            <i class="fas fa-edit"></i>
            <span>编辑属性</span>
        </div>
        <div class="context-menu-item" onclick="event.stopPropagation(); openConvertToMp3Modal('${filePath.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'); closeFileContextMenu();">
            <i class="fas fa-exchange-alt"></i>
            <span>转MP3</span>
        </div>
        <div class="context-menu-divider"></div>
        <div class="context-menu-item context-menu-item-danger" onclick="event.stopPropagation(); openDeleteModal('${filePath.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}', true); closeFileContextMenu();">
            <i class="fas fa-trash"></i>
            <span>删除</span>
        </div>
    `;
    
    menu.style.top = `${event.clientY + window.scrollY}px`;
    menu.style.left = `${event.clientX + window.scrollX}px`;
    
    document.body.appendChild(menu);
    
    setTimeout(() => {
        const menuRect = menu.getBoundingClientRect();
        const refX = event.clientX + window.scrollX;
        const refY = event.clientY + window.scrollY;
        if (menuRect.right > window.innerWidth) {
            menu.style.left = `${refX - menuRect.width}px`;
        }
        if (menuRect.bottom > window.innerHeight) {
            menu.style.top = `${refY - menuRect.height}px`;
        }
    }, 0);
    
    document.addEventListener('click', closeFileContextMenu, { once: true });
}

function closeFileContextMenu() {
    const menu = document.getElementById('fileContextMenu');
    if (menu) {
        menu.remove();
    }
}

// 文件夹右键菜单
function showFolderContextMenu(event, folderPath, folderName) {
    event.preventDefault();
    event.stopPropagation();
    
    closeAllContextMenus();
    
    const menu = document.createElement('div');
    menu.className = 'folder-file-context-menu';
    menu.id = 'folderContextMenu';
    menu.innerHTML = `
        <div class="context-menu-item" onclick="event.stopPropagation(); playFolder('${folderPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'); closeFolderContextMenu();">
            <i class="fas fa-play"></i>
            <span>播放</span>
        </div>
        <div class="context-menu-item" onclick="event.stopPropagation(); addFolderToPlaylist('${folderPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'); closeFolderContextMenu();">
            <i class="fas fa-plus"></i>
            <span>加入播放列表</span>
        </div>
        <div class="context-menu-divider"></div>
        <div class="context-menu-item" onclick="event.stopPropagation(); downloadFolder('${folderPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'); closeFolderContextMenu();">
            <i class="fas fa-download"></i>
            <span>下载</span>
        </div>
        <div class="context-menu-item" onclick="event.stopPropagation(); moveFolder('${folderPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}', '${folderName.replace(/'/g, "\\'")}'); closeFolderContextMenu();">
            <i class="fas fa-arrows-alt"></i>
            <span>移动</span>
        </div>
        <div class="context-menu-item" onclick="event.stopPropagation(); openConvertFolderToMp3Modal('${folderPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}', '${folderName.replace(/'/g, "\\'")}'); closeFolderContextMenu();">
            <i class="fas fa-exchange-alt"></i>
            <span>转MP3</span>
        </div>
        <div class="context-menu-divider"></div>
        <div class="context-menu-item" onclick="event.stopPropagation(); openRenameFolderModal('${folderPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}', '${folderName.replace(/'/g, "\\'")}'); closeFolderContextMenu();">
            <i class="fas fa-edit"></i>
            <span>重命名</span>
        </div>
        <div class="context-menu-item" onclick="event.stopPropagation(); openDissolveFolderModal('${folderPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}', '${folderName.replace(/'/g, "\\'")}'); closeFolderContextMenu();">
            <i class="fas fa-box-open"></i>
            <span>解散</span>
        </div>
        <div class="context-menu-divider"></div>
        <div class="context-menu-item context-menu-item-danger" onclick="event.stopPropagation(); openDeleteFolderModal('${folderPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}', '${folderName.replace(/'/g, "\\'")}'); closeFolderContextMenu();">
            <i class="fas fa-trash"></i>
            <span>删除</span>
        </div>
    `;
    
    menu.style.top = `${event.clientY + window.scrollY}px`;
    menu.style.left = `${event.clientX + window.scrollX}px`;
    
    document.body.appendChild(menu);
    
    setTimeout(() => {
        const menuRect = menu.getBoundingClientRect();
        const refX = event.clientX + window.scrollX;
        const refY = event.clientY + window.scrollY;
        if (menuRect.right > window.innerWidth) {
            menu.style.left = `${refX - menuRect.width}px`;
        }
        if (menuRect.bottom > window.innerHeight) {
            menu.style.top = `${refY - menuRect.height}px`;
        }
    }, 0);
    
    document.addEventListener('click', closeFolderContextMenu, { once: true });
}

function closeFolderContextMenu() {
    const menu = document.getElementById('folderContextMenu');
    if (menu) {
        menu.remove();
    }
}

// 小屏幕"更多"按钮
function toggleFileMenu(event, filePath) {
    const rect = event.target.getBoundingClientRect();
    showFileContextMenu(event, filePath, rect);
}

// 文件夹更多菜单
function toggleFolderMoreMenu(event) {
    event.stopPropagation();
    closeAllContextMenus();
    const menu = document.getElementById('folderMoreMenu');
    if (menu) {
        const isVisible = menu.style.display !== 'none';
        menu.style.display = isVisible ? 'none' : 'block';
        
        if (!isVisible) {
            setTimeout(() => {
                document.addEventListener('click', closeFolderMoreMenu, { once: true });
            }, 0);
        }
    }
}

function closeFolderMoreMenu() {
    const menu = document.getElementById('folderMoreMenu');
    if (menu) {
        menu.style.display = 'none';
    }
}

// 文件夹卡片菜单按钮（小屏幕更多按钮）
function toggleFolderCardMenu(event, folderPath, folderName) {
    event.stopPropagation();
    const rect = event.target.getBoundingClientRect();
    showFolderContextMenu(event, folderPath, folderName, rect);
}

// 全局点击关闭所有菜单
document.addEventListener('click', function(e) {
    // 关闭批量操作菜单
    if (!e.target.closest('.batch-more-menu-wrapper') && !e.target.closest('.batch-more-menu')) {
        const batchMenu = document.getElementById('batchMoreMenu');
        if (batchMenu) batchMenu.style.display = 'none';
    }
    
    // 关闭顶部栏菜单
    if (!e.target.closest('.top-bar-more-wrapper') && !e.target.closest('.top-bar-more-menu')) {
        const topMenu = document.getElementById('topBarMoreMenu');
        if (topMenu) topMenu.style.display = 'none';
    }
});

function closeFolderCardMenu(menuId) {
    const menu = document.getElementById(menuId);
    if (menu) {
        menu.style.display = 'none';
        // 重置父级文件夹卡片的 z-index
        const card = menu.closest('.folder-card');
        if (card) card.style.zIndex = '';
    }
}

// 批量操作菜单
function toggleBatchMoreMenu(event) {
    event.stopPropagation();
    closeAllContextMenus();
    const menu = document.getElementById('batchMoreMenu');
    if (menu) {
        const isVisible = menu.style.display !== 'none';
        menu.style.display = isVisible ? 'none' : 'block';
        
        if (!isVisible) {
            setTimeout(() => {
                document.addEventListener('click', closeBatchMoreMenu, { once: true });
            }, 0);
        }
    }
}

function closeBatchMoreMenu() {
    const menu = document.getElementById('batchMoreMenu');
    if (menu) {
        menu.style.display = 'none';
    }
}

// 更新批量菜单按钮状态
function updateBatchMenuStatus() {
    const hasSelection = selectedFiles.size > 0;
    const menuItems = ['batchMenuAdd', 'batchMenuMove', 'batchMenuDownload', 'batchMenuConvert', 'batchMenuDelete'];
    
    menuItems.forEach(id => {
        const item = document.getElementById(id);
        if (item) {
            if (id === 'batchMenuDelete' || id === 'batchMenuConvert') {
                item.style.opacity = hasSelection ? '1' : '0.5';
                item.style.pointerEvents = hasSelection ? 'auto' : 'none';
            } else {
                item.style.opacity = hasSelection ? '1' : '0.5';
                item.style.pointerEvents = hasSelection ? 'auto' : 'none';
            }
        }
    });
}

// 打开文件夹（优先使用缓存）
async function openFolder(folderPath) {
    currentFolderPath = folderPath;
    folderCurrentPage = 1;
    folderSearchKeyword = '';
    
    const searchInput = document.getElementById('folderSearchInput');
    const searchClear = document.getElementById('folderSearchClear');
    if (searchInput) searchInput.value = '';
    if (searchClear) searchClear.style.display = 'none';
    
    // 更新面包屑导航
    updateBreadcrumb(folderPath);
    
    await loadFolderData(folderPath, 1, FOLDER_PAGE_SIZE);
}

// 返回上级文件夹
function goBack() {
    if (!currentFolderPath) {
        loadFolders();
        return;
    }
    
    const pathParts = currentFolderPath.split('/');
    pathParts.pop();
    const parentPath = pathParts.join('/');
    
    if (parentPath) {
        openFolder(parentPath);
    } else {
        currentFolderPath = '';
        loadFolders();
    }
}

// 更新面包屑导航
function updateBreadcrumb(folderPath) {
    const breadcrumb = document.getElementById('folderBreadcrumb');
    const isMobile = window.innerWidth <= 768;
    
    if (!folderPath) {
        breadcrumb.innerHTML = `
            <i class="fas fa-home"></i>
            <span>文件管理</span>
        `;
        return;
    }
    
    const pathParts = folderPath.split('/');
    
    // 移动端简化面包屑显示
    if (isMobile) {
        const currentFolder = pathParts[pathParts.length - 1];
        breadcrumb.innerHTML = `
            <i class="fas fa-arrow-left" onclick="goBack()" style="cursor: pointer; margin-right: 8px;"></i>
            <i class="fas fa-home" onclick="loadFolders()" style="cursor: pointer;"></i>
            <span class="breadcrumb-separator">/</span>
            <span title="${folderPath}">${currentFolder}</span>
        `;
        return;
    }
    
    // 桌面端显示完整路径
    let html = '<i class="fas fa-home" onclick="loadFolders()" style="cursor: pointer;"></i>';
    
    let currentPath = '';
    pathParts.forEach((part, index) => {
        currentPath = currentPath ? currentPath + '/' + part : part;
        if (index === pathParts.length - 1) {
            html += ` <span class="breadcrumb-separator">/</span> <span>${part}</span>`;
        } else {
            html += ` <span class="breadcrumb-separator">/</span> <span class="breadcrumb-link" onclick="openFolder('${currentPath}')">${part}</span>`;
        }
    });
    
    breadcrumb.innerHTML = html;
}

// 刷新文件夹 - 重新加载缓存的 JSON 文件
let isRefreshing = false;
async function refreshFolders() {
    if (isRefreshing) return;
    isRefreshing = true;
    
    const btnRefresh = document.querySelector('.folder-refresh-btn');
    if (btnRefresh) {
        btnRefresh.disabled = true;
        btnRefresh.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 刷新中...';
    }
    
    try {
        // 从服务器重新加载缓存数据，添加时间戳避免浏览器缓存
        const response = await fetch(`/api/folder-cache?_=${Date.now()}`);
        const result = await response.json();
        
        if (result.success && result.data) {
            folderCacheData = result.data;
            showNotification({ type: 'success', message: '文件列表已刷新' });
        } else {
            folderCacheData = null;
        }
        
        // 重新渲染当前文件夹视图
        if (currentFolderPath) {
            openFolder(currentFolderPath);
        } else {
            loadFolders();
        }
    } catch (error) {
        console.error('刷新失败:', error);
        showError('刷新失败: ' + error.message);
    } finally {
        isRefreshing = false;
        // 重新获取按钮引用，因为 DOM 可能已被重新渲染
        const btnRefreshNow = document.querySelector('.folder-refresh-btn');
        if (btnRefreshNow) {
            btnRefreshNow.disabled = false;
            btnRefreshNow.innerHTML = '<i class="fas fa-sync-alt"></i> 刷新';
        }
    }
}

// 播放整个文件夹
async function playFolder(folderPath) {
    try {
        showNotification({ type: 'info', message: '正在加载文件夹...' });
        
        const result = await apiRequest('/api/folder-play', 'POST', { folderPath });
        
        if (!result.success) {
            showError(result.error || '播放失败');
            return;
        }
        
        // 刷新播放列表
        const playlistResult = await apiRequest('/api/playlist');
        if (playlistResult.playlist) {
            currentPlaylist = playlistResult.playlist;
        }
        
        if (playOutput === 'client' && result.clientMode) {
            // 客户端模式：用客户端播放第一首
            playTrack(0);
        } else {
            // 服务端模式：更新播放状态
            const statusResult = await apiRequest('/api/status');
            if (statusResult.current) {
                currentIndex = statusResult.currentIndex;
                isPlaying = statusResult.isPlaying;
                updateNowPlaying(statusResult.current);
                updatePlayPauseButton();
                
                if (statusResult.isPlaying) {
                    startProgressUpdate();
                } else {
                    stopProgressUpdate();
                }
            }
        }
        
        renderPlaylist();
        
        // 切换到播放列表视图
        switchView('music');
        
        showNotification({ type: 'success', message: `已加载 ${result.count} 首音乐` });
        
    } catch (error) {
        console.error('播放文件夹失败:', error);
        showError('播放文件夹失败');
    }
}

// 播放单曲（从文件夹视图）
async function playTrackFromFolder(filePath) {
    try {
        const result = await apiRequest('/api/play', 'POST', { path: filePath });
        
        if (!result.success) {
            showError(result.error || '播放失败');
            return;
        }
        
        // 刷新播放列表视图
        const playlistResult = await apiRequest('/api/playlist');
        if (playlistResult.playlist) {
            currentPlaylist = playlistResult.playlist;
        }
        
        if (playOutput === 'client' && result.clientMode) {
            // 客户端模式：找到歌曲索引并用客户端播放
            const index = result.index !== undefined ? result.index :
                currentPlaylist.findIndex(t => t.path === filePath || t.path.endsWith(filePath));
            if (index >= 0) {
                playTrack(index);
            }
        } else {
            // 服务端模式：更新播放状态
            isPlaying = true;
            if (result.current) {
                updateNowPlaying(result.current);
            }
            updatePlayPauseButton();
            startProgressUpdate();
        }
        
        renderPlaylist();
        
    } catch (error) {
        console.error('播放失败:', error);
        showError('播放失败');
    }
}

// 加入播放列表
async function addToPlaylist(filePath) {
    try {
        const result = await apiRequest('/api/add-to-playlist', 'POST', { path: filePath });
        
        if (!result.success) {
            showError(result.error || '添加失败');
            return;
        }
        
        showSuccess(result.message);
        
        // 刷新播放列表视图
        const playlistResult = await apiRequest('/api/playlist');
        if (playlistResult.playlist) {
            currentPlaylist = playlistResult.playlist;
            renderPlaylist();
        }
        
    } catch (error) {
        console.error('添加失败:', error);
        showError('添加失败');
    }
}

// 将文件夹添加到播放列表
async function addFolderToPlaylist(folderPath) {
    try {
        const result = await apiRequest('/api/add-folder-to-playlist', 'POST', { folderPath });
        
        if (!result.success) {
            showError(result.error || '添加失败');
            return;
        }
        
        showSuccess(result.message);
        
        // 刷新播放列表视图
        const playlistResult = await apiRequest('/api/playlist');
        if (playlistResult.playlist) {
            currentPlaylist = playlistResult.playlist;
            renderPlaylist();
        }
        
    } catch (error) {
        console.error('添加失败:', error);
        showError('添加失败');
    }
}

// 下载文件夹（打包为ZIP）
function downloadFolder(folderPath) {
    const folderName = folderPath.split(/[\\/]/).pop();
    const downloadUrl = `/api/download-folder?path=${encodeURIComponent(folderPath)}`;
    
    showNotification({
        type: 'info',
        message: `正在打包下载：${folderName}`,
        duration: 2000
    });
    
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = `${folderName}.zip`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// 移动文件夹
async function moveFolder(folderPath, folderName) {
    try {
        await requireLogin();
    } catch (e) {
        return;
    }
    const modal = document.getElementById('moveFolderModal');
    const pathInput = document.getElementById('moveFolderPath');
    const nameDisplay = document.getElementById('moveFolderNameDisplay');
    const targetInput = document.getElementById('moveFolderTargetInput');
    const btnConfirm = document.getElementById('btnConfirmMoveFolder');
    
    pathInput.value = folderPath;
    nameDisplay.textContent = folderName;
    targetInput.value = '';
    btnConfirm.disabled = true;
    
    modal.classList.add('show');
    document.body.style.overflow = 'hidden';
    
    // 监听输入框变化
    targetInput.addEventListener('input', function() {
        btnConfirm.disabled = !this.value.trim();
    });
}

function closeMoveFolderModal() {
    const modal = document.getElementById('moveFolderModal');
    modal.classList.remove('show');
    document.body.style.overflow = '';
}

// 确认移动文件夹
document.addEventListener('DOMContentLoaded', function() {
    const btnConfirmMoveFolder = document.getElementById('btnConfirmMoveFolder');
    if (btnConfirmMoveFolder) {
        btnConfirmMoveFolder.addEventListener('click', async function() {
            const folderPath = document.getElementById('moveFolderPath').value;
            const targetFolder = document.getElementById('moveFolderTargetInput').value.trim();
            
            if (!folderPath || !targetFolder) {
                showError('请填写完整信息');
                return;
            }
            
            btnConfirmMoveFolder.disabled = true;
            btnConfirmMoveFolder.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 移动中...';
            
            try {
                const result = await apiRequest('/api/move-folder', 'POST', { folderPath, targetFolder });
                
                if (result.success) {
                    showSuccess(result.message);
                    closeMoveFolderModal();
                    // 从缓存中删除原文件夹
                    removeFolderFromCache(folderPath);
                    await loadFolderData(currentFolderPath, folderCurrentPage, FOLDER_PAGE_SIZE, folderSearchKeyword || undefined);
                    refreshFolderTreeOnly();
                } else {
                    showError(result.error || '移动失败');
                }
            } catch (error) {
                console.error('移动文件夹失败:', error);
                showError('移动失败');
            } finally {
                btnConfirmMoveFolder.disabled = false;
                btnConfirmMoveFolder.innerHTML = '<i class="fas fa-arrows-alt"></i> 确认移动';
            }
        });
    }
});

// 转换文件夹为MP3
async function openConvertFolderToMp3Modal(folderPath, folderName) {
    try {
        await requireLogin();
    } catch (e) {
        return;
    }
    const modal = document.getElementById('convertFolderToMp3Modal');
    const pathInput = document.getElementById('convertFolderPath');
    const nameDisplay = document.getElementById('convertFolderName');
    
    pathInput.value = folderPath;
    nameDisplay.textContent = folderName;
    
    // 重置按钮状态
    const btn = document.getElementById('btnConfirmConvertFolder');
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-cog"></i> 开始转换';
    
    modal.classList.add('show');
    document.body.style.overflow = 'hidden';
}

function closeConvertFolderToMp3Modal() {
    if (isConverting) return;
    const modal = document.getElementById('convertFolderToMp3Modal');
    modal.classList.remove('show');
    document.body.style.overflow = '';
}

// 确认转换文件夹为MP3
document.addEventListener('DOMContentLoaded', function() {
    const btnConfirmConvertFolder = document.getElementById('btnConfirmConvertFolder');
    if (btnConfirmConvertFolder) {
        btnConfirmConvertFolder.addEventListener('click', async function() {
            const folderPath = document.getElementById('convertFolderPath').value;
            const quality = document.getElementById('convertFolderQuality').value;
            
            if (!folderPath) {
                showError('文件夹路径为空');
                return;
            }
            
            btnConfirmConvertFolder.disabled = true;
            btnConfirmConvertFolder.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 添加中...';
            
            try {
                const result = await apiRequest('/api/batch-convert-folder-mp3', 'POST', { folderPath, bitrate: quality });
                
                if (result.success) {
                    showSuccess(result.message);
                    closeConvertFolderToMp3Modal();
                } else {
                    showError(result.error || '转换失败');
                }
            } catch (error) {
                console.error('转换文件夹失败:', error);
                showError('转换失败');
            } finally {
                btnConfirmConvertFolder.disabled = false;
                btnConfirmConvertFolder.innerHTML = '<i class="fas fa-cog"></i> 开始转换';
            }
        });
    }
});

// 多选功能相关变量
let lastClickedFileIndex = -1;
let isCtrlPressed = false;
let selectionBoxInitialized = false;

// 批量操作相关变量
let selectedMusicFiles = new Set();


// 全选/取消全选
function toggleSelectAll() {
    const checkboxes = document.querySelectorAll('.folder-music-checkbox');
    const isAllSelected = selectedMusicFiles.size === checkboxes.length;
    
    checkboxes.forEach((checkbox, index) => {
        const filePath = currentFiles[index]?.path;
        if (filePath) {
            checkbox.checked = !isAllSelected;
            if (!isAllSelected) {
                selectedMusicFiles.add(filePath);
            } else {
                selectedMusicFiles.delete(filePath);
            }
        }
    });
    updateBatchActions();
}

// 更新批量操作按钮状态
function updateBatchActions() {
    const batchBar = document.getElementById('batchActionsBar');
    const selectAllBtn = document.getElementById('selectAllBtn');
    const batchActionBtns = document.querySelectorAll('.batch-action-btn');
    
    if (batchBar && selectAllBtn) {
        const checkboxes = document.querySelectorAll('.folder-music-checkbox');
        selectAllBtn.checked = selectedMusicFiles.size === checkboxes.length && checkboxes.length > 0;
        
        const hasSelection = selectedMusicFiles.size > 0;
        batchActionBtns.forEach(btn => {
            // 新建文件夹按钮不受选择状态影响
            if (btn.classList.contains('batch-new-folder-btn')) {
                return;
            }
            btn.disabled = !hasSelection;
        });
        
        updateBatchMenuStatus();
    }
}

// 批量加入播放列表
let isAddingToPlaylist = false;
async function batchAddToPlaylist() {
    if (isAddingToPlaylist) return;
    if (selectedMusicFiles.size === 0) return;
    
    isAddingToPlaylist = true;
    const btn = document.querySelector('.batch-add-btn');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    }
    
    try {
        const response = await fetch('/api/batch-add-to-playlist', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ files: Array.from(selectedMusicFiles) })
        });
        
        const result = await response.json();
        if (result.success) {
            showSuccess(result.message);
            const playlistResult = await apiRequest('/api/playlist');
            if (playlistResult.playlist) {
                currentPlaylist = playlistResult.playlist;
                renderPlaylist();
            }
            clearSelection();
        } else {
            showError(result.error || '添加失败');
        }
    } catch (error) {
        console.error('批量添加失败:', error);
        showError('添加失败');
    } finally {
        isAddingToPlaylist = false;
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-plus"></i>';
        }
    }
}

// 批量删除文件
function batchDeleteFiles() {
    if (selectedMusicFiles.size === 0) return;
    
    pendingDeletePaths = Array.from(selectedMusicFiles);
    openDeleteModal(pendingDeletePaths);
}

// 新建文件夹
async function createNewFolder() {
    try {
        await requireLogin();
    } catch (e) {
        return;
    }
    const modal = document.getElementById('newFolderModal');
    const input = document.getElementById('newFolderName');
    input.value = '';
    input.focus();
    modal.classList.add('show');
    document.body.style.overflow = 'hidden';
}

function closeNewFolderModal() {
    const modal = document.getElementById('newFolderModal');
    modal.classList.remove('show');
    document.body.style.overflow = '';
}

async function confirmCreateFolder() {
    const btnConfirm = document.getElementById('btnConfirmNewFolder');
    if (btnConfirm && btnConfirm.disabled) return;
    
    const input = document.getElementById('newFolderName');
    const folderName = input.value.trim();
    
    if (!folderName) {
        showError('请输入文件夹名称');
        return;
    }
    
    if (btnConfirm) {
        btnConfirm.disabled = true;
        btnConfirm.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 创建中...';
    }
    
    const parentPath = currentFolderPath ? `/music/${currentFolderPath}` : '/music';
    
    try {
        const response = await fetch('/api/create-folder', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                parentPath: parentPath,
                folderName: folderName
            })
        });
        
        const result = await response.json();
        if (result.success) {
            showSuccess(result.message);
            
            // 更新 folderCacheData，添加新创建的文件夹
            if (folderCacheData) {
                const targetPath = currentFolderPath || '';
                const newFolderData = {
                    name: folderName,
                    path: targetPath ? `${targetPath}/${folderName}` : folderName,
                    fullPath: '',
                    musicCount: 0,
                    hasSubFolders: false,
                    folders: [],
                    files: []
                };
                
                if (targetPath === '') {
                    // 根目录，直接添加
                    if (!folderCacheData.folders) folderCacheData.folders = [];
                    folderCacheData.folders.push(newFolderData);
                    folderCacheData.folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
                } else {
                    // 在子文件夹中找到目标并添加
                    const targetFolder = findFolderInCache(folderCacheData.folders, targetPath);
                    if (targetFolder) {
                        if (!targetFolder.folders) targetFolder.folders = [];
                        targetFolder.folders.push(newFolderData);
                        targetFolder.folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
                    }
                }
            }
            
            // 刷新当前文件夹视图
            await loadFolderData(currentFolderPath, folderCurrentPage, FOLDER_PAGE_SIZE, folderSearchKeyword || undefined);
        } else {
            showError(result.error || '创建失败');
        }
    } catch (error) {
        console.error('创建文件夹失败:', error);
        showError('创建失败');
    } finally {
        if (btnConfirm) {
            btnConfirm.disabled = false;
            btnConfirm.innerHTML = '<i class="fas fa-folder-plus"></i> 创建';
        }
        closeNewFolderModal();
    }
}

// 绑定新建文件夹确认按钮
document.addEventListener('DOMContentLoaded', () => {
    const btnConfirmNewFolder = document.getElementById('btnConfirmNewFolder');
    if (btnConfirmNewFolder) {
        btnConfirmNewFolder.addEventListener('click', confirmCreateFolder);
        
        // 绑定回车键
        const input = document.getElementById('newFolderName');
        if (input) {
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    confirmCreateFolder();
                }
            });
        }
    }
});

// 拖拽相关变量
let draggedFilePath = null;
let draggedElement = null;

// 开始拖拽
function handleDragStart(event, filePath) {
    draggedFilePath = filePath;
    draggedElement = event.target;
    
    event.dataTransfer.setData('text/plain', filePath);
    event.dataTransfer.effectAllowed = 'move';
    
    // 添加拖拽状态样式
    setTimeout(() => {
        if (draggedElement) {
            draggedElement.classList.add('dragging');
        }
    }, 0);
}

// 拖放到文件夹
async function handleDropToFolder(targetFolderPath, event) {
    if (!draggedFilePath) return;
    
    try {
        const response = await fetch('/api/batch-move-files', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                files: [draggedFilePath],
                targetFolder: targetFolderPath
            })
        });
        
        const result = await response.json();
        if (result.success) {
            showSuccess(`文件已移动到 "${targetFolderPath}"`);
            
            // 刷新播放列表（更新文件路径）
            const playlistResult = await apiRequest('/api/playlist');
            if (playlistResult.playlist) {
                currentPlaylist = playlistResult.playlist;
                renderPlaylist();
            }
            
            // 重新加载当前视图
            await loadFolderData(currentFolderPath, folderCurrentPage, FOLDER_PAGE_SIZE, folderSearchKeyword || undefined);
            
            // 刷新左侧导航栏的文件夹树（仅刷新导航栏，不重新加载当前视图）
            refreshFolderTreeOnly();
        } else {
            showError(result.error || '移动失败');
        }
    } catch (error) {
        console.error('移动文件失败:', error);
        showError('移动失败');
    } finally {
        // 清理拖拽状态
        if (draggedElement) {
            draggedElement.classList.remove('dragging');
        }
        draggedFilePath = null;
        draggedElement = null;
    }
}

// 批量移动文件
let selectedMoveTarget = null;

function moveSingleFile(filePath) {
    selectedMusicFiles.clear();
    selectedMusicFiles.add(filePath);
    selectedMoveTarget = null;
    openMoveModal();
}

function batchMoveFiles() {
    if (selectedMusicFiles.size === 0) return;
    
    selectedMoveTarget = null;
    openMoveModal();
}

async function openMoveModal() {
    try {
        await requireLogin();
    } catch (e) {
        return;
    }
    const modal = document.getElementById('moveModal');
    const btnConfirm = document.getElementById('btnConfirmMove');
    btnConfirm.disabled = true;
    
    // 渲染待移动文件列表
    renderMoveFileList();
    
    // 加载并渲染文件夹树
    renderFolderTree();
    
    modal.classList.add('show');
    document.body.style.overflow = 'hidden';
}

function renderMoveFileList() {
    const fileListEl = document.getElementById('moveFileList');
    const fileCountEl = document.getElementById('moveFileCount');
    
    if (!fileListEl || !fileCountEl) return;
    
    const files = Array.from(selectedMusicFiles);
    fileCountEl.textContent = files.length;
    
    if (files.length === 0) {
        fileListEl.innerHTML = '<div class="move-file-item"><span>未选择文件</span></div>';
        return;
    }
    
    fileListEl.innerHTML = '';
    files.forEach(filePath => {
        const fileName = filePath.split(/[\\/]/).pop();
        const item = document.createElement('div');
        item.className = 'move-file-item';
        item.innerHTML = `
            <i class="fas fa-music"></i>
            <span title="${filePath}">${fileName}</span>
        `;
        fileListEl.appendChild(item);
    });
}

function closeMoveModal() {
    const modal = document.getElementById('moveModal');
    modal.classList.remove('show');
    document.body.style.overflow = '';
    selectedMoveTarget = null;
    
    // 清空新建文件夹输入框
    const newFolderInput = document.getElementById('newFolderInMoveInput');
    if (newFolderInput) {
        newFolderInput.value = '';
    }
    
    // 清空文件列表显示
    const fileListEl = document.getElementById('moveFileList');
    const fileCountEl = document.getElementById('moveFileCount');
    if (fileListEl) {
        fileListEl.innerHTML = '';
    }
    if (fileCountEl) {
        fileCountEl.textContent = '0';
    }
}

function renderFolderTree() {
    const folderTreeEl = document.getElementById('folderTree');
    
    // 如果还没有加载文件夹数据，先加载
    if (!folderCacheData) {
        loadFolders().then(() => {
            buildFolderTree(folderTreeEl);
        });
        return;
    }
    
    buildFolderTree(folderTreeEl);
}

function buildFolderTree(container) {
    container.innerHTML = '';
    
    const ul = document.createElement('ul');
    
    // 添加根目录
    const rootLi = document.createElement('li');
    const rootItem = createFolderItem('music', '/music', true);
    rootLi.appendChild(rootItem);
    
    // 如果有子文件夹，嵌套添加
    if (folderCacheData && folderCacheData.folders && folderCacheData.folders.length > 0) {
        const subUl = document.createElement('ul');
        subUl.className = 'subfolder';
        addSubfolders(subUl, folderCacheData.folders, '/music');
        rootLi.appendChild(subUl);
    }
    
    ul.appendChild(rootLi);
    container.appendChild(ul);
}

function createFolderItem(name, path, isRoot = false) {
    const li = document.createElement('li');
    
    const item = document.createElement('div');
    item.className = 'folder-item';
    item.dataset.path = path;
    
    item.innerHTML = `
        <i class="fas fa-folder"></i>
        <span>${isRoot ? '主目录' : name}</span>
    `;
    
    item.addEventListener('click', () => {
        selectMoveTarget(path, item);
    });
    
    li.appendChild(item);
    return li;
}

function addSubfolders(parent, folders, parentPath) {
    if (!folders || !Array.isArray(folders)) return;
    
    folders.forEach(folder => {
        const childPath = parentPath === '/' ? `/${folder.name}` : `${parentPath}/${folder.name}`;
        const li = createFolderItem(folder.name, childPath);
        parent.appendChild(li);
        
        // 如果有子文件夹，递归添加
        if (folder.folders && folder.folders.length > 0) {
            const subUl = document.createElement('ul');
            subUl.className = 'subfolder';
            addSubfolders(subUl, folder.folders, childPath);
            li.appendChild(subUl);
        }
    });
}

function selectMoveTarget(path, element) {
    // 移除之前选中的样式
    document.querySelectorAll('.folder-item.selected').forEach(el => {
        el.classList.remove('selected');
    });
    
    // 添加选中样式
    element.classList.add('selected');
    selectedMoveTarget = path;
    
    // 启用确认按钮
    const btnConfirm = document.getElementById('btnConfirmMove');
    btnConfirm.disabled = false;
}

async function confirmMoveFiles() {
    const btnConfirm = document.getElementById('btnConfirmMove');
    if (selectedMusicFiles.size === 0) return;
    if (btnConfirm && btnConfirm.disabled) return;
    
    // 检查是否有输入新文件夹名称
    const newFolderInput = document.getElementById('newFolderInMoveInput');
    const newFolderName = newFolderInput ? newFolderInput.value.trim() : '';
    
    let targetFolder = selectedMoveTarget;
    
    // 如果输入了新文件夹名称，先创建文件夹
    if (newFolderName) {
        // 检查非法字符
        const invalidChars = /[\\/:*?"<>|]/;
        if (invalidChars.test(newFolderName)) {
            showError('文件夹名称包含非法字符');
            return;
        }
        
        // 确定父文件夹路径
        const parentPath = selectedMoveTarget || '/music';
        
        try {
            const createResponse = await fetch('/api/create-folder', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    parentPath: parentPath,
                    folderName: newFolderName
                })
            });
            
            const createResult = await createResponse.json();
            if (!createResult.success) {
                showError(createResult.error || '创建文件夹失败');
                return;
            }
            
            showSuccess(createResult.message);
            
            // 计算新文件夹的完整路径（需要以 /music 开头）
            targetFolder = parentPath === '/music' ? `/music/${newFolderName}` : `${parentPath}/${newFolderName}`;
            
            // 更新 folderCacheData
            if (folderCacheData) {
                const targetPath = parentPath === '/music' ? '' : parentPath;
                const newFolderData = {
                    name: newFolderName,
                    path: targetPath ? `${targetPath}/${newFolderName}` : newFolderName,
                    fullPath: '',
                    musicCount: 0,
                    hasSubFolders: false,
                    folders: [],
                    files: []
                };
                
                if (targetPath === '') {
                    if (!folderCacheData.folders) folderCacheData.folders = [];
                    folderCacheData.folders.push(newFolderData);
                    folderCacheData.folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
                } else {
                    const targetFolderObj = findFolderInCache(folderCacheData.folders, targetPath);
                    if (targetFolderObj) {
                        if (!targetFolderObj.folders) targetFolderObj.folders = [];
                        targetFolderObj.folders.push(newFolderData);
                        targetFolderObj.folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
                    }
                }
            }
        } catch (error) {
            console.error('创建文件夹失败:', error);
            showError('创建文件夹失败');
            return;
        }
    }
    
    if (!targetFolder) {
        showError('请选择目标文件夹或输入新文件夹名称');
        return;
    }
    
    if (btnConfirm) {
        btnConfirm.disabled = true;
        btnConfirm.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 移动中...';
    }
    
    try {
        const response = await fetch('/api/batch-move-files', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                files: Array.from(selectedMusicFiles),
                targetFolder: targetFolder
            })
        });
        
        const result = await response.json();
        if (result.success) {
            showSuccess(result.message);
            
            // 刷新播放列表（更新文件路径）
            const playlistResult = await apiRequest('/api/playlist');
            if (playlistResult.playlist) {
                currentPlaylist = playlistResult.playlist;
                renderPlaylist();
            }
            
            // 重新加载当前视图
            await loadFolderData(currentFolderPath, folderCurrentPage, FOLDER_PAGE_SIZE, folderSearchKeyword || undefined);
            
            // 刷新文件夹树（仅刷新导航栏，不重新加载当前视图）
            refreshFolderTreeOnly();
            
            clearSelection();
        } else {
            showError(result.error || '移动失败');
        }
    } catch (error) {
        console.error('批量移动失败:', error);
        showError('移动失败');
    } finally {
        if (btnConfirm) {
            btnConfirm.disabled = false;
            btnConfirm.innerHTML = '<i class="fas fa-arrow-right"></i> 确认移动';
        }
        closeMoveModal();
    }
}

// 绑定移动确认按钮
document.addEventListener('DOMContentLoaded', () => {
    const btnConfirmMove = document.getElementById('btnConfirmMove');
    if (btnConfirmMove) {
        btnConfirmMove.addEventListener('click', confirmMoveFiles);
    }
    
    // 监听新建文件夹输入框，输入内容时启用确认按钮
    const newFolderInMoveInput = document.getElementById('newFolderInMoveInput');
    if (newFolderInMoveInput) {
        newFolderInMoveInput.addEventListener('input', () => {
            const hasInput = newFolderInMoveInput.value.trim().length > 0;
            if (hasInput && selectedMusicFiles.size > 0) {
                btnConfirmMove.disabled = false;
            } else if (!selectedMoveTarget) {
                btnConfirmMove.disabled = true;
            }
        });
    }
});

// 批量下载文件
let isDownloading = false;
async function batchDownloadFiles() {
    if (isDownloading) return;
    if (selectedMusicFiles.size === 0) return;
    
    try {
        await requireLogin();
    } catch (e) {
        return;
    }
    
    isDownloading = true;
    const btn = document.querySelector('.batch-download-btn');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    }
    
    try {
        showNotification({
            type: 'info',
            message: `正在打包 ${selectedMusicFiles.size} 个文件...`,
            duration: 3000
        });
        
        const response = await fetch('/api/batch-download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ files: Array.from(selectedMusicFiles) })
        });
        
        if (response.ok) {
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `music_batch_${Date.now()}.zip`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            window.URL.revokeObjectURL(url);
            
            showSuccess(`已成功下载 ${selectedMusicFiles.size} 个文件`);
            clearSelection();
        } else {
            const result = await response.json();
            showError(result.error || '下载失败');
        }
    } catch (error) {
        console.error('批量下载失败:', error);
        showError('下载失败');
    } finally {
        isDownloading = false;
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-download"></i>';
        }
    }
}

// 批量转MP3功能
let isBatchConverting = false;

async function batchConvertToMp3() {
    try {
        await requireLogin();
    } catch (e) {
        return;
    }
    if (selectedMusicFiles.size === 0) return;
    
    const modal = document.getElementById('batchConvertModal');
    modal.classList.add('show');
    document.body.style.overflow = 'hidden';
    
    document.getElementById('batchConvertCount').textContent = selectedMusicFiles.size;
    document.getElementById('batchConvertTotal').textContent = selectedMusicFiles.size;
    document.getElementById('batchConvertCurrent').textContent = '0';
    
    // 重置进度条和日志
    document.getElementById('batchConvertProgress').style.display = 'none';
    document.getElementById('batchConvertProgressBar').style.width = '0%';
    document.getElementById('batchConvertStatus').textContent = '准备转换...';
    document.getElementById('batchConvertLog').innerHTML = '';
    
    // 重置按钮状态
    const btn = document.getElementById('btnConfirmBatchConvert');
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-cog"></i> 开始转换';
}

function closeBatchConvertModal() {
    if (isBatchConverting) return;
    const modal = document.getElementById('batchConvertModal');
    modal.classList.remove('show');
    document.body.style.overflow = '';
}

document.getElementById('btnConfirmBatchConvert').addEventListener('click', async function() {
    if (isBatchConverting) return;
    isBatchConverting = true;
    
    const btn = document.getElementById('btnConfirmBatchConvert');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 添加中...';
    
    const quality = document.getElementById('batchConvertQuality').value;
    const files = Array.from(selectedMusicFiles);
    const total = files.length;
    
    try {
        const response = await fetch('/api/batch-convert-mp3', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ files, bitrate: quality })
        });
        
        const result = await response.json();
        
        if (result.success) {
            showNotification({ type: 'success', message: `已将 ${result.totalTasks} 个任务添加到后台队列` });
            
            // 自动关闭模态框
            setTimeout(() => {
                closeBatchConvertModal();
                clearSelection();
            }, 800);
        } else {
            showNotification({ type: 'error', message: result.error || '添加任务失败' });
            closeBatchConvertModal();
            clearSelection();
        }
    } catch (error) {
        showNotification({ type: 'error', message: '添加任务失败: ' + error.message });
    } finally {
        isBatchConverting = false;
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-cog"></i> 开始转换';
    }
});

// 任务通知轮询
let taskNotificationInterval = null;

async function fetchTaskNotifications() {
    try {
        const response = await fetch('/api/task-notifications');
        const result = await response.json();
        
        if (result.success && result.notifications && result.notifications.length > 0) {
            result.notifications.forEach(notification => {
                // 显示通知
                if (notification.type === 'convert') {
                    showNotification({
                        type: 'success',
                        title: '转换完成',
                        message: notification.message
                    });
                } else if (notification.type === 'upload') {
                    showNotification({
                        type: 'success',
                        title: '上传完成',
                        message: notification.message
                    });
                }
            });
        }
    } catch (error) {
        console.error('获取任务通知失败:', error);
    }
}

function startTaskNotificationPoll() {
    stopTaskNotificationPoll();
    taskNotificationInterval = setInterval(fetchTaskNotifications, 3000);
    fetchTaskNotifications(); // 立即获取一次
}

function stopTaskNotificationPoll() {
    if (taskNotificationInterval) {
        clearInterval(taskNotificationInterval);
        taskNotificationInterval = null;
    }
}

// 后台转换进度轮询
let backgroundConvertPollInterval = null;

function showBackgroundConvertPanel() {
    const panel = document.getElementById('backgroundConvertPanel');
    if (panel) {
        panel.style.display = 'block';
        startBackgroundConvertPoll();
    }
}

function hideBackgroundConvertPanel() {
    const panel = document.getElementById('backgroundConvertPanel');
    if (panel) {
        panel.style.display = 'none';
    }
    stopBackgroundConvertPoll();
}

function startBackgroundConvertPoll() {
    stopBackgroundConvertPoll();
    backgroundConvertPollInterval = setInterval(fetchConvertProgress, 2000);
    fetchConvertProgress(); // 立即获取一次
}

function stopBackgroundConvertPoll() {
    if (backgroundConvertPollInterval) {
        clearInterval(backgroundConvertPollInterval);
        backgroundConvertPollInterval = null;
    }
}

async function fetchConvertProgress() {
    try {
        const response = await fetch('/api/convert-progress');
        const result = await response.json();
        
        if (result.success) {
            const panel = document.getElementById('backgroundConvertPanel');
            const progressBar = document.getElementById('backgroundConvertProgressBar');
            const statusText = document.getElementById('backgroundConvertStatus');
            const queueCount = document.getElementById('backgroundConvertQueueCount');
            
            // 更新任务徽章
            const totalActive = (result.isConverting ? 1 : 0) + (result.queueLength || 0);
            const badge = document.getElementById('taskBadge');
            if (badge) {
                if (totalActive > 0) {
                    badge.textContent = totalActive;
                    badge.style.display = 'inline';
                } else {
                    badge.style.display = 'none';
                }
            }
            
            if (result.isConverting && result.currentTask) {
                panel.style.display = 'block';
                progressBar.style.width = result.currentTask.progress + '%';
                statusText.textContent = `${result.currentTask.message} - ${result.currentTask.fileName}`;
                queueCount.textContent = result.queueLength;
                
                if (result.currentTask.status === 'completed') {
                    // 任务完成，显示成功通知
                    showNotification({ type: 'success', message: `转换完成: ${result.currentTask.fileName}` });
                } else if (result.currentTask.status === 'failed') {
                    showNotification({ type: 'error', message: `转换失败: ${result.currentTask.fileName}` });
                }
            } else if (result.queueLength > 0) {
                panel.style.display = 'block';
                progressBar.style.width = '0%';
                statusText.textContent = `等待转换，队列中有 ${result.queueLength} 个任务`;
                queueCount.textContent = result.queueLength;
            } else {
                // 没有正在转换的任务且队列为空
                panel.style.display = 'none';
            }
        }
    } catch (error) {
        console.error('获取转换进度失败:', error);
    }
}

// 取消后台转换
function cancelBackgroundConvert() {
    fetch('/api/cancel-convert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
    }).then(response => response.json()).then(result => {
        if (result.success) {
            showNotification({ type: 'info', message: result.message });
            hideBackgroundConvertPanel();
        }
    });
}

// 刷新任务列表
async function refreshTaskList() {
    await loadTaskList();
}

// 加载任务列表
async function loadTaskList(filter = 'all') {
    try {
        // 先获取全部任务的统计数据（不受过滤器影响）
        const [convertRes, uploadRes] = await Promise.all([
            fetch('/api/tasks?status=all'),
            fetch('/api/upload-tasks?status=all')
        ]);
        
        const convertResult = await convertRes.json();
        const uploadResult = await uploadRes.json();
        
        if (convertResult.success && uploadResult.success) {
            // 合并统计（始终显示全部任务的统计）
            const mergedStats = {
                pending: convertResult.stats.pending + uploadResult.stats.pending,
                converting: convertResult.stats.converting + uploadResult.stats.uploading,
                completed: convertResult.stats.completed + uploadResult.stats.completed,
                failed: convertResult.stats.failed + uploadResult.stats.failed
            };
            
            // 更新统计卡片（始终显示全部任务）
            updateTaskStats(mergedStats);
            updateTaskBadge(mergedStats);
            
            // 如果需要过滤，则重新获取过滤后的任务列表
            if (filter !== 'all') {
                const [filteredConvertRes, filteredUploadRes] = await Promise.all([
                    fetch(`/api/tasks?status=${filter}`),
                    fetch(`/api/upload-tasks?status=${filter}`)
                ]);
                
                const filteredConvertResult = await filteredConvertRes.json();
                const filteredUploadResult = await filteredUploadRes.json();
                
                if (filteredConvertResult.success && filteredUploadResult.success) {
                    const filteredConvertTasks = filteredConvertResult.tasks.map(t => ({ ...t, type: 'convert' }));
                    const filteredUploadTasks = filteredUploadResult.tasks.map(t => ({ ...t, type: 'upload' }));
                    const filteredTasks = [...filteredConvertTasks, ...filteredUploadTasks];
                    
                    // 按任务序号排序（保持添加顺序）
                    filteredTasks.sort((a, b) => (a.orderIndex || 0) - (b.orderIndex || 0));
                    
                    renderTaskList(filteredTasks);
                }
            } else {
                // 显示全部任务
                const convertTasks = convertResult.tasks.map(t => ({ ...t, type: 'convert' }));
                const uploadTasks = uploadResult.tasks.map(t => ({ ...t, type: 'upload' }));
                const allTasks = [...convertTasks, ...uploadTasks];
                
                // 按任务序号排序（保持添加顺序）
                allTasks.sort((a, b) => (a.orderIndex || 0) - (b.orderIndex || 0));
                
                renderTaskList(allTasks);
            }
        }
    } catch (error) {
        console.error('加载任务列表失败:', error);
    }
}

// 更新任务统计
function updateTaskStats(stats) {
    document.getElementById('taskStatPending').textContent = stats.pending;
    document.getElementById('taskStatConverting').textContent = stats.converting;
    document.getElementById('taskStatCompleted').textContent = stats.completed;
    document.getElementById('taskStatFailed').textContent = stats.failed;
}

// 更新任务徽章
function updateTaskBadge(stats) {
    const badge = document.getElementById('taskBadge');
    const total = stats.pending + stats.converting;
    
    if (total > 0) {
        badge.textContent = total;
        badge.style.display = 'inline';
    } else {
        badge.style.display = 'none';
    }
}

// 渲染任务列表
function renderTaskList(tasks) {
    const taskList = document.getElementById('taskList');
    
    if (!tasks || tasks.length === 0) {
        taskList.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-tasks"></i>
                <p>暂无任务</p>
                <p class="empty-hint">上传文件或转换MP3时，任务会显示在这里</p>
            </div>
        `;
        return;
    }
    
    taskList.innerHTML = tasks.map(task => {
        const statusText = {
            'queued': '等待中',
            'converting': '执行中',
            'uploading': '上传中',
            'completed': '已完成',
            'failed': '失败',
            'canceling': '取消中'
        };
        
        const statusClass = task.status === 'queued' ? 'pending' : task.status;
        
        // 区分上传和转换任务
        const isUpload = task.type === 'upload';
        const icon = isUpload ? '<i class="fas fa-upload"></i>' : '<i class="fas fa-exchange-alt"></i>';
        const taskName = isUpload ? (task.fileName || '上传文件') : (task.fileName || '未知文件');
        const progress = task.progress;
        
        return `
            <div class="task-item" data-task-id="${task.id}" data-task-type="${task.type}">
                <div class="task-status ${statusClass}">
                    ${task.status === 'completed' ? '<i class="fas fa-check"></i>' : ''}
                    ${task.status === 'failed' ? '<i class="fas fa-times"></i>' : ''}
                </div>
                <div class="task-info">
                    <div class="task-filename">${icon} ${taskName}</div>
                    <div class="task-message">${task.message || statusText[task.status]}</div>
                </div>
                <div class="task-progress">
                    <div class="task-progress-bar">
                        <div class="task-progress-fill" style="width: ${progress}%"></div>
                    </div>
                    <div class="task-progress-text">${progress}%</div>
                </div>
                <div class="task-actions-cell">
                    ${task.status === 'completed' || task.status === 'failed' ? `
                        <button class="task-action delete" onclick="deleteTask('${task.id}', '${task.type}')" title="删除任务">
                            <i class="fas fa-trash"></i>
                        </button>
                    ` : ''}
                </div>
            </div>
        `;
    }).join('');
}

// 删除任务
async function deleteTask(taskId, taskType = 'convert') {
    try {
        await requireLogin();
    } catch (e) {
        return;
    }
    const apiUrl = taskType === 'upload' ? `/api/upload-tasks/${taskId}` : `/api/tasks/${taskId}`;
    fetch(apiUrl, {
        method: 'DELETE'
    }).then(response => response.json()).then(result => {
        if (result.success) {
            showNotification({ type: 'success', message: '任务已删除' });
            loadTaskList(getCurrentTaskFilter());
        } else {
            showNotification({ type: 'error', message: result.error });
        }
    });
}

// 清除已完成任务
async function clearCompletedTasks() {
    try {
        await requireLogin();
    } catch (e) {
        return;
    }
    const modal = document.getElementById('clearTasksModal');
    if (modal) {
        modal.classList.add('show');
    }
}

// 关闭清除任务模态框
function closeClearTasksModal() {
    const modal = document.getElementById('clearTasksModal');
    if (modal) {
        modal.classList.remove('show');
    }
}

// 确认清除任务
async function confirmClearTasks() {
    try {
        await Promise.all([
            fetch('/api/tasks', { method: 'DELETE' }),
            fetch('/api/upload-tasks', { method: 'DELETE' })
        ]);
        showNotification({ type: 'success', message: '已完成任务已清除' });
        loadTaskList(getCurrentTaskFilter());
        closeClearTasksModal();
    } catch (error) {
        console.error('清除任务失败:', error);
        showNotification({ type: 'error', message: '清除任务失败' });
        closeClearTasksModal();
    }
}

// 获取当前任务过滤器
function getCurrentTaskFilter() {
    const activeFilter = document.querySelector('.filter-btn.active');
    return activeFilter ? activeFilter.dataset.filter : 'all';
}

// 启动任务列表轮询
function startTaskListPoll() {
    stopTaskListPoll();
    taskListPollInterval = setInterval(() => {
        const activeView = document.querySelector('.view.active');
        if (activeView && activeView.id === 'view-task') {
            loadTaskList(getCurrentTaskFilter());
        }
    }, 3000);
}

// 停止任务列表轮询
function stopTaskListPoll() {
    if (taskListPollInterval) {
        clearInterval(taskListPollInterval);
        taskListPollInterval = null;
    }
}

function clearSelection() {
    selectedMusicFiles.clear();
    document.querySelectorAll('.folder-music-item.selected').forEach(item => item.classList.remove('selected'));
    document.querySelectorAll('.folder-music-checkbox').forEach(cb => cb.checked = false);
    updateBatchActions();
}

// 播放列表批量操作函数
function togglePlaylistTrackSelection(index) {
    const item = document.querySelector(`.playlist-item[data-index="${index}"]`);
    const checkbox = item ? item.querySelector('input[type="checkbox"]') : null;
    
    if (selectedPlaylistTracks.has(index)) {
        selectedPlaylistTracks.delete(index);
        if (item) item.classList.remove('selected');
        if (checkbox) checkbox.checked = false;
    } else {
        selectedPlaylistTracks.add(index);
        if (item) item.classList.add('selected');
        if (checkbox) checkbox.checked = true;
    }
    
    updatePlaylistBatchBar();
}

function togglePlaylistSelectAll() {
    const selectAllCheckbox = document.getElementById('playlistSelectAllBtn');
    const isChecked = selectAllCheckbox.checked;
    
    selectedPlaylistTracks.clear();
    
    if (isChecked) {
        currentPlaylist.forEach((_, index) => {
            selectedPlaylistTracks.add(index);
        });
    }
    
    document.querySelectorAll('.playlist-item').forEach(item => {
        const index = parseInt(item.dataset.index);
        const checkbox = item.querySelector('input[type="checkbox"]');
        
        if (isChecked) {
            item.classList.add('selected');
            if (checkbox) checkbox.checked = true;
        } else {
            item.classList.remove('selected');
            if (checkbox) checkbox.checked = false;
        }
    });
    
    updatePlaylistBatchBar();
}

function updatePlaylistBatchBar() {
    const selectAllCheckbox = document.getElementById('playlistSelectAllBtn');
    const downloadBtn = document.querySelector('.playlist-batch-download-btn');
    const deleteBtn = document.querySelector('.playlist-batch-delete-btn');
    
    const count = selectedPlaylistTracks.size;
    
    if (selectAllCheckbox) {
        selectAllCheckbox.checked = count === currentPlaylist.length && count > 0;
    }
    
    if (downloadBtn) {
        downloadBtn.disabled = count === 0;
        downloadBtn.style.opacity = count === 0 ? '0.5' : '1';
    }
    if (deleteBtn) {
        deleteBtn.disabled = count === 0;
        deleteBtn.style.opacity = count === 0 ? '0.5' : '1';
    }
}

async function playlistBatchDownload() {
    if (selectedPlaylistTracks.size === 0) return;
    
    try {
        showNotification({
            type: 'info',
            message: `正在打包 ${selectedPlaylistTracks.size} 个文件...`,
            duration: 3000
        });
        
        const selectedPaths = Array.from(selectedPlaylistTracks).map(index => currentPlaylist[index].path);
        
        const response = await fetch('/api/batch-download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ files: selectedPaths })
        });
        
        if (response.ok) {
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `playlist_batch_${Date.now()}.zip`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            window.URL.revokeObjectURL(url);
            
            showSuccess(`已成功下载 ${selectedPlaylistTracks.size} 个文件`);
            clearPlaylistSelection();
        } else {
            const result = await response.json();
            showError(result.error || '下载失败');
        }
    } catch (error) {
        console.error('批量下载失败:', error);
        showError('下载失败');
    }
}

function playlistBatchDelete() {
    if (selectedPlaylistTracks.size === 0) return;
    
    const selectedIndices = Array.from(selectedPlaylistTracks).sort((a, b) => b - a);
    openPlaylistDeleteModal(selectedIndices);
}

async function openPlaylistDeleteModal(indices) {
    try {
        await requireLogin();
    } catch (e) {
        return;
    }
    const modal = document.getElementById('deleteModal');
    
    document.getElementById('deleteTrackName').textContent = `批量删除 ${indices.length} 首歌曲`;
    document.getElementById('deleteWarning').textContent = `此操作将从播放列表中移除 ${indices.length} 首歌曲。`;
    
    modal.classList.add('show');
    document.body.style.overflow = 'hidden';
    
    modal.dataset.deleteType = 'playlist-batch';
    modal.dataset.deleteIndices = JSON.stringify(indices);
    
    setTimeout(() => {
        document.addEventListener('click', closePlaylistMenu, { once: true });
    }, 0);
}

async function executePlaylistBatchDelete(indices) {
    closeDeleteModal();
    
    try {
        const response = await fetch('/api/batch-delete-playlist', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ indices })
        });
        
        const result = await response.json();
        if (result.success) {
            showSuccess(result.message);
            clearPlaylistSelection();
            
            const playlistResult = await apiRequest('/api/playlist');
            if (playlistResult.playlist) {
                currentPlaylist = playlistResult.playlist;
                renderPlaylist();
            }
        } else {
            showError(result.error || '删除失败');
        }
    } catch (error) {
        console.error('批量删除失败:', error);
        showError('删除失败');
    }
}

function clearPlaylistSelection() {
    selectedPlaylistTracks.clear();
    document.querySelectorAll('.playlist-item input[type="checkbox"]').forEach(cb => cb.checked = false);
    document.querySelectorAll('.playlist-item').forEach(item => item.classList.remove('selected'));
    updatePlaylistBatchBar();
    
    const modal = document.getElementById('deleteModal');
    if (modal) {
        delete modal.dataset.deleteType;
        delete modal.dataset.deleteIndices;
    }
}

// ==================== 在线音乐搜索和播放 ====================

let onlineSearchResults = [];
let onlineRankResults = [];
let rankCache = {};  // 排行榜缓存 { type: results }

// 在线音乐分页设置（独立于文件夹视图）
let ONLINE_PAGE_SIZE = 20;

// 在线搜索分页状态
let onlineSearchPage = 1;

// 排行榜分页状态
let rankCurrentPage = 1;
let rankTotalPages = 1;
let onlineSearchKeyword = '';
let onlineSearchTotal = 0;

// Tab切换
function switchOnlineTab(tab) {
    const rankTab = document.getElementById('tabRank');
    const searchTab = document.getElementById('tabSearch');
    const songlistTab = document.getElementById('tabSonglist');
    const rankSection = document.getElementById('onlineRankSection');
    const searchSection = document.getElementById('onlineResultsSection');
    const songlistSection = document.getElementById('onlineSonglistSection');
    
    if (tab === 'rank') {
        rankTab.classList.add('active');
        searchTab.classList.remove('active');
        songlistTab.classList.remove('active');
        rankSection.style.display = 'block';
        searchSection.style.display = 'none';
        songlistSection.style.display = 'none';
        
        // 检查缓存，如果有就直接显示
        const rankType = document.getElementById('rankTypeSelect').value;
        const source = document.getElementById('onlineSourceSelect').value;
        const cacheKey = `${source}_${rankType}`;
        if (rankCache[cacheKey]) {
            onlineRankResults = rankCache[cacheKey];
            renderRankResults();
        } else {
            loadRankList();
        }
    } else if (tab === 'search') {
        searchTab.classList.add('active');
        rankTab.classList.remove('active');
        songlistTab.classList.remove('active');
        searchSection.style.display = 'block';
        rankSection.style.display = 'none';
        songlistSection.style.display = 'none';
    } else if (tab === 'songlist') {
        songlistTab.classList.add('active');
        rankTab.classList.remove('active');
        searchTab.classList.remove('active');
        songlistSection.style.display = 'block';
        rankSection.style.display = 'none';
        searchSection.style.display = 'none';
        
        // 加载歌单列表
        if (!songlistLoaded) {
            loadSonglistTags();
            loadSonglistList();
            songlistLoaded = true;
        }
    }
}

// 音源切换时刷新数据
async function onSourceChange() {
    const source = document.getElementById('onlineSourceSelect').value;
    
    // 保存到后端
    try {
        await fetch('/api/online-source', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source })
        });
    } catch (error) {
        console.error('保存音源失败:', error);
    }
    
    // 刷新当前视图数据
    const rankTab = document.getElementById('tabRank');
    if (rankTab.classList.contains('active')) {
        loadRankList();
    }
}

// 加载排行榜
async function loadRankList(rankType = null, page = null) {
    const type = rankType || document.getElementById('rankTypeSelect').value;
    const source = document.getElementById('onlineSourceSelect').value;
    const currentPage = page || rankCurrentPage;
    const cacheKey = `${source}_${type}_${currentPage}`;
    const resultsContainer = document.getElementById('rankResults');
    
    // 检查缓存
    if (rankCache[cacheKey]) {
        onlineRankResults = rankCache[cacheKey];
        if (!rankType) {
            renderRankResults();
            renderRankPagination();
        }
        return;
    }
    
    // 只有用户主动触发时显示加载状态
    if (!rankType) {
        resultsContainer.innerHTML = '<div class="online-loading"><i class="fas fa-spinner fa-spin"></i><p>正在加载排行榜...</p></div>';
    }
    
    try {
        const response = await fetch('/api/online-rank', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type, source, page: currentPage, limit: ONLINE_PAGE_SIZE })
        });
        
        const result = await response.json();
        
        if (result.success) {
            rankCache[cacheKey] = result.results;  // 缓存数据
            onlineRankResults = result.results;
            // 更新总页数
            if (result.total !== undefined) {
                rankTotalPages = Math.ceil(result.total / ONLINE_PAGE_SIZE);
            }
            if (!rankType) {
                renderRankResults();
                renderRankPagination();
            }
        } else {
            console.error('加载排行榜失败:', result.error);
            if (!rankType) {
                resultsContainer.innerHTML = `<div class="empty-state"><i class="fas fa-exclamation-triangle"></i><p>加载失败：${result.error}</p></div>`;
            }
        }
    } catch (error) {
        console.error('加载排行榜失败:', error);
        if (!rankType) {
            resultsContainer.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-triangle"></i><p>加载失败，请检查网络连接</p></div>';
        }
    }
}

// 预加载所有排行榜类型（后台静默加载）
async function preloadAllRanks() {
    const rankTypes = ['hot', 'new', 'soaring', 'original'];
    for (const type of rankTypes) {
        await loadRankList(type);
        await new Promise(resolve => setTimeout(resolve, 500));
    }
}

// 刷新排行榜（清除缓存并重新加载）
async function refreshRankList() {
    const refreshBtn = document.querySelector('.rank-refresh-btn');
    const rankType = document.getElementById('rankTypeSelect').value;
    const source = document.getElementById('onlineSourceSelect').value;
    
    refreshBtn?.classList.add('refreshing');
    
    try {
        // 清除所有该类型的缓存
        Object.keys(rankCache).forEach(key => {
            if (key.startsWith(`${source}_${rankType}`)) {
                delete rankCache[key];
            }
        });
        rankCurrentPage = 1;  // 重置到第一页
        await loadRankList();
    } catch (error) {
        console.error('刷新排行榜失败:', error);
    } finally {
        refreshBtn?.classList.remove('refreshing');
    }
}

// 渲染排行榜分页
function renderRankPagination() {
    const pagination = document.getElementById('rankPagination');
    
    if (rankTotalPages <= 1) {
        hideRankPagination();
        return;
    }
    
    pagination.style.display = 'flex';
    const pageInfo = document.getElementById('rankPageInfo');
    const prevBtn = document.getElementById('rankPrevBtn');
    const nextBtn = document.getElementById('rankNextBtn');
    
    pageInfo.textContent = `${rankCurrentPage} / ${rankTotalPages}`;
    prevBtn.disabled = rankCurrentPage <= 1;
    nextBtn.disabled = rankCurrentPage >= rankTotalPages;
}

// 隐藏排行榜分页
function hideRankPagination() {
    const pagination = document.getElementById('rankPagination');
    pagination.style.display = 'none';
}

// 切换排行榜分页
async function changeRankPage(direction) {
    if (direction === 'prev' && rankCurrentPage > 1) {
        rankCurrentPage--;
        await loadRankList(null, rankCurrentPage);
    } else if (direction === 'next' && rankCurrentPage < rankTotalPages) {
        rankCurrentPage++;
        await loadRankList(null, rankCurrentPage);
    }
}

// 获取平台名称映射
function getSourceName(source) {
    const sourceNames = {
        'kw': '酷我',
        'kg': '酷狗',
        'tx': 'QQ',
        'wy': '网易云',
        'mg': '咪咕'
    };
    return sourceNames[source] || source;
}

// 获取平台颜色
function getSourceColor(source) {
    const colors = {
        'kw': '#ff6a00',
        'kg': '#ff4757',
        'tx': '#10b981',
        'wy': '#e01d2c',
        'mg': '#ffc107'
    };
    return colors[source] || '#6b7280';
}

// 渲染排行榜结果
function renderRankResults() {
    const resultsContainer = document.getElementById('rankResults');
    const countElement = document.getElementById('rankCount');
    
    // 将所有平台的音乐合并到一个列表
    let allSongs = [];
    onlineRankResults.forEach(sourceResult => {
        sourceResult.list.forEach((song, index) => {
            allSongs.push({
                ...song,
                sourceName: sourceResult.sourceName,
                globalIndex: allSongs.length
            });
        });
    });
    
    const total = allSongs.length;
    countElement.textContent = `(${total} 首)`;
    
    if (total === 0) {
        resultsContainer.innerHTML = '<div class="empty-state"><i class="fas fa-chart-line"></i><p>暂无排行榜数据</p></div>';
        return;
    }
    
    let html = '';
    
    allSongs.forEach((song, index) => {
        const cacheKey = `rank_${song.source}_${song.songId}_${index}`;
        onlineSongCache[cacheKey] = song;
        
        // 排名标识
        let rankBadge = '';
        if (index === 0) {
            rankBadge = '<span class="rank-badge rank-1">1</span>';
        } else if (index === 1) {
            rankBadge = '<span class="rank-badge rank-2">2</span>';
        } else if (index === 2) {
            rankBadge = '<span class="rank-badge rank-3">3</span>';
        } else {
            rankBadge = `<span class="rank-badge rank-other">${index + 1}</span>`;
        }
        
        // 平台标识
        const sourceColor = getSourceColor(song.source);
        const sourceName = getSourceName(song.source);
        
        html += `
            <div class="online-item" data-source="${song.source}" data-songid="${song.songId}">
                ${rankBadge}
                <img src="${song.picUrl || ''}" alt="" class="online-item-pic" onerror="this.style.display='none'">
                <div class="online-item-info">
                    <div class="online-item-title-row">
                        <div class="online-item-title">${song.name}</div>
                        <span class="online-source-tag" style="background-color: ${sourceColor}">${sourceName}</span>
                    </div>
                    <div class="online-item-artist">${song.singer}</div>
                    <div class="online-item-album">${song.albumName || ''}</div>
                </div>
                <div class="online-item-interval">${formatDuration(song.interval)}</div>
                <div class="online-item-actions">
                    <button class="online-play-btn" onclick="playOnlineSong('${cacheKey}')" title="播放">
                        <i class="fas fa-play"></i>
                    </button>
                    <button class="online-download-btn" onclick="downloadOnlineSong('${cacheKey}')" title="下载">
                        <i class="fas fa-download"></i>
                    </button>
                    <button class="online-add-btn" onclick="addToPlaylistFromOnline('${cacheKey}')" title="添加到播放列表">
                        <i class="fas fa-plus"></i>
                    </button>
                </div>
                <!-- 移动端菜单按钮 - 使用全局菜单 -->
                <button class="online-item-menu-btn" onclick="event.stopPropagation(); toggleOnlineItemMenu(event, '${cacheKey}')" title="更多">
                    <i class="fas fa-ellipsis-v"></i>
                </button>
            </div>`;
    });
    
    resultsContainer.innerHTML = html;
}

// 搜索在线音乐
async function searchOnlineMusic(page = 1) {
    const keyword = document.getElementById('onlineSearchInput').value.trim();
    const source = document.getElementById('onlineSourceSelect').value;
    
    if (!keyword) {
        showNotification({ type: 'warning', message: '请输入搜索关键词' });
        return;
    }
    
    onlineSearchKeyword = keyword;
    onlineSearchPage = page;
    
    const resultsContainer = document.getElementById('onlineResults');
    resultsContainer.innerHTML = '<div class="online-loading"><i class="fas fa-spinner"></i><p>正在搜索...</p></div>';
    
    try {
        console.log('发送搜索请求, ONLINE_PAGE_SIZE:', ONLINE_PAGE_SIZE);
        const response = await fetch('/api/online-search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ keyword, source, page, limit: ONLINE_PAGE_SIZE })
        });
        
        const result = await response.json();
        
        if (result.success) {
            onlineSearchResults = result.results;
            onlineSearchTotal = result.total || 0;
            renderOnlineResults();
            renderOnlinePagination();
        } else {
            resultsContainer.innerHTML = `<div class="empty-state"><i class="fas fa-exclamation-triangle"></i><p>搜索失败：${result.error}</p></div>`;
            hideOnlinePagination();
        }
    } catch (error) {
        console.error('在线搜索失败:', error);
        resultsContainer.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-triangle"></i><p>搜索失败，请检查网络连接</p></div>';
        hideOnlinePagination();
    }
}

// 渲染在线搜索分页
function renderOnlinePagination() {
    const pagination = document.getElementById('onlinePagination');
    const pageInfo = document.getElementById('onlinePageInfo');
    const prevBtn = document.getElementById('onlinePrevBtn');
    const nextBtn = document.getElementById('onlineNextBtn');
    
    const totalPages = Math.ceil(onlineSearchTotal / ONLINE_PAGE_SIZE);
    
    if (totalPages <= 1) {
        hideOnlinePagination();
        return;
    }
    
    pagination.style.display = 'flex';
    pageInfo.textContent = `${onlineSearchPage} / ${totalPages}`;
    prevBtn.disabled = onlineSearchPage <= 1;
    nextBtn.disabled = onlineSearchPage >= totalPages;
}

function hideOnlinePagination() {
    document.getElementById('onlinePagination').style.display = 'none';
}

// 切换在线搜索分页
async function changeOnlinePage(direction) {
    if (direction === 'prev' && onlineSearchPage > 1) {
        await searchOnlineMusic(onlineSearchPage - 1);
    } else if (direction === 'next') {
        const totalPages = Math.ceil(onlineSearchTotal / ONLINE_PAGE_SIZE);
        if (onlineSearchPage < totalPages) {
            await searchOnlineMusic(onlineSearchPage + 1);
        }
    }
}

// 存储完整的歌曲信息（用于播放）
let onlineSongCache = {};

// 渲染在线搜索结果
function renderOnlineResults() {
    const resultsContainer = document.getElementById('onlineResults');
    const countElement = document.getElementById('onlineCount');
    
    // 将所有平台的音乐合并到一个列表
    let allSongs = [];
    onlineSearchResults.forEach(sourceResult => {
        sourceResult.list.forEach((song, index) => {
            allSongs.push({
                ...song,
                sourceName: sourceResult.sourceName
            });
        });
    });
    
    const currentPageCount = allSongs.length;
    // 使用后端返回的真实total，而不是当前页数量
    countElement.textContent = `(${onlineSearchTotal} 首)`;
    
    if (currentPageCount === 0) {
        resultsContainer.innerHTML = '<div class="empty-state"><i class="fas fa-search"></i><p>未找到相关音乐</p><p class="empty-hint">请尝试其他关键词</p></div>';
        return;
    }
    
    let html = '';
    
    allSongs.forEach((song, index) => {
        // 缓存完整的歌曲信息
        const cacheKey = `${song.source}_${song.songId}_${index}`;
        onlineSongCache[cacheKey] = song;
        
        // 序号标识
        let indexBadge = `<span class="rank-badge rank-other">${index + 1}</span>`;
        
        // 平台标识
        const sourceColor = getSourceColor(song.source);
        const sourceName = getSourceName(song.source);
        
        html += `
            <div class="online-item" data-source="${song.source}" data-songid="${song.songId}">
                ${indexBadge}
                <img src="${song.picUrl || ''}" alt="" class="online-item-pic" onerror="this.style.display='none'">
                <div class="online-item-info">
                    <div class="online-item-title-row">
                        <div class="online-item-title">${song.name}</div>
                        <span class="online-source-tag" style="background-color: ${sourceColor}">${sourceName}</span>
                    </div>
                    <div class="online-item-artist">${song.singer}</div>
                    <div class="online-item-album">${song.albumName || ''}</div>
                </div>
                <div class="online-item-interval">${formatDuration(song.interval)}</div>
                <div class="online-item-actions">
                    <button class="online-play-btn" onclick="playOnlineSong('${cacheKey}')" title="播放">
                        <i class="fas fa-play"></i>
                    </button>
                    <button class="online-download-btn" onclick="downloadOnlineSong('${cacheKey}')" title="下载">
                        <i class="fas fa-download"></i>
                    </button>
                    <button class="online-add-btn" onclick="addToPlaylistFromOnline('${cacheKey}')" title="添加到播放列表">
                        <i class="fas fa-plus"></i>
                    </button>
                </div>
                <!-- 移动端菜单按钮 - 使用全局菜单 -->
                <button class="online-item-menu-btn" onclick="event.stopPropagation(); toggleOnlineItemMenu(event, '${cacheKey}')" title="更多">
                    <i class="fas fa-ellipsis-v"></i>
                </button>
            </div>
        `;
    });
    
    resultsContainer.innerHTML = html;
}

// 添加在线音乐到播放列表（不播放）
async function addToPlaylistFromOnline(cacheKey) {
    const song = onlineSongCache[cacheKey];
    if (!song) {
        showNotification({ type: 'error', message: '歌曲信息丢失，请重新搜索' });
        return;
    }
    
    try {
        const response = await fetch('/api/add-online-to-playlist', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                source: song.source,
                songId: song.songId,
                name: song.name,
                singer: song.singer,
                albumName: song.albumName || '',
                picUrl: song.picUrl || '',
                interval: song.interval || ''
            })
        });
        
        const result = await response.json();
        
        if (result.success) {
            showNotification({ type: 'success', message: result.message });
            // 刷新播放列表视图
            const playlistResult = await apiRequest('/api/playlist');
            if (playlistResult.playlist) {
                currentPlaylist = playlistResult.playlist;
                renderPlaylist();
            }
        } else {
            showNotification({ type: 'error', message: result.error || '添加失败' });
        }
    } catch (error) {
        console.error('添加失败:', error);
        showNotification({ type: 'error', message: '添加失败，请重试' });
    }
}

// 下载在线音乐
async function downloadOnlineSong(cacheKey) {
    const song = onlineSongCache[cacheKey];
    if (!song) {
        showNotification({ type: 'error', message: '歌曲信息丢失，请重新搜索' });
        return;
    }
    
    try {
        await requireLogin();
    } catch (e) {
        return;
    }
    
    showNotification({ type: 'info', message: `正在获取下载链接...` });
    
    try {
        const response = await fetch('/api/download-online', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                source: song.source,
                songId: song.songId,
                name: song.name,
                singer: song.singer,
                albumName: song.albumName || '',
                // 传递完整的歌曲信息给自定义音源
                songInfo: song
            })
        });
        
        if (response.ok) {
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            const artistName = song.singer ? `${song.singer} - ` : '';
            link.download = `${artistName}${song.name}.mp3`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            window.URL.revokeObjectURL(url);
            
            showNotification({ type: 'success', message: `下载完成：${song.name}` });
        } else {
            const result = await response.json();
            showNotification({ type: 'error', message: result.error || '下载失败' });
        }
    } catch (error) {
        console.error('下载失败:', error);
        showNotification({ type: 'error', message: '下载失败，请重试' });
    }
}

// 当前选中的在线音乐项
let currentOnlineMenuKey = null;

// 切换在线音乐项菜单显示 - 使用全局上下文菜单
function toggleOnlineItemMenu(event, cacheKey) {
    event.stopPropagation();
    
    const menu = document.getElementById('onlineContextMenu');
    
    // 如果点击的是同一个菜单按钮，则只关闭
    if (currentOnlineMenuKey === cacheKey && menu.classList.contains('show')) {
        closeOnlineContextMenu();
        return;
    }
    
    currentOnlineMenuKey = cacheKey;
    
    // 获取鼠标位置
    const mouseX = event.clientX;
    const mouseY = event.clientY;
    
    // 获取菜单尺寸
    const menuWidth = menu.offsetWidth || 160;
    const menuHeight = menu.offsetHeight || 120;
    
    // 计算菜单位置（以鼠标为基准，菜单显示在鼠标下方）
    let left = mouseX;
    let top = mouseY + 10; // 鼠标下方10px
    
        menu.style.top = `${top}px`;
    menu.style.left = `${left - menuWidth - 10 - window.scrollX}px`;
    menu.classList.add('show');


    // 点击其他地方关闭菜单
    setTimeout(() => {
        document.addEventListener('click', closeOnlineContextMenu, { once: true });
    }, 0);
}

// 关闭在线音乐上下文菜单
function closeOnlineContextMenu() {
    const menu = document.getElementById('onlineContextMenu');
    menu.classList.remove('show');
    currentOnlineMenuKey = null;
}

// 在线菜单 - 播放
function onlineMenuPlay() {
    closeOnlineContextMenu();
    if (currentOnlineMenuKey && currentOnlineMenuKey.startsWith('songlist_')) {
        const index = parseInt(currentOnlineMenuKey.replace('songlist_', ''));
        playSonglistSong(index);
    } else if (currentOnlineMenuKey) {
        playOnlineSong(currentOnlineMenuKey);
    }
}

// 在线菜单 - 下载
function onlineMenuDownload() {
    closeOnlineContextMenu();
    if (currentOnlineMenuKey && currentOnlineMenuKey.startsWith('songlist_')) {
        const index = parseInt(currentOnlineMenuKey.replace('songlist_', ''));
        downloadSonglistSong(index);
    } else if (currentOnlineMenuKey) {
        downloadOnlineSong(currentOnlineMenuKey);
    }
}

// 在线菜单 - 添加到播放列表
function onlineMenuAddToPlaylist() {
    closeOnlineContextMenu();
    if (currentOnlineMenuKey && currentOnlineMenuKey.startsWith('songlist_')) {
        const index = parseInt(currentOnlineMenuKey.replace('songlist_', ''));
        addSonglistSongToPlaylist(index);
    } else if (currentOnlineMenuKey) {
        addToPlaylistFromOnline(currentOnlineMenuKey);
    }
}

// 点击其他地方关闭菜单
document.addEventListener('click', function(e) {
    if (!e.target.closest('.online-item-menu-btn') && !e.target.closest('.online-context-menu')) {
        closeOnlineContextMenu();
    }
});

// 下载歌单中的在线歌曲
async function downloadSonglistSong(index) {
    const source = document.getElementById('onlineSourceSelect').value;
    const songElement = document.querySelector(`.online-music-item[data-index="${index}"]`);
    
    if (!songElement) {
        showNotification({ type: 'error', message: '歌曲信息丢失' });
        return;
    }
    
    const songId = songElement.dataset.songid;
    const name = songElement.dataset.name;
    const singer = songElement.dataset.singer;
    const albumName = songElement.dataset.album;
    
    showNotification({ type: 'info', message: `正在获取下载链接...` });
    
    try {
        const response = await fetch('/api/download-online', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                source: source,
                songId: songId,
                name: name,
                singer: singer,
                albumName: albumName || '',
                songInfo: {
                    songId: songId,
                    name: name,
                    singer: singer,
                    albumName: albumName,
                    source: source
                }
            })
        });
        
        if (response.ok) {
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            const artistName = singer ? `${singer} - ` : '';
            link.download = `${artistName}${name}.mp3`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            window.URL.revokeObjectURL(url);
            
            showNotification({ type: 'success', message: `下载完成：${name}` });
        } else {
            const result = await response.json();
            showNotification({ type: 'error', message: result.error || '下载失败' });
        }
    } catch (error) {
        console.error('下载失败:', error);
        showNotification({ type: 'error', message: '下载失败，请重试' });
    }
}

// 播放在线歌曲
async function playOnlineSong(cacheKey) {
    const song = onlineSongCache[cacheKey];
    if (!song) {
        showNotification({ type: 'error', message: '歌曲信息丢失，请重新搜索' });
        return;
    }
    
    showNotification({ type: 'info', message: '正在获取播放链接...' });
    
    try {
        const response = await fetch('/api/play-online', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                source: song.source,
                songId: song.songId,
                name: song.name,
                singer: song.singer,
                albumName: song.albumName || '',
                picUrl: song.picUrl || '',
                interval: song.interval || '',
                // 传递完整的歌曲信息给自定义音源
                songInfo: song
            })
        });
        
        const result = await response.json();
        
        if (result.success) {
            showNotification({ type: 'success', message: `正在播放：${song.name}` });
            
            // 客户端模式：使用客户端播放
            if (result.clientMode) {
                currentPlaylist = result.playlist || currentPlaylist;
                renderPlaylist();
                playTrack(result.currentIndex);
                return;
            }
            
            // 服务器模式：更新播放列表和状态
            const playlistResult = await apiRequest('/api/playlist');
            if (playlistResult.playlist) {
                currentPlaylist = playlistResult.playlist;
                renderPlaylist();
            }
            // 同步播放状态
            await syncStatusWithServer();
            // 启动进度更新
            startProgressUpdate();
        } else {
            // 当前平台无法播放，尝试从其他平台搜索同一首歌曲
            const platforms = ['kw', 'kg', 'tx', 'wy', 'mg'];
            const currentIndex = platforms.indexOf(song.source);
            const otherPlatforms = platforms.filter((_, i) => i !== currentIndex);
            
            // 尝试其他平台搜索并播放
            for (const platform of otherPlatforms) {
                try {
                    showNotification({ type: 'info', message: `尝试从${getSourceName(platform)}获取...` });
                    
                    // 先搜索该平台的同名歌曲
                    const searchResponse = await fetch('/api/online-search', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            keyword: `${song.name} ${song.singer}`,
                            source: platform,
                            page: 1,
                            limit: 5
                        })
                    });
                    
                    const searchResult = await searchResponse.json();
                    
                    if (searchResult.success && searchResult.results.length > 0 && searchResult.results[0].list.length > 0) {
                        // 找到匹配的歌曲，尝试播放
                        const foundSong = searchResult.results[0].list[0];
                        const altResponse = await fetch('/api/play-online', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                source: platform,
                                songId: foundSong.songId,
                                name: foundSong.name,
                                singer: foundSong.singer,
                                albumName: foundSong.albumName || '',
                                picUrl: foundSong.picUrl || '',
                                interval: foundSong.interval || ''
                            })
                        });
                        
                        const altResult = await altResponse.json();
                        
                        if (altResult.success) {
                            showNotification({ type: 'success', message: `正在播放：${foundSong.name}（${getSourceName(platform)}）` });
                            
                            // 客户端模式
                            if (altResult.clientMode) {
                                currentPlaylist = altResult.playlist || currentPlaylist;
                                renderPlaylist();
                                playTrack(altResult.currentIndex);
                                return;
                            }
                            
                            const playlistResult = await apiRequest('/api/playlist');
                            if (playlistResult.playlist) {
                                currentPlaylist = playlistResult.playlist;
                                renderPlaylist();
                            }
                            await syncStatusWithServer();
                            return;
                        }
                    }
                } catch (e) {
                    console.log(`尝试${getSourceName(platform)}失败:`, e.message);
                }
            }
            
            // 所有平台都失败
            showNotification({ type: 'error', message: result.error || '该歌曲暂无法播放（版权限制或需要付费）' });
        }
    } catch (error) {
        console.error('播放在线音乐失败:', error);
        showNotification({ type: 'error', message: '播放失败，请重试' });
    }
}

// HTML 转义
function escapeHtml(str) {
    return str
        .replace(/'/g, "\\'")
        .replace(/"/g, '\\"')
        .replace(/\\/g, '\\\\');
}

// ==================== 在线设置功能 ====================

let selectedSourceFiles = [];

// 打开上传音源文件模态框
async function openUploadSourceModal() {
    try {
        await requireLogin();
    } catch (e) {
        return;
    }
    const modal = document.getElementById('uploadSourceModal');
    modal.classList.add('show');
    document.body.style.overflow = 'hidden';
    
    // 重置状态
    selectedSourceFiles = [];
    document.getElementById('uploadSourceList').innerHTML = '';
    document.getElementById('uploadSourceStatus').style.display = 'none';
    document.getElementById('btnUploadSource').disabled = true;
}

// 关闭上传音源文件模态框
function closeUploadSourceModal() {
    const modal = document.getElementById('uploadSourceModal');
    modal.classList.remove('show');
    document.body.style.overflow = '';
    
    selectedSourceFiles = [];
    document.getElementById('uploadSourceList').innerHTML = '';
    document.getElementById('uploadSourceStatus').style.display = 'none';
    document.getElementById('uploadSourceInput').value = '';
}

// 处理音源文件选择
function handleSourceFileSelect(event) {
    const files = Array.from(event.target.files);
    
    files.forEach(file => {
        if (file.name.endsWith('.js')) {
            selectedSourceFiles.push(file);
        }
    });
    
    renderSelectedSourceFiles();
    document.getElementById('btnUploadSource').disabled = selectedSourceFiles.length === 0;
}

// 渲染已选择的音源文件
function renderSelectedSourceFiles() {
    const list = document.getElementById('uploadSourceList');
    
    if (selectedSourceFiles.length === 0) {
        list.innerHTML = '';
        return;
    }
    
    list.innerHTML = selectedSourceFiles.map((file, index) => `
        <div class="upload-source-file-item">
            <span class="upload-source-file-name">${file.name}</span>
            <span class="upload-source-file-size">${formatFileSize(file.size)}</span>
            <button class="upload-source-file-remove" onclick="removeSelectedSourceFile(${index})">
                <i class="fas fa-times"></i>
            </button>
        </div>
    `).join('');
}

// 移除已选择的音源文件
function removeSelectedSourceFile(index) {
    selectedSourceFiles.splice(index, 1);
    renderSelectedSourceFiles();
    document.getElementById('btnUploadSource').disabled = selectedSourceFiles.length === 0;
}

// 上传音源文件
async function uploadSourceFiles() {
    if (selectedSourceFiles.length === 0) return;
    
    const statusDiv = document.getElementById('uploadSourceStatus');
    const progressFill = document.getElementById('uploadSourceProgress');
    const statusText = document.getElementById('uploadSourceStatusText');
    const uploadBtn = document.getElementById('btnUploadSource');
    
    statusDiv.style.display = 'flex';
    uploadBtn.disabled = true;
    
    let uploaded = 0;
    
    for (const file of selectedSourceFiles) {
        try {
            statusText.textContent = `正在上传 ${file.name}...`;
            
            const content = await file.text();
            
            const response = await fetchWithAuth('/api/upload-source', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename: file.name, content })
            });
            
            const result = await response.json();
            
            if (result.success) {
                uploaded++;
            } else {
                showNotification({ type: 'error', message: `${file.name} 上传失败：${result.error}` });
            }
            
            progressFill.style.width = `${(uploaded / selectedSourceFiles.length) * 100}%`;
        } catch (error) {
            showNotification({ type: 'error', message: `${file.name} 上传失败` });
        }
    }
    
    statusText.textContent = `成功上传 ${uploaded}/${selectedSourceFiles.length} 个文件`;
    
    setTimeout(() => {
        closeUploadSourceModal();
        refreshSourceFiles();
        showNotification({ type: 'success', message: `成功上传 ${uploaded} 个音源文件` });
    }, 1000);
}

// 刷新音源文件列表
async function refreshSourceFiles() {
    try {
        const response = await fetch('/api/source-files');
        const result = await response.json();
        
        if (result.success) {
            renderSourceFileList(result.files);
        }
    } catch (error) {
        console.error('获取音源文件列表失败:', error);
    }
}

// 渲染音源文件列表
function renderSourceFileList(files) {
    const list = document.getElementById('sourceFileList');
    
    if (!files || files.length === 0) {
        list.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-file-audio"></i>
                <p>暂无音源文件</p>
                <p class="empty-hint">请上传音源配置文件以启用在线搜索功能</p>
            </div>
        `;
        return;
    }
    
    // 获取已激活的音源列表（后端返回的是不带.js的ID）
    const activeSources = window.activeSources || [];
    // 获取当前会话选中的音源文件列表（带.js）
    const selectedSourceFiles = window.selectedSourceFiles || [];
    
    list.innerHTML = files.map(file => {
        // 去掉文件名的.js扩展名，与后端返回的ID比较
        const fileId = file.name.replace('.js', '');
        // 同时检查两个数组：后端激活的和当前选中的
        const isActive = activeSources.includes(fileId) || selectedSourceFiles.includes(file.name);
        const displayName = file.displayName || file.name.replace('.js', '');
        const versionInfo = file.version ? ` v${file.version}` : '';
        return `
        <div class="source-file-item ${isActive ? 'selected' : ''}" data-filename="${file.name}" onclick="toggleSourceFile('${file.name}')">
            <div class="source-file-checkbox">
                <i class="fas fa-check"></i>
            </div>
            <div class="source-file-icon">
                <i class="fas fa-file-code"></i>
            </div>
            <div class="source-file-info">
                <div class="source-file-name">${displayName}${versionInfo}</div>
                <div class="source-file-size">${file.name}</div>
            </div>
            <span class="source-file-status ${isActive ? 'active' : 'inactive'}">${isActive ? '已选中' : '未选中'}</span>
            <div class="source-file-actions-row">
                <button class="source-file-delete-btn" onclick="event.stopPropagation(); deleteSourceFile('${file.name}')" title="删除">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        </div>
    `;
    }).join('');
}

// 切换音源文件选中状态
function toggleSourceFile(filename) {
    if (!window.selectedSourceFiles) {
        window.selectedSourceFiles = [];
    }
    
    const index = window.selectedSourceFiles.indexOf(filename);
    if (index > -1) {
        window.selectedSourceFiles.splice(index, 1);
    } else {
        window.selectedSourceFiles.push(filename);
    }
    
    // 更新UI
    const item = document.querySelector(`.source-file-item[data-filename="${filename}"]`);
    if (item) {
        item.classList.toggle('selected');
        const status = item.querySelector('.source-file-status');
        if (status) {
            const isSelected = window.selectedSourceFiles.includes(filename);
            status.className = `source-file-status ${isSelected ? 'active' : 'inactive'}`;
            status.textContent = isSelected ? '已选中' : '未选中';
        }
    }
}

// 应用选中的音源
async function applySelectedSources() {
    if (!window.selectedSourceFiles || window.selectedSourceFiles.length === 0) {
        showNotification({ type: 'warning', message: '请至少选择一个音源文件' });
        return;
    }
    
    try {
        const response = await fetch('/api/apply-sources', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sources: window.selectedSourceFiles })
        });
        
        const result = await response.json();
        
        if (result.success) {
            showNotification({ type: 'success', message: `已启用 ${window.selectedSourceFiles.length} 个音源` });
            // 更新激活的音源ID列表（不带.js）
            window.activeSources = window.selectedSourceFiles.map(f => f.replace('.js', ''));
            refreshSourceFiles();
        } else {
            showNotification({ type: 'error', message: result.error });
        }
    } catch (error) {
        showNotification({ type: 'error', message: '应用音源失败' });
    }
}

// 删除音源文件
let pendingSourceFileToDelete = null;

async function deleteSourceFile(filename) {
    try {
        await requireLogin();
    } catch (e) {
        return;
    }
    pendingSourceFileToDelete = filename;
    document.getElementById('deleteSourceFileName').textContent = `"${filename}"`;
    const modal = document.getElementById('deleteSourceFileModal');
    if (modal) {
        modal.classList.add('show');
    }
}

// 关闭删除音源文件模态框
function closeDeleteSourceFileModal() {
    pendingSourceFileToDelete = null;
    const modal = document.getElementById('deleteSourceFileModal');
    if (modal) {
        modal.classList.remove('show');
    }
}

// 确认删除音源文件
async function confirmDeleteSourceFile() {
    const filename = pendingSourceFileToDelete;
    if (!filename) {
        closeDeleteSourceFileModal();
        return;
    }
    
    try {
        const response = await fetch(`/api/source-files/${filename}`, {
            method: 'DELETE'
        });
        
        const result = await response.json();
        
        if (result.success) {
            showNotification({ type: 'success', message: '文件已删除' });
            refreshSourceFiles();
        } else {
            showNotification({ type: 'error', message: result.error });
        }
    } catch (error) {
        showNotification({ type: 'error', message: '删除失败' });
    } finally {
        closeDeleteSourceFileModal();
    }
}

// 获取在线设置
async function loadOnlineSettings() {
    try {
        const response = await fetch('/api/online-settings');
        const result = await response.json();
        
        if (result.success) {
            const { pageSize, activeSources } = result.settings;
            const parsedPageSize = parseInt(pageSize) || 20;
            
            document.getElementById('pageSizeSelect').value = pageSize || 20;
            FOLDER_PAGE_SIZE = parsedPageSize;
            ONLINE_PAGE_SIZE = parsedPageSize;  // 同步在线音乐分页设置
            
            // 保存激活的音源ID列表（不带.js）
            if (activeSources && activeSources.length > 0) {
                window.activeSources = activeSources;
                // 转换为带.js的文件名，用于前端选中状态
                window.selectedSourceFiles = activeSources.map(id => id.endsWith('.js') ? id : id + '.js');
            }
        }
    } catch (error) {
        console.error('获取在线设置失败:', error);
    }
}

// 保存在线设置
async function saveOnlineSettings() {
    try {
        await requireLogin();
    } catch (e) {
        return;
    }
    const pageSize = document.getElementById('pageSizeSelect').value;
    const newPageSize = parseInt(pageSize) || 20;
    
    // 如果 pageSize 发生变化，清除排行榜缓存，下次加载时会使用新的 pageSize
    if (newPageSize !== ONLINE_PAGE_SIZE) {
        rankCache = {};
        rankCurrentPage = 1;  // 重置到第一页
    }
    
    FOLDER_PAGE_SIZE = newPageSize;
    ONLINE_PAGE_SIZE = newPageSize;  // 更新在线音乐分页设置
    
    try {
        const response = await fetch('/api/online-settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pageSize })
        });
        
        const result = await response.json();
        
        if (result.success) {
            showNotification({ type: 'success', message: '设置已保存' });
        }
    } catch (error) {
        showNotification({ type: 'error', message: '保存失败' });
    }
}

// 格式化文件大小
function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

// 初始化拖拽上传
function initSourceDragDrop() {
    const dropzone = document.getElementById('uploadSourceDropzone');
    if (!dropzone) return;
    
    dropzone.addEventListener('click', () => {
        document.getElementById('uploadSourceInput').click();
    });
    
    dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('dragover');
    });
    
    dropzone.addEventListener('dragleave', () => {
        dropzone.classList.remove('dragover');
    });
    
    dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
        
        const files = Array.from(e.dataTransfer.files);
        files.forEach(file => {
            if (file.name.endsWith('.js')) {
                selectedSourceFiles.push(file);
            }
        });
        
        renderSelectedSourceFiles();
        document.getElementById('btnUploadSource').disabled = selectedSourceFiles.length === 0;
    });
}

// 切换到系统设置视图时加载设置
const originalSwitchView = switchView;
switchView = function(viewName) {
    originalSwitchView(viewName);
    
    if (viewName === 'online-settings') {
        // 加载播放相关设置
        loadAudioDevices();
        refreshCacheList();
        loadCacheLimit();
        // 先加载设置（获取 activeSources），再刷新文件列表（使用 activeSources 显示选中状态）
        loadOnlineSettings().then(() => {
            refreshSourceFiles();
        });
        setTimeout(initSourceDragDrop, 100);
        // 初始化二级菜单
        setTimeout(initSettingsSubnav, 100);
    } else if (viewName === 'online') {
        // 进入在线音乐页面时，确保在线设置已加载
        loadOnlineSettings().then(() => {
            // 检查缓存，有缓存直接显示
            const rankType = document.getElementById('rankTypeSelect').value;
            const source = document.getElementById('onlineSourceSelect').value;
            const cacheKey = `${source}_${rankType}_${rankCurrentPage}`;
            if (rankCache[cacheKey]) {
                onlineRankResults = rankCache[cacheKey];
                renderRankResults();
                renderRankPagination();
            } else {
                loadRankList();
            }
        });
    }
};

// 系统设置二级菜单
let settingsScrollHandler = null;

function initSettingsSubnav() {
    const scrollContainer = document.querySelector('#view-online-settings .content-area');
    const navItems = document.querySelectorAll('#view-online-settings .settings-subnav-item');
    
    if (!scrollContainer || navItems.length === 0) return;
    
    // 移除旧的滚动监听
    if (settingsScrollHandler) {
        scrollContainer.removeEventListener('scroll', settingsScrollHandler);
    }
    
    // 绑定菜单项点击事件
    navItems.forEach(item => {
        item.addEventListener('click', function(e) {
            e.preventDefault();
            const targetId = this.getAttribute('data-target');
            const targetEl = document.getElementById(targetId);
            if (targetEl) {
                targetEl.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start'
                });
            }
        });
    });
    
    // 滚动时高亮当前菜单项
    settingsScrollHandler = function() {
        const cards = [
            'setting-play-output',
            'setting-audio-device',
            'setting-cache',
            'setting-sources',
            'setting-search'
        ];
        
        const containerRect = scrollContainer.getBoundingClientRect();
        let activeId = cards[0];
        
        for (let i = 0; i < cards.length; i++) {
            const card = document.getElementById(cards[i]);
            if (card) {
                const cardRect = card.getBoundingClientRect();
                const cardTop = cardRect.top - containerRect.top;
                const containerHeight = scrollContainer.clientHeight;
                
                const cardMiddle = cardTop + cardRect.height / 2;
                if (cardMiddle < containerHeight / 2) {
                    activeId = cards[i];
                }
            }
        }
        
        navItems.forEach(item => {
            const target = item.getAttribute('data-target');
            if (target === activeId) {
                item.classList.add('active');
            } else {
                item.classList.remove('active');
            }
        });
    };
    
    scrollContainer.addEventListener('scroll', settingsScrollHandler);
    
    setTimeout(settingsScrollHandler, 200);
}

// ========== 歌单功能 ==========
let songlistLoaded = false;
let songlistCurrentPage = 1;
let songlistTotal = 0;
let songlistTotalPages = 1;
let songlistSearchPage = 1;
let songlistSearchTotal = 0;
let songlistSearchTotalPages = 1;
let currentSonglistDetail = null;
let currentSonglistSongs = [];

// 加载歌单标签
async function loadSonglistTags() {
    const source = document.getElementById('onlineSourceSelect').value;
    const tagSelect = document.getElementById('songlistTagSelect');
    
    try {
        const result = await apiRequest('/api/online-songlist-tags', 'POST', { source });
        
        if (result.success) {
            // 更新排序选项
            const sortSelect = document.getElementById('songlistSortSelect');
            sortSelect.innerHTML = '';
            
            // 获取音源支持的排序方式
            const sourcesResult = await apiRequest('/api/online-songlist-sources');
            const sourceInfo = sourcesResult.sources?.find(s => s.id === source);
            const sortList = sourceInfo?.sortList || [{ name: '最热', id: 'hot' }];
            
            sortList.forEach(sort => {
                const option = document.createElement('option');
                option.value = sort.id;
                option.textContent = sort.name;
                sortSelect.appendChild(option);
            });
            
            // 更新标签选项
            tagSelect.innerHTML = '<option value="">全部分类</option>';
            
            // 添加热门标签
            if (result.hotTag && result.hotTag.length > 0) {
                result.hotTag.forEach(tag => {
                    const option = document.createElement('option');
                    option.value = tag.id;
                    option.textContent = '🔥 ' + tag.name;
                    tagSelect.appendChild(option);
                });
            }
            
            // 添加分类标签
            if (result.tags && result.tags.length > 0) {
                result.tags.forEach(category => {
                    if (category.list && category.list.length > 0) {
                        category.list.forEach(tag => {
                            const option = document.createElement('option');
                            option.value = tag.id;
                            option.textContent = tag.name;
                            tagSelect.appendChild(option);
                        });
                    }
                });
            }
        }
    } catch (error) {
        console.error('加载歌单标签失败:', error);
    }
}

// 加载歌单列表
async function loadSonglistList(page = 1) {
    const source = document.getElementById('onlineSourceSelect').value;
    const sortId = document.getElementById('songlistSortSelect').value;
    const tagId = document.getElementById('songlistTagSelect').value;
    const grid = document.getElementById('songlistGrid');
    
    songlistCurrentPage = page;
    grid.innerHTML = '<div class="songlist-loading"><i class="fas fa-spinner"></i><p>加载歌单中...</p></div>';
    
    try {
        const result = await apiRequest('/api/online-songlist-list', 'POST', {
            source,
            sortId,
            tagId,
            page
        });
        
        if (result.success && result.list) {
            songlistTotal = result.total || result.list.length;
            songlistTotalPages = Math.ceil(songlistTotal / (result.limit || 30));
            songlistTotalPages = songlistTotalPages || 1;
            
            if (result.list.length === 0) {
                grid.innerHTML = '<div class="songlist-empty"><i class="fas fa-list-ul"></i><p>暂无歌单</p><p class="empty-hint">点击刷新按钮重新加载</p></div>';
            } else {
                renderSonglistGrid(result.list);
            }
            
            updateSonglistPagination();
        } else {
            grid.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-triangle"></i><p>加载失败</p></div>';
        }
    } catch (error) {
        console.error('加载歌单列表失败:', error);
        grid.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-triangle"></i><p>加载失败: ' + error.message + '</p></div>';
    }
}

// 渲染歌单网格
function renderSonglistGrid(list) {
    const grid = document.getElementById('songlistGrid');
    
    grid.innerHTML = list.map(item => `
        <div class="songlist-card" onclick="openSonglistDetail('${item.id}')">
            ${item.img 
                ? `<img class="songlist-card-img" src="${item.img}" alt="${item.name}" onerror="this.outerHTML='<div class=\\'songlist-card-img-placeholder\\'><i class=\\'fas fa-list-ul\\'></i></div>'">`
                : `<div class="songlist-card-img-placeholder"><i class="fas fa-list-ul"></i></div>`
            }
            <div class="songlist-card-content">
                <div class="songlist-card-title" title="${item.name}">${item.name}</div>
                <div class="songlist-card-meta">
                    <span class="songlist-card-playcount">
                        <i class="fas fa-play"></i> ${item.play_count || '0'}
                    </span>
                    ${item.author ? `<span class="songlist-card-author">${item.author}</span>` : ''}
                </div>
            </div>
        </div>
    `).join('');
}

// 更新歌单分页
function updateSonglistPagination() {
    const prevBtn = document.getElementById('songlistPrevBtn');
    const nextBtn = document.getElementById('songlistNextBtn');
    const pageInfo = document.getElementById('songlistPageInfo');
    
    prevBtn.disabled = songlistCurrentPage <= 1;
    nextBtn.disabled = songlistCurrentPage >= songlistTotalPages;
    pageInfo.textContent = `${songlistCurrentPage} / ${songlistTotalPages}`;
}

// 歌单分页切换
function changeSonglistPage(action) {
    if (action === 'prev' && songlistCurrentPage > 1) {
        loadSonglistList(songlistCurrentPage - 1);
    } else if (action === 'next' && songlistCurrentPage < songlistTotalPages) {
        loadSonglistList(songlistCurrentPage + 1);
    }
}

// 刷新歌单列表
function refreshSonglistList() {
    loadSonglistTags();
    loadSonglistList(songlistCurrentPage);
}

// 显示歌单搜索视图
function showSonglistSearchView() {
    document.getElementById('songlistListView').style.display = 'none';
    document.getElementById('songlistDetailView').style.display = 'none';
    document.getElementById('songlistSearchView').style.display = 'block';
    document.getElementById('songlistSearchInput').focus();
}

// 显示歌单列表视图
function showSonglistListView() {
    document.getElementById('songlistListView').style.display = 'block';
    document.getElementById('songlistSearchView').style.display = 'none';
    document.getElementById('songlistDetailView').style.display = 'none';
}

// 搜索歌单
async function searchSonglist() {
    const keyword = document.getElementById('songlistSearchInput').value.trim();
    
    if (!keyword) {
        showNotification({ type: 'warning', message: '请输入搜索关键词' });
        return;
    }
    
    const source = document.getElementById('onlineSourceSelect').value;
    const grid = document.getElementById('songlistSearchGrid');
    
    songlistSearchPage = 1;
    grid.innerHTML = '<div class="songlist-loading"><i class="fas fa-spinner"></i><p>搜索中...</p></div>';
    
    try {
        const result = await apiRequest('/api/online-songlist-search', 'POST', {
            source,
            keyword,
            page: 1,
            limit: 20
        });
        
        if (result.success && result.list) {
            songlistSearchTotal = result.total || result.list.length;
            songlistSearchTotalPages = Math.ceil(songlistSearchTotal / 20) || 1;
            
            if (result.list.length === 0) {
                grid.innerHTML = '<div class="empty-state"><i class="fas fa-search"></i><p>未找到相关歌单</p></div>';
            } else {
                renderSonglistSearchGrid(result.list);
            }
            
            updateSonglistSearchPagination();
        } else {
            grid.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-triangle"></i><p>搜索失败</p></div>';
        }
    } catch (error) {
        console.error('搜索歌单失败:', error);
        grid.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-triangle"></i><p>搜索失败</p></div>';
    }
}

// 渲染歌单搜索结果
function renderSonglistSearchGrid(list) {
    const grid = document.getElementById('songlistSearchGrid');
    
    grid.innerHTML = list.map(item => `
        <div class="songlist-card" onclick="openSonglistDetail('${item.id}')">
            ${item.img 
                ? `<img class="songlist-card-img" src="${item.img}" alt="${item.name}" onerror="this.outerHTML='<div class=\\'songlist-card-img-placeholder\\'><i class=\\'fas fa-list-ul\\'></i></div>'">`
                : `<div class="songlist-card-img-placeholder"><i class="fas fa-list-ul"></i></div>`
            }
            <div class="songlist-card-content">
                <div class="songlist-card-title" title="${item.name}">${item.name}</div>
                <div class="songlist-card-meta">
                    <span class="songlist-card-playcount">
                        <i class="fas fa-play"></i> ${item.play_count || '0'}
                    </span>
                    ${item.author ? `<span class="songlist-card-author">${item.author}</span>` : ''}
                </div>
            </div>
        </div>
    `).join('');
}

// 更新歌单搜索分页
function updateSonglistSearchPagination() {
    const prevBtn = document.getElementById('songlistSearchPrevBtn');
    const nextBtn = document.getElementById('songlistSearchNextBtn');
    const pageInfo = document.getElementById('songlistSearchPageInfo');
    
    prevBtn.disabled = songlistSearchPage <= 1;
    nextBtn.disabled = songlistSearchPage >= songlistSearchTotalPages;
    pageInfo.textContent = `${songlistSearchPage} / ${songlistSearchTotalPages}`;
}

// 歌单搜索分页
function changeSonglistSearchPage(action) {
    const keyword = document.getElementById('songlistSearchInput').value.trim();
    const source = document.getElementById('onlineSourceSelect').value;
    
    if (action === 'prev' && songlistSearchPage > 1) {
        songlistSearchPage--;
        loadSonglistSearch(keyword, songlistSearchPage);
    } else if (action === 'next' && songlistSearchPage < songlistSearchTotalPages) {
        songlistSearchPage++;
        loadSonglistSearch(keyword, songlistSearchPage);
    }
}

// 加载歌单搜索（分页）
async function loadSonglistSearch(keyword, page) {
    const source = document.getElementById('onlineSourceSelect').value;
    const grid = document.getElementById('songlistSearchGrid');
    
    grid.innerHTML = '<div class="songlist-loading"><i class="fas fa-spinner"></i><p>加载中...</p></div>';
    
    try {
        const result = await apiRequest('/api/online-songlist-search', 'POST', {
            source,
            keyword,
            page,
            limit: 20
        });
        
        if (result.success && result.list) {
            if (result.list.length === 0) {
                grid.innerHTML = '<div class="empty-state"><i class="fas fa-search"></i><p>未找到相关歌单</p></div>';
            } else {
                renderSonglistSearchGrid(result.list);
            }
            updateSonglistSearchPagination();
        }
    } catch (error) {
        console.error('加载歌单搜索失败:', error);
    }
}

// 打开歌单详情
async function openSonglistDetail(id) {
    const source = document.getElementById('onlineSourceSelect').value;
    
    // 显示详情视图
    document.getElementById('songlistListView').style.display = 'none';
    document.getElementById('songlistSearchView').style.display = 'none';
    document.getElementById('songlistDetailView').style.display = 'block';
    
    const resultsDiv = document.getElementById('songlistDetailResults');
    resultsDiv.innerHTML = '<div class="songlist-detail-empty"><i class="fas fa-spinner fa-spin"></i><p>加载歌曲中...</p></div>';
    
    try {
        const result = await apiRequest('/api/online-songlist-detail', 'POST', {
            source,
            id
        });
        
        if (result.success) {
            // 保存当前歌单信息
            currentSonglistDetail = {
                source,
                id,
                info: result.info || {},
                total: result.total || 0
            };
            currentSonglistSongs = result.list || [];
            
            // 更新歌单信息
            document.getElementById('songlistDetailTitle').innerHTML = 
                `歌单详情 <span class="count">(${result.total || 0} 首)</span>`;
            
            const info = result.info || {};
            document.getElementById('songlistInfoName').textContent = info.name || '未知歌单';
            document.getElementById('songlistInfoAuthor').textContent = info.author ? `创建者: ${info.author}` : '';
            document.getElementById('songlistInfoDesc').textContent = info.desc || '暂无描述';
            
            const imgEl = document.getElementById('songlistInfoImg');
            if (info.img) {
                imgEl.src = info.img;
                imgEl.style.display = 'block';
                imgEl.onerror = function() {
                    this.outerHTML = '<div class="songlist-info-img-placeholder"><i class="fas fa-list-ul"></i></div>';
                };
            } else {
                imgEl.outerHTML = '<div class="songlist-info-img-placeholder"><i class="fas fa-list-ul"></i></div>';
            }
            
            // 渲染歌曲列表
            if (result.list && result.list.length > 0) {
                renderSonglistSongs(result.list);
            } else {
                resultsDiv.innerHTML = '<div class="songlist-detail-empty"><i class="fas fa-music"></i><p>歌单为空</p></div>';
            }
        } else {
            resultsDiv.innerHTML = '<div class="songlist-detail-empty"><i class="fas fa-exclamation-triangle"></i><p>加载失败</p></div>';
        }
    } catch (error) {
        console.error('加载歌单详情失败:', error);
        resultsDiv.innerHTML = '<div class="songlist-detail-empty"><i class="fas fa-exclamation-triangle"></i><p>加载失败</p></div>';
    }
}

// 渲染歌单歌曲列表
function renderSonglistSongs(songs) {
    const resultsDiv = document.getElementById('songlistDetailResults');
    const source = document.getElementById('onlineSourceSelect').value;
    
    resultsDiv.innerHTML = songs.map((song, index) => `
        <div class="online-music-item" data-index="${index}" data-source="${source}" data-songid="${song.songmid || song.id || index}" data-name="${song.name || '未知歌曲'}" data-singer="${song.singer || ''}" data-album="${song.albumName || ''}" data-pic="${song.img || ''}" data-interval="${song.interval || '0'}">
            <div class="online-music-index">${index + 1}</div>
            <div class="online-music-info">
                <div class="online-music-title">${song.name || '未知歌曲'}</div>
                <div class="online-music-artist">${song.singer || '-'}</div>
            </div>
            <div class="online-music-album">${song.albumName || '-'}</div>
            <div class="online-music-duration">${song.interval || '--:--'}</div>
            <div class="online-music-actions">
                <button onclick="event.stopPropagation(); playSonglistSong(${index})" class="online-music-play-btn" title="播放">
                    <i class="fas fa-play"></i>
                </button>
                <button onclick="event.stopPropagation(); downloadSonglistSong(${index})" class="online-music-download-btn" title="下载">
                    <i class="fas fa-download"></i>
                </button>
                <button onclick="event.stopPropagation(); addSonglistSongToPlaylist(${index})" class="online-music-add-btn" title="添加到播放列表">
                    <i class="fas fa-plus"></i>
                </button>
            </div>
            <!-- 移动端菜单按钮 - 使用全局菜单 -->
            <button class="online-item-menu-btn" onclick="event.stopPropagation(); toggleOnlineItemMenu(event, 'songlist_${index}')" title="更多">
                <i class="fas fa-ellipsis-v"></i>
            </button>
        </div>
    `).join('');
}

// 添加歌单歌曲到播放列表
async function addSonglistSongToPlaylist(index) {
    const song = currentSonglistSongs[index];
    if (!song) return;
    
    const source = document.getElementById('onlineSourceSelect').value;
    
    try {
        const result = await apiRequest('/api/add-online-to-playlist', 'POST', {
            source,
            songId: song.songmid || song.id,
            name: song.name,
            singer: song.singer,
            albumName: song.albumName,
            picUrl: song.img,
            interval: song.interval,
            songInfo: song
        });
        
        if (result.success) {
            showNotification({ type: 'success', message: '已添加到播放列表' });
            loadPlaylistData();
        } else {
            showNotification({ type: 'warning', message: result.message || '添加失败' });
        }
    } catch (error) {
        console.error('添加歌曲失败:', error);
        showNotification({ type: 'error', message: '添加失败' });
    }
}

// 播放歌单歌曲
async function playSonglistSong(index) {
    const song = currentSonglistSongs[index];
    if (!song) return;
    
    const source = document.getElementById('onlineSourceSelect').value;
    
    // 客户端模式：先添加到播放列表，然后用客户端播放
    if (playOutput === 'client') {
        try {
            showNotification({ type: 'info', message: '正在获取播放链接...' });
            
            const response = await fetch('/api/play-online', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    source: source,
                    songId: song.songmid || song.id,
                    name: song.name,
                    singer: song.singer,
                    albumName: song.albumName || '',
                    picUrl: song.img || '',
                    interval: song.interval || '',
                    songInfo: song
                })
            });
            
            const result = await response.json();
            
            if (result.success) {
                // 更新播放列表
                currentPlaylist = result.playlist || currentPlaylist;
                renderPlaylist();
                
                // 用客户端播放
                playTrack(result.currentIndex);
            } else {
                showNotification({ type: 'error', message: result.message || '播放失败' });
            }
        } catch (error) {
            console.error('播放歌曲失败:', error);
            showNotification({ type: 'error', message: '播放失败' });
        }
        return;
    }
    
    showNotification({ type: 'info', message: '正在获取播放链接...' });
    
    try {
        const response = await fetch('/api/play-online', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                source: source,
                songId: song.songmid || song.id,
                name: song.name,
                singer: song.singer,
                albumName: song.albumName || '',
                picUrl: song.img || '',
                interval: song.interval || '',
                songInfo: song
            })
        });
        
        const result = await response.json();
        
        if (result.success) {
            showNotification({ type: 'success', message: `正在播放：${song.name}` });
            const playlistResult = await apiRequest('/api/playlist');
            if (playlistResult.playlist) {
                currentPlaylist = playlistResult.playlist;
                renderPlaylist();
            }
            await syncStatusWithServer();
            updateProgressBar();
        } else {
            showNotification({ type: 'error', message: result.message || '播放失败' });
        }
    } catch (error) {
        console.error('播放歌曲失败:', error);
        showNotification({ type: 'error', message: '播放失败' });
    }
}

// 播放全部歌单歌曲
async function playAllSonglistSongs() {
    if (currentSonglistSongs.length === 0) return;
    
    const source = document.getElementById('onlineSourceSelect').value;
    
    try {
        // 清空当前播放列表
        await apiRequest('/api/clear-playlist', 'POST');
        
        // 逐个添加歌曲
        for (let i = 0; i < currentSonglistSongs.length; i++) {
            const song = currentSonglistSongs[i];
            await apiRequest('/api/add-online-to-playlist', 'POST', {
                source,
                songId: song.songmid || song.id,
                name: song.name,
                singer: song.singer,
                albumName: song.albumName,
                picUrl: song.img,
                interval: song.interval,
                songInfo: song
            });
        }
        
        // 播放第一首
        if (playOutput === 'client') {
            // 客户端模式：先刷新播放列表，再用客户端播放
            const playlistResult = await apiRequest('/api/playlist');
            if (playlistResult.playlist) {
                currentPlaylist = playlistResult.playlist;
            }
            playTrack(0);
        } else {
            await apiRequest('/api/play/0');
        }
        
        loadPlaylistData();
        showNotification({ type: 'success', message: `已添加 ${currentSonglistSongs.length} 首歌曲到播放列表` });
    } catch (error) {
        console.error('播放全部失败:', error);
        showNotification({ type: 'error', message: '播放失败' });
    }
}


