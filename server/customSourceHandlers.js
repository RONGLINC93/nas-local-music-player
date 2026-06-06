"use strict";
const fs = require('fs');
const path = require('path');
const userApi = require('./userApi');

async function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', chunk => { chunks.push(chunk); });
        req.on('end', () => {
            const buffer = Buffer.concat(chunks);
            resolve(buffer.toString('utf-8'));
        });
        req.on('error', reject);
    });
}

async function handleValidate(req, res) {
    try {
        const body = await readBody(req);
        const { script, username } = JSON.parse(body);
        const targetOwner = (username && username !== 'default') ? username : 'open';
        if (targetOwner === 'open') {
            const auth = req.headers['x-frontend-auth'];
            if (auth !== global.lx?.config?.['frontend.password'] && auth !== process.env.FRONTEND_PASSWORD) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: '权限不足：管理自定义源需要先验证管理员身份。' }));
                return;
            }
        }
        if (!script || typeof script !== 'string') {
            throw new Error('Invalid script content');
        }
        const metadata = userApi.extractMetadata(script);
        const result = await userApi.loadUserApi({
            id: 'temp_validation',
            script,
            enabled: false,
            ...metadata,
            owner: 'temp'
        });
        if (result.success) {
            const api = result.apiInstance;
            const sources = api?.info?.sources || {};
            const sourcesCount = Object.keys(sources).length;
            if (sourcesCount === 0) {
                throw new Error('脚本没有注册任何音源。请确保脚本正确调用了 lx.send("inited", { sources: {...} })');
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                valid: true,
                metadata,
                sources: Object.keys(sources),
                sourcesCount
            }));
        } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                valid: false,
                error: result.error,
                requireUnsafe: result.requireUnsafe,
                metadata
            }));
        }
    } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ valid: false, error: err.message }));
    }
}

async function getScriptInfo(scriptContent, allowUnsafeVM = false) {
    const metadata = userApi.extractMetadata(scriptContent);
    let supportedSources = [];
    let requireUnsafe = false;
    try {
        const result = await userApi.loadUserApi({
            id: 'temp_analysis_' + Date.now(),
            script: scriptContent,
            enabled: false,
            allowUnsafeVM,
            ...metadata,
            owner: 'temp'
        });
        if (result.success && result.apiInstance?.info?.sources) {
            supportedSources = Object.keys(result.apiInstance.info.sources);
        } else {
            requireUnsafe = !!result.requireUnsafe;
        }
    } catch (e) {
        console.warn('[CustomSource] 分析脚本支持源失败:', e.message);
    }
    return { metadata, supportedSources, requireUnsafe };
}

function getSourceDir(username) {
    const dataPath = process.env.DATA_PATH || path.join(__dirname, '../data');
    const root = path.join(dataPath, 'users', 'source');
    const targetDirName = (username && username !== 'default' && username !== 'open') ? username : '_open';
    return path.join(root, targetDirName);
}

function generateId(name, fallbackFilename) {
    let input = name || fallbackFilename || 'source';
    try {
        input = decodeURIComponent(input);
    } catch (e) { }
    let base = path.basename(input);
    if (base.toLowerCase().endsWith('.js')) {
        base = base.slice(0, -3);
    }
    const clean = base.replace(/[\\/:*?"<>|]/g, '_').trim();
    return `${clean || 'source'}.js`;
}

async function handleUpload(req, res) {
    try {
        const body = await readBody(req);
        const { filename, content, username, allowUnsafeVM } = JSON.parse(body);
        const targetOwner = (username && username !== 'default') ? username : 'open';
        if (targetOwner === 'open') {
            const auth = req.headers['x-frontend-auth'];
            if (auth !== global.lx?.config?.['frontend.password'] && auth !== process.env.FRONTEND_PASSWORD) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: '公共源管理已受限，仅管理员可操作。' }));
                return;
            }
        }
        const sourcesDir = getSourceDir(username);
        const metaPath = path.join(sourcesDir, 'sources.json');
        if (!fs.existsSync(sourcesDir)) {
            fs.mkdirSync(sourcesDir, { recursive: true });
        }
        const { metadata, supportedSources, requireUnsafe } = await getScriptInfo(content, allowUnsafeVM);
        if (requireUnsafe && !allowUnsafeVM) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, requireUnsafe: true, message: '该脚本需要原生 VM 模式运行，可能存在安全风险，是否继续？' }));
            return;
        }
        const id = generateId(metadata.name, filename);
        const scriptPath = path.join(sourcesDir, id);
        let sources = [];
        if (fs.existsSync(metaPath)) {
            sources = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        }
        const existing = sources.find(s => s.id === id);
        if (existing) {
            throw new Error(`源 "${metadata.name || filename}" 已存在于 [${targetOwner}]`);
        }
        fs.writeFileSync(scriptPath, content, 'utf-8');
        sources.push({
            id,
            name: metadata.name || filename,
            version: metadata.version || '1.0.0',
            author: metadata.author || '未知',
            description: metadata.description || '',
            homepage: metadata.homepage || '',
            size: Buffer.byteLength(content, 'utf-8'),
            supportedSources,
            enabled: false,
            uploadTime: new Date().toISOString(),
            allowUnsafeVM: !!requireUnsafe || !!allowUnsafeVM,
            requireUnsafe: !!requireUnsafe
        });
        fs.writeFileSync(metaPath, JSON.stringify(sources, null, 2));
        await userApi.initUserApis(targetOwner);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, id, metadata, supportedSources, owner: targetOwner, allowUnsafeVM: !!requireUnsafe || !!allowUnsafeVM }));
    } catch (err) {
        console.error('[CustomSource] Upload error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
    }
}

async function handleImport(req, res) {
    try {
        const body = await readBody(req);
        const { url, filename, username, allowUnsafeVM } = JSON.parse(body);
        if (!url) {
            throw new Error('Missing URL');
        }
        const download = async (targetUrl, depth = 0) => {
            if (depth > 5) throw new Error('Too many redirects');
            const protocol = targetUrl.startsWith('https') ? require('https') : require('http');
            return new Promise((resolve, reject) => {
                protocol.get(targetUrl, (response) => {
                    const { statusCode } = response;
                    if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
                        let redirectUrl = response.headers.location;
                        if (!redirectUrl.startsWith('http')) {
                            const parsedUrl = new URL(targetUrl);
                            redirectUrl = `${parsedUrl.protocol}//${parsedUrl.host}${redirectUrl}`;
                        }
                        return resolve(download(redirectUrl, depth + 1));
                    }
                    if (statusCode !== 200) {
                        return reject(new Error(`Failed to download: status code ${statusCode}`));
                    }
                    const chunks = [];
                    response.on('data', (chunk) => chunks.push(chunk));
                    response.on('end', () => {
                        const buffer = Buffer.concat(chunks);
                        resolve(buffer.toString('utf-8'));
                    });
                    response.on('error', reject);
                }).on('error', reject);
            });
        };
        const content = await download(url);
        const { metadata, supportedSources, requireUnsafe } = await getScriptInfo(content, allowUnsafeVM);
        if (requireUnsafe && !allowUnsafeVM) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, requireUnsafe: true, message: '该脚本需要原生 VM 模式运行，可能存在安全风险，是否继续？' }));
            return;
        }
        const targetOwner = (username && username !== 'default') ? username : 'open';
        if (targetOwner === 'open') {
            const auth = req.headers['x-frontend-auth'];
            if (auth !== global.lx?.config?.['frontend.password'] && auth !== process.env.FRONTEND_PASSWORD) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: '公共源导入已受限，仅管理员可操作。' }));
                return;
            }
        }
        const sourcesDir = getSourceDir(username);
        const metaPath = path.join(sourcesDir, 'sources.json');
        if (!fs.existsSync(sourcesDir)) {
            fs.mkdirSync(sourcesDir, { recursive: true });
        }
        const displayName = metadata.name || filename || 'unknown_source';
        const id = generateId(metadata.name, filename || 'unknown_source');
        const scriptPath = path.join(sourcesDir, id);
        let sources = [];
        if (fs.existsSync(metaPath)) {
            sources = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        }
        const existing = sources.find(s => s.id === id);
        if (existing) {
            throw new Error(`源 "${displayName}" 已存在于 [${targetOwner}]`);
        }
        fs.writeFileSync(scriptPath, content, 'utf-8');
        sources.push({
            id,
            name: metadata.name || filename,
            version: metadata.version || '1.0.0',
            author: metadata.author || '未知',
            description: metadata.description || '',
            homepage: metadata.homepage || '',
            size: Buffer.byteLength(content, 'utf-8'),
            supportedSources,
            enabled: false,
            uploadTime: new Date().toISOString(),
            sourceUrl: url,
            allowUnsafeVM: !!requireUnsafe || !!allowUnsafeVM,
            requireUnsafe: !!requireUnsafe
        });
        fs.writeFileSync(metaPath, JSON.stringify(sources, null, 2));
        await userApi.initUserApis(targetOwner);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, filename: displayName, id, metadata, supportedSources, owner: targetOwner, allowUnsafeVM: !!requireUnsafe || !!allowUnsafeVM }));
    } catch (err) {
        console.error('[CustomSource] Import error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
    }
}

async function handleList(req, res, username) {
    const openSources = [];
    const userSources = [];
    const openSourcesDir = getSourceDir('open');
    const openMetaPath = path.join(openSourcesDir, 'sources.json');
    if (fs.existsSync(openMetaPath)) {
        try {
            const parsedOpenSources = JSON.parse(fs.readFileSync(openMetaPath, 'utf-8'));
            parsedOpenSources.forEach((s) => {
                s.owner = 'open';
                s.isPublic = true;
                openSources.push(s);
            });
        } catch (e) { }
    }
    let userStates = {};
    if (username && username !== 'default') {
        const userSourcesDir = getSourceDir(username);
        const userMetaPath = path.join(userSourcesDir, 'sources.json');
        const userStatesPath = path.join(userSourcesDir, 'states.json');
        if (fs.existsSync(userStatesPath)) {
            try {
                userStates = JSON.parse(fs.readFileSync(userStatesPath, 'utf-8'));
            } catch (e) { }
        }
        if (fs.existsSync(userMetaPath)) {
            try {
                const parsedUserSources = JSON.parse(fs.readFileSync(userMetaPath, 'utf-8'));
                parsedUserSources.forEach((s) => {
                    s.owner = username;
                    s.isPublic = false;
                    userSources.push(s);
                });
            } catch (e) { }
        }
    }
    const allSources = [];
    const userSourceIds = new Set(userSources.map(s => s.id));
    openSources.forEach((s) => {
        if (!userSourceIds.has(s.id)) {
            if (userStates[s.id] && typeof userStates[s.id].enabled === 'boolean') {
                s.enabled = userStates[s.id].enabled;
            }
            allSources.push(s);
        }
    });
    allSources.push(...userSources);
    const enrichedSources = allSources.map((source) => {
        const status = userApi.getApiStatus(source.owner, source.id);
        if (status) {
            source.status = status.status;
            source.error = status.error;
        }
        return source;
    });
    let targetOwner = (username && username !== 'default') ? username : 'open';
    let orderPath = path.join(getSourceDir(targetOwner), 'order.json');
    let order = [];
    if (!fs.existsSync(orderPath) && targetOwner !== 'open') {
        orderPath = path.join(getSourceDir('open'), 'order.json');
    }
    if (fs.existsSync(orderPath)) {
        try {
            order = JSON.parse(fs.readFileSync(orderPath, 'utf-8'));
        } catch (e) { }
    }
    if (order.length > 0) {
        const idToIndex = new Map(order.map((id, index) => [id, index]));
        enrichedSources.sort((a, b) => {
            if (a.enabled !== b.enabled) {
                return a.enabled ? -1 : 1;
            }
            const indexA = idToIndex.has(a.id) ? idToIndex.get(a.id) : 999999;
            const indexB = idToIndex.has(b.id) ? idToIndex.get(b.id) : 999999;
            if (indexA !== indexB) {
                return indexA - indexB;
            }
            return 0;
        });
    } else {
        enrichedSources.sort((a, b) => {
            if (a.enabled !== b.enabled) {
                return a.enabled ? -1 : 1;
            }
            return 0;
        });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(enrichedSources));
}

async function handleToggle(req, res) {
    try {
        const body = await readBody(req);
        const { id, sourceId, enabled, username, allowUnsafeVM } = JSON.parse(body);
        const targetId = id || sourceId;
        let targetOwner = (username && username !== 'default') ? username : 'open';
        if (targetOwner === 'open') {
            const auth = req.headers['x-frontend-auth'];
            if (auth !== global.lx?.config?.['frontend.password'] && auth !== process.env.FRONTEND_PASSWORD) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: '公共源状态切换已受限，仅管理员可操作。' }));
                return;
            }
        }
        let sourcesDir = getSourceDir(targetOwner);
        let metaPath = path.join(sourcesDir, 'sources.json');
        let target = null;
        let sources = [];
        let isPublicSourceToggle = false;
        if (!fs.existsSync(sourcesDir)) {
            fs.mkdirSync(sourcesDir, { recursive: true });
        }
        if (fs.existsSync(metaPath)) {
            sources = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
            target = sources.find((s) => s.id === targetId);
        }
        if (!target && targetOwner !== 'open') {
            const openSourcesDir = getSourceDir('open');
            const openMetaPath = path.join(openSourcesDir, 'sources.json');
            if (fs.existsSync(openMetaPath)) {
                const openSources = JSON.parse(fs.readFileSync(openMetaPath, 'utf-8'));
                const openTarget = openSources.find((s) => s.id === targetId);
                if (openTarget) {
                    target = openTarget;
                    isPublicSourceToggle = true;
                }
            }
        }
        if (!target) {
            throw new Error('源不存在');
        }
        if (targetOwner === 'open') {
            const auth = req.headers['x-frontend-auth'];
            if (auth !== global.lx?.config?.['frontend.password'] && auth !== process.env.FRONTEND_PASSWORD) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: '权限不足：管理全局公开自定义源需要验证管理员身份。' }));
                return;
            }
        }
        if (isPublicSourceToggle) {
            const userStatesPath = path.join(sourcesDir, 'states.json');
            let states = {};
            if (fs.existsSync(userStatesPath)) {
                try {
                    states = JSON.parse(fs.readFileSync(userStatesPath, 'utf-8'));
                } catch (e) { }
            }
            if (!states[targetId]) states[targetId] = {};
            states[targetId].enabled = enabled !== undefined ? enabled : !(states[targetId].enabled ?? target.enabled);
            fs.writeFileSync(userStatesPath, JSON.stringify(states, null, 2));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, enabled: states[targetId].enabled }));
            return;
        }
        const oldEnabled = target.enabled;
        const oldAllowUnsafeVM = !!target.allowUnsafeVM;
        if (allowUnsafeVM === true) target.allowUnsafeVM = true;
        target.enabled = enabled !== undefined ? enabled : !target.enabled;
        fs.writeFileSync(metaPath, JSON.stringify(sources, null, 2));
        try {
            await userApi.initUserApis(targetOwner);
            if (target.enabled) {
                const status = userApi.getApiStatus(targetOwner, targetId);
                if (status && status.status === 'failed' && status.error === 'REQUIRE_UNSAFE_VM') {
                    console.warn(`[CustomSource] Detect REQUIRE_UNSAFE_VM during toggle for ${targetId}, rolling back...`);
                    target.enabled = oldEnabled;
                    target.allowUnsafeVM = oldAllowUnsafeVM;
                    fs.writeFileSync(metaPath, JSON.stringify(sources, null, 2));
                    await userApi.initUserApis(targetOwner);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, requireUnsafe: true, message: '该脚本需要原生 VM 模式运行，可能存在安全风险，是否继续？' }));
                    return;
                }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, enabled: target.enabled }));
        } catch (e) {
            if (e.message === 'REQUIRE_UNSAFE_VM') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, requireUnsafe: true, message: '该脚本需要原生 VM 模式运行，可能存在安全风险，是否继续？' }));
                return;
            }
            throw e;
        }
    } catch (err) {
        console.error('[CustomSource] Toggle error:', err);
        res.writeHead(500);
        res.end(err.message);
    }
}

async function handleReorder(req, res) {
    try {
        const body = await readBody(req);
        const { username, sourceIds } = JSON.parse(body);
        if (!Array.isArray(sourceIds)) {
            throw new Error('sourceIds must be an array');
        }
        let targetOwner = (username && username !== 'default') ? username : 'open';
        if (targetOwner === 'open') {
            const auth = req.headers['x-frontend-auth'];
            if (auth !== global.lx?.config?.['frontend.password'] && auth !== process.env.FRONTEND_PASSWORD) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: '公共源排序已受限，仅管理员可操作。' }));
                return;
            }
        }
        let sourcesDir = getSourceDir(targetOwner);
        let metaPath = path.join(sourcesDir, 'sources.json');
        let orderPath = path.join(sourcesDir, 'order.json');
        if (!fs.existsSync(sourcesDir)) {
            fs.mkdirSync(sourcesDir, { recursive: true });
        }
        fs.writeFileSync(orderPath, JSON.stringify(sourceIds, null, 2));
        if (fs.existsSync(metaPath)) {
            const sources = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
            const currentSourcesMap = new Map(sources.map((s) => [s.id, s]));
            const newSources = [];
            for (const id of sourceIds) {
                if (currentSourcesMap.has(id)) {
                    newSources.push(currentSourcesMap.get(id));
                    currentSourcesMap.delete(id);
                }
            }
            for (const [id, source] of currentSourcesMap) {
                newSources.push(source);
            }
            fs.writeFileSync(metaPath, JSON.stringify(newSources, null, 2));
        } else if (targetOwner !== 'open') {
            const openSourcesDir = getSourceDir('open');
            const openMetaPath = path.join(openSourcesDir, 'sources.json');
            if (fs.existsSync(openMetaPath)) {
                const sources = JSON.parse(fs.readFileSync(openMetaPath, 'utf-8'));
                const currentSourcesMap = new Map(sources.map((s) => [s.id, s]));
                const newSources = [];
                for (const id of sourceIds) {
                    if (currentSourcesMap.has(id)) {
                        newSources.push(currentSourcesMap.get(id));
                        currentSourcesMap.delete(id);
                    }
                }
                for (const [id, source] of currentSourcesMap) {
                    newSources.push(source);
                }
                fs.writeFileSync(openMetaPath, JSON.stringify(newSources, null, 2));
            }
        }
        await userApi.initUserApis(targetOwner);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
    } catch (err) {
        console.error('[CustomSource] Reorder error:', err);
        res.writeHead(500);
        res.end(err.message);
    }
}

async function handleDelete(req, res) {
    try {
        const body = await readBody(req);
        const { id, sourceId, username } = JSON.parse(body);
        const targetId = id || sourceId;
        let targetOwner = (username && username !== 'default') ? username : 'open';
        if (targetOwner === 'open') {
            const auth = req.headers['x-frontend-auth'];
            if (auth !== global.lx?.config?.['frontend.password'] && auth !== process.env.FRONTEND_PASSWORD) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: '公共源删除已受限，仅管理员可操作。' }));
                return;
            }
        }
        let sourcesDir = getSourceDir(targetOwner);
        let metaPath = path.join(sourcesDir, 'sources.json');
        let found = false;
        let sources = [];
        if (fs.existsSync(metaPath)) {
            sources = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
            if (sources.find((s) => s.id === targetId)) {
                found = true;
            }
        }
        if (!found && targetOwner !== 'open') {
            const openSourcesDir = getSourceDir('open');
            const openMetaPath = path.join(openSourcesDir, 'sources.json');
            if (fs.existsSync(openMetaPath)) {
                const openSources = JSON.parse(fs.readFileSync(openMetaPath, 'utf-8'));
                if (openSources.find((s) => s.id === targetId)) {
                    targetOwner = 'open';
                    sourcesDir = openSourcesDir;
                    metaPath = openMetaPath;
                    sources = openSources;
                    found = true;
                }
            }
        }
        if (!found) {
            throw new Error('源不存在');
        }
        if (targetOwner === 'open') {
            const auth = req.headers['x-frontend-auth'];
            if (auth !== global.lx?.config?.['frontend.password'] && auth !== process.env.FRONTEND_PASSWORD) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: '权限不足：删除全局公共源需要验证管理员身份。' }));
                return;
            }
        }
        const scriptPath = path.join(sourcesDir, targetId);
        sources = sources.filter((s) => s.id !== targetId);
        if (fs.existsSync(scriptPath)) {
            fs.unlinkSync(scriptPath);
        }
        fs.writeFileSync(metaPath, JSON.stringify(sources, null, 2));
        await userApi.initUserApis(targetOwner);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
    } catch (err) {
        console.error('[CustomSource] Delete error:', err);
        res.writeHead(500);
        res.end(err.message);
    }
}

module.exports = {
    handleValidate,
    handleUpload,
    handleImport,
    handleList,
    handleToggle,
    handleReorder,
    handleDelete
};