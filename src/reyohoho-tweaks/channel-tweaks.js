const CHANNEL_INFO_SELECTOR = '#live-channel-stream-information, .channel-info-content';
const FOLLOWED_HEADER_SELECTOR = '.followed-side-nav-header';
const MARK_ATTRIBUTE = 'data-rte-channel-element';
const MAX_WRAPPER_DEPTH = 8;
// Twitch's own followed-channels sort option "Viewers (High to Low)"
const VIEWERS_SORT_TYPE = 'viewers_desc';

// Pure CSS toggles: setting key -> class on <html> (style.css)
const CSS_TOGGLES = {
	'hide.ai-summary': 'rte-hide-ai-summary',
	'hide.sub-upgrade': 'rte-hide-sub-upgrade',
	'hide.notifications': 'rte-hide-channel-notifications',
	'hide.bits-balance': 'rte-hide-bits-balance',
	'hide.bits-offer': 'rte-hide-bits-offer'
};
// These buttons have no stable data-a-target, so they are recognized by label (EN/RU) and marked for CSS
const MARKED_KEYS = ['hide.sub-upgrade', 'hide.notifications', 'hide.bits-offer'];
const SUB_UPGRADE_REGEX = /upgrade|повысить уровень/i;
const NOTIFICATIONS_REGEX = /notification|уведомлен/i;
const BITS_OFFER_REGEX = /^bits\b/i;

function getButtonKind(button) {
	const text = button.textContent?.trim() ?? '';
	const label = button.getAttribute('aria-label')?.trim() ?? '';
	if (BITS_OFFER_REGEX.test(text) || BITS_OFFER_REGEX.test(label))
		return 'bits-offer';
	if (SUB_UPGRADE_REGEX.test(text) || SUB_UPGRADE_REGEX.test(label))
		return 'sub-upgrade';
	if (NOTIFICATIONS_REGEX.test(label))
		return 'notifications';
	return null;
}

// Hide the button together with wrappers that contain nothing else, so no empty gap is left behind
function getOuterWrapper(button, box) {
	let element = button;
	for (let depth = 0; depth < MAX_WRAPPER_DEPTH; depth++) {
		const parent = element.parentElement;
		if (parent == null || parent === box || parent.childElementCount !== 1)
			break;
		element = parent;
	}
	return element;
}

export default class ChannelTweaks {
	constructor(addon) {
		this.addon = addon;
		this.marking = false;
		this.sorting = false;
		this.ChannelInfo = addon.elemental.define(
			'rte-channel-info', CHANNEL_INFO_SELECTOR, null,
			{childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label']}, 0
		);
		this.FollowedHeader = addon.elemental.define('rte-followed-header', FOLLOWED_HEADER_SELECTOR, null, null, 0);
	}

	update() {
		for (const [key, className] of Object.entries(CSS_TOGGLES))
			document.documentElement.classList.toggle(className, this.addon.isOn(key));

		const marking = MARKED_KEYS.some(key => this.addon.isOn(key));
		if (marking !== this.marking) {
			this.marking = marking;
			if (marking) {
				this.ChannelInfo.on('mount', this.scan, this);
				this.ChannelInfo.on('mutate', this.scan, this);
				this.ChannelInfo.each(box => this.scan(box));
			} else {
				this.ChannelInfo.off('mount', this.scan, this);
				this.ChannelInfo.off('mutate', this.scan, this);
			}
		}

		const sorting = this.addon.isOn('sidebar.sort-by-viewers');
		if (sorting !== this.sorting) {
			this.sorting = sorting;
			if (sorting) {
				this.FollowedHeader.on('mount', this.sortByViewers, this);
				this.FollowedHeader.each(header => this.sortByViewers(header));
			} else {
				this.FollowedHeader.off('mount', this.sortByViewers, this);
			}
		}
	}

	scan(box) {
		const marks = new Map();
		for (const button of box.querySelectorAll('button')) {
			const kind = getButtonKind(button);
			if (kind != null)
				marks.set(getOuterWrapper(button, box), kind);
		}

		for (const element of box.querySelectorAll(`[${MARK_ATTRIBUTE}]`))
			if (!marks.has(element))
				element.removeAttribute(MARK_ATTRIBUTE);
		for (const [element, kind] of marks)
			if (element.getAttribute(MARK_ATTRIBUTE) !== kind)
				element.setAttribute(MARK_ATTRIBUTE, kind);
	}

	// Switch Twitch's own sort instead of reordering cards, so "Show more" keeps loading channels in that order
	sortByViewers(header) {
		let node = this.addon.fine.getReactInstance(header.querySelector('button') ?? header);
		for (let depth = 0; node != null && depth < 20; depth++, node = node.return) {
			const sort = node.memoizedProps?.sort;
			if (typeof sort?.setSortType !== 'function')
				continue;
			if (sort.type !== VIEWERS_SORT_TYPE)
				sort.setSortType(VIEWERS_SORT_TYPE);
			return;
		}
	}
}
