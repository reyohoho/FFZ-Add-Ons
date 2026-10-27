const TICK_MS = 500;
// After a stall the Twitch player grows its buffer on purpose; speeding up then just causes the next stall
const STALL_COOLDOWN_MS = 30000;
const START_MARGIN_SECONDS = 0.75;
const MIN_BUFFER_TO_START = 2;
const MIN_BUFFER_TO_CONTINUE = 1;

// The native accessor: Twitch's own catch-up and FFZ's player.allow-catchup put their own playbackRate property on
// the video, which must not see our writes
const playbackRate = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate');

export default class LiveCatchup {
	constructor(addon) {
		this.addon = addon;
		this.interval = null;
		this.video = null;
		this.rate = 1;
		this.catchingUp = false;
		this.lastStallAt = 0;
		this.handleStall = () => {
			this.lastStallAt = Date.now();
			this.stop();
		};
		// The player writes playbackRate itself (1.0 or ~1.03 for its own catch-up); put ours back while catching up
		this.handleRateChange = () => {
			if (this.catchingUp && playbackRate.get.call(this.video) !== this.rate)
				playbackRate.set.call(this.video, this.rate);
		};
	}

	update() {
		const enabled = this.addon.isOn('live-catchup.enabled');
		if (enabled && this.interval == null) {
			this.interval = setInterval(() => this.tick(), TICK_MS);
		} else if (!enabled && this.interval != null) {
			clearInterval(this.interval);
			this.interval = null;
			this.attach(null);
		}
	}

	attach(video) {
		if (this.video === video)
			return;
		if (this.video != null) {
			this.stop();
			this.video.removeEventListener('waiting', this.handleStall);
			this.video.removeEventListener('ratechange', this.handleRateChange);
		}
		this.video = video;
		this.lastStallAt = Date.now();
		if (video != null) {
			video.addEventListener('waiting', this.handleStall);
			video.addEventListener('ratechange', this.handleRateChange);
		}
	}

	start() {
		this.catchingUp = true;
		this.rate = this.addon.get('live-catchup.rate');
		playbackRate.set.call(this.video, this.rate);
	}

	stop() {
		if (!this.catchingUp)
			return;
		this.catchingUp = false;
		playbackRate.set.call(this.video, 1);
	}

	getPlayerCore(video) {
		for (const inst of this.addon.player.Player.instances) {
			const outer = inst.props.containerRef || this.addon.fine.getChildNode(inst);
			if (!outer?.contains?.(video))
				continue;
			const instance = inst.props.mediaPlayerInstance;
			const player = instance?.playerInstance ?? instance;
			return player?.core ?? player;
		}
		return null;
	}

	tick() {
		const video = document.querySelector('.video-player__container video:not(.rte-lr-vod-video)');
		this.attach(video);
		if (video == null)
			return;

		const core = this.getPlayerCore(video);
		const isLive =
			typeof core?.getLiveLatency === 'function' &&
			// VODs and clips have a finite duration, live streams none or Infinity
			!Number.isFinite(core.getDuration?.()) &&
			!window.location.pathname.startsWith('/videos/');

		if (
			!isLive ||
			video.paused ||
			document.hidden ||
			core.getState?.() !== 'Playing' ||
			this.addon.resolve('addon.reyohoho-live-rewind')?.controller?.isRewinding
		) {
			this.stop();
			return;
		}

		const latency = core.getLiveLatency();
		const buffer = core.getBufferDuration?.() ?? 0;
		const target = this.addon.get('live-catchup.target');

		if (this.catchingUp) {
			if (latency <= target || buffer < MIN_BUFFER_TO_CONTINUE)
				this.stop();
			return;
		}

		if (
			latency > target + START_MARGIN_SECONDS &&
			buffer >= MIN_BUFFER_TO_START &&
			Date.now() - this.lastStallAt > STALL_COOLDOWN_MS
		)
			this.start();
	}
}
