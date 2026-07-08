const express = require('express');
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');
const https = require('https');
const http = require('http');
const mm = require('music-metadata');
const multer = require('multer');
const AdmZip = require('adm-zip');
const iconv = require('iconv-lite');
const NodeID3 = require('node-id3');
const ffmetadata = require('ffmetadata');
const ffmpeg = require('fluent-ffmpeg');

// 自定义音源系统
const userApi = require('./server/userApi');
const customSourceHandlers = require('./server/customSourceHandlers');

// 在线歌单模块
const songList = require('./server/songList');

const app = express();
const PORT = process.env.PORT || 9524;

// 配置：是否在 Docker 环境中运行
const IS_DOCKER = process.env.IS_DOCKER === 'true' || false;

app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));
app.use(express.static('public'));

// SSE 客户端集合
const updateProgressClients = new Set();

// 在线音乐播放链接获取控制器（用于取消之前的请求）
let currentMusicUrlController = null;

// SSE 端点：推送更新进度
app.get('/api/update-progress', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    
    updateProgressClients.add(res);
    
    req.on('close', () => {
        updateProgressClients.delete(res);
    });
});

// 推送进度到所有 SSE 客户端
function broadcastUpdateProgress(data) {
    const message = `data: ${JSON.stringify(data)}\n\n`;
    for (const client of updateProgressClients) {
        client.write(message);
    }
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, path.join(__dirname, 'temp_uploads'));
    },
    filename: (req, file, cb) => {
        const originalName = file.originalname;
        const timestamp = Date.now();
        cb(null, `${timestamp}_${originalName}`);
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 500 * 1024 * 1024, // 单个文件最大 500MB
        files: 50 // 最多 50 个文件
    }
});

const avatarStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const avatarDir = path.join(__dirname, 'data', 'avatars');
        if (!fs.existsSync(avatarDir)) {
            fs.mkdirSync(avatarDir, { recursive: true });
        }
        cb(null, avatarDir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `avatar_${Date.now()}${ext}`);
    }
});

const avatarUpload = multer({
    storage: avatarStorage,
    limits: {
        fileSize: 5 * 1024 * 1024
    },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error('只支持图片文件'));
        }
    }
});

let currentPlaylist = [];
let currentIndex = -1;
let isPlaying = false;
let currentVolume = 70; // 默认音量 70%
let isMuted = false; // 是否静音
let playbackStartTime = null; // 播放开始时间
let currentDuration = 0; // 当前歌曲时长（秒）
let currentAudioDevice = 'default'; // 当前选中的声卡设备
let playOutput = 'server'; // 播放输出方式：server(服务器声卡), client(客户端浏览器)
let playMode = 'sequence'; // 播放模式：sequence(顺序播放), random(随机播放), single(单曲播放), loop(单曲循环)
let onlineSource = 'wy'; // 在线音乐默认音源平台
let pausedElapsed = 0; // 暂停时的已播放秒数

// 用户认证
const USER_CONFIG_FILE = path.join(__dirname, 'data', 'user.json');
const AUTH_TOKENS_FILE = path.join(__dirname, 'data', 'auth_tokens.json');
let userConfig = {
    username: 'admin',
    passwordHash: null,
    passwordSalt: null,
    nickname: '管理员',
    avatar: null
};
let authTokens = new Map();

function loadUserConfig() {
    try {
        if (fs.existsSync(USER_CONFIG_FILE)) {
            const data = fs.readFileSync(USER_CONFIG_FILE, 'utf8');
            userConfig = JSON.parse(data);
            console.log(`👤 已加载用户配置，用户名：${userConfig.username}`);
        } else {
            saveUserConfig();
            console.log('👤 未找到用户配置，已创建默认配置');
        }
    } catch (err) {
        console.error('加载用户配置失败:', err.message);
    }
}

function saveUserConfig() {
    try {
        fs.writeFileSync(USER_CONFIG_FILE, JSON.stringify(userConfig, null, 4), 'utf8');
    } catch (err) {
        console.error('保存用户配置失败:', err.message);
    }
}

function loadAuthTokens() {
    try {
        if (fs.existsSync(AUTH_TOKENS_FILE)) {
            const data = fs.readFileSync(AUTH_TOKENS_FILE, 'utf8');
            const tokens = JSON.parse(data);
            authTokens = new Map(Object.entries(tokens));
            console.log(`🔑 已加载 ${authTokens.size} 个登录令牌`);
        }
    } catch (err) {
        console.error('加载登录令牌失败:', err.message);
    }
}

function saveAuthTokens() {
    try {
        const tokens = Object.fromEntries(authTokens);
        fs.writeFileSync(AUTH_TOKENS_FILE, JSON.stringify(tokens, null, 4), 'utf8');
    } catch (err) {
        console.error('保存登录令牌失败:', err.message);
    }
}

function hashPassword(password, salt) {
    if (!salt) {
        salt = crypto.randomBytes(16).toString('hex');
    }
    const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
    return { hash, salt };
}

function verifyPassword(password, hash, salt) {
    const result = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
    return result === hash;
}

function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

const TOKEN_EXPIRE_MS = 7 * 24 * 60 * 60 * 1000; // 7天

function requireAuth(req, res, next) {
    if (!userConfig.passwordHash) {
        return next();
    }
    const token = req.headers['authorization']?.replace('Bearer ', '') || req.query.token;
    if (!token || !authTokens.has(token)) {
        return res.status(401).json({ success: false, error: '未登录或登录已过期' });
    }
    const tokenData = authTokens.get(token);
    if (tokenData.loginAt && (Date.now() - tokenData.loginAt > TOKEN_EXPIRE_MS)) {
        authTokens.delete(token);
        saveAuthTokens();
        return res.status(401).json({ success: false, error: '未登录或登录已过期' });
    }
    req.authToken = token;
    next();
}

// 批量转换任务队列
let convertQueue = [];
let activeConvertWorkers = 0; // 当前活跃的转换工作线程数
let maxConvertWorkers = 2; // 最大并发转换线程数
let completedTasks = []; // 已完成的转换任务记录

// 上传队列
let uploadQueue = [];
let activeUploadWorkers = 0; // 当前活跃的上传工作线程数
let maxUploadWorkers = 3; // 最大并发上传线程数
let completedUploads = []; // 已完成的上传任务记录
let activeConvertTasks = []; // 当前正在转换的任务数组（支持多并发）
let activeUploadTasks = []; // 当前正在上传的任务数组（支持多并发）

// 下载队列
let downloadQueue = [];
let activeDownloadWorkers = 0; // 当前活跃的下载工作线程数
let maxDownloadWorkers = 3; // 最大并发下载线程数
let completedDownloads = []; // 已完成的下载任务记录
let activeDownloadTasks = []; // 当前正在下载的任务数组（支持多并发）

let taskOrderCounter = 0; // 全局任务序号计数器，确保任务按添加顺序执行

// 任务完成通知队列
let taskNotifications = []; // 存储队列完成的通知消息

// 批量下载到本地的任务
const batchDownloads = new Map();

// 任务持久化相关
const TASK_DATA_FILE = path.join(__dirname, 'data', 'tasks.json');

// 确保数据目录存在
function ensureDataDir() {
    const dataDir = path.dirname(TASK_DATA_FILE);
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
}

// 加载任务数据
function loadTaskData() {
    ensureDataDir();
    if (fs.existsSync(TASK_DATA_FILE)) {
        try {
            const data = fs.readFileSync(TASK_DATA_FILE, 'utf8');
            const parsed = JSON.parse(data);
            completedTasks = parsed.completedTasks || [];
            completedUploads = parsed.completedUploads || [];
            completedDownloads = parsed.completedDownloads || [];
            console.log(`📥 已加载 ${completedTasks.length} 个转换任务、${completedUploads.length} 个上传任务和 ${completedDownloads.length} 个下载任务`);
        } catch (error) {
            console.error('加载任务数据失败:', error);
        }
    }
}

// 保存任务数据
function saveTaskData() {
    ensureDataDir();
    const data = {
        completedTasks,
        completedUploads,
        completedDownloads,
        savedAt: Date.now()
    };
    fs.writeFileSync(TASK_DATA_FILE, JSON.stringify(data, null, 2));
}

// 初始化时加载任务数据
loadTaskData();

// 全局音乐目录
const MUSIC_DIR = path.join(__dirname, 'music');
const APP_CONFIG_FILE = path.join(__dirname, 'data', 'config.json'); // 应用配置文件
const FOLDER_CACHE_FILE = path.join(__dirname, 'data', 'folder_cache.json'); // 文件夹缓存文件
const PLAYLIST_CACHE_FILE = path.join(__dirname, 'data', 'playlist_cache.json');
const USER_SONGLISTS_FILE = path.join(__dirname, 'data', 'user_songlists.json');
const PLAY_HISTORY_FILE = path.join(__dirname, 'data', 'play_history.json');
const CACHE_DIR = path.join(__dirname, 'data', 'cache'); // 在线音乐缓存目录
const CACHE_META_FILE = path.join(__dirname, 'data', 'cache_meta.json'); // 缓存元数据文件
const MUSIC_EXTENSIONS = ['.mp3', '.flac', '.wav', '.m4a', '.ogg', '.wma'];
const MAX_PLAY_HISTORY = 200; // 最多保存200条播放历史

// 用户歌单
let userSonglists = [];

// 播放历史
let playHistory = [];

function loadPlayHistory() {
    try {
        if (fs.existsSync(PLAY_HISTORY_FILE)) {
            const data = fs.readFileSync(PLAY_HISTORY_FILE, 'utf8');
            playHistory = JSON.parse(data);
            console.log(`⏱️  已加载播放历史，共 ${playHistory.length} 条`);
        }
    } catch (err) {
        console.error('加载播放历史失败:', err.message);
        playHistory = [];
    }
}

function savePlayHistory() {
    try {
        fs.writeFileSync(PLAY_HISTORY_FILE, JSON.stringify(playHistory, null, 2), 'utf8');
    } catch (err) {
        console.error('保存播放历史失败:', err.message);
    }
}

function addToPlayHistory(track) {
    if (!track) return;
    
    // 去重：如果已存在相同歌曲，先移除旧的
    const existingIndex = playHistory.findIndex(item => 
        (item.id && track.id && item.id === track.id) || 
        (item.path && track.path && item.path === track.path)
    );
    
    if (existingIndex !== -1) {
        playHistory.splice(existingIndex, 1);
    }
    
    // 添加到最前面
    playHistory.unshift({
        id: track.id || null,
        title: track.title,
        artist: track.artist,
        album: track.album,
        duration: track.duration,
        path: track.path,
        source: track.source,
        cover: track.cover || track.picUrl || track.albumCover,
        isOnline: track.isOnline || track.path?.startsWith('online://'),
        songInfo: track.songInfo,
        playedAt: Date.now()
    });
    
    // 限制数量
    if (playHistory.length > MAX_PLAY_HISTORY) {
        playHistory = playHistory.slice(0, MAX_PLAY_HISTORY);
    }
    
    savePlayHistory();
}

function loadUserSonglists() {
    try {
        if (fs.existsSync(USER_SONGLISTS_FILE)) {
            const data = fs.readFileSync(USER_SONGLISTS_FILE, 'utf8');
            userSonglists = JSON.parse(data);
            console.log(`📋 已加载用户歌单，共 ${userSonglists.length} 个`);
        }
    } catch (err) {
        console.error('加载用户歌单失败:', err.message);
        userSonglists = [];
    }
    ensureFavoritesSonglist();
}

function ensureFavoritesSonglist() {
    const favorites = userSonglists.find(l => l.id === 'favorites');
    if (!favorites) {
        userSonglists.unshift({
            id: 'favorites',
            name: '我喜欢的音乐',
            cover: null,
            songs: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
            isFavorites: true
        });
        saveUserSonglists();
        console.log('❤️ 已创建"我喜欢的音乐"歌单');
    } else if (!favorites.isFavorites) {
        favorites.isFavorites = true;
        saveUserSonglists();
    }
}

function saveUserSonglists() {
    try {
        fs.writeFileSync(USER_SONGLISTS_FILE, JSON.stringify(userSonglists, null, 2), 'utf8');
    } catch (err) {
        console.error('保存用户歌单失败:', err.message);
    }
}

// 缓存元数据（内存缓存）
let cacheMetadata = {};

// 缓存大小限制（MB），0 表示不限制
let cacheLimitSize = 0;

// 缓存写入锁（防止并发写入同一文件）
let cacheWriteLocks = new Set();

// 确保缓存目录存在
function ensureCacheDir() {
    if (!fs.existsSync(CACHE_DIR)) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
}

// 加载缓存元数据
function loadCacheMetadata() {
    try {
        if (fs.existsSync(CACHE_META_FILE)) {
            const data = fs.readFileSync(CACHE_META_FILE, 'utf8');
            cacheMetadata = JSON.parse(data);
            console.log(`📦 已加载缓存元数据，共 ${Object.keys(cacheMetadata).length} 个缓存文件`);
        }
    } catch (err) {
        console.error('加载缓存元数据失败:', err.message);
        cacheMetadata = {};
    }
}

// 保存缓存元数据
function saveCacheMetadata() {
    try {
        fs.writeFileSync(CACHE_META_FILE, JSON.stringify(cacheMetadata, null, 2), 'utf8');
    } catch (err) {
        console.error('保存缓存元数据失败:', err.message);
    }
}

// 生成缓存键
function getCacheKey(source, songId) {
    return `${source}_${songId}`;
}

// 获取缓存文件路径
function getCacheFilePath(cacheKey, ext = '.mp3') {
    return path.join(CACHE_DIR, `${cacheKey}${ext}`);
}

// 检查缓存是否存在
function checkCache(source, songId) {
    const cacheKey = getCacheKey(source, songId);
    const meta = cacheMetadata[cacheKey];
    if (!meta) return null;
    
    const filePath = getCacheFilePath(cacheKey, meta.ext || '.mp3');
    if (fs.existsSync(filePath)) {
        const stats = fs.statSync(filePath);
        if (stats.size > 0) {
            return { ...meta, filePath, size: stats.size, cacheKey };
        }
    }
    // 文件不存在，清理元数据
    delete cacheMetadata[cacheKey];
    saveCacheMetadata();
    return null;
}

// 保存缓存元数据
function addCacheMeta(source, songId, title, artist, album, ext, size) {
    const cacheKey = getCacheKey(source, songId);
    cacheMetadata[cacheKey] = {
        source,
        songId,
        title,
        artist,
        album,
        ext,
        size,
        cachedAt: Date.now()
    };
    saveCacheMetadata();
    
    // 缓存写入后，检查是否超出限制
    if (cacheLimitSize > 0) {
        setImmediate(() => {
            checkAndCleanCache();
        });
    }
}

// 删除单个缓存
function deleteCache(cacheKey) {
    const meta = cacheMetadata[cacheKey];
    if (meta) {
        const filePath = getCacheFilePath(cacheKey, meta.ext || '.mp3');
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        delete cacheMetadata[cacheKey];
        saveCacheMetadata();
        return true;
    }
    return false;
}

// 清空所有缓存
function clearAllCache() {
    try {
        if (fs.existsSync(CACHE_DIR)) {
            const files = fs.readdirSync(CACHE_DIR);
            files.forEach(file => {
                const filePath = path.join(CACHE_DIR, file);
                if (fs.statSync(filePath).isFile()) {
                    fs.unlinkSync(filePath);
                }
            });
        }
        cacheMetadata = {};
        saveCacheMetadata();
        return true;
    } catch (err) {
        console.error('清空缓存失败:', err.message);
        return false;
    }
}

// 获取缓存总大小
function getCacheTotalSize() {
    let totalSize = 0;
    if (fs.existsSync(CACHE_DIR)) {
        const files = fs.readdirSync(CACHE_DIR);
        files.forEach(file => {
            const filePath = path.join(CACHE_DIR, file);
            if (fs.statSync(filePath).isFile()) {
                totalSize += fs.statSync(filePath).size;
            }
        });
    }
    return totalSize;
}

// 检查并清理超出限制的缓存（删除最旧的）
function checkAndCleanCache() {
    if (cacheLimitSize <= 0) return { cleaned: false, freedSize: 0, removedCount: 0 };
    
    const limitBytes = cacheLimitSize * 1024 * 1024;
    let totalSize = getCacheTotalSize();
    
    if (totalSize <= limitBytes) {
        return { cleaned: false, freedSize: 0, removedCount: 0 };
    }
    
    // 按缓存时间从旧到新排序
    const sortedCaches = Object.entries(cacheMetadata)
        .map(([cacheKey, meta]) => ({ cacheKey, meta }))
        .sort((a, b) => (a.meta.cachedAt || 0) - (b.meta.cachedAt || 0));
    
    let freedSize = 0;
    let removedCount = 0;
    
    for (const { cacheKey, meta } of sortedCaches) {
        if (totalSize <= limitBytes) break;
        
        const size = meta.size || 0;
        if (deleteCache(cacheKey)) {
            totalSize -= size;
            freedSize += size;
            removedCount++;
            console.log(`🧹 自动清理缓存: ${cacheKey} (${(size / 1024 / 1024).toFixed(2)} MB)`);
        }
    }
    
    if (removedCount > 0) {
        console.log(`✅ 缓存清理完成，共删除 ${removedCount} 个缓存，释放 ${(freedSize / 1024 / 1024).toFixed(2)} MB`);
    }
    
    return { cleaned: true, freedSize, removedCount };
}

// 从 Content-Type 推断文件扩展名
function getExtFromContentType(contentType) {
    const map = {
        'audio/mpeg': '.mp3',
        'audio/mp3': '.mp3',
        'audio/flac': '.flac',
        'audio/x-flac': '.flac',
        'audio/wav': '.wav',
        'audio/x-wav': '.wav',
        'audio/mp4': '.m4a',
        'audio/x-m4a': '.m4a',
        'audio/ogg': '.ogg',
        'audio/vorbis': '.ogg',
        'audio/wma': '.wma',
        'audio/x-ms-wma': '.wma'
    };
    return map[contentType] || '.mp3';
}

function loadConfig() {
    try {
        if (fs.existsSync(APP_CONFIG_FILE)) {
            const configData = fs.readFileSync(APP_CONFIG_FILE, 'utf8');
            const config = JSON.parse(configData);
            if (config.playMode) {
                playMode = config.playMode;
                console.log(`📂 已加载配置，播放模式：${playMode}`);
            }
            if (config.audioDevice) {
                currentAudioDevice = config.audioDevice;
                console.log(`📂 已加载配置，声卡设备：${currentAudioDevice}`);
            }
            if (config.playOutput) {
                playOutput = config.playOutput;
                console.log(`📂 已加载配置，播放输出：${playOutput === 'server' ? '服务器声卡' : '客户端浏览器'}`);
            }
            if (config.maxConvertWorkers !== undefined) {
                maxConvertWorkers = Math.max(1, Math.min(10, parseInt(config.maxConvertWorkers, 10) || 2));
                console.log(`⚙️ 已加载配置，转换线程数：${maxConvertWorkers}`);
            }
            if (config.maxUploadWorkers !== undefined) {
                maxUploadWorkers = Math.max(1, Math.min(10, parseInt(config.maxUploadWorkers, 10) || 3));
                console.log(`⚙️ 已加载配置，上传线程数：${maxUploadWorkers}`);
            }
            if (config.onlineSource) {
                onlineSource = config.onlineSource;
                console.log(`📂 已加载配置，在线音源平台：${onlineSource}`);
            }
            if (config.cacheLimitSize !== undefined) {
                cacheLimitSize = Math.max(0, parseInt(config.cacheLimitSize, 10) || 0);
                console.log(`📦 已加载配置，缓存大小限制：${cacheLimitSize === 0 ? '不限制' : cacheLimitSize + ' MB'}`);
            }
        }
    } catch (err) {
        console.log('加载配置文件失败，使用默认配置:', err.message);
    }
}

function saveConfig() {
    try {
        const config = { 
            playMode: playMode,
            audioDevice: currentAudioDevice,
            playOutput: playOutput,
            maxConvertWorkers: maxConvertWorkers,
            maxUploadWorkers: maxUploadWorkers,
            onlineSource: onlineSource,
            cacheLimitSize: cacheLimitSize
        };
        fs.writeFileSync(APP_CONFIG_FILE, JSON.stringify(config, null, 4), 'utf8');
    } catch (err) {
        console.error('保存配置文件失败:', err.message);
    }
}

function scanMusicFiles(dir) {
    const files = [];
    try {
        if (!fs.existsSync(dir)) {
            return files;
        }
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                files.push(...scanMusicFiles(fullPath));
            } else if (MUSIC_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) {
                files.push(fullPath);
            }
        }
    } catch (err) {
        console.error('扫描目录失败:', err.message);
    }
    return files;
}

async function getMusicMetadata(filePath) {
    try {
        const metadata = await mm.parseFile(filePath);
        return {
            title: metadata.common.title || path.basename(filePath),
            artist: metadata.common.artist || '未知艺术家',
            album: metadata.common.album || '未知专辑',
            duration: metadata.format.duration || 0,
            path: filePath,
            filename: path.basename(filePath)
        };
    } catch (err) {
        return {
            title: path.basename(filePath),
            artist: '未知艺术家',
            album: '未知专辑',
            duration: 0,
            path: filePath,
            filename: path.basename(filePath)
        };
    }
}

async function loadMusicLibrary() {
    // 只加载缓存，不扫描（用户要求：只有点击刷新才扫描）
    if (fs.existsSync(PLAYLIST_CACHE_FILE)) {
        try {
            const cacheData = fs.readFileSync(PLAYLIST_CACHE_FILE, 'utf8');
            const parsed = JSON.parse(cacheData);
            
            // 检查缓存是否为空数组或空对象
            if (Array.isArray(parsed) && parsed.length > 0) {
                currentPlaylist = parsed;
                // 按标题字母排序
                currentPlaylist.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
                console.log(`📚 从缓存加载了 ${currentPlaylist.length} 首音乐`);
            } else {
                currentPlaylist = [];
                console.log(`📚 播放列表缓存为空，当前播放列表为空`);
            }
        } catch (error) {
            console.error('加载播放列表缓存失败:', error.message);
            currentPlaylist = [];
        }
    } else {
        currentPlaylist = [];
        console.log(`📚 播放列表缓存不存在，当前播放列表为空`);
    }
}

async function scanMusicLibrary() {
    // 完整扫描并更新缓存（供刷新按钮调用）
    const musicDir = path.join(__dirname, 'music');
    const files = scanMusicFiles(musicDir);
    currentPlaylist = [];

    const promises = files.map(async file => {
        const metadata = await getMusicMetadata(file);
        currentPlaylist.push(metadata);
    });

    await Promise.all(promises);

    // 按标题字母排序
    currentPlaylist.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));

    // 保存到缓存
    try {
        fs.writeFileSync(PLAYLIST_CACHE_FILE, JSON.stringify(currentPlaylist, null, 2));
        console.log(`📚 已扫描并缓存 ${currentPlaylist.length} 首音乐`);
    } catch (error) {
        console.error('保存播放列表缓存失败:', error.message);
    }
}

loadConfig();
loadUserConfig();
loadAuthTokens();
ensureCacheDir();
loadCacheMetadata();
loadMusicLibrary();
loadUserSonglists();
loadPlayHistory();

app.get('/api/playlist', (req, res) => {
    res.json({ playlist: currentPlaylist, currentIndex, isPlaying });
});

// 获取用户信息（是否需要登录等）
app.get('/api/user/info', (req, res) => {
    const token = req.headers['authorization']?.replace('Bearer ', '') || req.query.token;
    let isLoggedIn = false;
    if (token && authTokens.has(token)) {
        const tokenData = authTokens.get(token);
        if (tokenData.loginAt && (Date.now() - tokenData.loginAt > TOKEN_EXPIRE_MS)) {
            authTokens.delete(token);
            saveAuthTokens();
        } else {
            isLoggedIn = true;
        }
    }
    res.json({
        success: true,
        needPassword: !!userConfig.passwordHash,
        isLoggedIn,
        username: userConfig.username,
        nickname: userConfig.nickname,
        avatar: userConfig.avatar
    });
});

// 登录
app.post('/api/user/login', (req, res) => {
    const { username, password } = req.body;
    
    if (!userConfig.passwordHash) {
        return res.status(400).json({ success: false, error: '尚未设置密码，请先设置密码' });
    }
    
    if (username !== userConfig.username) {
        return res.status(401).json({ success: false, error: '用户名或密码错误' });
    }
    
    if (!verifyPassword(password, userConfig.passwordHash, userConfig.passwordSalt)) {
        return res.status(401).json({ success: false, error: '用户名或密码错误' });
    }
    
    const token = generateToken();
    authTokens.set(token, {
        username: userConfig.username,
        loginAt: Date.now()
    });
    saveAuthTokens();

    res.json({
        success: true,
        token,
        username: userConfig.username,
        nickname: userConfig.nickname,
        avatar: userConfig.avatar,
        message: '登录成功'
    });
});

// 登出
app.post('/api/user/logout', (req, res) => {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    if (token && authTokens.has(token)) {
        authTokens.delete(token);
        saveAuthTokens();
    }
    res.json({ success: true, message: '已退出登录' });
});

// 设置密码（首次设置或修改密码，需要登录或首次设置）
app.post('/api/user/set-password', (req, res) => {
    const { oldPassword, newPassword, username, nickname } = req.body;
    
    if (!newPassword || newPassword.length < 4) {
        return res.status(400).json({ success: false, error: '密码长度不能少于4位' });
    }
    
    if (userConfig.passwordHash) {
        const token = req.headers['authorization']?.replace('Bearer ', '');
        if (!token || !authTokens.has(token)) {
            if (!oldPassword || !verifyPassword(oldPassword, userConfig.passwordHash, userConfig.passwordSalt)) {
                return res.status(401).json({ success: false, error: '原密码错误' });
            }
        }
    }
    
    const { hash, salt } = hashPassword(newPassword);
    userConfig.passwordHash = hash;
    userConfig.passwordSalt = salt;
    
    if (username) {
        userConfig.username = username;
    }
    if (nickname !== undefined) {
        userConfig.nickname = nickname;
    }
    
    saveUserConfig();
    res.json({ success: true, message: '密码设置成功' });
});

// 修改用户资料
app.post('/api/user/profile', requireAuth, (req, res) => {
    const { nickname } = req.body;
    
    if (nickname !== undefined) {
        userConfig.nickname = nickname;
    }
    
    saveUserConfig();
    res.json({ 
        success: true, 
        username: userConfig.username, 
        nickname: userConfig.nickname,
        avatar: userConfig.avatar
    });
});

// 上传头像
app.post('/api/user/avatar', requireAuth, (req, res) => {
    avatarUpload.single('avatar')(req, res, (err) => {
        if (err) {
            console.error('头像上传错误:', err.message);
            return res.status(400).json({ success: false, error: err.message });
        }
        
        if (!req.file) {
            return res.status(400).json({ success: false, error: '请选择图片文件' });
        }
        
        if (userConfig.avatar) {
            const oldAvatarPath = path.join(__dirname, 'data', 'avatars', path.basename(userConfig.avatar));
            if (fs.existsSync(oldAvatarPath)) {
                try { fs.unlinkSync(oldAvatarPath); } catch (e) {}
            }
        }
        
        const avatarUrl = `/api/user/avatar/${req.file.filename}`;
        userConfig.avatar = avatarUrl;
        saveUserConfig();
        
        res.json({
            success: true,
            avatar: avatarUrl
        });
    });
});

app.get('/api/user/avatar/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(__dirname, 'data', 'avatars', filename);
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        res.status(404).json({ error: '头像不存在' });
    }
});

// 获取歌单封面（优先使用在线音乐封面）
function getSonglistCover(songlist) {
    if (songlist.cover) return songlist.cover;
    
    const onlineSong = songlist.songs.find(s => 
        s.isOnline && (s.picUrl || s.cover || s.img)
    );
    if (onlineSong) {
        return onlineSong.picUrl || onlineSong.cover || onlineSong.img;
    }
    
    return null;
}

// 获取用户歌单列表
app.get('/api/user/songlists', requireAuth, (req, res) => {
    const lists = userSonglists.map(list => ({
        id: list.id,
        name: list.name,
        cover: getSonglistCover(list),
        count: list.songs.length,
        createdAt: list.createdAt,
        updatedAt: list.updatedAt
    }));
    res.json({ success: true, songlists: lists });
});

// 获取歌单详情
app.get('/api/user/songlists/:id', requireAuth, async (req, res) => {
    try {
        const songlist = userSonglists.find(l => l.id === req.params.id);
        if (!songlist) {
            return res.status(404).json({ success: false, error: '歌单不存在' });
        }
        
        const songsWithStatus = songlist.songs.map(song => {
            let exists = true;
            if (song.path && !song.isOnline) {
                exists = fs.existsSync(song.path);
            }
            return {
                ...song,
                exists
            };
        });
        
        const result = {
            ...songlist,
            songs: songsWithStatus,
            cover: getSonglistCover(songlist)
        };
        res.json({ success: true, songlist: result });
    } catch (error) {
        console.error('获取歌单详情失败:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 创建歌单
app.post('/api/user/songlists', requireAuth, (req, res) => {
    const { name, cover } = req.body;
    
    if (!name || !name.trim()) {
        return res.status(400).json({ success: false, error: '歌单名称不能为空' });
    }
    
    const newSonglist = {
        id: 'sl_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
        name: name.trim(),
        cover: cover || null,
        songs: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
    };
    
    userSonglists.unshift(newSonglist);
    saveUserSonglists();
    
    res.json({ success: true, songlist: newSonglist });
});

// 更新歌单信息
app.put('/api/user/songlists/:id', requireAuth, (req, res) => {
    const { name, cover } = req.body;
    const songlist = userSonglists.find(l => l.id === req.params.id);
    
    if (!songlist) {
        return res.status(404).json({ success: false, error: '歌单不存在' });
    }
    
    if (name !== undefined) {
        if (!name.trim()) {
            return res.status(400).json({ success: false, error: '歌单名称不能为空' });
        }
        songlist.name = name.trim();
    }
    if (cover !== undefined) {
        songlist.cover = cover;
    }
    
    songlist.updatedAt = Date.now();
    saveUserSonglists();
    
    res.json({ success: true, songlist });
});

// 删除歌单
app.delete('/api/user/songlists/:id', requireAuth, (req, res) => {
    if (req.params.id === 'favorites') {
        return res.status(400).json({ success: false, error: '不能删除"我喜欢的音乐"歌单' });
    }
    
    const index = userSonglists.findIndex(l => l.id === req.params.id);
    
    if (index === -1) {
        return res.status(404).json({ success: false, error: '歌单不存在' });
    }
    
    userSonglists.splice(index, 1);
    saveUserSonglists();
    
    res.json({ success: true });
});

// 收藏/取消收藏歌曲
app.post('/api/user/favorites/toggle', requireAuth, (req, res) => {
    const { song } = req.body;
    const favorites = userSonglists.find(l => l.id === 'favorites');
    
    if (!favorites) {
        return res.status(500).json({ success: false, error: '收藏歌单不存在' });
    }
    
    if (!song) {
        return res.status(400).json({ success: false, error: '歌曲信息不能为空' });
    }
    
    const existsIndex = favorites.songs.findIndex(s => 
        (s.id && song.id && s.id === song.id) || 
        (s.path && song.path && s.path === song.path)
    );
    
    let isFavorited;
    if (existsIndex !== -1) {
        favorites.songs.splice(existsIndex, 1);
        isFavorited = false;
    } else {
        favorites.songs.unshift(song);
        isFavorited = true;
    }
    
    favorites.updatedAt = Date.now();
    saveUserSonglists();
    
    res.json({ success: true, isFavorited, totalCount: favorites.songs.length });
});

// 检查歌曲是否已收藏
app.post('/api/user/favorites/check', requireAuth, (req, res) => {
    const { songId, path } = req.body;
    const favorites = userSonglists.find(l => l.id === 'favorites');
    
    if (!favorites) {
        return res.json({ success: true, isFavorited: false });
    }
    
    const exists = favorites.songs.some(s => 
        (songId && s.id === songId) || 
        (path && s.path === path)
    );
    
    res.json({ success: true, isFavorited: exists });
});

// 批量检查歌曲收藏状态
app.post('/api/user/favorites/check-batch', requireAuth, (req, res) => {
    const { songs } = req.body;
    const favorites = userSonglists.find(l => l.id === 'favorites');
    
    if (!favorites || !Array.isArray(songs)) {
        return res.json({ success: true, favorites: [] });
    }
    
    const result = songs.map(song => {
        const isFavorited = favorites.songs.some(s => 
            (song.id && s.id === song.id) || 
            (song.path && s.path === song.path)
        );
        return { id: song.id, path: song.path, isFavorited };
    });
    
    res.json({ success: true, favorites: result });
});

// 获取播放历史
app.get('/api/play-history', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    
    const history = playHistory.slice(offset, offset + limit);
    res.json({ 
        success: true, 
        history,
        total: playHistory.length
    });
});

// 清空播放历史
app.delete('/api/play-history', requireAuth, (req, res) => {
    playHistory = [];
    savePlayHistory();
    res.json({ success: true });
});

// 听歌统计
app.get('/api/play-stats', (req, res) => {
    const period = req.query.period || 'all'; // day, week, month, all
    
    let now = Date.now();
    let startTime = 0;
    
    switch (period) {
        case 'day':
            startTime = new Date();
            startTime.setHours(0, 0, 0, 0);
            startTime = startTime.getTime();
            break;
        case 'week':
            startTime = new Date();
            startTime.setDate(startTime.getDate() - 7);
            startTime.setHours(0, 0, 0, 0);
            startTime = startTime.getTime();
            break;
        case 'month':
            startTime = new Date();
            startTime.setMonth(startTime.getMonth() - 1);
            startTime.setHours(0, 0, 0, 0);
            startTime = startTime.getTime();
            break;
        case 'all':
        default:
            startTime = 0;
            break;
    }
    
    // 筛选时间范围内的播放记录
    const filteredHistory = playHistory.filter(item => item.playedAt >= startTime);
    
    // 统计播放次数
    const totalPlays = filteredHistory.length;
    
    // 统计总播放时长（估算：用歌曲duration，没有的按3分钟算）
    let totalDuration = 0;
    for (const item of filteredHistory) {
        totalDuration += item.duration || 180;
    }
    
    // 统计最常听的歌曲
    const songCountMap = {};
    for (const item of filteredHistory) {
        const key = item.path || item.id || item.title;
        if (!songCountMap[key]) {
            songCountMap[key] = {
                song: item,
                count: 0,
                duration: 0
            };
        }
        songCountMap[key].count++;
        songCountMap[key].duration += item.duration || 180;
    }
    
    const topSongs = Object.values(songCountMap)
        .sort((a, b) => b.count - a.count)
        .slice(0, 10)
        .map(item => ({
            title: item.song.title,
            artist: item.song.artist,
            album: item.song.album,
            cover: item.song.cover,
            count: item.count,
            duration: item.duration,
            isOnline: item.song.isOnline,
            source: item.song.source
        }));
    
    // 统计最常听的歌手
    const artistCountMap = {};
    for (const item of filteredHistory) {
        const artist = item.artist || '未知歌手';
        if (!artistCountMap[artist]) {
            artistCountMap[artist] = { artist, count: 0, duration: 0 };
        }
        artistCountMap[artist].count++;
        artistCountMap[artist].duration += item.duration || 180;
    }
    
    const topArtists = Object.values(artistCountMap)
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);
    
    // 按日期统计播放数量
    const dailyStats = {};
    for (const item of filteredHistory) {
        const date = new Date(item.playedAt);
        const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        if (!dailyStats[dateStr]) {
            dailyStats[dateStr] = { date: dateStr, plays: 0, duration: 0 };
        }
        dailyStats[dateStr].plays++;
        dailyStats[dateStr].duration += item.duration || 180;
    }
    
    const dailyStatsArray = Object.values(dailyStats).sort((a, b) => a.date.localeCompare(b.date));
    
    res.json({
        success: true,
        stats: {
            totalPlays,
            totalDuration,
            topSongs,
            topArtists,
            dailyStats: dailyStatsArray,
            period
        }
    });
});

// 添加歌曲到歌单
app.post('/api/user/songlists/:id/songs', requireAuth, (req, res) => {
    const { songs } = req.body;
    const songlist = userSonglists.find(l => l.id === req.params.id);
    
    if (!songlist) {
        return res.status(404).json({ success: false, error: '歌单不存在' });
    }
    
    if (!Array.isArray(songs) || songs.length === 0) {
        return res.status(400).json({ success: false, error: '歌曲列表不能为空' });
    }
    
    let addedCount = 0;
    for (const song of songs) {
        const exists = songlist.songs.some(s => 
            (s.id && song.id && s.id === song.id) || 
            (s.path && song.path && s.path === song.path)
        );
        if (!exists) {
            songlist.songs.push(song);
            addedCount++;
        }
    }
    
    songlist.updatedAt = Date.now();
    saveUserSonglists();
    
    res.json({ success: true, addedCount, totalCount: songlist.songs.length });
});

// 从歌单移除歌曲
app.delete('/api/user/songlists/:id/songs', requireAuth, (req, res) => {
    const { songIds } = req.body;
    const songlist = userSonglists.find(l => l.id === req.params.id);
    
    if (!songlist) {
        return res.status(404).json({ success: false, error: '歌单不存在' });
    }
    
    if (!Array.isArray(songIds) || songIds.length === 0) {
        return res.status(400).json({ success: false, error: '歌曲ID列表不能为空' });
    }
    
    let removedCount = 0;
    for (const songId of songIds) {
        const index = songlist.songs.findIndex(s => s.id === songId || s.path === songId);
        if (index !== -1) {
            songlist.songs.splice(index, 1);
            removedCount++;
        }
    }
    
    songlist.updatedAt = Date.now();
    saveUserSonglists();
    
    res.json({ success: true, removedCount, totalCount: songlist.songs.length });
});

// 清理歌单中不存在的歌曲
app.delete('/api/user/songlists/:id/clean-missing', requireAuth, (req, res) => {
    try {
        const songlist = userSonglists.find(l => l.id === req.params.id);
        
        if (!songlist) {
            return res.status(404).json({ success: false, error: '歌单不存在' });
        }

        const beforeCount = songlist.songs.length;
        
        songlist.songs = songlist.songs.filter(song => {
            if (song.isOnline || !song.path) {
                return true;
            }
            return fs.existsSync(song.path);
        });
        
        const removedCount = beforeCount - songlist.songs.length;
        
        songlist.updatedAt = Date.now();
        saveUserSonglists();
        
        res.json({ 
            success: true, 
            removedCount, 
            totalCount: songlist.songs.length 
        });
    } catch (error) {
        console.error('清理丢失歌曲失败:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 导出歌单
app.get('/api/user/songlists/:id/export', requireAuth, (req, res) => {
    try {
        const songlist = userSonglists.find(l => l.id === req.params.id);
        if (!songlist) {
            return res.status(404).json({ success: false, error: '歌单不存在' });
        }

        const format = req.query.format || 'json';

        if (format === 'm3u') {
            let m3uContent = '#EXTM3U\n';
            songlist.songs.forEach(song => {
                const duration = Math.round(song.duration || 0);
                const title = song.title || '未知歌曲';
                const artist = song.artist || '未知艺术家';
                const path = song.path || '';
                m3uContent += `#EXTINF:${duration},${artist} - ${title}\n`;
                m3uContent += `${path}\n`;
            });

            const fileName = encodeURIComponent(songlist.name) + '.m3u';
            res.setHeader('Content-Type', 'audio/x-mpegurl');
            res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${fileName}`);
            res.send(m3uContent);
        } else {
            const exportData = {
                name: songlist.name,
                createdAt: songlist.createdAt,
                updatedAt: songlist.updatedAt,
                songs: songlist.songs
            };

            const fileName = encodeURIComponent(songlist.name) + '.json';
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${fileName}`);
            res.json(exportData);
        }
    } catch (error) {
        console.error('导出歌单失败:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 导入歌单
app.post('/api/user/songlists/import', requireAuth, async (req, res) => {
    try {
        const { name, format, content } = req.body;

        if (!content) {
            return res.status(400).json({ success: false, error: '歌单内容不能为空' });
        }

        let songs = [];

        if (format === 'm3u') {
            const lines = content.split('\n').map(l => l.trim()).filter(l => l);
            let i = 0;

            while (i < lines.length) {
                const line = lines[i];

                if (line.startsWith('#EXTINF:')) {
                    const infoMatch = line.match(/#EXTINF:(-?\d+),(.+)/);
                    let duration = 0;
                    let title = '';
                    let artist = '';

                    if (infoMatch) {
                        duration = parseInt(infoMatch[1]) || 0;
                        const fullTitle = infoMatch[2];
                        const dashIndex = fullTitle.indexOf(' - ');
                        if (dashIndex > 0) {
                            artist = fullTitle.substring(0, dashIndex).trim();
                            title = fullTitle.substring(dashIndex + 3).trim();
                        } else {
                            title = fullTitle.trim();
                        }
                    }

                    i++;
                    if (i < lines.length && !lines[i].startsWith('#')) {
                        const filePath = lines[i];
                        let fullPath = filePath;

                        if (!path.isAbsolute(filePath)) {
                            fullPath = path.join(MUSIC_DIR, filePath);
                        }

                        if (!fullPath.startsWith(MUSIC_DIR)) {
                            fullPath = path.join(MUSIC_DIR, path.basename(filePath));
                        }

                        if (fs.existsSync(fullPath) && MUSIC_EXTENSIONS.includes(path.extname(fullPath).toLowerCase())) {
                            const metadata = await getMusicMetadata(fullPath);
                            if (metadata) {
                                songs.push({
                                    id: `song_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
                                    path: metadata.path,
                                    title: metadata.title,
                                    artist: metadata.artist,
                                    album: metadata.album,
                                    duration: metadata.duration,
                                    cover: metadata.path,
                                    type: 'local',
                                    addedAt: Date.now()
                                });
                            }
                        }
                    }
                } else if (!line.startsWith('#') && line) {
                    const filePath = line;
                    let fullPath = filePath;

                    if (!path.isAbsolute(filePath)) {
                        fullPath = path.join(MUSIC_DIR, filePath);
                    }

                    if (!fullPath.startsWith(MUSIC_DIR)) {
                        fullPath = path.join(MUSIC_DIR, path.basename(filePath));
                    }

                    if (fs.existsSync(fullPath) && MUSIC_EXTENSIONS.includes(path.extname(fullPath).toLowerCase())) {
                        const metadata = await getMusicMetadata(fullPath);
                        if (metadata) {
                            songs.push({
                                id: `song_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
                                path: metadata.path,
                                title: metadata.title,
                                artist: metadata.artist,
                                album: metadata.album,
                                duration: metadata.duration,
                                cover: metadata.path,
                                type: 'local',
                                addedAt: Date.now()
                            });
                        }
                    }
                }

                i++;
            }
        } else {
            const data = JSON.parse(content);
            if (data.songs && Array.isArray(data.songs)) {
                for (const song of data.songs) {
                    if (song.path && fs.existsSync(song.path) && song.path.startsWith(MUSIC_DIR)) {
                        songs.push({
                            id: `song_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
                            path: song.path,
                            title: song.title || path.basename(song.path, path.extname(song.path)),
                            artist: song.artist || '未知艺术家',
                            album: song.album || '未知专辑',
                            duration: song.duration || 0,
                            cover: song.cover || song.path,
                            type: song.type || 'local',
                            addedAt: Date.now()
                        });
                    }
                }
            }
        }

        if (songs.length === 0) {
            return res.status(400).json({ success: false, error: '没有找到可导入的有效歌曲' });
        }

        const newSonglist = {
            id: 'sl_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
            name: name || '导入的歌单',
            cover: null,
            songs,
            createdAt: Date.now(),
            updatedAt: Date.now()
        };

        userSonglists.push(newSonglist);
        saveUserSonglists();

        res.json({
            success: true,
            songlist: {
                id: newSonglist.id,
                name: newSonglist.name,
                count: newSonglist.songs.length,
                createdAt: newSonglist.createdAt
            },
            importedCount: songs.length
        });
    } catch (error) {
        console.error('导入歌单失败:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 封面管理 - 获取音乐文件嵌入封面
app.get('/api/cover/embedded', requireAuth, async (req, res) => {
    try {
        const filePath = decodeURIComponent(req.query.path || '');
        
        if (!filePath || !filePath.startsWith(MUSIC_DIR)) {
            return res.status(400).json({ success: false, error: '无效的文件路径' });
        }

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ success: false, error: '文件不存在' });
        }

        const metadata = await mm.parseFile(filePath);
        
        if (metadata.common.picture && metadata.common.picture.length > 0) {
            const pic = metadata.common.picture[0];
            res.setHeader('Content-Type', pic.format || 'image/jpeg');
            res.setHeader('Cache-Control', 'public, max-age=86400');
            return res.send(pic.data);
        }

        res.status(404).json({ success: false, error: '没有嵌入封面' });
    } catch (error) {
        console.error('获取嵌入封面失败:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 封面管理 - 获取文件夹封面
app.get('/api/cover/folder', requireAuth, (req, res) => {
    try {
        const folderPath = decodeURIComponent(req.query.path || '');
        
        if (!folderPath || !folderPath.startsWith(MUSIC_DIR)) {
            return res.status(400).json({ success: false, error: '无效的文件夹路径' });
        }

        if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
            return res.status(404).json({ success: false, error: '文件夹不存在' });
        }

        const coverNames = ['cover.jpg', 'cover.jpeg', 'cover.png', 'folder.jpg', 'folder.jpeg', 'folder.png', 'Cover.jpg', 'Cover.jpeg', 'album.jpg', 'album.jpeg'];
        
        for (const name of coverNames) {
            const coverPath = path.join(folderPath, name);
            if (fs.existsSync(coverPath)) {
                const ext = path.extname(name).toLowerCase();
                const contentType = ext === '.png' ? 'image/png' : 'image/jpeg';
                res.setHeader('Content-Type', contentType);
                res.setHeader('Cache-Control', 'public, max-age=86400');
                return res.sendFile(coverPath);
            }
        }

        res.status(404).json({ success: false, error: '文件夹中没有封面' });
    } catch (error) {
        console.error('获取文件夹封面失败:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 封面管理 - 获取最佳封面（先嵌入，后文件夹）
app.get('/api/cover/best', requireAuth, async (req, res) => {
    try {
        const filePath = decodeURIComponent(req.query.path || '');
        
        if (!filePath || !filePath.startsWith(MUSIC_DIR)) {
            return res.status(400).json({ success: false, error: '无效的文件路径' });
        }

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ success: false, error: '文件不存在' });
        }

        try {
            const metadata = await mm.parseFile(filePath);
            if (metadata.common.picture && metadata.common.picture.length > 0) {
                const pic = metadata.common.picture[0];
                res.setHeader('Content-Type', pic.format || 'image/jpeg');
                res.setHeader('Cache-Control', 'public, max-age=86400');
                return res.send(pic.data);
            }
        } catch (e) {
            // 忽略元数据解析错误，继续尝试文件夹封面
        }

        const folderPath = path.dirname(filePath);
        const coverNames = ['cover.jpg', 'cover.jpeg', 'cover.png', 'folder.jpg', 'folder.jpeg', 'folder.png', 'Cover.jpg', 'Cover.jpeg', 'album.jpg', 'album.jpeg'];
        
        for (const name of coverNames) {
            const coverPath = path.join(folderPath, name);
            if (fs.existsSync(coverPath)) {
                const ext = path.extname(name).toLowerCase();
                const contentType = ext === '.png' ? 'image/png' : 'image/jpeg';
                res.setHeader('Content-Type', contentType);
                res.setHeader('Cache-Control', 'public, max-age=86400');
                return res.sendFile(coverPath);
            }
        }

        res.status(404).json({ success: false, error: '没有找到封面' });
    } catch (error) {
        console.error('获取封面失败:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 封面管理 - 批量获取专辑封面列表
app.get('/api/covers/albums', requireAuth, async (req, res) => {
    try {
        const albums = {};
        
        for (const song of currentPlaylist) {
            const albumKey = `${song.artist} - ${song.album}`;
            if (!albums[albumKey]) {
                albums[albumKey] = {
                    artist: song.artist,
                    album: song.album,
                    songCount: 0,
                    hasEmbeddedCover: false,
                    hasFolderCover: false,
                    samplePath: song.path
                };
            }
            albums[albumKey].songCount++;
        }

        const albumList = Object.values(albums).sort((a, b) => {
            if (a.artist === b.artist) return a.album.localeCompare(b.album);
            return a.artist.localeCompare(b.artist);
        });

        const page = parseInt(req.query.page) || 1;
        const pageSize = parseInt(req.query.pageSize) || 50;
        const start = (page - 1) * pageSize;
        const end = start + pageSize;
        const paginated = albumList.slice(start, end);

        res.json({
            success: true,
            albums: paginated,
            total: albumList.length,
            page,
            pageSize
        });
    } catch (error) {
        console.error('获取专辑封面列表失败:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/upload-music', requireAuth, (req, res, next) => {
    upload.array('musicFiles', 50)(req, res, (err) => {
        if (err) {
            console.error('上传错误:', err.message);
            return res.status(400).json({ error: err.message });
        }
        next();
    });
}, async (req, res) => {
    try {
        console.log('📤 接收到上传请求');
        console.log('📁 目标文件夹:', req.body.folderPath || '根目录');
        
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: '没有上传文件' });
        }
        
        console.log('📄 上传文件数量:', req.files.length);

        const folderPath = req.body.folderPath || '';
        const destDir = path.join(__dirname, 'music', folderPath);
        
        // 确保目标目录存在
        if (!fs.existsSync(destDir)) {
            fs.mkdirSync(destDir, { recursive: true });
        }

        // 确保 temp_uploads 目录存在
        const tempDir = path.join(__dirname, 'temp_uploads');
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }

        const uploadedTracks = [];
        for (const file of req.files) {
            // 处理文件名编码
            let originalName = file.originalname;
            try {
                originalName = decodeURIComponent(originalName);
            } catch (e) {}
            originalName = Buffer.from(originalName, 'latin1').toString('utf8');

            const destPath = path.join(destDir, originalName);
            
            // 从 temp 目录移动到目标目录（使用 copy + delete 以支持跨卷）
            await fs.promises.copyFile(file.path, destPath);
            await fs.promises.unlink(file.path);
            
            const metadata = await getMusicMetadata(destPath);
            uploadedTracks.push(metadata);
        }

        // 删除文件夹缓存，下次打开时重新生成
        if (fs.existsSync(FOLDER_CACHE_FILE)) {
            fs.unlinkSync(FOLDER_CACHE_FILE);
            console.log('🗑️ 删除文件夹缓存，下次扫描重新生成');
        }

        res.json({
            success: true,
            message: `成功上传 ${uploadedTracks.length} 首音乐`,
            tracks: uploadedTracks
        });
    } catch (error) {
        console.error('上传处理错误:', error);
        res.status(500).json({ error: error.message });
    }
});

// 异步上传接口（后台模式）
app.post('/api/upload-music-async', requireAuth, (req, res, next) => {
    upload.array('musicFiles', 50)(req, res, (err) => {
        if (err) {
            console.error('上传错误:', err.message);
            return res.status(400).json({ error: err.message });
        }
        next();
    });
}, async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ success: false, error: '没有上传文件' });
        }
        
        const folderPath = req.body.folderPath || '';
        
        // 把每个文件拆分成单独的任务
        const taskIds = [];
        for (const file of req.files) {
            // 修复中文文件名编码问题
            let originalName = file.originalname;
            try {
                originalName = decodeURIComponent(originalName);
            } catch (e) {}
            originalName = Buffer.from(originalName, 'latin1').toString('utf8');
            
            const taskId = Date.now().toString(36) + Math.random().toString(36).substr(2) + Math.random().toString(36).substr(2);
            taskOrderCounter++;
            const task = {
                id: taskId,
                orderIndex: taskOrderCounter,
                fileName: originalName,  // 保存正确编码的文件名
                file: file,
                folderPath,
                status: 'queued',
                progress: 0,
                message: '等待上传',
                startTime: Date.now()
            };
            
            uploadQueue.push(task);
            completedUploads.push(task);
            taskIds.push(taskId);
        }
        
        console.log(`📤 添加 ${req.files.length} 个上传任务到队列`);
        
        // 启动多个worker支持并发处理
        for (let i = 0; i < maxUploadWorkers; i++) {
            processUploadQueue();
        }
        
        res.json({
            success: true,
            taskIds,
            totalFiles: taskIds.length,
            message: `已将 ${taskIds.length} 个文件添加到上传队列`
        });
    } catch (error) {
        console.error('上传请求错误:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 处理上传队列（支持并发）
async function processUploadQueue() {
    // 如果队列空或者已经达到最大并发数，返回
    if (uploadQueue.length === 0 || activeUploadWorkers >= maxUploadWorkers) {
        return;
    }
    
    // 启动新的worker
    activeUploadWorkers++;
    
    // 获取一个任务
    const task = uploadQueue.shift();
    
    try {
        task.status = 'uploading';
        task.message = '正在上传';
        
        // 添加到进行中任务列表
        activeUploadTasks.push(task);
        
        const destDir = path.join(__dirname, 'music', task.folderPath);
        
        // 确保目标目录存在
        if (!fs.existsSync(destDir)) {
            fs.mkdirSync(destDir, { recursive: true });
        }
        
        // 处理文件名编码
        let originalName = task.file.originalname;
        try {
            originalName = decodeURIComponent(originalName);
        } catch (e) {}
        originalName = Buffer.from(originalName, 'latin1').toString('utf8');
        
        const destPath = path.join(destDir, originalName);
        
        // 从 temp 目录移动到目标目录
        await fs.promises.copyFile(task.file.path, destPath);
        await fs.promises.unlink(task.file.path);
        
        task.status = 'completed';
        task.progress = 100;
        task.message = '上传完成';
        task.endTime = Date.now();
        
        console.log(`✅ 上传完成: ${originalName}`);
        
        // 保存任务数据
        saveTaskData();
        
        // 删除文件夹缓存
        if (fs.existsSync(FOLDER_CACHE_FILE)) {
            fs.unlinkSync(FOLDER_CACHE_FILE);
        }
        
        // 通知前端刷新
        broadcastFolderRefresh();
        
    } catch (error) {
        task.status = 'failed';
        task.message = '上传失败: ' + error.message;
        task.endTime = Date.now();
        console.error('上传失败:', error);
        
        // 保存任务数据
        saveTaskData();
        
        taskNotifications.push({
            type: 'upload',
            status: 'failed',
            fileName: task.fileName || (task.file ? task.file.originalname : ''),
            message: `上传失败：${task.fileName || (task.file ? task.file.originalname : '未知文件')}`
        });
    } finally {
        // 从进行中任务列表移除
        const index = activeUploadTasks.findIndex(t => t.id === task.id);
        if (index !== -1) {
            activeUploadTasks.splice(index, 1);
        }
        activeUploadWorkers--;
        
        // 检查上传队列是否全部完成
        if (uploadQueue.length === 0 && activeUploadWorkers === 0) {
            // 获取本次完成的所有上传任务
            const recentCompleted = completedUploads.filter(t => 
                t.status === 'completed' && 
                t.endTime > (Date.now() - 60000) // 最近1分钟内完成的
            );
            
            if (recentCompleted.length > 0) {
                taskNotifications.push({
                    type: 'upload',
                    message: `所有上传任务已完成！共 ${recentCompleted.length} 个文件`,
                    count: recentCompleted.length,
                    time: Date.now()
                });
                console.log(`📢 所有上传任务已完成！共 ${recentCompleted.length} 个文件`);
            }
        }
        
        // 尝试启动下一个worker
        processUploadQueue();
    }
}

// 广播文件夹刷新消息
function broadcastFolderRefresh() {
    // 通过轮询接口通知前端
    console.log('📂 上传完成，通知前端刷新文件夹');
}

app.get('/api/refresh', async (req, res) => {
    // 保存当前播放的歌曲路径
    const playingPath = currentIndex >= 0 && currentPlaylist[currentIndex]
        ? currentPlaylist[currentIndex].path
        : null;

    // 执行完整扫描（刷新按钮调用）
    await scanMusicLibrary();

    // 刷新后，根据路径找到新的索引（如果该歌曲还在播放列表中）
    if (playingPath) {
        const newIndex = currentPlaylist.findIndex(track => track.path === playingPath);
        if (newIndex !== -1) {
            currentIndex = newIndex;
            console.log(`🔄 刷新后恢复播放索引：${newIndex}`);
        } else {
            // 歌曲不在播放列表中了
            console.log('🔄 刷新后原歌曲不在播放列表中');
            currentIndex = -1;
            isPlaying = false;
        }
    }

    res.json({
        success: true,
        message: '音乐库已刷新',
        count: currentPlaylist.length
    });
});

// 扫描文件夹并生成JSON缓存
app.post('/api/scan-folders', requireAuth, async (req, res) => {
    try {
        const musicDir = path.join(__dirname, 'music');
        
        if (!fs.existsSync(musicDir)) {
            return res.json({ success: true, message: '音乐文件夹不存在', folders: [], files: [], totalScanned: 0 });
        }
        
        console.log('🔍 开始扫描音乐文件夹...');
        
        // 递归扫描文件夹结构
        const scanResult = await scanFolderRecursive(musicDir, '');
        
        // 保存到缓存文件
        const cacheData = {
            timestamp: Date.now(),
            ...scanResult
        };
        
        await fs.promises.writeFile(FOLDER_CACHE_FILE, JSON.stringify(cacheData, null, 2));
        
        console.log(`✅ 扫描完成！共扫描 ${scanResult.totalFiles} 个文件，${scanResult.totalFolders} 个文件夹`);
        
        res.json({
            success: true,
            message: `扫描完成！共扫描 ${scanResult.totalFiles} 个文件，${scanResult.totalFolders} 个文件夹`,
            totalScanned: scanResult.totalFiles,
            totalFolders: scanResult.totalFolders,
            folders: scanResult.folders,
            files: scanResult.files
        });
    } catch (error) {
        console.error('扫描文件夹失败:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 递归扫描文件夹
async function scanFolderRecursive(dirPath, relativePath) {
    const folders = [];
    const files = [];
    let totalFiles = 0;
    let totalFolders = 0;
    
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    
    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        const entryRelativePath = relativePath ? relativePath + '/' + entry.name : entry.name;
        
        if (entry.isDirectory()) {
            totalFolders++;
            // 递归扫描子文件夹
            const subResult = await scanFolderRecursive(fullPath, entryRelativePath);
            
            const folderData = {
                name: entry.name,
                path: entryRelativePath,
                fullPath: fullPath,
                musicCount: subResult.totalFiles,
                hasSubFolders: subResult.totalFolders > 0,
                folders: subResult.folders,
                files: subResult.files
            };
            
            folders.push(folderData);
            totalFiles += subResult.totalFiles;
            totalFolders += subResult.totalFolders;
        } else if (entry.isFile() && MUSIC_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) {
            const metadata = await getMusicMetadata(fullPath);
            const fileData = {
                ...metadata,
                path: fullPath,
                folderPath: relativePath
            };
            files.push(fileData);
            totalFiles++;
        }
    }
    
    // 按名称字母排序
    folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    files.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
    
    return {
        folders,
        files,
        totalFiles,
        totalFolders,
        path: relativePath
    };
}

// 获取音乐文件元数据
app.get('/api/metadata', async (req, res) => {
    try {
        const filePath = decodeURIComponent(req.query.path);
        
        if (!filePath || !fs.existsSync(filePath)) {
            return res.status(400).json({ success: false, error: '文件不存在' });
        }
        
        const metadata = await mm.parseFile(filePath);
        const { common, format } = metadata;
        
        console.log('📖 读取元数据:', path.basename(filePath));
        console.log('  标签类型:', format.tagTypes);
        console.log('  common.title:', common.title);
        console.log('  common.artists:', common.artists);
        console.log('  common.artist:', common.artist);
        console.log('  common.album:', common.album);
        
        res.json({
            success: true,
            metadata: {
                title: common.title || '',
                artist: common.artists && common.artists.length > 0 ? common.artists[0] : (common.artist || ''),
                album: common.album || '',
                year: common.date ? String(common.date).substring(0, 4) : '',
                track: common.track && common.track.no ? String(common.track.no) : '',
                genre: common.genres && common.genres.length > 0 ? common.genres[0] : '',
                comment: common.comment && common.comment.length > 0 ? common.comment[0] : '',
                albumArtist: common.albumArtist || ''
            }
        });
    } catch (error) {
        console.error('获取元数据失败:', error);
        res.status(500).json({ success: false, error: '获取元数据失败: ' + error.message });
    }
});

// 更新音乐文件元数据
app.post('/api/update-metadata', requireAuth, async (req, res) => {
    try {
        const { path: filePath, title, artist, album, year, track, genre, comment, albumArtist } = req.body;
        
        if (!filePath || !fs.existsSync(filePath)) {
            return res.status(400).json({ success: false, error: '文件不存在' });
        }
        
        // 使用 ffmetadata 写入（基于 ffmpeg，正确处理所有标签版本）
        const data = {};
        if (title !== undefined) data.title = title;
        if (artist !== undefined) data.artist = artist;
        if (album !== undefined) data.album = album;
        if (year !== undefined) data.date = year;
        if (track !== undefined) data.track = track;
        if (genre !== undefined) data.genre = genre;
        if (comment !== undefined) data.comment = comment;
        if (albumArtist !== undefined) data.albumartist = albumArtist;
        
        await new Promise((resolve, reject) => {
            ffmetadata.write(filePath, data, { 'id3v2.3': true }, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        
        console.log(`✅ 已更新元数据: ${path.basename(filePath)}`);
        console.log('  写入的标签:', { title, artist, album, year, track, genre, comment, albumArtist });
        
        res.json({ success: true, message: '元数据已更新' });
    } catch (error) {
        console.error('更新元数据失败:', error);
        res.status(500).json({ success: false, error: '更新元数据失败: ' + error.message });
    }
});

// 转换音频为MP3格式
app.post('/api/convert-to-mp3', requireAuth, async (req, res) => {
    try {
        const { path: filePath, bitrate, background = false } = req.body;
        
        if (!filePath || !fs.existsSync(filePath)) {
            return res.status(400).json({ success: false, error: '文件不存在' });
        }
        
        // 检测文件实际格式（不依赖扩展名）
        try {
            const metadata = await mm.parseFile(filePath);
            const container = metadata.format.container;
            
            // 如果是MP3格式，跳过转换
            if (container && container.toLowerCase().includes('mpeg')) {
                return res.status(400).json({ success: false, error: '文件已经是MP3格式' });
            }
        } catch (parseError) {
            // 如果无法解析元数据，可能是损坏的文件，继续尝试转换
            console.log('无法解析文件元数据，尝试直接转换:', parseError.message);
        }
        
        const dir = path.dirname(filePath);
        const nameWithoutExt = path.basename(filePath).replace(/\.[^/.]+$/, '');
        let outputPath = path.join(dir, nameWithoutExt + '.mp3');
        
        // 如果目标文件已存在，添加序号避免覆盖
        let counter = 1;
        while (fs.existsSync(outputPath)) {
            outputPath = path.join(dir, `${nameWithoutExt}_${counter}.mp3`);
            counter++;
        }
        
        if (background) {
            // 后台模式：加入队列
            const taskId = Date.now().toString(36) + Math.random().toString(36).substr(2);
            const task = {
                id: taskId,
                filePath,
                outputPath,
                bitrate,
                status: 'queued',
                progress: 0,
                message: '等待转换',
                startTime: Date.now()
            };
            
            convertQueue.push(task);
            
            // 如果当前没有正在转换的任务，立即开始处理
            if (!isConverting) {
                processConvertQueue();
            }
            
            res.json({ 
                success: true, 
                taskId,
                message: '任务已加入后台队列'
            });
        } else {
            // 同步模式：立即转换
            console.log(`开始转换: ${path.basename(filePath)} -> ${path.basename(outputPath)} (${bitrate}kbps)`);
            
            // 使用 fluent-ffmpeg 进行转换
            ffmpeg(filePath)
                .audioCodec('libmp3lame')
                .audioBitrate(bitrate + 'k')
                .on('end', () => {
                    console.log(`✅ 转换完成: ${path.basename(outputPath)}`);
                    res.json({ 
                        success: true, 
                        outputName: path.basename(outputPath),
                        outputPath: outputPath
                    });
                })
                .on('error', (err) => {
                    console.error('转换失败:', err.message);
                    res.status(500).json({ success: false, error: '转换失败: ' + err.message });
                })
                .save(outputPath);
        }
    } catch (error) {
        console.error('转换失败:', error);
        res.status(500).json({ success: false, error: '转换失败: ' + error.message });
    }
});

// 处理转换队列（支持并发）
async function processConvertQueue() {
    // 如果队列空或者已经达到最大并发数，返回
    if (convertQueue.length === 0 || activeConvertWorkers >= maxConvertWorkers) {
        return;
    }
    
    // 启动新的worker
    activeConvertWorkers++;
    
    // 获取一个任务
    const task = convertQueue.shift();
    
    try {
        task.status = 'converting';
        task.message = '正在转换...';
        task.progress = 0;
        
        // 添加到进行中任务列表
        activeConvertTasks.push(task);
        
        console.log(`开始后台转换: ${path.basename(task.filePath)} -> ${path.basename(task.outputPath)} (${task.bitrate}kbps)`);
        
        await new Promise((resolve, reject) => {
            ffmpeg(task.filePath)
                .audioCodec('libmp3lame')
                .audioBitrate(task.bitrate + 'k')
                .on('progress', (progress) => {
                    if (progress.percent !== undefined) {
                        task.progress = Math.round(progress.percent);
                    } else if (progress.timemark) {
                        task.progress = Math.min(99, task.progress + 1);
                    }
                    task.message = `正在转换... ${task.progress}%`;
                })
                .on('end', () => {
                    task.status = 'completed';
                    task.progress = 100;
                    task.message = '转换完成';
                    task.endTime = Date.now();
                    completedTasks.push(task);
                    saveTaskData();
                    console.log(`✅ 后台转换完成: ${path.basename(task.outputPath)}`);
                    resolve();
                })
                .on('error', (err) => {
                    task.status = 'failed';
                    task.message = '转换失败: ' + err.message;
                    task.endTime = Date.now();
                    completedTasks.push(task);
                    saveTaskData();
                    console.error('后台转换失败:', err.message);
                    
                    taskNotifications.push({
                        type: 'convert',
                        status: 'failed',
                        fileName: path.basename(task.filePath),
                        message: `转换失败：${path.basename(task.filePath)}`
                    });
                    
                    reject(err);
                })
                .save(task.outputPath);
        });
    } catch (error) {
        console.error('处理转换任务失败:', error.message);
    } finally {
        // 从进行中任务列表移除
        const index = activeConvertTasks.findIndex(t => t.id === task.id);
        if (index !== -1) {
            activeConvertTasks.splice(index, 1);
        }
        activeConvertWorkers--;
        
        // 检查转换队列是否全部完成
        if (convertQueue.length === 0 && activeConvertWorkers === 0) {
            // 获取本次完成的所有转换任务
            const recentCompleted = completedTasks.filter(t => 
                t.status === 'completed' && 
                t.endTime > (Date.now() - 60000) // 最近1分钟内完成的
            );
            
            if (recentCompleted.length > 0) {
                taskNotifications.push({
                    type: 'convert',
                    message: `所有转换任务已完成！共 ${recentCompleted.length} 个文件`,
                    count: recentCompleted.length,
                    time: Date.now()
                });
                console.log(`📢 所有转换任务已完成！共 ${recentCompleted.length} 个文件`);
            }
        }
        
        // 尝试启动下一个worker
        processConvertQueue();
    }
}

// 获取转换进度
app.get('/api/convert-progress', (req, res) => {
    const { taskId } = req.query;
    
    if (taskId) {
        // 查询特定任务
        const task = [...convertQueue, ...activeConvertTasks].find(t => t && t.id === taskId);
        if (task) {
            res.json({
                success: true,
                task: {
                    id: task.id,
                    status: task.status,
                    progress: task.progress,
                    message: task.message,
                    fileName: path.basename(task.filePath),
                    startTime: task.startTime,
                    endTime: task.endTime
                }
            });
        } else {
            res.json({ success: false, error: '任务不存在' });
        }
    } else {
        // 返回所有任务状态
        res.json({
            success: true,
            isConverting: activeConvertTasks.length > 0,
            currentTask: activeConvertTasks.length > 0 ? {
                id: activeConvertTasks[0].id,
                status: activeConvertTasks[0].status,
                progress: activeConvertTasks[0].progress,
                message: activeConvertTasks[0].message,
                fileName: path.basename(activeConvertTasks[0].filePath),
                startTime: activeConvertTasks[0].startTime
            } : null,
            queueLength: convertQueue.length
        });
    }
});

// 获取所有任务列表
app.get('/api/tasks', (req, res) => {
    const { status } = req.query;
    
    // 构建完整的任务列表（进行中任务 + 队列中的任务 + 已完成的任务）
    let allTasks = [];
    
    // 添加进行中的转换任务
    activeConvertTasks.forEach(task => {
        allTasks.push({
            id: task.id,
            orderIndex: task.orderIndex,
            type: 'convert',
            status: task.status,
            progress: task.progress,
            message: task.message,
            fileName: path.basename(task.filePath),
            filePath: task.filePath,
            outputPath: task.outputPath,
            bitrate: task.bitrate,
            startTime: task.startTime,
            endTime: task.endTime
        });
    });
    
    // 添加队列中的转换任务
    convertQueue.forEach(task => {
        allTasks.push({
            id: task.id,
            orderIndex: task.orderIndex,
            type: 'convert',
            status: task.status,
            progress: task.progress,
            message: task.message,
            fileName: path.basename(task.filePath),
            filePath: task.filePath,
            outputPath: task.outputPath,
            bitrate: task.bitrate,
            startTime: task.startTime,
            endTime: task.endTime
        });
    });
    
    // 添加已完成的转换任务
    completedTasks.forEach(task => {
        allTasks.push({
            id: task.id,
            orderIndex: task.orderIndex,
            type: 'convert',
            status: task.status,
            progress: task.progress,
            message: task.message,
            fileName: path.basename(task.filePath),
            filePath: task.filePath,
            outputPath: task.outputPath,
            bitrate: task.bitrate,
            startTime: task.startTime,
            endTime: task.endTime
        });
    });
    
    // 添加上传任务（completedUploads 已包含所有状态的上传任务）
    completedUploads.forEach(task => {
        allTasks.push({
            id: task.id,
            orderIndex: task.orderIndex,
            type: 'upload',
            status: task.status,
            progress: task.progress,
            message: task.message,
            fileName: task.fileName,
            folderPath: task.folderPath,
            startTime: task.startTime,
            endTime: task.endTime
        });
    });
    
    // 添加下载任务（completedDownloads 已包含所有状态的下载任务）
    completedDownloads.forEach(task => {
        allTasks.push({
            id: task.id,
            orderIndex: task.orderIndex,
            type: 'download',
            status: task.status,
            progress: task.progress,
            message: task.message,
            fileName: task.fileName,
            folderPath: task.folderPath,
            source: task.source,
            startTime: task.startTime,
            endTime: task.endTime
        });
    });
    
    // 根据状态过滤
    if (status && status !== 'all') {
        allTasks = allTasks.filter(task => task.status === status);
    }
    
    // 按 orderIndex 排序
    allTasks.sort((a, b) => a.orderIndex - b.orderIndex);
    
    // 统计各状态任务数量
    const stats = {
        pending: allTasks.filter(t => t.status === 'queued').length,
        converting: allTasks.filter(t => t.status === 'converting').length,
        uploading: allTasks.filter(t => t.status === 'uploading').length,
        downloading: allTasks.filter(t => t.status === 'downloading').length,
        completed: allTasks.filter(t => t.status === 'completed').length,
        failed: allTasks.filter(t => t.status === 'failed').length
    };
    
    res.json({
        success: true,
        tasks: allTasks,
        stats
    });
});

// 删除任务记录
app.delete('/api/tasks/:taskId', requireAuth, (req, res) => {
    const { taskId } = req.params;
    
    // 从转换队列中移除
    const convertQueueIndex = convertQueue.findIndex(t => t.id === taskId);
    if (convertQueueIndex !== -1) {
        convertQueue.splice(convertQueueIndex, 1);
        saveTaskData();
        res.json({ success: true, message: '任务已删除' });
        return;
    }
    
    // 检查是否是正在进行的转换任务
    if (activeConvertTasks.find(t => t.id === taskId)) {
        res.status(400).json({ success: false, error: '无法删除正在转换的任务' });
        return;
    }
    
    // 从已完成转换任务中删除
    const completedConvertIndex = completedTasks.findIndex(t => t.id === taskId);
    if (completedConvertIndex !== -1) {
        completedTasks.splice(completedConvertIndex, 1);
        saveTaskData();
        res.json({ success: true, message: '任务已删除' });
        return;
    }
    
    // 检查是否是正在进行的上传任务
    if (activeUploadTasks.find(t => t.id === taskId)) {
        res.status(400).json({ success: false, error: '无法删除正在上传的任务' });
        return;
    }
    
    // 从上传任务中删除（completedUploads 包含所有上传任务）
    const uploadIndex = completedUploads.findIndex(t => t.id === taskId);
    if (uploadIndex !== -1) {
        completedUploads.splice(uploadIndex, 1);
        const queueIdx = uploadQueue.findIndex(t => t.id === taskId);
        if (queueIdx !== -1) uploadQueue.splice(queueIdx, 1);
        saveTaskData();
        res.json({ success: true, message: '任务已删除' });
        return;
    }
    
    // 检查是否是正在进行的下载任务
    if (activeDownloadTasks.find(t => t.id === taskId)) {
        res.status(400).json({ success: false, error: '无法删除正在下载的任务' });
        return;
    }
    
    // 从下载任务中删除（completedDownloads 包含所有下载任务）
    const downloadIndex = completedDownloads.findIndex(t => t.id === taskId);
    if (downloadIndex !== -1) {
        completedDownloads.splice(downloadIndex, 1);
        const queueIdx = downloadQueue.findIndex(t => t.id === taskId);
        if (queueIdx !== -1) downloadQueue.splice(queueIdx, 1);
        saveTaskData();
        res.json({ success: true, message: '任务已删除' });
        return;
    }
    
    res.json({ success: false, error: '任务不存在' });
});

// 清除已完成的任务
app.delete('/api/tasks', requireAuth, (req, res) => {
    completedTasks = [];
    completedUploads = completedUploads.filter(t => t.status === 'queued' || t.status === 'uploading');
    completedDownloads = completedDownloads.filter(t => t.status === 'queued' || t.status === 'downloading');
    convertQueue = convertQueue.filter(t => t.status === 'queued');
    downloadQueue = downloadQueue.filter(t => t.status === 'queued');
    saveTaskData();
    res.json({ success: true, message: '已清除已完成的任务' });
});

// 取消转换任务
app.post('/api/cancel-convert', requireAuth, (req, res) => {
    const { taskId } = req.body;
    
    if (taskId) {
        // 从队列中移除任务
        const index = convertQueue.findIndex(t => t.id === taskId);
        if (index !== -1) {
            convertQueue.splice(index, 1);
            res.json({ success: true, message: '任务已从队列中移除' });
        } else {
            const activeTask = activeConvertTasks.find(t => t.id === taskId);
            if (activeTask) {
                // 取消当前正在转换的任务
                // 由于fluent-ffmpeg没有直接的取消方法，这里标记任务状态
                activeTask.status = 'canceling';
                activeTask.message = '正在取消...';
                res.json({ success: true, message: '正在取消转换任务' });
            } else {
                res.json({ success: false, error: '任务不存在' });
            }
        }
    } else {
        // 清空队列
        convertQueue = [];
        // 标记所有进行中的任务为取消中
        activeConvertTasks.forEach(task => {
            task.status = 'canceling';
            task.message = '正在取消...';
        });
        res.json({ success: true, message: '已清空转换队列' });
    }
});

// 获取任务完成通知
app.get('/api/task-notifications', (req, res) => {
    // 获取并清除通知（防止重复通知）
    const notifications = [...taskNotifications];
    taskNotifications = [];
    
    res.json({
        success: true,
        notifications
    });
});

// 获取线程数量配置
app.get('/api/worker-config', (req, res) => {
    res.json({
        success: true,
        config: {
            maxConvertWorkers,
            maxUploadWorkers,
            maxDownloadWorkers,
            activeConvertWorkers,
            activeUploadWorkers,
            activeDownloadWorkers,
            convertQueueLength: convertQueue.length,
            uploadQueueLength: uploadQueue.length,
            downloadQueueLength: downloadQueue.length
        }
    });
});

// 更新线程数量配置
app.post('/api/worker-config', requireAuth, (req, res) => {
    const { maxConvertWorkers: newConvertWorkers, maxUploadWorkers: newUploadWorkers, maxDownloadWorkers: newDownloadWorkers } = req.body;
    
    if (newConvertWorkers !== undefined) {
        const workers = parseInt(newConvertWorkers, 10);
        if (workers >= 1 && workers <= 10) {
            maxConvertWorkers = workers;
            console.log(`转换线程数量已更新为: ${maxConvertWorkers}`);
            
            // 如果有空闲的worker，立即启动更多任务
            if (activeConvertWorkers < maxConvertWorkers) {
                for (let i = activeConvertWorkers; i < maxConvertWorkers; i++) {
                    processConvertQueue();
                }
            }
        } else {
            return res.status(400).json({ 
                success: false, 
                error: '转换线程数量必须在 1-10 之间' 
            });
        }
    }
    
    if (newUploadWorkers !== undefined) {
        const workers = parseInt(newUploadWorkers, 10);
        if (workers >= 1 && workers <= 10) {
            maxUploadWorkers = workers;
            console.log(`上传线程数量已更新为: ${maxUploadWorkers}`);
            
            // 如果有空闲的worker，立即启动更多任务
            if (activeUploadWorkers < maxUploadWorkers) {
                for (let i = activeUploadWorkers; i < maxUploadWorkers; i++) {
                    processUploadQueue();
                }
            }
        } else {
            return res.status(400).json({ 
                success: false, 
                error: '上传线程数量必须在 1-10 之间' 
            });
        }
    }
    
    if (newDownloadWorkers !== undefined) {
        const workers = parseInt(newDownloadWorkers, 10);
        if (workers >= 1 && workers <= 10) {
            maxDownloadWorkers = workers;
            console.log(`下载线程数量已更新为: ${maxDownloadWorkers}`);
            
            if (activeDownloadWorkers < maxDownloadWorkers) {
                for (let i = activeDownloadWorkers; i < maxDownloadWorkers; i++) {
                    processDownloadQueue();
                }
            }
        } else {
            return res.status(400).json({ 
                success: false, 
                error: '下载线程数量必须在 1-10 之间' 
            });
        }
    }
    
    // 保存配置到config.json
    saveConfig();
    
    res.json({
        success: true,
        message: '配置已更新',
        config: {
            maxConvertWorkers,
            maxUploadWorkers,
            maxDownloadWorkers
        }
    });
});

// 获取所有上传任务列表
app.get('/api/upload-tasks', (req, res) => {
    const { status } = req.query;
    
    let allTasks = [];
    
    // 添加进行中的上传任务
    activeUploadTasks.forEach(task => {
        allTasks.push({
            id: task.id,
            orderIndex: task.orderIndex,
            fileName: task.fileName || (task.file ? task.file.originalname : ''),
            status: task.status,
            progress: task.progress,
            message: task.message,
            folderPath: task.folderPath,
            startTime: task.startTime,
            endTime: task.endTime
        });
    });
    
    // 添加队列中的任务
    uploadQueue.forEach(task => {
        allTasks.push({
            id: task.id,
            orderIndex: task.orderIndex,
            fileName: task.fileName || (task.file ? task.file.originalname : ''),
            status: task.status,
            progress: task.progress,
            message: task.message,
            folderPath: task.folderPath,
            startTime: task.startTime,
            endTime: task.endTime
        });
    });
    
    // 添加已完成的任务
    completedUploads.forEach(task => {
        allTasks.push({
            id: task.id,
            orderIndex: task.orderIndex,
            fileName: task.fileName || (task.file ? task.file.originalname : ''),
            status: task.status,
            progress: task.progress,
            message: task.message,
            folderPath: task.folderPath,
            startTime: task.startTime,
            endTime: task.endTime
        });
    });
    
    // 根据状态过滤
    if (status && status !== 'all') {
        allTasks = allTasks.filter(task => task.status === status);
    }
    
    // 统计
    const stats = {
        pending: allTasks.filter(t => t.status === 'queued').length,
        uploading: allTasks.filter(t => t.status === 'uploading').length,
        completed: allTasks.filter(t => t.status === 'completed').length,
        failed: allTasks.filter(t => t.status === 'failed').length
    };
    
    res.json({ success: true, tasks: allTasks, stats });
});

// 删除上传任务
app.delete('/api/upload-tasks/:taskId', requireAuth, (req, res) => {
    const { taskId } = req.params;
    
    const queueIndex = uploadQueue.findIndex(t => t.id === taskId);
    if (queueIndex !== -1) {
        uploadQueue.splice(queueIndex, 1);
        res.json({ success: true, message: '任务已删除' });
    } else if (activeUploadTasks.find(t => t.id === taskId)) {
        res.status(400).json({ success: false, error: '无法删除正在上传的任务' });
    } else {
        const completedIndex = completedUploads.findIndex(t => t.id === taskId);
        if (completedIndex !== -1) {
            completedUploads.splice(completedIndex, 1);
            saveTaskData(); // 持久化保存
            res.json({ success: true, message: '任务已删除' });
        } else {
            res.json({ success: false, error: '任务不存在' });
        }
    }
});

// 清除已完成的上传任务
app.delete('/api/upload-tasks', requireAuth, (req, res) => {
    completedUploads = completedUploads.filter(t => t.status !== 'completed' && t.status !== 'failed');
    uploadQueue = uploadQueue.filter(t => t.status === 'queued');
    saveTaskData(); // 持久化保存
    res.json({ success: true, message: '已清除已完成的任务' });
});

// 批量转换（后台模式）
app.post('/api/batch-convert-mp3', requireAuth, async (req, res) => {
    try {
        const { files, bitrate } = req.body;
        
        if (!files || !Array.isArray(files) || files.length === 0) {
            return res.status(400).json({ success: false, error: '请选择要转换的文件' });
        }
        
        console.log('收到批量转换请求，文件数量:', files.length);
        
        const taskIds = [];
        
        for (const filePath of files) {
            console.log('处理文件:', filePath);
            
            if (!fs.existsSync(filePath)) {
                console.log('文件不存在，跳过:', filePath);
                continue;
            }
            
            // 使用文件扩展名判断是否需要转换
            const ext = path.extname(filePath).toLowerCase();
            if (ext === '.mp3') {
                console.log('已是MP3格式，跳过:', filePath);
                continue;
            }
            
            const dir = path.dirname(filePath);
            const nameWithoutExt = path.basename(filePath).replace(/\.[^/.]+$/, '');
            let outputPath = path.join(dir, nameWithoutExt + '.mp3');
            
            // 如果目标文件已存在，添加序号避免覆盖
            let counter = 1;
            while (fs.existsSync(outputPath)) {
                outputPath = path.join(dir, `${nameWithoutExt}_${counter}.mp3`);
                counter++;
            }
            
            const taskId = Date.now().toString(36) + Math.random().toString(36).substr(2);
            taskOrderCounter++;
            const task = {
                id: taskId,
                orderIndex: taskOrderCounter,
                filePath,
                outputPath,
                bitrate,
                status: 'queued',
                progress: 0,
                message: '等待转换',
                startTime: Date.now()
            };
            
            convertQueue.push(task);
            taskIds.push(taskId);
        }
        
        // 如果没有任何有效任务（全部是MP3或不存在）
        if (taskIds.length === 0) {
            return res.json({ 
                success: false, 
                error: '没有需要转换的文件（请选择非MP3格式的音乐文件）',
                totalTasks: 0
            });
        }
        
        // 启动多个worker支持并发处理
        for (let i = 0; i < maxConvertWorkers; i++) {
            processConvertQueue();
        }
        
        res.json({ 
            success: true, 
            taskIds,
            totalTasks: taskIds.length,
            message: `已将 ${taskIds.length} 个任务加入后台队列`,
            maxConcurrent: maxConvertWorkers
        });
    } catch (error) {
        console.error('批量转换失败:', error);
        res.status(500).json({ success: false, error: '批量转换失败: ' + error.message });
    }
});

// 获取文件夹缓存
app.get('/api/folder-cache', async (req, res) => {
    try {
        if (fs.existsSync(FOLDER_CACHE_FILE)) {
            // 如果有缓存文件，直接读取返回
            const cacheContent = await fs.promises.readFile(FOLDER_CACHE_FILE, 'utf8');
            const cacheData = JSON.parse(cacheContent);
            res.json({
                success: true,
                hasCache: true,
                data: cacheData
            });
        } else {
            // 如果没有缓存文件，自动扫描生成
            const musicDir = path.join(__dirname, 'music');
            
            if (!fs.existsSync(musicDir)) {
                // 音乐文件夹不存在，返回空数据
                const cacheData = {
                    timestamp: Date.now(),
                    folders: [],
                    files: [],
                    totalFiles: 0,
                    totalFolders: 0
                };
                // 保存空缓存
                await fs.promises.writeFile(FOLDER_CACHE_FILE, JSON.stringify(cacheData, null, 2));
                res.json({
                    success: true,
                    hasCache: true,
                    data: cacheData,
                    message: '音乐文件夹不存在'
                });
                return;
            }
            
            console.log('🔍 缓存不存在，自动扫描音乐文件夹...');
            
            // 递归扫描文件夹结构
            const scanResult = await scanFolderRecursive(musicDir, '');
            
            // 保存到缓存文件
            const cacheData = {
                timestamp: Date.now(),
                ...scanResult
            };
            
            await fs.promises.writeFile(FOLDER_CACHE_FILE, JSON.stringify(cacheData, null, 2));
            
            console.log(`✅ 自动扫描完成！共扫描 ${scanResult.totalFiles} 个文件，${scanResult.totalFolders} 个文件夹`);
            
            res.json({
                success: true,
                hasCache: true,
                data: cacheData,
                message: `已扫描 ${scanResult.totalFiles} 个文件，${scanResult.totalFolders} 个文件夹`
            });
        }
    } catch (error) {
        console.error('读取缓存失败:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取文件夹和文件列表
app.get('/api/folders', async (req, res) => {
    try {
        const musicDir = path.join(__dirname, 'music');
        const folderPath = req.query.path ? decodeURIComponent(req.query.path) : '';
        const page = parseInt(req.query.page) || 1;
        const pageSize = parseInt(req.query.pageSize) || 20;
        const searchKeyword = req.query.search ? decodeURIComponent(req.query.search).trim() : '';

        if (!fs.existsSync(musicDir)) {
            return res.json({ success: true, folders: [], files: [], currentPath: '', totalFiles: 0, page: 1, pageSize: 20, totalPages: 0 });
        }

        // 构建当前完整路径
        let currentFullPath = musicDir;
        if (folderPath) {
            const normalizedPath = folderPath.replace(/\//g, path.sep);
            currentFullPath = path.join(musicDir, normalizedPath);
        }

        if (!fs.existsSync(currentFullPath)) {
            return res.status(404).json({ success: false, error: '路径不存在' });
        }

        // 使用异步读取目录
        const entries = await fs.promises.readdir(currentFullPath, { withFileTypes: true });

        const folders = [];
        const musicFiles = []; // 只存储文件路径，不立即解析元数据

        // 异步处理每个条目
        const promises = entries.map(async (entry) => {
            const fullPath = path.join(currentFullPath, entry.name);
            const relativePath = folderPath ? folderPath + '/' + entry.name : entry.name;

            if (entry.isDirectory()) {
                // 异步统计该文件夹下的音乐文件数量
                let musicCount = 0;
                async function countMusicFilesAsync(dirPath) {
                    const dirEntries = await fs.promises.readdir(dirPath, { withFileTypes: true });
                    for (const dirEntry of dirEntries) {
                        const filePath = path.join(dirPath, dirEntry.name);
                        if (dirEntry.isDirectory()) {
                            await countMusicFilesAsync(filePath);
                        } else if (MUSIC_EXTENSIONS.includes(path.extname(dirEntry.name).toLowerCase())) {
                            musicCount++;
                        }
                    }
                }
                await countMusicFilesAsync(fullPath);

                // 异步检查是否有子文件夹
                const subEntries = await fs.promises.readdir(fullPath, { withFileTypes: true });
                const hasSubFolders = subEntries.some(e => e.isDirectory());

                folders.push({
                    name: entry.name,
                    path: relativePath,
                    fullPath: fullPath,
                    musicCount: musicCount,
                    hasSubFolders: hasSubFolders
                });
            } else if (entry.isFile() && MUSIC_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) {
                musicFiles.push({
                    fullPath: fullPath,
                    filename: entry.name,
                    folderPath: folderPath
                });
            }
        });

        // 等待所有异步操作完成
        await Promise.all(promises);

        // 按文件名排序（不依赖元数据）
        folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
        musicFiles.sort((a, b) => a.filename.localeCompare(b.filename, undefined, { sensitivity: 'base' }));

        // 如果有搜索关键词，基于文件名过滤
        let filteredFiles = musicFiles;
        if (searchKeyword) {
            const lowerKeyword = searchKeyword.toLowerCase();
            
            // 只基于文件名搜索（快速）
            filteredFiles = musicFiles.filter(f => 
                f.filename.toLowerCase().includes(lowerKeyword)
            );
            
            // 搜索结果也需要分页，只解析当前页文件的元数据
            const totalFiles = filteredFiles.length;
            const totalPages = Math.ceil(totalFiles / pageSize);
            const startIndex = (page - 1) * pageSize;
            const endIndex = startIndex + pageSize;
            const pageFiles = filteredFiles.slice(startIndex, endIndex);
            
            // 只解析当前页文件的元数据
            const filesWithMetadata = await Promise.all(pageFiles.map(async (file) => {
                const metadata = await getMusicMetadata(file.fullPath);
                return {
                    ...metadata,
                    path: file.fullPath,
                    folderPath: file.folderPath
                };
            }));
            
            return res.json({ 
                success: true, 
                folders: [],
                files: filesWithMetadata,
                currentPath: folderPath,
                totalFiles: totalFiles,
                page: page,
                pageSize: pageSize,
                totalPages: totalPages
            });
        }

        // 无搜索时：只获取当前页的文件元数据
        const totalFiles = musicFiles.length;
        const totalPages = Math.ceil(totalFiles / pageSize);
        const startIndex = (page - 1) * pageSize;
        const endIndex = startIndex + pageSize;
        const pageFiles = musicFiles.slice(startIndex, endIndex);
        
        // 只解析当前页文件的元数据
        const filesWithMetadata = await Promise.all(pageFiles.map(async (file) => {
            const metadata = await getMusicMetadata(file.fullPath);
            return {
                ...metadata,
                path: file.fullPath,
                folderPath: file.folderPath
            };
        }));

        res.json({ 
            success: true, 
            folders: folders,
            files: filesWithMetadata,
            currentPath: folderPath,
            totalFiles: totalFiles,
            page: page,
            pageSize: pageSize,
            totalPages: totalPages
        });
    } catch (error) {
        console.error('获取文件夹列表失败:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取指定文件夹下的音乐文件
app.get('/api/folder/:folderPath', async (req, res) => {
    try {
        let folderPath = decodeURIComponent(req.params.folderPath);
        // 将正斜杠转换为系统路径分隔符
        folderPath = folderPath.replace(/\//g, path.sep);
        
        const musicDir = path.join(__dirname, 'music');
        const fullPath = path.join(musicDir, folderPath);

        console.log(' 请求文件夹路径:', folderPath);
        console.log('📂 完整路径:', fullPath);

        if (!fs.existsSync(fullPath)) {
            console.log('❌ 文件夹不存在:', fullPath);
            return res.status(404).json({ success: false, error: '文件夹不存在' });
        }

        // 使用异步读取目录
        const entries = await fs.promises.readdir(fullPath, { withFileTypes: true });

        console.log('📂 文件夹内容:', entries.map(e => e.name));

        // 异步处理每个文件
        const musicFiles = [];
        const promises = entries.map(async (entry) => {
            const filePath = path.join(fullPath, entry.name);
            if (entry.isFile() && MUSIC_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) {
                const metadata = await getMusicMetadata(filePath);
                musicFiles.push(metadata);
            }
        });

        await Promise.all(promises);

        console.log('📂 找到音乐文件数量:', musicFiles.length);

        // 按标题字母排序
        musicFiles.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));

        res.json({
            success: true,
            folder: folderPath,
            music: musicFiles
        });
    } catch (error) {
        console.error('获取文件夹音乐失败:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 文件夹缓存：folderPath -> { files: [{path, title, artist, album, duration}], lastModified: timestamp }
const folderCache = new Map();

// 分类浏览缓存
const browseCache = new Map();

// 按分类浏览音乐（艺术家/专辑/流派/年份）
app.get('/api/browse', async (req, res) => {
    try {
        const type = req.query.type || 'artist';
        const group = req.query.group ? decodeURIComponent(req.query.group) : null;
        const page = parseInt(req.query.page) || 1;
        const pageSize = parseInt(req.query.pageSize) || 50;
        const search = req.query.search ? decodeURIComponent(req.query.search).trim() : '';

        const validTypes = ['artist', 'album', 'genre', 'year'];
        if (!validTypes.includes(type)) {
            return res.status(400).json({ success: false, error: '无效的分类类型' });
        }

        const cacheKey = `browse_${type}`;
        const musicDirStat = fs.statSync(MUSIC_DIR);
        const cached = browseCache.get(cacheKey);
        let allFiles;

        if (cached && cached.lastModified >= musicDirStat.mtimeMs) {
            allFiles = cached.files;
            console.log(`📦 使用分类浏览缓存: ${type}`);
        } else {
            const filePaths = [];
            const scanDir = (dir) => {
                if (!fs.existsSync(dir)) return;
                const items = fs.readdirSync(dir, { withFileTypes: true });
                for (const item of items) {
                    const fullPath = path.join(dir, item.name);
                    if (item.isDirectory()) {
                        scanDir(fullPath);
                    } else if (MUSIC_EXTENSIONS.includes(path.extname(item.name).toLowerCase())) {
                        filePaths.push(fullPath);
                    }
                }
            };
            scanDir(MUSIC_DIR);

            allFiles = [];
            const batchSize = 20;
            for (let i = 0; i < filePaths.length; i += batchSize) {
                const batch = filePaths.slice(i, i + batchSize);
                const promises = batch.map(async (filePath) => {
                    try {
                        const metadata = await mm.parseFile(filePath);
                        const common = metadata.common;
                        let artist = '未知艺术家';
                        let album = '未知专辑';
                        let genre = '未知流派';
                        let year = '未知年份';

                        if (common.artists && common.artists.length > 0 && common.artists[0].trim()) {
                            artist = common.artists[0].trim();
                        } else if (common.artist && common.artist.trim()) {
                            artist = common.artist.trim();
                        }

                        if (common.album && common.album.trim()) {
                            album = common.album.trim();
                        }

                        if (common.genres && common.genres.length > 0 && common.genres[0].trim()) {
                            genre = common.genres[0].trim();
                        }

                        if (common.date) {
                            const yearStr = String(common.date).substring(0, 4);
                            if (yearStr && /^\d{4}$/.test(yearStr)) {
                                year = yearStr;
                            }
                        }

                        return {
                            path: filePath,
                            filename: path.basename(filePath),
                            title: common.title || path.basename(filePath, path.extname(filePath)),
                            artist,
                            album,
                            genre,
                            year,
                            duration: metadata.format.duration || 0,
                            size: fs.statSync(filePath).size
                        };
                    } catch (e) {
                        return {
                            path: filePath,
                            filename: path.basename(filePath),
                            title: path.basename(filePath, path.extname(filePath)),
                            artist: '未知艺术家',
                            album: '未知专辑',
                            genre: '未知流派',
                            year: '未知年份',
                            duration: 0,
                            size: fs.existsSync(filePath) ? fs.statSync(filePath).size : 0
                        };
                    }
                });
                allFiles.push(...(await Promise.all(promises)));
                await new Promise(r => setImmediate(r));
            }

            browseCache.set(cacheKey, {
                files: allFiles,
                lastModified: musicDirStat.mtimeMs
            });
            console.log(`📚 分类浏览扫描完成: ${type} (${allFiles.length} 首)`);
        }

        if (search) {
            const searchLower = search.toLowerCase();
            allFiles = allFiles.filter(f =>
                f.title.toLowerCase().includes(searchLower) ||
                f.artist.toLowerCase().includes(searchLower) ||
                f.album.toLowerCase().includes(searchLower)
            );
        }

        const groupMap = new Map();
        allFiles.forEach(file => {
            let key;
            switch (type) {
                case 'artist': key = file.artist; break;
                case 'album': key = file.album; break;
                case 'genre': key = file.genre; break;
                case 'year': key = file.year; break;
                default: key = file.artist;
            }
            if (!groupMap.has(key)) {
                groupMap.set(key, []);
            }
            groupMap.get(key).push(file);
        });

        if (group) {
            const groupFiles = groupMap.get(group) || [];
            groupFiles.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));

            const total = groupFiles.length;
            const totalPages = Math.ceil(total / pageSize);
            const startIndex = (page - 1) * pageSize;
            const pageFiles = groupFiles.slice(startIndex, startIndex + pageSize);

            res.json({
                success: true,
                type,
                group,
                totalFiles: total,
                totalPages,
                page,
                pageSize,
                files: pageFiles
            });
        } else {
            const groups = Array.from(groupMap.entries())
                .map(([name, files]) => ({
                    name,
                    count: files.length,
                    duration: files.reduce((sum, f) => sum + (f.duration || 0), 0)
                }))
                .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

            res.json({
                success: true,
                type,
                totalGroups: groups.length,
                groups
            });
        }
    } catch (error) {
        console.error('分类浏览失败:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 刷新分类浏览缓存
app.post('/api/browse/refresh', requireAuth, async (req, res) => {
    try {
        browseCache.clear();
        res.json({ success: true, message: '分类缓存已刷新' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 重复文件检测
app.get('/api/duplicates', async (req, res) => {
    try {
        const method = req.query.method || 'metadata';
        const threshold = parseFloat(req.query.threshold) || 2;

        const cacheKey = `browse_artist`;
        const musicDirStat = fs.statSync(MUSIC_DIR);
        const cached = browseCache.get(cacheKey);
        let allFiles;

        if (cached && cached.lastModified >= musicDirStat.mtimeMs) {
            allFiles = cached.files;
        } else {
            const filePaths = [];
            const scanDir = (dir) => {
                if (!fs.existsSync(dir)) return;
                const items = fs.readdirSync(dir, { withFileTypes: true });
                for (const item of items) {
                    const fullPath = path.join(dir, item.name);
                    if (item.isDirectory()) {
                        scanDir(fullPath);
                    } else if (MUSIC_EXTENSIONS.includes(path.extname(item.name).toLowerCase())) {
                        filePaths.push(fullPath);
                    }
                }
            };
            scanDir(MUSIC_DIR);

            allFiles = [];
            const batchSize = 20;
            for (let i = 0; i < filePaths.length; i += batchSize) {
                const batch = filePaths.slice(i, i + batchSize);
                const promises = batch.map(async (filePath) => {
                    try {
                        const stat = fs.statSync(filePath);
                        const metadata = await mm.parseFile(filePath);
                        const common = metadata.common;
                        let artist = '未知艺术家';
                        let album = '未知专辑';
                        let title = path.basename(filePath, path.extname(filePath));

                        if (common.artists && common.artists.length > 0 && common.artists[0].trim()) {
                            artist = common.artists[0].trim();
                        } else if (common.artist && common.artist.trim()) {
                            artist = common.artist.trim();
                        }

                        if (common.album && common.album.trim()) {
                            album = common.album.trim();
                        }

                        if (common.title && common.title.trim()) {
                            title = common.title.trim();
                        }

                        return {
                            path: filePath,
                            filename: path.basename(filePath),
                            title,
                            artist,
                            album,
                            duration: metadata.format.duration || 0,
                            size: stat.size,
                            bitrate: metadata.format.bitrate || 0
                        };
                    } catch (e) {
                        const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : { size: 0 };
                        return {
                            path: filePath,
                            filename: path.basename(filePath),
                            title: path.basename(filePath, path.extname(filePath)),
                            artist: '未知艺术家',
                            album: '未知专辑',
                            duration: 0,
                            size: stat.size || 0,
                            bitrate: 0
                        };
                    }
                });
                allFiles.push(...(await Promise.all(promises)));
                await new Promise(r => setImmediate(r));
            }

            browseCache.set(cacheKey, {
                files: allFiles,
                lastModified: musicDirStat.mtimeMs
            });
        }

        const duplicates = [];
        const groups = new Map();

        if (method === 'filename') {
            allFiles.forEach(file => {
                const key = file.filename.toLowerCase();
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key).push(file);
            });
        } else if (method === 'size') {
            allFiles.forEach(file => {
                const key = String(file.size);
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key).push(file);
            });
        } else {
            allFiles.forEach(file => {
                const normalizedTitle = file.title.toLowerCase().trim();
                const normalizedArtist = file.artist.toLowerCase().trim();
                const key = `${normalizedTitle}__${normalizedArtist}`;
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key).push(file);
            });
        }

        for (const [key, files] of groups) {
            if (files.length > 1) {
                if (method === 'metadata') {
                    const durations = files.map(f => f.duration).filter(d => d > 0);
                    if (durations.length >= 2) {
                        const maxDuration = Math.max(...durations);
                        const minDuration = Math.min(...durations);
                        if (maxDuration - minDuration > threshold) {
                            continue;
                        }
                    }
                }

                let totalSize = 0;
                files.forEach(f => totalSize += f.size);
                const wastedSize = totalSize - Math.max(...files.map(f => f.size));

                duplicates.push({
                    key,
                    count: files.length,
                    totalSize,
                    wastedSize,
                    files
                });
            }
        }

        duplicates.sort((a, b) => b.wastedSize - a.wastedSize);

        const totalDuplicateGroups = duplicates.length;
        const totalDuplicateFiles = duplicates.reduce((sum, d) => sum + d.count, 0);
        const totalWastedSize = duplicates.reduce((sum, d) => sum + d.wastedSize, 0);

        res.json({
            success: true,
            method,
            totalDuplicateGroups,
            totalDuplicateFiles,
            totalWastedSize,
            duplicates
        });
    } catch (error) {
        console.error('重复文件检测失败:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 播放整个文件夹
app.post('/api/folder-play', async (req, res) => {
    try {
        const { folderPath, playMode: folderPlayMode } = req.body;
        const musicDir = path.join(__dirname, 'music');
        const fullPath = path.join(musicDir, folderPath);

        if (!fs.existsSync(fullPath)) {
            return res.status(404).json({ success: false, error: '文件夹不存在' });
        }

        // 快速扫描文件夹下所有音乐文件（包括子文件夹）
        const musicFiles = [];
        async function scanMusicAsync(dir) {
            const entries = await fs.promises.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                const filePath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    await scanMusicAsync(filePath);
                } else if (MUSIC_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) {
                    musicFiles.push(filePath);
                }
            }
        }
        await scanMusicAsync(fullPath);

        if (musicFiles.length === 0) {
            return res.json({ success: false, error: '该文件夹下没有音乐文件' });
        }

        // 检查缓存是否有效
        const cached = folderCache.get(folderPath);
        const folderStat = fs.statSync(fullPath);
        const isCacheValid = cached && cached.lastModified >= folderStat.mtimeMs && cached.files.length === musicFiles.length;

        let tracks;
        if (isCacheValid) {
            // 使用缓存数据
            tracks = cached.files.map(t => ({ ...t }));
            console.log(`📦 使用文件夹缓存: ${folderPath} (${tracks.length} 首)`);
        } else {
            // 创建基础播放列表（不读取元数据，快速开始播放）
            tracks = musicFiles.map(file => ({
                title: path.basename(file, path.extname(file)),
                artist: '未知艺术家',
                album: '未知专辑',
                duration: 0,
                path: file,
                filename: path.basename(file)
            }));
            console.log(`🚀 快速加载 ${tracks.length} 首音乐，后台获取元数据`);
        }

        // 按标题字母排序
        tracks.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));

        // 将文件夹中的音乐添加到播放列表
        currentPlaylist = tracks;
        currentIndex = 0;
        isPlaying = true;

        // 添加到播放历史
        if (tracks.length > 0) {
            addToPlayHistory(tracks[0]);
        }

        // 保存到播放列表缓存
        try {
            fs.writeFileSync(PLAYLIST_CACHE_FILE, JSON.stringify(currentPlaylist, null, 2));
            console.log(`💾 已保存播放列表缓存: ${tracks.length} 首音乐`);
        } catch (error) {
            console.error('保存播放列表缓存失败:', error.message);
        }

        // 立即开始播放第一首
        const firstTrack = tracks[0];

        if (playOutput === 'client') {
            console.log(`📱 客户端模式播放文件夹：${folderPath} (${tracks.length} 首)`);
            currentDuration = firstTrack.duration;
            playbackStartTime = Date.now();
            return res.json({
                success: true,
                message: `开始播放文件夹，共 ${tracks.length} 首音乐`,
                count: tracks.length,
                currentTrack: firstTrack,
                clientMode: true
            });
        }

        playMusicFromPosition(firstTrack.path, 0, true);

        // 立即返回响应，不等待元数据加载
        res.json({
            success: true,
            message: `开始播放文件夹，共 ${tracks.length} 首音乐`,
            count: tracks.length,
            currentTrack: firstTrack
        });

        // 后台异步获取音乐元数据（不阻塞播放）
        if (!isCacheValid) {
            // 传递排序后的 tracks（按 path 匹配元数据）
            loadMetadataInBackground(tracks.map(t => t.path), folderPath);
        }

    } catch (error) {
        console.error('播放文件夹失败:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 后台异步加载元数据
async function loadMetadataInBackground(musicFiles, folderPath) {
    try {
        const batchSize = 10; // 每批处理10个文件
        const updatedTracks = [];

        for (let i = 0; i < musicFiles.length; i += batchSize) {
            const batch = musicFiles.slice(i, i + batchSize);
            const batchPromises = batch.map(async (file) => {
                try {
                    const metadata = await getMusicMetadata(file);
                    return metadata;
                } catch (err) {
                    return {
                        title: path.basename(file, path.extname(file)),
                        artist: '未知艺术家',
                        album: '未知专辑',
                        duration: 0,
                        path: file,
                        filename: path.basename(file)
                    };
                }
            });

            const batchResults = await Promise.all(batchPromises);
            updatedTracks.push(...batchResults);

            // 更新当前播放列表中的元数据
            for (let j = 0; j < batchResults.length; j++) {
                const trackIndex = i + j;
                if (trackIndex < currentPlaylist.length) {
                    currentPlaylist[trackIndex] = batchResults[j];
                }
            }

            // 每批处理后短暂延迟，避免占用过多CPU
            if (i + batchSize < musicFiles.length) {
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        }

        // 更新缓存
        const folderStat = fs.statSync(path.join(__dirname, 'music', folderPath));
        folderCache.set(folderPath, {
            files: updatedTracks,
            lastModified: folderStat.mtimeMs
        });

        console.log(`✅ 后台元数据加载完成: ${folderPath} (${updatedTracks.length} 首)`);

    } catch (error) {
        console.error('后台加载元数据失败:', error.message);
    }
}

app.delete('/api/delete/:index', requireAuth, async (req, res) => {
    const index = parseInt(req.params.index);

    if (index < 0 || index >= currentPlaylist.length) {
        return res.status(400).json({ error: '无效的索引' });
    }

    const track = currentPlaylist[index];

    try {
        // 从播放列表中移除（不删除物理文件）
        currentPlaylist.splice(index, 1);

        // 如果删除的是正在播放的歌曲，停止播放
        if (currentIndex === index) {
            stopMusic();
            currentIndex = -1;
            isPlaying = false;
        } else if (currentIndex > index) {
            // 调整当前播放索引
            currentIndex--;
        }

        // 更新播放列表缓存
        try {
            fs.writeFileSync(PLAYLIST_CACHE_FILE, JSON.stringify(currentPlaylist, null, 2));
            console.log('📝 删除后更新播放列表缓存');
        } catch (error) {
            console.error('更新播放列表缓存失败:', error.message);
        }

        res.json({
            success: true,
            message: `已删除 "${track.title}"`
        });
    } catch (error) {
        console.error('删除文件失败:', error);
        res.status(500).json({ error: '删除文件失败' });
    }
});

// 按文件路径删除文件
app.delete('/api/delete-file', requireAuth, async (req, res) => {
    try {
        const { filePath } = req.body;
        
        if (!filePath) {
            return res.status(400).json({ success: false, error: '缺少文件路径' });
        }
        
        // 如果已经是绝对路径，直接使用；否则拼接 __dirname
        const fullPath = path.isAbsolute(filePath) ? filePath : path.join(__dirname, filePath);
        const fileName = path.basename(fullPath);
        
        // 尝试删除物理文件（如果存在）
        const fileExisted = fs.existsSync(fullPath);
        if (fileExisted) {
            fs.unlinkSync(fullPath);
            console.log(`🗑️ 删除物理文件: ${fullPath}`);
        }
        
        // 从播放列表中移除（无论文件是否存在）
        const index = currentPlaylist.findIndex(track => track.path === fullPath);
        if (index !== -1) {
            const removedTrack = currentPlaylist[index];
            currentPlaylist.splice(index, 1);
            // 更新播放列表缓存
            fs.writeFileSync(PLAYLIST_CACHE_FILE, JSON.stringify(currentPlaylist, null, 2));
            console.log(`📝 从播放列表移除: ${removedTrack.title}`);
        }
        
        // 更新缓存文件（而不是删除）
        if (fs.existsSync(FOLDER_CACHE_FILE)) {
            try {
                const cacheContent = fs.readFileSync(FOLDER_CACHE_FILE, 'utf8');
                const cacheData = JSON.parse(cacheContent);
                
                // 从缓存中删除文件
                removeFileFromCacheData(cacheData, fullPath);
                
                cacheData.timestamp = Date.now();
                fs.writeFileSync(FOLDER_CACHE_FILE, JSON.stringify(cacheData, null, 2));
                console.log('✅ 已更新文件夹缓存');
            } catch (e) {
                console.error('更新缓存失败:', e);
            }
        }
        
        res.json({
            success: true,
            message: fileExisted ? `已删除 "${fileName}"` : `已从列表中移除 "${fileName}"（文件不存在）`
        });
    } catch (error) {
        console.error('删除文件失败:', error);
        res.status(500).json({ success: false, error: '删除文件失败: ' + error.message });
    }
});

// 删除文件夹
app.delete('/api/delete-folder', requireAuth, async (req, res) => {
    try {
        const { folderPath } = req.body;
        
        if (!folderPath) {
            return res.status(400).json({ success: false, error: '缺少文件夹路径' });
        }
        
        const musicDir = path.join(__dirname, 'music');
        const normalizedPath = folderPath.replace(/\//g, path.sep);
        const fullPath = path.join(musicDir, normalizedPath);
        
        // 安全检查：确保路径在 music 目录下
        if (!fullPath.startsWith(musicDir)) {
            return res.status(400).json({ success: false, error: '无效的路径' });
        }
        
        if (!fs.existsSync(fullPath)) {
            return res.status(404).json({ success: false, error: '文件夹不存在' });
        }
        
        // 递归删除文件夹及其内容
        fs.rmSync(fullPath, { recursive: true, force: true });
        console.log(`🗑️ 删除文件夹: ${fullPath}`);
        
        // 从播放列表中移除该文件夹下的所有文件
        const removedFiles = currentPlaylist.filter(track => track.path.startsWith(fullPath));
        currentPlaylist = currentPlaylist.filter(track => !track.path.startsWith(fullPath));
        
        // 更新播放列表缓存
        fs.writeFileSync(PLAYLIST_CACHE_FILE, JSON.stringify(currentPlaylist, null, 2));
        console.log(`📝 从播放列表移除 ${removedFiles.length} 个文件`);
        
        // 更新缓存文件（而不是删除）
        if (fs.existsSync(FOLDER_CACHE_FILE)) {
            try {
                const cacheContent = fs.readFileSync(FOLDER_CACHE_FILE, 'utf8');
                const cacheData = JSON.parse(cacheContent);
                
                // 计算相对路径
                const relativePath = normalizedPath.replace(/^[\\/]/, '').replace(/\\/g, '/');
                
                // 从缓存中删除文件夹
                const folderToDelete = findAndRemoveFolderFromCache(cacheData.folders, relativePath);
                if (folderToDelete) {
                    cacheData.totalFolders = (cacheData.totalFolders || 0) - 1;
                    cacheData.totalFiles = (cacheData.totalFiles || 0) - (folderToDelete.musicCount || 0);
                    if (cacheData.totalFiles < 0) cacheData.totalFiles = 0;
                }
                
                cacheData.timestamp = Date.now();
                fs.writeFileSync(FOLDER_CACHE_FILE, JSON.stringify(cacheData, null, 2));
                console.log('✅ 已更新文件夹缓存');
            } catch (e) {
                console.error('更新缓存失败:', e);
            }
        }
        
        res.json({
            success: true,
            message: `已删除文件夹 "${path.basename(fullPath)}" 及其 ${removedFiles.length} 个文件`
        });
    } catch (error) {
        console.error('删除文件夹失败:', error);
        res.status(500).json({ success: false, error: '删除文件夹失败: ' + error.message });
    }
});

// 解散文件夹（将文件移动到上级目录并删除空文件夹）
app.post('/api/dissolve-folder', requireAuth, async (req, res) => {
    try {
        const { folderPath } = req.body;
        
        if (!folderPath) {
            return res.status(400).json({ success: false, error: '缺少文件夹路径' });
        }
        
        const musicDir = path.join(__dirname, 'music');
        const normalizedPath = folderPath.replace(/\//g, path.sep);
        const fullPath = path.join(musicDir, normalizedPath);
        
        // 安全检查：确保路径在 music 目录下
        if (!fullPath.startsWith(musicDir)) {
            return res.status(400).json({ success: false, error: '无效的路径' });
        }
        
        if (!fs.existsSync(fullPath)) {
            return res.status(404).json({ success: false, error: '文件夹不存在' });
        }
        
        const stat = fs.statSync(fullPath);
        if (!stat.isDirectory()) {
            return res.status(400).json({ success: false, error: '路径不是文件夹' });
        }
        
        const parentDir = path.dirname(fullPath);
        
        // 获取文件夹内的所有文件（不包括子文件夹中的文件）
        const files = fs.readdirSync(fullPath).filter(file => {
            const filePath = path.join(fullPath, file);
            return fs.statSync(filePath).isFile();
        });
        
        let movedCount = 0;
        
        // 移动所有文件到上级目录
        for (const file of files) {
            const sourcePath = path.join(fullPath, file);
            const targetPath = path.join(parentDir, file);
            
            // 如果目标文件已存在，生成新文件名
            let finalTargetPath = targetPath;
            let counter = 1;
            while (fs.existsSync(finalTargetPath)) {
                const ext = path.extname(file);
                const nameWithoutExt = path.basename(file, ext);
                finalTargetPath = path.join(parentDir, `${nameWithoutExt}_${counter}${ext}`);
                counter++;
            }
            
            fs.renameSync(sourcePath, finalTargetPath);
            movedCount++;
            
            // 更新播放列表中的路径
            const index = currentPlaylist.findIndex(track => track.path === sourcePath);
            if (index !== -1) {
                currentPlaylist[index].path = finalTargetPath;
            }
        }
        
        // 删除空文件夹
        fs.rmdirSync(fullPath);
        console.log(`📂 解散文件夹: ${fullPath}，移动了 ${movedCount} 个文件`);
        
        // 保存播放列表
        fs.writeFileSync(PLAYLIST_CACHE_FILE, JSON.stringify(currentPlaylist, null, 2));
        
        // 更新缓存文件
        if (fs.existsSync(FOLDER_CACHE_FILE)) {
            try {
                const cacheContent = fs.readFileSync(FOLDER_CACHE_FILE, 'utf8');
                const cacheData = JSON.parse(cacheContent);
                
                // 计算相对路径
                const relativePath = normalizedPath.replace(/^[\\/]/, '').replace(/\\/g, '/');
                
                // 从缓存中删除文件夹
                const folderToDelete = findAndRemoveFolderFromCache(cacheData.folders, relativePath);
                if (folderToDelete) {
                    cacheData.totalFolders = (cacheData.totalFolders || 0) - 1;
                    cacheData.totalFiles = (cacheData.totalFiles || 0) - (folderToDelete.musicCount || 0);
                    if (cacheData.totalFiles < 0) cacheData.totalFiles = 0;
                }
                
                cacheData.timestamp = Date.now();
                fs.writeFileSync(FOLDER_CACHE_FILE, JSON.stringify(cacheData, null, 2));
                console.log('✅ 已更新文件夹缓存');
            } catch (e) {
                console.error('更新缓存失败:', e);
            }
        }
        
        res.json({
            success: true,
            message: `已解散文件夹 "${path.basename(fullPath)}"，${movedCount} 个文件已移动到上级目录`
        });
    } catch (error) {
        console.error('解散文件夹失败:', error);
        res.status(500).json({ success: false, error: '解散文件夹失败: ' + error.message });
    }
});

// 重命名文件夹
app.post('/api/rename-folder', requireAuth, async (req, res) => {
    try {
        const { folderPath, newName } = req.body;
        
        if (!folderPath || !newName) {
            return res.status(400).json({ success: false, error: '缺少参数' });
        }
        
        // 检查非法字符
        const invalidChars = /[\\/:*?"<>|]/;
        if (invalidChars.test(newName)) {
            return res.status(400).json({ success: false, error: '文件夹名称包含非法字符' });
        }
        
        const musicDir = path.join(__dirname, 'music');
        const normalizedPath = folderPath.replace(/\//g, path.sep);
        const oldFullPath = path.join(musicDir, normalizedPath);
        
        // 安全检查：确保路径在 music 目录下
        if (!oldFullPath.startsWith(musicDir)) {
            return res.status(400).json({ success: false, error: '无效的路径' });
        }
        
        if (!fs.existsSync(oldFullPath)) {
            return res.status(404).json({ success: false, error: '文件夹不存在' });
        }
        
        // 构建新路径
        const parentDir = path.dirname(oldFullPath);
        const newFullPath = path.join(parentDir, newName);
        
        // 检查新名称是否已存在
        if (fs.existsSync(newFullPath)) {
            return res.status(400).json({ success: false, error: '同名文件夹已存在' });
        }
        
        // 重命名文件夹
        fs.renameSync(oldFullPath, newFullPath);
        console.log(`📝 重命名文件夹: ${oldFullPath} -> ${newFullPath}`);
        
        // 更新播放列表中该文件夹下文件的路径
        let updatedCount = 0;
        currentPlaylist = currentPlaylist.map(track => {
            if (track.path.startsWith(oldFullPath)) {
                const relativePath = track.path.substring(oldFullPath.length);
                track.path = newFullPath + relativePath;
                updatedCount++;
                return track;
            }
            return track;
        });
        
        // 更新播放列表缓存
        fs.writeFileSync(PLAYLIST_CACHE_FILE, JSON.stringify(currentPlaylist, null, 2));
        console.log(`📝 更新播放列表中 ${updatedCount} 个文件的路径`);
        
        // 更新缓存文件（而不是删除）
        if (fs.existsSync(FOLDER_CACHE_FILE)) {
            try {
                const cacheContent = fs.readFileSync(FOLDER_CACHE_FILE, 'utf8');
                const cacheData = JSON.parse(cacheContent);
                
                // 计算相对路径
                const oldRelativePath = normalizedPath.replace(/^[\\/]/, '').replace(/\\/g, '/');
                const parentPath = oldRelativePath.substring(0, oldRelativePath.lastIndexOf('/'));
                const newRelativePath = parentPath ? `${parentPath}/${newName}` : newName;
                
                // 更新缓存中的文件夹名称和路径
                updateFolderNameInCache(cacheData.folders, oldRelativePath, newRelativePath, newName);
                
                cacheData.timestamp = Date.now();
                fs.writeFileSync(FOLDER_CACHE_FILE, JSON.stringify(cacheData, null, 2));
                console.log('✅ 已更新文件夹缓存');
            } catch (e) {
                console.error('更新缓存失败:', e);
            }
        }
        
        res.json({
            success: true,
            message: `已将文件夹重命名为 "${newName}"`
        });
    } catch (error) {
        console.error('重命名文件夹失败:', error);
        res.status(500).json({ success: false, error: '重命名文件夹失败: ' + error.message });
    }
});

// 移动文件夹
app.post('/api/move-folder', requireAuth, async (req, res) => {
    try {
        const { folderPath, targetFolder } = req.body;
        
        if (!folderPath || !targetFolder) {
            return res.status(400).json({ success: false, error: '缺少参数' });
        }
        
        const musicDir = path.join(__dirname, 'music');
        const normalizedPath = folderPath.replace(/\//g, path.sep);
        const oldFullPath = path.join(musicDir, normalizedPath);
        
        // 安全检查
        if (!oldFullPath.startsWith(musicDir)) {
            return res.status(400).json({ success: false, error: '无效的路径' });
        }
        
        if (!fs.existsSync(oldFullPath)) {
            return res.status(404).json({ success: false, error: '文件夹不存在' });
        }
        
        // 构建目标路径
        let fullTargetPath = targetFolder;
        if (targetFolder.startsWith('/music')) {
            const relativePath = targetFolder.substring('/music'.length);
            fullTargetPath = path.join(musicDir, relativePath);
        }
        
        // 确保目标文件夹存在
        if (!fs.existsSync(fullTargetPath)) {
            fs.mkdirSync(fullTargetPath, { recursive: true });
        }
        
        const folderName = path.basename(oldFullPath);
        const newFullPath = path.join(fullTargetPath, folderName);
        
        // 检查目标是否已存在
        if (fs.existsSync(newFullPath)) {
            return res.status(400).json({ success: false, error: '目标位置已存在同名文件夹' });
        }
        
        // 移动文件夹
        fs.renameSync(oldFullPath, newFullPath);
        console.log(`📁 移动文件夹: ${oldFullPath} -> ${newFullPath}`);
        
        // 更新播放列表中文件的路径
        let updatedCount = 0;
        currentPlaylist = currentPlaylist.map(track => {
            if (track.path.startsWith(oldFullPath)) {
                const relativePath = track.path.substring(oldFullPath.length);
                track.path = newFullPath + relativePath;
                updatedCount++;
                return track;
            }
            return track;
        });
        
        fs.writeFileSync(PLAYLIST_CACHE_FILE, JSON.stringify(currentPlaylist, null, 2));
        
        // 更新缓存
        if (fs.existsSync(FOLDER_CACHE_FILE)) {
            try {
                const cacheContent = fs.readFileSync(FOLDER_CACHE_FILE, 'utf8');
                const cacheData = JSON.parse(cacheContent);
                
                const oldRelativePath = normalizedPath.replace(/^[\\/]/, '').replace(/\\/g, '/');
                const targetRelativePath = fullTargetPath.substring(musicDir.length).replace(/^[\\/]/, '').replace(/\\/g, '/');
                const newRelativePath = targetRelativePath ? `${targetRelativePath}/${folderName}` : folderName;
                
                const folderToMove = findAndRemoveFolderFromCache(cacheData.folders, oldRelativePath);
                if (folderToMove) {
                    folderToMove.path = newRelativePath;
                    addFolderToCache(cacheData.folders, folderToMove, targetRelativePath);
                }
                
                cacheData.timestamp = Date.now();
                fs.writeFileSync(FOLDER_CACHE_FILE, JSON.stringify(cacheData, null, 2));
            } catch (e) {
                console.error('更新缓存失败:', e);
            }
        }
        
        res.json({
            success: true,
            message: `已将文件夹 "${folderName}" 移动到 "${targetFolder}"`
        });
    } catch (error) {
        console.error('移动文件夹失败:', error);
        res.status(500).json({ success: false, error: '移动文件夹失败: ' + error.message });
    }
});

// 批量转换文件夹为MP3
app.post('/api/batch-convert-folder-mp3', requireAuth, async (req, res) => {
    try {
        const { folderPath, bitrate } = req.body;
        
        if (!folderPath) {
            return res.status(400).json({ success: false, error: '缺少文件夹路径' });
        }
        
        const musicDir = path.join(__dirname, 'music');
        
        // 处理路径：如果以 /music 开头，去掉前缀
        let normalizedPath = folderPath.replace(/\//g, path.sep);
        if (normalizedPath.startsWith(path.sep + 'music' + path.sep) || normalizedPath === path.sep + 'music') {
            normalizedPath = normalizedPath.substring(('music' + path.sep).length + 1); // 去掉 /music/ 前缀
            if (!normalizedPath) normalizedPath = '';
        }
        
        const fullPath = normalizedPath ? path.join(musicDir, normalizedPath) : musicDir;
        
        // 安全检查
        if (!fullPath.startsWith(musicDir)) {
            return res.status(400).json({ success: false, error: '无效的路径' });
        }
        
        if (!fs.existsSync(fullPath)) {
            return res.status(404).json({ success: false, error: '文件夹不存在' });
        }
        
        const stat = fs.statSync(fullPath);
        if (!stat.isDirectory()) {
            return res.status(400).json({ success: false, error: '路径不是文件夹' });
        }
        
        // 递归收集所有非MP3音乐文件
        const nonMp3Extensions = ['.flac', '.wav', '.ogg', '.m4a', '.aac', '.wma'];
        const filesToConvert = [];
        
        function collectFiles(dirPath) {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                const entryPath = path.join(dirPath, entry.name);
                if (entry.isDirectory()) {
                    collectFiles(entryPath);
                } else if (entry.isFile()) {
                    const ext = path.extname(entry.name).toLowerCase();
                    if (nonMp3Extensions.includes(ext)) {
                        filesToConvert.push(entryPath);
                    }
                }
            }
        }
        
        collectFiles(fullPath);
        
        if (filesToConvert.length === 0) {
            return res.json({ success: true, message: '文件夹中没有需要转换的文件' });
        }
        
        // 复用已有的批量转换逻辑
        const taskIds = [];
        
        for (const filePath of filesToConvert) {
            if (!fs.existsSync(filePath)) {
                continue;
            }
            
            const ext = path.extname(filePath).toLowerCase();
            if (ext === '.mp3') {
                continue;
            }
            
            const dir = path.dirname(filePath);
            const nameWithoutExt = path.basename(filePath).replace(/\.[^/.]+$/, '');
            let outputPath = path.join(dir, nameWithoutExt + '.mp3');
            
            let counter = 1;
            while (fs.existsSync(outputPath)) {
                outputPath = path.join(dir, `${nameWithoutExt}_${counter}.mp3`);
                counter++;
            }
            
            const taskId = Date.now().toString(36) + Math.random().toString(36).substr(2);
            taskOrderCounter++;
            const task = {
                id: taskId,
                orderIndex: taskOrderCounter,
                filePath,
                outputPath,
                bitrate: bitrate || '192',
                status: 'queued',
                progress: 0,
                message: '等待转换',
                startTime: Date.now()
            };
            
            convertQueue.push(task);
            taskIds.push(taskId);
        }
        
        if (taskIds.length === 0) {
            return res.json({ 
                success: false, 
                error: '没有需要转换的文件（请选择非MP3格式的音乐文件）',
                totalTasks: 0
            });
        }
        
        // 启动worker处理队列
        for (let i = 0; i < maxConvertWorkers; i++) {
            processConvertQueue();
        }
        
        res.json({ 
            success: true, 
            taskIds,
            totalTasks: taskIds.length,
            message: `已将文件夹中的 ${taskIds.length} 个文件添加到转换队列`
        });
        
    } catch (error) {
        console.error('转换文件夹失败:', error);
        res.status(500).json({ success: false, error: '转换失败: ' + error.message });
    }
});

// 重命名音乐文件
app.post('/api/rename-file', requireAuth, async (req, res) => {
    try {
        const { filePath, newName } = req.body;
        
        if (!filePath || !newName) {
            return res.status(400).json({ success: false, error: '缺少参数' });
        }
        
        // 检查非法字符
        const invalidChars = /[\\/:*?"<>|]/;
        if (invalidChars.test(newName)) {
            return res.status(400).json({ success: false, error: '文件名称包含非法字符' });
        }
        
        // 如果已经是绝对路径，直接使用；否则拼接 __dirname
        const oldFullPath = path.isAbsolute(filePath) ? filePath : path.join(__dirname, filePath);
        
        if (!fs.existsSync(oldFullPath)) {
            return res.status(404).json({ success: false, error: '文件不存在' });
        }
        
        // 获取文件扩展名
        const ext = path.extname(oldFullPath);
        const parentDir = path.dirname(oldFullPath);
        const newFullPath = path.join(parentDir, newName + ext);
        
        // 检查新名称是否已存在
        if (fs.existsSync(newFullPath)) {
            return res.status(400).json({ success: false, error: '同名文件已存在' });
        }
        
        // 重命名文件
        fs.renameSync(oldFullPath, newFullPath);
        console.log(`📝 重命名文件: ${oldFullPath} -> ${newFullPath}`);
        
        // 更新播放列表中该文件的路径
        const trackIndex = currentPlaylist.findIndex(track => track.path === oldFullPath);
        if (trackIndex !== -1) {
            currentPlaylist[trackIndex].path = newFullPath;
            currentPlaylist[trackIndex].title = newName;
            // 更新播放列表缓存
            fs.writeFileSync(PLAYLIST_CACHE_FILE, JSON.stringify(currentPlaylist, null, 2));
            console.log(`📝 更新播放列表中文件路径`);
        }
        
        // 更新缓存文件（而不是删除）
        if (fs.existsSync(FOLDER_CACHE_FILE)) {
            try {
                const cacheContent = fs.readFileSync(FOLDER_CACHE_FILE, 'utf8');
                const cacheData = JSON.parse(cacheContent);
                
                // 更新缓存中的文件路径
                updateFilePathInCache(cacheData, oldFullPath, newFullPath, newName + ext);
                
                cacheData.timestamp = Date.now();
                fs.writeFileSync(FOLDER_CACHE_FILE, JSON.stringify(cacheData, null, 2));
                console.log('✅ 已更新文件夹缓存');
            } catch (e) {
                console.error('更新缓存失败:', e);
            }
        }
        
        res.json({
            success: true,
            message: `已将文件重命名为 "${newName}${ext}"`
        });
    } catch (error) {
        console.error('重命名音乐文件失败:', error);
        res.status(500).json({ success: false, error: '重命名音乐文件失败: ' + error.message });
    }
});

// 批量从播放列表删除（不删除物理文件）
app.post('/api/batch-delete-playlist', requireAuth, async (req, res) => {
    try {
        const { indices } = req.body;
        
        if (!Array.isArray(indices) || indices.length === 0) {
            return res.status(400).json({ success: false, error: '请选择要删除的歌曲' });
        }
        
        // 按降序排序，从后往前删除，避免索引变化
        const sortedIndices = [...indices].sort((a, b) => b - a);
        
        let deletedCount = 0;
        for (const index of sortedIndices) {
            if (index >= 0 && index < currentPlaylist.length) {
                // 如果删除的是正在播放的歌曲，停止播放
                if (currentIndex === index) {
                    stopMusic();
                    currentIndex = -1;
                    isPlaying = false;
                } else if (currentIndex > index) {
                    currentIndex--;
                }
                
                currentPlaylist.splice(index, 1);
                deletedCount++;
            }
        }
        
        // 更新播放列表缓存
        try {
            fs.writeFileSync(PLAYLIST_CACHE_FILE, JSON.stringify(currentPlaylist, null, 2));
            console.log(`📝 批量删除后更新播放列表缓存，删除了 ${deletedCount} 首`);
        } catch (error) {
            console.error('更新播放列表缓存失败:', error.message);
        }
        
        res.json({
            success: true,
            message: `已从播放列表删除 ${deletedCount} 首歌曲`
        });
    } catch (error) {
        console.error('批量删除失败:', error.message);
        res.status(500).json({ success: false, error: '批量删除失败' });
    }
});

// 清空播放列表
app.post('/api/clear-playlist', (req, res) => {
    try {
        stopMusic();
        currentPlaylist = [];
        currentIndex = -1;
        isPlaying = false;
        currentDuration = 0;
        playbackStartTime = null;

        try {
            fs.writeFileSync(PLAYLIST_CACHE_FILE, JSON.stringify([], null, 2));
            console.log('📝 播放列表已清空，缓存已更新');
        } catch (error) {
            console.error('更新播放列表缓存失败:', error.message);
        }

        res.json({ success: true, message: '播放列表已清空' });
    } catch (error) {
        console.error('清空播放列表失败:', error.message);
        res.status(500).json({ success: false, error: '清空失败' });
    }
});

// 按文件路径播放（单曲播放，播放完自动停止）
app.post('/api/play', async (req, res) => {
    try {
        const { path: filePath } = req.body;
        
        if (!filePath) {
            return res.status(400).json({ success: false, error: '缺少文件路径' });
        }
        
        // 如果已经是绝对路径，直接使用；否则拼接 __dirname
        const fullPath = path.isAbsolute(filePath) ? filePath : path.join(__dirname, filePath);
        
        if (!fs.existsSync(fullPath)) {
            return res.status(404).json({ success: false, error: '文件不存在' });
        }
        
        // 先停止当前播放
        stopMusic();
        
        // 获取音乐元数据
        const metadata = await getMusicMetadata(fullPath);
        
        // 检查该歌曲是否在播放列表中，如果在就使用它的索引
        const existingIndex = currentPlaylist.findIndex(track => track.path === fullPath);
        
        // 设置当前播放
        if (existingIndex >= 0) {
            currentIndex = existingIndex;
        } else {
            // 如果不在播放列表中，添加到列表末尾并排序
            currentPlaylist.push(metadata);
            // 按标题字母排序
            currentPlaylist.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
            // 排序后重新查找索引
            currentIndex = currentPlaylist.findIndex(track => track.path === fullPath);
        }
        isPlaying = true;
        
        // 添加到播放历史
        addToPlayHistory(metadata);
        
        console.log(`🎵 单曲播放：${metadata.title}`);
        
        if (playOutput === 'client') {
            console.log(`📱 客户端模式，不启动服务端播放`);
            return res.json({
                success: true,
                current: metadata,
                index: currentIndex,
                clientMode: true
            });
        }
        
        // 开始播放（正常模式，播放完自动播放下一首）
        playMusic(fullPath);
        
        res.json({
            success: true,
            current: metadata
        });
    } catch (error) {
        console.error('播放失败:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 添加到播放列表（不立即播放）
app.post('/api/add-to-playlist', async (req, res) => {
    try {
        const { path: filePath } = req.body;
        
        if (!filePath) {
            return res.status(400).json({ success: false, error: '缺少文件路径' });
        }
        
        const fullPath = path.isAbsolute(filePath) ? filePath : path.join(__dirname, filePath);
        
        if (!fs.existsSync(fullPath)) {
            return res.status(404).json({ success: false, error: '文件不存在' });
        }
        
        // 检查是否已在播放列表中
        const existingIndex = currentPlaylist.findIndex(track => track.path === fullPath);
        if (existingIndex >= 0) {
            return res.json({ success: true, message: '该歌曲已在播放列表中' });
        }
        
        // 获取音乐元数据并添加到播放列表
        const metadata = await getMusicMetadata(fullPath);
        currentPlaylist.push(metadata);
        
        // 按标题字母排序
        currentPlaylist.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
        
        // 更新播放列表缓存
        try {
            fs.writeFileSync(PLAYLIST_CACHE_FILE, JSON.stringify(currentPlaylist, null, 2));
        } catch (error) {
            console.error('更新播放列表缓存失败:', error.message);
        }
        
        console.log(`📋 添加到播放列表：${metadata.title}`);
        res.json({
            success: true,
            message: `已添加 "${metadata.title}" 到播放列表`
        });
        
    } catch (error) {
        console.error('添加失败:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 将文件夹中的所有音乐文件添加到播放列表（递归扫描子文件夹）
app.post('/api/add-folder-to-playlist', async (req, res) => {
    try {
        const { folderPath } = req.body;
        
        if (!folderPath) {
            return res.status(400).json({ success: false, error: '缺少文件夹路径' });
        }
        
        const musicDir = path.join(__dirname, 'music');
        const normalizedPath = folderPath.replace(/\//g, path.sep);
        const fullPath = path.join(musicDir, normalizedPath);
        
        // 安全检查：确保路径在 music 目录下
        if (!fullPath.startsWith(musicDir)) {
            return res.status(400).json({ success: false, error: '无效的路径' });
        }
        
        if (!fs.existsSync(fullPath)) {
            return res.status(404).json({ success: false, error: '文件夹不存在' });
        }
        
        const stat = fs.statSync(fullPath);
        if (!stat.isDirectory()) {
            return res.status(400).json({ success: false, error: '路径不是文件夹' });
        }
        
        // 递归获取文件夹中的所有音乐文件
        const musicExtensions = ['.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac', '.wma'];
        const musicFiles = [];
        
        async function collectMusicFiles(dirPath) {
            const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                const entryPath = path.join(dirPath, entry.name);
                if (entry.isDirectory()) {
                    await collectMusicFiles(entryPath);
                } else if (entry.isFile() && musicExtensions.includes(path.extname(entry.name).toLowerCase())) {
                    musicFiles.push(entryPath);
                }
            }
        }
        
        await collectMusicFiles(fullPath);
        
        if (musicFiles.length === 0) {
            return res.json({ success: true, message: '文件夹中没有音乐文件' });
        }
        
        let addedCount = 0;
        let skippedCount = 0;
        
        // 添加每个音乐文件到播放列表
        for (const filePath of musicFiles) {
            // 检查是否已在播放列表中
            const existingIndex = currentPlaylist.findIndex(track => track.path === filePath);
            if (existingIndex >= 0) {
                skippedCount++;
                continue;
            }
            
            try {
                const metadata = await getMusicMetadata(filePath);
                currentPlaylist.push(metadata);
                addedCount++;
            } catch (error) {
                console.error(`添加文件失败: ${filePath}`, error.message);
            }
        }
        
        // 按标题字母排序
        currentPlaylist.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
        
        // 更新播放列表缓存
        try {
            fs.writeFileSync(PLAYLIST_CACHE_FILE, JSON.stringify(currentPlaylist, null, 2));
        } catch (error) {
            console.error('更新播放列表缓存失败:', error.message);
        }
        
        console.log(`📋 添加文件夹到播放列表：${folderPath}，添加 ${addedCount} 首，跳过 ${skippedCount} 首`);
        res.json({
            success: true,
            message: `已将文件夹中的 ${addedCount} 首歌曲添加到播放列表${skippedCount > 0 ? `，跳过 ${skippedCount} 首已存在的歌曲` : ''}`
        });
        
    } catch (error) {
        console.error('添加文件夹失败:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 共享的文件下载函数
function sendFileDownload(res, filePath) {
    try {
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ success: false, error: '文件不存在' });
        }
        
        const fileName = path.basename(filePath);
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
        res.setHeader('Content-Type', 'audio/mpeg');
        
        const fileStream = fs.createReadStream(filePath);
        fileStream.pipe(res);
        
        console.log(`📥 文件下载：${filePath}`);
        
    } catch (error) {
        console.error('下载失败:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
}

// 在线音乐下载函数
async function downloadOnlineMusic(res, playUrl, title, artist) {
    try {
        // 构建文件名（清理非法字符）
        const safeArtist = artist ? sanitizeFileName(artist) : '';
        const safeTitle = sanitizeFileName(title);
        const artistName = safeArtist ? `${safeArtist} - ` : '';
        const fileName = `${artistName}${safeTitle}.mp3`;
        
        // 设置响应头
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
        res.setHeader('Content-Type', 'audio/mpeg');
        
        // 发起请求获取在线音乐数据
        const response = await fetch(playUrl);
        
        if (!response.ok) {
            throw new Error(`获取在线音乐失败: ${response.status}`);
        }
        
        // 将响应流直接管道到客户端
        const stream = response.body;
        if (stream) {
            const reader = stream.getReader();
            const pump = async () => {
                const { done, value } = await reader.read();
                if (done) {
                    console.log(`📥 在线音乐下载完成：${fileName}`);
                    return;
                }
                res.write(value);
                return pump();
            };
            await pump();
            res.end();
        } else {
            throw new Error('无法获取音乐流');
        }
        
    } catch (error) {
        console.error('在线音乐下载失败:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
}

// 通过路径下载文件 API
app.get('/api/download', (req, res) => {
    const filePath = decodeURIComponent(req.query.path);
    
    // 安全检查：确保路径在允许的目录内
    if (!filePath.startsWith(MUSIC_DIR)) {
        return res.status(403).json({ success: false, error: '访问被拒绝' });
    }
    
    sendFileDownload(res, filePath);
});

// 下载文件夹（打包为ZIP）
app.get('/api/download-folder', (req, res) => {
    try {
        const folderPath = decodeURIComponent(req.query.path);
        
        const musicDir = path.join(__dirname, 'music');
        const normalizedPath = folderPath.replace(/\//g, path.sep);
        const fullPath = path.join(musicDir, normalizedPath);
        
        // 安全检查
        if (!fullPath.startsWith(musicDir)) {
            return res.status(403).json({ success: false, error: '访问被拒绝' });
        }
        
        if (!fs.existsSync(fullPath)) {
            return res.status(404).json({ success: false, error: '文件夹不存在' });
        }
        
        const stat = fs.statSync(fullPath);
        if (!stat.isDirectory()) {
            return res.status(400).json({ success: false, error: '路径不是文件夹' });
        }
        
        const folderName = path.basename(fullPath);
        
        // 递归收集所有文件
        const musicExtensions = ['.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac', '.wma'];
        const files = [];
        
        function collectFiles(dirPath, relativePath) {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                const entryPath = path.join(dirPath, entry.name);
                const entryRelative = relativePath ? path.join(relativePath, entry.name) : entry.name;
                if (entry.isDirectory()) {
                    collectFiles(entryPath, entryRelative);
                } else if (entry.isFile()) {
                    files.push({ fullPath: entryPath, relativePath: entryRelative });
                }
            }
        }
        
        collectFiles(fullPath, '');
        
        if (files.length === 0) {
            return res.status(404).json({ success: false, error: '文件夹中没有文件' });
        }
        
        // 使用 adm-zip 打包
        const zip = new AdmZip();
        
        for (const file of files) {
            const fileContent = fs.readFileSync(file.fullPath);
            zip.addFile(file.relativePath.replace(/\\/g, '/'), fileContent);
        }
        
        const zipBuffer = zip.toBuffer();
        
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(folderName)}.zip"`);
        res.setHeader('Content-Length', zipBuffer.length);
        res.send(zipBuffer);
        
        console.log(`📦 下载文件夹: ${folderName} (${files.length} 个文件)`);
        
    } catch (error) {
        console.error('下载文件夹失败:', error);
        res.status(500).json({ success: false, error: '下载失败: ' + error.message });
    }
});

// 批量加入播放列表 API
app.post('/api/batch-add-to-playlist', async (req, res) => {
    try {
        const { files, clear = false } = req.body;
        
        if (!Array.isArray(files) || files.length === 0) {
            return res.status(400).json({ success: false, error: '请选择要添加的文件' });
        }
        
        if (clear) {
            currentPlaylist = [];
        }
        
        let addedCount = 0;
        
        for (const filePath of files) {
            // 安全检查
            if (!filePath.startsWith(MUSIC_DIR)) {
                continue;
            }
            
            if (!fs.existsSync(filePath)) {
                continue;
            }
            
            const existingIndex = currentPlaylist.findIndex(track => track.path === filePath);
            if (existingIndex === -1) {
                const metadata = await getMusicMetadata(filePath);
                if (metadata) {
                    currentPlaylist.push(metadata);
                    addedCount++;
                }
            }
        }
        
        // 按标题字母排序
        currentPlaylist.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
        
        fs.writeFileSync(PLAYLIST_CACHE_FILE, JSON.stringify(currentPlaylist, null, 2));
        res.json({ success: true, addedCount, message: `成功添加 ${addedCount} 首歌曲到播放列表` });
        
    } catch (error) {
        console.error('批量添加失败:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 批量删除文件 API
// 新建文件夹
app.post('/api/create-folder', requireAuth, (req, res) => {
    try {
        const { parentPath, folderName } = req.body;
        
        if (!folderName || folderName.trim() === '') {
            return res.status(400).json({ success: false, error: '请输入文件夹名称' });
        }
        
        // 处理父路径
        let fullParentPath = parentPath;
        if (parentPath.startsWith('/music')) {
            const relativePath = parentPath.substring('/music'.length).replace(/^\//, '').replace(/\\/g, path.sep);
            fullParentPath = relativePath ? path.join(MUSIC_DIR, relativePath) : MUSIC_DIR;
        } else if (!parentPath.startsWith(MUSIC_DIR)) {
            return res.status(400).json({ success: false, error: '父路径无效' });
        }
        
        // 确保父文件夹存在
        if (!fs.existsSync(fullParentPath)) {
            return res.status(400).json({ success: false, error: '父文件夹不存在' });
        }
        
        // 创建完整路径
        const newFolderPath = path.join(fullParentPath, folderName.trim());
        
        // 检查文件夹是否已存在
        if (fs.existsSync(newFolderPath)) {
            return res.status(400).json({ success: false, error: '文件夹已存在' });
        }
        
        // 创建文件夹
        fs.mkdirSync(newFolderPath);
        console.log(`📁 创建文件夹: ${newFolderPath}`);
        
        // 更新缓存文件（而不是删除）
        if (fs.existsSync(FOLDER_CACHE_FILE)) {
            try {
                const cacheContent = fs.readFileSync(FOLDER_CACHE_FILE, 'utf8');
                const cacheData = JSON.parse(cacheContent);
                
                // 计算新文件夹的相对路径
                const relativeParentPath = fullParentPath.substring(MUSIC_DIR.length).replace(/^[\\/]/, '').replace(/\\/g, '/');
                const newFolderRelativePath = relativeParentPath ? `${relativeParentPath}/${folderName.trim()}` : folderName.trim();
                
                // 添加新文件夹到缓存
                const newFolderEntry = {
                    name: folderName.trim(),
                    path: newFolderRelativePath,
                    fullPath: newFolderPath,
                    musicCount: 0,
                    hasSubFolders: false,
                    folders: [],
                    files: []
                };
                
                if (relativeParentPath === '') {
                    // 根目录，直接添加
                    if (!cacheData.folders) cacheData.folders = [];
                    cacheData.folders.push(newFolderEntry);
                    cacheData.folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
                    cacheData.totalFolders = (cacheData.totalFolders || 0) + 1;
                } else {
                    // 在子文件夹中找到目标并添加
                    const targetFolder = findFolderInCacheRecursive(cacheData.folders, relativeParentPath);
                    if (targetFolder) {
                        if (!targetFolder.folders) targetFolder.folders = [];
                        targetFolder.folders.push(newFolderEntry);
                        targetFolder.folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
                        cacheData.totalFolders = (cacheData.totalFolders || 0) + 1;
                    }
                }
                
                cacheData.timestamp = Date.now();
                fs.writeFileSync(FOLDER_CACHE_FILE, JSON.stringify(cacheData, null, 2));
                console.log('✅ 已更新文件夹缓存');
            } catch (e) {
                console.error('更新缓存失败:', e);
            }
        }
        
        res.json({ success: true, message: `成功创建文件夹 "${folderName}"` });
        
    } catch (error) {
        console.error('创建文件夹失败:', error);
        res.status(500).json({ success: false, error: '创建文件夹失败: ' + error.message });
    }
});

// 辅助函数：从缓存数据中删除文件
function removeFileFromCacheData(cacheData, filePath) {
    if (!cacheData) return false;
    
    // 在根目录文件中查找
    if (cacheData.files) {
        const fileIndex = cacheData.files.findIndex(f => f.path === filePath);
        if (fileIndex !== -1) {
            cacheData.files.splice(fileIndex, 1);
            cacheData.totalFiles = (cacheData.totalFiles || 0) - 1;
            if (cacheData.totalFiles < 0) cacheData.totalFiles = 0;
            return true;
        }
    }
    
    // 在子文件夹中查找
    return removeFileFromFolderCache(cacheData.folders, filePath);
}

function removeFileFromFolderCache(folders, filePath) {
    if (!folders) return false;
    
    for (const folder of folders) {
        if (folder.files) {
            const fileIndex = folder.files.findIndex(f => f.path === filePath);
            if (fileIndex !== -1) {
                folder.files.splice(fileIndex, 1);
                folder.musicCount = (folder.musicCount || 0) - 1;
                if (folder.musicCount < 0) folder.musicCount = 0;
                return true;
            }
        }
        if (folder.folders && folder.folders.length > 0) {
            if (removeFileFromFolderCache(folder.folders, filePath)) {
                folder.musicCount = (folder.musicCount || 0) - 1;
                if (folder.musicCount < 0) folder.musicCount = 0;
                return true;
            }
        }
    }
    return false;
}

// 辅助函数：更新缓存中的文件路径
function updateFilePathInCache(cacheData, oldPath, newPath, newTitle) {
    if (!cacheData) return false;
    
    // 在根目录文件中查找
    if (cacheData.files) {
        const file = cacheData.files.find(f => f.path === oldPath);
        if (file) {
            file.path = newPath;
            file.title = newTitle;
            return true;
        }
    }
    
    // 在子文件夹中查找
    return updateFileInFolderCache(cacheData.folders, oldPath, newPath, newTitle);
}

function updateFileInFolderCache(folders, oldPath, newPath, newTitle) {
    if (!folders) return false;
    
    for (const folder of folders) {
        if (folder.files) {
            const file = folder.files.find(f => f.path === oldPath);
            if (file) {
                file.path = newPath;
                file.title = newTitle;
                return true;
            }
        }
        if (folder.folders && folder.folders.length > 0) {
            if (updateFileInFolderCache(folder.folders, oldPath, newPath, newTitle)) {
                return true;
            }
        }
    }
    return false;
}

// 辅助函数：更新缓存中的文件夹名称和路径
function updateFolderNameInCache(folders, oldPath, newPath, newName) {
    if (!folders) return false;
    
    for (const folder of folders) {
        if (folder.path === oldPath) {
            folder.name = newName;
            folder.path = newPath;
            // 更新子文件夹的路径
            updateSubfolderPaths(folder.folders, oldPath, newPath);
            return true;
        }
        if (folder.folders && folder.folders.length > 0) {
            if (updateFolderNameInCache(folder.folders, oldPath, newPath, newName)) {
                return true;
            }
        }
    }
    return false;
}

function updateSubfolderPaths(folders, oldParentPath, newParentPath) {
    if (!folders) return;
    
    folders.forEach(folder => {
        const relativeName = folder.path.substring(oldParentPath.length + 1);
        folder.path = newParentPath + '/' + relativeName;
        if (folder.folders && folder.folders.length > 0) {
            updateSubfolderPaths(folder.folders, oldParentPath, newParentPath);
        }
    });
}

// 辅助函数：在缓存中查找并删除文件夹
function findAndRemoveFolderFromCache(folders, targetPath) {
    if (!folders) return null;
    for (let i = 0; i < folders.length; i++) {
        if (folders[i].path === targetPath) {
            const removed = folders.splice(i, 1)[0];
            return removed;
        }
        if (folders[i].folders && folders[i].folders.length > 0) {
            const removed = findAndRemoveFolderFromCache(folders[i].folders, targetPath);
            if (removed) {
                // 更新父文件夹的音乐计数
                folders[i].musicCount = (folders[i].musicCount || 0) - (removed.musicCount || 0);
                if (folders[i].musicCount < 0) folders[i].musicCount = 0;
                return removed;
            }
        }
    }
    return null;
}

// 辅助函数：在缓存中递归查找文件夹
function findFolderInCacheRecursive(folders, targetPath) {
    if (!folders) return null;
    for (const folder of folders) {
        if (folder.path === targetPath) return folder;
        if (folder.folders && folder.folders.length > 0) {
            const found = findFolderInCacheRecursive(folder.folders, targetPath);
            if (found) return found;
        }
    }
    return null;
}

// 辅助函数：发起 HTTP/HTTPS 请求
function httpGet(url, timeout = 15000) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        const options = {
            timeout,
            headers: {
                'User-Agent': 'NASMusicPlayer/1.0 ( https://github.com/RONGLINC93/nas-local-music-player )',
                'Accept': 'application/json'
            }
        };
        client.get(url, options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error('解析响应失败'));
                }
            });
        }).on('error', reject);
    });
}

// 清理文件名（去除扩展名、特殊字符等）
function cleanFileName(fileName) {
    return fileName
        .replace(/\.(mp3|flac|wav|m4a|ogg|wma|ape|aac)$/i, '')
        .replace(/[\[\(【（].*?[\]\)】）]/g, '')  // 去除括号内容
        .replace(/[^\w\s\u4e00-\u9fff\-–—·]/g, '')  // 保留中文、字母、数字、连字符
        .replace(/\s+/g, ' ')
        .trim();
}

// 从 MusicBrainz 刮削单个文件的元数据
async function scrapeFileMetadata(filePath) {
    const rawName = path.basename(filePath, path.extname(filePath));
    const fileName = cleanFileName(rawName);
    
    console.log(` 刮削文件: ${rawName}`);
    console.log(`   清理后: ${fileName}`);
    
    const searchStrategies = [];
    
    // 策略1: 尝试从文件名解析艺术家-标题
    const dashMatch = fileName.match(/^(.+?)\s*[-–—]\s*(.+)$/);
    if (dashMatch) {
        const artist = dashMatch[1].trim();
        const title = dashMatch[2].trim();
        searchStrategies.push({
            name: 'artist+title',
            url: `https://musicbrainz.org/ws/2/recording?query=artist:"${encodeURIComponent(artist)}" AND recording:"${encodeURIComponent(title)}"&fmt=json&limit=5`
        });
    }
    
    // 策略2: 仅搜索标题
    searchStrategies.push({
        name: 'title only',
        url: `https://musicbrainz.org/ws/2/recording?query=recording:"${encodeURIComponent(fileName)}"&fmt=json&limit=10`
    });
    
    // 策略3: 搜索标题（宽松匹配）
    const keywords = fileName.split(/[\s\-–—]+/).filter(k => k.length > 1);
    if (keywords.length > 1) {
        searchStrategies.push({
            name: 'keywords',
            url: `https://musicbrainz.org/ws/2/recording?query=${keywords.map(k => `recording:"${encodeURIComponent(k)}"`).join(' AND ')}&fmt=json&limit=10`
        });
    }
    
    for (const strategy of searchStrategies) {
        console.log(`   尝试策略: ${strategy.name}`);
        
        try {
            const result = await httpGet(strategy.url);
            
            if (result.recordings && result.recordings.length > 0) {
                console.log(`   ✅ 找到 ${result.recordings.length} 条记录`);
                
                // 选择最佳匹配
                let bestMatch = result.recordings[0];
                
                // 如果有多个结果，尝试找更精确的匹配
                if (result.recordings.length > 1) {
                    for (const rec of result.recordings) {
                        // 优先选择有 release 信息的
                        if (rec.releases && rec.releases.length > 0 && (!bestMatch.releases || bestMatch.releases.length === 0)) {
                            bestMatch = rec;
                            break;
                        }
                    }
                }
                
                const metadata = {
                    title: bestMatch.title || '',
                    artist: bestMatch['artist-credit'] && bestMatch['artist-credit'].length > 0 
                        ? bestMatch['artist-credit'].map(ac => ac.name).join(', ') 
                        : '',
                    album: '',
                    year: '',
                    genre: ''
                };
                
                // 如果有 release 信息
                if (bestMatch.releases && bestMatch.releases.length > 0) {
                    const release = bestMatch.releases[0];
                    metadata.album = release.title || '';
                    if (release.date) {
                        metadata.year = release.date.substring(0, 4);
                    }
                    // 尝试获取流派
                    if (release['release-group'] && release['release-group'].tags) {
                        const tags = release['release-group'].tags
                            .filter(t => t.count > 0)
                            .map(t => t.name)
                            .slice(0, 3);
                        if (tags.length > 0) {
                            metadata.genre = tags.join(', ');
                        }
                    }
                }
                
                console.log(`   结果: ${metadata.title} - ${metadata.artist} (${metadata.album})`);
                return { success: true, metadata };
            } else {
                console.log(`   ❌ 无结果`);
            }
        } catch (error) {
            console.log(`   ⚠️ 请求失败: ${error.message}`);
        }
    }
    
    return { success: false, error: '未找到匹配的记录' };
}

// 自动刮削元数据
let isScraping = false;

app.post('/api/scrape-metadata', requireAuth, async (req, res) => {
    try {
        const { path: filePath } = req.body;
        
        if (!filePath || !fs.existsSync(filePath)) {
            return res.status(400).json({ success: false, error: '文件不存在' });
        }
        
        const result = await scrapeFileMetadata(filePath);
        
        if (result.success) {
            // 自动写入元数据
            const { title, artist, album, year, genre } = result.metadata;
            
            const data = {};
            if (title) data.title = title;
            if (artist) data.artist = artist;
            if (album) data.album = album;
            if (year) data.date = year;
            if (genre) data.genre = genre;
            
            await new Promise((resolve, reject) => {
                ffmetadata.write(filePath, data, { 'id3v2.3': true }, (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
            
            console.log(`✅ 刮削成功: ${path.basename(filePath)}`);
            console.log('  元数据:', result.metadata);
            
            res.json({ success: true, metadata: result.metadata });
        } else {
            res.json({ success: false, error: result.error });
        }
    } catch (error) {
        console.error('刮削失败:', error);
        res.status(500).json({ success: false, error: '刮削失败: ' + error.message });
    }
});

// 批量刮削文件夹中的所有音乐文件
app.post('/api/scrape-folder', requireAuth, async (req, res) => {
    if (isScraping) {
        return res.status(400).json({ success: false, error: '刮削任务正在进行中' });
    }
    
    const { folderPath } = req.body;
    
    if (!folderPath || !fs.existsSync(folderPath)) {
        return res.status(400).json({ success: false, error: '文件夹不存在' });
    }
    
    isScraping = true;
    
    try {
        // 获取文件夹中所有音乐文件
        const files = fs.readdirSync(folderPath)
            .filter(f => /\.(mp3|flac|wav|m4a|ogg|wma)$/i.test(f))
            .map(f => path.join(folderPath, f));
        
        if (files.length === 0) {
            isScraping = false;
            return res.json({ success: true, total: 0, successCount: 0, failCount: 0, results: [] });
        }
        
        const results = [];
        let successCount = 0;
        let failCount = 0;
        
        for (const file of files) {
            try {
                const result = await scrapeFileMetadata(file);
                
                if (result.success) {
                    const { title, artist, album, year, genre } = result.metadata;
                    const data = {};
                    if (title) data.title = title;
                    if (artist) data.artist = artist;
                    if (album) data.album = album;
                    if (year) data.date = year;
                    if (genre) data.genre = genre;
                    
                    await new Promise((resolve, reject) => {
                        ffmetadata.write(file, data, { 'id3v2.3': true }, (err) => {
                            if (err) reject(err);
                            else resolve();
                        });
                    });
                    
                    successCount++;
                    results.push({ file: path.basename(file), success: true, metadata: result.metadata });
                    console.log(`✅ 刮削成功: ${path.basename(file)}`);
                } else {
                    failCount++;
                    results.push({ file: path.basename(file), success: false, error: result.error });
                    console.log(`❌ 刮削失败: ${path.basename(file)} - ${result.error}`);
                }
                
                // 避免请求过快被 MusicBrainz 限流
                await new Promise(resolve => setTimeout(resolve, 1200));
            } catch (error) {
                failCount++;
                results.push({ file: path.basename(file), success: false, error: error.message });
                console.error(`❌ 刮削异常: ${path.basename(file)} - ${error.message}`);
            }
        }
        
        isScraping = false;
        
        res.json({
            success: true,
            total: files.length,
            successCount,
            failCount,
            results
        });
    } catch (error) {
        isScraping = false;
        console.error('批量刮削失败:', error);
        res.status(500).json({ success: false, error: '批量刮削失败: ' + error.message });
    }
});

// 一键整理音乐文件
app.post('/api/organize', requireAuth, async (req, res) => {
    try {
        const { type } = req.body;
        
        if (!type || !['artist', 'album', 'year', 'genre', 'flat'].includes(type)) {
            return res.status(400).json({ success: false, error: '无效的整理类型' });
        }
        
        // 扫描所有音乐文件
        const musicFiles = [];
        const scanDir = (dir) => {
            if (!fs.existsSync(dir)) return;
            const items = fs.readdirSync(dir);
            for (const item of items) {
                const fullPath = path.join(dir, item);
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) {
                    scanDir(fullPath);
                } else if (MUSIC_EXTENSIONS.includes(path.extname(item).toLowerCase())) {
                    musicFiles.push(fullPath);
                }
            }
        };
        
        scanDir(MUSIC_DIR);
        
        if (musicFiles.length === 0) {
            return res.json({ success: true, organizedCount: 0, message: '没有找到音乐文件' });
        }
        
        let organizedCount = 0;
        const typeLabels = {
            artist: '艺术家',
            album: '专辑',
            year: '年份',
            genre: '流派',
            flat: '主目录'
        };
        
        console.log(`🎵 开始整理 ${musicFiles.length} 个音乐文件，按${typeLabels[type]}分类`);
        
        for (const filePath of musicFiles) {
            try {
                const fileName = path.basename(filePath);
                let targetPath;
                
                if (type === 'flat') {
                    // 移到主目录，不创建子文件夹
                    targetPath = path.join(MUSIC_DIR, fileName);
                } else {
                    const metadata = await mm.parseFile(filePath);
                    const { common } = metadata;
                    let folderName = '未知分类';
                    
                    switch (type) {
                        case 'artist':
                            if (common.artists && common.artists.length > 0 && common.artists[0].trim()) {
                                folderName = common.artists[0].trim().replace(/[\/\\:*?"<>|]/g, '_');
                            } else if (common.artist && common.artist.trim()) {
                                folderName = common.artist.trim().replace(/[\/\\:*?"<>|]/g, '_');
                            } else {
                                folderName = '未知艺术家';
                            }
                            break;
                        case 'album':
                            if (common.album && common.album.trim()) {
                                folderName = common.album.trim().replace(/[\/\\:*?"<>|]/g, '_');
                            } else {
                                folderName = '未知专辑';
                            }
                            break;
                        case 'year':
                            if (common.date) {
                                const yearStr = String(common.date).substring(0, 4);
                                if (yearStr && /^\d{4}$/.test(yearStr)) {
                                    folderName = yearStr;
                                } else {
                                    folderName = '未知年份';
                                }
                            } else {
                                folderName = '未知年份';
                            }
                            break;
                        case 'genre':
                            if (common.genres && common.genres.length > 0 && common.genres[0].trim()) {
                                folderName = common.genres[0].trim().replace(/[\/\\:*?"<>|]/g, '_');
                            } else {
                                folderName = '未知流派';
                            }
                            break;
                    }
                    
                    const targetDir = path.join(MUSIC_DIR, folderName);
                    if (!fs.existsSync(targetDir)) {
                        fs.mkdirSync(targetDir, { recursive: true });
                    }
                    
                    targetPath = path.join(targetDir, fileName);
                }
                
                if (filePath !== targetPath) {
                    await fs.promises.copyFile(filePath, targetPath);
                    await fs.promises.unlink(filePath);
                    organizedCount++;
                    if (type === 'flat') {
                        console.log(`  ✓ ${fileName} -> 主目录/`);
                    } else {
                        console.log(`  ✓ ${fileName} -> ${folderName}/`);
                    }
                }
                
                if (type !== 'flat') {
                    mm.closeFile(filePath);
                }
            } catch (err) {
                console.error(`  ✗ 处理文件失败 ${filePath}:`, err.message);
            }
        }
        
        // 清理空文件夹
        const cleanEmptyDirs = (dir) => {
            if (!fs.existsSync(dir)) return;
            const items = fs.readdirSync(dir);
            for (const item of items) {
                const fullPath = path.join(dir, item);
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) {
                    cleanEmptyDirs(fullPath);
                    const remaining = fs.readdirSync(fullPath);
                    if (remaining.length === 0) {
                        fs.rmdirSync(fullPath);
                        console.log(`  🗑️ 删除空文件夹: ${fullPath}`);
                    }
                }
            }
        };
        cleanEmptyDirs(MUSIC_DIR);
        
        // 删除文件夹缓存，下次打开时重新生成
        if (fs.existsSync(FOLDER_CACHE_FILE)) {
            fs.unlinkSync(FOLDER_CACHE_FILE);
        }
        
        console.log(`✅ 整理完成！共整理 ${organizedCount} 个文件`);
        res.json({ success: true, organizedCount, message: `成功整理 ${organizedCount} 个文件` });
        
    } catch (error) {
        console.error('整理音乐文件失败:', error);
        res.status(500).json({ success: false, error: '整理失败: ' + error.message });
    }
});

// 移动文件后更新文件夹缓存
function updateFolderCacheAfterMove(movedFiles, targetFolder) {
    try {
        if (!fs.existsSync(FOLDER_CACHE_FILE)) {
            return; // 没有缓存文件，无需更新
        }
        
        const cacheContent = fs.readFileSync(FOLDER_CACHE_FILE, 'utf8');
        const cacheData = JSON.parse(cacheContent);
        
        for (const filePath of movedFiles) {
            // 获取文件名（用于匹配）
            const fileName = path.basename(filePath);
            
            // 获取原文件所在的目录路径（相对于 MUSIC_DIR）
            let sourceRelativePath = '';
            if (filePath.startsWith(MUSIC_DIR)) {
                sourceRelativePath = filePath.substring(MUSIC_DIR.length);
                // 确保路径以 / 开头
                if (!sourceRelativePath.startsWith('/')) {
                    sourceRelativePath = '/' + sourceRelativePath;
                }
            }
            const sourceDir = path.dirname(sourceRelativePath);
            
            // 获取目标目录路径（相对于 MUSIC_DIR）
            let targetRelativePath = '';
            if (targetFolder.startsWith(MUSIC_DIR)) {
                targetRelativePath = targetFolder.substring(MUSIC_DIR.length);
                if (!targetRelativePath.startsWith('/')) {
                    targetRelativePath = '/' + targetRelativePath;
                }
            }
            
            // 从源目录的文件列表中移除该文件（使用文件名匹配）
            removeFileFromCacheByName(cacheData.folders, sourceDir, fileName);
            
            // 更新源目录的文件计数
            updateFolderMusicCount(cacheData.folders, sourceDir, -1);
            // 更新目标目录的文件计数
            updateFolderMusicCount(cacheData.folders, targetRelativePath, 1);
        }
        
        // 更新时间戳
        cacheData.timestamp = Date.now();
        
        // 保存更新后的缓存
        fs.writeFileSync(FOLDER_CACHE_FILE, JSON.stringify(cacheData, null, 2));
        console.log('📝 文件夹缓存已更新（精细更新）');
        
    } catch (error) {
        console.error('更新文件夹缓存失败:', error);
        // 如果更新失败，回退到删除缓存（会在下一次请求时重新扫描）
        if (fs.existsSync(FOLDER_CACHE_FILE)) {
            fs.unlinkSync(FOLDER_CACHE_FILE);
            console.log('🗑️ 更新缓存失败，删除缓存下次重新扫描');
        }
    }
}

// 从缓存中按文件名移除文件
function removeFileFromCacheByName(folders, dirPath, fileName) {
    if (!folders || folders.length === 0) return;
    
    for (const folder of folders) {
        // 检查当前文件夹是否匹配
        if (folder.path === dirPath) {
            if (folder.files && folder.files.length > 0) {
                folder.files = folder.files.filter(file => {
                    const fileBaseName = path.basename(file.path);
                    return fileBaseName !== fileName;
                });
            }
            return;
        }
        
        // 递归检查子文件夹
        if (folder.folders && folder.folders.length > 0) {
            removeFileFromCacheByName(folder.folders, dirPath, fileName);
        }
    }
}

// 递归更新文件夹的音乐文件计数
function updateFolderMusicCount(folders, dirPath, delta) {
    if (!folders || folders.length === 0) return;
    
    for (const folder of folders) {
        // 检查当前文件夹是否匹配
        if (folder.path === dirPath) {
            folder.musicCount = Math.max(0, (folder.musicCount || 0) + delta);
        }
        
        // 递归检查子文件夹
        if (folder.folders && folder.folders.length > 0) {
            updateFolderMusicCount(folder.folders, dirPath, delta);
        }
    }
}

// 批量移动文件
app.post('/api/batch-move-files', requireAuth, (req, res) => {
    try {
        const { files, targetFolder } = req.body;
        
        console.log('收到移动文件请求:', { files, targetFolder });
        
        if (!Array.isArray(files) || files.length === 0) {
            console.log('错误：文件数组为空或无效');
            return res.status(400).json({ success: false, error: '请选择要移动的文件' });
        }
        
        // 处理目标文件夹路径
        let fullTargetPath = targetFolder;
        // 如果是相对路径（以 /music 开头），转换为完整路径
        if (targetFolder.startsWith('/music')) {
            // 移除 /music 前缀，获取相对路径
            const relativePath = targetFolder.substring('/music'.length);
            fullTargetPath = path.join(MUSIC_DIR, relativePath);
            console.log('路径转换成功:', { original: targetFolder, converted: fullTargetPath });
        } else if (!targetFolder.startsWith(MUSIC_DIR)) {
            console.log('错误：目标文件夹路径无效:', targetFolder);
            return res.status(400).json({ success: false, error: '目标文件夹无效' });
        }
        
        // 确保目标文件夹存在
        if (!fs.existsSync(fullTargetPath)) {
            fs.mkdirSync(fullTargetPath, { recursive: true });
        }
        
        let movedCount = 0;
        
        for (const filePath of files) {
            // 安全检查
            if (!filePath.startsWith(MUSIC_DIR)) {
                continue;
            }
            
            if (!fs.existsSync(filePath)) {
                continue;
            }
            
            const fileName = path.basename(filePath);
            const targetPath = path.join(fullTargetPath, fileName);
            
            // 如果目标文件已存在，生成新文件名
            let finalTargetPath = targetPath;
            let counter = 1;
            while (fs.existsSync(finalTargetPath)) {
                const ext = path.extname(fileName);
                const nameWithoutExt = path.basename(fileName, ext);
                finalTargetPath = path.join(fullTargetPath, `${nameWithoutExt}_${counter}${ext}`);
                counter++;
            }
            
            // 移动文件
            fs.renameSync(filePath, finalTargetPath);
            movedCount++;
            
            // 更新播放列表中的路径
            const index = currentPlaylist.findIndex(track => track.path === filePath);
            if (index !== -1) {
                currentPlaylist[index].path = finalTargetPath;
            }
            
            console.log(`📁 移动文件: ${filePath} -> ${finalTargetPath}`);
        }
        
        // 保存播放列表
        fs.writeFileSync(PLAYLIST_CACHE_FILE, JSON.stringify(currentPlaylist, null, 2));
        
        // 删除文件夹缓存，让下次请求时重新扫描
        updateFolderCacheAfterMove(files, fullTargetPath);
        
        res.json({ 
            success: true, 
            message: `成功移动 ${movedCount} 个文件到目标文件夹` 
        });
        
    } catch (error) {
        console.error('批量移动文件失败:', error);
        res.status(500).json({ success: false, error: '移动文件失败: ' + error.message });
    }
});

app.post('/api/batch-delete-files', requireAuth, (req, res) => {
    try {
        const { files } = req.body;
        
        if (!Array.isArray(files) || files.length === 0) {
            return res.status(400).json({ success: false, error: '请选择要删除的文件' });
        }
        
        let deletedCount = 0;
        let removedFromListCount = 0;
        
        for (const filePath of files) {
            // 安全检查
            if (!filePath.startsWith(MUSIC_DIR)) {
                continue;
            }
            
            // 尝试删除物理文件（如果存在）
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                deletedCount++;
                console.log(`🗑️ 删除物理文件: ${filePath}`);
            }
            
            // 从播放列表中移除（无论文件是否存在）
            const index = currentPlaylist.findIndex(track => track.path === filePath);
            if (index !== -1) {
                currentPlaylist.splice(index, 1);
                removedFromListCount++;
            }
        }
        
        fs.writeFileSync(PLAYLIST_CACHE_FILE, JSON.stringify(currentPlaylist, null, 2));
        
        // 更新缓存文件（而不是删除）
        if (fs.existsSync(FOLDER_CACHE_FILE)) {
            try {
                const cacheContent = fs.readFileSync(FOLDER_CACHE_FILE, 'utf8');
                const cacheData = JSON.parse(cacheContent);
                
                for (const filePath of files) {
                    removeFileFromCacheData(cacheData, filePath);
                }
                
                cacheData.timestamp = Date.now();
                fs.writeFileSync(FOLDER_CACHE_FILE, JSON.stringify(cacheData, null, 2));
                console.log('✅ 已更新文件夹缓存');
            } catch (e) {
                console.error('更新缓存失败:', e);
            }
        }
        
        let message = '';
        if (deletedCount > 0 && removedFromListCount > 0) {
            message = `成功删除 ${deletedCount} 个文件，从列表移除 ${removedFromListCount} 个条目`;
        } else if (deletedCount > 0) {
            message = `成功删除 ${deletedCount} 个文件`;
        } else if (removedFromListCount > 0) {
            message = `从列表中移除 ${removedFromListCount} 个不存在的文件`;
        }
        
        res.json({ success: true, message });
        
    } catch (error) {
        console.error('批量删除失败:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 批量下载文件 API（打包为 ZIP）
app.post('/api/batch-download', async (req, res) => {
    try {
        const { files } = req.body;
        
        if (!Array.isArray(files) || files.length === 0) {
            return res.status(400).json({ success: false, error: '请选择要下载的文件' });
        }
        
        const batchId = Date.now().toString(36) + Math.random().toString(36).substr(2);
        
        const batchTask = {
            id: batchId,
            total: files.length,
            processed: 0,
            currentFile: '',
            status: 'processing',
            zipPath: null,
            zipFileName: `music_batch_${batchId}.zip`,
            error: null,
            createdAt: Date.now()
        };
        
        batchDownloads.set(batchId, batchTask);
        
        res.json({
            success: true,
            batchId: batchId,
            total: files.length,
            message: '已开始打包'
        });
        
        setTimeout(() => {
            processBatchDownload(batchId, files);
        }, 50);
        
    } catch (error) {
        console.error('批量下载失败:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

async function processBatchDownload(batchId, files) {
    const task = batchDownloads.get(batchId);
    if (!task) return;
    
    try {
        const zip = new AdmZip();
        let addedCount = 0;
        
        for (let i = 0; i < files.length; i++) {
            const item = files[i];
            try {
                if (typeof item === 'string') {
                    const filePath = item;
                    if (!filePath.startsWith(MUSIC_DIR)) {
                        task.processed++;
                        continue;
                    }
                    
                    task.currentFile = path.basename(filePath);
                    
                    if (fs.existsSync(filePath)) {
                        const fileName = path.basename(filePath);
                        const fileContent = fs.readFileSync(filePath);
                        zip.addFile(fileName, fileContent);
                        addedCount++;
                    }
                } else if (item && item.type === 'online') {
                    const { source, songId, name, singer, albumName, songInfo } = item;
                    
                    const fullSongInfo = songInfo || { 
                        songId: songId, 
                        name: name, 
                        singer: singer, 
                        albumName: albumName 
                    };
                    
                    const safeSinger = singer ? sanitizeFileName(singer) : '';
                    const safeName = sanitizeFileName(name);
                    const artistName = safeSinger ? `${safeSinger} - ` : '';
                    const fileName = `${artistName}${safeName}.mp3`;
                    
                    task.currentFile = fileName;
                    
                    let playUrl = await getMusicPlayUrl(source, fullSongInfo, '128');
                    
                    if (!playUrl) {
                        console.log(`批量下载：当前平台 ${source} 无法获取播放链接，尝试其他平台...`);
                        
                        const platforms = ['kw', 'kg', 'tx', 'wy', 'mg'];
                        const currentIndexInPlatforms = platforms.indexOf(source);
                        const otherPlatforms = currentIndexInPlatforms >= 0 
                            ? platforms.filter((_, idx) => idx !== currentIndexInPlatforms)
                            : platforms;
                        
                        for (const platform of otherPlatforms) {
                            try {
                                playUrl = await getMusicPlayUrl(platform, fullSongInfo, '128');
                                if (playUrl) break;
                            } catch (e) {
                                // 继续尝试下一个平台
                            }
                        }
                    }
                    
                    if (playUrl) {
                        const response = await fetch(playUrl);
                        if (response.ok) {
                            const arrayBuffer = await response.arrayBuffer();
                            const buffer = Buffer.from(arrayBuffer);
                            zip.addFile(fileName, buffer);
                            addedCount++;
                        }
                    }
                }
            } catch (e) {
                console.error('批量下载处理文件失败:', e.message);
            }
            
            task.processed = i + 1;
            
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        
        if (addedCount === 0) {
            task.status = 'failed';
            task.error = '没有可下载的文件';
            return;
        }
        
        task.currentFile = '正在生成 ZIP 文件...';
        
        const zipBuffer = zip.toBuffer();
        const tempDir = path.join(__dirname, 'data', 'temp');
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
        
        const zipPath = path.join(tempDir, task.zipFileName);
        fs.writeFileSync(zipPath, zipBuffer);
        
        task.zipPath = zipPath;
        task.status = 'completed';
        task.currentFile = '打包完成';
        
        setTimeout(() => {
            if (batchDownloads.has(batchId)) {
                const t = batchDownloads.get(batchId);
                if (t.zipPath && fs.existsSync(t.zipPath)) {
                    fs.unlinkSync(t.zipPath);
                }
                batchDownloads.delete(batchId);
            }
        }, 30 * 60 * 1000);
        
    } catch (error) {
        console.error('批量下载打包失败:', error.message);
        task.status = 'failed';
        task.error = error.message;
    }
}

app.get('/api/batch-download/:batchId/progress', (req, res) => {
    const { batchId } = req.params;
    const task = batchDownloads.get(batchId);
    
    if (!task) {
        return res.status(404).json({ success: false, error: '任务不存在或已过期' });
    }
    
    res.json({
        success: true,
        id: task.id,
        total: task.total,
        processed: task.processed,
        progress: task.total > 0 ? Math.round((task.processed / task.total) * 100) : 0,
        currentFile: task.currentFile,
        status: task.status,
        error: task.error
    });
});

app.get('/api/batch-download/:batchId/download', (req, res) => {
    const { batchId } = req.params;
    const task = batchDownloads.get(batchId);
    
    if (!task) {
        return res.status(404).json({ success: false, error: '任务不存在或已过期' });
    }
    
    if (task.status !== 'completed' || !task.zipPath) {
        return res.status(400).json({ success: false, error: '打包尚未完成' });
    }
    
    if (!fs.existsSync(task.zipPath)) {
        return res.status(404).json({ success: false, error: '文件已过期或不存在' });
    }
    
    res.download(task.zipPath, task.zipFileName, (err) => {
        if (err) {
            console.error('批量下载文件发送失败:', err.message);
        }
    });
});

// 在线音乐下载 API
app.post('/api/download-online', async (req, res) => {
    try {
        const { source, songId, name, singer, albumName, songInfo } = req.body;
        
        // 使用完整的歌曲信息
        const fullSongInfo = songInfo || { 
            songId: songId, 
            name: name, 
            singer: singer, 
            albumName: albumName 
        };
        
        // 获取播放链接
        let playUrl = await getMusicPlayUrl(source, fullSongInfo, '128');
        
        // 如果当前平台无法获取播放链接，尝试其他平台
        if (!playUrl) {
            console.log(`当前平台 ${source} 无法获取播放链接，尝试其他平台...`);
            
            const platforms = ['kw', 'kg', 'tx', 'wy', 'mg'];
            const currentIndexInPlatforms = platforms.indexOf(source);
            const otherPlatforms = currentIndexInPlatforms >= 0 
                ? platforms.filter((_, i) => i !== currentIndexInPlatforms)
                : platforms;
            
            for (const platform of otherPlatforms) {
                try {
                    const platformName = ONLINE_SOURCES.find(s => s.id === platform)?.name || platform;
                    console.log(`尝试从 ${platformName} 获取播放链接...`);
                    
                    playUrl = await getMusicPlayUrl(platform, fullSongInfo, '128');
                    
                    if (playUrl) {
                        console.log(`成功从 ${platformName} 获取播放链接`);
                        break;
                    }
                } catch (e) {
                    console.log(`尝试 ${platform} 失败:`, e.message);
                }
            }
        }
        
        if (!playUrl) {
            return res.status(500).json({ success: false, error: '无法获取播放链接（版权限制或需要付费）' });
        }
        
        // 下载在线音乐
        downloadOnlineMusic(res, playUrl, name, singer);
        
    } catch (error) {
        console.error('在线音乐下载失败:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 在线音乐下载到服务端 API
app.post('/api/download-online-to-server', requireAuth, async (req, res) => {
    try {
        const { source, songId, name, singer, albumName, songInfo, folderPath } = req.body;
        
        const fullSongInfo = songInfo || { 
            songId: songId, 
            name: name, 
            singer: singer, 
            albumName: albumName 
        };
        
        const taskId = Date.now().toString(36) + Math.random().toString(36).substr(2) + Math.random().toString(36).substr(2);
        taskOrderCounter++;
        
        const safeSinger = singer ? sanitizeFileName(singer) : '';
        const safeName = sanitizeFileName(name);
        const artistName = safeSinger ? `${safeSinger} - ` : '';
        const fileName = `${artistName}${safeName}.mp3`;
        
        let targetFolder = folderPath || '在线下载';
        targetFolder = targetFolder.replace(/^\/music\/?/, '').replace(/^music\/?/, '');
        targetFolder = targetFolder.replace(/^[\/\\]/, '');
        
        const task = {
            id: taskId,
            orderIndex: taskOrderCounter,
            type: 'download',
            source: source,
            songId: songId,
            songInfo: fullSongInfo,
            name: name,
            singer: singer,
            fileName: fileName,
            folderPath: targetFolder,
            status: 'queued',
            progress: 0,
            message: '等待下载',
            startTime: Date.now()
        };
        
        downloadQueue.push(task);
        completedDownloads.push(task);
        
        console.log(`⬇️ 添加下载任务到队列：${fileName}`);
        
        for (let i = 0; i < maxDownloadWorkers; i++) {
            processDownloadQueue();
        }
        
        saveTaskData();
        
        res.json({
            success: true,
            taskId,
            message: '已添加到下载队列',
            fileName: fileName
        });
        
    } catch (error) {
        console.error('添加下载任务失败:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 批量在线音乐下载到服务端 API
app.post('/api/batch-download-to-server', requireAuth, async (req, res) => {
    try {
        const { songs, folderPath } = req.body;
        
        if (!Array.isArray(songs) || songs.length === 0) {
            return res.status(400).json({ success: false, error: '请选择要下载的歌曲' });
        }
        
        let targetFolder = folderPath || '在线下载';
        targetFolder = targetFolder.replace(/^\/music\/?/, '').replace(/^music\/?/, '');
        targetFolder = targetFolder.replace(/^[\/\\]/, '');
        
        let addedCount = 0;
        
        for (const song of songs) {
            try {
                const { source, songId, name, singer, albumName, songInfo } = song;
                
                if (!source || !songId || !name) continue;
                
                const fullSongInfo = songInfo || { 
                    songId: songId, 
                    name: name, 
                    singer: singer, 
                    albumName: albumName 
                };
                
                const taskId = Date.now().toString(36) + Math.random().toString(36).substr(2) + Math.random().toString(36).substr(2);
                taskOrderCounter++;
                
                const safeSinger = singer ? sanitizeFileName(singer) : '';
                const safeName = sanitizeFileName(name);
                const artistName = safeSinger ? `${safeSinger} - ` : '';
                const fileName = `${artistName}${safeName}.mp3`;
                
                const task = {
                    id: taskId,
                    orderIndex: taskOrderCounter,
                    type: 'download',
                    source: source,
                    songId: songId,
                    songInfo: fullSongInfo,
                    name: name,
                    singer: singer,
                    fileName: fileName,
                    folderPath: targetFolder,
                    status: 'queued',
                    progress: 0,
                    message: '等待下载',
                    startTime: Date.now()
                };
                
                downloadQueue.push(task);
                completedDownloads.push(task);
                addedCount++;
                
                console.log(`⬇️ 批量添加下载任务：${fileName}`);
            } catch (e) {
                console.error('批量添加下载任务失败:', e.message);
            }
        }
        
        if (addedCount === 0) {
            return res.status(400).json({ success: false, error: '没有可下载的在线歌曲' });
        }
        
        for (let i = 0; i < maxDownloadWorkers; i++) {
            processDownloadQueue();
        }
        
        saveTaskData();
        
        res.json({
            success: true,
            message: `已添加 ${addedCount} 个下载任务到队列`,
            addedCount: addedCount
        });
        
    } catch (error) {
        console.error('批量添加下载任务失败:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 处理下载队列（支持并发）
async function processDownloadQueue() {
    if (downloadQueue.length === 0 || activeDownloadWorkers >= maxDownloadWorkers) {
        return;
    }
    
    activeDownloadWorkers++;
    
    const task = downloadQueue.shift();
    
    try {
        task.status = 'downloading';
        task.message = '正在下载';
        
        activeDownloadTasks.push(task);
        
        let playUrl = await getMusicPlayUrl(task.source, task.songInfo, '128');
        
        if (!playUrl) {
            console.log(`当前平台 ${task.source} 无法获取播放链接，尝试其他平台...`);
            
            const platforms = ['kw', 'kg', 'tx', 'wy', 'mg'];
            const currentIndexInPlatforms = platforms.indexOf(task.source);
            const otherPlatforms = currentIndexInPlatforms >= 0 
                ? platforms.filter((_, i) => i !== currentIndexInPlatforms)
                : platforms;
            
            for (const platform of otherPlatforms) {
                try {
                    const platformName = ONLINE_SOURCES.find(s => s.id === platform)?.name || platform;
                    console.log(`尝试从 ${platformName} 获取播放链接...`);
                    
                    playUrl = await getMusicPlayUrl(platform, task.songInfo, '128');
                    
                    if (playUrl) {
                        console.log(`成功从 ${platformName} 获取播放链接`);
                        break;
                    }
                } catch (e) {
                    console.log(`尝试 ${platform} 失败:`, e.message);
                }
            }
        }
        
        if (!playUrl) {
            throw new Error('无法获取播放链接（版权限制或需要付费）');
        }
        
        const downloadDir = path.join(MUSIC_DIR, task.folderPath);
        
        const resolvedDir = path.resolve(downloadDir);
        const resolvedMusicDir = path.resolve(MUSIC_DIR);
        if (!resolvedDir.startsWith(resolvedMusicDir)) {
            throw new Error('非法的目录路径');
        }
        
        await fs.promises.mkdir(downloadDir, { recursive: true });
        
        const filePath = path.join(downloadDir, task.fileName);
        
        if (fs.existsSync(filePath)) {
            task.status = 'completed';
            task.progress = 100;
            task.message = '文件已存在';
            task.endTime = Date.now();
            console.log(`ℹ️ 文件已存在：${task.fileName}`);
            saveTaskData();
            
            taskNotifications.push({
                type: 'download',
                status: 'completed',
                fileName: task.fileName,
                message: `文件已存在：${task.fileName}`
            });
            
            return;
        }
        
        task.progress = 10;
        task.message = '正在下载...';
        
        const response = await fetch(playUrl);
        
        if (!response.ok) {
            throw new Error(`获取在线音乐失败: ${response.status}`);
        }
        
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        
        task.progress = 80;
        task.message = '正在保存文件...';
        
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        await fs.promises.writeFile(filePath, buffer);
        
        task.status = 'completed';
        task.progress = 100;
        task.message = '下载完成';
        task.endTime = Date.now();
        
        console.log(`✅ 下载完成：${task.fileName}`);
        
        saveTaskData();
        
        if (fs.existsSync(FOLDER_CACHE_FILE)) {
            fs.unlinkSync(FOLDER_CACHE_FILE);
            console.log('🗑️ 删除文件夹缓存，下次扫描重新生成');
        }
        
        broadcastFolderRefresh();
        
        taskNotifications.push({
            type: 'download',
            status: 'completed',
            fileName: task.fileName,
            message: `下载完成：${task.fileName}`
        });
        
    } catch (error) {
        task.status = 'failed';
        task.message = '下载失败: ' + error.message;
        task.endTime = Date.now();
        console.error('下载失败:', error.message);
        
        saveTaskData();
        
        taskNotifications.push({
            type: 'download',
            status: 'failed',
            fileName: task.fileName,
            message: `下载失败：${task.fileName}`
        });
    } finally {
        const index = activeDownloadTasks.findIndex(t => t.id === task.id);
        if (index !== -1) {
            activeDownloadTasks.splice(index, 1);
        }
        activeDownloadWorkers--;
        
        if (downloadQueue.length === 0 && activeDownloadWorkers === 0) {
            console.log('📭 所有下载任务已完成');
        } else {
            processDownloadQueue();
        }
    }
}

app.get('/api/play/:index', async (req, res) => {
    const index = parseInt(req.params.index);
    if (index < 0 || index >= currentPlaylist.length) {
        return res.status(400).json({ error: '无效的索引' });
    }

    const track = currentPlaylist[index];

    // 如果是同一首歌，且正在播放，直接返回
    if (currentIndex === index && isPlaying) {
        console.log(`🎵 歌曲已在播放：${track.title}`);
        return res.json({
            success: true,
            current: track,
            index: currentIndex,
            alreadyPlaying: true
        });
    }

    // 设置新的播放索引
    currentIndex = index;

    // 添加到播放历史
    addToPlayHistory(track);

    if (playOutput === 'client') {
        isPlaying = true;
        currentDuration = track.duration;
        playbackStartTime = Date.now();
        console.log(`📱 客户端模式播放：${track.title}`);
        return res.json({
            success: true,
            current: track,
            index: currentIndex
        });
    }

    console.log(`🎵 切换歌曲：${track.title}`);

    // 判断是否是在线音乐
    if (track.isOnline || track.path.startsWith('online://')) {
        try {
            // 先停止当前播放
            stopMusic();
            
            // 获取播放链接（传递完整的歌曲信息，包括可能保存的 songInfo）
            const songInfo = track.songInfo || { 
                songId: track.path.split('/')[2], 
                name: track.title, 
                singer: track.artist, 
                albumName: track.album 
            };
            let playUrl = await getMusicPlayUrl(track.source, songInfo, '128');
            
            // 如果当前平台无法获取播放链接，尝试其他平台
            if (!playUrl) {
                console.log(`当前平台 ${track.sourceName} 无法获取播放链接，尝试其他平台...`);
                
                // 定义可用平台
                const platforms = ['kw', 'kg', 'tx', 'wy', 'mg'];
                const currentIndexInPlatforms = platforms.indexOf(track.source);
                const otherPlatforms = currentIndexInPlatforms >= 0 
                    ? platforms.filter((_, i) => i !== currentIndexInPlatforms)
                    : platforms;
                
                // 尝试其他平台
                for (const platform of otherPlatforms) {
                    try {
                        const platformName = ONLINE_SOURCES.find(s => s.id === platform)?.name || platform;
                        console.log(`尝试从 ${platformName} 获取播放链接...`);
                        
                        // 使用完整的歌曲信息
                        playUrl = await getMusicPlayUrl(platform, songInfo, '128');
                        
                        if (playUrl) {
                            // 更新歌曲的来源信息
                            track.source = platform;
                            track.sourceName = platformName;
                            console.log(`成功从 ${platformName} 获取播放链接`);
                            break;
                        }
                    } catch (e) {
                        console.log(`尝试 ${platform} 失败:`, e.message);
                    }
                }
            }
            
            if (!playUrl) {
                return res.json({ success: false, error: '无法获取播放链接（版权限制或需要付费）' });
            }
            
            // 更新播放链接
            track.playUrl = playUrl;
            currentDuration = track.duration;
            playbackStartTime = Date.now();
            isPlaying = true;
            
            console.log(`🎵 在线播放：${track.title} (${track.sourceName})`);
            
            // 播放在线音乐流
            playOnlineMusic(playUrl);
            
            res.json({
                success: true,
                current: track,
                index: currentIndex
            });
        } catch (error) {
            console.error('在线播放失败:', error.message);
            res.status(500).json({ success: false, error: error.message });
        }
    } else {
        // 播放本地音乐（playMusic 内部会处理 stopMusic 和 isPlaying）
        playMusic(track.path).then(() => {
            res.json({
                success: true,
                current: track,
                index: currentIndex
            });
        });
    }
});

app.get('/api/pause', (req, res) => {
    pauseMusic();
    isPlaying = false;
    res.json({ success: true, isPlaying: false });
});

app.get('/api/resume', (req, res) => {
    resumeMusic();
    isPlaying = true;
    res.json({ success: true, isPlaying: true });
});

app.get('/api/stop', (req, res) => {
    stopMusic();
    isPlaying = false;
    currentIndex = -1;
    res.json({ success: true });
});

// 跳转到指定时间
app.get('/api/seek', async (req, res) => {
    const time = parseFloat(req.query.time);
    
    if (isNaN(time) || time < 0) {
        return res.status(400).json({ success: false, message: '无效的时间值' });
    }
    
    if (currentIndex < 0) {
        return res.status(400).json({ success: false, message: '没有正在播放的歌曲' });
    }
    
    const maxTime = currentDuration || 0;
    const seekTime = Math.min(Math.max(time, 0), maxTime);
    
    console.log(`⏩ 跳转播放: ${seekTime.toFixed(1)}秒`);
    
    // 停止当前播放
    if (currentPlayer) {
        try {
            currentPlayer.kill('SIGTERM');
        } catch (e) {}
        currentPlayer = null;
    }
    
    // 更新播放时间记录
    if (isPlaying) {
        playbackStartTime = Date.now() - (seekTime * 1000);
    }
    pausedElapsed = seekTime;
    
    // 获取当前歌曲
    const track = currentPlaylist[currentIndex];
    
    // 判断是否是在线音乐
    if (track.isOnline || track.path.startsWith('online://')) {
        // 在线音乐无法精确跳转，只能重新播放
        try {
            const playUrl = await getMusicPlayUrl(track.source, { 
                songId: track.path.split('/')[2], 
                name: track.title, 
                singer: track.artist, 
                albumName: track.album 
            }, '128');
            
            if (!playUrl) {
                return res.json({ success: false, error: '无法获取播放链接' });
            }
            
            // 更新播放链接
            track.playUrl = playUrl;
            
            // 重新开始播放（在线音乐暂时不支持精确跳转）
            if (isPlaying) {
                playbackStartTime = Date.now();
                playOnlineMusic(playUrl);
            }
            
            res.json({ 
                success: true, 
                seekTime: seekTime,
                duration: maxTime
            });
        } catch (error) {
            console.error('在线播放跳转失败:', error.message);
            res.status(500).json({ success: false, error: error.message });
        }
    } else {
        // 本地音乐：重新开始播放（从指定位置）
        setTimeout(() => {
            playMusicFromPosition(track.path, seekTime, isPlaying);
        }, 100);
        
        res.json({ 
            success: true, 
            seekTime: seekTime,
            duration: maxTime
        });
    }
});

// 从指定位置播放
function playMusicFromPosition(filePath, startTime, shouldPlay) {
    stopMusic();
    
    setTimeout(async () => {
        const platform = process.platform;
        
        console.log(`🎵 从 ${startTime.toFixed(1)}秒 开始播放：${filePath}`);
        
        let player;
        
        if (platform === 'win32') {
            // Windows: 使用 ffplay，从指定位置开始
            // 注意：不使用 shell: true，让 Node.js 自动处理参数转义
            player = spawn('ffplay', [
                '-ss', startTime.toString(),
                '-i', filePath,
                '-autoexit',
                '-nodisp'
            ]);
        } else if (platform === 'darwin') {
            // macOS: afplay 不支持 seek，直接从头播放
            player = spawn('afplay', [filePath]);
            pausedElapsed = startTime;
        } else {
            // Linux/Docker: 使用 ffmpeg -ss 参数
            if (IS_DOCKER) {
                player = spawn('ffmpeg', [
                    '-ss', startTime.toString(),
                    '-i', filePath,
                    '-f', 's16le',
                    '-acodec', 'pcm_s16le',
                    '-ac', '2',
                    '-ar', '48000',
                    'pipe:1'
                ], {
                    stdio: ['ignore', 'pipe', 'pipe']
                });
                
                const aplay = spawn('aplay', [
                    '-D', currentAudioDevice || 'default',
                    '-f', 'S16_LE',
                    '-r', '48000',
                    '-c', '2'
                ], {
                    stdio: ['pipe', 'ignore', 'pipe']
                });
                
                player.stdout.pipe(aplay.stdin);
                const originalPlayer = player;
                player = aplay;
                
                player.on('exit', () => {
                    if (originalPlayer.pid) {
                        try { originalPlayer.kill(); } catch(e) {}
                    }
                    if (isPlaying && currentIndex >= 0) {
                        playNext();
                    }
                });
            } else {
                player = spawn('ffplay', [
                    '-ss', startTime.toString(),
                    '-i', filePath,
                    '-autoexit',
                    '-nodisp'
                ]);
            }
        }
        
        currentPlayer = player;
        
        if (shouldPlay) {
            playbackStartTime = Date.now() - (startTime * 1000);
            pausedElapsed = 0;
        } else {
            playbackStartTime = null;
            pausedElapsed = startTime;
        }
        
        player.on('error', (err) => {
            console.log('播放器错误:', err.message);
            isPlaying = false;
        });
        
        player.on('exit', (code) => {
            if (code !== null && code !== 0 && code !== 143) {
                console.log(`播放器退出，代码: ${code}`);
            }
            if (isPlaying && currentIndex >= 0) {
                isPlaying = false;
                playNext();
            }
        });
    }, 50);
}

// 通过播放列表索引下载文件 API
app.get('/api/download/:index', async (req, res) => {
    const index = parseInt(req.params.index);

    if (index < 0 || index >= currentPlaylist.length) {
        return res.status(404).json({ success: false, message: '歌曲不存在' });
    }

    const track = currentPlaylist[index];
    
    // 判断是否是在线音乐
    if (track.isOnline || track.path.startsWith('online://')) {
        try {
            // 使用完整的歌曲信息
            const songInfo = track.songInfo || { 
                songId: track.path.split('/')[2], 
                name: track.title, 
                singer: track.artist, 
                albumName: track.album 
            };
            
            // 获取播放链接
            let playUrl = await getMusicPlayUrl(track.source, songInfo, '128');
            
            // 如果当前平台无法获取播放链接，尝试其他平台
            if (!playUrl) {
                console.log(`当前平台 ${track.sourceName} 无法获取播放链接，尝试其他平台...`);
                
                const platforms = ['kw', 'kg', 'tx', 'wy', 'mg'];
                const currentIndexInPlatforms = platforms.indexOf(track.source);
                const otherPlatforms = currentIndexInPlatforms >= 0 
                    ? platforms.filter((_, i) => i !== currentIndexInPlatforms)
                    : platforms;
                
                for (const platform of otherPlatforms) {
                    try {
                        const platformName = ONLINE_SOURCES.find(s => s.id === platform)?.name || platform;
                        console.log(`尝试从 ${platformName} 获取播放链接...`);
                        
                        playUrl = await getMusicPlayUrl(platform, songInfo, '128');
                        
                        if (playUrl) {
                            track.source = platform;
                            track.sourceName = platformName;
                            console.log(`成功从 ${platformName} 获取播放链接`);
                            break;
                        }
                    } catch (e) {
                        console.log(`尝试 ${platform} 失败:`, e.message);
                    }
                }
            }
            
            if (!playUrl) {
                return res.status(500).json({ success: false, error: '无法获取播放链接（版权限制或需要付费）' });
            }
            
            // 下载在线音乐
            downloadOnlineMusic(res, playUrl, track.title, track.artist);
            
        } catch (error) {
            console.error('在线音乐下载失败:', error.message);
            res.status(500).json({ success: false, error: error.message });
        }
    } else {
        // 本地音乐下载
        const filePath = track.path;
        sendFileDownload(res, filePath);
    }
});

app.get('/api/next', async (req, res) => {
    if (currentPlaylist.length === 0) {
        return res.json({ success: false, message: '播放列表为空' });
    }

    let nextIndex;

    if (playMode === 'random') {
        if (currentPlaylist.length === 1) {
            nextIndex = 0;
        } else {
            do {
                nextIndex = Math.floor(Math.random() * currentPlaylist.length);
            } while (nextIndex === currentIndex);
        }
    } else {
        if (currentIndex < currentPlaylist.length - 1) {
            nextIndex = currentIndex + 1;
        } else {
            return res.json({ success: false, message: '已经是最后一首' });
        }
    }

    const track = currentPlaylist[nextIndex];
    currentIndex = nextIndex;
    
    // 添加到播放历史
    addToPlayHistory(track);

    if (playOutput === 'client') {
        isPlaying = true;
        currentDuration = track.duration;
        playbackStartTime = Date.now();
        console.log(`📱 客户端模式下一首：${track.title}`);
        return res.json({ success: true, current: track, index: currentIndex, isPlaying: isPlaying });
    }

    // 先停止当前播放
    stopMusic();

    // 判断是否是在线音乐
    if (track.isOnline || track.path.startsWith('online://')) {
        try {
            // 使用完整的歌曲信息
            const songInfo = track.songInfo || { 
                songId: track.path.split('/')[2], 
                name: track.title, 
                singer: track.artist, 
                albumName: track.album 
            };
            let playUrl = await getMusicPlayUrl(track.source, songInfo, '128');
            
            // 如果当前平台无法获取播放链接，尝试其他平台
            if (!playUrl) {
                console.log(`当前平台 ${track.sourceName} 无法获取播放链接，尝试其他平台...`);
                
                const platforms = ['kw', 'kg', 'tx', 'wy', 'mg'];
                const currentIndexInPlatforms = platforms.indexOf(track.source);
                const otherPlatforms = currentIndexInPlatforms >= 0 
                    ? platforms.filter((_, i) => i !== currentIndexInPlatforms)
                    : platforms;
                
                for (const platform of otherPlatforms) {
                    try {
                        const platformName = ONLINE_SOURCES.find(s => s.id === platform)?.name || platform;
                        console.log(`尝试从 ${platformName} 获取播放链接...`);
                        
                        playUrl = await getMusicPlayUrl(platform, songInfo, '128');
                        
                        if (playUrl) {
                            track.source = platform;
                            track.sourceName = platformName;
                            console.log(`成功从 ${platformName} 获取播放链接`);
                            break;
                        }
                    } catch (e) {
                        console.log(`尝试 ${platform} 失败:`, e.message);
                    }
                }
            }
            
            if (!playUrl) {
                return res.json({ success: false, error: '无法获取播放链接（版权限制或需要付费）' });
            }
            
            track.playUrl = playUrl;
            currentDuration = track.duration;
            playbackStartTime = Date.now();
            isPlaying = true;
            
            console.log(`🎵 在线播放：${track.title} (${track.sourceName})`);
            playOnlineMusic(playUrl);
            
            res.json({ success: true, current: track, index: currentIndex, isPlaying: isPlaying });
        } catch (error) {
            console.error('在线播放失败:', error.message);
            res.status(500).json({ success: false, error: error.message });
        }
    } else {
        // 播放本地音乐（playMusic 内部会处理 stopMusic 和 isPlaying）
        playMusic(track.path).then(() => {
            res.json({ success: true, current: track, index: currentIndex, isPlaying: true });
        });
    }
});

app.get('/api/previous', async (req, res) => {
    if (currentPlaylist.length === 0) {
        return res.json({ success: false, message: '播放列表为空' });
    }

    let prevIndex;

    if (playMode === 'random') {
        if (currentPlaylist.length === 1) {
            prevIndex = 0;
        } else {
            do {
                prevIndex = Math.floor(Math.random() * currentPlaylist.length);
            } while (prevIndex === currentIndex);
        }
    } else {
        if (currentIndex > 0) {
            prevIndex = currentIndex - 1;
        } else {
            return res.json({ success: false, message: '已经是第一首' });
        }
    }

    const track = currentPlaylist[prevIndex];
    currentIndex = prevIndex;
    
    // 添加到播放历史
    addToPlayHistory(track);

    if (playOutput === 'client') {
        isPlaying = true;
        currentDuration = track.duration;
        playbackStartTime = Date.now();
        console.log(`📱 客户端模式上一首：${track.title}`);
        return res.json({ success: true, current: track, index: currentIndex, isPlaying: isPlaying });
    }

    // 先停止当前播放
    stopMusic();

    // 判断是否是在线音乐
    if (track.isOnline || track.path.startsWith('online://')) {
        try {
            // 使用完整的歌曲信息
            const songInfo = track.songInfo || { 
                songId: track.path.split('/')[2], 
                name: track.title, 
                singer: track.artist, 
                albumName: track.album 
            };
            let playUrl = await getMusicPlayUrl(track.source, songInfo, '128');
            
            // 如果当前平台无法获取播放链接，尝试其他平台
            if (!playUrl) {
                console.log(`当前平台 ${track.sourceName} 无法获取播放链接，尝试其他平台...`);
                
                const platforms = ['kw', 'kg', 'tx', 'wy', 'mg'];
                const currentIndexInPlatforms = platforms.indexOf(track.source);
                const otherPlatforms = currentIndexInPlatforms >= 0 
                    ? platforms.filter((_, i) => i !== currentIndexInPlatforms)
                    : platforms;
                
                for (const platform of otherPlatforms) {
                    try {
                        const platformName = ONLINE_SOURCES.find(s => s.id === platform)?.name || platform;
                        console.log(`尝试从 ${platformName} 获取播放链接...`);
                        
                        playUrl = await getMusicPlayUrl(platform, songInfo, '128');
                        
                        if (playUrl) {
                            track.source = platform;
                            track.sourceName = platformName;
                            console.log(`成功从 ${platformName} 获取播放链接`);
                            break;
                        }
                    } catch (e) {
                        console.log(`尝试 ${platform} 失败:`, e.message);
                    }
                }
            }
            
            if (!playUrl) {
                return res.json({ success: false, error: '无法获取播放链接（版权限制或需要付费）' });
            }
            
            track.playUrl = playUrl;
            currentDuration = track.duration;
            playbackStartTime = Date.now();
            isPlaying = true;
            
            console.log(`🎵 在线播放：${track.title} (${track.sourceName})`);
            playOnlineMusic(playUrl);
            
            res.json({ success: true, current: track, index: currentIndex, isPlaying: isPlaying });
        } catch (error) {
            console.error('在线播放失败:', error.message);
            res.status(500).json({ success: false, error: error.message });
        }
    } else {
        // 播放本地音乐（playMusic 内部会处理 stopMusic 和 isPlaying）
        playMusic(track.path).then(() => {
            res.json({ success: true, current: track, index: currentIndex, isPlaying: true });
        });
    }
});

app.get('/api/status', async (req, res) => {
    const current = currentIndex >= 0 ? currentPlaylist[currentIndex] : null;

    // 计算播放进度
    let progress = null;
    if (currentDuration > 0 && (isPlaying || pausedElapsed > 0)) {
        let currentTime;
        if (isPlaying && playbackStartTime) {
            // 正在播放：计算从开始到现在的已播放时间
            currentTime = (Date.now() - playbackStartTime) / 1000;
        } else if (pausedElapsed > 0) {
            // 暂停中：使用保存的进度
            currentTime = pausedElapsed;
        } else if (playbackStartTime) {
            // 刚暂停还没保存进度时，使用计算值
            currentTime = (Date.now() - playbackStartTime) / 1000;
        } else {
            currentTime = 0;
        }
        currentTime = Math.min(currentTime, currentDuration);
        progress = {
            currentTime: currentTime,
            duration: currentDuration,
            percent: (currentTime / currentDuration) * 100
        };
    }

    // 从声卡获取实际音量和静音状态
    const systemVolume = await getSystemVolume();
    const systemMuted = await getSystemMuted();

    // 调试日志
    console.log(`[Status] playing=${isPlaying}, index=${currentIndex}, duration=${currentDuration}, pausedElapsed=${pausedElapsed}, progress=${JSON.stringify(progress)}, volume=${systemVolume}, muted=${systemMuted}`);

    res.json({
        current: current,
        currentIndex: currentIndex,
        isPlaying: isPlaying,
        progress: progress,
        playlistLength: currentPlaylist.length,
        playMode: playMode,
        volume: systemVolume,
        muted: systemMuted,
        audioDevice: currentAudioDevice
    });
});

app.get('/api/play-mode', (req, res) => {
    res.json({ success: true, playMode: playMode });
});

app.post('/api/play-mode', (req, res) => {
    const { mode } = req.body;
    const validModes = ['sequence', 'random', 'single', 'loop'];

    if (!validModes.includes(mode)) {
        return res.json({ success: false, message: '无效的播放模式' });
    }

    playMode = mode;
    saveConfig();
    console.log(`🎵 播放模式已切换为：${mode}`);
    res.json({ success: true, playMode: mode });
});

// 获取播放输出方式
app.get('/api/play-output', (req, res) => {
    res.json({ success: true, playOutput: playOutput });
});

// 设置播放输出方式
app.post('/api/play-output', requireAuth, (req, res) => {
    const { output } = req.body;
    const validOutputs = ['server', 'client'];

    if (!validOutputs.includes(output)) {
        return res.json({ success: false, message: '无效的播放输出方式' });
    }

    playOutput = output;
    saveConfig();
    console.log(`📱 播放输出已切换为：${output === 'server' ? '服务器声卡' : '客户端浏览器'}`);
    res.json({ success: true, playOutput: output });
});

// 获取缓存列表和总大小
app.get('/api/cache', (req, res) => {
    try {
        const cacheList = Object.entries(cacheMetadata).map(([cacheKey, meta]) => ({
            cacheKey,
            ...meta,
            size: meta.size || 0
        })).sort((a, b) => (b.cachedAt || 0) - (a.cachedAt || 0));
        
        const totalSize = getCacheTotalSize();
        
        res.json({
            success: true,
            cacheList,
            totalSize,
            count: cacheList.length
        });
    } catch (error) {
        console.error('获取缓存列表失败:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 删除单个缓存
app.delete('/api/cache/:cacheKey', requireAuth, (req, res) => {
    try {
        const { cacheKey } = req.params;
        const result = deleteCache(cacheKey);
        if (result) {
            console.log(`🗑️ 已删除缓存: ${cacheKey}`);
            res.json({ success: true, message: '缓存已删除' });
        } else {
            res.status(404).json({ success: false, error: '缓存不存在' });
        }
    } catch (error) {
        console.error('删除缓存失败:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 下载单个缓存文件
app.get('/api/cache/:cacheKey/download', (req, res) => {
    try {
        const { cacheKey } = req.params;
        const meta = cacheMetadata[cacheKey];
        if (!meta) {
            return res.status(404).json({ success: false, error: '缓存不存在' });
        }
        
        const cacheFilePath = getCacheFilePath(cacheKey, meta.ext || '.mp3');
        if (!fs.existsSync(cacheFilePath)) {
            return res.status(404).json({ success: false, error: '缓存文件不存在' });
        }
        
        const fileName = `${meta.artist || '未知艺术家'} - ${meta.title || '未知歌曲'}.${meta.ext || 'mp3'}`;
        const stat = fs.statSync(cacheFilePath);
        
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Content-Length', stat.size);
        
        const fileStream = fs.createReadStream(cacheFilePath);
        fileStream.pipe(res);
        
        console.log(`📥 下载缓存: ${fileName}`);
    } catch (error) {
        console.error('下载缓存失败:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 清空所有缓存
app.delete('/api/cache', requireAuth, (req, res) => {
    try {
        const result = clearAllCache();
        if (result) {
            console.log('🗑️ 已清空所有缓存');
            res.json({ success: true, message: '所有缓存已清空' });
        } else {
            res.status(500).json({ success: false, error: '清空缓存失败' });
        }
    } catch (error) {
        console.error('清空缓存失败:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取缓存大小限制
app.get('/api/cache-limit', (req, res) => {
    try {
        res.json({
            success: true,
            cacheLimitSize: cacheLimitSize,
            currentSize: getCacheTotalSize()
        });
    } catch (error) {
        console.error('获取缓存限制失败:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 设置缓存大小限制
app.post('/api/cache-limit', requireAuth, (req, res) => {
    try {
        const { cacheLimitSize: newLimit } = req.body;
        const limit = Math.max(0, parseInt(newLimit, 10) || 0);
        cacheLimitSize = limit;
        saveConfig();
        
        console.log(`📦 缓存大小限制已设置为：${limit === 0 ? '不限制' : limit + ' MB'}`);
        
        // 如果设置了限制，立即检查并清理
        let cleanResult = { cleaned: false, freedSize: 0, removedCount: 0 };
        if (limit > 0) {
            cleanResult = checkAndCleanCache();
        }
        
        res.json({
            success: true,
            cacheLimitSize: cacheLimitSize,
            cleaned: cleanResult.cleaned,
            freedSize: cleanResult.freedSize,
            removedCount: cleanResult.removedCount
        });
    } catch (error) {
        console.error('设置缓存限制失败:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 客户端音频流 API
app.get('/api/stream/:index', async (req, res) => {
    console.log(`[Stream] 请求音频流，索引: ${req.params.index}`);
    const index = parseInt(req.params.index);

    if (index < 0 || index >= currentPlaylist.length) {
        console.error(`[Stream] 索引超出范围: ${index}, 播放列表长度: ${currentPlaylist.length}`);
        return res.status(404).json({ success: false, message: '歌曲不存在' });
    }

    const track = currentPlaylist[index];
    console.log(`[Stream] 歌曲信息: ${track.title}, isOnline: ${track.isOnline}, path: ${track.path}`);
    
    // 判断是否是在线音乐
    if (track.isOnline || track.path.startsWith('online://')) {
        try {
            // 提取 source 和 songId
            let source = track.source;
            let songId;
            if (track.songInfo && track.songInfo.songId) {
                songId = track.songInfo.songId;
            } else if (track.path.startsWith('online://')) {
                songId = track.path.split('/')[2];
            }
            
            // 检查缓存
            const cached = source && songId ? checkCache(source, songId) : null;
            if (cached) {
                console.log(`[Stream] 使用缓存: ${track.title}, 大小: ${(cached.size / 1024 / 1024).toFixed(2)}MB`);
                const filePath = cached.filePath;
                const stat = fs.statSync(filePath);
                const range = req.headers.range;
                
                const ext = cached.ext || '.mp3';
                const contentTypeMap = {
                    '.mp3': 'audio/mpeg',
                    '.flac': 'audio/flac',
                    '.wav': 'audio/wav',
                    '.m4a': 'audio/mp4',
                    '.ogg': 'audio/ogg',
                    '.wma': 'audio/x-ms-wma'
                };
                const contentType = contentTypeMap[ext] || 'audio/mpeg';
                
                if (range) {
                    const parts = range.replace(/bytes=/, '').split('-');
                    const start = parseInt(parts[0], 10);
                    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
                    const chunksize = (end - start) + 1;
                    const file = fs.createReadStream(filePath, { start, end });
                    
                    res.writeHead(206, {
                        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
                        'Accept-Ranges': 'bytes',
                        'Content-Length': chunksize,
                        'Content-Type': contentType
                    });
                    file.pipe(res);
                } else {
                    res.writeHead(200, {
                        'Content-Length': stat.size,
                        'Accept-Ranges': 'bytes',
                        'Content-Type': contentType
                    });
                    const file = fs.createReadStream(filePath);
                    file.pipe(res);
                }
                return;
            }
            
            // 优先使用已存储的 playUrl（来自 /api/play-online）
            let playUrl = track.playUrl;
            let urlFromCache = !!playUrl;
            console.log(`[Stream] 已有 playUrl: ${playUrl ? '是' : '否'}`);
            
            const songInfo = track.songInfo || { 
                songId: track.path.split('/')[2], 
                name: track.title, 
                singer: track.artist, 
                albumName: track.album 
            };
            
            async function fetchPlayUrl(useCache) {
                if (useCache && track.playUrl) {
                    return track.playUrl;
                }
                console.log(`[Stream] 重新获取播放链接...`);
                let url = await getMusicPlayUrl(track.source, songInfo, '128');
                console.log(`[Stream] 获取 playUrl 结果: ${url ? url.substring(0, 100) : '失败'}`);
                
                if (!url) {
                    const platforms = ['kw', 'kg', 'tx', 'wy', 'mg'];
                    for (const platform of platforms) {
                        if (platform === track.source) continue;
                        try {
                            url = await getMusicPlayUrl(platform, songInfo, '128');
                            if (url) {
                                track.source = platform;
                                source = platform;
                                console.log(`[Stream] 从备用平台 ${platform} 获取到链接`);
                                break;
                            }
                        } catch (e) {
                            console.log(`[Stream] 平台 ${platform} 获取失败: ${e.message}`);
                        }
                    }
                }
                
                if (url) {
                    track.playUrl = url;
                }
                return url;
            }
            
            playUrl = await fetchPlayUrl(urlFromCache);
            
            if (!playUrl) {
                console.error(`[Stream] 无法获取播放链接`);
                return res.status(500).json({ success: false, error: '无法获取播放链接' });
            }
            
            console.log(`[Stream] 开始代理音频流: ${playUrl.substring(0, 100)}...`);
            
            // 代理在线音频流
            let response = await fetch(playUrl);
            console.log(`[Stream] fetch 响应状态: ${response.status}`);
            
            // 如果使用缓存的 playUrl 且请求失败，重新获取链接后重试一次
            if (!response.ok && urlFromCache) {
                console.log(`[Stream] 缓存的 playUrl 失效，重新获取链接...`);
                playUrl = await fetchPlayUrl(false);
                if (playUrl) {
                    response = await fetch(playUrl);
                    console.log(`[Stream] 重新获取后 fetch 响应状态: ${response.status}`);
                }
            }
            
            if (!response.ok) {
                throw new Error(`获取在线音乐失败: ${response.status}`);
            }
            
            const contentType = response.headers.get('content-type') || 'audio/mpeg';
            const contentLength = response.headers.get('content-length');
            
            console.log(`[Stream] Content-Type: ${contentType}, Content-Length: ${contentLength || '未知'}`);
            
            res.setHeader('Content-Type', contentType);
            res.setHeader('Accept-Ranges', 'bytes');
            if (contentLength) {
                res.setHeader('Content-Length', contentLength);
            }
            
            // 使用 Web Streams API 读取并转发数据，同时写入缓存
            const stream = response.body;
            if (!stream) {
                throw new Error('响应体为空');
            }
            
            const ext = getExtFromContentType(contentType);
            const cacheKey = source && songId ? getCacheKey(source, songId) : null;
            const cacheFilePath = cacheKey ? getCacheFilePath(cacheKey, ext) : null;
            let cacheWriteStream = null;
            let cachedBytes = 0;
            
            // 如果有缓存键，检查是否有其他请求正在写入该缓存
            if (cacheKey && cacheFilePath) {
                if (cacheWriteLocks.has(cacheKey)) {
                    console.log(`[Cache] 跳过缓存写入，已有请求正在写入: ${cacheKey}`);
                } else {
                    cacheWriteLocks.add(cacheKey);
                    ensureCacheDir();
                    cacheWriteStream = fs.createWriteStream(cacheFilePath);
                    console.log(`[Cache] 开始缓存: ${track.title} -> ${cacheKey}${ext}`);
                }
            }
            
            const reader = stream.getReader();
            const pump = async () => {
                try {
                    const { done, value } = await reader.read();
                    if (done) {
                        console.log(`[Stream] 流式传输完成: ${track.title}`);
                        res.end();
                        
                        // 缓存完成，保存元数据
                        if (cacheWriteStream) {
                            cacheWriteStream.end(() => {
                                cacheWriteLocks.delete(cacheKey);
                                if (cachedBytes > 0) {
                                    addCacheMeta(
                                        source,
                                        songId,
                                        track.title,
                                        track.artist,
                                        track.album,
                                        ext,
                                        cachedBytes
                                    );
                                    console.log(`[Cache] 缓存完成: ${track.title}, 大小: ${(cachedBytes / 1024 / 1024).toFixed(2)}MB`);
                                } else {
                                    // 空文件，删除
                                    if (fs.existsSync(cacheFilePath)) {
                                        fs.unlinkSync(cacheFilePath);
                                    }
                                }
                            });
                        }
                        return;
                    }
                    res.write(value);
                    
                    // 写入缓存
                    if (cacheWriteStream) {
                        cacheWriteStream.write(value);
                        cachedBytes += value.length;
                    }
                    
                    return pump();
                } catch (err) {
                    console.error(`[Stream] 读取流错误: ${err.message}`);
                    
                    // 出错时清理不完整的缓存
                    if (cacheWriteStream) {
                        cacheWriteStream.end(() => {
                            cacheWriteLocks.delete(cacheKey);
                            if (fs.existsSync(cacheFilePath)) {
                                fs.unlinkSync(cacheFilePath);
                            }
                        });
                    }
                    
                    if (!res.headersSent) {
                        res.status(500).json({ success: false, error: err.message });
                    } else {
                        res.end();
                    }
                }
            };
            pump();
            
            // 客户端断开连接时取消读取
            res.on('close', () => {
                reader.cancel();
                console.log(`[Stream] 客户端断开连接`);
                
                // 客户端提前断开，不完整的缓存保留还是删除？这里选择保留（下次播放可续传或继续）
                if (cacheWriteStream) {
                    cacheWriteStream.end(() => {
                        cacheWriteLocks.delete(cacheKey);
                        if (cachedBytes > 1024 * 100) { // 大于100KB才保留
                            addCacheMeta(
                                source,
                                songId,
                                track.title,
                                track.artist,
                                track.album,
                                ext,
                                cachedBytes
                            );
                            console.log(`[Cache] 部分缓存保留: ${track.title}, 大小: ${(cachedBytes / 1024 / 1024).toFixed(2)}MB`);
                        } else {
                            if (fs.existsSync(cacheFilePath)) {
                                fs.unlinkSync(cacheFilePath);
                                console.log(`[Cache] 缓存过小，已删除: ${track.title}`);
                            }
                        }
                    });
                }
            });
            
        } catch (error) {
            console.error(`[Stream] 在线音乐流式播放失败: ${error.message}`);
            console.error(`[Stream] 错误堆栈:`, error.stack);
            if (!res.headersSent) {
                res.status(500).json({ success: false, error: error.message });
            }
        }
    } else {
        // 本地音乐流式播放
        const filePath = track.path;
        
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ success: false, error: '文件不存在' });
        }
        
        const stat = fs.statSync(filePath);
        const range = req.headers.range;
        
        if (range) {
            // 支持 Range 请求（seek）
            const parts = range.replace(/bytes=/, '').split('-');
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
            const chunksize = (end - start) + 1;
            const file = fs.createReadStream(filePath, { start, end });
            
            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${stat.size}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunksize,
                'Content-Type': 'audio/mpeg'
            });
            file.pipe(res);
        } else {
            // 完整文件流
            res.writeHead(200, {
                'Content-Length': stat.size,
                'Content-Type': 'audio/mpeg'
            });
            const file = fs.createReadStream(filePath);
            file.pipe(res);
        }
    }
});

// 客户端播放状态同步 API
app.post('/api/client-playback-state', (req, res) => {
    const { state, currentTime, duration } = req.body;
    
    if (state === 'playing') {
        isPlaying = true;
        playbackStartTime = Date.now() - (currentTime * 1000);
        currentDuration = duration || currentDuration;
        console.log(`📱 客户端播放状态：播放中，进度 ${currentTime.toFixed(1)}s`);
    } else if (state === 'paused') {
        isPlaying = false;
        pausedElapsed = currentTime;
        console.log(`📱 客户端播放状态：暂停，进度 ${currentTime.toFixed(1)}s`);
    } else if (state === 'ended') {
        isPlaying = false;
        playbackStartTime = null;
        console.log(`📱 客户端播放状态：播放结束`);
        
        if (playOutput === 'client') {
            console.log(`📱 客户端模式下，切歌逻辑由客户端处理`);
            return res.json({ success: true });
        }
        
        // 处理自动播放下一首
        if (playMode === 'loop') {
            playMusic(currentPlaylist[currentIndex].path);
        } else if (playMode === 'single') {
            currentIndex = -1;
        } else if (playMode === 'random') {
            if (currentPlaylist.length > 1) {
                let randomIndex;
                do {
                    randomIndex = Math.floor(Math.random() * currentPlaylist.length);
                } while (randomIndex === currentIndex && currentPlaylist.length > 1);
                currentIndex = randomIndex;
                isPlaying = true;
                playMusic(currentPlaylist[currentIndex].path);
            }
        } else {
            if (currentIndex < currentPlaylist.length - 1) {
                const nextIndex = currentIndex + 1;
                const nextTrack = currentPlaylist[nextIndex];
                currentIndex = nextIndex;
                isPlaying = true;
                playMusic(nextTrack.path);
            }
        }
    }
    
    res.json({ success: true });
});

let currentPlayer = null;

function playMusic(filePath) {
    return new Promise((resolve) => {
        stopMusic();

        // Windows 上需要等待 ffplay 进程完全停止后再启动新的
        setTimeout(async () => {
            const platform = process.platform;
            let player;

            console.log(`🎵 开始播放：${filePath} (音量：${currentVolume}%)`);
            console.log(`📱 平台：${platform}, Docker: ${IS_DOCKER}`);

            try {
                const metadata = await mm.parseFile(filePath);
                currentDuration = metadata.format.duration || 0;
                console.log(`📊 歌曲时长：${currentDuration}秒`);
            } catch (err) {
                console.log('无法获取音频时长:', err.message);
                currentDuration = 0;
            }

            playbackStartTime = Date.now();
            isPlaying = true;

            if (platform === 'win32') {
                console.log(`🔊 使用 ffplay 播放：${filePath}`);
                player = spawn('ffplay', [
                    '-i', filePath,
                    '-autoexit',
                    '-nodisp'
                ]);
            } else if (platform === 'darwin') {
                player = spawn('afplay', [filePath]);
            } else {
                if (IS_DOCKER) {
                    console.log(`🔊 使用 ALSA 播放：${filePath} (设备：${currentAudioDevice})`);

                    player = spawn('ffmpeg', [
                        '-i', filePath,
                        '-f', 's16le',
                        '-acodec', 'pcm_s16le',
                        '-ac', '2',
                        '-ar', '48000',
                        'pipe:1'
                    ], {
                        stdio: ['ignore', 'pipe', 'pipe']
                    });

                    const aplay = spawn('aplay', [
                        '-D', currentAudioDevice || 'default',
                        '-f', 'S16_LE',
                        '-r', '48000',
                        '-c', '2'
                    ], {
                        stdio: ['pipe', 'ignore', 'pipe']
                    });

                    player.stdout.on('error', (err) => {
                        if (err.code !== 'EPIPE') {
                            console.log('ffmpeg stdout error:', err.message);
                        }
                    });

                    aplay.stdin.on('error', (err) => {
                        if (err.code !== 'EPIPE') {
                            console.log('aplay stdin error:', err.message);
                        }
                    });

                    player.stdout.pipe(aplay.stdin);

                    const originalPlayer = player;
                    player = aplay;

                    player.on('exit', () => {
                        if (originalPlayer.pid) {
                            try {
                                originalPlayer.kill('SIGTERM');
                            } catch (e) { }
                        }
                    });
                } else {
                    player = spawn('aplay', [filePath]);
                }
            }

            currentPlayer = player;

            player.on('exit', () => {
                if (currentPlayer === player) {
                    currentPlayer = null;
                    isPlaying = false;
                    playbackStartTime = null;
                    console.log('⏹️ 播放结束');

                    if (playOutput === 'client') {
                        console.log('📱 客户端模式，不执行服务端自动切歌');
                        return;
                    }

                    if (playMode === 'loop') {
                        console.log('🔁 单曲循环');
                        isPlaying = true;
                        playMusic(currentPlaylist[currentIndex].path);
                    } else if (playMode === 'single') {
                        console.log('⏹️ 单曲播放结束');
                        currentIndex = -1;
                    } else if (playMode === 'random') {
                        if (currentPlaylist.length > 1) {
                            console.log('🔀 随机播放下一首');
                            let randomIndex;
                            do {
                                randomIndex = Math.floor(Math.random() * currentPlaylist.length);
                            } while (randomIndex === currentIndex && currentPlaylist.length > 1);
                            currentIndex = randomIndex;
                            isPlaying = true;
                            playMusic(currentPlaylist[currentIndex].path);
                        }
                    } else {
                        if (currentIndex < currentPlaylist.length - 1) {
                            console.log('🎵 自动播放下一首');
                            const nextIndex = currentIndex + 1;
                            const nextTrack = currentPlaylist[nextIndex];
                            currentIndex = nextIndex;
                            isPlaying = true;
                            playMusic(nextTrack.path);
                        }
                    }
                }
            });

            player.stderr.on('data', (data) => {
                console.log(`播放器输出：${data}`);
            });

            player.on('error', (err) => {
                console.log(`播放器错误：${err.message}`);
                resolve();
            });

            setTimeout(() => {
                resolve();
            }, 300);
        }, 50);
    });
}

function pauseMusic() {
    console.log('⏸️ 暂停播放');
    // 保存当前播放进度
    if (playbackStartTime && currentDuration > 0) {
        pausedElapsed = (Date.now() - playbackStartTime) / 1000;
        pausedElapsed = Math.min(pausedElapsed, currentDuration);
        console.log(`📍 暂停时保存进度：${pausedElapsed.toFixed(1)}秒`);
    }
    if (currentPlayer) {
        if (process.platform === 'win32') {
            // Windows: 同步停止 ffplay 进程（恢复时重新播放）
            const { execSync } = require('child_process');
            try {
                execSync('taskkill /f /im ffplay.exe', { stdio: 'ignore' });
                console.log('✅ ffplay 已停止（暂停）');
            } catch (e) {
                // 忽略错误，进程可能已经不存在
            }
            currentPlayer = null;
        } else {
            if (IS_DOCKER && currentPlayer._aplayProcess) {
                // Docker环境：需要同时停止 ffmpeg 和 aplay
                try {
                    currentPlayer._aplayProcess.kill('SIGKILL');
                    console.log('✅ aplay 已停止（暂停）');
                } catch (e) {
                    // 忽略错误
                }
                try {
                    currentPlayer.kill('SIGKILL');
                    console.log('✅ ffmpeg 已停止（暂停）');
                } catch (e) {
                    // 忽略错误
                }
                currentPlayer = null;
            } else {
                // Linux/Docker 使用 kill -STOP
                currentPlayer.kill('SIGSTOP');
            }
        }
    }
}

function resumeMusic() {
    console.log('▶️ 继续播放');
    // 恢复播放进度：从暂停时的进度继续
    if (pausedElapsed > 0 && currentDuration > 0) {
        playbackStartTime = Date.now() - (pausedElapsed * 1000);
        console.log(`📍 恢复播放，从 ${pausedElapsed.toFixed(1)}秒 继续`);
    }
    if (currentPlayer) {
        if (process.platform === 'win32') {
            // Windows: 需要从暂停位置重新播放
            const track = currentPlaylist[currentIndex];
            if (track) {
                playMusicFromPosition(track.path, pausedElapsed);
            }
        } else {
            // Linux/Docker 使用 kill -CONT
            currentPlayer.kill('SIGCONT');
        }
    } else if (process.platform === 'win32') {
        // Windows: currentPlayer 已在暂停时被设置为 null，需要重新播放
        const track = currentPlaylist[currentIndex];
        if (track) {
            playMusicFromPosition(track.path, pausedElapsed);
        }
    }
}

function stopMusic() {
    console.log('⏹️ 停止播放');
    // 清除暂停时的进度
    pausedElapsed = 0;
    playbackStartTime = null;
    if (currentPlayer) {
        try {
            if (process.platform === 'win32') {
                // Windows: 同步杀死 ffplay 进程，等待执行完成
                const { execSync } = require('child_process');
                try {
                    execSync('taskkill /f /im ffplay.exe', { stdio: 'ignore' });
                    console.log('✅ ffplay 已停止');
                } catch (e) {
                    // 忽略错误，进程可能已经不存在
                }
            } else {
                // Docker环境：需要同时停止 ffmpeg 和 aplay
                if (IS_DOCKER && currentPlayer._aplayProcess) {
                    try {
                        currentPlayer._aplayProcess.kill('SIGKILL');
                        console.log('✅ aplay 已停止');
                    } catch (e) {
                        // 忽略错误
                    }
                }
                // 立即停止主进程
                currentPlayer.kill('SIGKILL');
                console.log('✅ 播放器已停止');
            }
        } catch (err) {
            // 忽略错误，进程可能已经不存在
        }
        currentPlayer = null;
        isPlaying = false;
        console.log('✅ 播放已停止');
    }
}

function getSystemVolume() {
    return new Promise((resolve) => {
        if (process.platform === 'win32') {
            // Windows 使用 PowerShell 获取系统音量
            exec('powershell -command "(Get-WmiObject -Namespace root\\cimv2\\TerminalServices Win32_SoundDevice | Select-Object -First 1).Volume"', (err, stdout) => {
                if (err) {
                    resolve(currentVolume);
                    return;
                }
                try {
                    const volume = parseInt(stdout.trim());
                    if (!isNaN(volume) && volume >= 0 && volume <= 100) {
                        resolve(volume);
                    } else {
                        resolve(currentVolume);
                    }
                } catch (e) {
                    resolve(currentVolume);
                }
            });
        } else if (IS_DOCKER || process.platform === 'linux') {
            // Linux/Docker 使用 amixer 获取音量
            exec('amixer -D default get Master | grep -o "\\[[0-9]*%\\]" | head -1 | tr -d "[]%"', (err, stdout) => {
                if (err) {
                    resolve(currentVolume);
                    return;
                }
                try {
                    const volume = parseInt(stdout.trim());
                    if (!isNaN(volume) && volume >= 0 && volume <= 100) {
                        resolve(volume);
                    } else {
                        resolve(currentVolume);
                    }
                } catch (e) {
                    resolve(currentVolume);
                }
            });
        } else {
            resolve(currentVolume);
        }
    });
}

function getSystemMuted() {
    return new Promise((resolve) => {
        if (process.platform === 'win32') {
            // Windows 使用 PowerShell 获取静音状态
            exec('powershell -command "(Get-WmiObject -Namespace root\\cimv2\\TerminalServices Win32_SoundDevice | Select-Object -First 1).Muted"', (err, stdout) => {
                if (err) {
                    resolve(isMuted);
                    return;
                }
                try {
                    const muted = stdout.trim().toLowerCase() === 'true';
                    resolve(muted);
                } catch (e) {
                    resolve(isMuted);
                }
            });
        } else if (IS_DOCKER || process.platform === 'linux') {
            // Linux/Docker 使用 amixer 获取静音状态
            exec('amixer -D default get Master | grep -o "\\[off\\]" | head -1', (err, stdout) => {
                if (err) {
                    resolve(isMuted);
                    return;
                }
                try {
                    const muted = stdout.trim() === '[off]';
                    resolve(muted);
                } catch (e) {
                    resolve(isMuted);
                }
            });
        } else {
            resolve(isMuted);
        }
    });
}

function getAudioDevices() {
    return new Promise((resolve) => {
        const devices = [];

        if (process.platform === 'win32') {
            // 使用 chcp 65001 设置 UTF-8 编码，确保中文正确输出
            exec('powershell -command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-WmiObject Win32_SoundDevice | Select-Object Name, DeviceID | ConvertTo-Json"', { encoding: 'buffer' }, (err, stdout) => {
                if (err) {
                    resolve([{ id: 'default', name: '默认声卡' }]);
                    return;
                }
                try {
                    // 尝试用 UTF-8 解码
                    let utf8Output = iconv.decode(stdout, 'utf-8');
                    // 如果解码结果有乱码，尝试 GBK
                    if (utf8Output.includes('\uFFFD')) {
                        utf8Output = iconv.decode(stdout, 'gbk');
                    }
                    const parsed = JSON.parse(utf8Output);
                    const soundDevices = Array.isArray(parsed) ? parsed : [parsed];
                    soundDevices.forEach((device, index) => {
                        devices.push({
                            id: device.DeviceID || `device_${index}`,
                            name: device.Name || '未知设备'
                        });
                    });
                } catch (e) {
                    devices.push({ id: 'default', name: '默认声卡' });
                }
                if (devices.length === 0) {
                    devices.push({ id: 'default', name: '默认声卡' });
                }
                resolve(devices);
            });
        } else if (IS_DOCKER || process.platform === 'linux') {
            // Docker 或 Linux 环境，使用 ALSA
            exec('aplay -l 2>/dev/null', (err, stdout) => {
                if (err || !stdout) {
                    resolve([{ id: 'default', name: '默认声卡 (ALSA)' }]);
                    return;
                }
                const lines = stdout.split('\n').filter(line => line.trim());
                if (lines.length === 0) {
                    resolve([{ id: 'default', name: '默认声卡 (ALSA)' }]);
                    return;
                }

                // 解析 ALSA 设备列表
                // aplay -l 输出格式示例:
                // card 0: PCH [HDA Intel PCH], device 0: ALC1220 Analog [ALC1220 Analog]
                // card 1: NVidia [HDA NVidia], device 0: HDMI 0 [HDMI 0]
                const foundCards = new Set();

                // 按行解析，寻找 card X: 开头的行
                lines.forEach(line => {
                    const cardMatch = line.match(/^card\s+(\d+):\s+(.+)$/i);
                    if (cardMatch) {
                        const cardId = cardMatch[1];
                        const restOfLine = cardMatch[2];

                        if (!foundCards.has(cardId)) {
                            foundCards.add(cardId);

                            // 尝试分离设备名称和卡名称
                            // 格式: "PCH [HDA Intel PCH], device 0: ALC1220 Analog [ALC1220 Analog]"
                            // 或者: "NVidia [HDA NVidia], device 0: HDMI 0 [HDMI 0]"

                            const parts = restOfLine.split(',');
                            let cardName = restOfLine;
                            let deviceName = '';

                            if (parts.length >= 2) {
                                cardName = parts[0].trim();
                                deviceName = parts.slice(1).join(',').replace(/device\s+\d+:\s*/gi, '').trim();
                            }

                            devices.push({
                                id: `hw:${cardId}`,
                                name: `${cardName} - ${deviceName}`
                            });
                        }
                    }
                });

                if (devices.length === 0) {
                    devices.push({ id: 'default', name: '默认声卡 (ALSA)' });
                }

                // 输出所有识别到的声卡到日志
                console.log('🎵 识别到的声卡设备:');
                devices.forEach((device, index) => {
                    console.log(`  ${index + 1}. ID: ${device.id}, 名称: ${device.name}`);
                });

                resolve(devices);
            });
        } else if (process.platform === 'darwin') {
            exec('system_profiler SPAudioDataType | grep -i "device name"', (err, stdout) => {
                if (err || !stdout) {
                    resolve([{ id: 'default', name: '默认声卡' }]);
                    return;
                }
                const lines = stdout.split('\n').filter(line => line.trim());
                lines.forEach((line, index) => {
                    const name = line.replace(/.*device name:\s*/i, '').trim();
                    if (name) {
                        devices.push({
                            id: `device_${index}`,
                            name: name
                        });
                    }
                });
                if (devices.length === 0) {
                    devices.push({ id: 'default', name: '默认声卡' });
                }
                resolve(devices);
            });
        } else {
            resolve([{ id: 'default', name: '默认声卡' }]);
        }
    });
}

app.get('/api/audio-devices', async (req, res) => {
    try {
        const devices = await getAudioDevices();
        res.json({
            success: true,
            devices,
            currentDevice: currentAudioDevice
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
            devices: [{ id: 'default', name: '默认声卡' }],
            currentDevice: 'default'
        });
    }
});

app.post('/api/audio-device', requireAuth, (req, res) => {
    const { deviceId } = req.body;

    if (!deviceId) {
        return res.status(400).json({ success: false, error: '设备 ID 不能为空' });
    }

    currentAudioDevice = deviceId;
    console.log(`🔊 声卡设备设置为：${currentAudioDevice}`);
    
    saveConfig();

    res.json({
        success: true,
        message: `已选择声卡设备：${deviceId}`,
        deviceId: currentAudioDevice
    });
});

app.get('/api/volume', async (req, res) => {
    const systemVolume = await getSystemVolume();
    const systemMuted = await getSystemMuted();
    res.json({ success: true, volume: systemVolume, muted: systemMuted });
});

app.post('/api/volume', async (req, res) => {
    const { volume } = req.body;

    if (volume === undefined || volume < 0 || volume > 100) {
        return res.status(400).json({ success: false, error: '音量必须在 0-100 之间' });
    }

    currentVolume = volume;
    console.log(`🔊 音量设置为：${currentVolume}%`);

    // 在 Linux/Docker 中，可以使用 amixer 调整系统音量
    if (IS_DOCKER && process.platform !== 'win32' && process.platform !== 'darwin') {
        // 先检查当前是否处于静音状态，如果是则先取消静音
        const currentMuted = await getSystemMuted();
        if (currentMuted) {
            console.log(`🔇 当前处于静音状态，先取消静音`);
            exec(`amixer -D default sset Master unmute`, (err) => {
                if (err) {
                    console.log(`⚠️  取消静音失败：${err.message}`);
                } else {
                    console.log(`✅ 已取消静音`);
                    isMuted = false;
                }
            });
        }
        
        exec(`amixer -D default sset Master ${volume}%`, (err) => {
            if (err) {
                console.log(`⚠️  系统音量调整失败：${err.message}`);
            } else {
                console.log(`✅ 系统音量已调整为 ${volume}%`);
            }
        });
    }

    res.json({ success: true, volume: currentVolume, muted: false });
});

// 静音切换API
app.post('/api/mute', async (req, res) => {
    // 先获取实际静音状态，再进行切换
    const currentMuted = await getSystemMuted();
    isMuted = !currentMuted;
    console.log(`🔇 静音状态：${isMuted ? '已静音' : '已取消静音'}`);
    
    // 在 Linux/Docker 中，可以使用 amixer 切换静音
    if (IS_DOCKER && process.platform !== 'win32' && process.platform !== 'darwin') {
        exec(`amixer -D default sset Master ${isMuted ? 'mute' : 'unmute'}`, (err) => {
            if (err) {
                console.log(`⚠️  静音切换失败：${err.message}`);
            } else {
                console.log(`✅ 静音状态已切换：${isMuted ? '静音' : '取消静音'}`);
            }
        });
    }

    res.json({ success: true, muted: isMuted });
});

app.post('/api/test-audio', requireAuth, async (req, res) => {
    const { deviceId } = req.body;
    const device = deviceId || 'default';

    console.log(`🔊 开始测试声卡：${device}`);

    try {
        // 生成测试音频率（1000Hz 正弦波）
        const testSound = '/tmp/test_sound.wav';

        // 使用 aplay 播放测试音
        if (IS_DOCKER || process.platform === 'linux') {
            // 在 Linux/Docker 中使用 speaker-test 或 aplay
            const testCommand = `speaker-test -t wav -c 2 -l 1 -D ${device} 2>&1 || echo "speaker-test not available"`;

            exec(testCommand, (err, stdout, stderr) => {
                if (err) {
                    console.log(`⚠️  测试命令执行失败：${err.message}`);
                }

                // 尝试使用 aplay 播放静音文件作为测试
                const aplayTest = `aplay -D ${device} -q /dev/zero 2>&1 & sleep 1 && kill $! 2>/dev/null; echo "Test completed"`;
                exec(aplayTest, (err2) => {
                    if (err2) {
                        console.log(`⚠️  aplay 测试失败：${err2.message}`);
                    }
                });

                res.json({
                    success: true,
                    message: `正在测试声卡设备：${device}`,
                    device: device,
                    output: stdout || stderr || '测试命令已发送'
                });
            });
        } else if (process.platform === 'win32') {
            // Windows 使用 PowerShell 测试
            res.json({
                success: false,
                message: 'Windows 环境不支持此测试',
                device: device
            });
        } else {
            res.json({
                success: false,
                message: '不支持的操作系统',
                device: device
            });
        }
    } catch (error) {
        console.error('声卡测试失败:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            device: device
        });
    }
});

// 配置系统更新文件上传
const updateStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const upgradeDir = path.join(__dirname, 'upgrades');
        if (!fs.existsSync(upgradeDir)) {
            fs.mkdirSync(upgradeDir, { recursive: true });
        }
        cb(null, upgradeDir);
    },
    filename: (req, file, cb) => {
        let originalName = file.originalname;

        try {
            originalName = decodeURIComponent(originalName);
        } catch (e) {
        }

        originalName = Buffer.from(originalName, 'latin1').toString('utf8');

        const timestamp = Date.now();
        const ext = path.extname(originalName);
        const nameWithoutExt = path.basename(originalName, ext);
        const safeName = `${nameWithoutExt}_${timestamp}${ext}`;

        cb(null, safeName);
    }
});

const updateUpload = multer({
    storage: updateStorage,
    limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
    fileFilter: (req, file, cb) => {
        if (file.originalname.endsWith('.zip')) {
            cb(null, true);
        } else {
            cb(new Error('只支持 ZIP 格式的更新包'));
        }
    }
});

// 系统更新 API - 上传 ZIP 包并解压替换
app.post('/api/system-update', requireAuth, updateUpload.single('file'), async (req, res) => {
    let upgradeFilePath = null;
    let tempExtractDir = null;
    
    try {
        console.log('===== 开始系统更新 =====');

        if (!req.file) {
            console.error('更新失败：未选择更新包文件');
            return res.status(400).json({ error: '请选择更新包文件' });
        }

        upgradeFilePath = req.file.path;
        const fileName = req.file.originalname;

        console.log(`更新包已保存: ${upgradeFilePath}, 大小: ${req.file.size} bytes`);

        console.log('正在验证更新包...');
        const validationResult = validateUpdatePackage(upgradeFilePath);
        if (!validationResult.valid) {
            console.error(`更新包验证失败: ${validationResult.message}`);
            if (upgradeFilePath && fs.existsSync(upgradeFilePath)) {
                fs.unlinkSync(upgradeFilePath);
            }
            return res.status(400).json({ error: validationResult.message });
        }
        console.log('更新包验证通过:', validationResult.version);

        tempExtractDir = path.join(__dirname, 'temp', 'extract');
        if (fs.existsSync(tempExtractDir)) {
            fs.rmSync(tempExtractDir, { recursive: true, force: true });
            console.log('已清理旧的临时解压目录');
        }
        fs.mkdirSync(tempExtractDir, { recursive: true });
        console.log(`创建临时解压目录: ${tempExtractDir}`);

        broadcastUpdateProgress({ type: 'extract_start', message: '正在解压更新包...' });
        console.log('正在解压更新包...');
        const zip = new AdmZip(upgradeFilePath);
        const zipEntries = zip.getEntries();

        for (let i = 0; i < zipEntries.length; i++) {
            const entry = zipEntries[i];
            const entryName = entry.entryName;
            const filePath = path.join(tempExtractDir, entryName);

            if (entry.isDirectory) {
                if (!fs.existsSync(filePath)) {
                    fs.mkdirSync(filePath, { recursive: true });
                }
            } else {
                const fileDir = path.dirname(filePath);
                if (!fs.existsSync(fileDir)) {
                    fs.mkdirSync(fileDir, { recursive: true });
                }
                fs.writeFileSync(filePath, entry.getData());
            }
            
            if (i % 50 === 0) {
                const percent = Math.round((i / zipEntries.length) * 100);
                broadcastUpdateProgress({
                    type: 'extract_progress',
                    percent,
                    message: `解压中... ${percent}% (${i}/${zipEntries.length} 文件)`
                });
            }
        }
        broadcastUpdateProgress({ type: 'extract_complete', message: '解压完成，正在安装更新...' });
        console.log(`解压完成，共 ${zipEntries.length} 个文件`);

        console.log('正在清理旧文件...');
        const protectedItems = ['music', 'upgrades', 'temp', '.git', 'node_modules', 'data'];

        const rootItems = fs.readdirSync(__dirname);
        for (const item of rootItems) {
            if (protectedItems.includes(item)) continue;
            const itemPath = path.join(__dirname, item);
            try {
                const stat = fs.statSync(itemPath);
                if (stat.isDirectory()) {
                    fs.rmSync(itemPath, { recursive: true, force: true });
                } else {
                    fs.unlinkSync(itemPath);
                }
                console.log(`删除: ${item}`);
            } catch (e) {
                console.error(`删除失败: ${item}, ${e.message}`);
            }
        }

        const publicDir = path.join(__dirname, 'public');
        if (fs.existsSync(publicDir)) {
            const publicItems = fs.readdirSync(publicDir);
            for (const item of publicItems) {
                if (protectedItems.includes(item)) continue;
                const itemPath = path.join(publicDir, item);
                try {
                    const stat = fs.statSync(itemPath);
                    if (stat.isDirectory()) {
                        fs.rmSync(itemPath, { recursive: true, force: true });
                    } else {
                        fs.unlinkSync(itemPath);
                    }
                    console.log(`删除 public/${item}`);
                } catch (e) {
                    console.error(`删除失败: public/${item}, ${e.message}`);
                }
            }
        }

        console.log('正在复制新文件...');
        let copiedCount = 0;
        function copyFiles(srcDir, destDir) {
            if (!fs.existsSync(srcDir)) return;
            const items = fs.readdirSync(srcDir);
            for (const item of items) {
                const srcPath = path.join(srcDir, item);
                const destPath = path.join(destDir, item);

                if (item === 'music' || item === 'upgrades' || item === 'temp' || item === '.git' || item === 'data') {
                    continue;
                }

                const stat = fs.statSync(srcPath);
                if (stat.isDirectory()) {
                    fs.mkdirSync(destPath, { recursive: true });
                    copyFiles(srcPath, destPath);
                } else {
                    fs.copyFileSync(srcPath, destPath);
                    copiedCount++;
                }
            }
        }

        copyFiles(tempExtractDir, __dirname);
        console.log(`复制完成，共复制 ${copiedCount} 个文件`);

        try {
            fs.rmSync(tempExtractDir, { recursive: true, force: true });
            console.log('临时目录已清理');
        } catch (e) {
            console.warn('清理临时目录失败:', e.message);
        }

        try {
            const upgradeDir = path.join(__dirname, 'upgrades');
            if (fs.existsSync(upgradeDir)) {
                const upgradeFiles = fs.readdirSync(upgradeDir)
                    .filter(f => f.endsWith('.zip'))
                    .map(f => ({
                        name: f,
                        path: path.join(upgradeDir, f),
                        mtime: fs.statSync(path.join(upgradeDir, f)).mtime
                    }))
                    .sort((a, b) => b.mtime - a.mtime);

                if (upgradeFiles.length > 3) {
                    upgradeFiles.slice(3).forEach(f => {
                        try {
                            fs.unlinkSync(f.path);
                            console.log('删除旧升级包:', f.name);
                        } catch (e) {
                            console.warn('删除旧升级包失败:', f.name, e.message);
                        }
                    });
                }
            }
        } catch (e) {
            console.warn('清理旧升级包失败:', e.message);
        }

        console.log(`===== 系统更新完成 (版本: ${validationResult.version}) =====`);
        
        res.json({ success: true, message: '系统更新成功，请重启容器以应用更新', version: validationResult.version });

        // 在Docker环境下，直接退出让容器自动重启（依赖restart策略）
        // 在非Docker环境下，尝试重启进程
        setTimeout(() => {
            try {
                if (IS_DOCKER) {
                    console.log('Docker环境：退出进程，容器将自动重启');
                    stopMusic();
                    process.exit(0);
                } else {
                    console.log('非Docker环境：尝试重启进程');
                    const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
                        detached: true,
                        stdio: ['ignore', 'inherit', 'inherit']
                    });

                    child.unref();

                    setTimeout(() => {
                        stopMusic();
                        process.exit(0);
                    }, 1000);
                }
            } catch (exitError) {
                console.error('重启过程中发生错误:', exitError);
                process.exit(1);
            }
        }, 1000);

    } catch (error) {
        console.error('===== 系统更新失败 =====');
        console.error('错误信息:', error.message);
        console.error('错误堆栈:', error.stack);
        
        // 清理临时文件
        try {
            if (tempExtractDir && fs.existsSync(tempExtractDir)) {
                fs.rmSync(tempExtractDir, { recursive: true, force: true });
            }
        } catch (cleanupError) {
            console.error('清理临时文件失败:', cleanupError.message);
        }
        
        res.status(500).json({ 
            error: '系统更新失败: ' + error.message,
            details: error.stack ? error.stack.substring(0, 500) : ''
        });
    }
});

// 验证更新包
function validateUpdatePackage(zipPath, isSourceZip = false) {
    let versionInfo = null;
    try {
        const zip = new AdmZip(zipPath);
        const entries = zip.getEntries();

        if (isSourceZip) {
            
            // 源码 ZIP 验证（路径会有嵌套目录前缀，如 nas-local-music-player-1.0.0/version.json）
            const versionEntry = entries.find(e => e.entryName.endsWith('/version.json') || e.entryName.endsWith('version.json'));
            if (!versionEntry) {
                console.log('GitHub ZIP 文件列表:', entries.slice(0, 10).map(e => e.entryName));
                return { valid: false, message: '更新包缺少 version.json 文件' };
            }

            const versionContent = versionEntry.getData().toString('utf8').replace(/^\uFEFF/, '');
            try {
                versionInfo = JSON.parse(versionContent);
            } catch {
                return { valid: false, message: 'version.json 格式无效' };
            }

            if (!versionInfo.version) {
                return { valid: false, message: 'version.json 缺少 version 字段' };
            }

            const serverEntry = entries.find(e => e.entryName.endsWith('/server.js') || e.entryName === 'server.js');
            if (!serverEntry) {
                return { valid: false, message: '更新包缺少 server.js 文件' };
            }

            const publicEntry = entries.find(e => e.entryName.includes('/public/'));
            if (!publicEntry) {
                return { valid: false, message: '更新包缺少 public 目录' };
            }
        } else {
            // 手动更新 ZIP 验证（根目录直接是文件）
            const versionEntry = entries.find(e => e.entryName === 'version.json');
            if (!versionEntry) {
                return { valid: false, message: '更新包缺少 version.json 文件' };
            }

            const versionContent = versionEntry.getData().toString('utf8').replace(/^\uFEFF/, '');
            try {
                versionInfo = JSON.parse(versionContent);
            } catch {
                return { valid: false, message: 'version.json 格式无效' };
            }

            if (!versionInfo.version) {
                return { valid: false, message: 'version.json 缺少 version 字段' };
            }

            const serverEntry = entries.find(e => e.entryName === 'server.js');
            if (!serverEntry) {
                return { valid: false, message: '更新包缺少 server.js 文件' };
            }

            const publicEntry = entries.find(e => e.entryName.startsWith('public/'));
            if (!publicEntry) {
                return { valid: false, message: '更新包缺少 public 目录' };
            }
        }

        return {
            valid: true,
            message: '验证通过',
            version: versionInfo ? versionInfo.version : 'unknown',
            packageName: path.basename(zipPath)
        };
    } catch (error) {
        return { valid: false, message: '更新包解压失败: ' + error.message };
    }
}

// 获取当前版本信息
app.get('/api/version', (req, res) => {
    try {
        const versionFile = path.join(__dirname, 'version.json');
        if (fs.existsSync(versionFile)) {
            const versionInfo = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
            res.json({ success: true, ...versionInfo });
        } else {
            res.json({ success: false, error: '版本文件不存在' });
        }
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// 检查远程更新
app.get('/api/check-update', (req, res) => {
    try {
        const versionFile = path.join(__dirname, 'version.json');
        let currentVersion = 'unknown';
        
        if (fs.existsSync(versionFile)) {
            const versionInfo = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
            currentVersion = versionInfo.version;
        }

        // 从 GitHub 获取最新版本
        const options = {
            hostname: 'api.github.com',
            path: '/repos/RONGLINC93/nas-local-music-player/releases/latest',
            method: 'GET',
            headers: {
                'User-Agent': 'NAS-Local-Music-Player'
            }
        };

        const request = https.request(options, (response) => {
            let data = '';
            
            response.on('data', (chunk) => {
                data += chunk;
            });
            
            response.on('end', () => {
                try {
                    if (response.statusCode === 200) {
                        const release = JSON.parse(data);
                        const latestVersion = release.tag_name.replace(/^v/, '');
                        const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;
                        
                        res.json({
                            success: true,
                            currentVersion,
                            latestVersion,
                            hasUpdate,
                            releaseNotes: release.body || '',
                            publishedAt: release.published_at,
                            downloadUrl: release.html_url
                        });
                    } else {
                        res.json({
                            success: false,
                            currentVersion,
                            error: '无法获取最新版本信息'
                        });
                    }
                } catch (error) {
                    res.json({
                        success: false,
                        currentVersion,
                        error: '解析版本信息失败: ' + error.message
                    });
                }
            });
        });

        request.on('error', (error) => {
            res.json({
                success: false,
                currentVersion,
                error: '网络请求失败: ' + error.message
            });
        });

        request.setTimeout(5000, () => {
            request.destroy();
            res.json({
                success: false,
                currentVersion,
                error: '请求超时'
            });
        });

        request.end();
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// 版本号比较 (返回 1: v1 > v2, -1: v1 < v2, 0: v1 == v2)
function compareVersions(v1, v2) {
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);
    const maxLen = Math.max(parts1.length, parts2.length);
    
    for (let i = 0; i < maxLen; i++) {
        const n1 = parts1[i] || 0;
        const n2 = parts2[i] || 0;
        if (n1 > n2) return 1;
        if (n1 < n2) return -1;
    }
    return 0;
}

// 下载并自动更新
app.post('/api/auto-update', requireAuth, async (req, res) => {
    let upgradeFilePath = null;
    let tempExtractDir = null;
    
    try {
        console.log('===== 开始自动更新 =====');

        // 先获取最新版本信息
        const versionFile = path.join(__dirname, 'version.json');
        let currentVersion = 'unknown';
        if (fs.existsSync(versionFile)) {
            const versionInfo = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
            currentVersion = versionInfo.version;
        }

        // 获取 GitHub 最新版本
        const releaseInfo = await getLatestRelease();
        if (!releaseInfo) {
            return res.status(500).json({ error: '无法获取最新版本信息' });
        }

        const latestVersion = releaseInfo.tag_name.replace(/^v/, '');
        const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;
        
        if (!hasUpdate) {
            return res.json({ success: true, message: '当前已是最新版本', currentVersion });
        }

        // 使用 GitHub 源码 ZIP 地址
        const zipUrl = `https://github.com/RONGLINC93/nas-local-music-player/archive/refs/tags/${releaseInfo.tag_name}.zip`;
        const zipFileName = `update-${latestVersion}.zip`;

        console.log(`正在下载更新包: ${zipUrl}`);

        // 下载更新包
        const upgradeDir = path.join(__dirname, 'upgrades');
        if (!fs.existsSync(upgradeDir)) {
            fs.mkdirSync(upgradeDir, { recursive: true });
        }

        upgradeFilePath = path.join(upgradeDir, zipFileName);
        
        broadcastUpdateProgress({ type: 'download_start', message: '开始下载更新包...' });
        
        await downloadFile(zipUrl, upgradeFilePath, (downloaded, total) => {
            const percent = Math.round((downloaded / total) * 100);
            const downloadedMB = (downloaded / 1024 / 1024).toFixed(2);
            const totalMB = (total / 1024 / 1024).toFixed(2);
            broadcastUpdateProgress({
                type: 'download_progress',
                percent,
                downloaded: downloadedMB,
                total: totalMB,
                message: `下载中... ${percent}% (${downloadedMB}MB / ${totalMB}MB)`
            });
        });

        broadcastUpdateProgress({ type: 'download_complete', message: '下载完成，正在验证...' });

        // 验证更新包
        console.log('正在验证更新包...');
        const validationResult = validateUpdatePackage(upgradeFilePath, true);
        if (!validationResult.valid) {
            console.error(`更新包验证失败: ${validationResult.message}`);
            if (upgradeFilePath && fs.existsSync(upgradeFilePath)) {
                fs.unlinkSync(upgradeFilePath);
            }
            return res.status(400).json({ error: validationResult.message });
        }
        console.log('更新包验证通过:', validationResult.version);

        // 解压
        tempExtractDir = path.join(__dirname, 'temp', 'extract');
        if (fs.existsSync(tempExtractDir)) {
            fs.rmSync(tempExtractDir, { recursive: true, force: true });
        }
        fs.mkdirSync(tempExtractDir, { recursive: true });

        broadcastUpdateProgress({ type: 'extract_start', message: '正在解压更新包...' });
        console.log('正在解压更新包...');
        const zip = new AdmZip(upgradeFilePath);
        const zipEntries = zip.getEntries();

        for (let i = 0; i < zipEntries.length; i++) {
            const entry = zipEntries[i];
            const entryName = entry.entryName;
            const filePath = path.join(tempExtractDir, entryName);

            if (entry.isDirectory) {
                if (!fs.existsSync(filePath)) {
                    fs.mkdirSync(filePath, { recursive: true });
                }
            } else {
                const fileDir = path.dirname(filePath);
                if (!fs.existsSync(fileDir)) {
                    fs.mkdirSync(fileDir, { recursive: true });
                }
                fs.writeFileSync(filePath, entry.getData());
            }
            
            if (i % 50 === 0) {
                const percent = Math.round((i / zipEntries.length) * 100);
                broadcastUpdateProgress({
                    type: 'extract_progress',
                    percent,
                    message: `解压中... ${percent}% (${i}/${zipEntries.length} 文件)`
                });
            }
        }
        broadcastUpdateProgress({ type: 'extract_complete', message: '解压完成，正在安装更新...' });
        console.log(`解压完成，共 ${zipEntries.length} 个文件`);

        // GitHub 源码 ZIP 解压后会有嵌套目录，需要提取出来
        const extractedItems = fs.readdirSync(tempExtractDir);
        let sourceDir = tempExtractDir;
        
        if (extractedItems.length === 1) {
            const singleItem = path.join(tempExtractDir, extractedItems[0]);
            if (fs.statSync(singleItem).isDirectory()) {
                sourceDir = singleItem;
                console.log(`检测到嵌套目录，使用: ${sourceDir}`);
            }
        }

        // 清理旧文件
        console.log('正在清理旧文件...');
        const protectedItems = ['music', 'upgrades', 'temp', '.git', 'node_modules', 'data'];

        const rootItems = fs.readdirSync(__dirname);
        for (const item of rootItems) {
            if (protectedItems.includes(item)) continue;
            const itemPath = path.join(__dirname, item);
            try {
                const stat = fs.statSync(itemPath);
                if (stat.isDirectory()) {
                    fs.rmSync(itemPath, { recursive: true, force: true });
                } else {
                    fs.unlinkSync(itemPath);
                }
                console.log(`删除: ${item}`);
            } catch (e) {
                console.error(`删除失败: ${item}, ${e.message}`);
            }
        }

        const publicDir = path.join(__dirname, 'public');
        if (fs.existsSync(publicDir)) {
            const publicItems = fs.readdirSync(publicDir);
            for (const item of publicItems) {
                if (protectedItems.includes(item)) continue;
                const itemPath = path.join(publicDir, item);
                try {
                    const stat = fs.statSync(itemPath);
                    if (stat.isDirectory()) {
                        fs.rmSync(itemPath, { recursive: true, force: true });
                    } else {
                        fs.unlinkSync(itemPath);
                    }
                    console.log(`删除 public/${item}`);
                } catch (e) {
                    console.error(`删除失败: public/${item}, ${e.message}`);
                }
            }
        }

        // 复制新文件
        broadcastUpdateProgress({ type: 'install_start', message: '正在安装更新...' });
        console.log('正在复制新文件...');
        let copiedCount = 0;
        let totalFiles = 0;
        
        // 先统计总文件数
        function countFiles(srcDir) {
            if (!fs.existsSync(srcDir)) return 0;
            let count = 0;
            const items = fs.readdirSync(srcDir);
            for (const item of items) {
                if (item === 'music' || item === 'upgrades' || item === 'temp' || item === '.git' || item === 'data' || item === 'node_modules') continue;
                const srcPath = path.join(srcDir, item);
                const stat = fs.statSync(srcPath);
                if (stat.isDirectory()) {
                    count += countFiles(srcPath);
                } else {
                    count++;
                }
            }
            return count;
        }
        
        totalFiles = countFiles(sourceDir);
        let processedFiles = 0;
        
        function copyFiles(srcDir, destDir) {
            if (!fs.existsSync(srcDir)) return;
            const items = fs.readdirSync(srcDir);
            for (const item of items) {
                const srcPath = path.join(srcDir, item);
                const destPath = path.join(destDir, item);

                if (item === 'music' || item === 'upgrades' || item === 'temp' || item === '.git' || item === 'data' || item === 'node_modules') {
                    continue;
                }

                const stat = fs.statSync(srcPath);
                if (stat.isDirectory()) {
                    fs.mkdirSync(destPath, { recursive: true });
                    copyFiles(srcPath, destPath);
                } else {
                    fs.copyFileSync(srcPath, destPath);
                    copiedCount++;
                    processedFiles++;
                    
                    if (processedFiles % 50 === 0 && totalFiles > 0) {
                        const percent = Math.round((processedFiles / totalFiles) * 100);
                        broadcastUpdateProgress({
                            type: 'install_progress',
                            percent,
                            message: `安装中... ${percent}% (${processedFiles}/${totalFiles} 文件)`
                        });
                    }
                }
            }
        }

        copyFiles(sourceDir, __dirname);
        broadcastUpdateProgress({ type: 'install_complete', message: '更新安装完成，正在重启服务...' });
        console.log(`复制完成，共复制 ${copiedCount} 个文件`);

        // 清理临时目录
        try {
            fs.rmSync(tempExtractDir, { recursive: true, force: true });
            console.log('临时目录已清理');
        } catch (e) {
            console.warn('清理临时目录失败:', e.message);
        }

        console.log(`===== 自动更新完成 (版本: ${latestVersion}) =====`);
        
        res.json({ success: true, message: '更新成功，服务器正在重启', version: latestVersion });

        // 重启服务
        setTimeout(() => {
            try {
                if (IS_DOCKER) {
                    console.log('Docker环境：退出进程，容器将自动重启');
                    stopMusic();
                    process.exit(0);
                } else {
                    console.log('非Docker环境：尝试重启进程');
                    const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
                        detached: true,
                        stdio: ['ignore', 'inherit', 'inherit']
                    });

                    child.unref();

                    setTimeout(() => {
                        stopMusic();
                        process.exit(0);
                    }, 1000);
                }
            } catch (exitError) {
                console.error('重启过程中发生错误:', exitError);
                process.exit(1);
            }
        }, 1000);

    } catch (error) {
        console.error('===== 自动更新失败 =====');
        console.error('错误信息:', error.message);
        console.error('错误堆栈:', error.stack);
        
        try {
            if (tempExtractDir && fs.existsSync(tempExtractDir)) {
                fs.rmSync(tempExtractDir, { recursive: true, force: true });
            }
            if (upgradeFilePath && fs.existsSync(upgradeFilePath)) {
                fs.unlinkSync(upgradeFilePath);
            }
        } catch (cleanupError) {
            console.error('清理临时文件失败:', cleanupError.message);
        }
        
        res.status(500).json({ 
            error: '自动更新失败: ' + error.message,
            details: error.stack ? error.stack.substring(0, 500) : ''
        });
    }
});

// 获取 GitHub 最新版本
function getLatestRelease() {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.github.com',
            path: '/repos/RONGLINC93/nas-local-music-player/releases/latest',
            method: 'GET',
            headers: {
                'User-Agent': 'NAS-Local-Music-Player'
            }
        };

        const request = https.request(options, (response) => {
            let data = '';
            
            response.on('data', (chunk) => {
                data += chunk;
            });
            
            response.on('end', () => {
                try {
                    if (response.statusCode === 200) {
                        resolve(JSON.parse(data));
                    } else {
                        resolve(null);
                    }
                } catch (error) {
                    resolve(null);
                }
            });
        });

        request.on('error', (error) => {
            resolve(null);
        });

        request.setTimeout(10000, () => {
            request.destroy();
            resolve(null);
        });

        request.end();
    });
}

// 下载文件
function downloadFile(url, dest, onProgress) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const options = {
            hostname: parsedUrl.hostname,
            path: parsedUrl.pathname,
            method: 'GET',
            headers: {
                'User-Agent': 'NAS-Local-Music-Player'
            }
        };

        const request = https.request(options, (response) => {
            if (response.statusCode === 302 || response.statusCode === 301) {
                // 处理重定向
                downloadFile(response.headers.location, dest, onProgress).then(resolve).catch(reject);
                return;
            }

            if (response.statusCode !== 200) {
                reject(new Error(`下载失败，HTTP 状态码: ${response.statusCode}`));
                return;
            }

            const totalBytes = parseInt(response.headers['content-length'], 10);
            let downloadedBytes = 0;

            const fileStream = fs.createWriteStream(dest);
            
            response.on('data', (chunk) => {
                downloadedBytes += chunk.length;
                if (onProgress && totalBytes) {
                    onProgress(downloadedBytes, totalBytes);
                }
            });

            response.pipe(fileStream);

            fileStream.on('finish', () => {
                fileStream.close();
                resolve();
            });

            fileStream.on('error', (err) => {
                fs.unlink(dest, () => {});
                reject(err);
            });
        });

        request.on('error', (error) => {
            reject(error);
        });

        request.setTimeout(60000, () => {
            request.destroy();
            reject(new Error('下载超时'));
        });

        request.end();
    });
}

// ==================== 在线音乐搜索和播放 ====================

// 音源文件目录
const sourceFilesDir = path.join(__dirname, 'online_sources');
if (!fs.existsSync(sourceFilesDir)) {
    fs.mkdirSync(sourceFilesDir, { recursive: true });
    console.log(`📁 创建音源文件目录: ${sourceFilesDir}`);
}

// 自定义音源存储
let customSources = {};
let activeSourceIds = []; // 当前激活的音源ID列表（带.js扩展名）

// 安全地从上下文中提取数据
function decontextify(obj) {
    if (obj === null || obj === undefined) return obj;
    try {
        const str = JSON.stringify(obj);
        return str ? JSON.parse(str) : String(obj);
    } catch (e2) {
        return String(obj);
    }
}

// 创建 lx.request 包装器（使用原生 http/https）
function createLxRequest() {
    const httpModule = require('http');
    const httpsModule = require('https');
    
    return (url, options, callback) => {
        // 延迟解析 options 以避免 Proxy 问题
        let safeOptions;
        try {
            safeOptions = JSON.parse(JSON.stringify(options || {}));
        } catch {
            safeOptions = {};
        }
        
        const method = (safeOptions.method || 'get').toUpperCase();
        const timeout = safeOptions.timeout || 60000;
        const headers = safeOptions.headers || {};
        const body = safeOptions.body;
        const form = safeOptions.form;
        const formData = safeOptions.formData;
        
        let urlStr = typeof url === 'object' ? JSON.stringify(url) : url;
        
        const urlObj = new URL(urlStr);
        const isHttps = urlObj.protocol === 'https:';
        const protocol = isHttps ? httpsModule : httpModule;
        
        let postData = null;
        let contentType = headers['Content-Type'] || headers['content-type'];
        
        if (form) {
            // form 是键值对，需要转换为 URL 编码字符串
            const formStr = typeof form === 'string' ? form : new URLSearchParams(form).toString();
            postData = formStr;
            if (!contentType) contentType = 'application/x-www-form-urlencoded';
        } else if (formData) {
            postData = JSON.stringify(formData);
            if (!contentType) contentType = 'application/json';
        } else if (body) {
            if (typeof body === 'object') {
                postData = JSON.stringify(body);
                if (!contentType) contentType = 'application/json';
            } else {
                postData = body;
            }
        }
        
        const requestHeaders = { ...headers };
        if (contentType) {
            requestHeaders['Content-Type'] = contentType;
        }
        // 添加默认 User-Agent
        if (!requestHeaders['User-Agent']) {
            requestHeaders['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
        }
        
        const requestOptions = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: method,
            headers: requestHeaders,
            timeout: Math.min(timeout, 60000),
            rejectUnauthorized: false  // 忽略 HTTPS 证书错误
        };
        
        const req = protocol.request(requestOptions, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                try {
                    let parsedBody = data;
                    if (typeof data === 'string') {
                        try {
                            parsedBody = JSON.parse(data);
                        } catch { }
                    }
                    const safeResp = {
                        statusCode: res.statusCode,
                        statusMessage: res.statusMessage,
                        headers: res.headers,
                        body: parsedBody
                    };
                    // 确保返回的数据是安全的（切断原型链）
                    const safeBody = JSON.parse(JSON.stringify(parsedBody));
                    callback.call(null, null, safeResp, safeBody);
                } catch (error) {
                    callback.call(null, { message: error.message }, null, null);
                }
            });
        });
        
        req.on('error', (e) => {
            callback.call(null, { message: e.message || String(e) }, null, null);
        });
        
        req.on('timeout', () => {
            req.destroy();
            callback.call(null, { message: 'Request timeout' }, null, null);
        });
        
        if (postData) {
            req.write(postData);
        }
        req.end();
        
        // 返回取消函数
        return () => {
            req.destroy();
        };
    };
}

// 加载单个自定义音源脚本
async function loadCustomSource(scriptPath) {
    try {
        const script = fs.readFileSync(scriptPath, 'utf-8');
        
        console.log(`[CustomSource] 脚本长度: ${script.length} 字符`);
        
        // 从脚本注释中提取元数据
        const metadata = {};
        const commentMatch = script.match(/\/\*[*!]([\s\S]*?)\*\//);
        if (commentMatch) {
            const comment = commentMatch[1];
            const nameMatch = comment.match(/@name\s+(.+)/);
            if (nameMatch) metadata.name = nameMatch[1].trim();
            const verMatch = comment.match(/@version\s+(.+)/);
            if (verMatch) metadata.version = verMatch[1].trim();
        }
        
        let initResolve = null;
        let initReject = null;
        const initPromise = new Promise((resolve, reject) => {
            initResolve = resolve;
            initReject = reject;
        });
        
        const eventHandlers = new Map();
        let registeredSources = {};
        
        const lxDataInside = {
            version: '2.0.0',
            env: 'desktop',
            platform: 'web',
            currentScriptInfo: {
                name: metadata.name || 'Unknown',
                description: '',
                version: metadata.version || '1.0.0',
                author: '',
                homepage: '',
                rawScript: script,
            },
            EVENT_NAMES: {
                request: 'request',
                inited: 'inited',
                updateAlert: 'updateAlert'
            }
        };
        
        const lxUtils = {
            buffer: {
                from: (d, e) => Buffer.from(decontextify(d), decontextify(e)),
                bufToString: (b, f) => Buffer.isBuffer(b) ? b.toString(f) : Buffer.from(b, 'binary').toString(f)
            },
            crypto: {
                md5: (str) => crypto.createHash('md5').update((decontextify(str) || '')).digest('hex'),
                sha1: (str) => crypto.createHash('sha1').update((decontextify(str) || '')).digest('hex'),
                sha256: (str) => crypto.createHash('sha256').update((decontextify(str) || '')).digest('hex'),
                aesEncrypt: (buffer, mode, key, iv) => {
                    const dKey = decontextify(key);
                    const dIv = decontextify(iv);
                    const dBuffer = decontextify(buffer);
                    const algorithm = `aes-${dKey.length * 8}-${mode}`;
                    const cipher = crypto.createCipheriv(algorithm, dKey, dIv);
                    return Buffer.concat([cipher.update(dBuffer), cipher.final()]);
                },
                aesDecrypt: (buffer, mode, key, iv) => {
                    const dKey = decontextify(key);
                    const dIv = decontextify(iv);
                    const dBuffer = decontextify(buffer);
                    const algorithm = `aes-${dKey.length * 8}-${mode}`;
                    const decipher = crypto.createDecipheriv(algorithm, dKey, dIv);
                    return Buffer.concat([decipher.update(dBuffer), decipher.final()]);
                },
                aesEncrypt2: (buffer, mode, key, iv) => {
                    // 另一种 AES 加密实现（与 aesEncrypt 类似但使用不同的填充方式）
                    const dKey = decontextify(key);
                    const dIv = decontextify(iv);
                    const dBuffer = decontextify(buffer);
                    const algorithm = `aes-${dKey.length * 8}-${mode}`;
                    const cipher = crypto.createCipheriv(algorithm, dKey, dIv);
                    cipher.setAutoPadding(false);
                    return Buffer.concat([cipher.update(dBuffer), cipher.final()]);
                },
                aesDecrypt2: (buffer, mode, key, iv) => {
                    // 另一种 AES 解密实现（无填充）
                    const dKey = decontextify(key);
                    const dIv = decontextify(iv);
                    const dBuffer = decontextify(buffer);
                    const algorithm = `aes-${dKey.length * 8}-${mode}`;
                    const decipher = crypto.createDecipheriv(algorithm, dKey, dIv);
                    decipher.setAutoPadding(false);
                    return Buffer.concat([decipher.update(dBuffer), decipher.final()]);
                },
                rsaEncrypt: (buffer, key) => crypto.publicEncrypt(decontextify(key), decontextify(buffer)),
                rsaDecrypt: (buffer, key) => crypto.privateDecrypt(decontextify(key), decontextify(buffer)),
                randomBytes: (size) => crypto.randomBytes(size),
                hmac: (algorithm, key, data) => {
                    const dKey = decontextify(key);
                    const dData = decontextify(data);
                    return crypto.createHmac(algorithm, dKey).update(dData).digest('hex');
                }
            },
            zlib: {
                inflate: (buffer) => {
                    const zlib = require('zlib');
                    return zlib.inflateSync(decontextify(buffer));
                },
                deflate: (buffer) => {
                    const zlib = require('zlib');
                    return zlib.deflateSync(decontextify(buffer));
                },
                inflateRaw: (buffer) => {
                    const zlib = require('zlib');
                    return zlib.inflateRawSync(decontextify(buffer));
                },
                deflateRaw: (buffer) => {
                    const zlib = require('zlib');
                    return zlib.deflateRawSync(decontextify(buffer));
                }
            }
        };
        
        const lxRequestFn = createLxRequest();
        
        const lxObject = {
            ...lxDataInside,
            utils: lxUtils,
            request: lxRequestFn,
            send: (eventName, data) => {
                const dData = decontextify(data);
                if (eventName === 'inited') {
                    if (dData && dData.sources) {
                        registeredSources = dData.sources;
                        console.log(`[CustomSource] Registered sources:`, Object.keys(registeredSources).join(', '));
                    }
                    if (initResolve) initResolve();
                } else if (eventName === 'updateAlert') {
                    const error = new Error(`发现新版本,需要更新: ${JSON.stringify(dData)}`);
                    if (initReject) initReject(error);
                }
            },
            on: (eventName, handler) => {
                if (eventName === 'request') {
                    eventHandlers.set(eventName, handler);
                }
            }
        };
        
        const sandbox = {};
        sandbox.console = console;
        sandbox.setTimeout = setTimeout;
        sandbox.clearTimeout = clearTimeout;
        sandbox.setInterval = setInterval;
        sandbox.clearInterval = clearInterval;
        sandbox.Buffer = Buffer;
        sandbox.URL = URL;
        sandbox.URLSearchParams = URLSearchParams;
        sandbox.TextEncoder = TextEncoder;
        sandbox.TextDecoder = TextDecoder;
        sandbox.process = {
            nextTick: (fn, ...args) => setTimeout(() => fn(...args), 0),
            env: { NODE_ENV: process.env.NODE_ENV || 'production' }
        };
        sandbox.lx = lxObject;
        sandbox.global = sandbox;
        sandbox.window = sandbox;
        sandbox.globalThis = sandbox;
        sandbox.atob = (s) => Buffer.from(s, 'base64').toString('binary');
        sandbox.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
        sandbox.crypto = crypto;
        
        const vm = require('vm');
        const context = vm.createContext(sandbox);
        
        try {
            vm.runInContext(script, context, {
                filename: scriptPath,
                timeout: 10000
            });
            console.log(`[CustomSource] 脚本执行完成`);
        } catch (runError) {
            console.error(`[CustomSource] 脚本执行错误:`, runError.message);
            throw runError;
        }
        
        await Promise.race([
            initPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('初始化超时')), 3000))
        ]);
        
        console.log(`[CustomSource] 初始化完成`);
        
        return {
            name: metadata.name || 'Unknown',
            version: metadata.version || '1.0.0',
            sources: registeredSources,
            callRequest: async (action, source, info) => {
                try {
                    const handler = eventHandlers.get('request');
                    if (!handler) throw new Error('未注册 request 处理器');
                    const inputData = JSON.parse(JSON.stringify({ action, source, info }));
                    
                    const result = await new Promise((resolve, reject) => {
                        try {
                            const callback = (err, resp, body) => {
                                if (err) {
                                    reject(err);
                                } else {
                                    resolve(body);
                                }
                            };
                            const ret = handler(inputData, callback);
                            if (ret && typeof ret.then === 'function') {
                                ret.then(resolve).catch(reject);
                            } else if (ret !== undefined) {
                                resolve(ret);
                            }
                        } catch (e) {
                            reject(e);
                        }
                    });
                    
                    return decontextify(result);
                } catch (e) {
                    console.error(`[CustomSource] callRequest Error:`, e.message);
                    throw e;
                }
            }
        };
    } catch (error) {
        console.error(`[CustomSource] 加载失败:`, error.message);
        return null;
    }
}

// 加载自定义音源（统一入口）
async function loadCustomSources(filterFiles = null) {
    try {
        customSources = {};
        
        const files = fs.readdirSync(sourceFilesDir).filter(f => f.endsWith('.js'));
        
        // 如果有过滤列表，只加载指定的音源
        const filesToLoad = filterFiles ? files.filter(f => filterFiles.includes(f)) : files;
        
        // 更新激活的音源ID列表（保持.js扩展名）
        activeSourceIds = filesToLoad;
        
        console.log(`📂 加载音源文件:`, filesToLoad);
        
        let loadedCount = 0;
        
        for (const file of filesToLoad) {
            try {
                const filePath = path.join(sourceFilesDir, file);
                console.log(`[CustomSource] 尝试加载: ${file}`);
                const source = await loadCustomSource(filePath);
                if (source) {
                    console.log(`[CustomSource] ✓ 成功加载: ${source.name} v${source.version}`);
                    loadedCount++;
                    for (const platform of Object.keys(source.sources)) {
                        customSources[platform] = {
                            name: source.sources[platform].name || platform,
                            getPlayUrl: async (songInfo, type, quality) => {
                                try {
                                    const result = await source.callRequest('musicUrl', platform, {
                                        musicInfo: songInfo,
                                        quality: quality,
                                        type: type || quality
                                    });
                                    if (result && result.url) {
                                        return result;
                                    }
                                    return null;
                                } catch (error) {
                                    console.error(`[CustomSource] 获取播放链接失败:`, error.message);
                                    return null;
                                }
                            },
                            search: async (keyword, page, limit) => {
                                try {
                                    const result = await source.callRequest('search', platform, {
                                        keyword: keyword,
                                        page: page,
                                        limit: limit
                                    });
                                    if (result && result.list) {
                                        return {
                                            total: result.total || result.list.length * 10,
                                            list: result.list
                                        };
                                    } else if (Array.isArray(result)) {
                                        return {
                                            total: result.length * 10,
                                            list: result
                                        };
                                    }
                                    return null;
                                } catch (error) {
                                    console.error(`[CustomSource] 搜索失败:`, error.message);
                                    return null;
                                }
                            },
                            getLyric: async (songInfo, type) => {
                                try {
                                    console.log(`[CustomSource] 调用 lyric action, platform=${platform}, song=${songInfo.name || songInfo.songId}`);
                                    const result = await source.callRequest('lyric', platform, {
                                        musicInfo: songInfo
                                    });
                                    console.log(`[CustomSource] lyric 返回结果:`, JSON.stringify(result).substring(0, 200));
                                    if (result && (result.lrc || result.lyric || typeof result === 'string')) {
                                        return {
                                            lyric: result.lrc || result.lyric || result
                                        };
                                    }
                                    return null;
                                } catch (error) {
                                    console.error(`[CustomSource] 获取歌词失败:`, error.message);
                                    return null;
                                }
                            }
                        };
                    }
                }
            } catch (error) {
                console.error(`❌ 加载音源文件 ${file} 失败:`, error.message);
            }
        }
        
        console.log(`📦 已加载 ${Object.keys(customSources).length} 个自定义音源，激活的音源文件:`, activeSourceIds);
    } catch (error) {
        console.error('加载音源文件失败:', error.message);
    }
}

// 启动时加载音源（从设置中读取激活的音源）
function loadActiveSourcesOnStart() {
    const settingsPath = path.join(__dirname, 'data', 'online-settings.json');
    if (fs.existsSync(settingsPath)) {
        try {
            const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            if (settings.activeSources && settings.activeSources.length > 0) {
                console.log('📂 从设置中加载激活的音源:', settings.activeSources);
                loadCustomSources(settings.activeSources);
                return;
            }
        } catch (e) {
            console.log('⚠️ 读取设置失败，加载所有音源');
        }
    }
    // 如果没有设置，加载所有音源
    console.log('📂 加载所有音源文件');
    loadCustomSources();
}

// 支持的在线音乐源
const ONLINE_SOURCES = [
    { id: 'kw', name: '酷我音乐' },
    { id: 'kg', name: '酷狗音乐' },
    { id: 'tx', name: 'QQ音乐' },
    { id: 'wy', name: '网易云音乐' },
    { id: 'mg', name: '咪咕音乐' }
];

// 清理文件名中的非法字符
function sanitizeFileName(name) {
    if (!name) return '';
    return String(name).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
}

// 获取音源文件列表
app.get('/api/source-files', (req, res) => {
    try {
        const files = fs.readdirSync(sourceFilesDir)
            .filter(f => f.endsWith('.js'))
            .map(f => {
                const filePath = path.join(sourceFilesDir, f);
                const stats = fs.statSync(filePath);
                const content = fs.readFileSync(filePath, 'utf-8');
                
                // 尝试从脚本注释中提取元数据
                let sourceName = f.replace('.js', '');
                let sourceVersion = '';
                const commentMatch = content.match(/\/\*[*!]([\s\S]*?)\*\//);
                if (commentMatch) {
                    const comment = commentMatch[1];
                    const nameMatch = comment.match(/@name\s+(.+)/);
                    if (nameMatch) sourceName = nameMatch[1].trim();
                    const verMatch = comment.match(/@version\s+(.+)/);
                    if (verMatch) sourceVersion = verMatch[1].trim();
                }
                
                return {
                    name: f,
                    displayName: sourceName,
                    version: sourceVersion,
                    size: stats.size,
                    createdAt: stats.birthtime,
                    modifiedAt: stats.mtime
                };
            });
        
        res.json({ success: true, files });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ========== 新自定义音源管理 API（lx-music-sync-server 风格）==========
app.post('/api/custom-source/validate', requireAuth, (req, res) => {
    customSourceHandlers.handleValidate(req, res);
});

app.post('/api/custom-source/upload', requireAuth, (req, res) => {
    customSourceHandlers.handleUpload(req, res);
});

app.post('/api/custom-source/import', requireAuth, (req, res) => {
    customSourceHandlers.handleImport(req, res);
});

app.get('/api/custom-source/list', (req, res) => {
    const username = req.query.username;
    customSourceHandlers.handleList(req, res, username);
});

app.post('/api/custom-source/toggle', requireAuth, (req, res) => {
    customSourceHandlers.handleToggle(req, res);
});

app.post('/api/custom-source/reorder', requireAuth, (req, res) => {
    customSourceHandlers.handleReorder(req, res);
});

app.post('/api/custom-source/delete', requireAuth, (req, res) => {
    customSourceHandlers.handleDelete(req, res);
});

// 获取已加载的自定义音源信息
app.get('/api/custom-source/loaded', (req, res) => {
    try {
        const apis = userApi.getLoadedApis();
        res.json({ success: true, apis });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 删除音源文件
app.delete('/api/source-files/:filename', requireAuth, (req, res) => {
    try {
        const filename = req.params.filename;
        if (!filename.endsWith('.js')) {
            return res.status(400).json({ success: false, error: '只能删除 .js 文件' });
        }
        
        const filePath = path.join(sourceFilesDir, filename);
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ success: false, error: '文件不存在' });
        }
        
        fs.unlinkSync(filePath);
        
        // 重新加载音源
        loadCustomSources();
        
        res.json({ success: true, message: '文件已删除' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 应用选中的音源
app.post('/api/apply-sources', requireAuth, (req, res) => {
    try {
        const { sources } = req.body;
        
        if (!sources || !Array.isArray(sources) || sources.length === 0) {
            return res.status(400).json({ success: false, error: '请选择至少一个音源' });
        }
        
        // 保存选中的音源列表
        const settingsPath = path.join(__dirname, 'data', 'online-settings.json');
        const dataDir = path.join(__dirname, 'data');
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        
        // 读取现有设置
        let settings = {};
        if (fs.existsSync(settingsPath)) {
            try {
                settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            } catch (e) {
                // 忽略解析错误
            }
        }
        
        // 更新激活的音源列表
        settings.activeSources = sources;
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
        
        // 重新加载音源（只加载激活的）
        loadCustomSources(sources);
        
        res.json({ success: true, message: '音源已启用' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 上传音源文件
app.post('/api/upload-source', requireAuth, (req, res) => {
    try {
        const { filename, content } = req.body;
        
        if (!filename || !content) {
            return res.status(400).json({ success: false, error: '缺少文件名或内容' });
        }
        
        if (!filename.endsWith('.js')) {
            return res.status(400).json({ success: false, error: '只支持 .js 文件' });
        }
        
        const filePath = path.join(sourceFilesDir, filename);
        fs.writeFileSync(filePath, content, 'utf8');
        
        // 重新加载音源
        loadCustomSources();
        
        res.json({ success: true, message: '文件上传成功' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取在线设置
app.get('/api/online-settings', (req, res) => {
    try {
        const settingsPath = path.join(__dirname, 'data', 'online-settings.json');
        let settings = { pageSize: 20, activeSources: [] };
        
        if (fs.existsSync(settingsPath)) {
            settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        }
        
        res.json({ success: true, settings });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 保存在线设置
app.post('/api/online-settings', requireAuth, (req, res) => {
    try {
        const { pageSize } = req.body;
        const settingsPath = path.join(__dirname, 'data', 'online-settings.json');
        let settings = { pageSize: 20, activeSources: [] };
        
        if (fs.existsSync(settingsPath)) {
            settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        }
        
        settings.pageSize = parseInt(pageSize) || 20;
        
        const dataDir = path.join(__dirname, 'data');
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
        res.json({ success: true, message: '设置已保存' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取在线音乐排行榜
app.post('/api/online-rank', async (req, res) => {
    try {
        const { type = 'hot', source = 'kw', page = 1, limit = 20 } = req.body;
        
        const results = [];
        let total = 0;
        
        // 只获取指定平台的排行榜
        // 优先使用自定义音源中对应平台的搜索函数
        if (customSources[source] && typeof customSources[source].search === 'function') {
            try {
                let keyword = '';
                switch(type) {
                    case 'hot': keyword = '热门歌曲'; break;
                    case 'new': keyword = '新歌'; break;
                    case 'soaring': keyword = '飙升榜'; break;
                    case 'original': keyword = '原创音乐'; break;
                    default: keyword = '热门歌曲';
                }
                const searchResults = await customSources[source].search(keyword, page, limit);
                // 处理返回值可能是数组或对象
                if (Array.isArray(searchResults) && searchResults.length > 0) {
                    total = searchResults.length * 10;
                    results.push({
                        source: source,
                        sourceName: customSources[source].name || source,
                        list: searchResults
                    });
                } else if (searchResults && searchResults.list && searchResults.list.length > 0) {
                    total = searchResults.total || searchResults.list.length * 10;
                    results.push({
                        source: source,
                        sourceName: customSources[source].name || source,
                        list: searchResults.list
                    });
                }
            } catch (error) {
                console.error(`自定义音源 ${source} 排行榜获取失败:`, error.message);
            }
        }
        
        // 如果自定义音源没有结果，使用内置音源
        if (results.length === 0) {
            try {
                const searchResults = await getMusicRank(source, type, page, limit);
                if (searchResults && searchResults.list && searchResults.list.length > 0) {
                    total = searchResults.total || searchResults.list.length * 10;
                    results.push({
                        source: source,
                        sourceName: ONLINE_SOURCES.find(s => s.id === source)?.name || source,
                        list: searchResults.list
                    });
                }
            } catch (error) {
                console.error(`获取 ${source} 排行榜失败:`, error.message);
            }
        }
        
        res.json({
            success: true,
            type,
            source,
            total: total,
            results
        });
    } catch (error) {
        console.error('获取排行榜失败:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 搜索在线音乐
app.post('/api/online-search', async (req, res) => {
    try {
        const { keyword, source, page = 1, limit = 20 } = req.body;
        
        console.log(`[在线搜索] keyword=${keyword}, source=${source}, page=${page}, limit=${limit}`);
        
        if (!keyword) {
            return res.status(400).json({ success: false, error: '缺少搜索关键词' });
        }
        
        const results = [];
        let total = 0;
        
        // 只搜索指定的单个音源平台
        if (source) {
            // 优先使用新的自定义音源系统（lx-music-sync-server 风格）
            let customSearchResult = null;
            try {
                console.log(`[在线搜索] 尝试新自定义音源系统搜索, source=${source}`);
                customSearchResult = await userApi.callUserApiSearch(source, keyword, page, limit);
                if (customSearchResult && customSearchResult.list && customSearchResult.list.length > 0) {
                    console.log(`[在线搜索] 新自定义音源返回 ${customSearchResult.list.length} 条结果`);
                    results.push({
                        source: source,
                        sourceName: customSearchResult.sourceName || source,
                        list: customSearchResult.list
                    });
                    total = customSearchResult.total || 0;
                }
            } catch (error) {
                console.error(`新自定义音源 ${source} 搜索失败:`, error.message);
            }
            
            // 如果新系统没有结果，尝试旧的自定义音源
            if (results.length === 0 && customSources[source] && typeof customSources[source].search === 'function') {
                try {
                    console.log(`[在线搜索] 使用旧自定义音源搜索, source=${source}, limit=${limit}`);
                    const searchResult = await customSources[source].search(keyword, page, limit);
                    const list = searchResult?.list || searchResult || [];
                    const srcTotal = searchResult?.total || (Array.isArray(searchResult) ? searchResult.length : 0);
                    console.log(`[在线搜索] 旧自定义音源返回 ${list.length} 条结果, total=${srcTotal}`);
                    if (list.length > 0) {
                        results.push({
                            source: source,
                            sourceName: customSources[source].name || source,
                            list
                        });
                        total = srcTotal;
                    }
                } catch (error) {
                    console.error(`旧自定义音源 ${source} 搜索失败:`, error.message);
                }
            }
            
            // 如果自定义音源没有结果，使用内置搜索
            if (results.length === 0) {
                try {
                    console.log(`[在线搜索] 使用内置搜索, source=${source}, limit=${limit}`);
                    const searchResult = await searchMusicOnline(source, keyword, page, limit);
                    const list = searchResult?.list || [];
                    console.log(`[在线搜索] 内置搜索返回 ${list.length} 条结果, total=${searchResult.total}`);
                    if (list.length > 0) {
                        results.push({
                            source: source,
                            sourceName: ONLINE_SOURCES.find(s => s.id === source)?.name || source,
                            list
                        });
                        total = searchResult.total || 0;
                    }
                } catch (error) {
                    console.error(`内置音源 ${source} 搜索失败:`, error.message);
                }
            }
        }
        
        res.json({
            success: true,
            keyword,
            total,
            results
        });
    } catch (error) {
        console.error('在线搜索失败:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取在线音乐播放链接
app.post('/api/online-play-url', async (req, res) => {
    try {
        const { source, songId, quality = '128' } = req.body;
        
        if (!source || !songId) {
            return res.status(400).json({ success: false, error: '缺少参数' });
        }
        
        const playUrl = await getMusicPlayUrl(source, songId, quality);
        
        if (!playUrl) {
            return res.json({ success: false, error: '无法获取播放链接' });
        }
        
        res.json({
            success: true,
            playUrl,
            quality
        });
    } catch (error) {
        console.error('获取播放链接失败:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取在线音乐歌词
app.post('/api/online-lyric', async (req, res) => {
    try {
        const { source, songInfo } = req.body;
        
        if (!source || !songInfo) {
            return res.status(400).json({ success: false, error: '缺少参数' });
        }
        
        console.log(`[在线歌词] source=${source}, song=${songInfo.name || songInfo.songId}`);
        
        let result = null;
        
        try {
            result = await userApi.callUserApiGetLyric(source, songInfo);
        } catch (error) {
            console.error('自定义音源获取歌词失败:', error.message);
        }
        
        if (!result) {
            if (customSources[source] && typeof customSources[source].getLyric === 'function') {
                try {
                    console.log(`[在线歌词] 使用旧自定义音源获取歌词, source=${source}`);
                    const lyricResult = await customSources[source].getLyric(songInfo, 'lyric');
                    if (lyricResult && (lyricResult.lrc || lyricResult.lyric || typeof lyricResult === 'string')) {
                        result = {
                            lyric: lyricResult.lrc || lyricResult.lyric || lyricResult,
                            sourceName: customSources[source].name || source
                        };
                    }
                } catch (error) {
                    console.error('旧自定义音源获取歌词失败:', error.message);
                }
            }
        }
        
        if (result && result.lyric) {
            res.json({
                success: true,
                lyric: result.lyric,
                sourceName: result.sourceName
            });
        } else {
            try {
                console.log(`[在线歌词] 尝试内置歌词API, source=${source}`);
                const builtinLyric = await getLyricOnline(source, songInfo);
                if (builtinLyric) {
                    res.json({
                        success: true,
                        lyric: builtinLyric,
                        sourceName: '内置'
                    });
                    return;
                }
            } catch (e) {
                console.error('内置歌词获取失败:', e.message);
            }
            res.json({ success: false, error: '未找到歌词' });
        }
    } catch (error) {
        console.error('获取歌词失败:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 搜索匹配歌词（通过歌曲名+歌手搜索）
app.post('/api/search-lyric', async (req, res) => {
    try {
        const { keyword, source } = req.body;
        
        if (!keyword) {
            return res.status(400).json({ success: false, error: '缺少搜索关键词' });
        }
        
        console.log(`[搜索歌词] keyword=${keyword}, source=${source || 'all'}`);
        
        const searchSource = source || 'kw';
        
        let searchResult = null;
        try {
            searchResult = await userApi.callUserApiSearch(searchSource, keyword, 1, 5);
        } catch (error) {
            console.error('搜索歌词失败:', error.message);
        }
        
        if (!searchResult && customSources[searchSource] && typeof customSources[searchSource].search === 'function') {
            try {
                const result = await customSources[searchSource].search(keyword, 1, 5);
                if (result && result.list) {
                    searchResult = { list: result.list, sourceName: customSources[searchSource].name };
                }
            } catch (error) {
                console.error('旧自定义音源搜索失败:', error.message);
            }
        }
        
        if (!searchResult || !searchResult.list || searchResult.list.length === 0) {
            try {
                console.log(`[搜索歌词] 尝试内置搜索, source=${searchSource}`);
                const builtinSearch = await searchMusicOnline(searchSource, keyword, 1, 5);
                if (builtinSearch && builtinSearch.list && builtinSearch.list.length > 0) {
                    searchResult = { list: builtinSearch.list, sourceName: '内置' };
                }
            } catch (e) {
                console.error('内置搜索失败:', e.message);
            }
        }
        
        if (!searchResult || !searchResult.list || searchResult.list.length === 0) {
            return res.json({ success: false, error: '未找到匹配歌曲' });
        }
        
        const firstSong = searchResult.list[0];
        
        let lyricResult = null;
        try {
            lyricResult = await userApi.callUserApiGetLyric(searchSource, firstSong);
        } catch (error) {
            console.error('获取搜索结果歌词失败:', error.message);
        }
        
        if (!lyricResult && customSources[searchSource] && typeof customSources[searchSource].getLyric === 'function') {
            try {
                const lr = await customSources[searchSource].getLyric(firstSong, 'lyric');
                if (lr && (lr.lrc || lr.lyric || typeof lr === 'string')) {
                    lyricResult = {
                        lyric: lr.lrc || lr.lyric || lr,
                        sourceName: customSources[searchSource].name
                    };
                }
            } catch (error) {
                console.error('旧自定义音源获取歌词失败:', error.message);
            }
        }
        
        if (lyricResult && lyricResult.lyric) {
            res.json({
                success: true,
                lyric: lyricResult.lyric,
                sourceName: lyricResult.sourceName,
                matchedSong: firstSong.name || firstSong.songName || firstSong.title,
                matchedArtist: firstSong.singer || firstSong.artist || firstSong.author
            });
        } else {
            try {
                console.log(`[搜索歌词] 尝试内置歌词API, source=${searchSource}`);
                const builtinLyric = await getLyricOnline(searchSource, firstSong);
                if (builtinLyric) {
                    res.json({
                        success: true,
                        lyric: builtinLyric,
                        sourceName: '内置',
                        matchedSong: firstSong.name || firstSong.songName || firstSong.title,
                        matchedArtist: firstSong.singer || firstSong.artist || firstSong.author
                    });
                    return;
                }
            } catch (e) {
                console.error('内置歌词获取失败:', e.message);
            }
            res.json({ success: false, error: '未找到歌词' });
        }
    } catch (error) {
        console.error('搜索歌词失败:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取歌单标签
app.post('/api/online-songlist-tags', async (req, res) => {
    try {
        const { source } = req.body;
        
        if (!source) {
            return res.status(400).json({ success: false, error: '缺少音源参数' });
        }
        
        const tags = await songList.getTags(source);
        
        res.json({
            success: true,
            tags: tags.tags || [],
            hotTag: tags.hotTag || [],
            source
        });
    } catch (error) {
        console.error('获取歌单标签失败:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取歌单列表
app.post('/api/online-songlist-list', async (req, res) => {
    try {
        const { source, sortId, tagId, page = 1 } = req.body;
        
        if (!source) {
            return res.status(400).json({ success: false, error: '缺少音源参数' });
        }
        
        const result = await songList.getList(source, sortId, tagId, page);
        
        res.json({
            success: true,
            list: result.list,
            total: result.total,
            page: result.page,
            limit: result.limit,
            source
        });
    } catch (error) {
        console.error('获取歌单列表失败:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取歌单详情
app.post('/api/online-songlist-detail', async (req, res) => {
    try {
        const { source, id, page = 1 } = req.body;
        
        if (!source || !id) {
            return res.status(400).json({ success: false, error: '缺少参数' });
        }
        
        const result = await songList.getListDetail(source, id, page);
        
        res.json({
            success: true,
            list: result.list,
            total: result.total,
            page: result.page,
            limit: result.limit,
            info: result.info,
            source
        });
    } catch (error) {
        console.error('获取歌单详情失败:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 搜索歌单
app.post('/api/online-songlist-search', async (req, res) => {
    try {
        const { source, keyword, page = 1, limit = 20 } = req.body;
        
        if (!source || !keyword) {
            return res.status(400).json({ success: false, error: '缺少参数' });
        }
        
        const result = await songList.search(source, keyword, page, limit);
        
        res.json({
            success: true,
            list: result.list,
            total: result.total,
            page,
            limit,
            source
        });
    } catch (error) {
        console.error('搜索歌单失败:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取支持的歌单音源列表
app.get('/api/online-songlist-sources', (req, res) => {
    try {
        const sources = songList.getSources().map(sourceId => ({
            id: sourceId,
            name: ONLINE_SOURCES.find(s => s.id === sourceId)?.name || sourceId,
            sortList: songList.getSortList(sourceId)
        }));
        
        res.json({
            success: true,
            sources
        });
    } catch (error) {
        console.error('获取歌单音源列表失败:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 播放在线音乐
// 添加在线音乐到播放列表（不播放）
app.post('/api/add-online-to-playlist', async (req, res) => {
    try {
        const { source, songId, name, singer, albumName, picUrl, interval, songInfo } = req.body;
        
        if (!source || !songId) {
            return res.status(400).json({ success: false, error: '缺少参数' });
        }
        
        // 创建在线音乐元数据（保存完整的 songInfo）
        const onlineTrack = {
            title: name || '未知歌曲',
            artist: singer || '未知艺术家',
            album: albumName || '',
            duration: parseInt(String(interval)) || 0,
            path: `online://${source}/${songId}`,
            playUrl: '',
            picUrl: picUrl || '',
            source,
            songId,
            sourceName: ONLINE_SOURCES.find(s => s.id === source)?.name || source,
            isOnline: true,
            songInfo: songInfo || { songId, name, singer, albumName }
        };
        
        // 检查是否已存在
        const existingIndex = currentPlaylist.findIndex(track => track.path === onlineTrack.path);
        
        if (existingIndex >= 0) {
            return res.json({ success: true, message: '已在播放列表中', added: false });
        }
        
        // 添加到播放列表
        currentPlaylist.push(onlineTrack);
        
        // 按标题字母排序
        currentPlaylist.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
        
        // 更新播放列表缓存（保存在线音乐）
        try {
            fs.writeFileSync(PLAYLIST_CACHE_FILE, JSON.stringify(currentPlaylist, null, 2));
        } catch (error) {
            console.error('更新播放列表缓存失败:', error.message);
        }
        
        console.log(`📥 添加在线音乐到播放列表：${onlineTrack.title} (${onlineTrack.sourceName})`);
        
        res.json({
            success: true,
            message: '添加成功',
            added: true,
            index: currentPlaylist.length - 1,
            track: onlineTrack
        });
    } catch (error) {
        console.error('添加在线音乐失败:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/play-online', async (req, res) => {
    try {
        const { source, songId, name, singer, albumName, picUrl, interval, songInfo } = req.body;
        
        if (!source || !songId) {
            return res.status(400).json({ success: false, error: '缺少参数' });
        }
        
        // 获取播放链接（传递完整的歌曲信息给自定义音源）
        const playUrl = await getMusicPlayUrl(source, songInfo || { songId, name, singer, albumName }, '128');
        
        if (!playUrl) {
            return res.json({ success: false, error: '无法获取播放链接' });
        }
        
        // 创建在线音乐元数据（保存完整的 songInfo）
        const onlineTrack = {
            title: name || '未知歌曲',
            artist: singer || '未知艺术家',
            album: albumName || '',
            duration: parseInt(String(interval)) || 0,
            path: `online://${source}/${songId}`,
            playUrl,
            picUrl: picUrl || '',
            source,
            sourceName: ONLINE_SOURCES.find(s => s.id === source)?.name || source,
            isOnline: true,
            songInfo: songInfo || { songId, name, singer, albumName } // 保存完整的歌曲信息
        };
        
        // 检查是否在播放列表中
        const existingIndex = currentPlaylist.findIndex(track => track.path === onlineTrack.path);
        
        if (existingIndex >= 0) {
            // 更新已存在的歌曲信息（包括 songInfo）
            currentPlaylist[existingIndex] = onlineTrack;
            currentIndex = existingIndex;
        } else {
            currentPlaylist.push(onlineTrack);
            currentIndex = currentPlaylist.length - 1;
        }
        
        // 更新播放列表缓存（保存在线音乐）
        try {
            fs.writeFileSync(PLAYLIST_CACHE_FILE, JSON.stringify(currentPlaylist, null, 2));
        } catch (error) {
            console.error('更新播放列表缓存失败:', error.message);
        }
        
        // 添加到播放历史
        addToPlayHistory(onlineTrack);
        
        currentDuration = onlineTrack.duration;
        
        console.log(`🎵 在线播放：${onlineTrack.title} (${onlineTrack.sourceName})`);
        
        // 客户端模式：只添加到播放列表，不启动服务器播放
        if (playOutput === 'client') {
            return res.json({
                success: true,
                current: onlineTrack,
                currentIndex,
                playlist: currentPlaylist,
                clientMode: true
            });
        }
        
        // 服务器模式：停止当前播放并播放在线音乐流
        stopMusic();
        
        isPlaying = true;
        playbackStartTime = Date.now();
        
        // 播放在线音乐流
        playOnlineMusic(playUrl);
        
        res.json({
            success: true,
            current: onlineTrack,
            currentIndex
        });
    } catch (error) {
        console.error('在线播放失败:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取支持的在线音乐源列表
app.get('/api/online-sources', (req, res) => {
    res.json({
        success: true,
        sources: ONLINE_SOURCES,
        currentSource: onlineSource
    });
});

// 保存在线音乐音源选择
app.post('/api/online-source', requireAuth, (req, res) => {
    try {
        const { source } = req.body;
        if (!source) {
            return res.status(400).json({ success: false, error: '缺少音源参数' });
        }
        
        onlineSource = source;
        saveConfig();
        
        res.json({
            success: true,
            message: '音源已保存',
            source
        });
    } catch (error) {
        console.error('保存音源失败:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 网易云音乐加密函数（参考 lx-music-sync-server）
const crypto = require('crypto');
const iv = Buffer.from('0102030405060708');
const presetKey = Buffer.from('0CoJUm6Qyw8W8jud');
const linuxapiKey = Buffer.from('rFgB&h#%2?^eDg:Q');
const base62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const publicKey = '-----BEGIN PUBLIC KEY-----\nMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB\n-----END PUBLIC KEY-----';
const eapiKey = 'e82ckenh8dichen8';

const aesEncrypt = (buffer, mode, key, iv) => {
    const cipher = crypto.createCipheriv(mode, key, iv);
    return Buffer.concat([cipher.update(buffer), cipher.final()]);
};

const rsaEncrypt = (buffer, key) => {
    buffer = Buffer.concat([Buffer.alloc(128 - buffer.length), buffer]);
    return crypto.publicEncrypt({ key, padding: crypto.constants.RSA_NO_PADDING }, buffer);
};

function weapiEncrypt(object) {
    const text = JSON.stringify(object);
    const secretKey = crypto.randomBytes(16).map(n => base62.charAt(n % 62).charCodeAt(0));
    const firstEncrypt = aesEncrypt(Buffer.from(text), 'aes-128-cbc', presetKey, iv);
    const params = aesEncrypt(Buffer.from(firstEncrypt.toString('base64')), 'aes-128-cbc', Buffer.from(secretKey), iv).toString('base64');
    const encSecKey = rsaEncrypt(Buffer.from(secretKey).reverse(), publicKey).toString('hex');
    return { params, encSecKey };
}

function eapiEncrypt(url, object) {
    const text = typeof object === 'object' ? JSON.stringify(object) : object;
    const message = `nobody${url}use${text}md5forencrypt`;
    const digest = crypto.createHash('md5').update(message).digest('hex');
    const data = `${url}-36cd479b6b5-${text}-36cd479b6b5-${digest}`;
    return {
        params: aesEncrypt(Buffer.from(data), 'aes-128-ecb', eapiKey, '').toString('hex').toUpperCase(),
    };
}

// 获取音乐排行榜（参考 lx-music-sync-server）
async function getMusicRank(source, type, page = 1, limit = 20) {
    try {
        switch (source) {
            case 'wy': {
                // 网易云音乐排行榜 - 使用 weapi 加密
                const wyTypes = { hot: '3778678', new: '3779629', soaring: '19723756', original: '2884035' };
                const id = wyTypes[type] || '3778678';
                const encrypted = weapiEncrypt({ id, n: limit, p: page });
                
                const options = {
                    protocol: 'https:',
                    hostname: 'music.163.com',
                    path: '/weapi/v3/playlist/detail',
                    method: 'POST',
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Referer': 'https://music.163.com/discover/toplist',
                        'Content-Length': Buffer.byteLength(new URLSearchParams(encrypted).toString())
                    }
                };
                
                try {
                    const { body } = await httpRequest(options, new URLSearchParams(encrypted).toString());
                    const json = JSON.parse(body);
                    
                    if (json.code === 200 && json.playlist?.trackIds) {
                        const total = json.playlist.trackIds.length;
                        const startIndex = (page - 1) * limit;
                        const endIndex = startIndex + limit;
                        const pageTrackIds = json.playlist.trackIds.slice(startIndex, endIndex).map(t => t.id);
                        const detailEncrypted = weapiEncrypt({ 
                            c: '[' + pageTrackIds.map(id => ('{"id":' + id + '}')).join(',') + ']',
                            ids: '[' + pageTrackIds.join(',') + ']'
                        });
                        
                        const detailOptions = {
                            protocol: 'https:',
                            hostname: 'music.163.com',
                            path: '/weapi/v3/song/detail',
                            method: 'POST',
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                                'Content-Type': 'application/x-www-form-urlencoded',
                                'Referer': 'https://music.163.com/',
                                'Content-Length': Buffer.byteLength(new URLSearchParams(detailEncrypted).toString())
                            }
                        };
                        
                        const { body: detailBody } = await httpRequest(detailOptions, new URLSearchParams(detailEncrypted).toString());
                        const detailJson = JSON.parse(detailBody);
                        
                        if (detailJson.code === 200 && detailJson.songs) {
                            return {
                                total: total,
                                list: detailJson.songs.map(item => ({
                                    songId: String(item.id),
                                    name: item.name || '',
                                    singer: item.ar.map(a => a.name).join('/'),
                                    albumName: item.al.name || '',
                                    albumId: String(item.al.id),
                                    interval: Math.floor(item.dt / 1000),
                                    picUrl: item.al.picUrl || '',
                                    source: 'wy',
                                    quality: '128'
                                }))
                            };
                        }
                    }
                } catch (e) {
                    console.error('网易云请求失败:', e.message);
                }
                return { total: 0, list: [] };
            }
            
            case 'kw': {
                // 酷我音乐排行榜 - 使用加密API
                const kwTypes = { hot: '16', new: '17', soaring: '93', original: '278' };
                const bangId = kwTypes[type] || '16';
                
                // 酷我音乐加密参数
                const aesKey = Buffer.from([112, 87, 39, 61, 199, 250, 41, 191, 57, 68, 45, 114, 221, 94, 140, 228], 'binary');
                const appId = 'y67sprxhhpws';
                
                const requestBody = { uid: '', devId: '', sFrom: 'kuwo_sdk', user_type: 'AP', carSource: 'kwplayercar_ar_6.0.1.0_apk_keluze.apk', id: bangId, pn: page - 1, rn: limit };
                const time = Date.now();
                
                // AES加密
                const cipher = crypto.createCipheriv('aes-128-ecb', aesKey, '');
                const encodeData = Buffer.concat([cipher.update(JSON.stringify(requestBody)), cipher.final()]).toString('base64');
                
                // 创建签名
                const md5Hash = crypto.createHash('md5');
                const sign = md5Hash.update(`${appId}${encodeData}${time}`).digest('hex').toUpperCase();
                
                const url = `https://wbd.kuwo.cn/api/bd/bang/bang_info?data=${encodeURIComponent(encodeData)}&time=${time}&appId=${appId}&sign=${sign}`;
                const urlObj = new URL(url);
                
                const options = {
                    protocol: urlObj.protocol,
                    hostname: urlObj.hostname,
                    path: urlObj.pathname + urlObj.search,
                    method: 'GET',
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Referer': 'http://www.kuwo.cn/'
                    }
                };
                
                const { body } = await httpRequest(options);
                
                // AES解密
                const decodeData = Buffer.from(decodeURIComponent(body), 'base64');
                const decipher = crypto.createDecipheriv('aes-128-ecb', aesKey, '');
                const rawData = JSON.parse(Buffer.concat([decipher.update(decodeData), decipher.final()]).toString());
                
                if (rawData.code == 200 && rawData.data?.musiclist) {
                    return {
                        total: parseInt(String(rawData.data.total || '0')) || rawData.data.musiclist.length * 10,
                        list: rawData.data.musiclist.map(item => ({
                            songId: String(item.id),
                            name: item.name || '',
                            singer: item.artist || '',
                            albumName: item.album || '',
                            albumId: String(item.albumId || ''),
                            interval: parseInt(String(item.duration || '0')) || 0,
                            picUrl: item.pic || '',
                            source: 'kw',
                            quality: '128'
                        }))
                    };
                }
                return { total: 0, list: [] };
            }
            
            case 'kg': {
                // 酷狗音乐排行榜 - 参考lx-music-sync-server使用的API
                const kgTypes = { hot: '8888', new: '59703', soaring: '6666', original: '30972' };
                const url = `http://mobilecdnbj.kugou.com/api/v3/rank/song?version=9108&ranktype=1&plat=0&pagesize=${limit}&area_code=1&page=${page}&rankid=${kgTypes[type] || '8888'}&with_res_tag=0&show_portrait_mv=1`;
                const urlObj = new URL(url);
                
                const options = {
                    protocol: urlObj.protocol,
                    hostname: urlObj.hostname,
                    path: urlObj.pathname + urlObj.search,
                    method: 'GET',
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                    }
                };
                
                const { body } = await httpRequest(options);
                const json = JSON.parse(body);
                
                if (json.errcode === 0 && json.data?.info) {
                    return {
                        total: json.data.total || json.data.info.length * 10, // 估算总数
                        list: json.data.info.map(item => {
                            const filename = item.filename || '';
                            const singer = filename.split(' - ')[0] || '';
                            return ({
                                songId: String(item.audio_id),
                                name: item.songname || '',
                                singer: singer,
                                albumName: item.remark || '',
                                albumId: String(item.album_id || ''),
                                interval: item.duration || 0,
                                picUrl: (item.album_sizable_cover || '').replace('{size}', '400'),
                                source: 'kg',
                                quality: '128',
                                hash: item.hash || ''
                            });
                        })
                    };
                }
                return { total: 0, list: [] };
            }
            
            case 'tx': {
                // QQ音乐排行榜 - 使用POST API
                const txTypes = { hot: '26', new: '27', soaring: '62', original: '52' };
                const topid = parseInt(txTypes[type] || '26');
                
                const postData = JSON.stringify({
                    toplist: {
                        module: 'musicToplist.ToplistInfoServer',
                        method: 'GetDetail',
                        param: {
                            topid: topid,
                            num: limit,
                            period: '',
                        },
                    },
                    comm: {
                        uin: 0,
                        format: 'json',
                        ct: 20,
                        cv: 1859,
                    },
                });
                
                const options = {
                    protocol: 'https:',
                    hostname: 'u.y.qq.com',
                    path: '/cgi-bin/musicu.fcg',
                    method: 'POST',
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; WOW64; Trident/5.0)',
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(postData),
                        'Referer': 'https://y.qq.com/n/ryqq/toplist'
                    }
                };
                
                const { body } = await httpRequest(options, postData);
                const json = JSON.parse(body);
                
                if (json.code === 0 && json.toplist?.data?.songInfoList) {
                    return {
                        total: json.toplist.data.songInfoList.length,
                        list: json.toplist.data.songInfoList.map(item => ({
                            songId: String(item.id || ''),
                            name: item.title || '',
                            singer: item.singer ? item.singer.map(s => s.name).join('/') : '',
                            albumName: item.album?.name || '',
                            albumId: String(item.album?.mid || ''),
                            interval: item.interval || 0,
                            picUrl: item.album?.name && item.album?.name !== '空' 
                                ? `https://y.gtimg.cn/music/photo_new/T002R500x500M000${item.album.mid}.jpg` 
                                : item.singer?.length 
                                    ? `https://y.gtimg.cn/music/photo_new/T001R500x500M000${item.singer[0].mid}.jpg` 
                                    : '',
                            source: 'tx',
                            quality: '128',
                            songmid: item.mid || '',
                            strMediaMid: item.file?.media_mid || ''
                        }))
                    };
                }
                return { total: 0, list: [] };
            }
            
            case 'mg': {
                // 咪咕音乐排行榜 - 使用加密API
                const mgTypes = { hot: '27186466', new: '27553319', soaring: '75959118', original: '27553408' };
                const bangId = mgTypes[type] || '27186466';
                
                const url = `https://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/querycontentbyId.do?columnId=${bangId}&needAll=0`;
                const urlObj = new URL(url);
                
                const options = {
                    protocol: urlObj.protocol,
                    hostname: urlObj.hostname,
                    path: urlObj.pathname + urlObj.search,
                    method: 'GET',
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Linux; Android 5.1.1; Nexus 6 Build/LYZ28E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/59.0.3071.115 Mobile Safari/537.36',
                        'Referer': 'https://app.c.nf.migu.cn/',
                        'channel': '0146921'
                    }
                };
                
                const { body } = await httpRequest(options);
                try {
                    const json = JSON.parse(body);
                    if (json.code === '000000' && json.columnInfo?.contents) {
                        return {
                            total: json.columnInfo.contents.length * 10,
                            list: json.columnInfo.contents.map(item => {
                                const info = item.objectInfo;
                                return {
                                    songId: String(info.songId || info.id || ''),
                                    name: info.songName || info.title || '',
                                    singer: info.singerName || info.artist || '',
                                    albumName: info.albumName || info.album || '',
                                    albumId: String(info.albumId || ''),
                                    interval: parseInt(String(info.duration || info.interval || '0')) || 0,
                                    picUrl: info.cover || info.picUrl || '',
                                    source: 'mg',
                                    quality: '128'
                                };
                            })
                        };
                    }
                } catch (e) {
                    console.error(`咪咕音乐JSON解析失败:`, e.message);
                }
                return { total: 0, list: [] };
            }
            
            default:
                return { total: 0, list: [] };
        }
    } catch (error) {
        console.error(`获取 ${source} 排行榜出错:`, error.message);
        return [];
    }
}

// 简化的HTTP请求函数（参考 lx-music-sync-server）
const httpRequest = (options, postData = null) => {
    return new Promise((resolve, reject) => {
        const protocol = options.protocol === 'https:' ? https : http;
        const req = protocol.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                resolve({ statusCode: res.statusCode, body: data });
            });
        });
        
        req.on('error', (e) => {
            reject(e);
        });
        
        if (postData) {
            req.write(postData);
        }
        req.end();
    });
};

// 在线音乐搜索函数（参考 lx-music-sync-server）
async function searchMusicOnline(source, keyword, page = 1, limit = 20) {
    try {
        switch (source) {
            case 'kw': {
                // 酷我音乐搜索（参考lx-music-sync-server）
                const url = `http://search.kuwo.cn/r.s?client=kt&all=${encodeURIComponent(keyword)}&pn=${page - 1}&rn=${limit}&uid=794762570&ver=kwplayer_ar_9.2.2.1&vipver=1&show_copyright_off=1&newver=1&ft=music&cluster=0&strategy=2012&encoding=utf8&rformat=json&vermerge=1&mobi=1&issubtitle=1`;
                const urlObj = new URL(url);
                const options = {
                    protocol: urlObj.protocol,
                    hostname: urlObj.hostname,
                    path: urlObj.pathname + urlObj.search,
                    method: 'GET',
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                    }
                };
                
                const { body } = await httpRequest(options);
                const json = JSON.parse(body);
                
                const list = (json.abslist || []).map(item => {
                    const songId = (item.MUSICRID || '').replace('MUSIC_', '');
                    let picUrl = item.prob_albumpic || '';
                    if (!picUrl && item.web_albumpic_short) {
                        picUrl = `https://img4.kuwo.cn/star/albumcover/1000${item.web_albumpic_short}`;
                    }
                    
                    return {
                        songId: songId,
                        name: item.SONGNAME || '',
                        singer: item.ARTIST || '',
                        albumName: item.ALBUM || '',
                        albumId: String(item.ALBUMID || ''),
                        interval: parseInt(String(item.DURATION || '0')) || 0,
                        picUrl: picUrl,
                        source: 'kw',
                        quality: '128'
                    };
                });
                return { list, total: parseInt(json.TOTAL || '0') };
            }
            
            case 'kg': {
                // 酷狗音乐搜索（参考 lx-music-sync-server）
                const url = `https://songsearch.kugou.com/song_search_v2?keyword=${encodeURIComponent(keyword)}&page=${page}&pagesize=${limit}&userid=0&clientver=&platform=WebFilter&filter=2&iscorrection=1&privilege_filter=0&area_code=1`;
                const urlObj = new URL(url);
                const options = {
                    protocol: urlObj.protocol,
                    hostname: urlObj.hostname,
                    path: urlObj.pathname + urlObj.search,
                    method: 'GET',
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                    }
                };
                
                const { body } = await httpRequest(options);
                const json = JSON.parse(body);
                if (json.error_code === 0 && json.data?.lists) {
                    const list = json.data.lists.map(item => ({
                        songId: item.Audioid || '',
                        name: item.SongName || '',
                        singer: item.Singers?.map(s => s.name).join('、') || item.SingerName || '',
                        albumName: item.AlbumName || '',
                        albumId: String(item.AlbumID || ''),
                        interval: item.Duration || 0,
                        picUrl: (item.Image || item.trans_param?.union_cover || '').replace('{size}', '400'),
                        source: 'kg',
                        quality: '128',
                        hash: item.FileHash || ''
                    }));
                    return { list, total: json.data.total || 0 };
                }
                return { list: [], total: 0 };
            }
            
            case 'tx': {
                // QQ音乐搜索
                const url = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=h5&needNewCode=1&w=${encodeURIComponent(keyword)}&p=${page}&n=${limit}`;
                const urlObj = new URL(url);
                const options = {
                    protocol: urlObj.protocol,
                    hostname: urlObj.hostname,
                    path: urlObj.pathname + urlObj.search,
                    method: 'GET',
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Referer': 'https://y.qq.com/n/ryqq/search'
                    }
                };
                
                const { body } = await httpRequest(options);
                const match = body.match(/^MusicJsonCallback\((.+)\)$/);
                if (match) {
                    const json = JSON.parse(match[1]);
                    if (json.data && json.data.song && json.data.song.list) {
                        const list = json.data.song.list.map(item => ({
                            songId: String(item.songid || item.songmid || ''),
                            name: item.songname || '',
                            singer: item.singer ? item.singer.map(s => s.name).join('/') : '',
                            albumName: item.albumname || '',
                            albumId: String(item.albumid || ''),
                            interval: item.interval || 0,
                            picUrl: item.albummid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${item.albummid}.jpg` : '',
                            source: 'tx',
                            quality: '128'
                        }));
                        return { list, total: json.data.song.total || 0 };
                    }
                }
                return { list: [], total: 0 };
            }
            
            case 'wy': {
                // 网易云音乐搜索（使用eapi加密，参考lx-music-sync-server）
                // 注意：网易云 API 限制每页最多 30 条
                const wyLimit = Math.min(limit, 30);
                const url = '/api/search/song/list/page';
                const encrypted = eapiEncrypt(url, {
                    keyword: keyword,
                    needCorrect: '1',
                    channel: 'typing',
                    offset: wyLimit * (page - 1),
                    scene: 'normal',
                    total: page == 1,
                    limit: wyLimit,
                });
                
                const options = {
                    protocol: 'http:',
                    hostname: 'interface.music.163.com',
                    path: '/eapi/batch',
                    method: 'POST',
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36',
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'origin': 'https://music.163.com',
                        'Content-Length': Buffer.byteLength(new URLSearchParams(encrypted).toString())
                    }
                };
                
                const { body } = await httpRequest(options, new URLSearchParams(encrypted).toString());
                const json = JSON.parse(body);
                
                console.log(`[网易云搜索] 返回 resources 数量: ${json.data?.resources?.length || 0}`);
                
                if (json.code === 200 && json.data?.resources) {
                    const list = json.data.resources.map(item => {
                        const song = item.baseInfo.simpleSongData;
                        return {
                            songId: String(song.id),
                            name: song.name || '',
                            singer: song.ar ? song.ar.map(a => a.name).join('、') : '',
                            albumName: song.al?.name || '',
                            albumId: String(song.al?.id || ''),
                            interval: Math.floor((song.dt || 0) / 1000) || 0,
                            picUrl: song.al?.picUrl || '',
                            source: 'wy',
                            quality: '128'
                        };
                    });
                    return { list, total: json.data?.totalCount || list.length };
                }
                return { list: [], total: 0 };
            }
            
            case 'mg': {
                // 咪咕音乐搜索（参考lx-music-sync-server）
                const time = Date.now().toString();
                const deviceId = '963B7AA0D21511ED807EE5846EC87D20';
                const signatureMd5 = '6cdc72a439cef99a3418d2a78aa28c73';
                const signStr = `${keyword}${signatureMd5}yyapp2d16148780a1dcc7408e06336b98cfd50${deviceId}${time}`;
                const sign = crypto.createHash('md5').update(signStr).digest('hex');
                
                const url = `https://jadeite.migu.cn/music_search/v3/search/searchAll?isCorrect=0&isCopyright=1&searchSwitch=%7B%22song%22%3A1%2C%22album%22%3A0%2C%22singer%22%3A0%2C%22tagSong%22%3A1%2C%22mvSong%22%3A0%2C%22bestShow%22%3A1%2C%22songlist%22%3A0%2C%22lyricSong%22%3A0%7D&pageSize=${limit}&text=${encodeURIComponent(keyword)}&pageNo=${page}&sort=0&sid=USS`;
                const urlObj = new URL(url);
                const options = {
                    protocol: urlObj.protocol,
                    hostname: urlObj.hostname,
                    path: urlObj.pathname + urlObj.search,
                    method: 'GET',
                    headers: {
                        'uiVersion': 'A_music_3.6.1',
                        'deviceId': deviceId,
                        'timestamp': time,
                        'sign': sign,
                        'channel': '0146921',
                        'User-Agent': 'Mozilla/5.0 (Linux; U; Android 11.0.0; zh-cn; MI 11 Build/OPR1.170623.032) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30'
                    }
                };
                
                const { body } = await httpRequest(options);
                const json = JSON.parse(body);
                
                if (json.code === '000000' && json.songResultData?.resultList) {
                    const results = [];
                    const ids = new Set();
                    
                    json.songResultData.resultList.forEach(group => {
                        group.forEach(item => {
                            if (!item.songId || !item.copyrightId || ids.has(item.copyrightId)) return;
                            ids.add(item.copyrightId);
                            
                            let img = item.img3 || item.img2 || item.img1 || '';
                            if (img && !/https?:/.test(img)) {
                                img = 'http://d.musicapp.migu.cn' + img;
                            }
                            
                            const singerList = item.singerList || [];
                            const singer = singerList.map(s => s.name).join('/') || '';
                            
                            results.push({
                                songId: String(item.songId),
                                name: item.name || '',
                                singer: singer,
                                albumName: item.album || '',
                                albumId: String(item.albumId || ''),
                                interval: parseInt(String(item.duration || '0')) || 0,
                                picUrl: img,
                                source: 'mg',
                                quality: '128',
                                copyrightId: String(item.copyrightId)
                            });
                        });
                    });
                    
                    return { list: results, total: parseInt(json.songResultData?.totalCount || '0') };
                }
                return { list: [], total: 0 };
            }
            
            default:
                return { list: [], total: 0 };
        }
    } catch (error) {
        console.error(`搜索 ${source} 音乐出错:`, error.message);
        return { list: [], total: 0 };
    }
}

// 在线歌词获取函数
async function getLyricOnline(source, songInfo) {
    try {
        const songId = songInfo.songId || songInfo.songmid || songInfo.id;
        const keyword = songInfo.name ? (songInfo.singer ? `${songInfo.name} - ${songInfo.singer}` : songInfo.name) : '';
        
        switch (source) {
            case 'kw': {
                if (!songId && keyword) {
                    const searchResult = await searchMusicOnline('kw', keyword, 1, 1);
                    if (searchResult.list && searchResult.list.length > 0) {
                        return getLyricOnline('kw', searchResult.list[0]);
                    }
                }
                if (songId) {
                    const url = `http://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=${songId}&httpsStatus=1`;
                    const urlObj = new URL(url);
                    const options = {
                        protocol: urlObj.protocol,
                        hostname: urlObj.hostname,
                        path: urlObj.pathname + urlObj.search,
                        method: 'GET',
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1',
                            'Referer': 'http://m.kuwo.cn/'
                        }
                    };
                    const { body } = await httpRequest(options);
                    const json = JSON.parse(body);
                    if (json.data?.lrclist) {
                        const lrcText = json.data.lrclist.map(item => {
                            const time = parseFloat(item.time || '0');
                            const minutes = Math.floor(time / 60);
                            const seconds = Math.floor(time % 60);
                            const ms = Math.floor((time % 1) * 100);
                            return `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(ms).padStart(2, '0')}]${item.lineLyric || item.text || ''}`;
                        }).join('\n');
                        return lrcText;
                    }
                }
                return null;
            }
            
            case 'wy': {
                if (!songId && keyword) {
                    const searchResult = await searchMusicOnline('wy', keyword, 1, 1);
                    if (searchResult.list && searchResult.list.length > 0) {
                        return getLyricOnline('wy', searchResult.list[0]);
                    }
                }
                if (songId) {
                    const url = `https://music.163.com/api/song/lyric?id=${songId}&lv=1&kv=1&tv=-1`;
                    const urlObj = new URL(url);
                    const options = {
                        protocol: urlObj.protocol,
                        hostname: urlObj.hostname,
                        path: urlObj.pathname + urlObj.search,
                        method: 'GET',
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                            'Referer': 'https://music.163.com/'
                        }
                    };
                    const { body } = await httpRequest(options);
                    const json = JSON.parse(body);
                    if (json.lrc?.lyric) {
                        return json.lrc.lyric;
                    }
                }
                return null;
            }
            
            case 'kg': {
                if (!songId && !songInfo.hash && keyword) {
                    const searchResult = await searchMusicOnline('kg', keyword, 1, 1);
                    if (searchResult.list && searchResult.list.length > 0) {
                        return getLyricOnline('kg', searchResult.list[0]);
                    }
                }
                const hash = songInfo.hash || songId;
                if (hash) {
                    const url = `https://krcs.kugou.com/search?ver=1&man=yes&client=mobi&keyword=&duration=&hash=${hash}&album_audio_id=`;
                    const urlObj = new URL(url);
                    const options = {
                        protocol: urlObj.protocol,
                        hostname: urlObj.hostname,
                        path: urlObj.pathname + urlObj.search,
                        method: 'GET',
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                        }
                    };
                    const { body } = await httpRequest(options);
                    const json = JSON.parse(body);
                    if (json.candidates && json.candidates.length > 0 && json.candidates[0].id) {
                        const krcId = json.candidates[0].id;
                        const krcUrl = `https://lyrics.kugou.com/download?ver=1&client=pc&id=${krcId}&accesskey=${json.candidates[0].accesskey || ''}&fmt=lrc&charset=utf8`;
                        const krcUrlObj = new URL(krcUrl);
                        const krcOptions = {
                            protocol: krcUrlObj.protocol,
                            hostname: krcUrlObj.hostname,
                            path: krcUrlObj.pathname + krcUrlObj.search,
                            method: 'GET',
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                            }
                        };
                        const { body: krcBody } = await httpRequest(krcOptions);
                        const krcJson = JSON.parse(krcBody);
                        if (krcJson.content) {
                            return krcJson.content;
                        }
                    }
                }
                return null;
            }
            
            default:
                return null;
        }
    } catch (error) {
        console.error(`获取 ${source} 歌词出错:`, error.message);
        return null;
    }
}

// LX Music 自定义音源沙箱环境
const vm = require('vm');
const zlib = require('zlib');
const util = require('util');
const inflate = util.promisify(zlib.inflate);
const deflate = util.promisify(zlib.deflate);

// 彻底切断与沙箱上下文的联系
function decontextify(obj) {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj !== 'object') return obj;
    try {
        if (Buffer.isBuffer(obj) || obj instanceof Uint8Array) {
            return Buffer.from(Uint8Array.from(obj));
        }
    } catch (e) { }
    if (Array.isArray(obj)) {
        try {
            return obj.map(item => decontextify(item));
        } catch (e) {
            return [];
        }
    }
    if (obj instanceof Error) {
        const err = new Error(obj.message);
        err.stack = obj.stack;
        return err;
    }
    try {
        const newObj = {};
        const keys = Object.keys(obj);
        for (const key of keys) {
            try {
                newObj[key] = decontextify(obj[key]);
            } catch (e) { }
        }
        return newObj;
    } catch (e) {
        try {
            const str = JSON.stringify(obj);
            return str ? JSON.parse(str) : String(obj);
        } catch (e2) {
            return String(obj);
        }
    }
}

// 创建 lx.request 包装器（使用原生 http/https）
// 初始化自定义音源（调用统一的 loadCustomSources 函数）
async function initCustomSources() {
    // 初始化新的自定义音源系统（lx-music-sync-server 风格）
    try {
        await userApi.initUserApis();
    } catch (error) {
        console.error('[UserApi] 初始化失败:', error.message);
    }
    
    // 读取激活的音源列表（旧系统兼容）
    let activeSourceIds = [];
    const settingsPath = path.join(__dirname, 'data', 'online-settings.json');
    if (fs.existsSync(settingsPath)) {
        try {
            const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            activeSourceIds = settings.activeSources || [];
        } catch (e) {
            console.log('[CustomSource] 读取设置失败，将加载所有音源');
        }
    }
    
    console.log('[CustomSource] 激活的音源列表:', activeSourceIds);
    
    // 如果有激活列表，加载指定的音源，否则加载所有音源
    if (activeSourceIds.length > 0) {
        await loadCustomSources(activeSourceIds);
    } else {
        await loadCustomSources();
    }
}

// 获取在线音乐播放链接
async function getMusicPlayUrl(source, songInfo, quality = '128') {
    // 取消之前正在进行的播放链接获取请求
    if (currentMusicUrlController) {
        currentMusicUrlController.abort();
        console.log('[MusicUrl] 已取消之前的播放链接获取请求');
    }
    
    // 创建新的 AbortController
    const controller = new AbortController();
    currentMusicUrlController = controller;
    
    try {
        // 标准化 songInfo 格式：将 meta 中的字段提升到顶层（参考 lx-music-sync-server）
        const normalizedSongInfo = { ...songInfo };
    if (songInfo.meta) {
        // 将 meta 中的所有字段展开到顶层
        Object.assign(normalizedSongInfo, songInfo.meta);
        
        // ========== 通用字段映射 ==========
        // songId -> songmid (通用)
        if (songInfo.meta.songId && !normalizedSongInfo.songmid) {
            normalizedSongInfo.songmid = songInfo.meta.songId;
        }
        // 图片字段统一
        if (songInfo.meta.picUrl && !normalizedSongInfo.img) {
            normalizedSongInfo.img = songInfo.meta.picUrl;
        }
        // 音质信息
        if (songInfo.meta.qualitys && !normalizedSongInfo.types) {
            normalizedSongInfo.types = songInfo.meta.qualitys;
        }
        if (songInfo.meta._qualitys && !normalizedSongInfo._types) {
            normalizedSongInfo._types = songInfo.meta._qualitys;
        }
        
        // ========== 各平台特有字段 ==========
        // 酷狗 (kg): hash, albumId
        if (songInfo.meta.hash && !normalizedSongInfo.hash) {
            normalizedSongInfo.hash = songInfo.meta.hash;
        }
        if (songInfo.meta.albumId && !normalizedSongInfo.albumId) {
            normalizedSongInfo.albumId = songInfo.meta.albumId;
        }
        // 咪咕 (mg): copyrightId, lrcUrl, mrcUrl, trcUrl
        if (songInfo.meta.copyrightId && !normalizedSongInfo.copyrightId) {
            normalizedSongInfo.copyrightId = songInfo.meta.copyrightId;
        }
        if (songInfo.meta.lrcUrl && !normalizedSongInfo.lrcUrl) {
            normalizedSongInfo.lrcUrl = songInfo.meta.lrcUrl;
        }
        if (songInfo.meta.mrcUrl && !normalizedSongInfo.mrcUrl) {
            normalizedSongInfo.mrcUrl = songInfo.meta.mrcUrl;
        }
        if (songInfo.meta.trcUrl && !normalizedSongInfo.trcUrl) {
            normalizedSongInfo.trcUrl = songInfo.meta.trcUrl;
        }
        // QQ音乐 (tx): strMediaMid, albumMid
        if (songInfo.meta.strMediaMid && !normalizedSongInfo.strMediaMid) {
            normalizedSongInfo.strMediaMid = songInfo.meta.strMediaMid;
        }
        if (songInfo.meta.albumMid && !normalizedSongInfo.albumMid) {
            normalizedSongInfo.albumMid = songInfo.meta.albumMid;
        }
    }
    
    // ========== 顶层字段兜底映射 ==========
    if (!normalizedSongInfo.hash && songInfo.hash) {
        normalizedSongInfo.hash = songInfo.hash;
    }
    if (!normalizedSongInfo.copyrightId && songInfo.copyrightId) {
        normalizedSongInfo.copyrightId = songInfo.copyrightId;
    }
    if (!normalizedSongInfo.strMediaMid && songInfo.strMediaMid) {
        normalizedSongInfo.strMediaMid = songInfo.strMediaMid;
    }
    if (!normalizedSongInfo.albumMid && songInfo.albumMid) {
        normalizedSongInfo.albumMid = songInfo.albumMid;
    }
    if (!normalizedSongInfo.albumId && songInfo.albumId) {
        normalizedSongInfo.albumId = songInfo.albumId;
    }
    if (!normalizedSongInfo.lrcUrl && songInfo.lrcUrl) {
        normalizedSongInfo.lrcUrl = songInfo.lrcUrl;
    }
    if (!normalizedSongInfo.mrcUrl && songInfo.mrcUrl) {
        normalizedSongInfo.mrcUrl = songInfo.mrcUrl;
    }
    if (!normalizedSongInfo.trcUrl && songInfo.trcUrl) {
        normalizedSongInfo.trcUrl = songInfo.trcUrl;
    }
    
    // ========== 优先使用新的自定义音源系统（lx-music-sync-server 风格）==========
    try {
        console.log(`[MusicUrl] 尝试新自定义音源系统获取播放链接, source=${source}`);
        const result = await userApi.callUserApiGetMusicUrl(source, normalizedSongInfo, quality);
        if (result && result.url) {
            console.log(`[MusicUrl] 新自定义音源 ${source} 获取到播放链接`);
            return result.url;
        }
    } catch (error) {
        console.error(`[MusicUrl] 新自定义音源 ${source} 获取播放链接失败:`, error.message);
    }
    
    // 优先使用自定义音源
    if (customSources[source] && typeof customSources[source].getPlayUrl === 'function') {
        try {
            console.log(`使用自定义音源 ${source} 获取播放链接，歌曲:`, normalizedSongInfo.name || normalizedSongInfo.songId);
            // LX Music 音源格式：getMusicUrl(songInfo, type, quality)
            // 使用标准化后的 songInfo
            const result = await customSources[source].getPlayUrl(normalizedSongInfo, 'url', quality);
            if (result && result.url) {
                console.log(`自定义音源 ${source} 获取到播放链接:`, result.url);
                return result.url;
            } else if (typeof result === 'string' && result) {
                console.log(`自定义音源 ${source} 获取到播放链接:`, result);
                return result;
            }
        } catch (error) {
            console.error(`自定义音源 ${source} 获取播放链接失败:`, error.message);
        }
    }
    
    // 从 songInfo 中提取必要的信息（使用标准化后的数据）
    const songId = normalizedSongInfo.songId || normalizedSongInfo.hash || normalizedSongInfo.songmid || normalizedSongInfo.id;
    const hash = normalizedSongInfo.hash || songId;
    const copyrightId = normalizedSongInfo.copyrightId;
    
    if (!songId) {
        console.error('无法获取歌曲ID:', JSON.stringify(songInfo));
        return null;
    }
    
    // 备用代理服务器列表
    const proxyServers = {
        kg: [
            `http://ts.tempmusics.tk/url/kg/${hash}/${quality}`,
            `http://tm.tempmusics.tk/url/kg/${hash}/${quality}`,
            `https://api.vvhan.com/api/music/kg?id=${hash}`,
            `http://124.71.215.146:3000/url/kg/${hash}/${quality}`
        ],
        wy: [
            `http://ts.tempmusics.tk/url/wy/${songId}/${quality}`,
            `http://tm.tempmusics.tk/url/wy/${songId}/${quality}`,
            `http://124.71.215.146:3000/url/wy/${songId}/${quality}`
        ],
        kw: [
            `http://ts.tempmusics.tk/url/kw/${songId}/${quality}`,
            `http://tm.tempmusics.tk/url/kw/${songId}/${quality}`,
            `http://124.71.215.146:3000/url/kw/${songId}/${quality}`
        ],
        tx: [
            `http://ts.tempmusics.tk/url/tx/${songId}/${quality}`,
            `http://tm.tempmusics.tk/url/tx/${songId}/${quality}`,
            `http://124.71.215.146:3000/url/tx/${songId}/${quality}`
        ],
        mg: [
            `http://ts.tempmusics.tk/url/mg/${copyrightId || songId}/${quality}`,
            `http://tm.tempmusics.tk/url/mg/${copyrightId || songId}/${quality}`,
            `http://124.71.215.146:3000/url/mg/${copyrightId || songId}/${quality}`
        ]
    };
    
    // 根据不同平台使用不同的代理策略
    switch (source) {
        case 'kg': {
            // 酷狗音乐使用 hash 获取播放链接
            const proxyUrls = proxyServers.kg;
            for (const proxyUrl of proxyUrls) {
                try {
                    console.log(`尝试通过代理获取酷狗播放链接: ${proxyUrl}`);
                    const response = await fetch(proxyUrl, { timeout: 10000, signal: controller.signal });
                    const text = await response.text();
                    // 尝试解析为 JSON
                    try {
                        const json = JSON.parse(text);
                        if (json.code === 0 && json.data) {
                            console.log(`酷狗播放链接(代理): ${json.data}`);
                            return json.data;
                        }
                    } catch {
                        // 如果不是 JSON，检查是否是直接返回的 URL
                        if (text.startsWith('http') && text.length > 20) {
                            console.log(`酷狗播放链接(代理): ${text}`);
                            return text;
                        }
                    }
                } catch (error) {
                    if (error.name === 'AbortError') throw error;
                    console.error(`酷狗代理请求失败:`, error.message);
                }
            }
            break;
        }
        
        case 'kw': {
            // 酷我音乐尝试使用官方API
            const url = `https://www.kuwo.cn/api/www/music/playUrl?mid=${songId}&type=convert_url3&br=${quality}kmp3`;
            try {
                console.log(`尝试酷我播放链接API: ${url}`);
                const response = await fetch(url, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Referer': 'https://www.kuwo.cn/'
                    },
                    signal: controller.signal
                });
                const json = await response.json();
                if (json.data && json.data.url) {
                    console.log(`酷我播放链接: ${json.data.url}`);
                    return json.data.url;
                }
            } catch (error) {
                if (error.name === 'AbortError') throw error;
                console.error(`酷我请求失败:`, error.message);
            }
            
            // 尝试代理
            const proxyUrls = proxyServers.kw;
            for (const proxyUrl of proxyUrls) {
                try {
                    console.log(`尝试代理获取酷我播放链接: ${proxyUrl}`);
                    const response = await fetch(proxyUrl, { timeout: 10000, signal: controller.signal });
                    const text = await response.text();
                    try {
                        const json = JSON.parse(text);
                        if (json.code === 0 && json.data) {
                            console.log(`酷我播放链接(代理): ${json.data}`);
                            return json.data;
                        }
                    } catch {
                        if (text.startsWith('http') && text.length > 20) {
                            console.log(`酷我播放链接(代理): ${text}`);
                            return text;
                        }
                    }
                } catch (error) {
                    if (error.name === 'AbortError') throw error;
                    console.error(`酷我代理请求失败:`, error.message);
                }
            }
            break;
        }
        
        case 'tx': {
            // QQ音乐使用第三方代理
            const proxyUrls = proxyServers.tx;
            for (const proxyUrl of proxyUrls) {
                try {
                    console.log(`尝试通过代理获取QQ音乐播放链接: ${proxyUrl}`);
                    const response = await fetch(proxyUrl, { timeout: 10000, signal: controller.signal });
                    const text = await response.text();
                    try {
                        const json = JSON.parse(text);
                        if (json.code === 0 && json.data) {
                            console.log(`QQ音乐播放链接(代理): ${json.data}`);
                            return json.data;
                        }
                    } catch {
                        if (text.startsWith('http') && text.length > 20) {
                            console.log(`QQ音乐播放链接(代理): ${text}`);
                            return text;
                        }
                    }
                } catch (error) {
                    if (error.name === 'AbortError') throw error;
                    console.error(`QQ音乐代理请求失败:`, error.message);
                }
            }
            break;
        }
        
        case 'mg': {
            // 咪咕音乐使用 copyrightId 获取播放链接
            const useId = copyrightId || songId;
            const proxyUrls = proxyServers.mg;
            for (const proxyUrl of proxyUrls) {
                try {
                    console.log(`尝试通过代理获取咪咕播放链接: ${proxyUrl}`);
                    const response = await fetch(proxyUrl, { timeout: 10000, signal: controller.signal });
                    const text = await response.text();
                    try {
                        const json = JSON.parse(text);
                        if (json.code === 0 && json.data) {
                            console.log(`咪咕播放链接(代理): ${json.data}`);
                            return json.data;
                        }
                    } catch {
                        if (text.startsWith('http') && text.length > 20) {
                            console.log(`咪咕播放链接(代理): ${text}`);
                            return text;
                        }
                    }
                } catch (error) {
                    if (error.name === 'AbortError') throw error;
                    console.error(`咪咕代理请求失败:`, error.message);
                }
            }
            break;
        }
        
        case 'wy': {
            // 网易云音乐尝试官方API
            const url = `https://music.163.com/api/song/enhance/player/url?id=${songId}&ids=[${songId}]&br=${parseInt(quality) * 1000}`;
            try {
                console.log(`尝试网易云播放链接API: ${url}`);
                const response = await fetch(url, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Referer': 'https://music.163.com/'
                    },
                    signal: controller.signal
                });
                const json = await response.json();
                if (json.data && json.data[0] && json.data[0].url) {
                    console.log(`网易云播放链接: ${json.data[0].url}`);
                    return json.data[0].url;
                }
            } catch (error) {
                if (error.name === 'AbortError') throw error;
                console.error(`网易云请求失败:`, error.message);
            }
            
            // 尝试代理
            const proxyUrls = proxyServers.wy;
            for (const proxyUrl of proxyUrls) {
                try {
                    console.log(`尝试通过代理获取网易云播放链接: ${proxyUrl}`);
                    const response = await fetch(proxyUrl, { timeout: 10000, signal: controller.signal });
                    const text = await response.text();
                    try {
                        const json = JSON.parse(text);
                        if (json.code === 0 && json.data) {
                            console.log(`网易云播放链接(代理): ${json.data}`);
                            return json.data;
                        }
                    } catch {
                        if (text.startsWith('http') && text.length > 20) {
                            console.log(`网易云播放链接(代理): ${text}`);
                            return text;
                        }
                    }
                } catch (error) {
                    if (error.name === 'AbortError') throw error;
                    console.error(`网易云代理请求失败:`, error.message);
                }
            }
            break;
        }
    }
    
    console.log(`${source} 无法获取播放链接`);
    return null;
    } catch (error) {
        if (error.name === 'AbortError') {
            console.log('[MusicUrl] 播放链接获取请求已被取消');
            return null;
        }
        console.error(`[MusicUrl] 获取播放链接失败:`, error.message);
        throw error;
    } finally {
        // 清理控制器（如果当前控制器是我们创建的）
        if (currentMusicUrlController === controller) {
            currentMusicUrlController = null;
        }
    }
}

// 播放在线音乐流
function playOnlineMusic(url, retryCount = 0) {
    try {
        let playerProcess = null;
        
        console.log('尝试播放在线音乐:', url.substring(0, 100) + (url.length > 100 ? '...' : ''));
        
        if (IS_DOCKER) {
            // Docker 环境使用 ffmpeg + aplay 管道
            playerProcess = spawn('ffmpeg', [
                '-reconnect', '1',
                '-reconnect_streamed', '1',
                '-reconnect_delay_max', '5',
                '-i', url,
                '-f', 's16le',
                '-ar', '44100',
                '-ac', '2',
                '-loglevel', 'error',
                '-timeout', '5000000',
                'pipe:1'
            ], {
                stdio: ['ignore', 'pipe', 'pipe']
            });
            
            const aplayProcess = spawn('aplay', [
                '-D', currentAudioDevice || 'default',
                '-f', 'S16_LE',
                '-r', '44100',
                '-c', '2'
            ], {
                stdio: ['pipe', 'ignore', 'ignore']
            });
            
            playerProcess.stdout.pipe(aplayProcess.stdin);
            
            playerProcess._aplayProcess = aplayProcess;
            
            // 捕获 ffmpeg 的错误输出
            playerProcess.stderr.on('data', (data) => {
                console.error('ffmpeg 错误:', data.toString().trim());
            });
            
            aplayProcess.on('error', (error) => {
                console.error('aplay 错误:', error.message);
            });
            
            aplayProcess.on('exit', (code) => {
                if (code !== 0) {
                    console.error('aplay 异常退出，代码:', code);
                }
            });
        } else {
            // 非 Docker 环境使用 ffplay
            const args = [
                '-nodisp',
                '-autoexit',
                '-volume', String(Math.round(currentVolume * 20)),
                '-hide_banner',
                '-loglevel', 'error'
            ];
            
            if (currentAudioDevice && currentAudioDevice !== 'default') {
                args.push('-audio_device', currentAudioDevice);
            }
            
            args.push(url);
            
            console.log('ffplay 参数:', args.join(' '));
            
            playerProcess = spawn('ffplay', args, {
                stdio: ['ignore', 'pipe', 'pipe']
            });
            
            // 捕获 ffplay 的输出用于调试
            playerProcess.stderr.on('data', (data) => {
                const output = data.toString().trim();
                if (output && !output.includes('Opening') && !output.includes('Metadata:')) {
                    console.log('ffplay 输出:', output);
                }
            });
        }
        
        // 使用 currentPlayer 变量，以便 pauseMusic 和 stopMusic 能够控制
        currentPlayer = playerProcess;
        
        playerProcess.on('error', (error) => {
            console.error('在线播放错误:', error.message);
            console.error('错误详情:', error);
            isPlaying = false;
            
            // 尝试重新播放（最多重试2次）
            if (retryCount < 2) {
                console.log(`重试播放（第 ${retryCount + 1} 次）...`);
                setTimeout(() => {
                    playOnlineMusic(url, retryCount + 1);
                }, 1000);
            }
        });
        
        playerProcess.on('exit', (code, signal) => {
            console.log('在线音乐播放结束，退出代码:', code, '信号:', signal);
            isPlaying = false;
            
            // 检查是否是正常退出（代码0或143表示被kill）
            const isNormalExit = code === 0 || code === 143 || code === null;
            
            if (!isNormalExit) {
                console.error('播放器异常退出，代码:', code);
                
                // 尝试重新播放（最多重试2次）
            if (retryCount < 2) {
                console.log(`重试播放（第 ${retryCount + 1} 次）...`);
                // 如果是第一次重试，尝试重新获取播放链接
                if (retryCount === 0 && currentIndex >= 0) {
                    const track = currentPlaylist[currentIndex];
                    if (track && (track.isOnline || track.path.startsWith('online://'))) {
                        console.log('尝试重新获取播放链接...');
                        getMusicPlayUrl(track.source, track.songInfo || {
                            songId: track.path.split('/')[2],
                            name: track.title,
                            singer: track.artist,
                            albumName: track.album
                        }, '128').then(newUrl => {
                            if (newUrl) {
                                track.playUrl = newUrl;
                                console.log('获取新链接成功，重试播放...');
                                playOnlineMusic(newUrl, retryCount + 1);
                            } else {
                                // 获取新链接失败，使用旧链接重试
                                playOnlineMusic(url, retryCount + 1);
                            }
                        }).catch(() => {
                            // 获取新链接失败，使用旧链接重试
                            playOnlineMusic(url, retryCount + 1);
                        });
                    } else {
                        playOnlineMusic(url, retryCount + 1);
                    }
                } else {
                    setTimeout(() => {
                        playOnlineMusic(url, retryCount + 1);
                    }, 1000);
                }
                return; // 不自动播放下一首，先重试当前歌曲
            }
            }
            
            // 自动播放下一首（只有正常退出或重试失败后才继续）
            if (playOutput === 'client') {
                console.log('📱 客户端模式，不执行服务端自动切歌');
                return;
            }

            if (playMode === 'sequence' && currentIndex < currentPlaylist.length - 1) {
                const nextIndex = currentIndex + 1;
                const nextTrack = currentPlaylist[nextIndex];
                if (nextTrack) {
                    currentIndex = nextIndex;
                    isPlaying = true;
                    
                    if (nextTrack.isOnline || nextTrack.path.startsWith('online://')) {
                        // 下一首是在线音乐
                        playOnlineMusic(nextTrack.playUrl);
                    } else {
                        // 下一首是本地音乐
                        playMusic(nextTrack.path);
                    }
                }
            }
        });
        
    } catch (error) {
        console.error('播放在线音乐失败:', error.message);
        console.error('错误详情:', error);
        isPlaying = false;
        
        // 尝试重新播放（最多重试2次）
        if (retryCount < 2) {
            console.log(`重试播放（第 ${retryCount + 1} 次）...`);
            setTimeout(() => {
                playOnlineMusic(url, retryCount + 1);
            }, 1000);
        }
    }
}

// HTML 解码辅助函数
function decodeHTML(str) {
    return str
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'");
}

// 格式化时长
function formatDuration(seconds) {
    const s = parseInt(seconds);
    if (isNaN(s) || s === 0) return '';
    const mins = Math.floor(s / 60);
    const secs = s % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// 创建临时上传目录
const tempUploadDir = path.join(__dirname, 'temp_uploads');
if (!fs.existsSync(tempUploadDir)) {
    fs.mkdirSync(tempUploadDir, { recursive: true });
    console.log(`📁 创建临时上传目录: ${tempUploadDir}`);
}

let server = null;

server = app.listen(PORT, async () => {
    console.log(`🎵 音乐播放器服务已启动`);
    console.log(`📻 访问地址：http://localhost:${PORT}`);
    console.log(`📂 工作目录：${process.cwd()}`);

    // 初始化自定义音源
    await initCustomSources();

    try {
        const devices = await getAudioDevices();
        console.log(`🔊 检测到 ${devices.length} 个声卡设备:`);
        devices.forEach(device => {
            console.log(`   - ${device.name}`);
        });
        // 如果检测到设备，且当前没有保存的设备，才将第一个设备设置为当前设备
        if (devices.length > 0) {
            if (!currentAudioDevice) {
                currentAudioDevice = devices[0].id;
                console.log(`🎧 默认使用第一个设备: ${devices[0].name}`);
            } else {
                // 根据设备ID查找设备名称
                const savedDevice = devices.find(d => d.id === currentAudioDevice);
                if (savedDevice) {
                    console.log(`🎧 使用已保存的设备: ${savedDevice.name}`);
                } else {
                    console.log(`🎧 使用已保存的设备: ${currentAudioDevice} (设备未找到)`);
                }
            }
        } else {
            console.log('⚠️ 未检测到声卡设备');
        }
    } catch (error) {
        console.log('⚠️ 声卡设备检测失败:', error.message);
    }

    console.log(`📤 请上传音乐文件开始播放`);
});

async function gracefulShutdown(signal) {
    console.log(`\n📢 收到 ${signal} 信号，正在优雅关闭...`);

    // 停止当前播放
    stopMusic();

    if (server) {
        server.close((err) => {
            if (err) {
                console.error('❌ 关闭服务器时发生错误:', err);
                process.exit(1);
            }
            console.log('✅ HTTP服务器已关闭');
            process.exit(0);
        });
    } else {
        process.exit(0);
    }
}

// 监听 SIGTERM 和 SIGINT 信号
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// 全局错误处理 - 防止未捕获异常导致连接重置
process.on('uncaughtException', (err) => {
    console.error('未捕获异常:', err);
    stopMusic();
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('未处理的 Promise Rejection:', reason);
});
