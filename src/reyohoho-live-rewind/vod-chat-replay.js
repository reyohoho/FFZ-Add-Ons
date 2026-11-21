import {fetchVodComments} from './vod-service.js';

const createElement = FrankerFaceZ.utilities.dom.createElement;

const CHAT_LIST_SELECTOR = '.chat-list--default, .chat-list--other';
const MAX_LINES = 150;
// Load the next page once fewer seconds than this are queued ahead of the video
const PREFETCH_AHEAD = 10;
// Past the newest comment only polling by offset finds new ones
const END_POLL_DELAY = 5000;
const RETRY_MIN = 5000;
const RETRY_MAX = 60000;
// A bigger jump than this between ticks is a seek: start over from the new position
const SEEK_JUMP = 10;

// The recording's chat in place of the live one while rewinding. Lines go through FFZ's own tokenizer and
// renderers, as in its VOD chat, so emotes, badges, name colours and overrides match the live chat.
// The live chat keeps running underneath and is back as it was on returning to live
export default class VodChatReplay {
	constructor({log} = {}) {
		this.log = typeof log === 'function' ? log : () => {};
		this.active = false;
		this.vodId = null;
		this.login = null;
		this.root = null;
		this.lines = null;
		this.seq = 0;
		this.reset(0);
	}

	start(vodId, login) {
		this.active = true;
		this.vodId = vodId;
		this.login = login;
		this.lastTime = null;
	}

	stop() {
		this.active = false;
		this.seq++;
		this.loading = false;
		this.root?.remove();
	}

	reset(time) {
		this.seq++;
		this.loading = false;
		this.queue = [];
		this.cursor = null;
		// Offset of the newest queued comment and the ids queued at it: pages overlap at their edges
		this.edge = Math.floor(time);
		this.edgeIds = new Set();
		this.nextLoadAt = 0;
		this.retryDelay = RETRY_MIN;
		this.lines?.replaceChildren();
	}

	tick(time) {
		if (!this.active || !this.mount()) return;
		if (this.lastTime == null || time < this.lastTime - 1 || time > this.lastTime + SEEK_JUMP) this.reset(time);
		this.lastTime = time;

		while (this.queue.length && this.queue[0].contentOffsetSeconds <= time) this.render(this.queue.shift());

		if (!this.loading && Date.now() >= this.nextLoadAt && this.edge < time + PREFETCH_AHEAD) this.load();
	}

	mount() {
		if (this.root?.isConnected) return true;
		const list = document.querySelector(CHAT_LIST_SELECTOR);
		if (!list) return false;
		if (!this.root) {
			const i18n = FrankerFaceZ.get().resolve('i18n');
			// column-reverse keeps the view pinned to the newest line as lines and emote images come in
			this.lines = createElement('div');
			this.root = createElement('div', {className: 'rte-lr-chat'}, [
				createElement(
					'div',
					{className: 'rte-lr-chat-header'},
					i18n ? i18n.t('addon.reyohoho-live-rewind.vod-chat', 'Recording chat') : 'Recording chat'
				),
				createElement('div', {className: 'rte-lr-chat-scroll'}, this.lines),
			]);
		}
		list.append(this.root);
		return true;
	}

	async load() {
		const seq = this.seq;
		this.loading = true;
		try {
			const page = await fetchVodComments(this.vodId, this.cursor ? {cursor: this.cursor} : {offset: this.edge});
			if (seq !== this.seq) return;

			const edges = page?.edges ?? [];
			for (const {node} of edges) {
				const offset = node?.contentOffsetSeconds;
				// Skips the overlap with the previous page, and a whole page from 0:00 that a spent cursor returns
				if (!(offset >= this.edge) || (offset === this.edge && this.edgeIds.has(node.id))) continue;
				if (offset > this.edge) {
					this.edge = offset;
					this.edgeIds = new Set();
				}
				this.edgeIds.add(node.id);
				this.queue.push(node);
			}

			const last = edges.at(-1);
			this.cursor = page?.pageInfo?.hasNextPage && last?.node?.contentOffsetSeconds >= this.edge ? last.cursor : null;
			this.nextLoadAt = this.cursor ? 0 : Date.now() + END_POLL_DELAY;
			this.retryDelay = RETRY_MIN;
		} catch (error) {
			if (seq !== this.seq) return;
			this.log('Recording chat failed:', error);
			this.nextLoadAt = Date.now() + this.retryDelay;
			this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX);
		} finally {
			if (seq === this.seq) this.loading = false;
		}
	}

	render(comment) {
		try {
			const line = this.renderLine(comment);
			if (!line) return;
			this.lines.append(line);
			while (this.lines.childElementCount > MAX_LINES) this.lines.firstElementChild.remove();
		} catch (error) {
			this.log('Recording chat line failed:', error);
		}
	}

	// The message object FFZ's VOD chat builds from a comment (standardizeMessage), with the fragments as Twitch's
	// message parts so detokenizeMessage turns them into text and emote ranges for the tokenizer
	renderLine({id, commenter, message}) {
		// Deleted accounts come without a commenter
		if (!commenter?.login) return null;
		const ffz = FrankerFaceZ.get();
		const chat = ffz.resolve('chat');
		if (!chat) return null;

		const room = chat.getRoom(null, this.login, true);
		const roomLogin = room?.login ?? this.login;
		const user = {
			id: commenter.id,
			login: commenter.login,
			displayName: commenter.displayName,
			isIntl: !!commenter.displayName && commenter.displayName.trim().toLowerCase() !== commenter.login,
			color: message?.userColor,
		};
		const badges = {};
		for (const badge of message?.userBadges ?? []) if (badge?.setID) badges[badge.setID] = badge.version;

		const msg = {
			id,
			user,
			roomLogin,
			roomID: room?.id,
			ffz_badges: chat.badges.getBadges(user.id, user.login, room?.id, roomLogin),
			badges,
			messageParts: (message?.fragments ?? []).map((fragment) =>
				fragment.emote?.emoteID
					? {content: {alt: fragment.text, emoteID: fragment.emote.emoteID, images: {sources: {}}}}
					: {content: fragment.text}
			),
			ffz_context: 'video',
		};
		chat.detokenizeMessage(msg);
		const tokens = chat.tokenizeMessage(msg, ffz.resolve('site')?.getUser?.());

		const overrides = ffz.resolve('chat.overrides');
		const rawColor = overrides?.getColor?.(user.id) || user.color;
		const color = ffz.resolve('site.chat')?.colors?.process?.(rawColor) ?? rawColor;
		const overrideName = overrides?.getName?.(user.id);

		return createElement(
			'div',
			{
				className: 'rte-lr-chat-line',
				'data-room-id': msg.roomID,
				'data-room': roomLogin,
				'data-user-id': user.id,
				'data-user': user.login,
			},
			[
				createElement('span', {className: 'chat-line__message--badges'}, chat.badges.render(msg, createElement)),
				createElement(
					'a',
					{
						className: 'video-chat__message-author notranslate',
						href: `/${user.login}`,
						rel: 'noopener noreferrer',
						target: '_blank',
						style: color ? {color} : null,
					},
					overrideName
						? createElement('span', {className: 'chat-author__display-name'}, overrideName)
						: chat.formatUser(user, createElement)
				),
				createElement('div', {className: 'tw-inline video-chat__message'}, [
					createElement('span', null, ': '),
					createElement('span', {className: 'message'}, chat.renderTokens(tokens, createElement)),
				]),
			]
		);
	}
}
