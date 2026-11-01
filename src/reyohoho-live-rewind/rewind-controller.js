// Based on TwitchRewind (https://github.com/Alban1911/TwitchRewind), MIT License, Copyright (c) 2026 Alban1911

import Hls from 'hls.js';
import SeekPreview, {PREVIEW_H, PREVIEW_W} from './seek-preview.js';
import {fetchCurrentVod, resolveVodPlaybackUrl, revokeVodPlaybackUrl} from './vod-service.js';

function observeSelector(selector, callback) {
	const run = () => {
		if (document.querySelector(selector)) {
			callback();
		}
	};
	run();
	const observer = new MutationObserver(run);
	observer.observe(document.body, {childList: true, subtree: true});
	return () => observer.disconnect();
}

const VOD_CHECK_INTERVAL = 30000;
const UI_TICK = 500;
const CONTROLS_KEEPALIVE = 2000;
const SEEK_STEP = 10;
const MIN_REWIND_SEC = 15;
const HLS_RECOVERY_LIMIT = 3;
const SPEED_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const SVG_NS = 'http://www.w3.org/2000/svg';
const AD_SELECTOR =
  '[data-a-target="video-ad-label"], [data-test-selector="ad-overlay-component"], .ad-banner-default-container';
const PLAY_PATH = 'M5 2.969V21.03a.5.5 0 0 0 .765.424L20.18 12.424a.5.5 0 0 0 0-.849L5.765 2.546A.5.5 0 0 0 5 2.97Z';
const PAUSE_PATH = 'M10 4H5v16h5V4Zm9 0h-5v16h5V4Z';

const KNOWN_ROUTES = new Set([
  'directory',
  'settings',
  'subscriptions',
  'inventory',
  'wallet',
  'drops',
  'videos',
  'p',
  'search',
  'downloads',
  'turbo',
  'prime',
  'products',
  'jobs',
  'about',
  'legal',
  'moderator',
  'friends',
  'store',
  'checkout',
  'bits',
  'subs',
  'u',
  'popout',
  'embed',
  'broadcast',
  'dashboard',
  'messages',
]);

// Always hh:mm:ss, like Twitch's own seekbar
function formatTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(sec / 3600))}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}`;
}

export default class LiveRewindController {
  constructor({log, syncAudio, canUseRewind} = {}) {
    this._logFn = typeof log === 'function' ? log : () => {};
    this._syncAudioFn = typeof syncAudio === 'function' ? syncAudio : () => {};
    this._canUseRewindFn = typeof canUseRewind === 'function' ? canUseRewind : () => true;
    this.enabled = true;
    this.channel = null;
    this.vodId = null;
    this.vodCreatedAt = null;
    this.vodUrl = null;
    this.usingSyntheticPlaylist = false;
    this.isRewinding = false;
    this.hlsInstance = null;
    this.hlsReady = false;
    this.vodVideo = null;
    this.ui = {};
    this.uiTimer = null;
    this.uiObserver = null;
    this.uiObservedContainer = null;
    this.uiRepairFrame = 0;
    this.controlsKeptAt = 0;
    this.vodCheckInterval = null;
    this.preloading = false;
    this.loadingRewind = false;
    this.pendingSeek = null;
    this.rewindSeq = 0;
    this.vodMisses = 0;
    // Bumped on every channel change so stale async continuations can bail out
    this.navEpoch = 0;
    this.checkInFlight = null;
    this.mutedVideoRef = null;
    this.videoObserver = null;
    this.navTimer = null;
    this.hooksAttached = false;
    this.globalHooksAttached = false;
    this.seekDragging = false;
    this.dragTarget = null;
    this.hovered = null;
    this.unwatchControls = null;
    this.preview = new SeekPreview({
      log: (...args) => this.log(...args),
      getVodUrl: () => this.vodUrl,
      getSeekbar: () => this.ui.seekbar,
      formatTime,
    });
  }

  resetPreview() {
    this.preview.reset();
    this.hovered = null;
  }

  log(...args) {
    this._logFn('[live_rewind]', ...args);
  }

  canUseRewind() {
    return this._canUseRewindFn();
  }

  syncAudioCompressor(video = null) {
    try {
      this._syncAudioFn(video);
    } catch (error) {
      this.log('Audio compressor sync skipped:', error);
    }
  }

  setVodUrl(url) {
    if (url !== this.vodUrl) revokeVodPlaybackUrl(this.vodUrl);
    this.vodUrl = url;
    this.usingSyntheticPlaylist = !!url?.startsWith('blob:');
  }

  clearVodUrl() {
    this.setVodUrl(null);
  }

  destroyHls() {
    this.hlsInstance?.destroy();
    this.hlsInstance = null;
    this.hlsReady = false;
  }

  elapsed() {
    if (!this.vodCreatedAt) return 0;
    return (Date.now() - new Date(this.vodCreatedAt).getTime()) / 1000;
  }

  clampSeek(sec) {
    return Math.max(0, Math.min(sec, this.elapsed() - MIN_REWIND_SEC));
  }

  playerContainer() {
    return (
      document.querySelector('.video-player__container') || document.querySelector('[data-a-target="video-player"]')
    );
  }

  // Only visible ad markers inside the player count: a leftover or page-level ad container must not hide the seekbar
  isAdPlaying() {
    const container = this.playerContainer();
    const root =
      container &&
      (container.closest('.persistent-player') || container.closest('[data-a-target="video-player"]') || container);
    if (!root) return false;
    for (const el of root.querySelectorAll(AD_SELECTOR)) {
      if (el.getClientRects().length) return true;
    }
    return false;
  }

  twitchVideo() {
    const container = this.playerContainer();
    if (!container) return null;
    return container.querySelector('video:not(.rte-lr-vod-video)') || null;
  }

  nativeControls() {
    return (
      this.playerContainer()?.querySelector('[data-a-target="player-controls"]') ||
      document.querySelector('[data-a-target="player-controls"]') ||
      document.querySelector('.player-controls')
    );
  }

  // Twitch's own rewind (Turbo, ad-free subs) puts its seekbar into the controls; checked on the page, not guessed from status
  nativeRewind() {
    return !!this.nativeControls()?.querySelector('[data-a-target="player-seekbar"]');
  }

  channelFromUrl() {
    const parts = location.pathname.split('/').filter(Boolean);
    if (parts.length !== 1) return null;
    // Logins are case-insensitive, so a case-only URL rewrite must not look like a channel change
    const channel = parts[0].toLowerCase();
    return KNOWN_ROUTES.has(channel) ? null : channel;
  }

  start() {
    if (this.hooksAttached || !this.canUseRewind()) return;
    this.hooksAttached = true;
    if (!this.globalHooksAttached) {
      this.globalHooksAttached = true;
      this.hookNavigation();
      this.hookQualityMenu();
      this.hookVolumeSlider();
      this.hookNativeButtons();
      this.hookSpeedMenu();
      this.hookCopyUrl();
      this.hookKeyboard();
      document.addEventListener('mousemove', this.onDocMouseMove);
      document.addEventListener('mouseup', this.onDocMouseUp);
    }
    this.hookPlayerControls();
    this.onPlayerReady();
  }

  stop() {
    this.unhookPlayerControls();
    this.navEpoch++;
    this.cleanup();
    this.hooksAttached = false;
  }

  hookPlayerControls() {
    if (this.unwatchControls) return;

    this.unwatchControls = observeSelector('[data-a-target="player-controls"], .player-controls', () => {
      this.onPlayerReady();
    });
  }

  unhookPlayerControls() {
    this.unwatchControls?.();
    this.unwatchControls = null;
  }

  onPlayerReady() {
    if (!this.enabled || !this.hooksAttached || !this.canUseRewind()) {
      if (!this.canUseRewind()) {
        this.navEpoch++;
        this.cleanup();
      }
      return;
    }

    const channel = this.channelFromUrl();
    if (!channel) return;

    if (channel !== this.channel) {
      this.onChannelChange(channel);
      return;
    }

    // The VOD itself is looked up by onChannelChange and its poll: this runs on every player re-render
    if (this.vodId) this.startUi();
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (!enabled) {
      this.navEpoch++;
      this.cleanup();
    } else if (this.hooksAttached) {
      this.onNavigate();
    }
  }

  hookNavigation() {
    const wrap =
      (orig) =>
      (...args) => {
        orig.apply(history, args);
        this.onNavigate();
      };
    history.pushState = wrap(history.pushState);
    history.replaceState = wrap(history.replaceState);
    window.addEventListener('popstate', () => this.onNavigate());
  }

  onNavigate() {
    clearTimeout(this.navTimer);
    this.navTimer = setTimeout(() => {
      if (!this.enabled || !this.hooksAttached) return;
      const channel = this.channelFromUrl();
      if (channel !== this.channel) this.onChannelChange(channel);
    }, 500);
  }

  async onChannelChange(channel) {
    const epoch = ++this.navEpoch;
    this.cleanup();
    if (!channel || !this.enabled || !this.canUseRewind()) return;
    this.channel = channel;
    this.log('Channel:', channel);
    await this.waitForPlayer();
    if (epoch !== this.navEpoch) return;
    await this.checkVod();
    if (epoch !== this.navEpoch) return;
    clearInterval(this.vodCheckInterval);
    this.vodCheckInterval = setInterval(() => this.checkVod(), VOD_CHECK_INTERVAL);
  }

  async checkVod() {
    const epoch = this.navEpoch;
    const channel = this.channel;
    if (!channel || !this.enabled || !this.canUseRewind() || this.checkInFlight === epoch) return;
    if (this.nativeRewind()) return;
    this.checkInFlight = epoch;
    try {
      const vod = await fetchCurrentVod(channel);
      if (epoch !== this.navEpoch) return;
      if (vod) {
        const isNew = this.vodId !== vod.id;
        this.vodId = vod.id;
        this.vodCreatedAt = vod.createdAt;
        this.vodMisses = 0;
        if (isNew) {
          this.log('VOD found:', vod.id);
          if (this.isRewinding || this.loadingRewind) this.goLive();
          this.clearVodUrl();
          this.destroyHls();
          this.resetPreview();
        }
        this.startUi();
        this.preloadVod();
      } else {
        // Errors throw instead of landing here; tear down after two misses in a row, never mid-rewind
        this.vodMisses++;
        if (this.vodMisses >= 2 && !this.isRewinding) {
          this.vodId = null;
          this.vodCreatedAt = null;
          this.removeControls();
          if (this.loadingRewind) this.goLive();
          this.clearVodUrl();
          this.destroyHls();
          this.resetPreview();
        }
      }
    } catch (error) {
      this.log('VOD check error:', error);
    } finally {
      if (this.checkInFlight === epoch) this.checkInFlight = null;
    }
  }

  waitForPlayer() {
    return new Promise((resolve) => {
      let tries = 0;
      const check = () => {
        if (this.nativeControls() || ++tries > 60) {
          resolve();
          return;
        }
        setTimeout(check, 500);
      };
      check();
    });
  }

  // Twitch re-renders or replaces the player whenever it likes (ads, reconnects, tab switches):
  // a watchdog tick plus an observer on the current container keep the controls mounted
  startUi() {
    if (!this.uiTimer) this.uiTimer = setInterval(() => this.uiTick(), UI_TICK);
    this.ensureUi();
  }

  stopUi() {
    clearInterval(this.uiTimer);
    this.uiTimer = null;
    this.uiObserver?.disconnect();
    this.uiObserver = null;
    this.uiObservedContainer = null;
    cancelAnimationFrame(this.uiRepairFrame);
    this.uiRepairFrame = 0;
  }

  uiTick() {
    this.ensureUi();
    this.updateSeek();
    this.keepControlsUp();
  }

  // Twitch hides its controls 5 s after they appear even with the pointer on them; re-arm that timer while on the seekbar
  keepControlsUp() {
    const seekbar = this.ui.seekbar;
    if (!seekbar || !(this.seekDragging || seekbar.el.matches(':hover'))) return;
    if (Date.now() - this.controlsKeptAt < CONTROLS_KEEPALIVE) return;
    this.controlsKeptAt = Date.now();
    seekbar.el
      .closest('[data-a-target="video-ref"]')
      ?.dispatchEvent(new MouseEvent('mouseenter', {relatedTarget: null}));
  }

  scheduleUiRepair() {
    if (this.uiRepairFrame) return;
    this.uiRepairFrame = requestAnimationFrame(() => {
      this.uiRepairFrame = 0;
      this.ensureUi();
    });
  }

  ensureUi() {
    if (!this.enabled || !this.vodId || !this.canUseRewind()) return;

    const container = this.playerContainer();
    if (container && container !== this.uiObservedContainer) {
      this.uiObserver?.disconnect();
      this.uiObserver = new MutationObserver(() => this.scheduleUiRepair());
      this.uiObserver.observe(container, {childList: true, subtree: true});
      this.uiObservedContainer = container;
    }

    if (this.nativeRewind()) {
      if (this.ui.seekArea) this.stepAside();
      return;
    }

    const controls = this.nativeControls();
    const area = this.ui.seekArea;
    if (controls && !(area?.isConnected && controls.contains(area))) this.injectControls(controls);

    if (this.isRewinding) {
      const nativeVideo = this.twitchVideo();
      if (nativeVideo && nativeVideo !== this.mutedVideoRef) this.attachMuteListener(nativeVideo);
      if (this.vodVideo && !this.vodVideo.isConnected) this.reattachVodVideo();
      this.updatePlayPauseIcon();
    }
  }

  // The watchdog keeps running, so the controls come back if Twitch's seekbar goes away
  stepAside() {
    if (this.isRewinding || this.loadingRewind) this.goLive();
    // Stop the preloaded VOD from buffering behind Twitch's own rewind; a later rewind loads it again
    this.destroyHls();
    document.getElementById('rte-lr-seekbar-area')?.remove();
    this.ui = {};
    this.seekDragging = false;
    this.log('Native rewind present, stepping aside');
  }

  // Pointer position as a fraction of the seekbar, or null when it isn't laid out (a zero-width rect would read as 0:00)
  seekPctFromEvent(el, event) {
    if (!el.isConnected) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return null;
    return Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  }

  dragSeek(sec) {
    if (this.isRewinding && this.hlsReady && this.vodVideo) this.vodVideo.currentTime = sec;
    else if (this.loadingRewind || this.isRewinding) this.pendingSeek = sec;
  }

  onDocMouseMove = (event) => {
    // Button no longer held: the mouseup happened somewhere we didn't see it
    if (this.seekDragging && !(event.buttons & 1)) this.onDocMouseUp();
    const seekbar = this.ui.seekbar;
    if (!seekbar) return;
    const pct = this.seekPctFromEvent(seekbar.el, event);
    if (pct === null) return;
    const sec = this.clampSeek(pct * this.elapsed());
    const target = this.preview.seekTarget(sec);
    if (this.seekDragging && target !== this.dragTarget) {
      this.dragTarget = target;
      this.dragSeek(target);
    }
    if (this.seekDragging || seekbar.el.matches(':hover')) {
      this.hovered = {x: event.clientX, sec};
      // With previews: the time of the keyframe shown, where a click lands
      seekbar.time.textContent = formatTime(this.preview.working() ? target : pct * this.elapsed());
      this.preview.show(sec);
      // Keep the tooltip (160px wide with a preview) inside the bar
      const width = seekbar.el.clientWidth;
      const half = seekbar.tooltip.offsetWidth / 2;
      seekbar.tooltip.style.left = `${Math.min(Math.max(pct * width, half), Math.max(half, width - half))}px`;
    }
  };

  onDocMouseUp = () => {
    if (!this.seekDragging) return;
    this.seekDragging = false;
    this.ui.seekbar?.el.classList.remove('rte-lr-seekbar--active');
  };

  injectControls(controls) {
    document.getElementById('rte-lr-seekbar-area')?.remove();

    const seekArea = document.createElement('div');
    seekArea.id = 'rte-lr-seekbar-area';
    seekArea.className = 'rte-lr-seekbar-area';

    const topRow = document.createElement('div');
    topRow.className = 'rte-lr-seekbar-top';

    const curLabel = document.createElement('p');
    curLabel.className = 'rte-lr-elapsed';
    curLabel.textContent = formatTime(this.elapsed());

    const liveLabel = document.createElement('div');
    liveLabel.id = 'rte-lr-live-label';
    liveLabel.className = this.isRewinding ? 'rte-lr-live-label' : 'rte-lr-live-label rte-lr-live-label--at-live';
    liveLabel.tabIndex = 0;
    liveLabel.setAttribute('role', 'button');
    liveLabel.setAttribute('aria-label', 'Перейти к live');

    const liveText = document.createElement('span');
    liveText.className = 'rte-lr-live-text';
    liveText.textContent = 'LIVE';
    liveLabel.appendChild(liveText);

    const skipSvg = document.createElementNS(SVG_NS, 'svg');
    skipSvg.setAttribute('width', '18');
    skipSvg.setAttribute('height', '18');
    skipSvg.setAttribute('viewBox', '0 0 24 24');
    skipSvg.setAttribute('fill', 'currentColor');
    const skipPath = document.createElementNS(SVG_NS, 'path');
    skipPath.setAttribute(
      'd',
      'M5.794 4.578 16 12 5.794 19.422A.5.5 0 0 1 5 19.018V4.982a.5.5 0 0 1 .794-.404ZM17 4h2v16h-2V4Z'
    );
    skipSvg.appendChild(skipPath);
    liveLabel.appendChild(skipSvg);
    liveLabel.addEventListener('click', () => this.goLive());

    topRow.append(curLabel, liveLabel);

    const seekRow = document.createElement('div');
    seekRow.className = 'rte-lr-seekbar-row';

    const seekbar = document.createElement('div');
    seekbar.className = 'rte-lr-seekbar';

    const seekTrack = document.createElement('div');
    seekTrack.className = 'rte-lr-seekbar-track';

    const seekPlayed = document.createElement('span');
    seekPlayed.className = 'rte-lr-seekbar-played';
    seekPlayed.style.width = '100%';

    const seekThumb = document.createElement('span');
    seekThumb.className = 'rte-lr-seekbar-thumb';
    seekThumb.style.left = '100%';

    const seekTooltip = document.createElement('span');
    seekTooltip.className = 'rte-lr-seekbar-tooltip';
    const seekPreview = document.createElement('canvas');
    seekPreview.className = 'rte-lr-seekbar-preview';
    seekPreview.width = PREVIEW_W;
    seekPreview.height = PREVIEW_H;
    const seekTime = document.createElement('span');
    seekTime.className = 'rte-lr-seekbar-time';
    seekTooltip.append(seekPreview, seekTime);

    seekTrack.appendChild(seekPlayed);
    seekbar.append(seekTrack, seekThumb, seekTooltip);

    const liveDot = document.createElement('button');
    liveDot.id = 'rte-lr-live-dot';
    liveDot.className = 'rte-lr-live-dot';
    liveDot.title = 'Перейти к live';
    liveDot.setAttribute('aria-label', 'Перейти к live');
    liveDot.innerHTML = '<span class="rte-lr-live-dot-indicator"></span>';
    liveDot.addEventListener('click', () => this.goLive());

    seekRow.append(seekbar, liveDot);
    seekArea.append(topRow, seekRow);

    const buttonSection = controls.querySelector(':scope > section');
    if (buttonSection) {
      controls.insertBefore(seekArea, buttonSection);
    } else {
      const firstChild = controls.querySelector(':scope > div:last-of-type, :scope > section');
      if (firstChild) controls.insertBefore(seekArea, firstChild);
      else controls.appendChild(seekArea);
    }

    seekbar.addEventListener('mousedown', (event) => {
      if (event.button !== 0 || !this.vodId) return;
      const pct = this.seekPctFromEvent(seekbar, event);
      if (pct === null) return;
      event.preventDefault();
      this.seekDragging = true;
      seekbar.classList.add('rte-lr-seekbar--active');
      // The bar of a live stream grows under a resting pointer: land where the tooltip says
      this.dragTarget = this.preview.seekTarget(
        this.hovered && this.hovered.x === event.clientX ? this.hovered.sec : this.clampSeek(pct * this.elapsed())
      );
      this.startRewind(this.dragTarget);
    });

    this.ui = {
      seekArea,
      seekbar: {
        el: seekbar,
        played: seekPlayed,
        thumb: seekThumb,
        tooltip: seekTooltip,
        preview: seekPreview,
        time: seekTime,
      },
      curLabel,
      liveLabel,
    };
    this.updateSeek();
    this.log('Controls injected');
  }

  removeControls() {
    this.stopUi();
    document.getElementById('rte-lr-seekbar-area')?.remove();
    this.ui = {};
    this.seekDragging = false;
  }

  reattachVodVideo() {
    const video = this.vodVideo;
    if (!video) return false;
    if (video.isConnected) return true;
    const container = this.playerContainer();
    if (!container) return false;
    const nativeVideo = this.twitchVideo();
    const videoRef = container.querySelector('.video-ref, [data-a-target="video-ref"]');
    if (nativeVideo && videoRef?.contains(nativeVideo)) nativeVideo.after(video);
    else if (videoRef) videoRef.prepend(video);
    else container.appendChild(video);
    this.log('Re-attached VOD video');
    return true;
  }

  ensureVodVideo() {
    if (this.vodVideo) {
      // A detached video plays audio with no picture, so reattach it
      return this.vodVideo.isConnected || this.reattachVodVideo() ? this.vodVideo : null;
    }
    const container = this.playerContainer();
    if (!container) return null;

    const video = document.createElement('video');
    video.className = 'rte-lr-vod-video';
    video.playsInline = true;
    video.style.display = 'none';
    video.addEventListener('click', () => {
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    });
    video.addEventListener('play', () => {
      this.updatePlayPauseIcon();
      this.syncAudioCompressor(video);
    });
    video.addEventListener('pause', () => this.updatePlayPauseIcon());

    const videoRef = container.querySelector('.video-ref, [data-a-target="video-ref"]');
    if (videoRef) {
      const nativeVid = videoRef.querySelector('video');
      if (nativeVid) nativeVid.after(video);
      else videoRef.prepend(video);
    } else {
      container.appendChild(video);
    }

    this.vodVideo = video;
    return video;
  }

  showVodVideo() {
    if (this.vodVideo) this.vodVideo.style.display = '';
  }

  hideVodVideo() {
    if (this.vodVideo) this.vodVideo.style.display = 'none';
  }

  async preloadVod() {
    // Never replace an existing instance: it may be serving the active rewind
    if (
      !this.canUseRewind() ||
      !this.vodId ||
      this.hlsInstance ||
      this.preloading ||
      this.loadingRewind ||
      this.isRewinding
    ) {
      return;
    }
    const vodId = this.vodId;
    const epoch = this.navEpoch;
    this.preloading = true;
    this.log('Pre-loading VOD URL...');

    try {
      const url = await resolveVodPlaybackUrl(vodId);
      if (
        epoch !== this.navEpoch ||
        this.vodId !== vodId ||
        this.loadingRewind ||
        this.isRewinding ||
        this.hlsInstance
      ) {
        revokeVodPlaybackUrl(url);
        return;
      }
      if (!url) {
        this.log('VOD URL not available');
        return;
      }

      this.setVodUrl(url);
      if (!Hls.isSupported()) return;

      const video = this.ensureVodVideo();
      if (!video) return;

      const hls = new Hls({maxBufferLength: 30, maxMaxBufferLength: 120, startPosition: -1});
      this.hlsInstance = hls;

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (this.hlsInstance !== hls) return;
        this.hlsReady = true;
        this.log('VOD pre-loaded');
      });
      this.watchHlsErrors(hls);

      hls.loadSource(url);
      hls.attachMedia(video);
      video.addEventListener(
        'loadedmetadata',
        () => {
          if (!this.isRewinding) video.pause();
        },
        {once: true}
      );
    } catch (error) {
      this.log('Pre-load failed:', error);
    } finally {
      // cleanup() already reset the flag if the channel changed meanwhile
      if (epoch === this.navEpoch) this.preloading = false;
    }
  }

  async startRewind(seekTo) {
    // Ads only block starting a rewind; seeking within one keeps working
    if (!this.vodId || (!this.isRewinding && this.isAdPlaying())) return;

    seekTo = this.clampSeek(seekTo);

    if (this.isRewinding && this.vodVideo) {
      if (this.hlsReady) {
        this.vodVideo.currentTime = seekTo;
        return;
      }
      if (this.hlsInstance) {
        this.pendingSeek = seekTo;
        return;
      }
    }

    if (this.loadingRewind) {
      this.pendingSeek = seekTo;
      return;
    }

    this.log('Rewind →', formatTime(seekTo));

    if (this.hlsReady && this.hlsInstance && this.vodVideo) {
      if (!this.vodVideo.isConnected && !this.reattachVodVideo()) return;
      this.syncVodVolume();
      this.vodVideo.currentTime = seekTo;
      this.showVodVideo();
      this.vodVideo.play().catch(() => {});
      this.isRewinding = true;
      this.muteNative();
      this.updateSeek();
      this.updatePlayPauseIcon();
      this.syncAudioCompressor(this.vodVideo);
      return;
    }

    const epoch = this.navEpoch;
    const seq = this.rewindSeq;
    const vodId = this.vodId;
    // LIVE clicked, channel left or recording rotated while the load was in flight
    const cancelled = () => epoch !== this.navEpoch || seq !== this.rewindSeq || this.vodId !== vodId;
    this.loadingRewind = true;
    this.pendingSeek = null;
    try {
      let url = this.vodUrl;
      if (!url) {
        url = await resolveVodPlaybackUrl(vodId);
        if (cancelled()) {
          revokeVodPlaybackUrl(url);
          return;
        }
        if (!url) {
          this.log('Cannot access VOD');
          return;
        }
        this.setVodUrl(url);
      }

      const video = this.ensureVodVideo();
      if (!video || !Hls.isSupported()) return;

      this.destroyHls();

      // A seek made while the URL was resolving wins over the original target
      const start = this.pendingSeek ?? seekTo;
      this.pendingSeek = null;
      const hls = new Hls({maxBufferLength: 30, maxMaxBufferLength: 120, startPosition: start});
      this.hlsInstance = hls;

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (this.hlsInstance !== hls) return;
        this.hlsReady = true;
        if (!this.isRewinding) {
          // Returned to live while loading: don't start hidden VOD playback on top of the live stream
          video.pause();
          return;
        }
        this.syncVodVolume();
        if (this.pendingSeek != null) video.currentTime = this.pendingSeek;
        this.pendingSeek = null;
        video.play().catch(() => {});
        this.updatePlayPauseIcon();
        this.syncAudioCompressor(video);
      });
      this.watchHlsErrors(hls);

      hls.loadSource(url);
      hls.attachMedia(video);

      this.showVodVideo();
      this.isRewinding = true;
      this.muteNative();
      this.updateSeek();
    } catch (error) {
      this.log('Rewind failed:', error);
      if (!cancelled()) this.goLive();
    } finally {
      // cleanup() already reset the flag if the channel changed meanwhile
      if (epoch === this.navEpoch) this.loadingRewind = false;
    }
  }

  // Fatal errors: try the synthetic CDN playlist once, then a few recoveries per minute, then give up cleanly
  watchHlsErrors(hls) {
    let attempts = 0;
    let windowStart = 0;
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal || this.hlsInstance !== hls) return;

      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && !this.usingSyntheticPlaylist && this.vodId) {
        this.retryWithSyntheticPlaylist(hls);
        return;
      }

      const now = Date.now();
      if (now - windowStart > 60000) {
        windowStart = now;
        attempts = 0;
      }
      const isMedia = data.type === Hls.ErrorTypes.MEDIA_ERROR;
      // A failed master playlist can't be resumed with startLoad(): it needs a fresh URL
      const isNetwork = data.type === Hls.ErrorTypes.NETWORK_ERROR && !String(data.details).startsWith('manifest');
      if ((isMedia || isNetwork) && attempts++ < HLS_RECOVERY_LIMIT) {
        this.log('HLS error, recovering:', data.details);
        if (isMedia) {
          // recoverMediaError() re-attaches the media element, which pauses it
          const media = hls.media;
          const resume = media && !media.paused;
          hls.recoverMediaError();
          if (resume) media.play().catch(() => {});
        } else {
          hls.startLoad();
        }
        return;
      }
      this.log('HLS error, giving up:', data.details);
      this.dropHls();
    });
  }

  async retryWithSyntheticPlaylist(hls) {
    const vodId = this.vodId;
    // Set before the await so a second fatal error doesn't start another retry
    this.usingSyntheticPlaylist = true;
    try {
      const syntheticUrl = await resolveVodPlaybackUrl(vodId, {synthetic: true});
      if (this.hlsInstance !== hls || this.vodId !== vodId) {
        revokeVodPlaybackUrl(syntheticUrl);
        return;
      }
      if (!syntheticUrl) {
        this.log('Synthetic VOD playlist unavailable');
        this.dropHls();
        return;
      }

      this.setVodUrl(syntheticUrl);
      this.log('Retrying VOD with synthetic CDN playlist');
      hls.loadSource(syntheticUrl);
      if (this.vodVideo) hls.attachMedia(this.vodVideo);
    } catch (error) {
      this.log('Synthetic VOD retry failed:', error);
      if (this.hlsInstance === hls) this.dropHls();
    }
  }

  // Forget the (possibly expired) URL too, so the next preload or rewind starts over with a fresh token
  dropHls() {
    if (this.isRewinding) this.goLive();
    this.destroyHls();
    this.clearVodUrl();
  }

  syncVodVolume() {
    if (!this.vodVideo) return;
    const nativeVideo = this.twitchVideo();
    this.vodVideo.volume = nativeVideo?._rteLrSavedVolume ?? nativeVideo?.volume ?? 1;
    this.vodVideo.muted = nativeVideo?.muted ?? false;
  }

  hookVolumeSlider() {
    document.addEventListener(
      'input',
      (event) => {
        if (!this.isRewinding || !this.vodVideo) return;
        const slider = event.target.closest('[data-a-target="player-volume-slider"]');
        if (!slider) return;
        this.vodVideo.volume = parseFloat(slider.value);
      },
      true
    );
  }

  // Delegated, so the hook survives Twitch re-rendering the control bar
  hookNativeButtons() {
    document.addEventListener(
      'click',
      (event) => {
        if (!this.isRewinding || !this.vodVideo) return;
        if (!event.target.closest('[data-a-target="player-play-pause-button"]')) return;
        event.stopImmediatePropagation();
        event.preventDefault();
        if (this.vodVideo.paused) this.vodVideo.play().catch(() => {});
        else this.vodVideo.pause();
        this.updatePlayPauseIcon();
      },
      true
    );
  }

  onNativeVolumeChange = (event) => {
    const video = event.currentTarget;
    if (!this.isRewinding) return;
    if (video.volume > 0) {
      video._rteLrSavedVolume = video.volume;
      video.volume = 0;
    }
    // Mirror mute toggles (button or M key) onto the VOD video
    if (this.vodVideo) this.vodVideo.muted = video.muted;
  };

  attachMuteListener(video) {
    if (this.mutedVideoRef === video) return;
    this.detachMuteListener();
    video._rteLrSavedVolume = video.volume;
    video.volume = 0;
    video.addEventListener('volumechange', this.onNativeVolumeChange);
    this.mutedVideoRef = video;
  }

  detachMuteListener() {
    if (!this.mutedVideoRef) return;
    this.mutedVideoRef.removeEventListener('volumechange', this.onNativeVolumeChange);
    if (this.mutedVideoRef._rteLrSavedVolume !== undefined) {
      this.mutedVideoRef.volume = this.mutedVideoRef._rteLrSavedVolume;
      delete this.mutedVideoRef._rteLrSavedVolume;
    }
    this.mutedVideoRef = null;
  }

  muteNative() {
    const video = this.twitchVideo();
    if (video) this.attachMuteListener(video);

    if (!this.videoObserver) {
      const container = this.playerContainer();
      if (container) {
        this.videoObserver = new MutationObserver(() => {
          if (!this.isRewinding) return;
          const nativeVideo = this.twitchVideo();
          if (nativeVideo && nativeVideo !== this.mutedVideoRef) this.attachMuteListener(nativeVideo);
          if (this.vodVideo && !this.vodVideo.isConnected) this.reattachVodVideo();
        });
        this.videoObserver.observe(container, {childList: true, subtree: true});
      }
    }
  }

  unmuteNative() {
    this.detachMuteListener();
    this.videoObserver?.disconnect();
    this.videoObserver = null;
  }

  goLive() {
    this.log('Back to live');
    this.isRewinding = false;
    this.pendingSeek = null;
    this.rewindSeq++;

    if (this.vodVideo) {
      this.vodVideo.pause();
      this.vodVideo.playbackRate = 1;
    }
    this.hideVodVideo();
    this.unmuteNative();
    this.restorePlayPauseIcon();

    requestAnimationFrame(() => {
      if (this.isRewinding) return;
      const nativeVideo = this.twitchVideo();
      if (nativeVideo?.paused) nativeVideo.play().catch(() => {});
    });

    this.updateSeek();
    this.syncAudioCompressor(this.twitchVideo());
  }

  updateSeek() {
    const {seekArea, seekbar, curLabel, liveLabel} = this.ui;
    if (!seekArea) return;
    // Hide during ads, but never mid-rewind: a midroll on the muted live stream must not take the controls away
    seekArea.style.display = !this.isRewinding && this.isAdPlaying() ? 'none' : '';
    liveLabel.classList.toggle('rte-lr-live-label--at-live', !this.isRewinding);

    const total = this.elapsed();
    if (total <= 0) return;

    if (this.isRewinding && this.vodVideo) {
      const cur = this.vodVideo.currentTime;
      const pct = Math.min(100, (cur / total) * 100);
      seekbar.el.classList.remove('rte-lr-seekbar--live');
      seekbar.played.style.width = `${pct}%`;
      seekbar.thumb.style.left = `${pct}%`;
      curLabel.textContent = formatTime(cur);
    } else {
      seekbar.el.classList.add('rte-lr-seekbar--live');
      seekbar.played.style.width = '100%';
      seekbar.thumb.style.left = '100%';
      curLabel.textContent = formatTime(total);
    }
  }

  playPauseButton() {
    return document.querySelector('[data-a-target="player-play-pause-button"]');
  }

  // Keeps Twitch's original icon and label so restorePlayPauseIcon() can put them back; writes only on change
  updatePlayPauseIcon() {
    if (!this.isRewinding || !this.vodVideo) return;
    const btn = this.playPauseButton();
    const svg = btn?.querySelector('svg');
    if (!svg) return;
    const paused = this.vodVideo.paused;
    const d = paused ? PLAY_PATH : PAUSE_PATH;
    if (svg._rteLrPath !== d) {
      if (!svg._rteLrNative) svg._rteLrNative = [...svg.childNodes];
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.replaceChildren(path);
      svg._rteLrPath = d;
    }
    const label = paused ? 'Play' : 'Pause';
    const current = btn.getAttribute('aria-label');
    if (current !== btn._rteLrLabel) btn._rteLrNativeLabel = current;
    if (current !== label) btn.setAttribute('aria-label', label);
    btn._rteLrLabel = label;
  }

  restorePlayPauseIcon() {
    const btn = this.playPauseButton();
    const svg = btn?.querySelector('svg');
    if (svg?._rteLrNative) {
      svg.replaceChildren(...svg._rteLrNative);
      delete svg._rteLrNative;
      delete svg._rteLrPath;
    }
    if (btn && btn._rteLrLabel !== undefined) {
      if (btn.getAttribute('aria-label') === btn._rteLrLabel && btn._rteLrNativeLabel != null) {
        btn.setAttribute('aria-label', btn._rteLrNativeLabel);
      }
      delete btn._rteLrLabel;
      delete btn._rteLrNativeLabel;
    }
  }

  hookQualityMenu() {
    document.addEventListener(
      'click',
      (event) => {
        if (!this.isRewinding || !this.hlsInstance) return;
        const item =
          event.target.closest('[data-a-target="player-settings-menu-item-quality"]') ||
          event.target.closest('[data-a-target^="player-settings-submenu-quality-option"]');
        if (!item) return;

        const text = item.textContent.trim().toLowerCase();
        const {levels} = this.hlsInstance;
        if (!levels?.length) return;

        if (text.includes('auto')) {
          this.hlsInstance.currentLevel = -1;
          return;
        }

        const match = text.match(/(\d{3,4})p/);
        if (!match) return;
        const targetHeight = parseInt(match[1], 10);
        let bestIdx = -1;
        for (let i = 0; i < levels.length; i++) {
          if (levels[i].height === targetHeight) {
            bestIdx = i;
            break;
          }
        }
        if (bestIdx === -1 && text.includes('source')) bestIdx = 0;
        if (bestIdx !== -1) this.hlsInstance.currentLevel = bestIdx;
      },
      true
    );
  }

  hookSpeedMenu() {
    document.addEventListener(
      'click',
      (event) => {
        if (!this.isRewinding || !this.vodVideo) return;
        const item =
          event.target.closest('[data-a-target^="player-settings-submenu-speed-option"]') ||
          event.target.closest('[data-a-target="player-settings-menu-item-speed"]');
        if (!item) return;
        const match = item.textContent
          .trim()
          .toLowerCase()
          .match(/([\d.]+)\s*x/);
        if (match) this.vodVideo.playbackRate = parseFloat(match[1]);
      },
      true
    );
  }

  hookCopyUrl() {
    document.addEventListener(
      'click',
      (event) => {
        if (!this.isRewinding || !this.vodVideo || !this.vodId) return;
        const item = event.target.closest('[data-a-target="player-settings-menu-item-copy-url"]');
        if (!item) return;
        event.stopImmediatePropagation();
        event.preventDefault();

        const sec = Math.floor(this.vodVideo.currentTime);
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        const url = `https://www.twitch.tv/videos/${this.vodId}?t=${h}h${m}m${s}s`;
        navigator.clipboard.writeText(url).catch(() => {});
      },
      true
    );
  }

  // Capture phase + stopImmediatePropagation keeps Twitch's own key handler off the hidden native player
  hookKeyboard() {
    document.addEventListener(
      'keydown',
      (event) => {
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (
          !this.vodId ||
          event.target.tagName === 'INPUT' ||
          event.target.tagName === 'TEXTAREA' ||
          event.target.isContentEditable
        ) {
          return;
        }
        if (!this.isRewinding || !this.vodVideo) return;

        const vod = this.vodVideo;
        if (event.key === ' ' || (event.key || '').toLowerCase() === 'k') {
          if (vod.paused) vod.play().catch(() => {});
          else vod.pause();
        } else if (event.key === 'ArrowLeft') {
          vod.currentTime = this.clampSeek(vod.currentTime - SEEK_STEP);
        } else if (event.key === 'ArrowRight') {
          vod.currentTime = this.clampSeek(vod.currentTime + SEEK_STEP);
        } else if (event.key === '>' || event.key === '.') {
          const next = SPEED_STEPS.find((step) => step > vod.playbackRate);
          if (next) vod.playbackRate = next;
        } else if (event.key === '<' || event.key === ',') {
          const prev = [...SPEED_STEPS].reverse().find((step) => step < vod.playbackRate);
          if (prev) vod.playbackRate = prev;
        } else {
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        this.updatePlayPauseIcon();
      },
      true
    );
  }

  // Always paired with a navEpoch bump, so in-flight async work bails out instead of resurrecting what this tears down
  cleanup() {
    this.isRewinding = false;
    this.pendingSeek = null;
    this.preloading = false;
    this.loadingRewind = false;
    this.vodMisses = 0;
    this.destroyHls();
    this.resetPreview();
    if (this.vodVideo) {
      // Pause before removing: a detached <video> keeps playing audio
      this.vodVideo.pause();
      this.vodVideo.remove();
      this.vodVideo = null;
    }
    this.unmuteNative();
    this.restorePlayPauseIcon();
    clearInterval(this.vodCheckInterval);
    this.vodCheckInterval = null;
    this.removeControls();
    this.channel = null;
    this.vodId = null;
    this.vodCreatedAt = null;
    this.clearVodUrl();
  }
}
