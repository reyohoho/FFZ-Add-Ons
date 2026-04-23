const SETTING_PREFIX = 'addon.reyohoho-mod-slider';
const STYLE_ID = 'rms-styles';

// ─── React fiber helpers (ported from reyohoho-twitch-extension/src/utils/twitch.js) ─────

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

// ─── Selectors (same as original) ────────────────────────────────────────────

const CHAT_CONTAINER = 'section[data-test-selector="chat-room-component-layout"]';

// ─── Addon ────────────────────────────────────────────────────────────────────

class ModSlider extends Addon {
	constructor(...args) {
		super(...args);

		this.inject('settings');
		this.inject('site');

		this._processedElements = new WeakSet();
		this._observer = null;
		this._onMutation = this._onMutation.bind(this);
	}

	onEnable() {
		this.settings.add(`${SETTING_PREFIX}.enabled`, {
			default: true,
			ui: {
				sort: 0,
				path: 'Add-Ons > ReYohoho Mod Slider',
				title: 'Enable Mod Slider',
				description: 'Show a swipeable handle on the left side of chat messages for moderators. Drag right to ban/timeout/delete, drag left to unban.',
				component: 'setting-check-box'
			},
			changed: () => this._onSettingChange()
		});

		this._injectCSS();
		this._startObserver();
		this.log.info('ModSlider: enabled');
	}

	onDisable() {
		this._stopObserver();
		document.querySelectorAll('.rms-swipe-slider').forEach(el => this._restoreElement(el));
		this._removeCSS();
	}

	// ─── Observer ────────────────────────────────────────────────────────────

	_startObserver() {
		// Process any messages already in DOM
		document.querySelectorAll('.chat-line__message').forEach(el => {
			setTimeout(() => this._processElement(el), 0);
		});

		this._observer = new MutationObserver(this._onMutation);
		this._observer.observe(document.body, {childList: true, subtree: true});
	}

	_stopObserver() {
		if (this._observer) {
			this._observer.disconnect();
			this._observer = null;
		}
		this._processedElements = new WeakSet();
	}

	_onMutation(mutations) {
		if (!this.settings.get(`${SETTING_PREFIX}.enabled`)) return;

		for (const mutation of mutations) {
			for (const node of mutation.addedNodes) {
				if (!(node instanceof Element)) continue;

				if (node.classList.contains('chat-line__message')) {
					setTimeout(() => this._processElement(node), 100);
				} else {
					node.querySelectorAll('.chat-line__message').forEach(el => {
						setTimeout(() => this._processElement(el), 100);
					});
				}
			}
		}
	}

	_onSettingChange() {
		if (this.settings.get(`${SETTING_PREFIX}.enabled`)) {
			document.querySelectorAll('.chat-line__message:not(.rms-swipe-slider)').forEach(el => {
				this._processElement(el);
			});
		} else {
			document.querySelectorAll('.rms-swipe-slider').forEach(el => this._restoreElement(el));
		}
	}

	// ─── Chat data helpers (ported from twitch.js) ───────────────────────────

	_getChatMessageObject(element) {
		try {
			const fiber = getReactInstance(element);
			const node = searchReactParents(fiber, n => n?.pendingProps?.message != null, 10);
			return node?.pendingProps?.message ?? null;
		} catch (_) {
			return null;
		}
	}

	_getCurrentChat() {
		try {
			const container = document.querySelector(CHAT_CONTAINER);
			if (!container) return null;
			const node = searchReactParents(
				getReactInstance(container),
				n => n?.stateNode?.props?.onSendMessage
			);
			return node?.stateNode ?? null;
		} catch (_) {
			return null;
		}
	}

	_getCurrentUserIsModerator() {
		try {
			const chat = this._getCurrentChat();
			return chat?.props?.isCurrentUserModerator === true;
		} catch (_) {
			return false;
		}
	}

	_getCurrentUserIsOwner() {
		try {
			const currentUser = this.site.getUser();
			if (!currentUser?.id) return false;
			const chat = this._getCurrentChat();
			if (!chat?.props?.channelID) return false;
			return String(currentUser.id) === String(chat.props.channelID);
		} catch (_) {
			return false;
		}
	}

	// ─── Moderation logic ────────────────────────────────────────────────────

	_canModerate(msgObject) {
		const isModerator = this._getCurrentUserIsModerator();
		const isOwner = this._getCurrentUserIsOwner();

		if (!isModerator && !isOwner) return false;

		const currentUser = this.site.getUser();
		if (currentUser && msgObject.user?.userID === String(currentUser.id)) return false;

		const badges = msgObject.badges || {};
		if (badges.broadcaster || badges.moderator || badges.staff || badges.admin || badges.global_mod) {
			return false;
		}

		return true;
	}

	_processElement(element) {
		if (!element || !element.isConnected) return;
		if (this._processedElements.has(element)) return;

		const msgObject = this._getChatMessageObject(element);
		if (!msgObject) return;

		if (!this._canModerate(msgObject)) return;

		this._processedElements.add(element);
		this._addSwipeUI(element, msgObject);
		this.log.debug('ModSlider: slider added for', msgObject.user?.userLogin);
	}

	// ─── Slider UI ───────────────────────────────────────────────────────────

	_addSwipeUI(element, msgObject) {
		element.dataset.rmsOriginalPosition = element.style.position;
		element.dataset.rmsOriginalOverflow = element.style.overflow;
		element.dataset.rmsOriginalDisplay = element.style.display;
		element.dataset.rmsOriginalMinHeight = element.style.minHeight;

		element.classList.add('rms-swipe-slider');
		element.style.position = 'relative';
		element.style.overflow = 'visible';
		element.style.display = 'flex';
		element.style.alignItems = 'stretch';
		element.style.minHeight = '30px';

		const banBg = document.createElement('div');
		banBg.className = 'rms-ban-background';
		banBg.innerHTML = '<span class="rms-background-text"></span>';
		banBg.style.display = 'none';

		const unbanBg = document.createElement('div');
		unbanBg.className = 'rms-unban-background';
		unbanBg.innerHTML = '<span class="rms-background-text">Unban</span>';
		unbanBg.style.display = 'none';

		const handleWrapper = document.createElement('div');
		handleWrapper.className = 'rms-handle-wrapper';
		handleWrapper.title = 'Drag to moderate';

		const handleOuter = document.createElement('div');
		handleOuter.className = 'rms-handle-outer';

		const handleInner = document.createElement('div');
		handleInner.className = 'rms-handle-inner';

		const dots = document.createElement('div');
		dots.className = 'rms-dots';

		handleInner.appendChild(dots);
		handleOuter.appendChild(handleInner);
		handleWrapper.appendChild(handleOuter);

		const wrapped = document.createElement('div');
		wrapped.className = 'rms-wrapped';

		while (element.firstChild) {
			wrapped.appendChild(element.firstChild);
		}
		element.appendChild(wrapped);

		element.insertBefore(banBg, element.firstChild);
		element.insertBefore(handleWrapper, element.firstChild);
		element.appendChild(unbanBg);

		this._setupPointerHandlers(element, {banBg, unbanBg, handleOuter}, msgObject);
	}

	_setupPointerHandlers(container, {banBg, unbanBg, handleOuter}, msgObject) {
		let startX = 0;
		let currentX = 0;
		let isDragging = false;

		const updateVisuals = (deltaX) => {
			const pos = Math.max(Math.min(deltaX, 300), -60);
			container.style.transform = `translateX(${pos}px)`;

			banBg.style.display = 'none';
			unbanBg.style.display = 'none';

			if (pos > 0) {
				banBg.style.display = 'flex';
				banBg.style.width = `${pos}px`;

				const banText = banBg.querySelector('.rms-background-text');
				if (pos > 40 && pos < 80) {
					banText.textContent = 'Delete';
					banBg.style.backgroundColor = '#e67e22';
					banText.style.opacity = '1';
				} else if (pos >= 80 && pos < 300) {
					banText.textContent = `Timeout ${this._formatDuration(this._calcTimeoutSeconds(pos))}`;
					banBg.style.backgroundColor = '#d35400';
					banText.style.opacity = '1';
				} else if (pos >= 300) {
					banText.textContent = 'Ban';
					banBg.style.backgroundColor = '#c0392b';
					banText.style.opacity = '1';
				} else {
					banText.textContent = '';
					banBg.style.backgroundColor = 'transparent';
					banText.style.opacity = '0';
				}
			} else if (pos < 0) {
				unbanBg.style.display = 'flex';
				unbanBg.style.width = `${Math.abs(pos)}px`;
				unbanBg.querySelector('.rms-background-text').style.opacity = Math.abs(pos) > 40 ? '1' : '0';
			}
		};

		const handleStart = (e) => {
			if (e.button !== 0) return;
			e.stopPropagation();
			startX = e.pageX;
			currentX = startX;
			isDragging = true;
			handleOuter.style.cursor = 'grabbing';
			handleOuter.setPointerCapture?.(e.pointerId);
		};

		const handleMove = (e) => {
			if (!isDragging) return;
			e.preventDefault();
			currentX = e.pageX;
			updateVisuals(currentX - startX);
		};

		const handleEnd = (e) => {
			if (!isDragging) return;
			isDragging = false;
			handleOuter.style.cursor = 'grab';
			try { handleOuter.releasePointerCapture(e.pointerId); } catch (_) {}

			const deltaX = currentX - startX;
			if (Math.abs(deltaX) > 40) this._executeCommand(deltaX, msgObject);

			container.style.transition = 'transform 0.3s ease';
			container.style.transform = 'translateX(0px)';
			banBg.style.width = '0px';
			unbanBg.style.width = '0px';
			banBg.style.display = 'none';
			unbanBg.style.display = 'none';

			setTimeout(() => { container.style.transition = ''; }, 300);
			startX = 0;
			currentX = 0;
		};

		handleOuter.addEventListener('pointerdown', handleStart);
		handleOuter.addEventListener('pointermove', handleMove);
		handleOuter.addEventListener('pointerup', handleEnd);
		handleOuter.addEventListener('pointerleave', handleEnd);
	}

	// ─── Commands ────────────────────────────────────────────────────────────

	_executeCommand(deltaX, msgObject) {
		const send = (cmd) => {
			try {
				this.resolve('site.chat')?.ChatService?.first?.sendMessage(cmd);
			} catch (err) {
				this.log.error('ModSlider: sendMessage error:', err);
			}
		};

		const login = msgObject.user?.userLogin || msgObject.user?.login;
		const msgId = msgObject.id;

		if (deltaX < -40) {
			send(`/unban ${login}`);
		} else if (deltaX > 40 && deltaX < 80) {
			send(msgId ? `/delete ${msgId}` : `/timeout ${login} 1`);
		} else if (deltaX >= 80) {
			if (deltaX >= 300) {
				send(`/ban ${login}`);
			} else {
				send(`/timeout ${login} ${this._calcTimeoutSeconds(deltaX)}`);
			}
		}
	}

	_calcTimeoutSeconds(pos) {
		const normalized = Math.min((pos - 80) / (300 - 80), 1);
		return Math.floor(Math.pow(normalized, 10) * 1209600) || 600;
	}

	_formatDuration(seconds) {
		if (seconds < 60) return `${seconds}s`;
		if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
		if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
		return `${Math.round(seconds / 86400)}d`;
	}

	// ─── Restore ─────────────────────────────────────────────────────────────

	_restoreElement(element) {
		if (!element) return;

		element.classList.remove('rms-swipe-slider');
		element.style.position = element.dataset.rmsOriginalPosition ?? '';
		element.style.overflow = element.dataset.rmsOriginalOverflow ?? '';
		element.style.display = element.dataset.rmsOriginalDisplay ?? '';
		element.style.minHeight = element.dataset.rmsOriginalMinHeight ?? '';
		element.style.transform = '';
		element.style.transition = '';

		delete element.dataset.rmsOriginalPosition;
		delete element.dataset.rmsOriginalOverflow;
		delete element.dataset.rmsOriginalDisplay;
		delete element.dataset.rmsOriginalMinHeight;

		element.querySelector('.rms-ban-background')?.remove();
		element.querySelector('.rms-unban-background')?.remove();
		element.querySelector('.rms-handle-wrapper')?.remove();

		const wrapped = element.querySelector('.rms-wrapped');
		if (wrapped) {
			while (wrapped.firstChild) element.appendChild(wrapped.firstChild);
			wrapped.remove();
		}
	}

	// ─── CSS ─────────────────────────────────────────────────────────────────

	_injectCSS() {
		if (document.getElementById(STYLE_ID)) return;
		const style = document.createElement('style');
		style.id = STYLE_ID;
		style.textContent = `
.rms-swipe-slider {
	position: relative !important;
	width: 100%;
	overflow: visible !important;
	display: flex !important;
	align-items: stretch !important;
	min-height: 30px !important;
}

.rms-wrapped {
	position: relative;
	z-index: 2;
	flex: 1;
	width: 100%;
}

.rms-ban-background,
.rms-unban-background {
	position: absolute;
	top: 0;
	height: 100%;
	display: none;
	align-items: center;
	justify-content: center;
	overflow: hidden;
	transition: background-color 0.15s ease;
	z-index: 1;
	min-width: 40px;
	border: 1px solid var(--color-border-base, #404040);
}

.rms-ban-background {
	right: 100%;
	background-color: var(--color-background-base, #0e0e0e) !important;
	border-left: 2px solid #ff4444;
}

.rms-unban-background {
	left: 100%;
	background-color: var(--color-background-base, #0e0e0e) !important;
	border-right: 2px solid #44ff44;
}

.rms-background-text {
	position: relative;
	white-space: nowrap;
	width: 100%;
	text-align: center;
	color: var(--color-text-base, #ffffff);
	font-weight: 500;
	font-size: 10px;
	transition: opacity 0.15s ease;
	opacity: 0;
}

.rms-handle-wrapper {
	width: 0;
	height: 100%;
	z-index: 999;
	position: absolute;
	left: 0;
}

.rms-handle-outer {
	height: 100%;
	display: inline-flex;
	padding: 0.5rem 0;
	width: 2rem;
	pointer-events: all;
	cursor: grab;
}

.rms-handle-outer:active {
	cursor: grabbing;
}

.rms-handle-inner {
	height: 100%;
	border: 1px solid var(--color-border-base, #404040);
	border-radius: 0;
	display: inline-flex;
	align-items: center;
	border-left: none;
	background-color: var(--color-background-base, #0e0e0e);
	justify-content: center;
	transition: border-color 0.1s ease;
}

.rms-handle-inner:hover {
	border-color: var(--color-text-link, #bf94ff);
}

.rms-dots {
	background-image: linear-gradient(
		var(--color-border-base, #404040) 2px,
		transparent 2px
	);
	background-size: 100% 6px;
	height: 1.4rem;
	width: 4px;
	background-repeat: repeat-y;
}

.tw-root--theme-light .rms-handle-inner {
	background-color: #efeff1 !important;
	border-color: #d3d3d9 !important;
}

.tw-root--theme-light .rms-handle-inner:hover {
	border-color: #53535f !important;
}

.tw-root--theme-light .rms-dots {
	background-image: linear-gradient(#53535f 2px, transparent 2px);
}

.tw-root--theme-light .rms-ban-background,
.tw-root--theme-light .rms-unban-background {
	background-color: #efeff1 !important;
	border-color: #d3d3d9 !important;
}

.tw-root--theme-light .rms-background-text {
	color: #1f1f23 !important;
}`;
		document.head.appendChild(style);
	}

	_removeCSS() {
		document.getElementById(STYLE_ID)?.remove();
	}
}

ModSlider.register();
