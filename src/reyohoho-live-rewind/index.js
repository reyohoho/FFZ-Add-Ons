import LiveRewindController from './rewind-controller.js';
import {hasRteSubscription, invalidateVipAccessCache, openSubscriptionPage} from './vip-access.js';
import STYLE_URL from './style.css';

const createElement = FrankerFaceZ.utilities.dom.createElement;

const SETTING_PREFIX = 'addon.reyohoho-live-rewind';

class ReyohohoLiveRewind extends Addon {
	constructor(...args) {
		super(...args);

		this.inject('settings');
		this.inject('i18n');
		this.inject('site');

		this.load_requires = ['site'];

		this.controller = null;
		this.hasAccess = false;
		this.ready = false;
		this._contextHandler = null;
		this._onSettingChange = null;
		this._proxyBase = null;
		this._styleLink = null;
		this._bootstrapping = false;
		this._settingsRegistered = false;
		this._ensureReadyPromise = null;
	}

	async onLoad() {
		await this._waitForProxyBase();
	}

	onEnable() {
		this._injectCSS();
		this._bootstrapping = true;
		this._registerSettings();
		this._onSettingChange = () => this._syncController();
		this.settings.on(`changed.${SETTING_PREFIX}.enabled`, this._onSettingChange, this);
		this.settings.on(`changed.${SETTING_PREFIX}.user-set`, this._onSettingChange, this);

		void this.ensureReady().finally(() => {
			this._bootstrapping = false;
		});

		this._startContextWatcher();
	}

	onDisable() {
		this._removeCSS();
		this._stopContextWatcher();
		if (this._onSettingChange) {
			this.settings.off(`changed.${SETTING_PREFIX}.enabled`, this._onSettingChange, this);
			this.settings.off(`changed.${SETTING_PREFIX}.user-set`, this._onSettingChange, this);
			this._onSettingChange = null;
		}
		this._revokeAccess();
		this.ready = false;
		this._bootstrapping = false;
		this._ensureReadyPromise = null;
	}

	// ================================================================
	//  Settings
	// ================================================================

	_isSettingEnabled() {
		if (!this.settings.get(`${SETTING_PREFIX}.user-set`)) {
			return true;
		}
		return !!this.settings.get(`${SETTING_PREFIX}.enabled`);
	}

	_setSettingEnabled(value) {
		this.settings.set(`${SETTING_PREFIX}.user-set`, true);
		this.settings.set(`${SETTING_PREFIX}.enabled`, value);
	}

	_registerSettings() {
		if (this._settingsRegistered) {
			return;
		}
		this._settingsRegistered = true;

		this.settings.add(`${SETTING_PREFIX}.enabled`, {
			default: true,
			ui: {
				sort: 0,
				path: 'Add-Ons > ReYohoho Live Rewind',
				title: this._t(
					'addon.reyohoho-live-rewind.setting.title',
					'Live stream rewind (RTE Sub)'
				),
				description: this._t(
					'addon.reyohoho-live-rewind.setting.description',
					'Adds a seek bar on live streams via the channel VOD recording. The streamer must have VOD storage enabled.\n\n' +
					'**Available to RTE subscribers only.** [Subscribe](https://ext.rte.net.ru)'
				),
				component: 'setting-check-box'
			},
			changed: (val) => this._onEnabledChanged(val)
		});

		this.settings.add(`${SETTING_PREFIX}.user-set`, {
			default: false,
			hidden: true
		});
	}

	_onEnabledChanged(value) {
		if (this._bootstrapping) {
			return;
		}

		this.settings.set(`${SETTING_PREFIX}.user-set`, true);

		if (value && !this.hasAccess) {
			void this.ensureReady(true).then(() => {
				if (!this.hasAccess) {
					this._revokeAccess();
					this.settings.set(`${SETTING_PREFIX}.enabled`, false);
					openSubscriptionPage();
				} else {
					this._syncController();
				}
			});
			return;
		}

		if (!value) {
			this._stopRewind();
			return;
		}

		this._syncController();
	}

	_injectCSS() {
		if (this._styleLink || document.getElementById('rte-live-rewind-style')) {
			return;
		}

		this._styleLink = document.head.appendChild(createElement('link', {
			id: 'rte-live-rewind-style',
			href: STYLE_URL,
			rel: 'stylesheet',
			type: 'text/css',
			crossOrigin: 'anonymous'
		}));
	}

	_removeCSS() {
		document.getElementById('rte-live-rewind-style')?.remove();
		this._styleLink = null;
	}

	// ================================================================
	//  Proxy / VIP access
	// ================================================================

	async _waitForProxyBase() {
		for (let i = 0; i < 30; i++) {
			const proxy = this.resolve('addon.reyohoho-emotes-proxy');
			if (proxy?._proxyBase) {
				this._proxyBase = proxy._proxyBase;
				return this._proxyBase;
			}
			await new Promise((r) => setTimeout(r, 1000));
		}
		return null;
	}

	_getUserId() {
		return this.site?.getUser?.()?.id || null;
	}

	async _checkAccess(forceRefresh = false) {
		if (!this._proxyBase) {
			this._proxyBase = await this._waitForProxyBase();
		}

		const twitchId = this._getUserId();
		if (!this._proxyBase || !twitchId) {
			return false;
		}

		return hasRteSubscription(this._proxyBase, twitchId, forceRefresh);
	}

	// ================================================================
	//  Controller lifecycle
	// ================================================================

	async ensureReady(forceAccessCheck = false) {
		if (this._ensureReadyPromise) {
			await this._ensureReadyPromise;
			if (!forceAccessCheck) {
				return;
			}
		}

		this._ensureReadyPromise = this._runEnsureReady(forceAccessCheck);

		try {
			await this._ensureReadyPromise;
		} finally {
			this._ensureReadyPromise = null;
		}
	}

	async _runEnsureReady(forceAccessCheck = false) {
		if (!this._isSettingEnabled()) {
			this.ready = true;
			this._stopRewind();
			return;
		}

		if (forceAccessCheck || !this.hasAccess) {
			this.hasAccess = await this._checkAccess(forceAccessCheck);
		}

		if (!this.hasAccess) {
			this.ready = true;
			this._revokeAccess();
			return;
		}

		if (!this.controller) {
			this.controller = new LiveRewindController({
				log: (...args) => this.log.info(...args),
				syncAudio: (video) => this._syncAudioCompressor(video),
				canUseRewind: () => this.hasAccess && this._isSettingEnabled()
			});
		}

		if (this._isSettingEnabled() && !this.controller.hooksAttached) {
			this.controller.start();
		} else if (this.controller.hooksAttached) {
			this.controller.onPlayerReady();
		}

		this.ready = true;
	}

	_stopRewind() {
		this._stopController();
		this.controller = null;
	}

	_revokeAccess() {
		invalidateVipAccessCache();
		this.hasAccess = false;
		this._stopRewind();
	}

	_syncController() {
		if (!this._isSettingEnabled()) {
			this._stopRewind();
			return;
		}

		if (!this.hasAccess) {
			void this.ensureReady(true);
			return;
		}

		if (!this.controller) {
			void this.ensureReady(true);
			return;
		}

		if (!this.controller.canUseRewind?.()) {
			this._revokeAccess();
			void this.ensureReady(true);
			return;
		}

		this.controller.setEnabled(true);
		if (!this.controller.hooksAttached) {
			this.controller.start();
		} else {
			this.controller.onPlayerReady();
		}
	}

	_stopController() {
		if (this.controller) {
			this.controller.stop();
		}
	}

	exitLiveRewindIfActive() {
		if (this.controller?.isRewinding) {
			this.controller.goLive();
		}
	}

	// ================================================================
	//  Twitch navigation / player hooks
	// ================================================================

	_startContextWatcher() {
		this._stopContextWatcher();
		this._contextHandler = () => {
			void this.ensureReady(true);
		};
		this.settings.main_context.on('context_changed', this._contextHandler);
	}

	_stopContextWatcher() {
		if (this._contextHandler) {
			this.settings.main_context.off('context_changed', this._contextHandler);
			this._contextHandler = null;
		}
	}

	_t(key, defaultMessage, opts) {
		return this.i18n.t(key, defaultMessage, opts);
	}

	_syncAudioCompressor(video) {
		try {
			const player = this.resolve('site.player');
			if (!player?.settings?.get?.('player.compressor.enable')) {
				return;
			}

			for (const inst of player.Player?.instances || []) {
				player.compressPlayer(inst);
			}

			if (video && video._ffz_compressor == null) {
				const nativeVideo = this.controller?.twitchVideo?.();
				if (nativeVideo?._ffz_compressor) {
					video._ffz_maybe_compress = nativeVideo._ffz_compressed;
				}
			}
		} catch (error) {
			this.log.warn('Audio compressor sync failed:', error);
		}
	}
}

ReyohohoLiveRewind.register();
