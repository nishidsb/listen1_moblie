// Lyric auto-fill engine: resolves lyrics for ANY-source tracks by matching
// them on netease (lrc + tlyric + romalrc, no membership needed), caches the
// result per track id in AsyncStorage, and exposes helpers for
// add-song-time prefetch, batch backfill and alternative-source lookup.
//
// Mobile port of the reference engine validated in _matcher_test.mjs
// (38/41 = 92.7% end-to-end on real bilibili-origin playlist samples).
import { AsyncStorage } from 'react-native';
import netease from './provider/netease';
import kuwo from './provider/kuwo';

// ------------------------------------------------------------------ cleaning
// Keep alnum + CJK + kana + hangul after lowercasing (full-width folded).
function norm2(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[^0-9a-z\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\u31f0-\u31ff\uac00-\ud7af\u3130-\u318f]/g, '');
}

// Quality/tag junk that pollutes bilibili video titles.
const JUNK = new RegExp([
  'hi-?res', '无损(?:音质|音乐|歌曲)?', '[48]\\s*k\\b', '\\d{3,4}\\s*p\\b', '\\d+\\s*帧', '\\d+\\s*fps',
  '高清|超清|蓝光|画质|修复|重制|翻录|压制',
  'mv|vcd|pv|ncop|nced|op\\d*|ed\\d*|bgm|mad|amv|mp3|flac|ape|wav',
  '主题曲|片头曲|片尾曲|片头|片尾|插曲|宣传曲|印象曲|剧场版|现场(?:版|版音源)?|完整版?|官方|official(?:\\s*music)?\\s*video',
  'live|翻唱|cover|自弹自唱|弹唱|清唱|重唱|串烧|remix',
  '字幕|双语|中英|中日|台词|注解',
  '歌词版?|动态歌词|歌词|翻译|听译|精校|熟肉|汉化|特效',
  '纯享|舞台|直拍|饭拍|歌切|舞见|踊ってみた|karaoke|卡拉ok|伴奏|inst(?:rumental)?|off\\s*vocal',
  'feat\\.?|ft\\.?', 'ver\\.?|version',
  '录音棚|百万豪装|大声听|修音|演唱会|合集|混剪|高燃|燃向|催泪|神曲|名场面|经典|怀旧|巅峰|开口跪|起鸡皮|单曲循环|收藏级|百听不厌|循环|洗脑|上头|无敌|轰炸|燃爆|顶级|天花板|百万级|现场感|氛围感|代入感|沉浸式|太好听了|绝对|珍藏|追忆|回忆杀|青春|岁月',
].join('|'), 'gi');

const QUOTE_PAIRS = [['《', '》'], ['「', '」'], ['『', '』'], ['“', '”']];
const PAREN_PAIRS = [['（', '）'], ['(', ')']];
const BRACKET_PAIRS = [['【', '】'], ['[', ']']];
function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function segments(raw, pairs, minLen, maxLen) {
  const out = [];
  for (let i = 0; i < pairs.length; i += 1) {
    const a = pairs[i][0];
    const b = pairs[i][1];
    const re = new RegExp(`${esc(a)}([^${esc(a)}${esc(b)}]{${minLen},${maxLen}})${esc(b)}`, 'g');
    let m;
    while ((m = re.exec(raw || ''))) out.push({ text: m[1], at: m.index });
  }
  return out.sort((x, y) => x.at - y.at);
}
const hasPunct = (s) => /[，。！？!?～~、；;：:…·]/.test(s);

// Ordered query variants for one raw title (best first).
export function queryVariants(rawTitle, artist) {
  const raw = (rawTitle || '').trim();
  if (!raw) return [];
  const variants = [];

  // V1: first usable quote segment (song name is usually quoted on bilibili)
  const quos = segments(raw, QUOTE_PAIRS, 2, 40);
  for (let i = 0; i < quos.length; i += 1) {
    const t = quos[i].text.trim();
    if (!hasPunct(t) && !JUNK.test(t)) {
      variants.push(t);
      break;
    }
    JUNK.lastIndex = 0;
  }

  // V2: strip brackets/parens/quotes and junk words
  let t = raw;
  const allPairs = [BRACKET_PAIRS, PAREN_PAIRS, QUOTE_PAIRS];
  for (let g = 0; g < allPairs.length; g += 1) {
    for (let i = 0; i < allPairs[g].length; i += 1) {
      t = t.split(allPairs[g][i][0]).join(' ').split(allPairs[g][i][1]).join(' ');
    }
  }
  t = t.replace(JUNK, ' ');
  JUNK.lastIndex = 0;
  // drop descriptive tail clauses (split by sentence punctuation, keep head)
  const clauses = t.split(/[，。！？!?～~、；;]+/).filter(Boolean);
  t = clauses.join(' ');
  t = t.replace(/[\s\-—–/／|｜_·]+/g, ' ').replace(/[,,.。::'"()（）]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (t.length >= 2) variants.push(t);

  // V3: first two tokens of V2
  const toks = t.split(' ').filter((x) => norm2(x).length >= 2);
  if (toks.length > 2 && toks.slice(0, 2).join(' ') !== t) variants.push(toks.slice(0, 2).join(' '));

  // V4: bracket texts that are not quality/tag junk (e.g. [BOYS BE AMBITIOUS])
  const brs = segments(raw, BRACKET_PAIRS, 1, 40);
  for (let i = 0; i < brs.length; i += 1) {
    const s = brs[i].text.trim();
    if (s.length >= 2 && !JUNK.test(s) && !/\d/.test(s)) variants.push(s);
    JUNK.lastIndex = 0;
  }

  // V6: quote segment nested in parens
  const ps = segments(raw, PAREN_PAIRS, 2, 60);
  for (let i = 0; i < ps.length; i += 1) {
    const inner = segments(ps[i].text, QUOTE_PAIRS, 2, 40);
    if (inner.length) variants.push(inner[0].text.trim());
  }

  // V5: legacy keyword (all-brackets stripped title + artist) as last resort
  const legacy = raw
    .replace(/【[^【】]*】|\[[^\[\]]*\]|（[^（）]*）|\([^()]*\)|《[^《》]*》|「[^「」]*」|『[^『』]*』/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (legacy.length >= 2) variants.push(artist ? `${legacy} ${artist}` : legacy);

  // dedupe, keep order, drop degenerate queries
  const seen = {};
  const out = [];
  for (let i = 0; i < variants.length; i += 1) {
    const v = variants[i].trim();
    const n = norm2(v);
    if (n.length < 2 || seen[n]) continue;
    seen[n] = true;
    out.push(v);
  }
  return out;
}

// ------------------------------------------------------------------ scoring
function lcs(a, b) {
  if (!a.length || !b.length) return 0;
  const prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diag = prev[0];
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = prev[j];
      prev[j] = a[i - 1] === b[j - 1] ? diag + 1 : Math.max(prev[j], prev[j - 1]);
      diag = tmp;
    }
  }
  return prev[b.length];
}

// Strong score of a candidate song against a query variant. Accept line 4.0.
export function strongScore(query, name, artistNames, rawTitle) {
  const w = norm2(query);
  const c = norm2(name);
  if (!w || !c) return 0;
  let score = 0;
  if (w === c) {
    score = 6;
  } else if (c.length >= 4 && w.indexOf(c) !== -1) {
    score = 3.2 + c.length / w.length;
  } else if (w.indexOf(c) !== -1) {
    score = 4.5 + Math.min(1, w.length / c.length);
  }
  if (!score) {
    const toks = query.split(/[\s\-—–/／|｜_·,，、]+/).map(norm2).filter((x) => x.length >= 2);
    let tokHit = false;
    for (let i = 0; i < toks.length; i += 1) {
      if (toks[i] === c) {
        score = 4.6;
        tokHit = true;
        break;
      }
    }
    if (!tokHit) {
      for (let i = 0; i < toks.length; i += 1) {
        if (toks[i].length >= 4 && c.indexOf(toks[i]) !== -1) {
          score = 4.2;
          break;
        }
      }
    }
  }
  if (!score) {
    const r = lcs(w, c) / Math.max(w.length, c.length);
    if (r >= 0.8) score = 4.4 + r;
    else if (r >= 0.65) score = 3.4 + r;
    else if (r >= 0.5) score = 2.4 + r;
  }
  if (score >= 3.2 && rawTitle) {
    const rt = norm2(rawTitle);
    for (let i = 0; i < artistNames.length; i += 1) {
      const na = norm2(artistNames[i]);
      if (na.length >= 2 && rt.indexOf(na) !== -1) {
        score += 1;
        break;
      }
    }
  }
  return score;
}

// -------------------------------------------------------------------- cache
// lyric_cache_v2_<trackId> -> JSON {neteaseId, songName, lyric, tlyric, romalrc}
// or {miss:1, at} (negative result; retried after 24h so a temporarily
// blocked network never poisons the cache permanently).
const CACHE_PREFIX = 'lyric_cache_v2_';
const MISS_TTL = 24 * 60 * 60 * 1000;
const inflight = {};

function readCache(trackId) {
  return AsyncStorage.getItem(CACHE_PREFIX + trackId)
    .then((s) => {
      if (!s) return null;
      const entry = JSON.parse(s);
      if (entry && entry.miss && Date.now() - (entry.at || 0) > MISS_TTL) {
        return null;
      }
      return entry;
    })
    .catch(() => null);
}
function writeCache(trackId, entry) {
  AsyncStorage.setItem(CACHE_PREFIX + trackId, JSON.stringify(entry)).catch(() => undefined);
}

const hasTimestamp = (lrc) => /\[\d{1,3}:\d{2}/.test(lrc || '');

// ----------------------------------------------------------------- resolving
const ACCEPT = 4.0;

// Resolve an arbitrary-source track to a netease song with usable lyrics.
// Returns { neteaseId, songName, lyric, tlyric, romalrc } or null.
export function resolveLyric(track) {
  if (!track || !track.title) {
    return Promise.resolve(null);
  }
  if (track.source === 'netease') {
    const num = String(track.id).replace('netrack_', '');
    return netease.getLyricRaw(num).then((raw) => {
      if (raw && hasTimestamp(raw.lyric)) {
        return { neteaseId: num, songName: track.title, lyric: raw.lyric, tlyric: raw.tlyric, romalrc: raw.romalrc };
      }
      return null;
    });
  }
  const pool = {}; // songId -> {song, score}
  const variants = queryVariants(track.title, track.artist);

  const step = (vi) => {
    if (vi >= variants.length) return Promise.resolve(null);
    const q = variants[vi];
    return netease.searchSongsRaw(q).then((songs) => {
      for (let i = 0; i < Math.min(songs.length, 20); i += 1) {
        const s = songs[i];
        const sc = strongScore(q, s.name, s.artists, track.title);
        const prev = pool[s.id];
        if (!prev || sc > prev.score) pool[s.id] = { song: s, score: sc };
      }
      let max = 0;
      const keys = Object.keys(pool);
      for (let i = 0; i < keys.length; i += 1) {
        if (pool[keys[i]].score > max) max = pool[keys[i]].score;
      }
      if (max >= ACCEPT) return null; // early stop marker handled below
      return step(vi + 1);
    });
  };

  // run the cascade; because "early stop" needs the pool afterwards, track it
  return step(0).then(() => {
    const cands = Object.keys(pool)
      .map((k) => pool[k])
      .filter((v) => v.score >= ACCEPT)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2);

    const tryCand = (ci) => {
      if (ci >= cands.length) return Promise.resolve(null);
      const cand = cands[ci];
      return netease.getLyricRaw(cand.song.id).then((raw) => {
        if (raw && hasTimestamp(raw.lyric)) {
          return {
            neteaseId: String(cand.song.id),
            songName: cand.song.name,
            lyric: raw.lyric,
            tlyric: raw.tlyric,
            romalrc: raw.romalrc,
          };
        }
        return tryCand(ci + 1);
      });
    };
    return tryCand(0);
  });
}

// Resolve and persist into the per-track cache. Safe to call repeatedly.
export function preloadLyric(track) {
  if (!track || !track.id) {
    return Promise.resolve(null);
  }
  if (inflight[track.id]) {
    return inflight[track.id];
  }
  inflight[track.id] = readCache(track.id)
    .then((cached) => {
      if (cached) return cached;
      return resolveLyric(track)
        .then((r) => {
          const entry = r || { miss: 1, at: Date.now() };
          writeCache(track.id, entry);
          return entry;
        })
        .catch(() => null);
    })
    .then((r) => {
      delete inflight[track.id];
      return r;
    });
}

// Unified access point for a track: returns { lines, found }.
// 1. per-track cache  2. netease source direct  3. matcher engine + cache.
export function getLyrics(track) {
  if (!track || !track.title) {
    return Promise.resolve({ lines: [], found: false });
  }
  if (track.source === 'netease') {
    return netease.getLyric(track).then((r) => r);
  }
  return readCache(track.id).then((cached) => {
    if (cached) {
      if (cached.miss) return { lines: [], found: false };
      return netease.parseLyricTexts(cached);
    }
    // fast path: track carries a previously resolved netease song id
    if (track.neteaseId) {
      return netease.getLyricRaw(track.neteaseId).then((raw) => {
        if (raw && hasTimestamp(raw.lyric)) {
          const entry = {
            neteaseId: String(track.neteaseId),
            songName: track.title,
            lyric: raw.lyric,
            tlyric: raw.tlyric,
            romalrc: raw.romalrc,
          };
          writeCache(track.id, entry);
          return netease.parseLyricTexts(entry);
        }
        return { lines: [], found: false };
      });
    }
    return preloadLyric(track).then((entry) => {
      if (!entry || entry.miss) return { lines: [], found: false };
      return netease.parseLyricTexts(entry);
    });
  });
}

// Resolve just the netease song id for a track (used at add-to-playlist time
// so the id can be persisted onto the track object).
export function resolveNeteaseId(track) {
  return preloadLyric(track).then((entry) => (entry && !entry.miss ? entry.neteaseId : null));
}

// ------------------------------------------------------- alternative source
// Find the same song on kuwo (playable fallback when the original source has
// no playable url). Uses the same cleaned queries + strong scoring.
export function findAlternativeSource(track) {
  if (!track || !track.title || track.source === 'kuwo') {
    return Promise.resolve(null);
  }
  const variants = queryVariants(track.title, track.artist).slice(0, 4);

  const step = (vi) => {
    if (vi >= variants.length) return Promise.resolve(null);
    return kuwo.search(variants[vi], 1).then((res) => {
      const songs = (res && res.result) || [];
      let best = null;
      let bestScore = 0;
      for (let i = 0; i < songs.length; i += 1) {
        const s = songs[i];
        const sc = strongScore(variants[vi], s.title, s.artist ? [s.artist] : [], track.title);
        if (sc > bestScore) {
          best = s;
          bestScore = sc;
        }
      }
      if (best && bestScore >= ACCEPT) return best;
      return step(vi + 1);
    }).catch(() => (vi + 1 < variants.length ? step(vi + 1) : null));
  };
  return step(0);
}

// ------------------------------------------------------------ batch backfill
// Fill lyrics for every track of a playlist that has no cache entry yet.
// onProgress(done, total, title); cancelled() -> true aborts the loop.
// Aborts (rejects {aborted:true}) after 8 consecutive misses — that pattern
// means the netease endpoints are blocked/rate-limiting right now, and
// grinding on would only poison the negative cache.
// Returns { done, matched }.
export function fillPlaylistLyrics(tracks, onProgress, cancelled) {
  const list = (tracks || []).slice();
  let done = 0;
  let matched = 0;
  let consecutiveMiss = 0;

  return new Promise((resolve, reject) => {
    const step = (i) => {
      if (cancelled && cancelled()) {
        if (onProgress) onProgress(done, list.length, '');
        return resolve({ done, matched });
      }
      if (i >= list.length) {
        if (onProgress) onProgress(done, list.length, '');
        return resolve({ done, matched });
      }
      const t = list[i];
      readCache(t.id)
        .then((cached) => {
          if (cached) {
            if (!cached.miss) {
              matched += 1;
            }
            consecutiveMiss = 0;
            done += 1;
            if (onProgress) onProgress(done, list.length, t.title);
            return step(i + 1);
          }
          return preloadLyric(t).then((entry) => {
            if (entry && !entry.miss) {
              matched += 1;
              consecutiveMiss = 0;
            } else {
              consecutiveMiss += 1;
            }
            done += 1;
            if (onProgress) onProgress(done, list.length, t.title);
            if (consecutiveMiss >= 8) {
              return reject({ aborted: true, done, matched });
            }
            return step(i + 1);
          });
        })
        .catch(() => {
          done += 1;
          consecutiveMiss += 1;
          if (onProgress) onProgress(done, list.length, t.title);
          if (consecutiveMiss >= 8) {
            return reject({ aborted: true, done, matched });
          }
          return step(i + 1);
        });
    };
    step(0);
  });
}

export function hasLyrics(result) {
  return Boolean(result && result.found && result.lines.length);
}

export default {
  getLyrics,
  hasLyrics,
  queryVariants,
  strongScore,
  resolveLyric,
  preloadLyric,
  resolveNeteaseId,
  findAlternativeSource,
  fillPlaylistLyrics,
};
