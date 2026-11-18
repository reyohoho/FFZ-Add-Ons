const HEADER_SELECTOR = '.video-chat__header';
const CONTROL_CLASS = 'rte-vod-chat-sync';
const MAX_OFFSET = 900;

function getVodId() {
	return window.location.pathname.match(/^\/videos\/(\d+)/)?.[1] ?? null;
}

export default class VodChatSync {
	constructor(addon) {
		this.addon = addon;
		this.enabled = false;
		// shortcut: kept in memory per VOD like ReTwitch, lost on reload; persist it if users ask
		this.offsets = new Map();
		this.render = this.render.bind(this);
		this.Header = addon.elemental.define('rte-vod-chat-header', HEADER_SELECTOR, null, null, 0);
	}

	update() {
		const enabled = this.addon.isOn('vod-chat-sync');
		if (enabled === this.enabled)
			return;
		this.enabled = enabled;
		this.refreshChat();

		if (enabled) {
			this.Header.on('mount', this.attach, this);
			this.Header.each(header => this.attach(header));
			this.addon.on('site.router:route', this.render);
			return;
		}

		this.Header.off('mount', this.attach, this);
		this.addon.off('site.router:route', this.render);
		for (const node of document.querySelectorAll(`.${CONTROL_CLASS}`))
			node.remove();
	}

	getOffset() {
		const vodId = this.enabled ? getVodId() : null;
		return vodId == null ? 0 : (this.offsets.get(vodId) ?? 0);
	}

	// VOD chat picks and fetches comments by vodChat.comments.currentVideoTime, read through store.getState
	patchStore() {
		const store = this.addon.site.store;
		if (store == null || store.getState._rte_vod_chat_sync)
			return;

		const getState = store.getState;
		let lastState, lastOffset, lastShifted;
		const shiftedGetState = () => {
			const state = getState();
			const comments = state?.vodChat?.comments;
			const offset = this.getOffset();
			if (offset === 0 || typeof comments?.currentVideoTime !== 'number')
				return state;
			// Same object for the same input, or useSyncExternalStore re-renders forever
			if (state !== lastState || offset !== lastOffset) {
				lastState = state;
				lastOffset = offset;
				lastShifted = {
					...state,
					vodChat: {
						...state.vodChat,
						comments: {...comments, currentVideoTime: Math.max(0, comments.currentVideoTime + offset)}
					}
				};
			}
			return lastShifted;
		};
		shiftedGetState._rte_vod_chat_sync = true;
		store.getState = shiftedGetState;
	}

	// Wake connected components so a paused VOD re-reads the shifted time too
	refreshChat() {
		this.addon.site.store?.dispatch({type: 'RTE_VOD_CHAT_SYNC_CHANGED'});
	}

	setOffset(value) {
		const vodId = getVodId();
		if (vodId == null)
			return;
		this.offsets.set(vodId, Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, Math.round(Number(value) || 0))));
		this.refreshChat();
		this.render();
	}

	render() {
		const offset = this.getOffset();
		for (const control of document.querySelectorAll(`.${CONTROL_CLASS}`)) {
			control.hidden = getVodId() == null;
			const input = control.querySelector('input');
			if (document.activeElement !== input)
				input.value = String(offset);
		}
	}

	attach(header) {
		if (!this.enabled || header.querySelector(`.${CONTROL_CLASS}`) != null)
			return;
		this.patchStore();

		const control = document.createElement('div');
		control.className = CONTROL_CLASS;
		control.title = this.addon.t('vod-chat-sync.tooltip',
			'Chat sync with the video, seconds. Raise it if chat lags behind the video, lower it if chat runs ahead.');

		const makeButton = (label, delta) => {
			const button = document.createElement('button');
			button.type = 'button';
			button.textContent = label;
			button.setAttribute('aria-label', `${delta > 0 ? '+' : ''}${delta}`);
			button.addEventListener('click', () => this.setOffset(this.getOffset() + delta));
			return button;
		};

		const input = document.createElement('input');
		input.type = 'number';
		input.step = '1';
		input.min = String(-MAX_OFFSET);
		input.max = String(MAX_OFFSET);
		input.setAttribute('aria-label', this.addon.t('vod-chat-sync.label', 'Chat sync, seconds'));
		input.addEventListener('change', () => this.setOffset(input.value));

		const unit = document.createElement('span');
		unit.textContent = this.addon.t('vod-chat-sync.unit', 's');

		control.append(makeButton('−', -1), input, unit, makeButton('+', 1));
		header.append(control);
		this.render();
	}
}
