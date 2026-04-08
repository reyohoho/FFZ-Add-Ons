const createElement = FrankerFaceZ.utilities.dom.createElement;

const SETTING_PREFIX = 'addon.reyohoho-friends';
const SIDEBAR_ID = 'rte-friends-sidebar';
const SIDEBAR_VISIBLE_LIMIT = 5;
const SIDEBAR_REFRESH_MS = 60 * 1000;
const NOTIFICATION_POLL_MS = 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000;
const INITIAL_DELAY_MS = 5 * 60 * 1000;
const BADGE_STYLE_ID = 'rte-friends-badge-style';

class ReyohohoFriends extends Addon {
	constructor(...args) {
		super(...args);

		this.inject('settings');
		this.inject('i18n');

		this._apiBase = null;
		this._sidebarTimer = null;
		this._notifTimer = null;
		this._heartbeatTimer = null;
		this._initialDelayTimer = null;
		this._fetchInProgress = false;
		this._pendingCount = 0;
		this._currentChannel = null;
		this._contextHandler = null;
	}

	async onEnable() {
		this._apiBase = await this._waitForProxyBase();

		if (!this._apiBase) {
			this.log.warn('No starege domain available — friends features disabled');
			return;
		}

		this.settings.add(`${SETTING_PREFIX}.enabled`, {
			default: true,
			ui: {
				sort: 0,
				path: 'Add-Ons > ReYohoho Friends',
				title: 'Enable Friends',
				description: 'Show friend list in the sidebar, report activity on channels, and poll for friend request notifications.',
				component: 'setting-check-box'
			},
			changed: () => this._onSettingChange()
		});

		this._injectCSS();

		if (this.settings.get(`${SETTING_PREFIX}.enabled`)) {
			this._setupSidebar();
			this._setupNotifications();
			this._startChannelWatcher();
		}
	}

	onDisable() {
		this._teardownSidebar();
		this._teardownNotifications();
		this._stopHeartbeat();
		this._stopChannelWatcher();
		this._removeCSS();
		this._removeBadge();
	}

	_onSettingChange() {
		if (this.settings.get(`${SETTING_PREFIX}.enabled`)) {
			this._setupSidebar();
			this._setupNotifications();
			this._startChannelWatcher();
		} else {
			this._teardownSidebar();
			this._teardownNotifications();
			this._stopHeartbeat();
			this._stopChannelWatcher();
			this._removeBadge();
		}
	}

	// ================================================================
	//  Proxy resolution
	// ================================================================

	async _waitForProxyBase() {
		for (let i = 0; i < 30; i++) {
			const proxy = this.resolve('addon.reyohoho-emotes-proxy');
			if (proxy?._proxyBase) return proxy._proxyBase;
			await new Promise(r => setTimeout(r, 1000));
		}
		return null;
	}

	// ================================================================
	//  API
	// ================================================================

	async _getFriends(twitchId) {
		try {
			const resp = await fetch(`${this._apiBase}/api/ext/friends/${encodeURIComponent(twitchId)}`);
			if (!resp.ok) return [];
			return await resp.json();
		} catch {
			return [];
		}
	}

	async _getRequestCount(twitchId) {
		try {
			const resp = await fetch(`${this._apiBase}/api/ext/friends/requests/count/${encodeURIComponent(twitchId)}`);
			if (!resp.ok) return 0;
			const data = await resp.json();
			return data.count || 0;
		} catch {
			return 0;
		}
	}

	async _reportActivity(twitchId, channelLogin, channelDisplayName, streamCategory) {
		try {
			const payload = {
				twitch_id: twitchId,
				channel_login: channelLogin,
				channel_display_name: channelDisplayName || channelLogin,
			};
			if (streamCategory != null && String(streamCategory).trim() !== '')
				payload.stream_category = String(streamCategory).trim();

			const resp = await fetch(`${this._apiBase}/api/ext/friends/activity`, {
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify(payload),
			});
			return resp.ok;
		} catch {
			return false;
		}
	}

	// ================================================================
	//  Context helpers
	// ================================================================

	_getUser() {
		const site = this.resolve('site');
		return site?.getUser?.();
	}

	_getChannelFromContext() {
		const ctx = this.settings?.main_context?._context;
		if (!ctx) return null;
		return {
			login: ctx.channel || null,
			id: ctx.channelID || null,
			displayName: ctx.channelDisplayName || ctx.channel || null,
			category: ctx.category || null,
		};
	}

	// ================================================================
	//  Channel watcher (detect navigation)
	// ================================================================

	_startChannelWatcher() {
		this._stopChannelWatcher();

		const channel = this._getChannelFromContext();
		this._currentChannel = channel?.login || null;
		if (this._currentChannel)
			this._startHeartbeat();

		this._contextHandler = () => {
			const ch = this._getChannelFromContext();
			const login = ch?.login || null;
			if (login !== this._currentChannel) {
				this._currentChannel = login;
				if (login)
					this._startHeartbeat();
				else
					this._stopHeartbeat();
			}
		};
		this.settings.main_context.on('context_changed', this._contextHandler);
	}

	_stopChannelWatcher() {
		if (this._contextHandler) {
			this.settings.main_context.off('context_changed', this._contextHandler);
			this._contextHandler = null;
		}
	}

	// ================================================================
	//  Activity heartbeat
	// ================================================================

	_startHeartbeat() {
		this._stopHeartbeat();

		if (!this.settings.get(`${SETTING_PREFIX}.enabled`)) return;

		const user = this._getUser();
		if (!user?.id) return;

		this._initialDelayTimer = setTimeout(() => {
			this._initialDelayTimer = null;
			this._sendHeartbeat();
			this._heartbeatTimer = setInterval(() => this._sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
		}, INITIAL_DELAY_MS);
	}

	_stopHeartbeat() {
		if (this._initialDelayTimer != null) {
			clearTimeout(this._initialDelayTimer);
			this._initialDelayTimer = null;
		}
		if (this._heartbeatTimer != null) {
			clearInterval(this._heartbeatTimer);
			this._heartbeatTimer = null;
		}
	}

	async _sendHeartbeat() {
		const user = this._getUser();
		if (!user?.id) return;

		const channel = this._getChannelFromContext();
		if (!channel?.login) return;

		await this._reportActivity(
			user.id,
			channel.login,
			channel.displayName,
			channel.category
		);
	}

	// ================================================================
	//  Notifications
	// ================================================================

	_setupNotifications() {
		this._pollRequests();
		if (this._notifTimer == null)
			this._notifTimer = setInterval(() => this._pollRequests(), NOTIFICATION_POLL_MS);
	}

	_teardownNotifications() {
		if (this._notifTimer != null) {
			clearInterval(this._notifTimer);
			this._notifTimer = null;
		}
		this._pendingCount = 0;
		this._dispatchCountEvent();
		this._removeBadge();
	}

	async _pollRequests() {
		const user = this._getUser();
		if (!user?.id) return;

		try {
			const newCount = await this._getRequestCount(user.id);
			if (newCount !== this._pendingCount) {
				this._pendingCount = newCount;
				this._dispatchCountEvent();
				this._updateBadge();
			}
		} catch { /* ignore */ }
	}

	_dispatchCountEvent() {
		window.dispatchEvent(
			new CustomEvent('rte:friends:requestsCount', {detail: {count: this._pendingCount}})
		);
	}

	// ================================================================
	//  Emote picker button badge (notification dot)
	// ================================================================

	_updateBadge() {
		this._removeBadge();
		if (this._pendingCount <= 0) return;

		const btn = document.querySelector('[data-a-target="emote-picker-button"]');
		if (!btn) return;

		const container = btn.closest('div') || btn.parentElement;
		if (!container) return;
		container.style.position = 'relative';

		const dot = document.createElement('div');
		dot.id = 'rte-friends-notif-dot';
		dot.style.cssText =
			'position:absolute;top:2px;right:2px;width:8px;height:8px;border-radius:50%;' +
			'background:#bf94ff;pointer-events:none;z-index:10;';
		container.appendChild(dot);
	}

	_removeBadge() {
		const dot = document.getElementById('rte-friends-notif-dot');
		if (dot) dot.remove();
	}

	// ================================================================
	//  Sidebar
	// ================================================================

	_setupSidebar() {
		this._renderFriendsList();
		if (this._sidebarTimer == null)
			this._sidebarTimer = setInterval(() => this._renderFriendsList(), SIDEBAR_REFRESH_MS);
	}

	_teardownSidebar() {
		if (this._sidebarTimer != null) {
			clearInterval(this._sidebarTimer);
			this._sidebarTimer = null;
		}
		const el = document.getElementById(SIDEBAR_ID);
		if (el) el.remove();
	}

	async _renderFriendsList() {
		if (this._fetchInProgress) return;
		const user = this._getUser();
		if (!user?.id) return;

		this._fetchInProgress = true;
		try {
			await this._doRender(user);
		} finally {
			this._fetchInProgress = false;
		}
	}

	async _doRender(user) {
		const friends = await this._getFriends(user.id);

		let section = document.getElementById(SIDEBAR_ID);
		if (!section) {
			section = this._createSidebarSection();
			if (!this._injectIntoSidebar(section)) return;
		}

		const expandedBefore = section.dataset.rteFriendsExpanded === '1';
		const list = section.querySelector('.rte-friends-sidebar-list');
		const showMoreRow = section.querySelector('.rte-friends-sidebar-show-more');
		if (!list) return;

		list.innerHTML = '';

		if (friends.length === 0) {
			section.classList.remove('rte-friends-sidebar--collapsed', 'rte-friends-sidebar--expanded');
			section.dataset.rteFriendsExpanded = '';
			if (showMoreRow) showMoreRow.style.display = 'none';

			const empty = document.createElement('div');
			empty.style.cssText =
				'padding:10px;font-size:12px;color:var(--color-text-alt,#898395);text-align:center;';
			empty.textContent = this.i18n.t(
				'addon.reyohoho-friends.list.empty',
				'No friends yet. Add people from chat user cards!'
			);
			list.appendChild(empty);
			return;
		}

		const online = friends.filter(f => f.is_online);
		const offline = friends.filter(f => !f.is_online);
		const sorted = [...online, ...offline];

		for (const f of sorted)
			list.appendChild(this._createFriendCard(f));

		if (sorted.length > SIDEBAR_VISIBLE_LIMIT) {
			if (expandedBefore) {
				section.classList.add('rte-friends-sidebar--expanded');
				section.classList.remove('rte-friends-sidebar--collapsed');
				section.dataset.rteFriendsExpanded = '1';
			} else {
				section.classList.remove('rte-friends-sidebar--expanded');
				section.classList.add('rte-friends-sidebar--collapsed');
				section.dataset.rteFriendsExpanded = '0';
			}
			this._applyCollapsedState(section);
			if (showMoreRow) showMoreRow.style.display = '';
		} else {
			section.classList.remove('rte-friends-sidebar--collapsed', 'rte-friends-sidebar--expanded');
			section.dataset.rteFriendsExpanded = '';
			if (showMoreRow) showMoreRow.style.display = 'none';
		}
	}

	_createSidebarSection() {
		const section = document.createElement('div');
		section.id = SIDEBAR_ID;
		section.className = 'rte-friends-sidebar';
		section.style.cssText = 'padding:0 0 10px 0;';

		const header = document.createElement('div');
		header.style.cssText =
			'padding:5px 10px;display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0;';

		const title = document.createElement('p');
		title.style.cssText =
			'font-size:14px;font-weight:600;margin:0;line-height:1.2;' +
			'color:var(--color-text-base,#efeff1);flex:1;min-width:0;overflow:hidden;' +
			'text-overflow:ellipsis;white-space:nowrap;';
		title.textContent = this.i18n.t('addon.reyohoho-friends.sidebar.title', 'Friends');
		header.appendChild(title);

		const actions = document.createElement('div');
		actions.style.cssText = 'display:flex;align-items:center;gap:10px;flex-shrink:0;';

		const manageLink = document.createElement('a');
		manageLink.href = 'https://ext.rte.net.ru/friends';
		manageLink.target = '_blank';
		manageLink.rel = 'noopener noreferrer';
		manageLink.style.cssText =
			'font-size:11px;color:var(--color-text-brand,#bf94ff);text-decoration:none;cursor:pointer;white-space:nowrap;';
		manageLink.textContent = this.i18n.t('addon.reyohoho-friends.sidebar.manage', 'Manage');
		actions.appendChild(manageLink);

		const hideButton = document.createElement('button');
		hideButton.type = 'button';
		hideButton.style.cssText =
			'margin:0;padding:0;border:none;background:none;font:inherit;' +
			'font-size:11px;color:var(--color-text-alt-2,#adadb8);cursor:pointer;text-decoration:none;white-space:nowrap;';
		hideButton.textContent = this.i18n.t('addon.reyohoho-friends.sidebar.hide', 'Disable');
		hideButton.title = this.i18n.t(
			'addon.reyohoho-friends.sidebar.hideTitle',
			'Hide and turn off the Friends feature'
		);
		hideButton.addEventListener('click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.settings.provider.set(`${SETTING_PREFIX}.enabled`, false);
			this.settings.update(`${SETTING_PREFIX}.enabled`);
		});
		hideButton.addEventListener('mouseenter', () => {
			hideButton.style.color = 'var(--color-text-base,#efeff1)';
			hideButton.style.textDecoration = 'underline';
		});
		hideButton.addEventListener('mouseleave', () => {
			hideButton.style.color = 'var(--color-text-alt-2,#adadb8)';
			hideButton.style.textDecoration = 'none';
		});
		actions.appendChild(hideButton);
		header.appendChild(actions);
		section.appendChild(header);

		const list = document.createElement('div');
		list.className = 'rte-friends-sidebar-list';
		section.appendChild(list);

		const showMoreRow = document.createElement('div');
		showMoreRow.className = 'rte-friends-sidebar-show-more';
		showMoreRow.style.display = 'none';

		const moreWrap = document.createElement('div');
		moreWrap.className = 'rte-friends-sidebar-show-more__more-wrap';
		const showMoreBtn = document.createElement('button');
		showMoreBtn.type = 'button';
		showMoreBtn.className = 'rte-friends-sidebar-show-more__btn';
		showMoreBtn.textContent = this.i18n.t('addon.reyohoho-friends.sidebar.showMore', 'Show more');
		showMoreBtn.addEventListener('click', e => {
			e.preventDefault();
			e.stopPropagation();
			section.dataset.rteFriendsExpanded = '1';
			section.classList.add('rte-friends-sidebar--expanded');
			section.classList.remove('rte-friends-sidebar--collapsed');
			this._applyCollapsedState(section);
		});
		moreWrap.appendChild(showMoreBtn);

		const lessWrap = document.createElement('div');
		lessWrap.className = 'rte-friends-sidebar-show-more__less-wrap';
		const showLessBtn = document.createElement('button');
		showLessBtn.type = 'button';
		showLessBtn.className = 'rte-friends-sidebar-show-more__btn';
		showLessBtn.textContent = this.i18n.t('addon.reyohoho-friends.sidebar.showLess', 'Show less');
		showLessBtn.addEventListener('click', e => {
			e.preventDefault();
			e.stopPropagation();
			section.dataset.rteFriendsExpanded = '0';
			section.classList.remove('rte-friends-sidebar--expanded');
			section.classList.add('rte-friends-sidebar--collapsed');
			this._applyCollapsedState(section);
		});
		lessWrap.appendChild(showLessBtn);

		showMoreRow.appendChild(moreWrap);
		showMoreRow.appendChild(lessWrap);
		section.appendChild(showMoreRow);

		return section;
	}

	_createFriendCard(friend) {
		const channels = friend.channels || [];
		const isOnline = channels.length > 0;

		const wrapper = document.createElement('div');
		wrapper.className = 'rte-friends-sidebar-card';
		wrapper.style.cssText = 'position:relative;';

		const row = document.createElement('div');
		row.style.cssText =
			'display:flex;align-items:center;padding:5px 10px;gap:10px;transition:background .1s;';
		row.addEventListener('mouseenter', () => {
			row.style.background = 'var(--color-background-interactable-hover,rgba(83,83,95,.48))';
		});
		row.addEventListener('mouseleave', () => {
			row.style.background = '';
		});

		const avatarContainer = document.createElement('div');
		avatarContainer.style.cssText = 'position:relative;flex-shrink:0;width:30px;height:30px;';

		const avatarLink = document.createElement('a');
		avatarLink.href = `https://www.twitch.tv/${friend.login}`;
		avatarLink.target = '_blank';
		avatarLink.rel = 'noopener noreferrer';
		avatarLink.style.cssText = 'display:block;width:30px;height:30px;';

		const avatar = document.createElement('img');
		avatar.src = friend.profile_image_url || '';
		avatar.alt = friend.display_name || friend.login;
		avatar.style.cssText =
			'width:30px;height:30px;border-radius:50%;object-fit:cover;display:block;' +
			'background:var(--color-background-alt,#1f1f23);';
		avatar.onerror = () => {
			avatar.style.background = 'var(--color-background-alt-2,#26262c)';
			avatar.src = '';
		};
		avatarLink.appendChild(avatar);
		avatarContainer.appendChild(avatarLink);

		if (isOnline) {
			const dot = document.createElement('div');
			dot.style.cssText =
				'position:absolute;bottom:-1px;right:-1px;width:10px;height:10px;' +
				'border-radius:50%;background:#00e600;border:2px solid var(--color-background-body,#0e0e10);';
			avatarContainer.appendChild(dot);
		}
		row.appendChild(avatarContainer);

		const info = document.createElement('div');
		info.style.cssText = 'flex:1;min-width:0;overflow:hidden;';

		const nameRow = document.createElement('a');
		nameRow.href = `https://www.twitch.tv/${friend.login}`;
		nameRow.target = '_blank';
		nameRow.rel = 'noopener noreferrer';
		nameRow.style.cssText =
			'display:block;font-size:13px;font-weight:600;color:var(--color-text-base,#efeff1);' +
			'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.4;' +
			'text-decoration:none;cursor:pointer;';
		nameRow.textContent = friend.display_name || friend.login || '';
		info.appendChild(nameRow);

		if (isOnline) {
			for (const ch of channels) {
				const chLink = document.createElement('a');
				chLink.href = `/${ch.channel_login}`;
				chLink.style.cssText =
					'display:block;font-size:12px;color:var(--color-text-alt-2,#adadb8);' +
					'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.4;' +
					'text-decoration:none;cursor:pointer;';
				chLink.addEventListener('mouseenter', () => {
					chLink.style.color = 'var(--color-text-base,#efeff1)';
				});
				chLink.addEventListener('mouseleave', () => {
					chLink.style.color = 'var(--color-text-alt-2,#adadb8)';
				});
				const channelLabel = ch.channel_display_name || ch.channel_login;
				chLink.textContent = ch.stream_category
					? `${channelLabel} · ${ch.stream_category}`
					: channelLabel;
				chLink.addEventListener('click', e => this._navigateToChannel(e, ch.channel_login));
				info.appendChild(chLink);
			}
		} else {
			const offlineRow = document.createElement('div');
			offlineRow.style.cssText =
				'font-size:12px;color:var(--color-text-alt,#898395);line-height:1.4;';
			offlineRow.textContent = this.i18n.t('addon.reyohoho-friends.offline', 'Offline');
			info.appendChild(offlineRow);
		}

		row.appendChild(info);
		wrapper.appendChild(row);
		return wrapper;
	}

	_injectIntoSidebar(section) {
		const sideNav = document.getElementById('side-nav');
		if (!sideNav) return false;

		const showMore = sideNav.querySelector('[data-a-target="side-nav-show-more-button"]');
		const followedSection = showMore ? showMore.closest('div[class]') : null;

		if (followedSection?.parentElement) {
			followedSection.parentElement.insertBefore(section, followedSection.nextSibling);
			return true;
		}

		const navBody = sideNav.querySelector('.side-nav-section');
		if (navBody?.parentElement) {
			navBody.parentElement.appendChild(section);
			return true;
		}

		const scrollable =
			sideNav.querySelector('[class*="scrollable"]') ||
			sideNav.querySelector('[class*="Scrollable"]') ||
			sideNav.querySelector('.simplebar-content');
		if (scrollable) {
			scrollable.appendChild(section);
			return true;
		}

		sideNav.appendChild(section);
		return true;
	}

	_applyCollapsedState(section) {
		const cards = section.querySelectorAll('.rte-friends-sidebar-card');
		const expanded = section.dataset.rteFriendsExpanded === '1';
		cards.forEach((card, index) => {
			if (!expanded && index >= SIDEBAR_VISIBLE_LIMIT)
				card.classList.add('rte-friends-sidebar-card--hidden');
			else
				card.classList.remove('rte-friends-sidebar-card--hidden');
		});
	}

	_navigateToChannel(e, channelLogin) {
		e.preventDefault();
		e.stopPropagation();
		const href = `/${channelLogin}`;
		const existing = document.querySelector(`a.side-nav-card__link[href="${href}"]`);
		if (existing) {
			existing.click();
			return;
		}
		window.history.pushState(null, '', href);
		window.dispatchEvent(new PopStateEvent('popstate', {state: null, bubbles: true}));
	}

	// ================================================================
	//  CSS injection
	// ================================================================

	_injectCSS() {
		if (document.getElementById(BADGE_STYLE_ID)) return;

		const style = document.createElement('style');
		style.id = BADGE_STYLE_ID;
		style.textContent = `
#rte-friends-sidebar.rte-friends-sidebar--collapsed .rte-friends-sidebar-card--hidden {
	display: none !important;
}
#rte-friends-sidebar.rte-friends-sidebar--expanded .rte-friends-sidebar-card--hidden {
	display: block !important;
}
.rte-friends-sidebar-show-more__less-wrap {
	display: none;
}
#rte-friends-sidebar.rte-friends-sidebar--expanded .rte-friends-sidebar-show-more__more-wrap {
	display: none;
}
#rte-friends-sidebar.rte-friends-sidebar--expanded .rte-friends-sidebar-show-more__less-wrap {
	display: block;
}
.rte-friends-sidebar-show-more__btn {
	display: inline-flex;
	align-items: center;
	width: 100%;
	margin: 0;
	padding: 0.5rem;
	border: none;
	background: transparent;
	font: inherit;
	font-size: 14px;
	font-weight: 600;
	color: var(--color-text-link, #bf94ff);
	cursor: pointer;
	text-align: left;
}
.rte-friends-sidebar-show-more__btn:hover {
	text-decoration: underline;
}`;
		document.head.appendChild(style);
	}

	_removeCSS() {
		const el = document.getElementById(BADGE_STYLE_ID);
		if (el) el.remove();
	}
}

ReyohohoFriends.register();
