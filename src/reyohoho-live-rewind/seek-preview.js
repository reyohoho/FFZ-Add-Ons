// Based on TwitchRewind (https://github.com/Alban1911/TwitchRewind), MIT License, Copyright (c) 2026 Alban1911
//
// Seekbar previews: Twitch only publishes storyboards once a stream has ended, so previews are decoded on the fly
// from the VOD's own keyframes. Twitch streams have one every 2 s and a keyframe's byte position inside a segment is
// roughly proportional to its time, so each spot of the bar maps to its nearest keyframe (an "anchor") and range
// requests fetch just that frame. It's cut out of the MPEG-TS or fMP4 container and decoded with WebCodecs.

/* global VideoDecoder, EncodedVideoChunk */
/* eslint-disable no-await-in-loop -- reads are sequential on purpose: each one decides where the next one aims */

export const PREVIEW_W = 160;
export const PREVIEW_H = 90;

const FETCH_TIMEOUT = 10000;
const PREVIEW_DEBOUNCE = 100;
const PREVIEW_CACHE_MAX = 200;
const PREVIEW_RETRY = 60000;
const PREVIEW_PLAYLIST_TTL = 15000;
const PREVIEW_READ_STEPS = [64, 256, 1024, 4096].map((kb) => kb * 1024);
const KEYFRAME_INTERVAL = 2;
const PTS_WRAP = 2 ** 33;

function fetchWithTimeout(url, opts = {}) {
  return fetch(url, {...opts, signal: AbortSignal.timeout?.(FETCH_TIMEOUT)});
}

function parseMediaPlaylist(text, url) {
  const segments = [];
  let t = 0;
  let duration = 0;
  let init = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#EXTINF:')) {
      duration = parseFloat(line.slice(8));
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const m = line.match(/URI="([^"]+)"/);
      if (m) init = new URL(m[1], url).href;
    } else if (line && !line.startsWith('#')) {
      // DMCA-muted parts are listed as -unmuted but served as -muted (see vod-unlock.js)
      segments.push({start: t, url: new URL(line.replace(/-unmuted/g, '-muted'), url).href});
      t += duration;
    }
  }
  return {segments, end: t, init};
}

// Media playlists to try, smallest H.264 rendition first: the master's variants (usher or our synthetic one),
// or the playlist itself when it already is a media playlist
async function previewPlaylistCandidates(vodUrl) {
  const res = await fetchWithTimeout(vodUrl);
  if (!res.ok) throw new Error(`master playlist HTTP ${res.status}`);
  const lines = (await res.text()).split('\n');
  const variants = [];
  lines.forEach((line, i) => {
    const resolution = line.startsWith('#EXT-X-STREAM-INF:') && line.match(/RESOLUTION=\d+x(\d+)/); // skips audio_only
    const uri = (lines[i + 1] || '').trim();
    if (resolution && uri && !uri.startsWith('#')) {
      variants.push({avc: /avc1/.test(line) ? 0 : 1, height: +resolution[1], url: new URL(uri, vodUrl).href});
    }
  });
  if (!variants.length) return [vodUrl];
  return variants.sort((a, b) => a.avc - b.avc || a.height - b.height).map((v) => v.url);
}

// Reads `url` from byte `from` in growing ranges until `parse` finds what it's after (null while it needs more bytes),
// then stops the download. Null if the file ends first. `openEnded`: one request to the end of the file, whose
// Content-Length reveals the file size (Twitch's CDN blocks HEAD and hides Content-Range from cross-origin pages)
async function readRange(url, from, parse, openEnded = false) {
  let buf = new Uint8Array(0);
  for (const length of openEnded ? [Infinity] : PREVIEW_READ_STEPS) {
    const range = `bytes=${from + buf.length}-${openEnded ? '' : from + length - 1}`;
    const res = await fetchWithTimeout(url, {headers: {Range: range}});
    if (res.status === 416) break;
    if (res.status !== 206 && !(res.status === 200 && from === 0)) throw new Error(`segment HTTP ${res.status}`);
    if (res.status === 200) buf = new Uint8Array(0); // range ignored: this is the whole segment
    const size = (res.status === 206 ? from + buf.length : 0) + Number(res.headers.get('content-length'));
    const reader = res.body.getReader();
    for (;;) {
      const {done, value} = await reader.read();
      if (value) {
        const grown = new Uint8Array(buf.length + value.length);
        grown.set(buf);
        grown.set(value, buf.length);
        buf = grown;
        const found = parse(buf);
        if (found) {
          reader.cancel().catch(() => {});
          if (found.error) throw new Error(found.error);
          if (openEnded) found.size = size;
          return found;
        }
      }
      if (done) break;
    }
    if (res.status === 200) break;
  }
  return null;
}

async function decodeKeyframe(keyframe) {
  const config = {codec: keyframe.codec, optimizeForLatency: true};
  if (keyframe.description) config.description = keyframe.description;
  if (!(await VideoDecoder.isConfigSupported(config)).supported) throw new Error(`can't decode ${keyframe.codec}`);
  const canvas = document.createElement('canvas');
  canvas.width = PREVIEW_W;
  canvas.height = PREVIEW_H;
  let drawn = false;
  let failure = null;
  const decoder = new VideoDecoder({
    output: (frame) => {
      canvas.getContext('2d').drawImage(frame, 0, 0, PREVIEW_W, PREVIEW_H);
      frame.close();
      drawn = true;
    },
    error: (error) => {
      failure = error;
    },
  });
  try {
    decoder.configure(config);
    decoder.decode(new EncodedVideoChunk({type: 'key', timestamp: 0, data: keyframe.data}));
    await decoder.flush();
  } catch (error) {
    failure = failure || error;
  } finally {
    if (decoder.state !== 'closed') decoder.close();
  }
  if (!drawn) throw failure || new Error('no frame decoded');
  return canvas;
}

// Keyframe extraction. Parsers return null while they need more bytes, {error} when the data can't be used, else
// {codec, description?, data, ticks, rate, byte} for WebCodecs (ticks / rate = timestamp in seconds, byte = where it
// starts in `b`). `aim(ticks, key, first)`, if given, judges each frame (see findAnchorKeyframe): 'take' a keyframe,
// 'skip' a frame, or stop there with {miss: 'early' | 'past' | 'missing', ticks, byte}.

const hexByte = (x) => x.toString(16).padStart(2, '0');
const readU32 = (b, p) => b[p] * 0x1000000 + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3];
const readPts = (b, p) =>
  ((b[p] >> 1) & 7) * 2 ** 30 + b[p + 1] * 2 ** 22 + (b[p + 2] >> 1) * 2 ** 15 + b[p + 3] * 2 ** 7 + (b[p + 4] >> 1);

// H.264 access unit (Annex B): {codec} if it's a keyframe (IDR), null if it isn't. SPS/PPS precede every IDR on Twitch
function avcKeyframe(es) {
  let codec = null;
  for (let i = 0; i + 6 < es.length; i++) {
    if (es[i] !== 0 || es[i + 1] !== 0 || es[i + 2] !== 1) continue;
    const type = es[i + 3] & 0x1f;
    if (type === 7 && !codec) codec = `avc1.${hexByte(es[i + 4])}${hexByte(es[i + 5])}${hexByte(es[i + 6])}`;
    if (type === 1) return null;
    if (type === 5) return codec ? {codec} : {error: 'keyframe without SPS'};
  }
  return null;
}

// MPEG-TS: the first IDR access unit of the video pid in `b`, which starts on a 188-byte packet boundary. Without a pid
// (start of segment 0), PAT/PMT tell which pid is the H.264 video and the first video timestamp is returned right away
function tsKeyframe(b, pid, aim) {
  let pmtPid = -1;
  let videoPid = pid == null ? -1 : pid;
  let parts = null;
  let size = 0;
  let ticks = 0;
  let unitByte = 0;
  let first = true;
  for (let off = 0; off + 188 <= b.length; off += 188) {
    if (b[off] !== 0x47) return {error: 'not an MPEG-TS segment'};
    const unitStart = b[off + 1] & 0x40;
    const packetPid = ((b[off + 1] & 0x1f) << 8) | b[off + 2];
    const adaptation = (b[off + 3] >> 4) & 3;
    if (!(adaptation & 1)) continue;
    let p = off + 4 + (adaptation === 3 ? 1 + b[off + 4] : 0);
    const end = off + 188;
    if (p >= end) continue;
    if (videoPid < 0) {
      if (packetPid === 0 && unitStart) {
        p += 1 + b[p];
        const sectionEnd = p + 3 + (((b[p + 1] & 0x0f) << 8) | b[p + 2]) - 4;
        for (let q = p + 8; q + 4 <= sectionEnd; q += 4) {
          if (((b[q] << 8) | b[q + 1]) !== 0) {
            pmtPid = ((b[q + 2] & 0x1f) << 8) | b[q + 3];
            break;
          }
        }
      } else if (packetPid === pmtPid && unitStart) {
        p += 1 + b[p];
        const sectionEnd = p + 3 + (((b[p + 1] & 0x0f) << 8) | b[p + 2]) - 4;
        for (
          let q = p + 12 + (((b[p + 10] & 0x0f) << 8) | b[p + 11]);
          q + 5 <= sectionEnd;
          q += 5 + (((b[q + 3] & 0x0f) << 8) | b[q + 4])
        ) {
          if (b[q] === 0x1b) {
            videoPid = ((b[q + 1] & 0x1f) << 8) | b[q + 2];
            break;
          }
        }
        if (videoPid < 0) return {error: 'no H.264 video in segment'};
      }
      continue;
    }
    if (packetPid !== videoPid) continue;
    if (unitStart) {
      // A PES starts: the previous one is a complete access unit
      const pesTicks = b[p + 7] & 0x80 ? readPts(b, p + 9) : 0;
      if (pid == null) return {videoPid, ticks: pesTicks, rate: 90000};
      if (parts) {
        const unit = new Uint8Array(size);
        let o = 0;
        for (const part of parts) {
          unit.set(part, o);
          o += part.length;
        }
        const es = unit.subarray(9 + unit[8]);
        const kf = avcKeyframe(es);
        if (kf?.error) return kf;
        let verdict = 'skip';
        if (aim) verdict = aim(ticks, !!kf, first);
        else if (kf) verdict = 'take';
        if (verdict === 'take') return {codec: kf.codec, data: es.slice(), ticks, rate: 90000, byte: unitByte};
        if (verdict !== 'skip') return {miss: verdict, ticks, byte: unitByte};
        first = false;
      }
      parts = [];
      size = 0;
      ticks = pesTicks;
      unitByte = off;
    }
    if (parts) {
      parts.push(b.subarray(p, end));
      size += end - p;
    }
  }
  return null;
}

function mp4Boxes(b, start, end) {
  const list = [];
  for (let p = start; p + 8 <= end; ) {
    let size = readU32(b, p);
    let header = 8;
    const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    if (size === 1) {
      size = readU32(b, p + 8) * 0x100000000 + readU32(b, p + 12);
      header = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < header) break;
    list.push({type, start: p, body: p + header, end: p + size});
    p += size;
  }
  return list;
}

const mp4Child = (b, box, type) =>
  box && mp4Boxes(b, box.body, Math.min(box.end, b.length)).find((x) => x.type === type);

// fMP4 init segment: video track id, timescale and avcC decoder configuration
function mp4Init(b) {
  const moov = mp4Boxes(b, 0, b.length).find((x) => x.type === 'moov');
  if (!moov || moov.end > b.length) return {error: 'incomplete init segment'};
  for (const trak of mp4Boxes(b, moov.body, moov.end).filter((x) => x.type === 'trak')) {
    const mdia = mp4Child(b, trak, 'mdia');
    const hdlr = mp4Child(b, mdia, 'hdlr');
    if (!hdlr || String.fromCharCode(...b.subarray(hdlr.body + 8, hdlr.body + 12)) !== 'vide') continue;
    const tkhd = mp4Child(b, trak, 'tkhd');
    const mdhd = mp4Child(b, mdia, 'mdhd');
    const stsd = mp4Child(b, mp4Child(b, mp4Child(b, mdia, 'minf'), 'stbl'), 'stsd');
    const entry = stsd && mp4Boxes(b, stsd.body + 8, stsd.end)[0];
    if (!tkhd || !mdhd || !entry || !/^avc[13]$/.test(entry.type)) {
      return {error: `unsupported codec ${entry ? entry.type : '?'}`};
    }
    // avcC follows the 78-byte VisualSampleEntry
    const avcC = mp4Boxes(b, entry.body + 78, entry.end).find((x) => x.type === 'avcC');
    if (!avcC) return {error: 'no avcC'};
    const description = b.slice(avcC.body, avcC.end);
    return {
      trackId: readU32(b, tkhd.body + (b[tkhd.body] === 1 ? 20 : 12)),
      timescale: readU32(b, mdhd.body + (b[mdhd.body] === 1 ? 20 : 12)),
      codec: `avc1.${hexByte(description[1])}${hexByte(description[2])}${hexByte(description[3])}`,
      description,
    };
  }
  return {error: 'no video track'};
}

// Start of the first 'moof' box: its fourcc, then an 'mfhd' child
function mp4FindMoof(b) {
  for (let i = 4; i + 12 <= b.length; i++) {
    if (
      b[i] === 0x6d &&
      b[i + 1] === 0x6f &&
      b[i + 2] === 0x6f &&
      b[i + 3] === 0x66 &&
      b[i + 8] === 0x6d &&
      b[i + 9] === 0x66 &&
      b[i + 10] === 0x68 &&
      b[i + 11] === 0x64
    ) {
      return i - 4;
    }
  }
  return -1;
}

// First video sample of a fragment: byte position, size, keyframe flag, decode time
function mp4VideoFragment(b, moof, init) {
  for (const traf of mp4Boxes(b, moof.body, moof.end).filter((x) => x.type === 'traf')) {
    const tfhd = mp4Child(b, traf, 'tfhd');
    if (!tfhd || readU32(b, tfhd.body + 4) !== init.trackId) continue;
    const tfFlags = readU32(b, tfhd.body) & 0xffffff;
    let q = tfhd.body + 8;
    let base = moof.start;
    if (tfFlags & 0x1) {
      base = readU32(b, q) * 0x100000000 + readU32(b, q + 4);
      q += 8;
    }
    if (tfFlags & 0x2) q += 4;
    if (tfFlags & 0x8) q += 4;
    let defaultSize = 0;
    let flags = 0;
    if (tfFlags & 0x10) {
      defaultSize = readU32(b, q);
      q += 4;
    }
    if (tfFlags & 0x20) flags = readU32(b, q);
    const tfdt = mp4Child(b, traf, 'tfdt');
    let dts = 0;
    if (tfdt) {
      dts =
        b[tfdt.body] === 1
          ? readU32(b, tfdt.body + 4) * 0x100000000 + readU32(b, tfdt.body + 8)
          : readU32(b, tfdt.body + 4);
    }
    const trun = mp4Child(b, traf, 'trun');
    if (!trun) return null;
    const trFlags = readU32(b, trun.body) & 0xffffff;
    let r = trun.body + 8;
    let dataOffset = 0;
    if (trFlags & 0x1) {
      dataOffset = readU32(b, r) | 0;
      r += 4;
    }
    if (trFlags & 0x4) {
      flags = readU32(b, r);
      r += 4;
    }
    if (trFlags & 0x100) r += 4;
    const size = trFlags & 0x200 ? readU32(b, r) : defaultSize;
    if (trFlags & 0x200) r += 4;
    if (trFlags & 0x400) flags = readU32(b, r);
    return {sync: !(flags & 0x10000), pos: base + dataOffset, size, dts};
  }
  return null;
}

// fMP4 segments are many small fragments (moof + mdat); keyframes start a fragment. Returns the first fragment in `b`
// whose video starts with a keyframe. `atBox`: `b` begins on a box boundary, otherwise the first 'moof' is looked for
function mp4Keyframe(b, init, atBox, aim) {
  const from = atBox ? 0 : mp4FindMoof(b);
  if (from < 0) return null;
  let first = true;
  for (const box of mp4Boxes(b, from, b.length)) {
    if (box.type !== 'moof') continue;
    if (box.end > b.length) return null;
    const frag = mp4VideoFragment(b, box, init);
    if (!frag) continue;
    let verdict = 'skip';
    if (aim) verdict = aim(frag.dts, frag.sync, first);
    else if (frag.sync) verdict = 'take';
    if (verdict === 'take') {
      if (frag.pos + frag.size > b.length) return null;
      return {
        codec: init.codec,
        description: init.description,
        data: b.slice(frag.pos, frag.pos + frag.size),
        ticks: frag.dts,
        rate: init.timescale,
        byte: box.start,
      };
    }
    if (verdict !== 'skip') return {miss: verdict, ticks: frag.dts, byte: box.start};
    first = false;
  }
  return null;
}

export default class SeekPreview {
  constructor({log, getVodUrl, getSeekbar, formatTime}) {
    this.log = log;
    this.getVodUrl = getVodUrl;
    this.getSeekbar = getSeekbar;
    this.formatTime = formatTime;
    this.gen = 0; // bumped by reset() so stale async work bails out
    this.source = null;
    this.retryAt = 0;
    this.loading = false;
    this.cache = new Map();
    this.wantTime = 0;
    this.debounce = 0;
  }

  reset() {
    this.gen++;
    clearTimeout(this.debounce);
    this.source = null;
    this.retryAt = 0;
    this.loading = false;
    this.cache.clear();
  }

  available() {
    return !!this.getVodUrl() && Date.now() >= this.retryAt && typeof VideoDecoder === 'function';
  }

  // At least one frame decoded for this VOD: seeks snap to anchors
  working() {
    return !!this.source && this.cache.size > 0 && this.available();
  }

  segmentAt(sec) {
    const segs = this.source.segments;
    let lo = 0;
    let hi = segs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segs[mid].start <= sec) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  // The recording grew past the playlist since it was read: anchorAt() would clamp to the old last keyframe
  beyondPlaylist(sec) {
    const src = this.source;
    return !!src && sec >= src.end && Date.now() - src.fetchedAt > PREVIEW_PLAYLIST_TTL;
  }

  // Keyframe nearest to `sec` (k-th of its segment on the 2 s grid, or the segment start on a stream without that grid).
  // `time` is the frame's own timestamp once decoded, the grid estimate before
  anchorAt(sec) {
    const {segments, end, gridless} = this.source;
    const segEnd = (i) => (i + 1 < segments.length ? segments[i + 1].start : end);
    let index = this.segmentAt(sec);
    const duration = Math.max(segEnd(index) - segments[index].start, 0.001);
    // 29.97/59.94 fps streams have 2.002 s between keyframes, so a 10.01 s segment holds 5
    const step = gridless ? duration : KEYFRAME_INTERVAL;
    const count = gridless ? 1 : Math.max(1, Math.ceil(duration / KEYFRAME_INTERVAL - 0.05));
    let k = Math.max(0, Math.round((sec - segments[index].start) / step));
    if (k >= count) {
      if (index + 1 < segments.length) {
        index++;
        k = 0;
      } else {
        k = count - 1;
      }
    }
    const start = segments[index].start;
    const key = `${index}:${k}`;
    const cached = this.cache.get(key);
    return {key, index, k, start, time: cached ? cached.time : start + k * KEYFRAME_INTERVAL};
  }

  // Seekbar time -> where playback should start: the keyframe the tooltip shows once previews work, else the exact time
  seekTarget(sec) {
    return this.working() && !this.beyondPlaylist(sec) ? this.anchorAt(sec).time : sec;
  }

  // Pointer over the seekbar at `sec`: show the cached frame right away, fetch it once the pointer rests there
  show(sec) {
    const ui = this.getSeekbar();
    clearTimeout(this.debounce);
    const on = this.available();
    ui.tooltip.classList.toggle('rte-lr-seekbar-tooltip--preview', on);
    if (!on) return;
    this.wantTime = sec;
    const frame = this.source && !this.beyondPlaylist(sec) && this.cache.get(this.anchorAt(sec).key);
    if (frame) {
      this.draw(frame);
    } else {
      ui.tooltip.classList.add('rte-lr-seekbar-tooltip--loading');
      this.debounce = setTimeout(() => this.fetchFrame(), PREVIEW_DEBOUNCE);
    }
  }

  draw(frame) {
    const ui = this.getSeekbar();
    if (!ui) return;
    ui.preview.getContext('2d').drawImage(frame.canvas, 0, 0, PREVIEW_W, PREVIEW_H);
    ui.time.textContent = this.formatTime(frame.time);
    ui.tooltip.classList.remove('rte-lr-seekbar-tooltip--loading');
  }

  // One fetch at a time; when it lands, chase wherever the pointer is now
  async fetchFrame() {
    if (this.loading || !this.available()) return;
    const gen = this.gen;
    const sec = this.wantTime;
    this.loading = true;
    try {
      const src = this.source;
      if (!src || this.beyondPlaylist(sec)) {
        const source = src ? await this.refreshSource(src) : await this.loadSource(this.getVodUrl());
        if (gen !== this.gen) return;
        this.source = source;
      }
      const anchor = this.anchorAt(sec);
      if (!this.cache.has(anchor.key)) {
        const frame = await this.grabAnchor(anchor);
        if (gen !== this.gen) return;
        this.cache.set(anchor.key, frame);
        if (this.cache.size > PREVIEW_CACHE_MAX) this.cache.delete(this.cache.keys().next().value);
      }
    } catch (error) {
      if (gen !== this.gen) return;
      this.log('Seekbar previews unavailable for now:', error?.message || error);
      this.retryAt = Date.now() + PREVIEW_RETRY;
      return;
    } finally {
      if (gen === this.gen) this.loading = false;
    }
    // Past a stale playlist fetch again rather than draw the cached last frame, but not for the spot just fetched,
    // so a fetch slower than the TTL can't loop
    const want = this.wantTime;
    const frame = (want === sec || !this.beyondPlaylist(want)) && this.cache.get(this.anchorAt(want).key);
    if (frame) this.draw(frame);
    else this.fetchFrame();
  }

  // Rendition used for previews: the smallest H.264 one, falling back to larger ones
  async loadSource(vodUrl) {
    for (const url of await previewPlaylistCandidates(vodUrl)) {
      const res = await fetchWithTimeout(url);
      if (!res.ok) continue;
      const source = parseMediaPlaylist(await res.text(), url);
      if (!source.segments.length) continue;
      if (source.init) {
        const initRes = await fetchWithTimeout(source.init);
        const init = initRes.ok && mp4Init(new Uint8Array(await initRes.arrayBuffer()));
        if (!init || init.error) continue; // e.g. an HEVC rendition
        source.init = init;
      }
      // Time origin: timestamp of the VOD's first frame. Segment 0's size gives the rendition's byte rate, used to aim
      // at keyframes inside segments (segment sizes vary by only a few %)
      const first = await readRange(
        source.segments[0].url,
        0,
        source.init ? (b) => mp4Keyframe(b, source.init, true) : (b) => tsKeyframe(b, null),
        true
      );
      if (!first) continue;
      const firstDuration = source.segments.length > 1 ? source.segments[1].start : source.end;
      source.url = url;
      source.videoPid = first.videoPid;
      source.origin = first.ticks;
      source.byteRate = first.size > 0 && firstDuration > 0 ? first.size / firstDuration : null;
      source.gridless = !source.byteRate;
      source.fetchedAt = Date.now();
      return source;
    }
    throw new Error('no usable rendition');
  }

  // Segment indexes don't change as the recording grows, so cached frames stay valid
  async refreshSource(src) {
    const res = await fetchWithTimeout(src.url);
    if (!res.ok) throw new Error(`playlist HTTP ${res.status}`);
    const {segments, end} = parseMediaPlaylist(await res.text(), src.url);
    return {...src, segments, end, fetchedAt: Date.now()};
  }

  async grabAnchor(anchor) {
    const {keyframe, time} = await this.findAnchorKeyframe(anchor);
    return {canvas: await decodeKeyframe(keyframe), time};
  }

  // Fetches the keyframe of `anchor` -> {keyframe, time (s into the VOD)}
  async findAnchorKeyframe(anchor) {
    const src = this.source;
    const url = src.segments[anchor.index].url;
    const timescale = src.init ? src.init.timescale : 90000;
    const secondsOf = (ticks) => {
      const delta = ticks - src.origin;
      return (src.init ? delta : ((delta % PTS_WRAP) + PTS_WRAP) % PTS_WRAP) / timescale;
    };
    const target = anchor.start + anchor.k * KEYFRAME_INTERVAL;
    if (anchor.k > 0 && src.byteRate) {
      // Jump close to the keyframe instead of reading the segment from its start: its byte position is ~byte rate x
      // its time into the segment, corrected by a learned per-rendition ratio (`layout`). GOPs are closed, so the first
      // frame read tells where we landed: a little early, read on; far too early or past it, aim again
      let judged = false;
      const aim = (ticks, key, first) => {
        judged = true;
        const offset = secondsOf(ticks) - target;
        if (offset <= -1) return first ? 'early' : 'skip';
        if (key && offset <= 1) return 'take';
        if (first && offset > 0.01) return 'past';
        return offset > 1 ? 'missing' : 'skip';
      };
      const parse = src.init ? (b) => mp4Keyframe(b, src.init, false, aim) : (b) => tsKeyframe(b, src.videoPid, aim);
      const expected = src.byteRate * (src.layout || 1) * anchor.k * KEYFRAME_INTERVAL;
      const packet = (x) => Math.max(0, Math.floor(x / 188) * 188);
      const into = target - anchor.start;
      const segEnd = anchor.index + 1 < src.segments.length ? src.segments[anchor.index + 1].start : src.end;
      let lo = {b: 0, t: 0};
      let hi = null;
      let from = packet(expected - 16384 - expected * (src.layout ? 0.05 : 0.12));
      for (let attempt = 0; attempt < 4; attempt++) {
        judged = false;
        const found = await readRange(url, from, parse);
        if (found && !found.miss) {
          const layout = (from + found.byte) / (src.byteRate * anchor.k * KEYFRAME_INTERVAL);
          src.layout = src.layout ? (src.layout + layout) / 2 : layout;
          return {keyframe: found, time: secondsOf(found.ticks)};
        }
        // The segment ended after frames that were neither the keyframe nor past it: it isn't in this segment
        if (found ? found.miss === 'missing' : judged) break;
        // Interpolate between the positions seen before and after the keyframe (nothing read: `from` is past the end),
        // a little early since the keyframe itself is larger than other frames
        const seen = found
          ? {b: from + found.byte, t: secondsOf(found.ticks) - anchor.start}
          : {b: from, t: segEnd - anchor.start};
        if (found && found.miss === 'early') lo = seen;
        else hi = seen;
        let rate = src.byteRate * (src.layout || 1);
        if (hi) rate = (hi.b - lo.b) / (hi.t - lo.t);
        else if (lo.t > 1) rate = lo.b / lo.t;
        from = Math.max(lo.b, packet(lo.b + (into - lo.t) * rate * 0.95 - 16384 - 0.3 * rate));
      }
      // A stream without a keyframe every 2 s: after two misses, anchor to segment starts (always keyframes)
      src.misses = (src.misses || 0) + 1;
      if (src.misses >= 2 && !src.gridless) {
        src.gridless = true;
        this.log('Preview keyframes are not every 2 s on this stream: previews snap to segments');
      }
    }
    const keyframe = await readRange(
      url,
      0,
      src.init ? (b) => mp4Keyframe(b, src.init, true) : (b) => tsKeyframe(b, src.videoPid)
    );
    if (!keyframe) throw new Error('no keyframe at the start of the segment');
    return {keyframe, time: secondsOf(keyframe.ticks)};
  }
}
