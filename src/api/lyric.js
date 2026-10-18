// Lyric auto-fill engine (mobile adapter around the shared v3 core).
//
// GENERATED FILE — do not hand-edit the core below.
//   source of truth : _engine_core.mjs        (workspace root)
//   regenerate      : node _build_engine.mjs  (rewrites this file + desktop)
//
// v3 = precision-first. v2 adopted any candidate >= 4.0 including 65%-LCS
// near-misses and never checked the performer, so some tracks showed another
// song's lyrics. v3 requires corroboration, refuses ambiguity, and validates
// the fetched lyric; when unsure it returns no lyrics at all.
import { AsyncStorage } from 'react-native';
import netease from './provider/netease';
import kuwo from './provider/kuwo';

// ------------------------------- shared core (generated) -------------------------------
const ENGINE_VERSION = 'v3';

function createLyricEngine(adapter) {
  // adapter = {
  //   search(keyword) -> Promise<[{id,name,artists:[string],duration:ms,album}]>
  //   lyric(songId)    -> Promise<{lyric,tlyric,romalrc}>
  //   cacheGet(trackId) -> Promise<entry|null>
  //   cacheSet(trackId, entry) -> void
  //   stamp(trackId, neteaseId, songName) -> void
  //   now() -> number            (optional)
  // }

  const ACCEPT = 5.0; // adoption line (v2 used 4.0)
  const AMBIGUITY_GAP = 1.0; // top1 must beat the best *different* title by this
  const STRONG_STOP = 1.2; // stop the variant cascade when this far above ACCEPT

  // ---------------------------------------------------------------- text norm
  function norm2(s) {
    return (s || '')
      .toLowerCase()
      .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/[^0-9a-z\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\u31f0-\u31ff\uac00-\ud7af\u3130-\u318f]/g, '');
  }

  const JUNK = new RegExp(
    [
      // latin tags need word boundaries: without them "ver" eats "Everywhere",
      // "cover" eats "discover", "live" eats "Alive"
      '\\bhi-?res\\b', '无损(?:音质|音乐|歌曲|版)?', '\\b[48]\\s*k\\b', '\\b\\d{3,4}\\s*p\\b', '\\d+\\s*帧', '\\b\\d+\\s*fps\\b',
      '高清|超清|蓝光|画质|修复|重制|翻录|压制',
      '\\bmv\\b|\\bvcd\\b|\\bpv\\b|ncop|nced|\\bop\\d*\\b|\\bed\\d*\\b|\\bbgm\\b|\\bmad\\b|\\bamv\\b|\\bmp3\\b|\\bflac\\b|\\bape\\b|\\bwav\\b',
      '主题曲|片头曲|片尾曲|片头|片尾|插曲|宣传曲|印象曲|剧场版|现场(?:版|版音源)?|完整版?|官方|\\bofficial(?:\\s*music)?\\s*video\\b',
      '\\blive\\b|翻唱|\\bcover\\b|自弹自唱|弹唱|清唱|重唱|串烧|\\bremix\\b',
      '字幕|双语|中英|中日|台词|注解',
      '歌词版?|动态歌词|歌词|翻译|听译|精校|熟肉|汉化|特效',
      '纯享|舞台|直拍|饭拍|歌切|舞见|踊ってみた|\\bkaraoke\\b|卡拉ok|伴奏|\\binst(?:rumental)?\\b|\\boff\\s*vocal\\b',
      '\\bfeat\\.?\\b|\\bft\\.?\\b', '\\bver\\.?\\b|\\bversion\\b',
      // work-type words are not part of a song name
      '港剧|日剧|韩剧|美剧|泰剧|电视剧|电影|动画|动漫|番剧|舞台剧|音乐剧|原声带?|\\bost\\b|游戏|手游|预告',
      '录音棚|百万豪装|大声听|修音|演唱会|合集|混剪|高燃|燃向|催泪|神曲|名场面|经典|怀旧|巅峰|开口跪|起鸡皮|单曲循环|收藏级|百听不厌|循环|洗脑|上头|无敌|轰炸|燃爆|顶级|天花板|百万级|现场感|氛围感|代入感|沉浸式|太好听了|绝对|珍藏|追忆|回忆杀|青春|岁月',
    ].join('|'),
    'gi'
  );

  const QUOTE_PAIRS = [['《', '》'], ['「', '」'], ['『', '』'], ['“', '”']];
  const PAREN_PAIRS = [['（', '）'], ['(', ')']];
  const BRACKET_PAIRS = [['【', '】'], ['[', ']']];
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function segments(raw, pairs, minLen, maxLen) {
    const out = [];
    for (let p = 0; p < pairs.length; p += 1) {
      const a = pairs[p][0];
      const b = pairs[p][1];
      const re = new RegExp(`${esc(a)}([^${esc(a)}${esc(b)}]{${minLen},${maxLen}})${esc(b)}`, 'g');
      let m;
      while ((m = re.exec(raw || ''))) out.push({ text: m[1], at: m.index });
    }
    return out.sort((x, y) => x.at - y.at);
  }
  // Prose punctuation disqualifies a quoted segment; ？！ are common inside
  // Japanese song titles and must stay allowed.
  const hasPunct = (s) => /[，。～~、；;：:…·]/.test(s);
  function stripJunk(s) {
    JUNK.lastIndex = 0;
    const out = (s || '').replace(JUNK, ' ');
    JUNK.lastIndex = 0;
    return out;
  }

  // ------------------------------------------------------------- artist hints
  // Words that may sit in the name slot without being a performer.
  const HINT_STOP = {};
  [
    '港剧', '日剧', '韩剧', '美剧', '泰剧', '电视剧', '电影', '动画', '动漫', '番剧', '剧场版', '舞台剧',
    '音乐剧', '游戏', '原声', '原声带', '主题曲', '片尾曲', '片头曲', '插曲', '宣传曲', '印象曲', '官方',
    '完整版', '现场', '翻唱', '合集', '精选', '歌单', '音乐', '歌曲', '高清', '无损', '纯音乐', '伴奏',
    '钢琴', '吉他', '小提琴', '八音盒', '经典', '怀旧', '高音质', '立体声', '环绕', '抖音', '快手',
    '哔哩哔哩', '字幕', '双语', '中英', '中日', '男声', '女声', '合唱', '童声', '翻自', '原唱', '无损音质',
    '收藏', '推荐', '必听', '神曲', '深夜', '电台', '播客', 'mv', 'pv', 'op', 'ed', 'ost', 'bgm', 'mad',
    'amv', 'mmd', 'live', 'cover', 'remix', 'dj', '8d', '自制', '翻唱版',
    // language / edition tags
    '粤语', '国语', '华语', '日语', '英语', '韩语', '闽南语', '台语', '现场版', '自製', '完整版', '试听',
    '母带', '高音', '超清', '中字', '日字', '英字', '繁中', '简中', '中文字幕', '原版', '官方版',
    'ep', 'sp', 'cm', '每日', '资讯', '频道', '搬运', '字幕组', '制作', '剪辑', '调音', '混音', '后期',
  ].forEach((x) => { HINT_STOP[norm2(x)] = 1; });

  // Only a name-like string may veto a candidate; "正式版" or "17岁" must not.
  function nameLike(n) {
    if (!n || n.length < 2 || n.length > 14) return false;
    if (/\d/.test(n)) return false;
    if (/(版|曲|集|辑|篇|季|话)$/.test(n)) return false;
    return true;
  }

  function artistHints(rawTitle, trackArtist, source) {
    const raw = (rawTitle || '').trim();
    const hints = [];
    const push = (value, weight) => {
      const n = norm2(value);
      if (n.length < 2 || n.length > 16) return;
      if (HINT_STOP[n]) return;
      // a hint that does not look like a name may only add a small bonus —
      // it must never veto a candidate ("17岁-刘德华", "官方正式版")
      const wgt = nameLike(n) ? weight : 0.4;
      for (let i = 0; i < hints.length; i += 1) if (hints[i].norm === n) return;
      hints.push({ value, norm: n, weight: wgt });
    };

    // 1) text right before a quoted song name:  杨千嬅《野孩子》
    let firstQuote = -1;
    for (let q = 0; q < QUOTE_PAIRS.length; q += 1) {
      const i = raw.indexOf(QUOTE_PAIRS[q][0]);
      if (i > 0 && (firstQuote === -1 || i < firstQuote)) firstQuote = i;
    }
    if (firstQuote > 0) {
      const pre = raw
        .slice(0, firstQuote)
        .replace(/[【\[（(〔<《「『“"][^】\]）)〕>》」』”"]*[】\]）)〕>》」』”"]/g, ' ');
      const toks = stripJunk(pre).trim().split(/\s+/).filter(Boolean);
      const tail = toks.length ? toks[toks.length - 1] : '';
      if (tail && norm2(tail).length >= 2 && norm2(tail).length <= 14) push(tail, 1);
      if (toks.length >= 2) {
        const two = toks.slice(-2).join('');
        if (norm2(two).length >= 2 && norm2(two).length <= 14) push(two, 0.4);
      }
    }

    // 2) "A - B": bilibili uses BOTH orders ("歌手 - 歌名", "歌名 - 歌手"), so
    //    neither side may veto a candidate; both are soft hints and queryVariants
    //    also tries the reversed order.
    const dash = raw.match(/^([^\s《》【】\[\]()（）「」『』“”]{1,14})\s*[-–—]\s*(.+)$/);
    if (dash && !/[《》「」]/.test(dash[1])) {
      const left = dash[1].trim();
      const right = dash[2].trim().split(/[（(【\[]/)[0].trim();
      if (norm2(left).length >= 2) push(left, 0.4);
      if (norm2(right).length >= 2) push(right, 0.4);
      hints.dash = { left, right };
    }

    // 3) 【歌手】 at the head of the title (only when it is not a quality tag)
    const head = raw.match(/^[【\[]([^】\]]{2,16})[】\]]/);
    if (head) {
      const cleaned = stripJunk(head[1]).trim();
      if (cleaned.length >= 2) push(cleaned, 0.4);
    }

    // 4) the track's own artist field (bilibili: uploader → low confidence;
    //    uploader names often carry tags like "每日MAD" that are not names)
    if (trackArtist) {
      const cleaned = stripJunk(String(trackArtist)).trim();
      if (cleaned.length >= 2) push(cleaned, source === 'bilibili' ? 0.4 : 1);
    }
    return hints;
  }

  // ------------------------------------------------------------ query variants
  function queryVariants(rawTitle, artist, hints) {
    const raw = (rawTitle || '').trim();
    if (!raw) return [];
    const variants = [];
    const hs = hints || artistHints(rawTitle, artist);

    // V1: first usable quote segment (song names are usually quoted on bilibili)
    const quos = segments(raw, QUOTE_PAIRS, 2, 40);
    for (let i = 0; i < quos.length; i += 1) {
      const t = quos[i].text.trim();
      if (!hasPunct(t) && stripJunk(t).trim() === t) {
        variants.push(t);
        break;
      }
    }

    // V2: strip brackets/parens/quotes and junk words
    let t = raw;
    const groups = [BRACKET_PAIRS, PAREN_PAIRS, QUOTE_PAIRS];
    for (let g = 0; g < groups.length; g += 1) {
      for (let i = 0; i < groups[g].length; i += 1) {
        t = t.split(groups[g][i][0]).join(' ').split(groups[g][i][1]).join(' ');
      }
    }
    t = stripJunk(t)
      .split(/[，。！？!?～~、；;]+/)
      .filter(Boolean)
      .join(' ');
    t = t.replace(/[\s\-—–/／|｜_·]+/g, ' ').replace(/[,,.。::'"()（）]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (norm2(t).length >= 2) variants.push(t);

    // V2b: cleaned title + high-confidence performer hint
    const strong = hs.filter((h) => h.weight >= 1).map((h) => h.value);
    if (t && strong.length && norm2(t).indexOf(norm2(strong[0])) === -1) {
      variants.push(`${t} ${strong[0]}`);
    }

    // V3: first two tokens of V2
    const toks = t.split(' ').filter((x) => norm2(x).length >= 2);
    if (toks.length > 2 && toks.slice(0, 2).join(' ') !== t) variants.push(toks.slice(0, 2).join(' '));

    // V3b: dash titles are order-ambiguous ("歌手 - 歌名" vs "歌名 - 歌手")
    if (hs.dash && hs.dash.left && hs.dash.right) {
      variants.push(`${hs.dash.right} ${hs.dash.left}`);
    }

    // V4: bracket texts that are not quality/tag junk
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

    // V5: legacy keyword (all brackets stripped + artist) as last resort
    const legacy = raw
      .replace(/【[^【】]*】|\[[^\[\]]*\]|（[^（）]*）|\([^()]*\)|《[^《》]*》|「[^「」]*」|『[^『』]*』/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (legacy.length >= 2) variants.push(artist ? `${legacy} ${artist}` : legacy);

    const seen = {};
    const out = [];
    for (let i = 0; i < variants.length; i += 1) {
      const v = variants[i].trim();
      const n = norm2(v);
      if (n.length < 2 || seen[n]) continue;
      seen[n] = 1;
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

  const VERSION_WORDS = /(live|ver(?:sion)?|inst(?:rumental)?|cover|伴奏|remix|piano|acoustic|demo|edition|tv|movie|feat|karaoke|纯音乐|钢琴|吉他|小提琴|八音盒|重制|remaster|翻自)/i;
  const INST_WORDS = /(伴奏|纯音乐|instrumental|off\s?vocal|karaoke|钢琴|piano|八音盒|music\s?box|吉他|guitar|小提琴|violin|铃声|rington|慢摇|舞曲|dj版|片段|剪辑)/i;

  // A remainder is "harmless" when the two names still denote the same song:
  // short, a version suffix, or the performer's name.
  function harmlessRest(rest, artistNorms) {
    if (!rest) return true;
    if (rest.length <= 2) return true;
    if (VERSION_WORDS.test(rest)) return true;
    // "妖精小姐的魔法邀约 Miss Elf's Magical Invitation" — a latin-only tail is
    // a translated title, not another song
    if (!/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(rest)) return true;
    for (let i = 0; i < artistNorms.length; i += 1) {
      if (artistNorms[i].length >= 2 && rest.indexOf(artistNorms[i]) !== -1) return true;
    }
    return false;
  }

  // Song names often carry a version tail that is not part of the identity:
  // "樱花树下(Live)" / "晴天 - Live" / "Lemon【MV版】". Comparing the bare names
  // as well keeps those candidates scoreable without loosening the rules.
  function baseName(name) {
    const s = String(name || '');
    let out = s.replace(/[（(【\[][^）)】\]]*[）)】\]]/g, ' ');
    out = out.replace(/\s*[-–—]\s*(live|remix|ver\.?|version|inst|instrumental|伴奏|karaoke|off\s?vocal|acoustic|piano|demo|tv\s*size|short).*$/i, '');
    out = out.replace(/\s+(live|remix|伴奏|instrumental|inst)$/i, '');
    // "妖精小姐的魔法邀约 Miss Elf's Magical Invitation" — a CJK title followed
    // by its latin translation is still one title
    out = out.replace(/^([\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af][^A-Za-z]*[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af])\s+[A-Za-z0-9].*$/, '$1');
    return out.trim() || s;
  }

  // Same song identity? Two names that contain each other ("风的季节" /
  // "Soler - 风的季节") or differ only in version tails are one song, not a
  // rival pair — the ambiguity guard must not fire on them.
  function sameIdentity(a, b) {
    const x = norm2(baseName(a));
    const y = norm2(baseName(b));
    if (!x || !y) return false;
    if (x === y) return true;
    if (x.length >= 3 && y.indexOf(x) !== -1) return true;
    if (y.length >= 3 && x.indexOf(y) !== -1) return true;
    return false;
  }

  // Title-only score of a candidate against one query variant.
  function titleScoreRaw(query, candName, artistNorms) {
    const w = norm2(query);
    const c = norm2(candName);
    if (!w || !c) return 0;
    if (w === c) return 6;
    if (w.indexOf(c) !== -1) {
      const rest = w.split(c).join('');
      if (harmlessRest(rest, artistNorms)) {
        let artistInRest = false;
        for (let i = 0; i < artistNorms.length; i += 1) {
          if (rest.indexOf(artistNorms[i]) !== -1) { artistInRest = true; break; }
        }
        return artistInRest ? 5.6 : 5.2;
      }
      return 2.9; // song name is a random phrase inside a long messy title
    }
    if (c.indexOf(w) !== -1) {
      // the song name is LONGER than the query: "手放开" must not adopt
      // "手放开的温柔" — only a short/version/artist tail is acceptable
      const rest = c.split(w).join('');
      return harmlessRest(rest, artistNorms) ? 5.3 : 2.7;
    }

    const toks = query.split(/[\s\-—–/／|｜_·,，、]+/).map(norm2).filter((x) => x.length >= 2);
    // one whole token equals the song name ("狐妖小红娘 梦回还"): decent
    // evidence, but only from 3 chars up — "Go"/"光" would match everything
    for (let i = 0; i < toks.length; i += 1) {
      if (toks[i] === c && c.length >= 3) return 5.2;
    }
    for (let i = 0; i < toks.length; i += 1) {
      if (toks[i].length >= 4 && c.indexOf(toks[i]) !== -1 && toks[i].length / c.length >= 0.75) return 4.2;
    }

    const r = lcs(w, c) / Math.max(w.length, c.length);
    if (r >= 0.86) return 4.4;
    if (r >= 0.72) return 3.5; // ranking only — never adopted
    return 0;
  }

  // Score with and without version tails; the better reading wins.
  // extraNorms: performer hints that may legitimately sit inside the leftovers.
  function titleScore(query, candName, candArtists, extraNorms) {
    const artistNorms = [];
    for (let i = 0; i < (candArtists || []).length; i += 1) {
      const n = norm2(candArtists[i]);
      if (n.length >= 2) artistNorms.push(n);
    }
    for (let i = 0; i < (extraNorms || []).length; i += 1) {
      if (extraNorms[i] && extraNorms[i].length >= 2) artistNorms.push(extraNorms[i]);
    }
    const raw = titleScoreRaw(query, candName, artistNorms);
    if (raw >= 6) return raw;
    const bq = baseName(query);
    const bc = baseName(candName);
    if (bq === query && bc === candName) return raw;
    const based = titleScoreRaw(bq, bc, artistNorms);
    return Math.max(raw, based);
  }

  // Full score: title + performer corroboration + version signals.
  // ctx = { rawTitle, artist, source, hints, duration, candDuration }
  function strongScore(query, candName, candArtists, ctx) {
    const hints = ctx.hints || [];
    const hintNorms = [];
    for (let i = 0; i < hints.length; i += 1) {
      // only names we actually trust may excuse leftovers in a candidate title
      if (hints[i].weight >= 1) hintNorms.push(hints[i].norm);
    }
    let score = titleScore(query, candName, candArtists, hintNorms);
    if (!score) return 0;

    const names = [];
    for (let i = 0; i < (candArtists || []).length; i += 1) {
      const n = norm2(candArtists[i]);
      if (n.length >= 2) names.push(n);
    }
    const rawNorm = norm2(ctx.rawTitle);
    let corroborated = false;

    let sawHigh = false;
    let matchedHigh = false;
    let matchedAny = false;
    for (let i = 0; i < hints.length; i += 1) {
      const h = hints[i];
      if (h.weight >= 1) sawHigh = true;
      let hit = false;
      for (let j = 0; j < names.length; j += 1) {
        if (names[j].indexOf(h.norm) !== -1 || h.norm.indexOf(names[j]) !== -1) { hit = true; break; }
      }
      // a candidate that carries the performer inside its own name counts too
      // ("Soler - 风的季节" re-uploaded under another artist)
      if (!hit && h.weight >= 1 && norm2(candName).indexOf(h.norm) !== -1) hit = true;
      if (hit) {
        matchedAny = true;
        if (h.weight >= 1) matchedHigh = true;
      }
    }

    // An exact title match outranks a performer mismatch: "拂晓" uploaded by a
    // cover singer is still 拂晓's lyrics. One bogus hint ("EP：", "迪迦奥特曼")
    // must not kill a correct match, so penalties are capped when titles agree.
    const qn = norm2(baseName(query));
    const cn = norm2(baseName(candName));
    const exactish = Boolean(qn) && qn === cn;

    let penalty = 0;
    if (matchedHigh) {
      score += 1.6;
      corroborated = true;
    } else if (matchedAny) {
      score += 0.6;
      corroborated = true;
    } else if (sawHigh) {
      penalty = 1.6; // a trusted performer hint exists and this is someone else
    }

    // the track's own artist field is trustworthy for non-bilibili sources
    if (!corroborated && ctx.source !== 'bilibili' && ctx.artist) {
      const ta = norm2(ctx.artist);
      if (ta.length >= 2) {
        let hit = false;
        for (let i = 0; i < names.length; i += 1) {
          if (names[i].indexOf(ta) !== -1 || ta.indexOf(names[i]) !== -1) { hit = true; break; }
        }
        if (hit) {
          score += 1.2;
          corroborated = true;
        } else if (penalty < 1.0) {
          penalty = 1.0;
        }
      }
    }
    // never stack penalties, and never let one veto an exact title match
    if (penalty > 0) score -= exactish ? Math.min(penalty, 0.4) : penalty;

    // the raw title mentions the candidate performer (weak evidence)
    if (!corroborated && rawNorm) {
      for (let i = 0; i < names.length; i += 1) {
        if (names[i].length >= 3 && rawNorm.indexOf(names[i]) !== -1) {
          score += 0.5;
          break;
        }
      }
    }

    // instrumental candidates rarely carry the vocal timeline we want
    const candInst = INST_WORDS.test(candName || '');
    const rawInst = INST_WORDS.test(ctx.rawTitle || '');
    if (candInst && !rawInst) score -= 0.8;
    // ...and an instrumental *upload* (【钢琴】晴天) has no vocals at all, so a
    // vocal lyric is wrong even when the title matches perfectly
    else if (rawInst && !candInst) score -= 1.2;

    // duration sanity when both sides are known
    const candDur = ctx.candDuration || 0;
    if (ctx.duration && candDur) {
      const diff = Math.abs(candDur - ctx.duration);
      if (diff > Math.max(120000, ctx.duration * 0.3)) score -= 1.5;
      else if (diff > Math.max(45000, ctx.duration * 0.15)) score -= 0.6;
    }

    // A one-character title (光 / 海 / 花) or a two-letter one matches almost any
    // song of that name by a different performer. Without a performer to back it
    // up there is no evidence at all, so it can never reach the adoption line.
    const core = norm2(baseName(candName));
    const tooShort = /^[\u4e00-\u9fff\u3040-\u30ff]$/.test(core) || /^[a-z]{1,2}$/.test(core);
    if (tooShort && !corroborated) score = Math.min(score, ACCEPT - 0.6);
    return score;
  }

  // ------------------------------------------------------------------ gates
  const hasTimestamp = (lrc) => /\[\d{1,3}:\d{2}/.test(lrc || '');

  function lyricOk(raw) {
    if (!raw || !hasTimestamp(raw.lyric)) return false;
    let timed = 0;
    const lines = raw.lyric.split('\n');
    for (let i = 0; i < lines.length; i += 1) if (/\[\d{1,3}:\d{2}/.test(lines[i])) timed += 1;
    if (timed < 3) return false;
    const text = raw.lyric.replace(/\[[^\]]*\]/g, '').replace(/\s+/g, '');
    if (text.length < 40) return false;
    if (timed < 8 && /纯音乐|请欣赏|暂无歌词|没有找到歌词|instrumental/i.test(text)) return false;
    return true;
  }

  function makeCtx(track) {
    return {
      rawTitle: track.title,
      artist: track.artist,
      source: track.source,
      duration: track.duration || 0,
      hints: artistHints(track.title, track.artist, track.source),
    };
  }

  function corroboratedByHighHint(ctx, artists) {
    for (let i = 0; i < ctx.hints.length; i += 1) {
      const h = ctx.hints[i];
      if (h.weight < 1) continue;
      for (let j = 0; j < (artists || []).length; j += 1) {
        const na = norm2(artists[j]);
        if (!na) continue;
        if (na.indexOf(h.norm) !== -1 || h.norm.indexOf(na) !== -1) return true;
      }
    }
    return false;
  }

  // Pick the winning candidate out of the scored pool, or null when the
  // evidence is not decisive. Returns { song, score, query } | null.
  function decide(pool, ctx) {
    const ranked = [];
    for (const k in pool) {
      if (!Object.prototype.hasOwnProperty.call(pool, k)) continue;
      if (pool[k].score >= ACCEPT) ranked.push(pool[k]);
    }
    ranked.sort((a, b) => b.score - a.score);
    if (!ranked.length) return null;
    const best = ranked[0];
    let rival = null;
    for (let i = 1; i < ranked.length; i += 1) {
      // versions of the same song ("X (Live)", "X (Remix)") are not rivals
      if (!sameIdentity(ranked[i].song.name, best.song.name)) { rival = ranked[i]; break; }
    }
    if (rival && best.score - rival.score < AMBIGUITY_GAP && !corroboratedByHighHint(ctx, best.song.artists)) {
      return null; // two different songs, no performer evidence → refuse
    }
    return best;
  }

  // ----------------------------------------------------------------- cascade
  // Resolve an arbitrary-source track to a netease song with usable lyrics.
  // Returns { neteaseId, songName, artist, score, query, lyric, tlyric, romalrc }
  // or null.
  function resolve(track) {
    if (!track || !track.title) return Promise.resolve(null);
    if (track.source === 'netease') {
      const num = String(track.id).replace('netrack_', '');
      return adapter.lyric(num).then((raw) => {
        if (!raw || !hasTimestamp(raw.lyric)) return null;
        return {
          neteaseId: num,
          songName: track.title,
          artist: track.artist || '',
          score: 9,
          query: track.title,
          lyric: raw.lyric,
          tlyric: raw.tlyric,
          rlrc: raw.romalrc,
          romalrc: raw.romalrc,
        };
      });
    }
    const ctx = makeCtx(track);
    const pool = {};
    const variants = queryVariants(track.title, track.artist, ctx.hints);

    const step = (vi) => {
      if (vi >= variants.length) return Promise.resolve();
      const q = variants[vi];
      return adapter.search(q).then((songs) => {
        const list = songs || [];
        for (let i = 0; i < Math.min(list.length, 20); i += 1) {
          const s = list[i];
          const sc = strongScore(q, s.name, s.artists, {
            rawTitle: ctx.rawTitle,
            artist: ctx.artist,
            source: ctx.source,
            duration: ctx.duration,
            candDuration: s.duration,
            hints: ctx.hints,
          });
          const prev = pool[s.id];
          if (!prev || sc > prev.score) pool[s.id] = { song: s, score: sc, query: q };
        }
        let max = 0;
        for (const k in pool) {
          if (Object.prototype.hasOwnProperty.call(pool, k) && pool[k].score > max) max = pool[k].score;
        }
        if (max >= ACCEPT + STRONG_STOP) return null; // confident enough
        return step(vi + 1);
      });
    };

    return step(0).then(() => {
      const best = decide(pool, ctx);
      if (!best) return null;
      // try the winner first, then the runner-up if it has no timed lyric
      const ranked = [];
      for (const k in pool) {
        if (Object.prototype.hasOwnProperty.call(pool, k) && pool[k].score >= ACCEPT) ranked.push(pool[k]);
      }
      ranked.sort((a, b) => b.score - a.score);
      const tries = [best];
      for (let i = 0; i < ranked.length && tries.length < 2; i += 1) {
        if (ranked[i].song.id !== best.song.id) tries.push(ranked[i]);
      }

      const attempt = (ti) => {
        if (ti >= tries.length) return null;
        const c = tries[ti];
        return adapter.lyric(c.song.id).then((raw) => {
          if (lyricOk(raw)) {
            if (adapter.stamp && c.song.name) adapter.stamp(track.id, String(c.song.id).replace('netrack_', ''), c.song.name);
            return {
              neteaseId: String(c.song.id).replace('netrack_', ''),
              songName: c.song.name,
              artist: (c.song.artists || []).join('/'),
              score: c.score,
              query: c.query,
              lyric: raw.lyric,
              tlyric: raw.tlyric,
              rlrc: raw.romalrc,
              romalrc: raw.romalrc,
            };
          }
          return attempt(ti + 1);
        });
      };
      return attempt(0);
    });
  }

  // Resolve + cache. Also stamps the resolved netease id + song name onto the
  // stored track so later loads can re-verify instead of trusting blindly.
  const inflight = {};
  function preload(track) {
    if (!track || !track.id) return Promise.resolve(null);
    if (inflight[track.id]) return inflight[track.id];
    inflight[track.id] = adapter
      .cacheGet(track.id)
      .then((cached) => {
        if (cached) return cached;
        return resolve(track).then((r) => {
          const entry = r || { miss: 1, at: Date.now() };
          adapter.cacheSet(track.id, entry);
          return entry;
        });
      })
      .catch(() => null)
      .then((r) => {
        delete inflight[track.id];
        return r;
      });
    return inflight[track.id];
  }

  // Batch backfill. Aborts (rejects {aborted:true}) after 8 consecutive misses:
  // that means the endpoints are blocked right now and grinding on would only
  // poison the negative cache.
  function fillPlaylist(tracks, onProgress, isCancelled) {
    const list = (tracks || []).slice();
    let done = 0;
    let matched = 0;
    let consecutiveMiss = 0;
    return new Promise((resolveOuter, rejectOuter) => {
      const step = (i) => {
        if (isCancelled && isCancelled()) return resolveOuter({ done, matched });
        if (i >= list.length) return resolveOuter({ done, matched });
        const t = list[i];
        return adapter
          .cacheGet(t.id)
          .then((cached) => {
            if (cached) {
              if (!cached.miss) {
                matched += 1;
                consecutiveMiss = 0;
              }
              done += 1;
              if (onProgress) onProgress(done, list.length, t.title);
              return step(i + 1);
            }
            return preload(t).then((entry) => {
              if (entry && !entry.miss) {
                matched += 1;
                consecutiveMiss = 0;
              } else {
                consecutiveMiss += 1;
              }
              done += 1;
              if (onProgress) onProgress(done, list.length, t.title);
              if (consecutiveMiss >= 8) return rejectOuter({ aborted: true, done, matched });
              return step(i + 1);
            });
          })
          .catch(() => {
            done += 1;
            consecutiveMiss += 1;
            if (onProgress) onProgress(done, list.length, t.title);
            if (consecutiveMiss >= 8) return rejectOuter({ aborted: true, done, matched });
            return step(i + 1);
          });
      };
      step(0);
    });
  }

  // Same song on another provider (kuwo) for playable-source fallback.
  // altSearch(query) -> Promise<[{id,name|title,artists|artist,duration}]>
  function findAlternative(track, altSearch) {
    if (!track || !track.title) return Promise.resolve(null);
    const ctx = makeCtx(track);
    const variants = queryVariants(track.title, track.artist, ctx.hints).slice(0, 4);
    const step = (vi) => {
      if (vi >= variants.length) return Promise.resolve(null);
      return altSearch(variants[vi])
        .then((songs) => {
          const list = songs || [];
          const scored = [];
          for (let i = 0; i < list.length; i += 1) {
            const s = list[i];
            const name = s.name || s.title;
            const artists = s.artists || (s.artist ? [s.artist] : []);
            const sc = strongScore(variants[vi], name, artists, {
              rawTitle: ctx.rawTitle,
              artist: ctx.artist,
              source: ctx.source,
              duration: ctx.duration,
              candDuration: s.duration,
              hints: ctx.hints,
            });
            if (sc >= ACCEPT) scored.push({ song: s, score: sc });
          }
          scored.sort((a, b) => b.score - a.score);
          if (scored.length) {
            const best = scored[0];
            const bestName = best.song.name || best.song.title;
            let rival = null;
            for (let i = 1; i < scored.length; i += 1) {
              const nm = scored[i].song.name || scored[i].song.title;
              if (!sameIdentity(nm, bestName)) { rival = scored[i]; break; }
            }
            const arts = best.song.artists || (best.song.artist ? [best.song.artist] : []);
            if (!rival || best.score - rival.score >= AMBIGUITY_GAP || corroboratedByHighHint(ctx, arts)) {
              return best.song;
            }
          }
          return step(vi + 1);
        })
        .catch(() => (vi + 1 < variants.length ? step(vi + 1) : null));
    };
    return step(0);
  }

  return {
    ENGINE_VERSION,
    ACCEPT,
    norm2,
    baseName,
    sameIdentity,
    artistHints,
    queryVariants,
    titleScore,
    strongScore,
    lyricOk,
    hasTimestamp,
    decide,
    resolve,
    preload,
    fillPlaylist,
    findAlternative,
  };
}
// ------------------------------ end of shared core ------------------------------

// -------------------------------------------------------------------- cache
// lyric_cache_v4_<trackId> -> { neteaseId, songName, lyric, tlyric, romalrc }
// or { miss: 1, at } (negative; retried after 24h so a temporarily blocked
// network never poisons the cache permanently).
// v4: scorer + stamp schema changed (older entries may point at wrong songs).
const CACHE_PREFIX = 'lyric_cache_v4_';
const MISS_TTL = 24 * 60 * 60 * 1000;

function readCache(trackId) {
  if (!trackId) return Promise.resolve(null);
  return AsyncStorage.getItem(CACHE_PREFIX + trackId)
    .then((s) => {
      if (!s) return null;
      const entry = JSON.parse(s);
      if (entry && entry.miss && Date.now() - (entry.at || 0) > MISS_TTL) return null;
      return entry;
    })
    .catch(() => null);
}

function writeCache(trackId, entry) {
  if (!trackId) return;
  AsyncStorage.setItem(CACHE_PREFIX + trackId, JSON.stringify(entry)).catch(() => undefined);
}

const engine = createLyricEngine({
  search: (keyword) => netease.searchSongsRaw(keyword).then((list) => list || []),
  lyric: (songId) => netease.getLyricRaw(songId),
  cacheGet: readCache,
  cacheSet: writeCache,
  // mobile persists the resolved id through redux (attachTrackLyric) instead
  stamp: () => undefined,
});

// Does a (persisted) matched song name still describe this track? Used to
// re-verify netease ids stamped by older versions before trusting them.
export function nameMatchesTrack(track, name) {
  if (!track || !track.title || !name) return false;
  const variants = engine.queryVariants(track.title, track.artist);
  for (let i = 0; i < variants.length; i += 1) {
    if (engine.titleScore(variants[i], name, []) >= engine.ACCEPT) return true;
  }
  return false;
}

function toResult(entry) {
  if (!entry || entry.miss) return { lines: [], found: false };
  return netease.parseLyricTexts(entry);
}

// Unified access point for a track: returns { lines, found }.
// 1. per-track cache → 2. netease source direct → 3. matcher engine + cache.
export function getLyrics(track) {
  if (!track || !track.title) return Promise.resolve({ lines: [], found: false });
  if (track.source === 'netease') return netease.getLyric(track).then((r) => r);

  return readCache(track.id).then((cached) => {
    if (cached) return toResult(cached);
    // fast path: a netease id stamped earlier — only trusted when the matched
    // song name was stored too and still matches (an id alone may be wrong)
    if (track.neteaseId && track.lyricMatchName && nameMatchesTrack(track, track.lyricMatchName)) {
      return netease.getLyricRaw(track.neteaseId).then((raw) => {
        if (raw && engine.lyricOk(raw)) {
          const entry = {
            neteaseId: String(track.neteaseId),
            songName: track.lyricMatchName,
            lyric: raw.lyric,
            tlyric: raw.tlyric,
            romalrc: raw.romalrc,
            at: Date.now(),
          };
          writeCache(track.id, entry);
          return toResult(entry);
        }
        return preloadLyric(track).then(toResult);
      });
    }
    return preloadLyric(track).then(toResult);
  });
}

export function hasLyrics(result) {
  return Boolean(result && result.found && result.lines.length);
}

export function queryVariants(rawTitle, artist) {
  return engine.queryVariants(rawTitle, artist);
}

export function strongScore(query, name, artists, ctx) {
  return engine.strongScore(query, name, artists, ctx || {});
}

export function resolveLyric(track) {
  return engine.resolve(track);
}

export function preloadLyric(track) {
  return engine.preload(track);
}

// Resolve the netease id for a track (persisted onto the playlist track).
export function resolveNeteaseId(track) {
  return engine.preload(track).then((entry) => (entry && !entry.miss ? entry.neteaseId : null));
}

// Resolve the full match (id + matched song name) for add-to-playlist time.
export function resolveMatch(track) {
  return engine.preload(track).then((entry) => {
    if (!entry || entry.miss) return null;
    return { neteaseId: entry.neteaseId, songName: entry.songName || '' };
  });
}

// Find the same song on kuwo (playable fallback when the source has no url).
export function findAlternativeSource(track) {
  return engine.findAlternative(track, (keyword) =>
    kuwo
      .search(keyword, 1)
      .then((res) => (res && res.result) || [])
      .catch(() => [])
  );
}

// Batch backfill. onProgress(done, total, title); cancelled() -> true.
// Rejects { aborted: true } after 8 consecutive misses (endpoint is blocked).
export function fillPlaylistLyrics(tracks, onProgress, cancelled) {
  return engine.fillPlaylist(tracks, onProgress, cancelled);
}

export default {
  getLyrics,
  hasLyrics,
  queryVariants,
  strongScore,
  resolveLyric,
  preloadLyric,
  resolveNeteaseId,
  resolveMatch,
  findAlternativeSource,
  fillPlaylistLyrics,
  nameMatchesTrack,
};
