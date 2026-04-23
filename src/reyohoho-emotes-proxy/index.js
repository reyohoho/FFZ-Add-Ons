const STAREGE_DOMAINS = [
	'https://starege.rte.net.ru',
	'https://starege3.rte.net.ru',
	'https://starege5.rte.net.ru',
	'https://starege4.rte.net.ru',
];

const SERVICE_HOSTS = {
	'7tv': ['7tv.io', '7tv.app', 'cdn.7tv.app'],
	'bttv': ['api.betterttv.net', 'cdn.betterttv.net'],
	'ffz': ['cdn.frankerfacez.com', 'api.frankerfacez.com', 'api2.frankerfacez.com'],
};

const API_HOSTS = new Set([
	'7tv.io',
	'api.betterttv.net',
	'api.frankerfacez.com',
	'api2.frankerfacez.com',
]);

const SETTING_PREFIX = 'addon.reyohoho-emotes-proxy';
const BADGE_PROVIDER = 'addon.reyohoho-emotes-proxy';
const BADGE_CACHE_TTL = 5 * 60 * 1000;
const PAINT_CACHE_TTL = 5 * 60 * 1000;

class EmotesProxy extends Addon {
	constructor(...args) {
		super(...args);

		this.inject('settings');
		this.inject('i18n');
		this.inject('chat');
		this.inject('chat.badges');

		this._proxyBase = null;
		this._origFetch = null;
		this._bypassCacheUntil = 0;

		this._badgeCache = new Map();
		this._badgePending = new Set();
		this._badgeUrls = new Map();

		this._paintDefs = new Map();
		this._userPaintCache = new Map();
		this._paintPending = new Set();
		this._paintSheet = null;
	}

	async onLoad() {
		try {
			this._proxyBase = await this._findFastestDomain();
		} catch {
			this._proxyBase = null;
		}

		if (this._proxyBase)
			this.log.info(`Using proxy domain: ${this._proxyBase}`);
		else
			this.log.warn('All proxy domains unavailable, proxy disabled');
	}

	onEnable() {
		this.settings.add(`${SETTING_PREFIX}.enabled`, {
			default: true,
			ui: {
				sort: 0,
				path: 'Add-Ons > ReYohoho Emotes Proxy',
				title: 'Enable Proxy',
				description: 'Proxy API and CDN requests through the fastest available RTE mirror. The endpoint is selected automatically on startup.',
				component: 'setting-check-box'
			}
		});

		this.settings.add(`${SETTING_PREFIX}.7tv-enabled`, {
			default: true,
			ui: {
				sort: 1,
				path: 'Add-Ons > ReYohoho Emotes Proxy >> Services',
				title: '7TV',
				description: 'Proxy 7TV API and CDN requests (7tv.io, 7tv.app, cdn.7tv.app)',
				component: 'setting-check-box'
			}
		});

		this.settings.add(`${SETTING_PREFIX}.bttv-enabled`, {
			default: true,
			ui: {
				sort: 2,
				path: 'Add-Ons > ReYohoho Emotes Proxy >> Services',
				title: 'BTTV',
				description: 'Proxy BetterTTV API and CDN requests (api.betterttv.net, cdn.betterttv.net)',
				component: 'setting-check-box'
			}
		});

		this.settings.add(`${SETTING_PREFIX}.ffz-enabled`, {
			default: true,
			ui: {
				sort: 3,
				path: 'Add-Ons > ReYohoho Emotes Proxy >> Services',
				title: 'FFZ',
				description: 'Proxy FrankerFaceZ API and CDN requests (cdn.frankerfacez.com, api.frankerfacez.com, api2.frankerfacez.com)',
				component: 'setting-check-box'
			}
		});

		this.settings.add(`${SETTING_PREFIX}.badges`, {
			default: true,
			ui: {
				sort: 10,
				path: 'Add-Ons > ReYohoho Emotes Proxy >> Badges',
				title: 'ReYohoho Badges',
				description: 'Show custom ReYohoho badges in chat.\n\n(Per-badge visibility can be set in [Chat >> Badges > Visibility > Add-Ons](~chat.badges.tabs.visibility))',
				component: 'setting-check-box'
			},
			changed: () => this._toggleBadges()
		});

		this.settings.add(`${SETTING_PREFIX}.paints`, {
			default: true,
			ui: {
				sort: 20,
				path: 'Add-Ons > ReYohoho Emotes Proxy >> Paints',
				title: 'RTE Nametag Paints',
				description: 'Show custom RTE username paints (gradients & images) in chat.',
				component: 'setting-check-box'
			},
			changed: () => this._togglePaints()
		});

		this._installFetchInterceptor();

		this.chat.addTokenizer({
			type: 'reyohoho-badge',
			process: this._onBadgeMessage.bind(this)
		});

		this.chat.addTokenizer({
			type: 'reyohoho-paint',
			priority: 100,
			process: this._onPaintMessage.bind(this)
		});

		this.resolve('tooltips')?.define('reyohoho-paint', target => {
			const paintId = target?.dataset?.rtePaintId;
			const paint = this._paintDefs.get(paintId);
			if (!paint?.name) return FrankerFaceZ.utilities.tooltip.NoContent;
			const source = paint._source === '7tv' ? '7TV' : 'RTE';
			return FrankerFaceZ.utilities.dom.createElement('span', null, `${source} Paint: ${paint.name}`);
		});

		this._registerCurrentUser();
		this._preloadPaints();
	}

	onDisable() {
		this._removeFetchInterceptor();
		this.chat.removeTokenizer('reyohoho-badge');
		this.chat.removeTokenizer('reyohoho-paint');
		this._cleanupBadges();
		this._cleanupPaints();
	}

	// ================================================================
	//  Proxy
	// ================================================================

	isEnabled() {
		return this.settings.get(`${SETTING_PREFIX}.enabled`);
	}

	isServiceEnabled(service) {
		return this.settings.get(`${SETTING_PREFIX}.${service}-enabled`) ?? false;
	}

	getProxyUrl() {
		if (!this.isEnabled() || !this._proxyBase) return null;
		return `${this._proxyBase}/`;
	}

	applyProxy(url, service) {
		if (!this._proxyBase || !this.isEnabled()) return url;

		if (service) {
			if (!this.isServiceEnabled(service)) return url;
		} else {
			service = this._detectService(url);
			if (!service || !this.isServiceEnabled(service)) return url;
		}

		if (url.startsWith('//'))
			return `${this._proxyBase}/https:${url}`;

		if (url.startsWith('http'))
			return `${this._proxyBase}/${url}`;

		return url;
	}

	_detectService(url) {
		for (const [service, hosts] of Object.entries(SERVICE_HOSTS)) {
			if (hosts.some(h => url.includes(h)))
				return service;
		}
		return null;
	}

	_isApiHost(url) {
		for (const host of API_HOSTS) {
			if (url.includes(host))
				return true;
		}
		return false;
	}

	_installFetchInterceptor() {
		if (this._origFetch) return;

		this._origFetch = window.fetch;
		const self = this;

		window.fetch = function(input, init) {
			if (self._proxyBase && self.isEnabled()) {
				const url = typeof input === 'string'
					? input
					: (input instanceof Request ? input.url : '');

				const service = self._detectService(url);
				if (service && self.isServiceEnabled(service)) {
					let proxied = url.startsWith('//')
						? `${self._proxyBase}/https:${url}`
						: `${self._proxyBase}/${url}`;

					if (Date.now() < self._bypassCacheUntil && self._isApiHost(url))
						proxied += (proxied.includes('?') ? '&' : '?') + '_t=' + Date.now();

					if (typeof input === 'string')
						input = proxied;
					else if (input instanceof Request)
						input = new Request(proxied, input);
				}
			}

			return self._origFetch.call(window, input, init);
		};
	}

	enableCacheBypass(duration = 30000) {
		this._bypassCacheUntil = Math.max(this._bypassCacheUntil, Date.now() + duration);
		this.log?.info?.(`Cache bypass enabled for ${duration}ms`);
	}

	_removeFetchInterceptor() {
		if (!this._origFetch) return;
		window.fetch = this._origFetch;
		this._origFetch = null;
	}

	async _findFastestDomain() {
		const probes = STAREGE_DOMAINS.map(async domain => {
			const ctrl = new AbortController();
			const timer = setTimeout(() => ctrl.abort(), 3000);
			try {
				const resp = await fetch(`${domain}/https://google.com`, {
					method: 'HEAD',
					signal: ctrl.signal
				});
				clearTimeout(timer);
				if (!resp.ok) throw new Error('not ok');
				return domain;
			} catch (err) {
				clearTimeout(timer);
				throw err;
			}
		});

		return Promise.any(probes);
	}

	// ================================================================
	//  Badges
	// ================================================================

	_onBadgeMessage(tokens, msg) {
		const user = msg?.user;
		if (!user?.id || !this._proxyBase)
			return tokens;
		if (!this.settings.get(`${SETTING_PREFIX}.badges`))
			return tokens;

		const cached = this._badgeCache.get(user.id);
		if (cached && Date.now() - cached.ts < BADGE_CACHE_TTL)
			return tokens;

		if (this._badgePending.has(user.id))
			return tokens;

		this._fetchBadge(user.id, user.login);
		return tokens;
	}

	async _fetchBadge(userId, userLogin) {
		if (this._badgePending.has(userId))
			return;

		this._badgePending.add(userId);
		try {
			const resp = await fetch(`${this._proxyBase}/api/badge-users/${userId}`);

			if (resp.status === 204 || !resp.ok) {
				this._badgeCache.set(userId, {badgeId: null, ts: Date.now()});
				return;
			}

			const data = await resp.json();
			if (!data?.badgeUrl) {
				this._badgeCache.set(userId, {badgeId: null, ts: Date.now()});
				return;
			}

			const badgeId = this._ensureBadgeDef(data.badgeUrl);
			this._badgeCache.set(userId, {badgeId, ts: Date.now()});

			if (!this.settings.get(`${SETTING_PREFIX}.badges`))
				return;

			this.chat.getUser(userId, userLogin).addBadge(BADGE_PROVIDER, badgeId);
			this.emit('chat:update-lines-by-user', userId, userLogin, false, true);
		} catch (err) {
			this.log.warn(`Badge fetch failed for ${userId}:`, err);
			this._badgeCache.set(userId, {badgeId: null, ts: Date.now()});
		} finally {
			this._badgePending.delete(userId);
		}
	}

	_ensureBadgeDef(url) {
		const existing = this._badgeUrls.get(url);
		if (existing)
			return existing;

		const id = `addon.reyohoho-emotes-proxy.badge-${this._badgeUrls.size}`;
		this._badgeUrls.set(url, id);

		this.badges.loadBadgeData(id, {
			id,
			title: 'ReYohoho',
			slot: 70,
			image: url,
			urls: {1: url, 2: url, 4: url},
			click_url: 'https://t.me/ReYohoho',
			no_invert: true
		});

		return id;
	}

	_toggleBadges() {
		const enabled = this.settings.get(`${SETTING_PREFIX}.badges`);
		if (!enabled) {
			for (const user of this.chat.iterateUsers())
				user.removeAllBadges(BADGE_PROVIDER);
		} else {
			for (const [userId, cache] of this._badgeCache) {
				if (cache.badgeId)
					this.chat.getUser(userId).addBadge(BADGE_PROVIDER, cache.badgeId);
			}
		}
		this.emit('chat:update-lines');
	}

	_cleanupBadges() {
		for (const user of this.chat.iterateUsers())
			user.removeAllBadges(BADGE_PROVIDER);

		for (const badgeId of this._badgeUrls.values())
			this.badges.removeBadge(badgeId, false);

		this._badgeUrls.clear();
		this._badgeCache.clear();
		this.badges.buildBadgeCSS();
		this.emit('chat:update-lines');
	}

	async _registerCurrentUser() {
		if (!this._proxyBase) return;
		try {
			const site = this.resolve('site');
			const user = site?.getUser?.();
			if (!user?.id) return;

			await fetch(`${this._proxyBase}/api/badge-users`, {
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify({userId: user.id})
			});
		} catch (err) {
			this.log.warn('Failed to register current user for badges:', err);
		}
	}

	// ================================================================
	//  Paints
	// ================================================================

	_onPaintMessage(tokens, msg) {
		const user = msg?.user;
		const userId = user?.userID || user?.id;
		if (!userId || !this._proxyBase)
			return tokens;
		if (!this.settings.get(`${SETTING_PREFIX}.paints`))
			return tokens;
		if (msg.ffz_user_props?.['data-seventv-paint-id'])
			return tokens;

		const cached = this._userPaintCache.get(userId);
		if (cached && Date.now() - cached.ts < PAINT_CACHE_TTL) {
			if (cached.paintId)
				this._applyPaintToMsg(msg, cached.paintId);
			return tokens;
		}

		if (!this._paintPending.has(userId))
			this._fetchUserPaint(userId);

		return tokens;
	}

	_applyPaintToMsg(msg, paintId) {
		msg.ffz_user_class = msg.ffz_user_class || new Set();
		msg.ffz_user_class.add('rte-paint');
		msg.ffz_user_class.add('rte-painted-content');
		msg.ffz_user_class.add('ffz-tooltip');
		msg.ffz_user_class.add('ffz-tooltip--no-mouse');

		msg.ffz_user_props = {
			...msg.ffz_user_props,
			'data-rte-paint-id': paintId,
			'data-rte-painted-text': 'true',
			'data-tooltip-type': 'reyohoho-paint'
		};
	}

	async _preloadPaints() {
		if (!this._proxyBase) return;
		try {
			const resp = await fetch(`${this._proxyBase}/api/paints`);
			if (!resp.ok) return;
			const json = await resp.json();
			for (const p of json.paints || []) {
				if (p?.id) {
					this._paintDefs.set(p.id, p);
					this._ensurePaintCSS(p);
				}
			}
		} catch (err) {
			this.log.warn('Failed to preload paints:', err);
		}
	}

	async _fetchUserPaint(userId) {
		if (this._paintPending.has(userId)) return;
		this._paintPending.add(userId);

		try {
			const resp = await fetch(`${this._proxyBase}/api/paint/${userId}`);
			if (!resp.ok) {
				this._userPaintCache.set(userId, {paintId: null, ts: Date.now()});
				return;
			}

			const data = await resp.json();
			if (!data?.has_paint || !data?.paint_id) {
				this._userPaintCache.set(userId, {paintId: null, ts: Date.now()});
				return;
			}

			const paintId = data.paint_id;
			this._userPaintCache.set(userId, {paintId, ts: Date.now()});

			if (!this._paintDefs.has(paintId))
				await this._fetchPaintDef(paintId);

			if (!this.settings.get(`${SETTING_PREFIX}.paints`))
				return;

			this._updatePaintLines(userId);
		} catch (err) {
			this.log.warn(`Paint fetch failed for ${userId}:`, err);
			this._userPaintCache.set(userId, {paintId: null, ts: Date.now()});
		} finally {
			this._paintPending.delete(userId);
		}
	}

	async _fetchPaintDef(paintId) {
		if (this._paintDefs.has(paintId)) return;
		try {
			const resp = await fetch(`${this._proxyBase}/api/paints/${paintId}`);
			if (!resp.ok) return;
			const paint = await resp.json();
			if (paint?.id) {
				this._paintDefs.set(paint.id, paint);
				this._ensurePaintCSS(paint);
			}
		} catch (err) {
			this.log.warn(`Paint def fetch failed for ${paintId}:`, err);
		}
	}

	// ---- Paint CSS ----

	_getPaintSheet() {
		if (this._paintSheet) return this._paintSheet;

		const s = document.createElement('style');
		s.id = 'rte-paint-styles';
		document.head.appendChild(s);

		s.sheet.insertRule('.rte-painted-content { background-color: currentcolor; }');
		s.sheet.insertRule('.rte-painted-content > .chat-author__intl-login { opacity: 1; }');
		s.sheet.insertRule(`[data-rte-painted-text="true"] {
			-webkit-text-fill-color: transparent;
			background-clip: text !important;
			-webkit-background-clip: text !important;
			font-weight: 700;
		}`);

		this._paintSheet = s.sheet;
		return this._paintSheet;
	}

	_ensurePaintCSS(paint) {
		if (!paint?.id) return;

		if (!paint.gradients?.length && paint.function) {
			paint.gradients = [{
				function: paint.function,
				canvas_repeat: '',
				size: [1, 1],
				shape: paint.shape,
				image_url: paint.image_url,
				stops: paint.stops ?? [],
				repeat: paint.repeat ?? false,
				angle: paint.angle,
			}];
		}

		if (!paint.gradients?.length) return;

		const gradients = paint.gradients.map(g => this._createGradient(g));
		const filter = paint.shadows
			? paint.shadows.map(s => this._createDropShadow(s)).join(' ')
			: '';

		const selector = `.rte-paint[data-rte-paint-id="${paint.id}"]`;
		const rule = `${selector} {
			color: ${paint.color ? this._intToRgba(paint.color) : 'inherit'};
			background-image: ${gradients.map(g => g[0]).join(', ')};
			background-position: ${gradients.map(g => g[1]).join(', ')};
			background-size: ${gradients.map(g => g[2]).join(', ')};
			background-repeat: ${gradients.map(g => g[3]).join(', ')};
			filter: ${filter || 'inherit'};
			${paint.text ? `
				font-weight: ${paint.text.weight ? paint.text.weight * 100 : 'inherit'};
				-webkit-text-stroke-width: ${paint.text.stroke ? `${paint.text.stroke.width}px` : 'inherit'};
				-webkit-text-stroke-color: ${paint.text.stroke ? this._intToRgba(paint.text.stroke.color) : 'inherit'};
				text-shadow: ${paint.text.shadows?.map(s =>
					`${s.x_offset}px ${s.y_offset}px ${s.radius}px ${this._intToRgba(s.color)}`
				).join(', ') ?? 'unset'};
				text-transform: ${paint.text.transform ?? 'unset'};
			` : ''}
		}`;

		const sheet = this._getPaintSheet();
		if (!sheet) return;

		for (let i = 0; i < sheet.cssRules.length; i++) {
			if (sheet.cssRules[i] instanceof CSSStyleRule && sheet.cssRules[i].selectorText === selector) {
				sheet.deleteRule(i);
				sheet.insertRule(rule, i);
				return;
			}
		}

		sheet.insertRule(rule, sheet.cssRules.length);
	}

	_createGradient(gradient) {
		const result = ['', '', '', ''];
		const args = [];

		switch (gradient.function) {
			case 'LINEAR_GRADIENT':
				args.push(`${gradient.angle ?? 0}deg`);
				break;
			case 'RADIAL_GRADIENT':
				args.push(gradient.shape ?? 'circle');
				break;
			case 'URL': {
				let imgUrl = gradient.image_url ?? '';
				if (imgUrl && this._proxyBase) {
					if (imgUrl.startsWith('http'))
						imgUrl = `${this._proxyBase}/${imgUrl}`;
					else
						imgUrl = `${this._proxyBase}/${imgUrl.replace(/^\/+/, '')}`;
				}
				args.push(imgUrl);
				break;
			}
		}

		let funcPrefix = '';
		if (gradient.function !== 'URL') {
			funcPrefix = gradient.repeat ? 'repeating-' : '';
			for (const stop of gradient.stops || [])
				args.push(`${this._intToRgba(stop.color)} ${stop.at * 100}%`);
		}

		result[0] = `${funcPrefix}${gradient.function.toLowerCase().replace('_', '-')}(${args.join(', ')})`;
		result[1] = gradient.at?.length === 2 ? `${gradient.at[0] * 100}% ${gradient.at[1] * 100}%` : '';
		result[2] = gradient.size?.length === 2 ? `${gradient.size[0] * 100}% ${gradient.size[1] * 100}%` : '';
		result[3] = gradient.canvas_repeat ?? 'unset';

		return result;
	}

	_createDropShadow(shadow) {
		return `drop-shadow(${shadow.x_offset}px ${shadow.y_offset}px ${shadow.radius}px ${this._intToRgba(shadow.color)})`;
	}

	_intToRgba(num) {
		if (num == null) return 'transparent';
		const n = typeof num === 'number' ? num : parseInt(num, 10);
		return `rgba(${(n >>> 24) & 0xff},${(n >>> 16) & 0xff},${(n >>> 8) & 0xff},${((n & 0xff) / 255).toFixed(3)})`;
	}

	// ---- Paint lifecycle ----

	_updatePaintLines(userId) {
		const cached = this._userPaintCache.get(userId);
		const paintId = cached?.paintId;

		for (const {message, update} of this.chat.iterateMessages()) {
			const uid = message.user?.userID || message.user?.id;
			if (uid !== userId) continue;
			if (message.ffz_user_props?.['data-seventv-paint-id']) continue;

			if (paintId) {
				this._applyPaintToMsg(message, paintId);
			} else {
				this._removePaintFromMsg(message);
			}
			update();
		}
	}

	_removePaintFromMsg(msg) {
		if (msg.ffz_user_class) {
			msg.ffz_user_class.delete('rte-paint');
			msg.ffz_user_class.delete('rte-painted-content');
			msg.ffz_user_class.delete('ffz-tooltip');
			msg.ffz_user_class.delete('ffz-tooltip--no-mouse');
		}
		if (msg.ffz_user_props?.['data-rte-paint-id']) {
			delete msg.ffz_user_props['data-rte-paint-id'];
			delete msg.ffz_user_props['data-rte-painted-text'];
			delete msg.ffz_user_props['data-tooltip-type'];
		}
	}

	_togglePaints() {
		const enabled = this.settings.get(`${SETTING_PREFIX}.paints`);
		for (const {message, update} of this.chat.iterateMessages()) {
			if (message.ffz_user_props?.['data-seventv-paint-id']) continue;

			const uid = message.user?.userID || message.user?.id;
			const paintId = enabled && uid ? this._userPaintCache.get(uid)?.paintId : null;

			if (paintId)
				this._applyPaintToMsg(message, paintId);
			else
				this._removePaintFromMsg(message);

			update();
		}
	}

	_cleanupPaints() {
		const sheet = document.getElementById('rte-paint-styles');
		if (sheet) sheet.remove();
		this._paintSheet = null;

		for (const {message, update} of this.chat.iterateMessages()) {
			this._removePaintFromMsg(message);
			update();
		}

		this._paintDefs.clear();
		this._userPaintCache.clear();
	}
}

EmotesProxy.register();
