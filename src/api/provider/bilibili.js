/* eslint no-bitwise: ["error", { "allow": ["&"] }] */
// Bilibili provider for listen1 mobile (React Native 0.59 compatible).
// Playback strategy: platform=html5 progressive mp4 (single URL, plays in
// react-native-video), falling back to dash audio stream when html5 fails.
import queryString from 'query-string';

const BILI_API = 'https://api.bilibili.com';

const HEADERS = {
  referer: 'https://www.bilibili.com/',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  // A per-install random buvid keeps the search API away from -412 risk control.
  cookie:
    'buvid3=In4B8C2A2C5A4E11E8B4A0D5F1C6B7D8Einforc; b_nut=1700000000',
};

function requestJson(url) {
  return fetch(url, { method: 'get', headers: HEADERS })
    .then(response => response.json())
    .catch(() => null);
}

// Track ids look like 'bitrack_v_BV1xxx' (v_ = video kind, legacy desktop format).
function extractVideoId(trackId) {
  let rest = trackId.slice('bitrack_'.length);
  if (rest.indexOf('v_') === 0) {
    rest = rest.slice(2);
  }
  return rest; // 'BV1xxx' | 'av123' | '123'
}

function requestVideoInfo(videoId) {
  const isBv = videoId.indexOf('BV') === 0;
  const aid = videoId.replace(/^av/, '');
  const url = isBv
    ? `${BILI_API}/x/web-interface/view?bvid=${videoId}`
    : `${BILI_API}/x/web-interface/view?aid=${aid}`;
  return requestJson(url).then(data => {
    if (data && data.code === 0 && data.data && data.data.cid) {
      return data.data;
    }
    return null;
  });
}

function pickDurl(data) {
  if (
    data &&
    data.code === 0 &&
    data.data &&
    data.data.durl &&
    data.data.durl.length > 0 &&
    data.data.durl[0].url
  ) {
    return data.data.durl[0].url;
  }
  return '';
}

function pickDashAudio(data) {
  if (
    data &&
    data.code === 0 &&
    data.data &&
    data.data.dash &&
    data.data.dash.audio &&
    data.data.dash.audio.length > 0
  ) {
    const audios = data.data.dash.audio;
    const best = audios[audios.length - 1]; // last entry = highest bandwidth
    return best.baseUrl || best.base_url || '';
  }
  return '';
}

function fetchPlayUrl(bvid, cid) {
  // html5 endpoint returns a single progressive mp4 (video+audio) - most reliable
  // stream for react-native-video without needing any cookie or login.
  const html5Url = `${BILI_API}/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=64&type=mp4&otype=json&platform=html5&high_quality=1`;
  return requestJson(html5Url).then(data => {
    const url = pickDurl(data);
    if (url !== '') {
      return url;
    }
    // fallback: dash audio-only stream (saves bandwidth, needs range support)
    const dashUrl = `${BILI_API}/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=16&fnver=0&fourk=1&otype=json&platform=pc`;
    return requestJson(dashUrl).then(dashData => pickDashAudio(dashData));
  });
}

function bootstrapTrack(trackId) {
  const videoId = extractVideoId(trackId);
  return requestVideoInfo(videoId).then(info => {
    if (!info) {
      return '';
    }
    const bvid = info.bvid || `av${info.aid}`;
    return fetchPlayUrl(bvid, info.cid).then(url => url || '');
  });
}

function stripTags(text) {
  return String(text || '')
    .replace(/<em class="keyword">/g, '')
    .replace(/<\/em>/g, '')
    .replace(/<[^>]+>/g, '');
}

function search(keyword, page) {
  const url = `${
    BILI_API
  }/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(
    keyword
  )}&page=${page || 1}`;
  return requestJson(url).then(data => {
    if (!data || data.code !== 0 || !data.data || !data.data.result) {
      return { result: [], total: 0 };
    }
    const tracks = data.data.result
      .filter(item => item.bvid)
      .map(item => ({
        id: `bitrack_v_${item.bvid}`,
        title: stripTags(item.title),
        artist: item.author || '',
        artist_id: `biartist_${item.mid || ''}`,
        album: '哔哩哔哩',
        album_id: '',
        source: 'bilibili',
        source_url: `https://www.bilibili.com/video/${item.bvid}`,
        img_url: item.pic || '',
        url: `bitrack_v_${item.bvid}`,
        lyric_url: '',
      }));
    return { result: tracks, total: data.data.numResults || tracks.length };
  });
}

function showPlaylist(offset) {
  // bilibili has no curated music playlist index; keep the tab functional but empty
  return Promise.resolve({ result: [], hasNextPage: false });
}

function renderFavMedia(item) {
  if (!item || (!item.bvid && !item.bv_id)) {
    return null;
  }
  const bvid = item.bvid || item.bv_id;
  return {
    id: `bitrack_v_${bvid}`,
    title: item.title || '',
    artist: (item.upper && item.upper.name) || '',
    artist_id: `biartist_${(item.upper && item.upper.mid) || ''}`,
    album: '哔哩哔哩收藏夹',
    album_id: '',
    source: 'bilibili',
    source_url: `https://www.bilibili.com/video/${bvid}`,
    img_url: item.cover || '',
    url: `bitrack_v_${bvid}`,
    lyric_url: '',
  };
}

function getPlaylist(playlistId) {
  if (playlistId.indexOf('bilifavlist_') !== 0) {
    return null;
  }
  const mediaId = playlistId.slice('bilifavlist_'.length);
  const url = `${BILI_API}/x/v3/fav/resource/list?media_id=${mediaId}&pn=1&ps=50&order=mtime&type=0&tid=0&platform=web`;
  return requestJson(url).then(data => {
    if (!data || data.code !== 0 || !data.data) {
      return null;
    }
    const info = {
      cover_img_url: (data.data.info && data.data.info.cover) || '',
      title: (data.data.info && data.data.info.title) || '哔哩哔哩收藏夹',
      id: `bilifavlist_${mediaId}`,
      source_url: `https://space.bilibili.com/favlist?fid=${mediaId}`,
    };
    const medias = data.data.medias || [];
    const tracks = medias.map(renderFavMedia).filter(t => t !== null);
    return { info, tracks };
  });
}

function parseUrl(url) {
  let result = null;

  const fav = /\/\/space\.bilibili\.com\/[0-9]+\/favlist.*[?&]fid=([0-9]+)/g.exec(
    url
  );
  if (fav !== null) {
    result = {
      type: 'playlist',
      id: `bilifavlist_${fav[1]}`,
    };
    return result;
  }

  const medialist = /\/\/www\.bilibili\.com\/medialist\/play\/ml([0-9]+)/g.exec(
    url
  );
  if (medialist !== null) {
    result = {
      type: 'playlist',
      id: `bilifavlist_${medialist[1]}`,
    };
    return result;
  }

  return result;
}

const meta = { name: '哔哩', platformId: 'bi', enName: 'bilibili' };

export default {
  meta,
  showPlaylist,
  getPlaylist,
  bootstrapTrack,
  search,
  parseUrl,
};
