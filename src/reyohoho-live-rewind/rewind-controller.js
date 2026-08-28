import Hls from 'hls.js';
import {fetchCurrentVod, isSubscribed, resolveVodPlaybackUrl, revokeVodPlaybackUrl} from './vod-service.js';

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
const SEEK_STEP = 10;
const MIN_REWIND_SEC = 15;

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

function formatTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
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
    this.seekInterval = null;
    this.vodCheckInterval = null;
    this.reinjectObserver = null;
    this.reinjectPending = false;
    this.mutedVideoRef = null;
    this.videoObserver = null;
    this.navTimer = null;
    this.hooksAttached = false;
    this.seeking = false;
    this.unwatchControls = null;
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

  clearVodUrl() {
    revokeVodPlaybackUrl(this.vodUrl);
    this.vodUrl = null;
    this.usingSyntheticPlaylist = false;
  }

  attachHlsErrorHandler(hls, video, onFatal = () => this.goLive()) {
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal) return;
      this.log('HLS error:', data.details);

      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && !this.usingSyntheticPlaylist && this.vodId) {
        void this.retryWithSyntheticPlaylist(hls, video);
        return;
      }

      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        hls.startLoad();
        return;
      }

      onFatal();
    });
  }

  async retryWithSyntheticPlaylist(hls, video) {
    try {
      const syntheticUrl = await resolveVodPlaybackUrl(this.vodId, {synthetic: true});
      if (!syntheticUrl) {
        this.log('Synthetic VOD playlist unavailable');
        this.goLive();
        return;
      }

      this.clearVodUrl();
      this.vodUrl = syntheticUrl;
      this.usingSyntheticPlaylist = true;
      this.log('Retrying VOD with synthetic CDN playlist');
      hls.loadSource(syntheticUrl);
      hls.attachMedia(video);
    } catch (error) {
      this.log('Synthetic VOD retry failed:', error);
      this.goLive();
    }
  }

  elapsed() {
    if (!this.vodCreatedAt) return 0;
    return (Date.now() - new Date(this.vodCreatedAt).getTime()) / 1000;
  }

  getSeekBounds() {
    const total = this.elapsed();
    const maxSec = Math.max(0, total - MIN_REWIND_SEC);
    return {total, maxSec, minSec: 0};
  }

  clampSeek(sec) {
    const {maxSec, minSec} = this.getSeekBounds();
    return Math.max(minSec, Math.min(sec, maxSec));
  }

  playerContainer() {
    return (
      document.querySelector('.video-player__container') ||
      document.querySelector('[data-a-target="video-player"]')
    );
  }

  isAdPlaying() {
    return !!(
      document.querySelector('[data-a-target="video-ad-label"]') ||
      document.querySelector('[data-test-selector="ad-overlay-component"]') ||
      document.querySelector('.ad-banner-default-container')
    );
  }

  twitchVideo() {
    const container = this.playerContainer();
    if (!container) return null;
    return container.querySelector('video:not(.rte-lr-vod-video)') || null;
  }

  nativeControls() {
    return (
      document.querySelector('[data-a-target="player-controls"]') ||
      document.querySelector('.player-controls')
    );
  }

  channelFromUrl() {
    const parts = location.pathname.split('/').filter(Boolean);
    if (parts.length !== 1) return null;
    return KNOWN_ROUTES.has(parts[0].toLowerCase()) ? null : parts[0];
  }

  start() {
    if (this.hooksAttached || !this.canUseRewind()) return;
    this.hooksAttached = true;
    this.hookNavigation();
    this.hookQualityMenu();
    this.hookVolumeSlider();
    this.hookSpeedMenu();
    this.hookCopyUrl();
    this.hookKeyboard();
    this.hookPlayerControls();
    this.onPlayerReady();
  }

  stop() {
    this.unhookPlayerControls();
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
        this.cleanup();
      }
      return;
    }

    const channel = this.channelFromUrl();
    if (!channel) return;

    if (channel !== this.channel) {
      void this.onChannelChange(channel);
      return;
    }

    if (this.vodId) {
      if (!document.getElementById('rte-lr-seekbar-area')) {
        this.injectControls();
      }
      this.watchForReinject();
      return;
    }

    void this.checkVod();
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (!enabled) this.cleanup();
    else if (this.hooksAttached) this.onNavigate();
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
      const channel = this.channelFromUrl();
      if (channel !== this.channel) this.onChannelChange(channel);
    }, 500);
  }

  async onChannelChange(channel) {
    this.cleanup();
    if (!channel || !this.enabled || !this.canUseRewind()) return;
    this.channel = channel;
    this.log('Channel:', channel);
    await this.waitForPlayer();
    await this.checkVod();
    clearInterval(this.vodCheckInterval);
    this.vodCheckInterval = setInterval(() => this.checkVod(), VOD_CHECK_INTERVAL);
  }

  async checkVod() {
    if (!this.channel || !this.enabled || !this.canUseRewind()) return;
    try {
      if (await isSubscribed(this.channel)) {
        this.log('Subscribed, skipping rewind UI');
        return;
      }

      const vod = await fetchCurrentVod(this.channel);
      if (vod) {
        this.vodId = vod.id;
        this.vodCreatedAt = vod.createdAt;
        this.log('VOD found:', vod.id);
        this.injectControls();
        this.watchForReinject();
        this.preloadVod();
      } else {
        this.vodId = null;
        this.vodCreatedAt = null;
        this.removeControls();
      }
    } catch (error) {
      this.log('VOD check error:', error);
    }

    if (this.vodId && !document.getElementById('rte-lr-seekbar-area')) {
      this.injectControls();
      this.watchForReinject();
    }
  }

  waitForPlayer() {
    return new Promise((resolve) => {
      let tries = 0;
      const check = () => {
        if (this.nativeControls()) {
          resolve();
          return;
        }
        if (++tries > 60) {
          resolve();
          return;
        }
        setTimeout(check, 500);
      };
      check();
    });
  }

  injectControls() {
    if (!this.canUseRewind()) return;

    document.getElementById('rte-lr-seekbar-area')?.remove();

    const controls = this.nativeControls();
    if (!controls) return;

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
    liveLabel.className = 'rte-lr-live-label rte-lr-live-label--at-live';
    liveLabel.tabIndex = 0;
    liveLabel.setAttribute('role', 'button');
    liveLabel.setAttribute('aria-label', 'Перейти к live');

    const liveText = document.createElement('span');
    liveText.className = 'rte-lr-live-text';
    liveText.textContent = 'LIVE';
    liveLabel.appendChild(liveText);

    const skipSvgNS = 'http://www.w3.org/2000/svg';
    const skipSvg = document.createElementNS(skipSvgNS, 'svg');
    skipSvg.setAttribute('width', '20');
    skipSvg.setAttribute('height', '20');
    skipSvg.setAttribute('viewBox', '0 0 24 24');
    skipSvg.setAttribute('fill', 'currentColor');
    const skipPath = document.createElementNS(skipSvgNS, 'path');
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

    seekTrack.appendChild(seekPlayed);
    seekbar.append(seekTrack, seekThumb, seekTooltip);

    const liveDot = document.createElement('button');
    liveDot.id = 'rte-lr-live-dot';
    liveDot.className = 'rte-lr-live-dot';
    liveDot.title = 'Перейти к live';
    liveDot.setAttribute('aria-label', 'Перейти к live');
    liveDot.innerHTML = '<span class="rte-lr-live-dot-indicator rte-lr-live-dot-indicator--pulse"></span>';
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

    const seekPctFromEvent = (event) => {
      const rect = seekbar.getBoundingClientRect();
      return Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    };

    seekbar.addEventListener('mousedown', (event) => {
      this.seeking = true;
      seekbar.classList.add('rte-lr-seekbar--active');
      const pct = seekPctFromEvent(event);
      const {total} = this.getSeekBounds();
      this.startRewind(this.clampSeek(pct * total));
    });

    this.onSeekMouseMove = (event) => {
      if (this.seeking && this.vodVideo) {
        const pct = seekPctFromEvent(event);
        const {total} = this.getSeekBounds();
        this.vodVideo.currentTime = this.clampSeek(pct * total);
      }
      if (seekbar.matches(':hover') || this.seeking) {
        const pct = seekPctFromEvent(event);
        seekTooltip.textContent = formatTime(pct * this.elapsed());
        seekTooltip.style.left = `${pct * 100}%`;
      }
    };

    this.onSeekMouseUp = () => {
      if (this.seeking) {
        this.seeking = false;
        seekbar.classList.remove('rte-lr-seekbar--active');
      }
    };

    document.addEventListener('mousemove', this.onSeekMouseMove);
    document.addEventListener('mouseup', this.onSeekMouseUp);

    const playPauseBtn = document.querySelector('[data-a-target="player-play-pause-button"]');
    if (playPauseBtn) {
      playPauseBtn.addEventListener(
        'click',
        (event) => {
          if (this.isRewinding && this.vodVideo) {
            event.stopImmediatePropagation();
            event.preventDefault();
            if (this.vodVideo.paused) this.vodVideo.play();
            else this.vodVideo.pause();
            this.updatePlayPauseIcon();
          }
        },
        true
      );
    }

    this.ui.seekArea = seekArea;
    this.ui.seekbar = {el: seekbar, played: seekPlayed, thumb: seekThumb};
    this.ui.curLabel = curLabel;
    this.startSeekUpdates();
    this.log('Controls injected');
  }

  removeControls() {
    this.stopSeekUpdates();
    document.getElementById('rte-lr-seekbar-area')?.remove();
    if (this.onSeekMouseMove) document.removeEventListener('mousemove', this.onSeekMouseMove);
    if (this.onSeekMouseUp) document.removeEventListener('mouseup', this.onSeekMouseUp);
    this.ui = {};
  }

  watchForReinject() {
    this.reinjectObserver?.disconnect();
    const container = this.playerContainer();
    if (!container) return;
    this.reinjectObserver = new MutationObserver(() => {
      if (!this.vodId || this.reinjectPending) return;
      if (!document.getElementById('rte-lr-seekbar-area')) {
        this.reinjectPending = true;
        requestAnimationFrame(() => {
          this.injectControls();
          this.reinjectPending = false;
        });
      }
    });
    this.reinjectObserver.observe(container, {childList: true, subtree: true});
  }

  ensureVodVideo() {
    if (this.vodVideo) return this.vodVideo;
    const container = this.playerContainer();
    if (!container) return null;

    const video = document.createElement('video');
    video.className = 'rte-lr-vod-video';
    video.playsInline = true;
    video.style.display = 'none';
    video.addEventListener('click', () => {
      if (video.paused) video.play();
      else video.pause();
      this.updatePlayPauseIcon();
    });
    video.addEventListener('play', () => {
      this.syncAudioCompressor(video);
    });

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
    if (!this.canUseRewind() || !this.vodId || this.hlsReady) return;
    this.log('Pre-loading VOD URL...');

    try {
      const url = await resolveVodPlaybackUrl(this.vodId);
      if (!url) {
        this.log('VOD URL not available');
        return;
      }

      this.vodUrl = url;
      if (!Hls.isSupported()) return;

      const video = this.ensureVodVideo();
      if (!video) return;

      if (this.hlsInstance) this.hlsInstance.destroy();

      const hls = new Hls({maxBufferLength: 30, maxMaxBufferLength: 120, startPosition: -1});
      this.hlsInstance = hls;

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        this.hlsReady = true;
        this.log('VOD pre-loaded');
      });

      this.attachHlsErrorHandler(hls, video, () => {
        this.hlsReady = false;
      });

      hls.loadSource(url);
      hls.attachMedia(video);
      video.addEventListener('loadedmetadata', () => video.pause(), {once: true});
    } catch (error) {
      this.log('Pre-load failed:', error);
    }
  }

  async startRewind(seekTo) {
    if (!this.vodId || this.isAdPlaying()) return;

    seekTo = this.clampSeek(seekTo);

    if (this.isRewinding && this.vodVideo && this.hlsReady) {
      this.vodVideo.currentTime = seekTo;
      return;
    }

    this.log('Rewind →', formatTime(seekTo));

    if (this.hlsReady && this.hlsInstance && this.vodVideo) {
      this.syncVodVolume();
      this.vodVideo.currentTime = seekTo;
      this.showVodVideo();
      this.vodVideo.play().catch(() => {});
      this.isRewinding = true;
      this.muteNative();
      document.getElementById('rte-lr-live-label')?.classList.remove('rte-lr-live-label--at-live');
      this.updatePlayPauseIcon();
      this.syncAudioCompressor(this.vodVideo);
      return;
    }

    try {
      let url = this.vodUrl;
      if (!url) {
        url = await resolveVodPlaybackUrl(this.vodId);
        if (!url) {
          this.log('Cannot access VOD');
          return;
        }
        this.vodUrl = url;
      }

      const video = this.ensureVodVideo();
      if (!video || !Hls.isSupported()) return;

      if (this.hlsInstance) this.hlsInstance.destroy();

      const hls = new Hls({maxBufferLength: 30, maxMaxBufferLength: 120, startPosition: seekTo});
      this.hlsInstance = hls;

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        this.hlsReady = true;
        this.syncVodVolume();
        video.play().catch(() => {});
        this.updatePlayPauseIcon();
        this.syncAudioCompressor(video);
      });

      this.attachHlsErrorHandler(hls, video);

      hls.loadSource(url);
      hls.attachMedia(video);

      this.showVodVideo();
      this.isRewinding = true;
      this.muteNative();
      document.getElementById('rte-lr-live-label')?.classList.remove('rte-lr-live-label--at-live');
    } catch (error) {
      this.log('Rewind failed:', error);
      this.goLive();
    }
  }

  syncVodVolume() {
    if (!this.vodVideo) return;
    const nativeVideo = this.twitchVideo();
    const volume = nativeVideo?._rteLrSavedVolume ?? nativeVideo?.volume ?? 1;
    this.vodVideo.volume = volume;
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

    const muteBtn = document.querySelector('[data-a-target="player-mute-unmute-button"]');
    if (muteBtn) {
      muteBtn.addEventListener(
        'click',
        () => {
          if (!this.isRewinding || !this.vodVideo) return;
          queueMicrotask(() => {
            this.vodVideo.muted = !this.vodVideo.muted;
          });
        },
        true
      );
    }
  }

  onNativeVolumeChange = () => {
    const video = this.mutedVideoRef;
    if (!video || !this.isRewinding || video.volume <= 0) return;
    video._rteLrSavedVolume = video._rteLrSavedVolume || video.volume;
    video.volume = 0;
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
        });
        this.videoObserver.observe(container, {childList: true, subtree: true});
      }
    }
  }

  unmuteNative() {
    this.detachMuteListener();
    if (this.videoObserver) {
      this.videoObserver.disconnect();
      this.videoObserver = null;
    }
  }

  goLive() {
    this.log('Back to live');
    this.isRewinding = false;

    if (this.vodVideo) {
      this.vodVideo.pause();
      this.vodVideo.playbackRate = 1;
    }
    this.hideVodVideo();
    this.unmuteNative();

    requestAnimationFrame(() => {
      const nativeVideo = this.twitchVideo();
      if (nativeVideo?.paused) nativeVideo.play().catch(() => {});
    });

    if (this.ui.seekbar) {
      this.ui.seekbar.played.style.width = '100%';
      this.ui.seekbar.thumb.style.left = '100%';
    }
    document.getElementById('rte-lr-live-label')?.classList.add('rte-lr-live-label--at-live');
    this.syncAudioCompressor(this.twitchVideo());
  }

  startSeekUpdates() {
    this.stopSeekUpdates();
    this.seekInterval = setInterval(() => this.updateSeek(), 500);
  }

  stopSeekUpdates() {
    clearInterval(this.seekInterval);
    this.seekInterval = null;
  }

  updateSeek() {
    const seekArea = document.getElementById('rte-lr-seekbar-area');
    if (seekArea) seekArea.style.display = this.isAdPlaying() ? 'none' : '';

    const total = this.elapsed();
    if (total <= 0) return;

    const {seekbar, curLabel} = this.ui;

    if (this.isRewinding && this.vodVideo) {
      const cur = this.vodVideo.currentTime;
      const pct = (cur / total) * 100;
      if (seekbar) {
        seekbar.el?.classList.remove('rte-lr-seekbar--live');
        seekbar.played.style.width = `${pct}%`;
        seekbar.thumb.style.left = `${pct}%`;
      }
      if (curLabel) curLabel.textContent = formatTime(cur);
    } else {
      if (seekbar) {
        seekbar.el?.classList.add('rte-lr-seekbar--live');
        seekbar.played.style.width = '100%';
        seekbar.thumb.style.left = '100%';
      }
      if (curLabel) curLabel.textContent = formatTime(total);
    }
  }

  updatePlayPauseIcon() {
    const btn = document.querySelector('[data-a-target="player-play-pause-button"]');
    if (!btn || !this.isRewinding || !this.vodVideo) return;
    const svg = btn.querySelector('svg');
    if (!svg) return;
    const paused = this.vodVideo.paused;
    svg.innerHTML = paused
      ? '<path d="M8 5v14l11-7z"></path>'
      : '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"></path>';
    btn.setAttribute('aria-label', paused ? 'Play' : 'Pause');
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
        const match = item.textContent.trim().toLowerCase().match(/([\d.]+)\s*x/);
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

  hookKeyboard() {
    const speedSteps = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
    document.addEventListener('keydown', (event) => {
      if (
        !this.vodId ||
        event.target.tagName === 'INPUT' ||
        event.target.tagName === 'TEXTAREA' ||
        event.target.isContentEditable
      ) {
        return;
      }
      if (!this.isRewinding || !this.vodVideo) return;

      if (event.key === 'ArrowLeft') {
        this.vodVideo.currentTime = this.clampSeek(this.vodVideo.currentTime - SEEK_STEP);
        event.preventDefault();
      } else if (event.key === 'ArrowRight') {
        this.vodVideo.currentTime = this.clampSeek(this.vodVideo.currentTime + SEEK_STEP);
        event.preventDefault();
      } else if (event.key === '>' || event.key === '.') {
        const next = speedSteps.find((step) => step > this.vodVideo.playbackRate);
        if (next) this.vodVideo.playbackRate = next;
        event.preventDefault();
      } else if (event.key === '<' || event.key === ',') {
        const prev = [...speedSteps].reverse().find((step) => step < this.vodVideo.playbackRate);
        if (prev) this.vodVideo.playbackRate = prev;
        event.preventDefault();
      }
    });
  }

  cleanup() {
    this.isRewinding = false;
    if (this.hlsInstance) {
      this.hlsInstance.destroy();
      this.hlsInstance = null;
    }
    this.hlsReady = false;
    if (this.vodVideo) {
      this.vodVideo.remove();
      this.vodVideo = null;
    }
    this.unmuteNative();
    clearInterval(this.vodCheckInterval);
    this.vodCheckInterval = null;
    this.reinjectObserver?.disconnect();
    this.reinjectObserver = null;
    this.removeControls();
    this.channel = null;
    this.vodId = null;
    this.vodCreatedAt = null;
    this.clearVodUrl();
  }
}
