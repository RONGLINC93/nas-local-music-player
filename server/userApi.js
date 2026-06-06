"use strict";
const vm2 = require("vm2");
const fs = require('fs');
const path = require('path');
const needle = require('needle');
const crypto = require('crypto');
const zlib = require('zlib');
const util = require('util');
const inflate = util.promisify(zlib.inflate);
const deflate = util.promisify(zlib.deflate);

function decontextify(obj) {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj !== 'object') return obj;
    try {
        if (Buffer.isBuffer(obj) || obj instanceof Uint8Array || (obj && obj.constructor && obj.constructor.name === 'Buffer')) {
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
    if (obj instanceof Error || (obj && obj.constructor && obj.constructor.name === 'Error')) {
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

const loadedApis = new Map();
const apiStatus = new Map();

function getApiStatus(owner, id) {
    return apiStatus.get(`${owner}_${id}`);
}

function extractMetadata(script) {
    const meta = {};
    const commentMatch = script.match(/\/\*[*!]([\s\S]*?)\*\//);
    if (commentMatch) {
        const comment = commentMatch[1];
        const nameMatch = comment.match(/@name\s+(.+)/);
        if (nameMatch) meta.name = nameMatch[1].trim();
        const descMatch = comment.match(/@description\s+(.+)/);
        if (descMatch) meta.description = descMatch[1].trim();
        const verMatch = comment.match(/@version\s+(.+)/);
        if (verMatch) meta.version = verMatch[1].trim();
        const authorMatch = comment.match(/@author\s+(.+)/);
        if (authorMatch) meta.author = authorMatch[1].trim();
        const repoMatch = comment.match(/@(?:repository|homepage)\s+(.+)/);
        if (repoMatch) meta.homepage = repoMatch[1].trim();
    }
    return meta;
}

function createLxRequest(isUnsafe = false) {
    return (url, options, callback) => {
        const safeOptions = decontextify(options || {});
        const { method = 'get', timeout, headers, body, form, formData } = safeOptions;
        let requestOptions = {
            headers,
            response_timeout: typeof timeout === 'number' && timeout > 0 ? Math.min(timeout, 60000) : 60000
        };
        let data = body;
        if (form) {
            data = form;
            requestOptions.json = false;
        } else if (formData) {
            data = formData;
            requestOptions.json = false;
        }
        const request = needle.request(method, url, data, requestOptions, (err, resp, body) => {
            try {
                if (err) {
                    callback.call(null, decontextify(err), null, null);
                } else {
                    let parsedBody = body;
                    if (typeof body === 'string') {
                        try {
                            parsedBody = JSON.parse(body);
                        } catch { }
                    }
                    let safeResp = {
                        statusCode: resp.statusCode,
                        statusMessage: resp.statusMessage,
                        headers: resp.headers,
                        body: decontextify(parsedBody)
                    };
                    if (isUnsafe) {
                        const jsonBody = (typeof parsedBody === 'object' && !Buffer.isBuffer(parsedBody))
                            ? JSON.parse(JSON.stringify(parsedBody))
                            : parsedBody;
                        safeResp = JSON.parse(JSON.stringify({
                            statusCode: resp.statusCode,
                            statusMessage: resp.statusMessage,
                            headers: resp.headers
                        }));
                        safeResp.body = jsonBody;
                    }
                    callback.call(null, null, safeResp, safeResp.body);
                }
            } catch (error) {
                callback.call(null, decontextify(error), null, null);
            }
        });
        return () => {
            const reqObj = request.request;
            if (reqObj && !reqObj.aborted) reqObj.abort();
        };
    };
}

async function loadUserApi(apiInfo) {
    const metadata = extractMetadata(apiInfo.script);
    const fullApiInfo = { ...apiInfo, ...metadata };
    const eventHandlers = new Map();
    let registeredSources = {};

    let initResolve = null;
    let initReject = null;
    const initPromise = new Promise((resolve, reject) => {
        initResolve = resolve;
        initReject = reject;
    });

    const lxDataInside = {
        version: '2.0.0',
        env: 'desktop',
        platform: 'web',
        currentScriptInfo: {
            name: fullApiInfo.name,
            description: fullApiInfo.description,
            version: fullApiInfo.version,
            author: fullApiInfo.author,
            homepage: fullApiInfo.homepage,
            rawScript: fullApiInfo.script,
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
                const dKey = decontextify(key);
                const dIv = decontextify(iv);
                const dBuffer = decontextify(buffer);
                const algorithm = `aes-${dKey.length * 8}-${mode}`;
                const cipher = crypto.createCipheriv(algorithm, dKey, dIv);
                cipher.setAutoPadding(false);
                return Buffer.concat([cipher.update(dBuffer), cipher.final()]);
            },
            aesDecrypt2: (buffer, mode, key, iv) => {
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
            inflate: (buffer) => inflate(decontextify(buffer)),
            deflate: (buffer) => deflate(decontextify(buffer)),
            inflateRaw: (buffer) => util.promisify(zlib.inflateRaw)(decontextify(buffer)),
            deflateRaw: (buffer) => util.promisify(zlib.deflateRaw)(decontextify(buffer)),
        }
    };

    const lxObject = {
        ...lxDataInside,
        utils: lxUtils,
        request: createLxRequest(!!apiInfo.allowUnsafeVM),
        send: (eventName, data) => {
            const dData = decontextify(data);
            if (eventName === 'inited') {
                if (dData && dData.sources) {
                    registeredSources = dData.sources;
                    console.log(`[UserApi-${fullApiInfo.name}] Registered sources:`, Object.keys(registeredSources).join(', '));
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

    const sandbox = {
        console,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        Buffer,
        URL,
        URLSearchParams,
        TextEncoder,
        TextDecoder,
        process: {
            nextTick: (fn, ...args) => setTimeout(() => fn(...args), 0),
            env: { NODE_ENV: process.env.NODE_ENV || 'production' }
        },
        lx: lxObject,
        global: null,
        window: null,
        globalThis: null,
        atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
        crypto: crypto
    };
    sandbox.global = sandbox;
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;

    try {
        if (apiInfo.allowUnsafeVM) {
            console.log(`[UserApi] ${fullApiInfo.name} 正在以原生 VM 模式启动...`);
            const vm = require('vm');
            const context = vm.createContext(sandbox);
            vm.runInContext(apiInfo.script, context, {
                filename: `custom_source_${fullApiInfo.id}.js`,
                timeout: 10000
            });
        } else {
            try {
                const vmInstance = new vm2.VM({
                    timeout: 10000,
                    sandbox,
                    eval: true,
                    wasm: false,
                });
                await vmInstance.run(apiInfo.script);
            } catch (e) {
                const isContextError = e.message.includes('contextified object') || e.message.includes('Operation not allowed');
                if (isContextError) {
                    console.warn(`[UserApi] ${fullApiInfo.name} 触发 vm2 安全限制，正在提示用户开启 VM 模式`);
                    throw new Error('REQUIRE_UNSAFE_VM');
                }
                throw e;
            }
        }

        await Promise.race([
            initPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('初始化超时，请确保脚本调用了 lx.send("inited", ...)')), 3000))
        ]);

        const apiInstance = {
            info: { ...fullApiInfo, sources: registeredSources },
            handlers: eventHandlers,
            callRequest: async (action, source, info) => {
                try {
                    const handler = eventHandlers.get('request');
                    if (!handler) throw new Error(`源 ${fullApiInfo.name} 未注册 request 处理器`);
                    let inputData = { action, source, info };
                    if (apiInfo.allowUnsafeVM) {
                        inputData = JSON.parse(JSON.stringify(inputData));
                    }
                    const result = await handler(inputData);
                    return decontextify(result);
                } catch (e) {
                    console.error(`[UserApi-${fullApiInfo.name}] callRequest Error:`, e.message);
                    throw e;
                }
            }
        };

        loadedApis.set(`${fullApiInfo.owner}_${apiInfo.id}`, apiInstance);
        console.log(`[UserApi] ✓ 成功加载: ${fullApiInfo.name} v${fullApiInfo.version} (Owner: ${fullApiInfo.owner})`);
        console.log(`[UserApi]   支持源: ${Object.keys(registeredSources).join(', ')}`);
        return { success: true, apiInstance, error: null };
    } catch (error) {
        console.error(`[UserApi] ✗ 加载失败 ${fullApiInfo.name}:`, error.message);
        if (error.stack && error.message !== 'REQUIRE_UNSAFE_VM') {
            console.error(`[UserApi] [Stack] ${fullApiInfo.name}:`, error.stack);
        }
        return { success: false, apiInstance: null, error: error.message, requireUnsafe: error.message === 'REQUIRE_UNSAFE_VM' };
    }
}

async function callUserApiGetMusicUrl(source, songInfo, quality, clientUsername, onProgress) {
    const normalizedSongInfo = { ...songInfo };
    if (songInfo.meta) {
        Object.assign(normalizedSongInfo, songInfo.meta);
        if (songInfo.meta.songId && !normalizedSongInfo.songmid) {
            normalizedSongInfo.songmid = songInfo.meta.songId;
        }
        if (songInfo.meta.picUrl && !normalizedSongInfo.img) {
            normalizedSongInfo.img = songInfo.meta.picUrl;
        }
        if (songInfo.meta.qualitys && !normalizedSongInfo.types) {
            normalizedSongInfo.types = songInfo.meta.qualitys;
        }
        if (songInfo.meta._qualitys && !normalizedSongInfo._types) {
            normalizedSongInfo._types = songInfo.meta._qualitys;
        }
        if (songInfo.meta.hash && !normalizedSongInfo.hash) {
            normalizedSongInfo.hash = songInfo.meta.hash;
        }
        if (songInfo.meta.albumId && !normalizedSongInfo.albumId) {
            normalizedSongInfo.albumId = songInfo.meta.albumId;
        }
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
        if (songInfo.meta.strMediaMid && !normalizedSongInfo.strMediaMid) {
            normalizedSongInfo.strMediaMid = songInfo.meta.strMediaMid;
        }
        if (songInfo.meta.albumMid && !normalizedSongInfo.albumMid) {
            normalizedSongInfo.albumMid = songInfo.meta.albumMid;
        }
    }
    if (!normalizedSongInfo.hash && songInfo.hash) normalizedSongInfo.hash = songInfo.hash;
    if (!normalizedSongInfo.copyrightId && songInfo.copyrightId) normalizedSongInfo.copyrightId = songInfo.copyrightId;
    if (!normalizedSongInfo.strMediaMid && songInfo.strMediaMid) normalizedSongInfo.strMediaMid = songInfo.strMediaMid;
    if (!normalizedSongInfo.albumMid && songInfo.albumMid) normalizedSongInfo.albumMid = songInfo.albumMid;
    if (!normalizedSongInfo.albumId && songInfo.albumId) normalizedSongInfo.albumId = songInfo.albumId;
    if (!normalizedSongInfo.lrcUrl && songInfo.lrcUrl) normalizedSongInfo.lrcUrl = songInfo.lrcUrl;
    if (!normalizedSongInfo.mrcUrl && songInfo.mrcUrl) normalizedSongInfo.mrcUrl = songInfo.mrcUrl;
    if (!normalizedSongInfo.trcUrl && songInfo.trcUrl) normalizedSongInfo.trcUrl = songInfo.trcUrl;

    let supportedCount = 0;
    let lastError = null;
    const candidates = [];
    const userApiIds = new Set();
    let userStates = {};

    if (clientUsername && clientUsername !== 'default') {
        const dataPath = process.env.DATA_PATH || path.join(__dirname, '../data');
        const userPath = path.join(dataPath, 'users', 'source', clientUsername);
        const statesPath = path.join(userPath, 'states.json');
        const metaPath = path.join(userPath, 'sources.json');
        if (fs.existsSync(statesPath)) {
            try {
                userStates = JSON.parse(fs.readFileSync(statesPath, 'utf-8'));
            } catch (e) { }
        }
        if (fs.existsSync(metaPath)) {
            try {
                const userSources = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
                for (const s of userSources) {
                    userApiIds.add(s.id);
                }
            } catch (e) { }
        }
    }

    for (const [apiId, api] of loadedApis) {
        if (!api.info.enabled) continue;
        if (!api.info.sources || !api.info.sources[source]) continue;
        if (clientUsername && api.info.owner === clientUsername) {
            candidates.push(api);
            userApiIds.add(api.info.id);
        }
    }

    for (const [apiId, api] of loadedApis) {
        if (!api.info.sources || !api.info.sources[source]) continue;
        if (api.info.owner === 'open') {
            let isEnabled = api.info.enabled;
            if (clientUsername && clientUsername !== 'default' && userStates[api.info.id]) {
                if (typeof userStates[api.info.id].enabled === 'boolean') {
                    isEnabled = userStates[api.info.id].enabled;
                }
            }
            if (!isEnabled) continue;
            if (!userApiIds.has(api.info.id)) {
                candidates.push(api);
            }
        }
    }

    supportedCount = candidates.length;
    if (supportedCount === 0) {
        const errMsg = `未找到支持 ${source} 平台的自定义源，请在设置中添加或启用相关源`;
        if (onProgress) await onProgress({ name: '系统', status: 'fail', message: errMsg });
        throw new Error(errMsg);
    }

    const attempts = [];
    if (supportedCount === 1) {
        const api = candidates[0];
        const maxRetries = 3;
        for (let i = 0; i < maxRetries; i++) {
            try {
                console.log(`[UserApi] 尝试 ${api.info.name} 获取 ${source} 音乐链接 (第 ${i + 1}/${maxRetries} 次, Owner: ${api.info.owner})`);
                const url = await api.callRequest('musicUrl', source, {
                    musicInfo: normalizedSongInfo,
                    quality: quality,
                    type: quality
                });
                console.log(`[UserApi] ✓ ${api.info.name} 成功返回链接 (Owner: ${api.info.owner})`);
                const att = { name: api.info.name, status: 'success', message: `第 ${i + 1} 次尝试成功` };
                attempts.push(att);
                if (onProgress) await onProgress(att);
                return { url, type: quality, sourceName: api.info.name, attempts };
            } catch (error) {
                console.error(`[UserApi] ${api.info.name} 失败 (第 ${i + 1}/${maxRetries} 次):`, `音源日志：${error.message}`);
                lastError = error;
                const att = { name: api.info.name, status: 'fail', message: `第 ${i + 1} 次尝试失败,音源日志：${error.message}` };
                attempts.push(att);
                if (onProgress) await onProgress(att);
                if (i < maxRetries - 1) {
                    await new Promise(r => setTimeout(r, 1000));
                }
            }
        }
    } else {
        for (const api of candidates) {
            try {
                console.log(`[UserApi] 尝试 ${api.info.name} 获取 ${source} 音乐链接 (Owner: ${api.info.owner})`);
                const url = await api.callRequest('musicUrl', source, {
                    musicInfo: normalizedSongInfo,
                    quality: quality,
                    type: quality
                });
                console.log(`[UserApi] ✓ ${api.info.name} 成功返回链接 (Owner: ${api.info.owner})`);
                const att = { name: api.info.name, status: 'success' };
                attempts.push(att);
                if (onProgress) await onProgress(att);
                return { url, type: quality, sourceName: api.info.name, attempts };
            } catch (error) {
                console.error(`[UserApi] ${api.info.name} 失败:`, `音源日志：${error.message}`);
                lastError = error;
                const att = { name: api.info.name, status: 'fail', message: `音源日志：${error.message}` };
                attempts.push(att);
                if (onProgress) await onProgress(att);
                continue;
            }
        }
    }

    const detailMsg = supportedCount === 1
        ? `自定义源 [${candidates[0].info.name}] 解析失败`
        : `已尝试了 ${supportedCount} 个支持 ${source} 平台的源，但全部解析失败`;
    const finalError = new Error(`${detailMsg} (音源日志: ${lastError?.message})`);
    finalError.attempts = attempts;
    throw finalError;
}

async function callUserApiSearch(source, keyword, page, limit, clientUsername) {
    let supportedCount = 0;
    let lastError = null;
    const candidates = [];
    const userApiIds = new Set();
    let userStates = {};

    if (clientUsername && clientUsername !== 'default') {
        const dataPath = process.env.DATA_PATH || path.join(__dirname, '../data');
        const userPath = path.join(dataPath, 'users', 'source', clientUsername);
        const statesPath = path.join(userPath, 'states.json');
        const metaPath = path.join(userPath, 'sources.json');
        if (fs.existsSync(statesPath)) {
            try {
                userStates = JSON.parse(fs.readFileSync(statesPath, 'utf-8'));
            } catch (e) { }
        }
        if (fs.existsSync(metaPath)) {
            try {
                const userSources = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
                for (const s of userSources) {
                    userApiIds.add(s.id);
                }
            } catch (e) { }
        }
    }

    for (const [apiId, api] of loadedApis) {
        if (!api.info.enabled) continue;
        if (!api.info.sources || !api.info.sources[source]) continue;
        if (clientUsername && api.info.owner === clientUsername) {
            candidates.push(api);
            userApiIds.add(api.info.id);
        }
    }

    for (const [apiId, api] of loadedApis) {
        if (!api.info.sources || !api.info.sources[source]) continue;
        if (api.info.owner === 'open') {
            let isEnabled = api.info.enabled;
            if (clientUsername && clientUsername !== 'default' && userStates[api.info.id]) {
                if (typeof userStates[api.info.id].enabled === 'boolean') {
                    isEnabled = userStates[api.info.id].enabled;
                }
            }
            if (!isEnabled) continue;
            if (!userApiIds.has(api.info.id)) {
                candidates.push(api);
            }
        }
    }

    supportedCount = candidates.length;
    if (supportedCount === 0) {
        return null;
    }

    if (supportedCount === 1) {
        const api = candidates[0];
        const maxRetries = 3;
        for (let i = 0; i < maxRetries; i++) {
            try {
                console.log(`[UserApi] 尝试 ${api.info.name} 搜索 ${source} (第 ${i + 1}/${maxRetries} 次)`);
                const result = await api.callRequest('search', source, {
                    keyword: keyword,
                    page: page,
                    limit: limit
                });
                if (result && result.list) {
                    return {
                        total: result.total || result.list.length * 10,
                        list: result.list,
                        sourceName: api.info.name
                    };
                } else if (Array.isArray(result)) {
                    return {
                        total: result.length * 10,
                        list: result,
                        sourceName: api.info.name
                    };
                }
            } catch (error) {
                console.error(`[UserApi] ${api.info.name} 搜索失败 (第 ${i + 1}/${maxRetries} 次):`, error.message);
                lastError = error;
                if (i < maxRetries - 1) {
                    await new Promise(r => setTimeout(r, 1000));
                }
            }
        }
    } else {
        for (const api of candidates) {
            try {
                console.log(`[UserApi] 尝试 ${api.info.name} 搜索 ${source}`);
                const result = await api.callRequest('search', source, {
                    keyword: keyword,
                    page: page,
                    limit: limit
                });
                if (result && result.list) {
                    return {
                        total: result.total || result.list.length * 10,
                        list: result.list,
                        sourceName: api.info.name
                    };
                } else if (Array.isArray(result)) {
                    return {
                        total: result.length * 10,
                        list: result,
                        sourceName: api.info.name
                    };
                }
            } catch (error) {
                console.error(`[UserApi] ${api.info.name} 搜索失败:`, error.message);
                lastError = error;
                continue;
            }
        }
    }

    console.error(`[UserApi] 所有自定义源搜索 ${source} 失败:`, lastError?.message);
    return null;
}

async function loadSourcesFromDir(dirPath, owner, stats) {
    const metaPath = path.join(dirPath, 'sources.json');
    if (!fs.existsSync(metaPath)) {
        return;
    }
    try {
        const sources = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        let needsSave = false;
        for (const source of sources) {
            if (!source.enabled && owner !== 'open') {
                console.log(`[UserApi] [${owner}] 跳过已禁用: ${source.name}`);
                apiStatus.delete(`${owner}_${source.id}`);
                continue;
            }
            const scriptPath = path.join(dirPath, source.id);
            if (!fs.existsSync(scriptPath)) {
                console.warn(`[UserApi] [${owner}] 脚本文件未找到: ${source.id}`);
                continue;
            }
            try {
                const script = fs.readFileSync(scriptPath, 'utf-8');
                const metadata = extractMetadata(script);
                const result = await loadUserApi({
                    id: source.id,
                    name: metadata.name || source.name,
                    description: metadata.description || '',
                    version: metadata.version || 1,
                    author: metadata.author || '',
                    homepage: metadata.homepage || '',
                    script,
                    sources: {},
                    enabled: source.enabled,
                    allowUnsafeVM: source.allowUnsafeVM,
                    owner: owner
                });
                if (result.success) {
                    stats.loadedCount++;
                    apiStatus.set(`${owner}_${source.id}`, { status: 'success' });
                    const runtimeSources = Object.keys(result.apiInstance.info.sources).sort();
                    const storedSources = (source.supportedSources || []).sort();
                    if (JSON.stringify(runtimeSources) !== JSON.stringify(storedSources)) {
                        console.log(`[UserApi] [Fix] [${owner}] 更新源 ${source.name} 的支持列表`);
                        source.supportedSources = runtimeSources;
                        if (metadata.version && source.version !== metadata.version) source.version = metadata.version;
                        if (metadata.author && source.author !== metadata.author) source.author = metadata.author;
                        if (metadata.description && source.description !== metadata.description) source.description = metadata.description;
                        if (metadata.homepage && source.homepage !== metadata.homepage) source.homepage = metadata.homepage;
                        needsSave = true;
                    }
                } else {
                    console.error(`[UserApi] [${owner}] 加载 ${metadata.name || source.name} 失败: ${result.error}`);
                    apiStatus.set(`${owner}_${source.id}`, { status: 'failed', error: result.error });
                }
            } catch (error) {
                console.error(`[UserApi] [${owner}] 加载 ${source.name} 失败:`, error.message);
                apiStatus.set(`${owner}_${source.id}`, { status: 'failed', error: error.message });
            }
        }
        if (needsSave) {
            fs.writeFileSync(metaPath, JSON.stringify(sources, null, 2));
            console.log(`[UserApi] [${owner}] 已更新 sources.json 元数据`);
        }
    } catch (error) {
        console.error(`[UserApi] [${owner}] 读取 sources.json 失败:`, error.message);
    }
}

let fsWatcher = null;
const lastReloadMap = new Map();

function startWatcher(sourceRoot) {
    if (fsWatcher) return;
    console.log(`[UserApi] 启动源文件监控: ${sourceRoot}`);
    const debounceMap = new Map();
    try {
        fsWatcher = fs.watch(sourceRoot, { recursive: true }, (eventType, filename) => {
            if (!filename) return;
            if (!filename.endsWith('.js') && !filename.endsWith('sources.json')) {
                return;
            }
            const parts = filename.split(path.sep);
            let username = parts[0];
            if (username === '_open') {
                username = 'open';
            }
            if (debounceMap.has(username)) {
                clearTimeout(debounceMap.get(username));
            }
            debounceMap.set(username, setTimeout(() => {
                const lastReload = lastReloadMap.get(username) || 0;
                if (Date.now() - lastReload < 3000) {
                    console.log(`[UserApi] [Watcher] 忽略近期更新的文件变动: ${filename}`);
                    return;
                }
                console.log(`[UserApi] [Watcher] 检测到文件变动 (${eventType}): ${filename} -> 重新加载 ${username}`);
                initUserApis(username).catch(err => {
                    console.error(`[UserApi] [Watcher] 重新加载失败:`, err);
                });
            }, 2000));
        });
        process.on('exit', () => {
            if (fsWatcher) fsWatcher.close();
        });
    } catch (e) {
        console.error('[UserApi] 启动文件监控失败:', e);
    }
}

async function initUserApis(targetUser) {
    const dataPath = process.env.DATA_PATH || path.join(__dirname, '../data');
    const sourceRoot = path.join(dataPath, 'users', 'source');
    const stats = { loadedCount: 0 };

    if (targetUser) {
        lastReloadMap.set(targetUser, Date.now());
    }

    console.log(`[UserApi] ========================================`);
    if (!fs.existsSync(sourceRoot)) {
        console.log(`[UserApi] Source root directory not found: ${sourceRoot}`);
        console.log(`[UserApi] ========================================`);
        return;
    }

    if (!fsWatcher) {
        startWatcher(sourceRoot);
    }

    if (targetUser) {
        console.log(`[UserApi] 重新加载用户源: ${targetUser}`);
        for (const [key, api] of loadedApis.entries()) {
            if (api.info.owner === targetUser) {
                loadedApis.delete(key);
            }
        }
        for (const key of apiStatus.keys()) {
            if (key.startsWith(`${targetUser}_`)) {
                apiStatus.delete(key);
            }
        }
        let dirName = targetUser;
        if (targetUser === 'open') {
            dirName = '_open';
        }
        const userSourceDir = path.join(sourceRoot, dirName);
        if (fs.existsSync(userSourceDir)) {
            await loadSourcesFromDir(userSourceDir, targetUser, stats);
        }
    } else {
        console.log(`[UserApi] 初始化所有自定义源...`);
        loadedApis.clear();
        try {
            const entries = fs.readdirSync(sourceRoot, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    let owner = entry.name;
                    if (entry.name === '_open') {
                        owner = 'open';
                    }
                    const dirPath = path.join(sourceRoot, entry.name);
                    await loadSourcesFromDir(dirPath, owner, stats);
                }
            }
        } catch (error) {
            console.error('[UserApi] 扫描源目录失败:', error.message);
        }
    }
    console.log(`[UserApi] 本次加载: ${stats.loadedCount} 个源`);
    console.log(`[UserApi] 当前总计: ${loadedApis.size} 个源`);
    console.log(`[UserApi] ========================================`);
}

function getLoadedApis() {
    return Array.from(loadedApis.values()).map(api => api.info);
}

function isSourceSupported(source, clientUsername) {
    for (const [apiId, api] of loadedApis) {
        if (!api.info.enabled || !api.info.sources || !api.info.sources[source]) {
            continue;
        }
        if (api.info.owner === 'open' || (clientUsername && api.info.owner === clientUsername)) {
            return true;
        }
    }
    return false;
}

module.exports = {
    getApiStatus,
    extractMetadata,
    loadUserApi,
    callUserApiGetMusicUrl,
    callUserApiSearch,
    initUserApis,
    getLoadedApis,
    isSourceSupported
};