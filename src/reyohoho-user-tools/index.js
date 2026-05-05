const FOLLOWS_URL = 'https://ext.rte.net.ru/follows?user=';
const ACTION_KEY = 'addon.reyohoho-user-tools.follows';

const DEFAULT_HOVER_ENTRY = {
	v: {
		action: ACTION_KEY,
		appearance: {type: 'icon', icon: 'ffz-i-link-ext'},
		options: {},
		display: {}
	}
};

class UserTools extends Addon {
	constructor(...args) {
		super(...args);

		this.inject('settings');
		this.inject('i18n');
		this.inject('chat.actions');
	}

	_t(key, fallback, data) {
		try {
			return this.i18n?.t?.(key, fallback, data) ?? fallback;
		} catch (_) {
			return fallback;
		}
	}

	onEnable() {
		this.settings.add('addon.reyohoho-user-tools.enabled', {
			default: true,
			ui: {
				sort: 0,
				path: 'Add-Ons > ReYohoho User Tools',
				title: 'Show Follows button on message hover',
				description: 'Adds a Follows button to the chat message hover actions bar. Clicking it opens the user\'s follow list.',
				component: 'setting-check-box'
			},
			changed: val => this._onSettingChange(val)
		});

		const i18n = this.i18n;
		this.actions.addAction(ACTION_KEY, {
			presets: [{
				appearance: {type: 'icon', icon: 'ffz-i-link-ext'}
			}],

			required_context: ['user'],

			title: this._t('addon.reyohoho-user-tools.action.title', 'Show Follows'),
			description: this._t(
				'addon.reyohoho-user-tools.action.description',
				'Open the follows list for this user.'
			),

			tooltip(data) {
				const fallback = `Follows: ${data.user.login}`;
				try {
					return i18n?.t?.(
						'addon.reyohoho-user-tools.action.tooltip',
						fallback,
						{login: data.user.login}
					) ?? fallback;
				} catch (_) {
					return fallback;
				}
			},

			click(event, data) {
				window.open(FOLLOWS_URL + encodeURIComponent(data.user.login), '_blank');
			}
		});

		if (this.settings.get('addon.reyohoho-user-tools.enabled')) {
			this._addToHoverList();
		}
	}

	onDisable() {
		this.actions.removeAction(ACTION_KEY);
		this._removeFromHoverList();
	}

	_onSettingChange(enabled) {
		if (enabled) {
			this._addToHoverList();
		} else {
			this._removeFromHoverList();
		}
	}

	_addToHoverList() {
		const stored = this.settings.provider.get('chat.actions.hover') ?? [];
		if (stored.some(e => e?.v?.action === ACTION_KEY)) return;
		this.settings.provider.set('chat.actions.hover', [...stored, DEFAULT_HOVER_ENTRY]);
	}

	_removeFromHoverList() {
		const stored = this.settings.provider.get('chat.actions.hover');
		if (!stored) return;
		const filtered = stored.filter(e => e?.v?.action !== ACTION_KEY);
		if (filtered.length !== stored.length) {
			this.settings.provider.set('chat.actions.hover', filtered);
		}
	}
}

UserTools.register();
