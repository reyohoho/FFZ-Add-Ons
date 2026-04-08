const STAREGE_DOMAINS = [
	'https://starege.rte.net.ru',
	'https://starege3.rte.net.ru',
	'https://starege5.rte.net.ru',
	'https://starege4.rte.net.ru',
];

const SERVICE_HOSTS = {
	'7tv': ['7tv.io', '7tv.app', 'cdn.7tv.app'],
	'bttv': ['api.betterttv.net', 'cdn.betterttv.net'],
	'ffz': ['cdn.frankerfacez.com', 'api2.frankerfacez.com'],
};

const SETTING_PREFIX = 'addon.reyohoho-emotes-proxy';

class EmotesProxy extends Addon {
	constructor(...args) {
		super(...args);

		this.inject('settings');
		this.inject('i18n');

		this._proxyBase = null;
		this._origFetch = null;
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
				description: 'Proxy FrankerFaceZ API and CDN requests (cdn.frankerfacez.com, api2.frankerfacez.com)',
				component: 'setting-check-box'
			}
		});

		this._installFetchInterceptor();
	}

	onDisable() {
		this._removeFetchInterceptor();
	}

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
					const proxied = url.startsWith('//')
						? `${self._proxyBase}/https:${url}`
						: `${self._proxyBase}/${url}`;

					if (typeof input === 'string')
						input = proxied;
					else if (input instanceof Request)
						input = new Request(proxied, input);
				}
			}

			return self._origFetch.call(window, input, init);
		};
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
}

EmotesProxy.register();
