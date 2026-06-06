const needle = require('needle');
const crypto = require('crypto');

// 网易云音乐加密相关
const iv = Buffer.from('0102030405060708');
const linuxapiKey = Buffer.from('rFgB&h#%2?^eDg:Q');

const aesEncrypt = (buffer, mode, key, iv) => {
    const cipher = crypto.createCipheriv(mode, key, iv);
    return Buffer.concat([cipher.update(buffer), cipher.final()]);
};

const linuxapi = object => {
    const text = JSON.stringify(object);
    return {
        eparams: aesEncrypt(Buffer.from(text), 'aes-128-ecb', linuxapiKey, '').toString('hex').toUpperCase(),
    };
};

async function httpFetch(url, options = {}) {
    const timeout = options.timeout || 10000;
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
        ...options.headers
    };
    const method = options.method || 'get';
    const body = options.body || options.form;

    return new Promise((resolve) => {
        const requestOptions = { headers, timeout, follow_max: 5 };
        if (method === 'post' && body) {
            requestOptions.form = body;
            needle.post(url, body, requestOptions, (error, response) => {
                if (error) {
                    resolve({ statusCode: 500, body: error.message });
                } else {
                    let respBody = response.body;
                    if (typeof respBody === 'string') {
                        try {
                            respBody = JSON.parse(respBody);
                        } catch (e) { }
                    }
                    resolve({ statusCode: response.statusCode, body: respBody, headers: response.headers });
                }
            });
        } else {
            needle.get(url, requestOptions, (error, response) => {
                if (error) {
                    resolve({ statusCode: 500, body: error.message });
                } else {
                    let respBody = response.body;
                    if (typeof respBody === 'string') {
                        try {
                            respBody = JSON.parse(respBody);
                        } catch (e) { }
                    }
                    resolve({ statusCode: response.statusCode, body: respBody, headers: response.headers });
                }
            });
        }
    });
}

const formatPlayCount = (count) => {
    count = parseInt(count);
    if (isNaN(count)) return '0';
    if (count >= 100000000) return (count / 100000000).toFixed(1) + '亿';
    if (count >= 10000) return (count / 10000).toFixed(1) + '万';
    return count.toString();
};

const formatPlayTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
};

const formatSingerName = (singers, key = 'name') => {
    if (!singers || !Array.isArray(singers)) return '';
    return singers.map(s => s[key]).join('、');
};

const decodeName = (str) => {
    if (!str) return '';
    try {
        return decodeURIComponent(str);
    } catch {
        return str;
    }
};

const sizeFormate = (size) => {
    if (!size) return null;
    size = parseInt(size);
    if (size < 1024) return size + ' B';
    if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB';
    return (size / (1024 * 1024)).toFixed(2) + ' MB';
};

const songListModules = {
    wy: {
        sortList: [{ name: '最热', id: 'hot' }],
        async getTags() {
            try {
                const hotTagResponse = await httpFetch('https://music.163.com/api/playlist/hot');
                const hotTags = hotTagResponse.body.tags?.map(tag => ({
                    id: tag.name,
                    name: tag.name,
                    source: 'wy'
                })) || [];

                const tagResponse = await httpFetch('https://music.163.com/api/playlist/catalogue');
                const tags = tagResponse.body.categories ? Object.keys(tagResponse.body.categories).map(key => ({
                    name: tagResponse.body.categories[key],
                    list: (tagResponse.body.sub?.filter(s => s.category === key) || []).map(s => ({
                        parent_id: key,
                        parent_name: tagResponse.body.categories[key],
                        id: s.name,
                        name: s.name,
                        source: 'wy'
                    })),
                    source: 'wy'
                })) : [];

                return { tags, hotTag: hotTags, source: 'wy' };
            } catch (e) {
                return { tags: [], hotTag: [], source: 'wy' };
            }
        },
        async getList(sortId, tagId, page = 1) {
            try {
                const response = await httpFetch(
                    `https://music.163.com/api/playlist/list?cat=${encodeURIComponent(tagId || '全部')}&order=${sortId || 'hot'}&limit=30&offset=${(page - 1) * 30}`
                );
                const playlists = response.body.playlists || [];
                return {
                    list: playlists.map(p => ({
                        play_count: formatPlayCount(p.playCount),
                        id: String(p.id),
                        author: p.creator?.nickname || '',
                        name: p.name,
                        img: p.coverImgUrl,
                        total: p.trackCount,
                        desc: p.description || '',
                        source: 'wy'
                    })),
                    total: response.body.total || playlists.length,
                    page,
                    limit: 30,
                    source: 'wy'
                };
            } catch (e) {
                return { list: [], total: 0, page, limit: 30, source: 'wy' };
            }
        },
        async getListDetail(id, page = 1) {
            try {
                if (/[?&]id=/.test(id)) {
                    id = id.match(/[?&]id=(\d+)/)[1];
                }
                
                // 使用加密方式请求歌单详情
                const encrypted = linuxapi({
                    method: 'POST',
                    url: 'https://music.163.com/api/v3/playlist/detail',
                    params: {
                        id: parseInt(id),
                        n: 100000,
                        s: 8
                    }
                });
                
                const response = await httpFetch('https://music.163.com/api/linux/forward', {
                    method: 'post',
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36',
                        'Content-Type': 'application/x-www-form-urlencoded'
                    },
                    form: encrypted
                });
                
                const body = response.body;
                if (!body.playlist) throw new Error('获取失败');
                
                const playlist = body.playlist;
                const tracks = playlist.tracks || [];
                const songs = tracks.map(track => {
                    const types = [];
                    const _types = {};
                    if (track.h) {
                        types.push({ type: '320k', size: sizeFormate(track.h.size) });
                        _types['320k'] = { size: sizeFormate(track.h.size) };
                    }
                    if (track.l) {
                        types.push({ type: '128k', size: sizeFormate(track.l.size) });
                        _types['128k'] = { size: sizeFormate(track.l.size) };
                    }
                    types.reverse();
                    return {
                        singer: formatSingerName(track.ar, 'name'),
                        name: track.name,
                        albumName: track.al?.name || '',
                        albumId: track.al?.id || '',
                        source: 'wy',
                        interval: formatPlayTime(track.dt / 1000),
                        songmid: track.id,
                        img: track.al?.picUrl || '',
                        types,
                        _types,
                        typeUrl: {}
                    };
                });

                return {
                    list: songs,
                    page,
                    limit: 100000,
                    total: playlist.trackIds?.length || songs.length,
                    source: 'wy',
                    info: {
                        play_count: formatPlayCount(playlist.playCount),
                        name: playlist.name,
                        img: playlist.coverImgUrl,
                        desc: playlist.description || '',
                        author: playlist.creator?.nickname || ''
                    }
                };
            } catch (e) {
                return { list: [], page, limit: 100000, total: 0, source: 'wy', info: {} };
            }
        },
        async search(text, page = 1, limit = 20) {
            try {
                const response = await httpFetch(
                    `https://music.163.com/api/cloudsearch/pc?s=${encodeURIComponent(text)}&type=1000&limit=${limit}&offset=${(page - 1) * limit}`
                );
                const playlists = response.body.result?.playlists || [];
                return {
                    list: playlists.map(p => ({
                        play_count: formatPlayCount(p.playCount),
                        id: String(p.id),
                        author: p.creator?.nickname || '',
                        name: p.name,
                        img: p.coverImgUrl,
                        total: p.trackCount,
                        desc: p.description || '',
                        source: 'wy'
                    })),
                    limit,
                    total: response.body.result?.playlistCount || playlists.length,
                    source: 'wy'
                };
            } catch (e) {
                return { list: [], limit, total: 0, source: 'wy' };
            }
        }
    },

    tx: {
        sortList: [{ name: '最热', id: 5 }, { name: '最新', id: 2 }],
        async getTags() {
            try {
                const response = await httpFetch('https://c.y.qq.com/node/pc/wk_v15/category_playlist.html');
                const html = response.body;
                const hotTagMatches = html.match(/class="c_bg_link js_tag_item" data-id="(\w+)">(.+?)<\/a>/g) || [];
                const hotTags = hotTagMatches.map(match => {
                    const result = match.match(/data-id="(\w+)">(.+?)<\/a>/);
                    return result ? { id: parseInt(result[1]), name: result[2], source: 'tx' } : null;
                }).filter(Boolean);

                return { tags: [], hotTag: hotTags, source: 'tx' };
            } catch (e) {
                return { tags: [], hotTag: [], source: 'tx' };
            }
        },
        async getList(sortId, tagId, page = 1) {
            try {
                const url = tagId
                    ? `https://u.y.qq.com/cgi-bin/musicu.fcg?data=${encodeURIComponent(JSON.stringify({
                        comm: { cv: 1602, ct: 20 },
                        playlist: {
                            method: 'get_category_content',
                            param: { titleid: parseInt(tagId), caller: '0', category_id: parseInt(tagId), size: 36, page: page - 1, use_page: 1 },
                            module: 'playlist.PlayListCategoryServer'
                        }
                    }))}`
                    : `https://u.y.qq.com/cgi-bin/musicu.fcg?data=${encodeURIComponent(JSON.stringify({
                        comm: { cv: 1602, ct: 20 },
                        playlist: {
                            method: 'get_playlist_by_tag',
                            param: { id: 10000000, sin: (page - 1) * 36, size: 36, order: sortId || 5, cur_page: page },
                            module: 'playlist.PlayListPlazaServer'
                        }
                    }))}`;

                const response = await httpFetch(url);
                const data = response.body.playlist?.data;
                if (!data) throw new Error('获取失败');

                const list = tagId
                    ? (data.content?.v_item || []).map(item => ({
                        play_count: formatPlayCount(item.basic?.play_cnt),
                        id: String(item.basic?.tid),
                        author: item.basic?.creator?.nick || '',
                        name: item.basic?.title || '',
                        img: item.basic?.cover?.medium_url || item.basic?.cover?.default_url || '',
                        desc: decodeName(item.basic?.desc || '').replace(/<br>/g, '\n'),
                        source: 'tx'
                    }))
                    : (data.v_playlist || []).map(item => ({
                        play_count: formatPlayCount(item.access_num),
                        id: String(item.tid),
                        author: item.creator_info?.nick || '',
                        name: item.title,
                        time: item.modify_time ? new Date(item.modify_time * 1000).toLocaleDateString() : '',
                        img: item.cover_url_medium,
                        total: item.song_ids?.length || 0,
                        desc: decodeName(item.desc || '').replace(/<br>/g, '\n'),
                        source: 'tx'
                    }));

                return {
                    list,
                    total: tagId ? data.content?.total_cnt : data.total,
                    page,
                    limit: 36,
                    source: 'tx'
                };
            } catch (e) {
                return { list: [], total: 0, page, limit: 36, source: 'tx' };
            }
        },
        async getListDetail(id, page = 1) {
            try {
                if (/\/playlist\//.test(id)) {
                    id = id.match(/\/playlist\/(\d+)/)[1];
                } else if (/[?&]id=/.test(id)) {
                    id = id.match(/[?&]id=(\d+)/)[1];
                }

                const url = `https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?type=1&json=1&utf8=1&onlysong=0&new_format=1&disstid=${id}&loginUin=0&hostUin=0&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0`;
                const response = await httpFetch(url, {
                    headers: {
                        'Origin': 'https://y.qq.com',
                        'Referer': `https://y.qq.com/n/yqq/playsquare/${id}.html`
                    }
                });
                const cdlist = response.body.cdlist?.[0];
                if (!cdlist) throw new Error('获取失败');

                const songs = cdlist.songlist?.map(item => {
                    const types = [];
                    const _types = {};
                    if (item.file?.size_128mp3 !== 0) {
                        types.push({ type: '128k', size: sizeFormate(item.file.size_128mp3) });
                        _types['128k'] = { size: sizeFormate(item.file.size_128mp3) };
                    }
                    if (item.file?.size_320mp3 !== 0) {
                        types.push({ type: '320k', size: sizeFormate(item.file.size_320mp3) });
                        _types['320k'] = { size: sizeFormate(item.file.size_320mp3) };
                    }
                    if (item.file?.size_flac !== 0) {
                        types.push({ type: 'flac', size: sizeFormate(item.file.size_flac) });
                        _types.flac = { size: sizeFormate(item.file.size_flac) };
                    }

                    return {
                        singer: formatSingerName(item.singer, 'name'),
                        name: item.title,
                        albumName: item.album?.name || '',
                        albumId: item.album?.mid || '',
                        source: 'tx',
                        interval: formatPlayTime(item.interval),
                        songmid: item.mid,
                        img: `https://y.gtimg.cn/music/photo_new/T002R500x500M000${item.album?.mid}.jpg`,
                        types,
                        _types,
                        typeUrl: {}
                    };
                }) || [];

                return {
                    list: songs,
                    page: 1,
                    limit: songs.length,
                    total: songs.length,
                    source: 'tx',
                    info: {
                        name: cdlist.dissname,
                        img: cdlist.logo,
                        desc: decodeName(cdlist.desc || '').replace(/<br>/g, '\n'),
                        author: cdlist.nickname,
                        play_count: formatPlayCount(cdlist.visitnum)
                    }
                };
            } catch (e) {
                return { list: [], page, limit: 0, total: 0, source: 'tx', info: {} };
            }
        },
        async search(text, page = 1, limit = 20) {
            try {
                const response = await httpFetch(
                    `http://c.y.qq.com/soso/fcgi-bin/client_music_search_songlist?page_no=${page - 1}&num_per_page=${limit}&format=json&query=${encodeURIComponent(text)}&remoteplace=txt.yqq.playlist&inCharset=utf8&outCharset=utf-8`,
                    { headers: { Referer: 'http://y.qq.com/portal/search.html' } }
                );
                const list = response.body.data?.list?.map(item => ({
                    play_count: formatPlayCount(item.listennum),
                    id: String(item.dissid),
                    author: decodeName(item.creator?.name || ''),
                    name: decodeName(item.dissname),
                    img: item.imgurl,
                    total: item.song_count,
                    desc: decodeName(decodeName(item.introduction || '')).replace(/<br>/g, '\n'),
                    source: 'tx'
                })) || [];

                return {
                    list,
                    limit,
                    total: response.body.data?.sum || list.length,
                    source: 'tx'
                };
            } catch (e) {
                return { list: [], limit, total: 0, source: 'tx' };
            }
        }
    },

    mg: {
        sortList: [{ name: '推荐', id: '15127315' }],
        async getTags() {
            try {
                const response = await httpFetch('https://app.c.nf.migu.cn/pc/v1.0/template/musiclistplaza-taglist/release');
                const data = response.body.data;
                if (!data) throw new Error('获取失败');

                const hotTags = data[0]?.content?.map(item => ({
                    id: item.texts?.[1] || '',
                    name: item.texts?.[0] || '',
                    source: 'mg'
                })) || [];

                const tags = data.slice(1).map(item => ({
                    name: item.header?.title || '',
                    list: (item.content || []).map(tag => ({
                        id: tag.texts?.[1] || '',
                        name: tag.texts?.[0] || '',
                        source: 'mg'
                    })),
                    source: 'mg'
                }));

                return { tags, hotTag: hotTags, source: 'mg' };
            } catch (e) {
                return { tags: [], hotTag: [], source: 'mg' };
            }
        },
        async getList(sortId, tagId, page = 1) {
            try {
                const url = tagId
                    ? `https://app.c.nf.migu.cn/pc/v1.0/template/musiclistplaza-listbytag/release?pageNumber=${page}&templateVersion=2&tagId=${tagId}`
                    : `https://app.c.nf.migu.cn/pc/bmw/page-data/playlist-square-recommend/v1.0?templateVersion=2&pageNo=${page}`;

                const response = await httpFetch(url, { headers: { Referer: 'https://m.music.migu.cn/' } });
                const data = response.body.data;
                if (!data) throw new Error('获取失败');

                const list = data.contents
                    ? data.contents.map(item => ({
                        id: String(item.resId),
                        author: '',
                        name: item.txt || '',
                        img: item.img || '',
                        desc: item.txt2 || '',
                        source: 'mg'
                    }))
                    : (data.contentItemList?.[1]?.itemList || []).map(item => ({
                        play_count: item.barList?.[0]?.title || '',
                        id: String(item.logEvent?.contentId),
                        author: '',
                        name: item.title || '',
                        img: item.imageUrl || '',
                        source: 'mg'
                    }));

                return {
                    list,
                    total: 99999,
                    page,
                    limit: 30,
                    source: 'mg'
                };
            } catch (e) {
                return { list: [], total: 0, page, limit: 30, source: 'mg' };
            }
        },
        async getListDetail(id, page = 1) {
            try {
                if (/playlist[/?]/.test(id)) {
                    id = /(?:playlistId|id)=(\d+)/.exec(id)?.[1] || id;
                }

                const detailResponse = await httpFetch(`https://c.musicapp.migu.cn/MIGUM3.0/resource/playlist/v2.0?playlistId=${id}`);
                const listResponse = await httpFetch(`https://app.c.nf.migu.cn/MIGUM3.0/resource/playlist/song/v2.0?pageNo=${page}&pageSize=50&playlistId=${id}`);

                const info = detailResponse.body.data ? {
                    name: detailResponse.body.data.title,
                    img: detailResponse.body.data.imgItem?.img,
                    desc: detailResponse.body.data.summary,
                    author: detailResponse.body.data.ownerName,
                    play_count: formatPlayCount(detailResponse.body.data.opNumItem?.playNum)
                } : {};

                const songs = (listResponse.body.data?.songList || []).map(item => ({
                    singer: item.singerName || '',
                    name: item.songName || '',
                    albumName: item.albumName || '',
                    albumId: item.albumId || '',
                    source: 'mg',
                    interval: formatPlayTime(item.duration / 1000),
                    songmid: item.songId || '',
                    img: item.albumImg || '',
                    types: [{ type: '128k' }],
                    _types: { '128k': {} },
                    typeUrl: {}
                }));

                return {
                    list: songs,
                    page,
                    limit: 50,
                    total: listResponse.body.data?.totalCount || songs.length,
                    source: 'mg',
                    info
                };
            } catch (e) {
                return { list: [], page, limit: 50, total: 0, source: 'mg', info: {} };
            }
        },
        async search(text, page = 1, limit = 20) {
            try {
                const response = await httpFetch(
                    `https://jadeite.migu.cn/music_search/v3/search/searchAll?isCorrect=1&isCopyright=1&searchSwitch=%7B%22song%22%3A0%2C%22album%22%3A0%2C%22singer%22%3A0%2C%22songlist%22%3A1%7D&pageSize=${limit}&text=${encodeURIComponent(text)}&pageNo=${page}&sort=0`
                );
                const list = (response.body.songListResultData?.result || []).map(item => ({
                    play_count: formatPlayCount(item.playNum),
                    id: String(item.id),
                    author: item.userName || '',
                    name: item.name || '',
                    img: item.musicListPicUrl || '',
                    total: item.musicNum || 0,
                    source: 'mg'
                }));

                return {
                    list,
                    limit,
                    total: parseInt(response.body.songListResultData?.totalCount) || list.length,
                    source: 'mg'
                };
            } catch (e) {
                return { list: [], limit, total: 0, source: 'mg' };
            }
        }
    },

    kw: {
        sortList: [{ name: '最新', id: 'new' }, { name: '最热', id: 'hot' }],
        async getTags() {
            try {
                const hotResponse = await httpFetch('http://wapi.kuwo.cn/api/pc/classify/playlist/getRcmTagList?loginUid=0&loginSid=0&appUid=76039576');
                const hotTags = (hotResponse.body.data?.[0]?.data || []).map(item => ({
                    id: `${item.id}-${item.digest}`,
                    name: item.name,
                    source: 'kw'
                }));

                const tagResponse = await httpFetch('http://wapi.kuwo.cn/api/pc/classify/playlist/getTagList?cmd=rcm_keyword_playlist&user=0&prod=kwplayer_pc_9.0.5.0&vipver=9.0.5.0&source=kwplayer_pc_9.0.5.0&loginUid=0&loginSid=0&appUid=76039576');
                const tags = (tagResponse.body.data || []).map(type => ({
                    name: type.name,
                    list: (type.data || []).map(item => ({
                        parent_id: type.id,
                        parent_name: type.name,
                        id: `${item.id}-${item.digest}`,
                        name: item.name,
                        source: 'kw'
                    })),
                    source: 'kw'
                }));

                return { tags, hotTag: hotTags, source: 'kw' };
            } catch (e) {
                return { tags: [], hotTag: [], source: 'kw' };
            }
        },
        async getList(sortId, tagId, page = 1) {
            try {
                let id = null;
                let type = null;
                if (tagId) {
                    const arr = tagId.split('-');
                    id = arr[0];
                    type = arr[1];
                }

                const url = !id
                    ? `http://wapi.kuwo.cn/api/pc/classify/playlist/getRcmPlayList?loginUid=0&loginSid=0&appUid=76039576&pn=${page}&rn=36&order=${sortId || 'hot'}`
                    : type === '10000'
                    ? `http://wapi.kuwo.cn/api/pc/classify/playlist/getTagPlayList?loginUid=0&loginSid=0&appUid=76039576&pn=${page}&id=${id}&rn=36`
                    : `http://mobileinterfaces.kuwo.cn/er.s?type=get_pc_qz_data&f=web&id=${id}&prod=pc`;

                const response = await httpFetch(url);

                if (!id || type === '10000') {
                    const list = (response.body.data?.data || []).map(item => ({
                        play_count: formatPlayCount(item.listencnt),
                        id: `digest-${item.digest}__${item.id}`,
                        author: item.uname || '',
                        name: item.name || '',
                        total: item.total || 0,
                        img: item.img || '',
                        desc: item.desc || '',
                        source: 'kw'
                    }));
                    return {
                        list,
                        total: response.body.data?.total || list.length,
                        page: response.body.data?.pn || page,
                        limit: response.body.data?.rn || 36,
                        source: 'kw'
                    };
                } else {
                    const list = [];
                    (response.body || []).forEach(item => {
                        if (item.label && item.list) {
                            item.list.forEach(sublist => {
                                list.push({
                                    play_count: formatPlayCount(sublist.listencnt),
                                    id: `digest-${sublist.digest}__${sublist.id}`,
                                    author: sublist.uname || '',
                                    name: sublist.name || '',
                                    total: sublist.total || 0,
                                    img: sublist.img || '',
                                    desc: sublist.desc || '',
                                    source: 'kw'
                                });
                            });
                        }
                    });
                    return {
                        list,
                        total: 1000,
                        page,
                        limit: 1000,
                        source: 'kw'
                    };
                }
            } catch (e) {
                return { list: [], total: 0, page, limit: 36, source: 'kw' };
            }
        },
        async getListDetail(id, page = 1) {
            try {
                if (/\/playlist(?:_detail)?\//.test(id)) {
                    id = id.match(/\/playlist(?:_detail)?\/(\d+)/)[1];
                } else if (/^digest-/.test(id)) {
                    const parts = id.split('__');
                    id = parts[1];
                }

                const response = await httpFetch(`http://nplserver.kuwo.cn/pl.svc?op=getlistinfo&pid=${id}&pn=${page - 1}&rn=1000&encode=utf8&keyset=pl2012&identity=kuwo&pcmp4=1&vipver=MUSIC_9.0.5.0_W1&newver=1`);

                if (response.body.result !== 'ok') throw new Error('获取失败');

                const songs = (response.body.musiclist || []).map(item => {
                    const types = [];
                    const _types = {};
                    const infoArr = item.N_MINFO?.split(';') || [];
                    infoArr.forEach(info => {
                        const match = info.match(/level:(\w+),bitrate:(\d+),format:(\w+),size:([\w.]+)/);
                        if (match) {
                            switch (match[2]) {
                                case '4000':
                                    types.push({ type: 'flac24bit', size: match[4].toUpperCase() });
                                    _types.flac24bit = { size: match[4].toUpperCase() };
                                    break;
                                case '2000':
                                    types.push({ type: 'flac', size: match[4].toUpperCase() });
                                    _types.flac = { size: match[4].toUpperCase() };
                                    break;
                                case '320':
                                    types.push({ type: '320k', size: match[4].toUpperCase() });
                                    _types['320k'] = { size: match[4].toUpperCase() };
                                    break;
                                case '128':
                                    types.push({ type: '128k', size: match[4].toUpperCase() });
                                    _types['128k'] = { size: match[4].toUpperCase() };
                                    break;
                            }
                        }
                    });
                    types.reverse();

                    return {
                        singer: decodeName(item.artist) || '',
                        name: decodeName(item.name) || '',
                        albumName: decodeName(item.album) || '',
                        albumId: item.albumid || '',
                        songmid: item.id || '',
                        source: 'kw',
                        interval: formatPlayTime(parseInt(item.duration) || 0),
                        img: item.pic || item.albumpic || '',
                        types,
                        _types,
                        typeUrl: {}
                    };
                });

                return {
                    list: songs,
                    page,
                    limit: response.body.rn || 1000,
                    total: response.body.total || songs.length,
                    source: 'kw',
                    info: {
                        name: response.body.title || '',
                        img: response.body.pic || '',
                        desc: response.body.info || '',
                        author: response.body.uname || '',
                        play_count: formatPlayCount(response.body.playnum)
                    }
                };
            } catch (e) {
                return { list: [], page, limit: 1000, total: 0, source: 'kw', info: {} };
            }
        },
        async search(text, page = 1, limit = 20) {
            try {
                const response = await httpFetch(
                    `http://search.kuwo.cn/r.s?all=${encodeURIComponent(text)}&pn=${page - 1}&rn=${limit}&rformat=json&encoding=utf8&ver=mbox&vipver=MUSIC_8.7.7.0_BCS37&plat=pc&devid=28156413&ft=playlist&pay=0&needliveshow=0`
                );
                
                let body = response.body;
                if (typeof body === 'string') {
                    try {
                        body = JSON.parse(body);
                    } catch {
                        body = {};
                    }
                }

                const list = (body.abslist || []).map(item => ({
                    play_count: formatPlayCount(item.playcnt),
                    id: String(item.playlistid),
                    author: decodeName(item.nickname || ''),
                    name: decodeName(item.name || ''),
                    total: item.songnum || 0,
                    img: item.pic || '',
                    desc: decodeName(item.intro || ''),
                    source: 'kw'
                }));

                return {
                    list,
                    limit,
                    total: parseInt(body.TOTAL) || list.length,
                    source: 'kw'
                };
            } catch (e) {
                return { list: [], limit, total: 0, source: 'kw' };
            }
        }
    },

    kg: {
        sortList: [
            { name: '推荐', id: '5' },
            { name: '最热', id: '6' },
            { name: '最新', id: '7' },
            { name: '热藏', id: '3' },
            { name: '飙升', id: '8' }
        ],
        async getTags() {
            try {
                const response = await httpFetch('http://www2.kugou.kugou.com/yueku/v9/special/getSpecial?is_smarty=1&');
                const data = response.body.data;
                if (!data) throw new Error('获取失败');

                const hotTags = (data.hotTag || {}).map(tag => ({
                    id: tag.special_id,
                    name: tag.special_name,
                    source: 'kg'
                }));

                const tags = Object.keys(data.tagids || {}).map(name => ({
                    name,
                    list: (data.tagids[name]?.data || []).map(tag => ({
                        parent_id: tag.parent_id,
                        parent_name: tag.pname,
                        id: tag.id,
                        name: tag.name,
                        source: 'kg'
                    })),
                    source: 'kg'
                }));

                return { tags, hotTag: hotTags, source: 'kg' };
            } catch (e) {
                return { tags: [], hotTag: [], source: 'kg' };
            }
        },
        async getList(sortId, tagId, page = 1) {
            try {
                const url = `http://www2.kugou.kugou.com/yueku/v9/special/getSpecial?is_ajax=1&cdn=cdn&t=${sortId || '5'}&c=${tagId || ''}&p=${page}`;
                const response = await httpFetch(url);

                if (!response.body || response.body.status !== 1) throw new Error('获取失败');

                const list = (response.body.special_db || []).map(item => ({
                    play_count: formatPlayCount(item.play_count || item.total_play_count),
                    id: 'id_' + item.specialid,
                    author: item.nickname || '',
                    name: item.specialname || '',
                    time: item.publish_time ? new Date(item.publish_time * 1000).toLocaleDateString() : '',
                    img: item.img || item.imgurl || '',
                    total: item.songcount || 0,
                    desc: item.intro || '',
                    source: 'kg'
                }));

                return {
                    list,
                    total: response.body.data?.params?.total || list.length,
                    page,
                    limit: response.body.data?.params?.pagesize || 30,
                    source: 'kg'
                };
            } catch (e) {
                return { list: [], total: 0, page, limit: 30, source: 'kg' };
            }
        },
        async getListDetail(id, page = 1) {
            try {
                if (/\/(\d+)\.html/.test(id)) {
                    id = id.match(/\/(\d+)\.html/)[1];
                } else if (/^id_/.test(id)) {
                    id = id.replace('id_', '');
                }

                const url = `http://www2.kugou.kugou.com/yueku/v9/special/single/${id}-5-9999.html`;
                const response = await httpFetch(url);
                const body = response.body;

                const listDataMatch = body.match(/global\.data = (\[.+\]);/);
                const listInfoMatch = body.match(/global = \{[\s\S]+?name: "(.+)"[\s\S]+?pic: "(.+)"[\s\S]+?\};/);

                if (!listDataMatch) throw new Error('获取失败');

                const songList = JSON.parse(listDataMatch[1]);
                const songs = songList.map(item => {
                    const types = [];
                    const _types = {};
                    if (item.filesize !== 0) {
                        types.push({ type: '128k', size: sizeFormate(item.filesize), hash: item.hash });
                        _types['128k'] = { size: sizeFormate(item.filesize), hash: item.hash };
                    }
                    if (item.filesize_320 !== 0) {
                        types.push({ type: '320k', size: sizeFormate(item.filesize_320), hash: item.hash_320 });
                        _types['320k'] = { size: sizeFormate(item.filesize_320), hash: item.hash_320 };
                    }
                    if (item.filesize_flac !== 0) {
                        types.push({ type: 'flac', size: sizeFormate(item.filesize_flac), hash: item.hash_flac });
                        _types.flac = { size: sizeFormate(item.filesize_flac), hash: item.hash_flac };
                    }

                    return {
                        singer: decodeName(item.singername) || '',
                        name: decodeName(item.songname) || '',
                        albumName: decodeName(item.album_name) || '',
                        albumId: item.album_id || '',
                        songmid: item.audio_id || '',
                        source: 'kg',
                        interval: formatPlayTime((item.duration || 0) / 1000),
                        img: (item.img || item.album_img || '').replace('{size}', '400') || '',
                        hash: item.hash || '',
                        types,
                        _types,
                        typeUrl: {}
                    };
                });

                return {
                    list: songs,
                    page: 1,
                    limit: 9999,
                    total: songs.length,
                    source: 'kg',
                    info: {
                        name: listInfoMatch?.[1] || '',
                        img: listInfoMatch?.[2] || '',
                        desc: '',
                        author: ''
                    }
                };
            } catch (e) {
                return { list: [], page, limit: 9999, total: 0, source: 'kg', info: {} };
            }
        },
        async search(text, page = 1, limit = 20) {
            try {
                const response = await httpFetch(
                    `http://msearchretry.kugou.com/api/v3/search/special?keyword=${encodeURIComponent(text)}&page=${page}&pagesize=${limit}&showtype=10&filter=0&version=7910&sver=2`
                );

                if (response.body.errcode !== 0) throw new Error('获取失败');

                const list = (response.body.data?.info || []).map(item => ({
                    play_count: formatPlayCount(item.playcount),
                    id: 'id_' + item.specialid,
                    author: item.nickname || '',
                    name: item.specialname || '',
                    img: item.imgurl || '',
                    total: item.songcount || 0,
                    desc: item.intro || '',
                    source: 'kg'
                }));

                return {
                    list,
                    limit,
                    total: response.body.data?.total || list.length,
                    source: 'kg'
                };
            } catch (e) {
                return { list: [], limit, total: 0, source: 'kg' };
            }
        }
    }
};

module.exports = {
    getSongListModule: (source) => songListModules[source],
    getSources: () => Object.keys(songListModules),
    getSortList: (source) => songListModules[source]?.sortList || [],
    
    async getTags(source) {
        const module = songListModules[source];
        if (!module) throw new Error(`不支持的音源: ${source}`);
        return module.getTags();
    },
    
    async getList(source, sortId, tagId, page = 1) {
        const module = songListModules[source];
        if (!module) throw new Error(`不支持的音源: ${source}`);
        return module.getList(sortId, tagId, page);
    },
    
    async getListDetail(source, id, page = 1) {
        const module = songListModules[source];
        if (!module) throw new Error(`不支持的音源: ${source}`);
        return module.getListDetail(id, page);
    },
    
    async search(source, text, page = 1, limit = 20) {
        const module = songListModules[source];
        if (!module) throw new Error(`不支持的音源: ${source}`);
        return module.search(text, page, limit);
    }
};