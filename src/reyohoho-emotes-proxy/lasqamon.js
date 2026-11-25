import {renderLasqamonCard} from './card';
import CARD_STYLE from './card.css';

const PROVIDER = 'addon.reyohoho-emotes-proxy';
const BADGE = PROVIDER + '.lasqamon';
const SITE = 'https://lasqamon.lasqa.ru';
const MINUTE = 60_000;

export default class LasqamonBadges {
	constructor(addon) {
		this.addon = addon;
		this.room = null;
		this.profiles = new Map();
		this.pending = new Map();
	}

	enable() {
		this.enabled = true;
		const style = this.style = document.createElement('link');
		style.rel = 'stylesheet';
		style.href = CARD_STYLE;
		style.crossOrigin = 'anonymous';
		document.head.append(style);
		const handler = (target, tip) => {
			const ds = this.addon.badges.getBadgeData(target);
			const login = ds.data?.find(entry => entry.id === BADGE)?.badge?.login;
			tip.add_class = 'lqm-ffz-tip';
			return this.tooltip(login, tip);
		};
		handler.onShow = (target, tip) => {
			this.openTip?.hide();
			this.openTip = tip;
			const controller = new AbortController();
			tip.onLasqamonClose = () => controller.abort();
			const fit = () => {
				const r = target.getBoundingClientRect();
				const space = Math.max(1, Math.floor(Math.max(r.top, innerHeight - r.bottom) - 22)) + 'px';
				if (tip.outer.style.getPropertyValue('--lqm-room') !== space) {
					tip.outer.style.setProperty('--lqm-room', space);
					tip.update();
				}
			};
			const {signal} = controller;
			window.addEventListener('resize', fit, {signal});
			window.addEventListener('scroll', fit, {capture: true, signal});
			window.addEventListener('keydown', e => { if (e.key === 'Escape') tip.hide(); }, {signal});
			fit();
		};
		handler.onHide = (_target, tip) => {
			tip.onLasqamonClose?.();
			if (tip === this.openTip) this.openTip = null;
		};
		handler.interactive = true;
		handler.delayHide = 180;
		this.addon.resolve('tooltips').define(BADGE, handler);
		this.addon.chat.context.on('context_changed', this.sync, this);
		this.sync();
	}

	disable() {
		this.enabled = false;
		this.openTip?.hide();
		this.style?.remove();
		this.addon.resolve('tooltips').define(BADGE, null);
		this.addon.chat.context.off('context_changed', this.sync, this);
		this.sync();
	}

	sync() {
		const {chat, settings, badges, _proxyBase} = this.addon;
		const active = this.enabled && _proxyBase && chat.context.get('context.channel')?.toLowerCase() === 'lasqa'
			&& settings.get(PROVIDER + '.badges') && settings.get(PROVIDER + '.lasqamons');
		if (active && this.room && !this.room.destroyed && this.room.login === 'lasqa') return;
		if (this.room) {
			this.openTip?.hide();
			this.session.abort();
			clearTimeout(this.timer);
			for (const login of this.profiles.keys())
				this.room.getUser(null, login, true)?.removeBadge(PROVIDER, BADGE);
			this.room = null;
			this.profiles.clear();
			this.pending.clear();
			badges.removeBadge(BADGE);
			this.addon.emit('chat:update-line-badges');
		}
		if (!active) return;
		this.room = chat.getRoom(null, 'lasqa', true);
		if (!this.room) return;
		this.session = new AbortController();
		badges.loadBadgeData(BADGE, {
			id: BADGE, title: 'Ласкамон', slot: 71, image: this.fallbackArt(), trans: {invert: false},
			css: 'background-size:contain;background-position:center;',
			tooltip_type: BADGE,
			click_handler: (_id, _login, _roomId, _roomLogin, data) => {
				const login = data.find(entry => entry.id === BADGE)?.badge?.login;
				const profile = this.profiles.get(login);
				return profile && SITE + '/#r/' + encodeURIComponent(profile.id);
			}
		});
		this.poll(this.session.signal);
	}

	fallbackArt() {
		return this.addon._proxyBase + '/' + SITE + '/lantern.svg';
	}

	async poll(signal) {
		const {_proxyBase} = this.addon;
		try {
			const response = await fetch(_proxyBase + '/api/lasqamon', {signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)])});
			if (!response.ok) throw new Error('HTTP ' + response.status);
			const {users} = await response.json();
			if (signal.aborted || !Array.isArray(users)) return;
			const next = new Map();
			let changed = false;
			for (const profile of users) {
				const login = profile?.login?.trim().toLowerCase();
				if (!login || !profile.id) continue;
				next.set(login, profile);
				const old = this.profiles.get(login);
				if (old?.id === profile.id && old.artUrl === profile.artUrl && old.name === profile.name) continue;
				this.room.getUser(null, login).addBadge(PROVIDER, BADGE, {
					login, image: profile.artUrl || this.fallbackArt(), title: profile.name || 'Ласкамон'
				});
				changed = true;
			}
			for (const login of this.profiles.keys()) {
				if (next.has(login)) continue;
				this.room.getUser(null, login, true)?.removeBadge(PROVIDER, BADGE);
				changed = true;
			}
			this.profiles = next;
			if (changed) this.addon.emit('chat:update-line-badges');
		} catch (err) {
			if (!signal.aborted) this.addon.log.warn('Lasqamon roster refresh failed:', err);
		} finally {
			if (!signal.aborted) this.timer = setTimeout(() => this.poll(signal), MINUTE);
		}
	}

	tooltip(login, tip) {
		const profile = this.profiles.get(login);
		if (!profile) return null;
		const showArt = this.addon.chat.context.get('tooltip.badge-images');
		const art = showArt ? profile.artUrl || this.fallbackArt() : null;
		const host = document.createElement('div');
		host.append(renderLasqamonCard(profile, art));
		const signal = this.session.signal;
		this.fetchDetails(login, signal).then(data => {
			if (signal.aborted || !host.isConnected || this.profiles.get(login)?.id !== profile.id) return;
			const same = data?.resident?.id === profile.id;
			const offset = host.firstElementChild.scrollTop;
			const card = renderLasqamonCard(same ? data.resident : profile, art, !same || data.stale);
			host.replaceChildren(card);
			card.scrollTop = offset;
			tip.update();
		});
		return host;
	}

	fetchDetails(login, signal) {
		let request = this.pending.get(login);
		if (!request) {
			request = fetch(this.addon._proxyBase + '/api/lasqamon/' + encodeURIComponent(login), {
				signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)])
			})
				.then(response => response.status === 200 ? response.json() : null)
				.catch(() => null)
				.finally(() => { if (this.pending.get(login) === request) this.pending.delete(login); });
			this.pending.set(login, request);
		}
		return request;
	}
}
