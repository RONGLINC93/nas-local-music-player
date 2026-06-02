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

const app = express();
const PORT = process.env.PORT || 9524;

// 配置：是否在 Docker 环境中运行
const IS_DOCKER = process.env.IS_DOCKER === 'true' || false;

app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));
app.use(express.static('public'));

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

let currentPlaylist = [];
let currentIndex = -1;
let isPlaying = false;
let currentVolume = 70; // 默认音量 70%
let isMuted = false; // 是否静音
let playbackStartTime = null; // 播放开始时间
let currentDuration = 0; // 当前歌曲时长（秒）
let currentAudioDevice = 'default'; // 当前选中的声卡设备
let playMode = 'sequence'; // 播放模式：sequence(顺序播放), random(随机播放), single(单曲播放), loop(单曲循环)
let pausedElapsed = 0; // 暂停时的已播放秒数

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
let taskOrderCounter = 0; // 全局任务序号计数器，确保任务按添加顺序执行

// 任务完成通知队列
let taskNotifications = []; // 存储队列完成的通知消息

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
            console.log(`📥 已加载 ${completedTasks.length} 个转换任务和 ${completedUploads.length} 个上传任务`);
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
const MUSIC_EXTENSIONS = ['.mp3', '.flac', '.wav', '.m4a', '.ogg', '.wma'];

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
            if (config.maxConvertWorkers !== undefined) {
                maxConvertWorkers = Math.max(1, Math.min(10, parseInt(config.maxConvertWorkers, 10) || 2));
                console.log(`⚙️ 已加载配置，转换线程数：${maxConvertWorkers}`);
            }
            if (config.maxUploadWorkers !== undefined) {
                maxUploadWorkers = Math.max(1, Math.min(10, parseInt(config.maxUploadWorkers, 10) || 3));
                console.log(`⚙️ 已加载配置，上传线程数：${maxUploadWorkers}`);
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
            maxConvertWorkers: maxConvertWorkers,
            maxUploadWorkers: maxUploadWorkers
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
loadMusicLibrary();

app.get('/api/playlist', (req, res) => {
    res.json({ playlist: currentPlaylist, currentIndex, isPlaying });
});

app.post('/api/upload-music', (req, res, next) => {
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
app.post('/api/upload-music-async', (req, res, next) => {
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
app.post('/api/scan-folders', async (req, res) => {
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
app.post('/api/update-metadata', async (req, res) => {
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
app.post('/api/convert-to-mp3', async (req, res) => {
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
    
    // 添加进行中的任务
    activeConvertTasks.forEach(task => {
        allTasks.push({
            id: task.id,
            orderIndex: task.orderIndex,
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
    
    // 添加队列中的任务
    convertQueue.forEach(task => {
        allTasks.push({
            id: task.id,
            orderIndex: task.orderIndex,
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
    
    // 添加已完成的任务
    completedTasks.forEach(task => {
        allTasks.push({
            id: task.id,
            orderIndex: task.orderIndex,
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
    
    // 根据状态过滤
    if (status && status !== 'all') {
        allTasks = allTasks.filter(task => task.status === status);
    }
    
    // 统计各状态任务数量
    const stats = {
        pending: allTasks.filter(t => t.status === 'queued').length,
        converting: allTasks.filter(t => t.status === 'converting').length,
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
app.delete('/api/tasks/:taskId', (req, res) => {
    const { taskId } = req.params;
    
    // 从队列中移除
    const queueIndex = convertQueue.findIndex(t => t.id === taskId);
    if (queueIndex !== -1) {
        convertQueue.splice(queueIndex, 1);
        res.json({ success: true, message: '任务已删除' });
    } else if (activeConvertTasks.find(t => t.id === taskId)) {
        // 不能删除正在转换的任务
        res.status(400).json({ success: false, error: '无法删除正在转换的任务' });
    } else {
        // 从已完成任务中删除
        const completedIndex = completedTasks.findIndex(t => t.id === taskId);
        if (completedIndex !== -1) {
            completedTasks.splice(completedIndex, 1);
            saveTaskData(); // 持久化保存
            res.json({ success: true, message: '任务已删除' });
        } else {
            res.json({ success: false, error: '任务不存在' });
        }
    }
});

// 清除已完成的任务
app.delete('/api/tasks', (req, res) => {
    // 清空已完成任务列表
    completedTasks = [];
    // 队列中只保留等待中的任务（转换中的不能清空）
    convertQueue = convertQueue.filter(t => t.status === 'queued');
    saveTaskData(); // 持久化保存
    res.json({ success: true, message: '已清除已完成的任务' });
});

// 取消转换任务
app.post('/api/cancel-convert', (req, res) => {
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
            activeConvertWorkers,
            activeUploadWorkers,
            convertQueueLength: convertQueue.length,
            uploadQueueLength: uploadQueue.length
        }
    });
});

// 更新线程数量配置
app.post('/api/worker-config', (req, res) => {
    const { maxConvertWorkers: newConvertWorkers, maxUploadWorkers: newUploadWorkers } = req.body;
    
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
    
    // 保存配置到config.json
    saveConfig();
    
    res.json({
        success: true,
        message: '配置已更新',
        config: {
            maxConvertWorkers,
            maxUploadWorkers
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
app.delete('/api/upload-tasks/:taskId', (req, res) => {
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
app.delete('/api/upload-tasks', (req, res) => {
    completedUploads = completedUploads.filter(t => t.status !== 'completed' && t.status !== 'failed');
    uploadQueue = uploadQueue.filter(t => t.status === 'queued');
    saveTaskData(); // 持久化保存
    res.json({ success: true, message: '已清除已完成的任务' });
});

// 批量转换（后台模式）
app.post('/api/batch-convert-mp3', async (req, res) => {
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

        // 保存到播放列表缓存
        try {
            fs.writeFileSync(PLAYLIST_CACHE_FILE, JSON.stringify(currentPlaylist, null, 2));
            console.log(`💾 已保存播放列表缓存: ${tracks.length} 首音乐`);
        } catch (error) {
            console.error('保存播放列表缓存失败:', error.message);
        }

        // 立即开始播放第一首
        const firstTrack = tracks[0];
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

app.delete('/api/delete/:index', async (req, res) => {
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
app.delete('/api/delete-file', async (req, res) => {
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
        
        // 删除文件夹缓存，下次打开时重新生成
        if (fs.existsSync(FOLDER_CACHE_FILE)) {
            fs.unlinkSync(FOLDER_CACHE_FILE);
            console.log('🗑️ 删除文件夹缓存');
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

// 批量从播放列表删除（不删除物理文件）
app.post('/api/batch-delete-playlist', async (req, res) => {
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
        
        console.log(`🎵 单曲播放：${metadata.title}`);
        
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

// 通过路径下载文件 API
app.get('/api/download', (req, res) => {
    const filePath = decodeURIComponent(req.query.path);
    
    // 安全检查：确保路径在允许的目录内
    if (!filePath.startsWith(MUSIC_DIR)) {
        return res.status(403).json({ success: false, error: '访问被拒绝' });
    }
    
    sendFileDownload(res, filePath);
});

// 批量加入播放列表 API
app.post('/api/batch-add-to-playlist', async (req, res) => {
    try {
        const { files } = req.body;
        
        if (!Array.isArray(files) || files.length === 0) {
            return res.status(400).json({ success: false, error: '请选择要添加的文件' });
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
        res.json({ success: true, message: `成功添加 ${addedCount} 首歌曲到播放列表` });
        
    } catch (error) {
        console.error('批量添加失败:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 批量删除文件 API
// 新建文件夹
app.post('/api/create-folder', (req, res) => {
    try {
        const { parentPath, folderName } = req.body;
        
        if (!folderName || folderName.trim() === '') {
            return res.status(400).json({ success: false, error: '请输入文件夹名称' });
        }
        
        // 处理父路径
        let fullParentPath = parentPath;
        if (parentPath.startsWith('/music')) {
            const relativePath = parentPath.substring('/music'.length);
            fullParentPath = path.join(MUSIC_DIR, relativePath);
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
        
        // 删除文件夹缓存，下次打开时重新生成
        if (fs.existsSync(FOLDER_CACHE_FILE)) {
            fs.unlinkSync(FOLDER_CACHE_FILE);
        }
        
        res.json({ success: true, message: `成功创建文件夹 "${folderName}"` });
        
    } catch (error) {
        console.error('创建文件夹失败:', error);
        res.status(500).json({ success: false, error: '创建文件夹失败: ' + error.message });
    }
});

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

app.post('/api/scrape-metadata', async (req, res) => {
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
app.post('/api/scrape-folder', async (req, res) => {
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
app.post('/api/organize', async (req, res) => {
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
app.post('/api/batch-move-files', (req, res) => {
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

app.post('/api/batch-delete-files', (req, res) => {
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
        
        // 删除文件夹缓存，下次打开时重新生成
        if (fs.existsSync(FOLDER_CACHE_FILE)) {
            fs.unlinkSync(FOLDER_CACHE_FILE);
            console.log('🗑️ 删除文件夹缓存');
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
        
        // 使用项目已有的 adm-zip 库
        const zip = new AdmZip();
        
        for (const filePath of files) {
            if (!filePath.startsWith(MUSIC_DIR)) {
                continue;
            }
            
            if (fs.existsSync(filePath)) {
                const fileName = path.basename(filePath);
                const fileContent = fs.readFileSync(filePath);
                zip.addFile(fileName, fileContent);
            }
        }
        
        const zipBuffer = zip.toBuffer();
        
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="music_batch_${Date.now()}.zip"`);
        res.setHeader('Content-Length', zipBuffer.length);
        
        res.send(zipBuffer);
        
    } catch (error) {
        console.error('批量下载失败:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/play/:index', (req, res) => {
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

    // 先停止当前播放
    stopMusic();

    // 设置新的播放索引
    currentIndex = index;
    isPlaying = true;

    console.log(`🎵 切换歌曲：${track.title}`);

    // 立即开始播放，不延迟
    playMusic(track.path).then(() => {
        res.json({
            success: true,
            current: track,
            index: currentIndex
        });
    });
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
app.get('/api/seek', (req, res) => {
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
    
    // 重新开始播放（从指定位置）
    setTimeout(() => {
        const track = currentPlaylist[currentIndex];
        if (track) {
            playMusicFromPosition(track.path, seekTime, isPlaying);
        }
    }, 100);
    
    res.json({ 
        success: true, 
        seekTime: seekTime,
        duration: maxTime
    });
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
app.get('/api/download/:index', (req, res) => {
    const index = parseInt(req.params.index);

    if (index < 0 || index >= currentPlaylist.length) {
        return res.status(404).json({ success: false, message: '歌曲不存在' });
    }

    const track = currentPlaylist[index];
    const filePath = track.path;
    
    sendFileDownload(res, filePath);
});

app.get('/api/next', (req, res) => {
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
    isPlaying = true;
    playMusic(track.path).then(() => {
        res.json({ success: true, current: track, index: currentIndex, isPlaying: isPlaying });
    });
});

app.get('/api/previous', (req, res) => {
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
    isPlaying = true;
    playMusic(track.path).then(() => {
        res.json({ success: true, current: track, index: currentIndex, isPlaying: isPlaying });
    });
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
            // Windows: 停止 ffplay 进程（恢复时重新播放）
            exec('taskkill /f /im ffplay.exe', (err) => {
                if (err) {
                    console.log('⚠️ 停止 ffplay 失败:', err.message);
                } else {
                    console.log('✅ ffplay 已停止（暂停）');
                }
            });
            currentPlayer = null;
        } else {
            // Linux/Docker 使用 kill -STOP
            currentPlayer.kill('SIGSTOP');
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
                // 立即停止 aplay
                currentPlayer.kill('SIGKILL');

                // 如果是 ffmpeg+aplay 的管道，也需要停止 ffmpeg
                if (currentPlayer.spawnargs && currentPlayer.spawnargs.includes('S16_LE')) {
                    // 这是 aplay 进程，立即停止 ffmpeg
                    exec('pkill -9 -f "ffmpeg.*pipe" || true', (err) => {
                        if (err) {
                            // 忽略错误，ffmpeg 可能已经停止
                        }
                    });
                }
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

app.post('/api/audio-device', (req, res) => {
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

app.post('/api/test-audio', async (req, res) => {
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
app.post('/api/system-update', updateUpload.single('file'), async (req, res) => {
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

        console.log('正在解压更新包...');
        const zip = new AdmZip(upgradeFilePath);
        const zipEntries = zip.getEntries();

        for (const entry of zipEntries) {
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
        }
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
app.post('/api/auto-update', async (req, res) => {
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
        await downloadFile(zipUrl, upgradeFilePath);

        console.log(`更新包已下载: ${upgradeFilePath}, 大小: ${fs.statSync(upgradeFilePath).size} bytes`);

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

        console.log('正在解压更新包...');
        const zip = new AdmZip(upgradeFilePath);
        const zipEntries = zip.getEntries();

        for (const entry of zipEntries) {
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
        }
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

        copyFiles(sourceDir, __dirname);
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
function downloadFile(url, dest) {
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
                downloadFile(response.headers.location, dest).then(resolve).catch(reject);
                return;
            }

            if (response.statusCode !== 200) {
                reject(new Error(`下载失败，HTTP 状态码: ${response.statusCode}`));
                return;
            }

            const fileStream = fs.createWriteStream(dest);
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
