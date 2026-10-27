const {createElement} = FrankerFaceZ.utilities.dom;

const RIGHT_COLUMN_SELECTOR = '.channel-root__right-column';
const HANDLE_CLASS = 'rte-chat-width-handle';
const DRAGGING_CLASS = 'rte-chat-width-dragging';
const MIN_WIDTH = 250;
const MAX_WIDTH = 800;
// Keep room for the player, otherwise a wide chat on a small window squeezes the video away
const MIN_PLAYER_WIDTH = 400;

function clampWidth(width) {
	return Math.round(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, window.innerWidth - MIN_PLAYER_WIDTH, width)));
}

// FFZ lays the page out from its own chat.width setting (--ffz-chat-width); the handle only drives that setting
export default class ChatResize {
	constructor(addon) {
		this.addon = addon;
		this.enabled = false;
		this.Column = addon.elemental.define('rte-chat-column', RIGHT_COLUMN_SELECTOR, null, null, 0);
	}

	update() {
		const enabled = this.addon.isOn('chat-resize');
		if (enabled === this.enabled)
			return;
		this.enabled = enabled;

		if (enabled) {
			this.Column.on('mount', this.addHandle, this);
			this.Column.each(column => this.addHandle(column));
			return;
		}

		this.Column.off('mount', this.addHandle, this);
		for (const handle of document.querySelectorAll(`.${HANDLE_CLASS}`))
			handle.remove();
	}

	addHandle(column) {
		if (column.querySelector(`:scope > .${HANDLE_CLASS}`) != null)
			return;

		const handle = createElement('div', {
			className: HANDLE_CLASS,
			title: this.addon.t('chat-resize.handle', 'Drag to resize the chat, double-click to reset')
		});
		handle.classList.toggle(`${HANDLE_CLASS}--left`, !!this.addon.settings.get('layout.swap-sidebars'));
		handle.addEventListener('pointerdown', event => this.startDrag(event, column, handle));
		handle.addEventListener('dblclick', () => this.addon.setValue('chat.width', null));
		column.appendChild(handle);
	}

	setVariables(width) {
		document.body.style.setProperty('--ffz-chat-width', `${width / 10}rem`);
		document.body.style.setProperty('--ffz-negative-chat-width', `${-width / 10}rem`);
	}

	startDrag(event, column, handle) {
		if (event.button !== 0)
			return;
		event.preventDefault();
		handle.setPointerCapture(event.pointerId);
		document.documentElement.classList.add(DRAGGING_CLASS);

		const chatOnLeft = this.addon.settings.get('layout.swap-sidebars');
		handle.classList.toggle(`${HANDLE_CLASS}--left`, !!chatOnLeft);
		let width = clampWidth(column.getBoundingClientRect().width);
		// FFZ only applies its width rules while chat.width is set
		if (this.addon.settings.get('chat.width') == null)
			this.addon.setValue('chat.width', width);

		// Inline on body beats FFZ's body rule, so the column follows the cursor without a settings write per move
		const onMove = moveEvent => {
			const rect = column.getBoundingClientRect();
			width = clampWidth(chatOnLeft ? moveEvent.clientX - rect.left : rect.right - moveEvent.clientX);
			this.setVariables(width);
		};
		const onUp = () => {
			handle.removeEventListener('pointermove', onMove);
			handle.removeEventListener('pointerup', onUp);
			handle.removeEventListener('pointercancel', onUp);
			document.documentElement.classList.remove(DRAGGING_CLASS);
			this.addon.setValue('chat.width', width);
			// FFZ rewrites its variables on the next frame; dropping ours earlier flashes the old width
			requestAnimationFrame(() => requestAnimationFrame(() => {
				document.body.style.removeProperty('--ffz-chat-width');
				document.body.style.removeProperty('--ffz-negative-chat-width');
			}));
		};
		handle.addEventListener('pointermove', onMove);
		handle.addEventListener('pointerup', onUp);
		handle.addEventListener('pointercancel', onUp);
	}
}
