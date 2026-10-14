/* eslint no-bitwise: ["error", { "allow": ["&"] }] */
import queryString from 'query-string';
import { weapi } from '../../modules/crypto';

// Anonymous session cookie, created once per app session. Rotating cookies
// per request is a crawl signature and gets the whole IP banned (observed
// 405 WAF bans lasting 5-15 minutes during lyric matching tests).
const NTES_COOKIE = (() => {
  let nuid = '';
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i += 1) {
    nuid += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `_ntes_nuid=${nuid}; _ntes_nnid3=${nuid},${Date.now()}; NMTID=0`;
})();

// Global paced queue for anonymous netease endpoints. Measured safe rhythm is
// >=2.5s between requests; faster bursts trigger 405/406 WAF bans. Backoff
// 10s/30s before giving up, then a 5-minute cooldown so a ban can expire
// instead of being extended by retries.
let neChain = Promise.resolve();
let neLastAt = 0;
let neCooldownUntil = 0;
const NE_GAP = 2500;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function nePacedRequest(doRequest) {
  const run = neChain.then(async () => {
    if (Date.now() < neCooldownUntil) {
      await sleep(neCooldownUntil - Date.now());
    }
    const gap = NE_GAP + Math.floor(Math.random() * 600);
    const since = Date.now() - neLastAt;
    if (since < gap) {
      await sleep(gap - since);
    }
    neLastAt = Date.now();
    return doRequest();
  });
  // keep the queue alive when a caller does not catch
  neChain = run.then(() => undefined, () => undefined);
  return run;
}

// A hung request (e.g. okhttp OOM mid-response kills the RN network callback
// without settling the JS promise) must never stall a batch: race a 15s
// timeout that resolves null, which callers treat as a failed request.
const NE_TIMEOUT = 15000;
function withTimeout(promise) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(null), NE_TIMEOUT)),
  ]);
}

function postForm(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: {
      referer: 'https://music.163.com/',
      'content-type': 'application/x-www-form-urlencoded',
      cookie: NTES_COOKIE,
      'user-agent':
        'Mozilla/5.0 (Linux; U; Android 8.1.0; zh-cn; BLA-AL00 Build/HUAWEIBLA-AL00) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/57.0.2987.132 MQQBrowser/8.9 Mobile Safari/537.36',
    },
    body,
  })
    .then((response) => {
      if (response.status === 405 || response.status === 406) {
        return { code: response.status };
      }
      return response.json();
    })
    .catch(() => null);
}

// Legacy song search with degraded endpoint. cloudsearch is rate-limited for
// anonymous clients (code 50000005); api/search/pc with the _ntes_* cookie
// works, and api/search/get takes the same params/shape as a fallback.
function searchSongsRaw(keyword) {
  const body = queryString.stringify({
    s: keyword,
    offset: 0,
    limit: 20,
    type: 1,
  });
  const endpoints = [
    'https://music.163.com/api/search/pc',
    'https://music.163.com/api/search/get',
  ];
  const attempt = (idx) =>
    nePacedRequest(() => withTimeout(postForm(endpoints[idx], body))).then((resData) => {
      if (resData && resData.code === 200 && resData.result && resData.result.songs) {
        return resData.result.songs.map((song) => ({
          id: song.id,
          name: song.name,
          artists: (song.artists || []).map((a) => a.name),
        }));
      }
      if (idx + 1 < endpoints.length && (!resData || resData.code === 405 || resData.code === 406 || resData.code === -460 || resData.code === -462)) {
        return attempt(idx + 1);
      }
      return [];
    });
  return attempt(0);
}

// Raw lyric fetch for the matcher engine (paced). Returns null when blocked.
function getLyricRaw(songId) {
  const url = 'https://music.163.com/weapi/song/lyric';
  const data = {
    id: String(songId),
    lv: 1,
    tv: -1,
    rv: -1,
    kv: -1,
  };
  return nePacedRequest(() => withTimeout(requestAPI(url, data))).then((resData) => {
    if (!resData || !resData.lrc) {
      return null;
    }
    return {
      lyric: resData.lrc.lyric || '',
      tlyric: (resData.tlyric && resData.tlyric.lyric) || '',
      romalrc: (resData.romalrc && resData.romalrc.lyric) || '',
    };
  });
}

function requestAPI(url, data) {
  return fetch(url, {
    method: 'POST',
    headers: {
      referer: 'https://music.163.com/',
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent':
        'Mozilla/5.0 (Linux; U; Android 8.1.0; zh-cn; BLA-AL00 Build/HUAWEIBLA-AL00) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/57.0.2987.132 MQQBrowser/8.9 Mobile Safari/537.36',
    },
    body: queryString.stringify(weapi(data)),
  })
    .then((response) => {
      return response.json();
    })
    .catch(() => {
      // console.error(error);
    });
}
function getSmallImageUrl(url) {
  return `${url}?param=140y140`;
}
function showPlaylist(offset) {
  const query = {
    offset,
  };
  const data = {
    cat: query.cat || '全部',
    order: query.order || 'hot', // hot,new
    limit: query.limit || 30,
    offset: query.offset || 0,
    total: true,
  };

  const url = 'https://music.163.com/weapi/playlist/list';

  return requestAPI(url, data)
    .then((r) => {
      const playlists = r.playlists.map((item) => ({
        cover_img_url: getSmallImageUrl(item.coverImgUrl),
        title: item.name,
        id: `neplaylist_${item.id}`,
        source_url: `http://music.163.com/#/playlist?id=${item.id}`,
      }));

      return { result: playlists };
    })
    .catch(() => {
      // console.error(error);
    });
}
function getNEScore(song) {
  if (!song) return 0;
  const privilege = song.privilege;

  if (song.program) return 0;

  if (privilege) {
    if (privilege.st != null && privilege.st < 0) {
      return 100;
    }
    if (
      privilege.fee > 0 &&
      privilege.fee !== 8 &&
      privilege.payed === 0 &&
      privilege.pl <= 0
    )
      return 10;
    if (privilege.fee === 16 || (privilege.fee === 4 && privilege.flag & 2048))
      return 11;
    if (
      (privilege.fee === 0 || privilege.payed) &&
      privilege.pl > 0 &&
      privilege.dl === 0
    )
      return 1e3;
    if (privilege.pl === 0 && privilege.dl === 0) return 100;

    return 0;
  }

  if (song.status >= 0) return 0;
  if (song.fee > 0) return 10;

  return 100;
}

function isPlayable(song) {
  return getNEScore(song) < 100;
}

function convert(allowAll) {
  return (songInfo) => ({
    id: `netrack_${songInfo.id}`,
    title: songInfo.name,
    artist: songInfo.ar[0].name,
    artist_id: `neartist_${songInfo.ar[0].id}`,
    album: songInfo.al.name,
    album_id: `nealbum_${songInfo.al.id}`,
    source: 'netease',
    source_url: `http://music.163.com/#/song?id=${songInfo.id}`,
    img_url: songInfo.al.picUrl,
    url: `netrack_${songInfo.id}`,
    disabled: allowAll ? false : !isPlayable(songInfo),
  });
}

function getPlaylist(playlistId) {
  const listId = playlistId.split('_').pop();
  const data = {
    id: listId,
    offset: 0,
    total: true,
    limit: 1000,
    n: 1000,
    csrf_token: '',
  };

  const playlist_url = 'http://music.163.com/weapi/v3/playlist/detail';
  const tracks_url = 'https://music.163.com/weapi/v3/song/detail';

  return requestAPI(playlist_url, data).then((resData) => {
    const info = {
      id: `neplaylist_${listId}`,
      cover_img_url: getSmallImageUrl(resData.playlist.coverImgUrl),
      title: resData.playlist.name,
      source_url: `http://music.163.com/#/playlist?id=${listId}`,
    };

    // request all tracks to fetch song info
    // Code reference from listen1_chrome_extension
    const track_ids = resData.playlist.trackIds.map((i) => i.id);
    const data = {
      c: '[' + track_ids.map((id) => '{"id":' + id + '}').join(',') + ']',
      ids: '[' + track_ids.join(',') + ']',
    };

    return requestAPI(tracks_url, data).then((response) => {
      const tracks = response.songs.map(convert(true));
      return { info, tracks };
    });
  });
}

function bootstrapTrack(trackId) {
  const url =
    'http://music.163.com/weapi/song/enhance/player/url/v1?csrf_token=';

  const songId = trackId.slice('netrack_'.length);

  const data = {
    ids: [songId],
    level: 'standard',
    encodeType: 'aac',
    csrf_token: '',
  };

  return requestAPI(url, data).then((resData) => {
    const { url: songUrl } = resData.data[0];

    if (songUrl === null) {
      return '';
    }

    return songUrl;
  });
}

function search(keyword, page) {
  const url = 'https://music.163.com/weapi/cloudsearch/get/web';
  const data = {
    csrf_token: '',
    hlposttag: '</span>',
    hlpretag: '<span class="s-fc7">',
    limit: '30',
    offset: (30 * (page - 1)).toString(),
    s: keyword,
    total: 'false',
    type: '1',
  };

  return requestAPI(url, data).then((resData) => {
    const tracks = resData.result.songs.map(convert(false));

    return {
      result: tracks,
      total: resData.result.songCount,
    };
  });
}

// Legacy search endpoint with the session ntes cookie (see NTES_COOKIE note).
function searchByTitle(keyword) {
  return searchSongsRaw(keyword).then((songs) => ({
    result: songs.map((song) => ({
      id: `netrack_${song.id}`,
      title: song.name,
      artist: song.artists && song.artists.length > 0 ? song.artists[0].name : '',
      album: '',
      source: 'netease',
      source_url: `http://music.163.com/#/song?id=${song.id}`,
      img_url: '',
      url: `netrack_${song.id}`,
    })),
    total: songs.length,
  }));
}

function parseUrl(url) {
  let result = null;

  const r = /\/\/music\.163\.com\/playlist\/([0-9]+)/g.exec(url);

  if (r !== null) {
    return {
      type: 'playlist',
      id: `neplaylist_${r[1]}`,
    };
  }

  if (
    url.search('//music.163.com/#/m/playlist') !== -1 ||
    url.search('//music.163.com/#/playlist') !== -1 ||
    url.search('//music.163.com/playlist') !== -1 ||
    url.search('//music.163.com/#/my/m/music/playlist') !== -1
  ) {
    const parsed = queryString.parseUrl(url);

    result = {
      type: 'playlist',
      id: `neplaylist_${parsed.query.id}`,
    };
  }

  return result;
}

// Parse an LRC block into [{time, text}] where time is seconds (fractional).
function parseLrc(lrcText) {  if (!lrcText) {
    return [];
  }
  const lines = lrcText.split(/\r?\n/);
  const result = [];
  const timeRe = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

  for (const line of lines) {
    // Skip blank/meta lines that carry no time stamp
    if (!line || !timeRe.test(line)) {
      continue;
    }
    timeRe.lastIndex = 0;
    const stamps = [];
    let m;
    while ((m = timeRe.exec(line)) !== null) {
      const min = parseInt(m[1], 10);
      const sec = parseInt(m[2], 10);
      let frac = 0;
      if (m[3]) {
        // '4'->400ms '46'->460ms '466'->466ms; avoids padEnd (ES2017, not
        // guaranteed on RN 0.59's old Android JSC)
        const fs = m[3].length === 1 ? `${m[3]}00` : m[3].length === 2 ? `${m[3]}0` : m[3];
        frac = parseInt(fs, 10) / 1000;
      }
      stamps.push(min * 60 + sec + frac);
    }
    const text = line.replace(timeRe, '').replace(/^\s+/, '');
    if (!text.trim()) {
      continue;
    }
    for (const t of stamps) {
      result.push({ time: t, text });
    }
  }
  result.sort((a, b) => a.time - b.time);
  return result;
}

// Merge raw lrc/tlyric/romalrc texts into normalized lines
// [{time, text, trans, roma}]. Translation/romaji are matched to the nearest
// original line within a 0.5s tolerance.
function parseLyricTexts(raw) {
  const lyricText = raw && raw.lyric ? raw.lyric : '';
  if (!lyricText) {
    return { lines: [], found: false };
  }
  const origin = parseLrc(lyricText);
  const trans = parseLrc(raw.tlyric);
  const roma = parseLrc(raw.romalrc);

  const lines = origin.map((l) => {
    const transLine = trans.find((t) => Math.abs(t.time - l.time) < 0.5);
    const romaLine = roma.find((r) => Math.abs(r.time - l.time) < 0.5);
    return {
      time: l.time,
      text: l.text,
      trans: transLine ? transLine.text : '',
      roma: romaLine ? romaLine.text : '',
    };
  });
  return { lines, found: lines.length > 0 };
}

// Fetch netease lyrics for a given netease song id and return a normalized
// line list [{time, text, trans, roma}]. Original lyrics + translation +
// romaji all come straight from the netease lyric endpoint (no membership).
function getLyric(trackOrId) {
  let songId = trackOrId;
  if (typeof trackOrId === 'object') {
    // id is 'netrack_<neteaseSongId>' or the raw id
    songId = String(trackOrId.id || trackOrId).replace('netrack_', '');
  }
  songId = String(songId).replace('netrack_', '');
  return getLyricRaw(songId).then((raw) => parseLyricTexts(raw));
}

const meta = { name: '网易', platformId: 'ne', enName: 'netease' };

export default {
  meta,
  showPlaylist,
  getPlaylist,
  bootstrapTrack,
  search,
  searchByTitle,
  searchSongsRaw,
  getLyricRaw,
  parseLyricTexts,
  parseUrl,
  getLyric,
};
