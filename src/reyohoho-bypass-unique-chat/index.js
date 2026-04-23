const SETTING_PREFIX = 'addon.reyohoho-bypass-unique-chat';

const INVISIBLE_CHAR = '\u{E0000}';
const INVISIBLE_CHAR_REGEX = new RegExp(INVISIBLE_CHAR, 'gu');

const CHAT_INPUT_SELECTOR =
	'textarea[data-a-target="chat-input"], ' +
	'div[data-a-target="chat-input"], ' +
	'div[data-a-target="chat-input"] [contenteditable="true"]';

class BypassUniqueChat extends Addon {
	constructor(...args) {
		super(...args);

		this.inject('settings');
		this.inject('chat');
		this.inject('site.chat.input');

		this._lastClean = '';
		this._repeatCount = 0;
		this._onKeyDown = this._onKeyDown.bind(this);
	}

	onEnable() {
		this.settings.add(`${SETTING_PREFIX}.enabled`, {
			default: true,
			ui: {
				sort: 0,
				path: 'Add-Ons > ReYohoho Bypass Unique Chat',
				title: 'Enable bypass of Twitch unique-chat mode',
				description:
					'When enabled, pressing Enter with the same message as the previous one will append an invisible Unicode character to bypass Twitch unique-chat / R9K duplicate-message protection. Works client-side only.',
				component: 'setting-check-box'
			}
		});

		document.addEventListener('keydown', this._onKeyDown, true);
	}

	onDisable() {
		document.removeEventListener('keydown', this._onKeyDown, true);
		this._lastClean = '';
		this._repeatCount = 0;
	}

	_onKeyDown(event) {
		if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
		if (!this.settings.get(`${SETTING_PREFIX}.enabled`)) return;

		const target = event.target;
		if (!target || typeof target.closest !== 'function') return;
		if (!target.closest(CHAT_INPUT_SELECTOR)) return;

		const inst = this._findChatInputInstance(target);
		if (!inst) return;

		const currentValue = this._getInputValue(inst);
		if (typeof currentValue !== 'string' || currentValue.trim().length === 0) return;

		const cleanTrimmed = currentValue.replace(INVISIBLE_CHAR_REGEX, '').trim();
		if (cleanTrimmed.length === 0) return;

		if (cleanTrimmed.startsWith('/') || cleanTrimmed.startsWith('.')) {
			this._lastClean = cleanTrimmed;
			this._repeatCount = 0;
			return;
		}

		if (cleanTrimmed === this._lastClean) {
			this._repeatCount += 1;
			const base = currentValue.replace(INVISIBLE_CHAR_REGEX, '').replace(/\s+$/, '');
			const newValue = `${base} ${INVISIBLE_CHAR.repeat(this._repeatCount)}`;
			this._setInputValue(inst, newValue);
		} else {
			this._repeatCount = 0;
		}

		this._lastClean = cleanTrimmed;
	}

	_findChatInputInstance(target) {
		const chatInput = this.input;
		if (!chatInput || !chatInput.ChatInput) return null;

		const fine = this.resolve('site.fine');

		for (const inst of chatInput.ChatInput.instances) {
			if (!inst || !inst.autocompleteInputRef) continue;

			let node = null;
			try {
				node = fine?.getHostNode?.(inst) || fine?.getChildNode?.(inst);
			} catch {
				node = null;
			}

			if (node instanceof Element && node.contains(target)) return inst;
		}

		for (const inst of chatInput.ChatInput.instances) {
			if (inst && inst.autocompleteInputRef && this._isInstanceVisible(inst)) return inst;
		}

		return null;
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

	_getInputValue(inst) {
		if (typeof inst.ffzGetValue === 'function') {
			try {
				return inst.ffzGetValue();
			} catch {
				/* fallthrough */
			}
		}

		if (inst.chatInputRef && typeof inst.chatInputRef.value === 'string') return inst.chatInputRef.value;
		if (inst.state && typeof inst.state.value === 'string') return inst.state.value;

		return '';
	}

	_setInputValue(inst, value) {
		try {
			if (inst.autocompleteInputRef && typeof inst.autocompleteInputRef.setValue === 'function') {
				inst.autocompleteInputRef.setValue(value);
				return;
			}
		} catch {
			/* fallthrough */
		}

		const el = inst.chatInputRef;
		if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
			el.value = value;
			el.dispatchEvent(new Event('input', {bubbles: true}));
		}
	}
}

BypassUniqueChat.register();
