import netease from './provider/netease';

function titleKey(title) {
  if (!title) {
    return '';
  }
  // Strip bracketed annotations like [xxx] / (xxx) / 伴奏 / 各种版本后缀
  return title
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/（[^）]*）/g, ' ')
    .replace(/【[^】]*】/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreMatch(title, artist, song) {
  const tKey = titleKey(title).toLowerCase();
  const sKey = titleKey(song.name).toLowerCase();
  let score = 0;
  if (sKey === tKey) {
    score += 3;
  } else if (tKey && (sKey.indexOf(tKey) !== -1 || tKey.indexOf(sKey) !== -1)) {
    score += 2;
  }
  if (!score) {
    return 0;
  }
  // artist bonus (best-effort, matches any of the song's artists)
  if (artist) {
    const aKey = artist.toLowerCase();
    const songArtists = (song.ar || []).map((a) => a.name.toLowerCase()).join(' ');
    if (songArtists.indexOf(aKey) !== -1) {
      score += 1;
    }
  }
  return score;
}

// Find the best matching netease song id for an arbitrary-origin track.
// Uses the same cloudsearch channel the app's search already uses.
function findNeteaseId(track) {
  const keyword = `${titleKey(track.title)} ${track.artist || ''}`.trim();
  if (!keyword) {
    return Promise.resolve(null);
  }
  return netease.search(keyword, 1).then((res) => {
    const tracks = res && res.result ? res.result : [];
    if (!tracks.length) {
      return null;
    }
    let best = null;
    let bestScore = 0;
    for (const t of tracks) {
      // t is a converted netease track: { id:'netrack_<id>', title, artist }
      const s = scoreMatch(track.title, track.artist, {
        name: t.title,
        ar: t.artist ? [{ name: t.artist }] : [],
      });
      if (s > bestScore) {
        best = t;
        bestScore = s;
      }
    }
    return bestScore >= 2 ? best : null;
  });
}

// Unified access point for a track: returns { lines, found }.
// Priority: netease source first; otherwise try to locate the same song on
// netease (original + translation + romaji); best-effort native fallback.
export function getLyrics(track) {
  if (!track || !track.title) {
    return Promise.resolve({ lines: [], found: false });
  }
  if (track.source === 'netease') {
    return netease.getLyric(track).then((r) => r);
  }
  return findNeteaseId(track).then((netTrack) => {
    if (netTrack) {
      return netease.getLyric(netTrack.id);
    }
    return { lines: [], found: false };
  });
}

export function hasLyrics(result) {
  return Boolean(result && result.found && result.lines.length);
}

export default { getLyrics, hasLyrics };
