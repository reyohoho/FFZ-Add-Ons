const SETTING_PREFIX = 'addon.reyohoho-ascii-art-font';
const STYLE_ID = 'rte-ascii-art-font-styles';
const ASCII_CLASS = 'rte-ascii-art';
const PROCESSED_ATTR = 'data-rte-ascii-processed';

// ─── React fiber helpers (same pattern as reyohoho-mod-slider) ───────────

let _reactFiberKey = null;

function getReactInstance(element) {
	if (_reactFiberKey != null && element[_reactFiberKey] != null) {
		return element[_reactFiberKey];
	}
	for (const key of Object.keys(element)) {
		if (key.startsWith('__reactInternalInstance$') || key.startsWith('__reactFiber$')) {
			_reactFiberKey = key;
			return element[key];
		}
	}
	return null;
}

function searchReactParents(node, predicate, maxDepth = 15, depth = 0) {
	try {
		if (predicate(node)) return node;
	} catch (_) {}
	if (!node || depth > maxDepth) return null;
	const parent = node.return;
	if (parent) return searchReactParents(parent, predicate, maxDepth, depth + 1);
	return null;
}

// ─── ASCII art detection (ported from reyohoho-twitch-extension) ─────────

const ASCII_ART_CHARS =
	/[░▒▓█▄▀▐▌▆▇▉▊▋▍▎▏▐▕▖▗▘▙▚▛▜▝▞▟■□▢▣▤▥▦▧▨▩▪▫▬▭▮▯▰▱▲▼◀▶◆◇◈◉◊○◌◍◎●◐◑◒◓◔◕◖◗◘◙◚◛◜◝◞◟◠◡◢◣◤◥◦◧◨◩◪◫◬◭◮◯◰◱◲◳◴◵◶◷◸◹◺◻◼◽◾◿⬛⬜⬝⬞⬟⬠⬡⬢⬣⬤⬥⬦⬧⬨⬩⬪⬫⬬⬭⬮⬯⬰⬱⬲⬳⬴⬵⬶⬷⬸⬹⬺⬻⬼⬽⬾⬿⭀⭁⭂⭃⭄⭅⭆⭇⭈⭉⭊⭋⭌⭍⭎⭏⭐\u2800-\u28FF]/g;

function isASCIIArt(message) {
	if (!message || typeof message !== 'string') return false;

	const asciiArtMatches = message.match(ASCII_ART_CHARS);
	const asciiArtCount = asciiArtMatches ? asciiArtMatches.length : 0;

	const nonSpaceChars = message.replace(/\s/g, '');
	const totalChars = nonSpaceChars.length;
	if (totalChars === 0) return false;

	const asciiArtRatio = asciiArtCount / totalChars;
	const hasMultipleSpaces = /\s{3,}/.test(message);
	const isLongMessage = message.length > 50;

	return asciiArtRatio > 0.2 || (asciiArtRatio > 0.1 && hasMultipleSpaces && isLongMessage);
}

// ─── Selectors ───────────────────────────────────────────────────────────

const LINE_SELECTORS = [
	'.chat-line__message',
	'.video-chat__message',
	'.thread-message__message',
	'.whispers .thread-message',
	'.user-notice-line'
];
const LINE_SELECTOR = LINE_SELECTORS.join(', ');

// ─── Addon ───────────────────────────────────────────────────────────────

class ASCIIArtFont extends Addon {
	constructor(...args) {
		super(...args);

		this.inject('settings');
		this.inject('site');

		this._observer = null;
		this._onMutation = this._onMutation.bind(this);
	}

	onEnable() {
		this.settings.add(`${SETTING_PREFIX}.enabled`, {
			default: true,
			ui: {
				sort: 0,
				path: 'Add-Ons > ReYohoho ASCII Art Font',
				title: 'Use default font for ASCII art messages',
				description:
					'When a chat message is detected as ASCII art, override the font to Twitch\'s default so a custom chat font size/family does not break the artwork. Runs client-side only.',
				component: 'setting-check-box'
			},
			changed: () => this._onSettingChange()
		});

		this._injectCSS();
		this._startObserver();
	}

	onDisable() {
		this._stopObserver();
		this._removeAllClasses();
		this._removeCSS();
	}

	// ─── Observer ────────────────────────────────────────────────────────

	_startObserver() {
		document.querySelectorAll(LINE_SELECTOR).forEach(el => this._processElement(el));

		this._observer = new MutationObserver(this._onMutation);
		this._observer.observe(document.body, {childList: true, subtree: true});
	}

	_stopObserver() {
		if (this._observer) {
			this._observer.disconnect();
			this._observer = null;
		}
	}

	_onMutation(mutations) {
		if (!this.settings.get(`${SETTING_PREFIX}.enabled`)) return;

		for (const mutation of mutations) {
			for (const node of mutation.addedNodes) {
				if (!(node instanceof Element)) continue;

				if (node.matches?.(LINE_SELECTOR)) {
					this._processElement(node);
				}
				node.querySelectorAll?.(LINE_SELECTOR).forEach(el => this._processElement(el));
			}
		}
	}

	_onSettingChange() {
		if (this.settings.get(`${SETTING_PREFIX}.enabled`)) {
			document.querySelectorAll(LINE_SELECTOR).forEach(el => this._processElement(el));
		} else {
			this._removeAllClasses();
		}
	}

	_removeAllClasses() {
		document.querySelectorAll(`.${ASCII_CLASS}`).forEach(el => {
			el.classList.remove(ASCII_CLASS);
			el.removeAttribute(PROCESSED_ATTR);
		});
	}

	// ─── Message extraction ──────────────────────────────────────────────

	_getChatMessageBody(element) {
		try {
			const fiber = getReactInstance(element);
			const node = searchReactParents(fiber, n => n?.pendingProps?.message != null, 10);
			const msg = node?.pendingProps?.message;
			if (!msg) return null;

			if (typeof msg.messageBody === 'string' && msg.messageBody.length > 0) {
				return msg.messageBody;
			}

			if (Array.isArray(msg.messageParts)) {
				const parts = [];
				for (const part of msg.messageParts) {
					if (!part) continue;
					if (typeof part.content === 'string') {
						parts.push(part.content);
					} else if (part.content && typeof part.content.text === 'string') {
						parts.push(part.content.text);
					} else if (typeof part.text === 'string') {
						parts.push(part.text);
					}
				}
				if (parts.length) return parts.join('');
			}
		} catch (_) {
			/* fallthrough */
		}
		return null;
	}

	_getDomMessageBody(element) {
		const parts = element.querySelectorAll(
			'span[data-a-target="chat-message-text"], .text-fragment, .message'
		);
		if (parts.length === 0) return element.textContent || '';
		let out = '';
		for (const p of parts) out += p.textContent || '';
		return out;
	}

	_processElement(element) {
		if (!element || !element.isConnected) return;
		if (!this.settings.get(`${SETTING_PREFIX}.enabled`)) return;
		if (element.getAttribute(PROCESSED_ATTR) === '1') return;

		let body = this._getChatMessageBody(element);
		if (!body) body = this._getDomMessageBody(element);
		if (!body) return;

		element.setAttribute(PROCESSED_ATTR, '1');

		if (isASCIIArt(body)) {
			element.classList.add(ASCII_CLASS);
		}
	}

	// ─── CSS ─────────────────────────────────────────────────────────────

	_injectCSS() {
		if (document.getElementById(STYLE_ID)) return;
		const style = document.createElement('style');
		style.id = STYLE_ID;
		style.textContent = `
.${ASCII_CLASS},
.${ASCII_CLASS} .message,
.${ASCII_CLASS} span[data-a-target="chat-message-text"],
.${ASCII_CLASS} .text-fragment {
	font-family: "Roobert", "Helvetica Neue", Helvetica, Arial, sans-serif !important;
	font-size: 13px !important;
	line-height: 1.4 !important;
	letter-spacing: normal !important;
}
`;
		document.head.appendChild(style);
	}

	_removeCSS() {
		document.getElementById(STYLE_ID)?.remove();
	}
}

ASCIIArtFont.register();
