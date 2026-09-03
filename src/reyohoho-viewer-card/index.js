import gql from 'graphql-tag';

const SETTING_PREFIX = 'addon.reyohoho-viewer-card';
const STYLE_ID = 'rte-viewer-card-style';
const STATS_CLASS = 'rte-viewer-card-stats';

const CARD_SELECTOR = '[data-a-target="viewer-card"]';
const OVERLAY_SELECTOR = '.viewer-card-header__overlay';
const NAME_LINK_SELECTOR = '.viewer-card-header__display-name a[href^="/"]';

const STATS_QUERY = gql`
	query RTEViewerCardStats($login: String!, $channelID: ID!) {
		user(login: $login) {
			id
			createdAt
			followers(first: 1) {
				totalCount
			}
			relationship(targetUserID: $channelID) {
				followedAt
				subscriptionBenefit {
					gift {
						giftDate
						gifter {
							id
							displayName
						}
					}
				}
			}
		}
	}
`;

// SVG icons matching the ReYohoho Twitch extension moderator card.
const Icons = {
	HEART:
		'<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">' +
		'<path clip-rule="evenodd" fill-rule="evenodd" d="M8,14L1,7V4l2-2h3l2,2l2-2h3l2,2v3L8,14z"></path></svg>',
	CAKE:
		'<svg width="16" height="16" viewBox="0 0 1792 1792" fill="currentColor" aria-hidden="true">' +
		'<path d="M1792 1408v384h-1792v-384q45 0 85-14t59-27.5 47-37.5q30-27 51.5-38t56.5-11q24 0 44 7t31 15 33 27q29 25 47 38t58 27 86 14q45 0 85-14.5t58-27 48-37.5q21-19 32.5-27t31-15 43.5-7q35 0 56.5 11t51.5 38q28 24 47 37.5t59 27.5 85 14 85-14 59-27.5 47-37.5q30-27 51.5-38t56.5-11q34 0 55.5 11t51.5 38q28 24 47 37.5t59 27.5 85 14zm0-320v192q-24 0-44-7t-31-15-33-27q-29-25-47-38t-58-27-85-14q-46 0-86 14t-58 27-47 38q-22 19-33 27t-31 15-44 7q-35 0-56.5-11t-51.5-38q-29-25-47-38t-58-27-86-14q-45 0-85 14.5t-58 27-48 37.5q-21 19-32.5 27t-31 15-43.5 7q-35 0-56.5-11t-51.5-38q-28-24-47-37.5t-59-27.5-85-14q-46 0-86 14t-58 27-47 38q-30 27-51.5 38t-56.5 11v-192q0-80 56-136t136-56h64v-448h256v448h256v-448h256v448h256v-448h256v448h64q80 0 136 56t56 136zm-1280-864q0 77-36 118.5t-92 41.5q-53 0-90.5-37.5t-37.5-90.5q0-29 9.5-51t23.5-34 31-28 31-31.5 23.5-44.5 9.5-67q38 0 83 74t45 150zm512 0q0 77-36 118.5t-92 41.5q-53 0-90.5-37.5t-37.5-90.5q0-29 9.5-51t23.5-34 31-28 31-31.5 23.5-44.5 9.5-67q38 0 83 74t45 150zm512 0q0 77-36 118.5t-92 41.5q-53 0-90.5-37.5t-37.5-90.5q0-29 9.5-51t23.5-34 31-28 31-31.5 23.5-44.5 9.5-67q38 0 83 74t45 150z"></path></svg>',
	GIFT:
		'<svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">' +
		'<path clip-rule="evenodd" fill-rule="evenodd" d="M16 6h2v6h-1v6H3v-6H2V6h2V4.793c0-2.507 3.03-3.762 4.803-1.99.131.131.249.275.352.429L10 4.5l.845-1.268a2.81 2.81 0 01.352-.429C12.969 1.031 16 2.286 16 4.793V6zM6 4.793V6h2.596L7.49 4.341A.814.814 0 006 4.793zm8 0V6h-2.596l1.106-1.659a.814.814 0 011.49.451zM16 8v2h-5V8h5zm-1 8v-4h-4v4h4zM9 8v2H4V8h5zm0 4H5v4h4v-4z"></path></svg>'
};

class ReYohohoViewerCard extends Addon {
	constructor(...args) {
		super(...args);

		this.inject('settings');
		this.inject('i18n');
		this.inject('site');
		this.inject('site.apollo');

		this._observer = null;
		this._scanScheduled = false;
	}

	onEnable() {
		this.settings.add(`${SETTING_PREFIX}.enabled`, {
			default: true,
			ui: {
				sort: 0,
				path: 'Add-Ons > ReYohoho Viewer Card',
				title: 'Enable Viewer Card stats',
				description: 'Adds account creation date, follow date, follower count, and gifted-subscription info to the chat viewer card (data Twitch removed from the card UI).',
				component: 'setting-check-box'
			},
			changed: () => this._onSettingChange()
		});

		this._installStyles();

		if (this.settings.get(`${SETTING_PREFIX}.enabled`))
			this._startObserver();
	}

	onDisable() {
		this._stopObserver();
		this._removeInjected();
		document.getElementById(STYLE_ID)?.remove();
	}

	_onSettingChange() {
		if (this.settings.get(`${SETTING_PREFIX}.enabled`)) {
			this._startObserver();
			this._scan();
		} else {
			this._stopObserver();
			this._removeInjected();
		}
	}

	_t(key, fallback, data) {
		try {
			return this.i18n?.t?.(key, fallback, data) ?? fallback;
		} catch (_) {
			return fallback;
		}
	}

	// ================================================================
	//  DOM observing
	// ================================================================

	_startObserver() {
		if (this._observer) return;

		this._observer = new MutationObserver(() => this._scheduleScan());
		this._observer.observe(document.body, {childList: true, subtree: true});

		// Handle a card that is already open.
		this._scan();
	}

	_stopObserver() {
		if (this._observer) {
			this._observer.disconnect();
			this._observer = null;
		}
	}

	_scheduleScan() {
		if (this._scanScheduled) return;
		this._scanScheduled = true;
		requestAnimationFrame(() => {
			this._scanScheduled = false;
			this._scan();
		});
	}

	_scan() {
		if (!this.settings.get(`${SETTING_PREFIX}.enabled`)) return;

		for (const card of document.querySelectorAll(CARD_SELECTOR))
			this._tryInject(card);
	}

	_removeInjected() {
		document.querySelectorAll(`.${STATS_CLASS}`).forEach(el => el.remove());
		document.querySelectorAll('[data-rte-vc-processed]').forEach(el => {
			delete el.dataset.rteVcProcessed;
		});
	}

	// ================================================================
	//  Injection
	// ================================================================

	_tryInject(card) {
		if (!card || card.dataset.rteVcProcessed) return;

		const overlay = card.querySelector(OVERLAY_SELECTOR);
		if (!overlay) return;
		if (overlay.querySelector(`.${STATS_CLASS}`)) return;

		const login = this._getCardLogin(card);
		if (!login) return;

		const channelID = this._getChannelID();
		if (!channelID) return;

		// Mark as processed only once we have everything needed to run the query,
		// so incomplete cards keep getting retried by the observer.
		card.dataset.rteVcProcessed = '1';

		this._query(login, channelID)
			.then(user => {
				if (!user) return;
				// Card may have been closed/replaced while loading.
				if (!card.isConnected) return;
				const liveOverlay = card.querySelector(OVERLAY_SELECTOR);
				if (!liveOverlay || liveOverlay.querySelector(`.${STATS_CLASS}`)) return;

				const stats = this._buildStats(user);
				if (stats) liveOverlay.appendChild(stats);
			})
			.catch(err => {
				this.log.error('Failed to load viewer card stats.', err);
				delete card.dataset.rteVcProcessed;
			});
	}

	_getCardLogin(card) {
		const link = card.querySelector(NAME_LINK_SELECTOR);
		const href = link?.getAttribute('href');
		if (!href) return null;
		const login = href.replace(/^\//, '').split(/[/?#]/)[0];
		return login ? login.toLowerCase() : null;
	}

	_getChannelID() {
		const ctx = this.settings?.main_context?._context;
		return ctx?.channelID || null;
	}

	_query(login, channelID) {
		const apollo = this.apollo || this.resolve('site.apollo');
		if (!apollo?.client) return Promise.reject(new Error('Apollo client unavailable.'));

		return apollo.client
			.query({
				query: STATS_QUERY,
				variables: {login, channelID},
				fetchPolicy: 'network-only'
			})
			.then(result => result?.data?.user || null);
	}

	// ================================================================
	//  Rendering
	// ================================================================

	_buildStats(user) {
		const container = document.createElement('div');
		container.className = STATS_CLASS;

		const followers = user.followers?.totalCount;
		if (typeof followers === 'number')
			container.appendChild(this._statItem(
				Icons.HEART,
				this._t('addon.reyohoho-viewer-card.stat.followers', 'Followers'),
				this._formatNumber(followers)
			));

		const followedAt = user.relationship?.followedAt;
		if (followedAt) {
			const date = this._formatDate(followedAt);
			if (date)
				container.appendChild(this._statItem(
					Icons.HEART,
					this._t('addon.reyohoho-viewer-card.stat.following-since', 'Following Since'),
					date,
					this._formatDateTime(followedAt)
				));
		}

		const createdAt = user.createdAt;
		if (createdAt) {
			const date = this._formatDate(createdAt);
			if (date)
				container.appendChild(this._statItem(
					Icons.CAKE,
					this._t('addon.reyohoho-viewer-card.stat.created', 'Account Creation Date'),
					date
				));
		}

		const gift = user.relationship?.subscriptionBenefit?.gift;
		if (gift?.giftDate) {
			const giftedBy = gift.gifter?.displayName || this._t('addon.reyohoho-viewer-card.stat.anonymous', 'Anonymous');
			container.appendChild(this._statItem(
				Icons.GIFT,
				this._t('addon.reyohoho-viewer-card.stat.gifted-by', 'Subscription Gifted By'),
				giftedBy,
				this._formatDate(gift.giftDate)
			));
		}

		return container.childElementCount ? container : null;
	}

	_statItem(iconSvg, iconTitle, value, valueTitle) {
		const item = document.createElement('div');
		item.className = 'userStat';

		const icon = document.createElement('div');
		icon.className = 'statIcon';
		if (iconTitle) icon.setAttribute('title', iconTitle);
		icon.innerHTML = iconSvg;
		item.appendChild(icon);

		const val = document.createElement('div');
		if (valueTitle) val.setAttribute('title', valueTitle);
		val.textContent = value;
		item.appendChild(val);

		return item;
	}

	// ================================================================
	//  Formatting
	// ================================================================

	_formatNumber(value) {
		try {
			return this.i18n?.formatNumber?.(value) ?? new Intl.NumberFormat().format(value);
		} catch {
			return String(value);
		}
	}

	_formatDate(value) {
		try {
			const d = new Date(value);
			if (isNaN(d.getTime())) return null;
			return d.toLocaleDateString(undefined, {year: 'numeric', month: 'short', day: '2-digit'});
		} catch {
			return null;
		}
	}

	_formatDateTime(value) {
		try {
			const d = new Date(value);
			if (isNaN(d.getTime())) return undefined;
			return d.toLocaleString();
		} catch {
			return undefined;
		}
	}

	// ================================================================
	//  Styles
	// ================================================================

	_installStyles() {
		if (document.getElementById(STYLE_ID)) return;

		const style = document.createElement('style');
		style.id = STYLE_ID;
		style.textContent = `
.${STATS_CLASS} {
	display: flex !important;
	flex-wrap: wrap;
	width: 100% !important;
	padding: 8px 0;
	color: var(--color-text-base, #efeff1);
	background-color: var(--color-background-body, rgba(0, 0, 0, 0.5));
	border-top: 1px solid var(--color-border-base, #2f2f35);
}
.${STATS_CLASS} .userStat {
	display: inline-flex !important;
	align-items: center !important;
	padding-left: 1rem !important;
	font-size: 11px;
	line-height: 1.4;
}
.${STATS_CLASS} .userStat .statIcon {
	display: inline-flex !important;
	align-items: center !important;
	margin-right: 0.5rem !important;
	color: var(--color-text-alt-2, #adadb8);
}
.${STATS_CLASS} .userStat .statIcon svg {
	fill: currentColor;
}
`;
		document.head.appendChild(style);
	}
}

ReYohohoViewerCard.register();
