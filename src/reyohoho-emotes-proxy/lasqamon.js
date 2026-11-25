const PROVIDER = 'addon.reyohoho-emotes-proxy';
const BADGE = PROVIDER + '.lasqamon';
const SITE = 'https://lasqamon.lasqa.ru';
const MINUTE = 60_000;

function details(profile, stale) {
	const lines = [];
	if (profile.level != null) {
		const status = profile.activity?.label || (profile.resting ? 'Отдыхает' : profile.duelState || 'Свободен');
		lines.push(`Уровень: ${profile.level}`, `Статус: ${status}`,
			`HP: ${profile.hp ?? '?'} / ${profile.maxHP ?? '?'} · MP: ${profile.mp ?? '?'} / ${profile.maxMP ?? '?'}`);
		if (profile.job) lines.push('Профессия: ' + profile.job);
		const stats = Object.entries(profile.stats ?? {}).map(([key, value]) => `${key}: ${value}`);
		if (stats.length) lines.push('Характеристики: ' + stats.join(' · '));
		if (profile.duelState) lines.push('Готовность: ' + profile.duelState);
		const minutes = Math.ceil((profile.rematchUntil - Date.now()) / MINUTE);
		if (minutes > 0 && Number.isFinite(minutes)) {
			const date = new Intl.DateTimeFormat('ru-RU', {
				day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow'
			}).format(profile.rematchUntil);
			lines.push(`Кулдаун повторных пар: ещё ${Math.floor(minutes / 60)} ч ${minutes % 60} мин · ${date} МСК`);
		}
		if (profile.wins != null || profile.losses != null || profile.draws != null)
			lines.push(`Победы / поражения / ничьи: ${profile.wins ?? 0} / ${profile.losses ?? 0} / ${profile.draws ?? 0}`);
		if (profile.xp != null) lines.push('Боевой опыт: ' + profile.xp);
	}
	if (stale) lines.push(profile.level == null ? 'Статус пока недоступен' : 'Сохранённые данные');
	return lines.join('\n');
}

export default class LasqamonBadges {
	constructor(addon) {
		this.addon = addon;
		this.room = null;
		this.profiles = new Map();
		this.pending = new Map();
	}

	enable() {
		this.enabled = true;
		this.addon.chat.context.on('context_changed', this.sync, this);
		this.sync();
	}

	disable() {
		this.enabled = false;
		this.addon.chat.context.off('context_changed', this.sync, this);
		this.sync();
	}

	sync() {
		const {chat, settings, badges, _proxyBase} = this.addon;
		const active = this.enabled && _proxyBase && chat.context.get('context.channel')?.toLowerCase() === 'lasqa'
			&& settings.get(PROVIDER + '.badges') && settings.get(PROVIDER + '.lasqamons');
		if (active && this.room && !this.room.destroyed && this.room.login === 'lasqa') return;
		if (this.room) {
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
			tooltipExtra: (ds, badge, target) => target && this.tooltip(badge?.login),
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

	async tooltip(login) {
		const profile = this.profiles.get(login);
		if (!profile) return null;
		const signal = this.session.signal;
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
		const data = await request;
		if (signal.aborted || this.profiles.get(login)?.id !== profile.id) return null;
		const same = data?.resident?.id === profile.id;
		const body = document.createElement('div');
		body.style.whiteSpace = 'pre-line';
		body.style.textAlign = 'left';
		body.textContent = details(same ? data.resident : profile, !same || data.stale);
		return body;
	}
}
