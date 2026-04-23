const SETTING_PREFIX = 'addon.reyohoho-emote-actions';

const CHAT_EMOTE_SELECTOR =
	'.chat-line__message--emote[data-tooltip-type="emote"], ' +
	'img.chat-line__message--emote, ' +
	'.chat-image.chat-line__message--emote';

const PICKER_EMOTE_SELECTOR = '.emote-picker__emote-link[data-tooltip-type="emote"]';

class EmoteActions extends Addon {
	constructor(...args) {
		super(...args);

		this.inject('settings');
		this.inject('chat');
		this.inject('site.chat.input');

		this._onContextMenu = this._onContextMenu.bind(this);
		this._onMouseDown = this._onMouseDown.bind(this);
		this._onAuxClick = this._onAuxClick.bind(this);
	}

	onEnable() {
		this.settings.add(`${SETTING_PREFIX}.mmb_open_page`, {
			default: true,
			ui: {
				sort: 0,
				path: 'Add-Ons > ReYohoho Emote Actions',
				title: 'Middle-click opens emote page',
				description: 'Opens the source page (7TV / BTTV / FFZ) of the emote in a new tab when you middle-click a chat emote.',
				component: 'setting-check-box'
			}
		});

		this.settings.add(`${SETTING_PREFIX}.rmb_insert_code`, {
			default: true,
			ui: {
				sort: 1,
				path: 'Add-Ons > ReYohoho Emote Actions',
				title: 'Right-click inserts emote code into chat input',
				description: 'Replaces the default browser context menu on chat emotes. Appends the emote code to the chat input, separated by a space.',
				component: 'setting-check-box'
			}
		});

		this.settings.add(`${SETTING_PREFIX}.include_twitch`, {
			default: true,
			ui: {
				sort: 2,
				path: 'Add-Ons > ReYohoho Emote Actions >> Providers',
				title: 'Apply to Twitch native emotes',
				description: 'Use twitchemotes.com for the middle-click destination of native Twitch emotes.',
				component: 'setting-check-box'
			}
		});

		document.addEventListener('contextmenu', this._onContextMenu, true);
		document.addEventListener('mousedown', this._onMouseDown, true);
		document.addEventListener('auxclick', this._onAuxClick, true);
	}

	onDisable() {
		document.removeEventListener('contextmenu', this._onContextMenu, true);
		document.removeEventListener('mousedown', this._onMouseDown, true);
		document.removeEventListener('auxclick', this._onAuxClick, true);
	}

	// ================================================================
	//  Event handlers
	// ================================================================

	_onContextMenu(event) {
		if (!this.settings.get(`${SETTING_PREFIX}.rmb_insert_code`)) return;

		const resolved = this._resolveEmoteTarget(event.target);
		if (!resolved || !resolved.code) return;

		if (!this._insertIntoChat(resolved.code)) return;

		event.preventDefault();
		event.stopPropagation();
	}

	_onMouseDown(event) {
		if (event.button !== 1) return;
		if (!this.settings.get(`${SETTING_PREFIX}.mmb_open_page`)) return;

		const resolved = this._resolveEmoteTarget(event.target);
		if (!resolved) return;

		event.preventDefault();
		event.stopPropagation();

		const url = this._buildEmoteUrl(resolved);
		if (!url) return;

		this._flashElement(resolved.element);
		this._openInNewTab(url);
	}

	_onAuxClick(event) {
		// Swallow the `auxclick` that follows our handled middle-mousedown so
		// other listeners (like the Twitch emote hover card) don't fire.
		if (event.button !== 1) return;
		if (!this.settings.get(`${SETTING_PREFIX}.mmb_open_page`)) return;

		const resolved = this._resolveEmoteTarget(event.target);
		if (!resolved) return;

		event.preventDefault();
		event.stopPropagation();
	}

	// ================================================================
	//  Emote resolution
	// ================================================================

	_resolveEmoteTarget(target) {
		if (!target || typeof target.closest !== 'function') return null;

		const chatEmote = target.closest(CHAT_EMOTE_SELECTOR);
		if (chatEmote) {
			const ds = chatEmote.dataset || {};
			return {
				element: chatEmote,
				provider: ds.provider || 'twitch',
				id: ds.id || null,
				set: ds.set || null,
				name: ds.name || chatEmote.getAttribute('alt') || null,
				code: ds.name || chatEmote.getAttribute('alt') || null
			};
		}

		const picker = target.closest(PICKER_EMOTE_SELECTOR);
		if (picker) {
			const ds = picker.dataset || {};
			return {
				element: picker,
				provider: ds.provider || null,
				id: ds.id || null,
				set: ds.set || null,
				name: ds.name || null,
				code: ds.name || null
			};
		}

		return null;
	}

	_buildEmoteUrl(resolved) {
		if (!resolved) return null;
		const {provider, id, set, code} = resolved;

		if (provider === 'ffz') {
			const source = this._getEmoteSource(set);
			switch (source) {
				case '7tv':
					return id ? `https://7tv.app/emotes/${id}` : null;
				case 'bttv':
					return id ? `https://betterttv.com/emotes/${id}` : null;
				case 'ffz':
				default:
					if (!id) return null;
					return code
						? `https://www.frankerfacez.com/emoticon/${id}-${encodeURIComponent(code)}`
						: `https://www.frankerfacez.com/emoticon/${id}`;
			}
		}

		if (provider === 'twitch') {
			if (!this.settings.get(`${SETTING_PREFIX}.include_twitch`)) return null;
			return id ? `https://twitchemotes.com/emotes/${id}` : null;
		}

		return null;
	}

	_getEmoteSource(setId) {
		if (!setId) return 'ffz';
		const s = String(setId).toLowerCase();
		if (s.includes('seventv')) return '7tv';
		if (s.includes('ffzap.betterttv') || s.includes('betterttv') || s.includes('bttv')) return 'bttv';
		return 'ffz';
	}

	// ================================================================
	//  Chat input
	// ================================================================

	_insertIntoChat(code) {
		if (!code) return false;

		const chatInput = this.input;
		if (!chatInput || !chatInput.ChatInput) return false;

		for (const inst of chatInput.ChatInput.instances) {
			if (!inst || !inst.autocompleteInputRef || !inst.state) continue;
			if (!this._isInstanceVisible(inst)) continue;

			const current = typeof inst.state.value === 'string' ? inst.state.value : '';
			const prefix = current.length > 0 && !current.endsWith(' ') ? `${current} ` : current;

			inst.autocompleteInputRef.setValue(`${prefix}${code} `);
			inst.autocompleteInputRef.componentRef?.focus?.();
			return true;
		}

		// Fallback: no visible instance found, try the first available.
		for (const inst of chatInput.ChatInput.instances) {
			if (!inst || !inst.autocompleteInputRef || !inst.state) continue;

			const current = typeof inst.state.value === 'string' ? inst.state.value : '';
			const prefix = current.length > 0 && !current.endsWith(' ') ? `${current} ` : current;

			inst.autocompleteInputRef.setValue(`${prefix}${code} `);
			inst.autocompleteInputRef.componentRef?.focus?.();
			return true;
		}

		return false;
	}

	_isInstanceVisible(inst) {
		try {
			const fine = this.resolve('site.fine');
			const node = fine?.getHostNode?.(inst) || fine?.getChildNode?.(inst);
			if (!node || !(node instanceof Element)) return true;
			if (!node.isConnected) return false;
			const rect = node.getBoundingClientRect();
			return rect.width > 0 && rect.height > 0;
		} catch {
			return true;
		}
	}

	// ================================================================
	//  UI feedback
	// ================================================================

	_flashElement(el) {
		if (!el || !el.style) return;
		const original = el.style.opacity;
		el.style.opacity = '0.5';
		setTimeout(() => {
			el.style.opacity = original;
		}, 200);
	}

	_openInNewTab(url) {
		const win = window.open();
		if (win) {
			win.opener = null;
			win.location = url;
		} else {
			window.open(url, '_blank', 'noopener');
		}
	}
}

EmoteActions.register();
