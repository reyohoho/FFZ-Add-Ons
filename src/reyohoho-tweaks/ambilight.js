import LightRenderer from './renderer.js';

const {createElement} = FrankerFaceZ.utilities.dom;

const PLAYER_SELECTOR = '.persistent-player';
const RIGHT_CONTROLS = '.video-player__default-player .player-controls__right-control-group';
const BUTTON_CLASS = 'rte-ambilight-container';
// Turn Twitch's panels into glass while the light is visible (style.css): the whole page normally, only the
// chat column in theatre mode
const ACTIVE_CLASS = 'rte-ambilight-active';
const THEATRE_ACTIVE_CLASS = 'rte-ambilight-theatre';
const FRAME_INTERVAL_MS = 33;
// One light canvas pixel per this many CSS pixels; the blur hides the coarse grid
const LIGHT_SCALE = 8;
// Reach of the light above the player, relative to its height and clamped so big players don't flood the page
const SPREAD_HEIGHT_RATIO = 0.26;
const SPREAD_MIN_PX = 96;
const SPREAD_MAX_PX = 220;
// Light reaches further sideways (onto the side nav and chat) and down than up
const SIDE_SPREAD_FACTOR = 1.3;
const BOTTOM_SPREAD_FACTOR = 1.4;
// Smaller than this the player is the corner mini player while browsing
const MIN_PLAYER_WIDTH = 400;
// Channel tabs (videos, about...) and offline channels show the stream as a scaled banner cropped by the page, which
// the glass would uncover
const CHANNEL_HOME_SELECTOR = '.channel-root--home';
// Dark text over a lit background would be unreadable
const LIGHT_THEME_CLASS = 'tw-root--theme-light';
// In theatre mode the fixed player and chat cover the page, so the light is drawn in a layer of its own inside the
// chat column instead of under the document
const THEATRE_CLASS = 'persistent-player--theatre';
// Only when chat sits beside the player; chat overlaid on the video stays as Twitch draws it
const THEATRE_COLUMN_SELECTOR = '.right-column--theatre.right-column--beside';
// The theatre player keeps the stream's aspect ratio inside a black box: a copy of the light under the video fills
// the bars left around it
const VIDEO_CONTAINER_SELECTOR = '.video-player__container';
// The light turns itself off when the stream drops more than this share of frames over a window while it shines.
// Firefox with hardware acceleration off keeps GPU WebGL but composites the page in software, which no WebGL check
// can see; this also catches GPUs too weak for it
const DROPPED_FRAMES_LIMIT = 0.3;
const DROPPED_FRAMES_WINDOW_MS = 5000;
const DROPPED_FRAMES_MIN_FRAMES = 60;
// A longer gap between drawn frames (hidden tab, pause, hidden light) starts the window over
const DROPPED_FRAMES_MAX_GAP_MS = 2000;

const ICON = '<svg xmlns="http://www.w3.org/2000/svg" height="20" viewBox="0 0 24 24" width="20" fill="currentColor"><path d="M4 6h16v12H4zM2 4v16h20V4zm4 4v8h12V8zM11 0h2v2h-2zm0 22h2v2h-2zM0 11h2v2H0zm22 0h2v2h-2z"/></svg>';

function getVisibleVideo(player) {
	// During Live Rewind the visible frame is in the VOD video overlaid on the native one
	const vodVideo = player.querySelector('video.rte-lr-vod-video');
	if (vodVideo != null && vodVideo.style.display !== 'none')
		return vodVideo;
	return player.querySelector('video:not(.rte-lr-vod-video)');
}

// The part of the video element the frame covers, given object-fit: contain
function getFrameRect(video) {
	const rect = video.getBoundingClientRect();
	if (video.videoWidth === 0 || video.videoHeight === 0)
		return rect;
	const scale = Math.min(rect.width / video.videoWidth, rect.height / video.videoHeight);
	const width = video.videoWidth * scale;
	const height = video.videoHeight * scale;
	return {
		left: rect.left + (rect.width - width) / 2,
		top: rect.top + (rect.height - height) / 2,
		width,
		height
	};
}

export default class Ambilight {
	constructor(addon) {
		this.addon = addon;
		this.canvas = null;
		this.renderer = null;
		// Set when the browser has no hardware accelerated WebGL 2
		this.unsupported = false;
		// Set until the page reloads when the stream dropped too many frames with the light on
		this.tooSlow = false;
		this.framesSample = null;
		this.layout = null;
		this.columnLayer = null;
		this.barsCanvas = null;
		this.sizeKey = null;
		this.player = null;
		this.video = null;
		this.frameRequestVideo = null;
		this.timer = null;
		// Set while the tab was hidden until the video presents a frame again: a background tab stops decoding the
		// video, so on return the light would show around (and through) the empty player before the picture
		this.awaitingFrame = false;
		this.effect = null;
		this.updatePosition = this.updatePosition.bind(this);
		// Only a scroller that contains the player can move it; chat scrolls on every message
		this.handleScroll = event => {
			if (event.target.contains?.(this.player))
				this.updatePosition();
		};
		this.handleVisibility = () => {
			if (document.hidden) {
				this.setVisible(false);
				this.awaitingFrame = true;
			}
		};
	}

	update() {
		const get = key => this.addon.get(`ambilight.${key}`);
		this.effect = {
			brightness: get('brightness'),
			size: get('size'),
			blur: get('blur'),
			saturation: get('saturation'),
			smoothness: get('smoothness'),
			fillBars: get('fill-bars')
		};
		this.applyEffect();

		if (this.addon.isOn('ambilight.enabled') && !this.unsupported && !this.tooSlow) {
			if (this.timer == null) {
				this.timer = setInterval(() => this.draw(), FRAME_INTERVAL_MS);
				// The light is fixed to the viewport, so follow the player on scroll without waiting for the next frame
				document.addEventListener('scroll', this.handleScroll, true);
				document.addEventListener('visibilitychange', this.handleVisibility);
				window.addEventListener('resize', this.updatePosition);
			}
			// Show an effect change right away, also while the stream is paused
			if (this.renderer != null && this.layout != null) {
				this.sizeKey = null;
				this.updatePosition();
			}
		} else {
			clearInterval(this.timer);
			this.timer = null;
			document.removeEventListener('scroll', this.handleScroll, true);
			document.removeEventListener('visibilitychange', this.handleVisibility);
			window.removeEventListener('resize', this.updatePosition);
			this.setVisible(false);
			this.canvas?.remove();
		}

		for (const inst of this.addon.player.Player.instances)
			this.addButton(inst);
	}

	setVisible(visible, theatre = false) {
		this.canvas?.classList.toggle('rte-ambilight--visible', visible);
		this.barsCanvas?.classList.toggle('rte-ambilight--visible', visible);
		document.documentElement.classList.toggle(ACTIVE_CLASS, visible && !theatre);
		document.documentElement.classList.toggle(THEATRE_ACTIVE_CLASS, visible && theatre);
		if (!visible || !theatre) {
			this.columnLayer?.remove();
			this.barsCanvas?.remove();
		}
	}

	// First in the video container, so the video (later in the DOM, also positioned) is drawn over it
	attachBarsCanvas(container) {
		if (this.barsCanvas == null) {
			this.barsCanvas = createElement('canvas', {className: 'rte-ambilight rte-ambilight-bars', 'aria-hidden': 'true'});
			this.applyEffect();
		}
		if (this.barsCanvas.parentElement !== container) {
			container.prepend(this.barsCanvas);
			// Copied on the next render; a paused stream renders only on resize
			this.sizeKey = null;
		}
	}

	renderLight(video) {
		this.renderer.render(video, this.layout, this.effect);
		const bars = this.barsCanvas;
		if (bars?.isConnected) {
			const {width, height} = this.canvas;
			if (bars.width !== width || bars.height !== height) {
				bars.width = width;
				bars.height = height;
			}
			const context = bars.getContext('2d');
			context.clearRect(0, 0, width, height);
			// Same task as the WebGL render, so its drawing buffer is still there to copy
			context.drawImage(this.canvas, 0, 0);
		}
	}

	// Under the whole document normally; inside the chat column in theatre mode
	attachCanvas(column) {
		if (column == null) {
			if (this.canvas.parentElement !== document.body)
				document.body.appendChild(this.canvas);
			return;
		}

		if (this.columnLayer == null)
			this.columnLayer = createElement('div', {className: 'rte-ambilight-column'});
		if (this.columnLayer.parentElement !== column)
			column.prepend(this.columnLayer);
		if (this.canvas.parentElement !== this.columnLayer)
			this.columnLayer.appendChild(this.canvas);
	}

	createCanvas() {
		const canvas = createElement('canvas', {className: 'rte-ambilight', 'aria-hidden': 'true'});
		const renderer = LightRenderer.create(canvas);
		if (renderer == null) {
			this.markUnsupported();
			return false;
		}

		// A GPU reset or driver update drops the context; start over with a new canvas on the next frame
		canvas.addEventListener('webglcontextlost', () => {
			this.setVisible(false);
			canvas.remove();
			this.canvas = null;
			this.renderer = null;
			this.sizeKey = null;
		});
		this.canvas = canvas;
		this.renderer = renderer;
		this.applyEffect();
		return true;
	}

	markUnsupported() {
		this.unsupported = true;
		this.update();
	}

	// Why the light can't be shown right now, for the button tooltip; null when it can
	getUnavailableMessage() {
		if (this.unsupported)
			return this.addon.t('ambilight.unsupported', 'Ambilight needs hardware acceleration (WebGL 2), which is off or unavailable in this browser');
		if (this.tooSlow)
			return this.addon.t('ambilight.too-slow', 'Ambilight is off until the page is reloaded: the stream was dropping frames with it. Check that hardware acceleration is on in the browser settings');
		if (document.documentElement.classList.contains(LIGHT_THEME_CLASS))
			return this.addon.t('ambilight.light-theme', 'Ambilight works only with the dark Twitch theme');
		return null;
	}

	applyEffect() {
		for (const canvas of [this.canvas, this.barsCanvas])
			canvas?.style.setProperty('--rte-ambilight-opacity', `${this.effect.brightness / 100}`);
	}

	updatePosition() {
		if (this.canvas == null || this.player == null)
			return;

		// From the frame rather than the player, so the light also starts at the edge of a picture with bars around it
		const rect = this.effect.fillBars ? getFrameRect(this.video) : this.player.getBoundingClientRect();
		const spread =
			Math.min(Math.max(rect.height * SPREAD_HEIGHT_RATIO, SPREAD_MIN_PX), SPREAD_MAX_PX) * (this.effect.size / 100);
		const side = spread * SIDE_SPREAD_FACTOR;
		const bottom = spread * BOTTOM_SPREAD_FACTOR;
		const width = rect.width + side * 2;
		const height = rect.height + spread + bottom;

		// In theatre mode the canvas is positioned inside the chat column layer rather than the viewport
		const host = this.canvas.parentElement === this.columnLayer ? this.columnLayer.getBoundingClientRect() : null;
		const {style} = this.canvas;
		style.left = `${rect.left - side - (host?.left ?? 0)}px`;
		style.top = `${rect.top - spread - (host?.top ?? 0)}px`;
		style.width = `${width}px`;
		style.height = `${height}px`;
		if (this.barsCanvas?.isConnected) {
			const container = this.barsCanvas.parentElement.getBoundingClientRect();
			Object.assign(this.barsCanvas.style, {
				left: `${rect.left - side - container.left}px`,
				top: `${rect.top - spread - container.top}px`,
				width: style.width,
				height: style.height
			});
		}

		// Scrolling only moves the box; resize the canvas only when the size changes
		const canvasWidth = Math.max(1, Math.round(width / LIGHT_SCALE));
		const canvasHeight = Math.max(1, Math.round(height / LIGHT_SCALE));
		const sizeKey = `${canvasWidth}x${canvasHeight}:${Math.round(spread)}`;
		if (sizeKey === this.sizeKey)
			return;

		this.sizeKey = sizeKey;
		this.layout = {
			inner: [side, spread, side + rect.width, spread + rect.height].map(value => value / LIGHT_SCALE),
			reach: [side, spread, bottom].map(value => value / LIGHT_SCALE),
			scale: LIGHT_SCALE
		};
		// Resizing clears the canvas: redraw the last frame so a paused stream keeps its light
		this.renderer.resize(canvasWidth, canvasHeight);
		this.renderLight(null);
	}

	draw() {
		if (document.hidden)
			return;

		const player = document.querySelector(PLAYER_SELECTOR);
		const video = player != null ? getVisibleVideo(player) : null;
		const theatre = player?.classList.contains(THEATRE_CLASS) === true;
		const column = theatre ? document.querySelector(THEATRE_COLUMN_SELECTOR) : null;
		if (
			video == null ||
			player.offsetWidth < MIN_PLAYER_WIDTH ||
			(theatre && column == null) ||
			document.fullscreenElement != null ||
			document.querySelector(CHANNEL_HOME_SELECTOR) != null ||
			document.documentElement.classList.contains(LIGHT_THEME_CLASS) ||
			// No frame (e.g. ~1s while switching channels): the video is transparent and the glass player would show
			// the previous stream's light through it
			video.readyState < 2
		) {
			this.setVisible(false);
			return;
		}

		if (this.canvas == null && !this.createCanvas())
			return;
		this.attachCanvas(column);
		const container = theatre && this.effect.fillBars ? video.closest(VIDEO_CONTAINER_SELECTOR) : null;
		if (container != null)
			this.attachBarsCanvas(container);
		else
			this.barsCanvas?.remove();

		this.player = player;
		this.video = video;
		this.updatePosition();

		// Keep the last light while paused, but follow a switch into or out of theatre mode
		if (video.paused) {
			this.setVisible(this.canvas.classList.contains('rte-ambilight--visible'), theatre);
			return;
		}

		if (this.awaitingFrame) {
			if (this.frameRequestVideo !== video && video.requestVideoFrameCallback != null) {
				this.frameRequestVideo = video;
				video.requestVideoFrameCallback(() => {
					this.awaitingFrame = false;
					this.frameRequestVideo = null;
				});
				return;
			}
			if (this.frameRequestVideo === video)
				return;
			this.awaitingFrame = false;
		}

		try {
			this.renderLight(video);
		} catch (_) {
			return;
		}
		this.setVisible(true, theatre);
		this.checkDroppedFrames(video);
	}

	checkDroppedFrames(video) {
		const {droppedVideoFrames, totalVideoFrames} = video.getVideoPlaybackQuality();
		const now = performance.now();
		const sample = this.framesSample;
		if (
			sample == null ||
			sample.video !== video ||
			now - sample.last > DROPPED_FRAMES_MAX_GAP_MS ||
			totalVideoFrames < sample.total
		) {
			this.framesSample = {video, start: now, last: now, dropped: droppedVideoFrames, total: totalVideoFrames};
			return;
		}

		sample.last = now;
		if (now - sample.start < DROPPED_FRAMES_WINDOW_MS)
			return;

		this.framesSample = null;
		const total = totalVideoFrames - sample.total;
		const dropped = droppedVideoFrames - sample.dropped;
		if (total >= DROPPED_FRAMES_MIN_FRAMES && dropped / total > DROPPED_FRAMES_LIMIT) {
			this.addon.log.warn(`Ambilight turned off, the stream dropped ${dropped} of ${total} frames with it`);
			this.tooSlow = true;
			this.update();
		}
	}

	addButton(inst) {
		const outer = inst.props.containerRef || this.addon.fine.getChildNode(inst);
		const container = outer?.querySelector?.(this.addon.player.RIGHT_CONTROLS || RIGHT_CONTROLS);
		let wrapper = container?.querySelector(`.${BUTTON_CLASS}`);

		if (!this.addon.isOn('ambilight.button')) {
			wrapper?.remove();
			return;
		}
		if (!container)
			return;

		if (!wrapper) {
			let button, tip;
			wrapper = (<div class={`${BUTTON_CLASS} tw-inline-flex tw-relative ffz-il-tooltip__container`}>
				{button = (<button
					class="rte-ambilight-button tw-align-items-center tw-align-middle tw-border-bottom-left-radius-medium tw-border-bottom-right-radius-medium tw-border-top-left-radius-medium tw-border-top-right-radius-medium tw-button-icon tw-button-icon--overlay ffz-core-button ffz-core-button--border ffz-core-button--overlay tw-inline-flex tw-interactive tw-justify-content-center tw-overflow-hidden tw-relative"
					type="button"
					aria-label={this.addon.t('ambilight.button', 'Ambilight')}
				/>)}
				{tip = (<div class="ffz-il-tooltip ffz-il-tooltip--align-right ffz-il-tooltip--up" role="tooltip" />)}
			</div>);
			button.innerHTML = ICON;

			button.addEventListener('click', () => {
				if (!this.unsupported && this.renderer == null && !LightRenderer.isSupported())
					this.markUnsupported();
				// The tooltip explains why instead of toggling a light that would never show
				if (this.getUnavailableMessage() == null)
					this.addon.setValue('addon.reyohoho-tweaks.ambilight.enabled', !this.addon.get('ambilight.enabled'));
			});
			button.addEventListener('contextmenu', event => {
				event.preventDefault();
				this.addon.openSettings();
			});
			// Checked on hover: the theme can change without a reload
			wrapper.addEventListener('mouseenter', () => {
				const message = this.getUnavailableMessage();
				tip.textContent = message ?? this.addon.t('ambilight.tooltip', 'Ambilight (right click for settings)');
				tip.classList.toggle('rte-ambilight-tooltip--hint', message != null);
			});

			// Users expect theatre mode right before fullscreen, so the light goes in front of both
			let before = this.addon.player.findTheatreButton(container) ??
				container.querySelector('button[data-a-target="player-fullscreen-button"]');
			while (before?.parentElement && before.parentElement !== container)
				before = before.parentElement;
			container.insertBefore(wrapper, before?.parentElement === container ? before : null);
		}

		wrapper.querySelector('button').classList.toggle(
			'rte-ambilight-button--active',
			this.addon.isOn('ambilight.enabled') && !this.unsupported && !this.tooSlow
		);
	}
}
