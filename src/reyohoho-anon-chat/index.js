const SETTING_ENABLED = 'addon.reyohoho-anon-chat.enabled';
const SETTING_BLOCK_SEND = 'addon.reyohoho-anon-chat.block-send';

const ANON_USERNAME = 'justinfan12345';
const ANON_USERNAME_PREFIX = 'justinfan';

const PART_REGEX = /^\/part\s*$/i;
const JOIN_REGEX = /^\/join\s*$/i;

const NOTICE_PART = 'ReYohoho: [Anon Chat] Logging you out of chat...';
const NOTICE_JOIN = 'ReYohoho: [Anon Chat] Logging you into chat...';
const NOTICE_BLOCKED = "You can't send messages when Anon Chat is enabled. Type /join to rejoin the chat.";
const NOTICE_NOT_LOGGED_IN = 'ReYohoho: [Anon Chat] Unable to /join: you are not logged in to Twitch.';

class AnonChat extends Addon {
	constructor(...args) {
		super(...args);

		this.inject('settings');
		this.inject('site');
		this.injectAs('siteChat', 'site.chat');
	}

	onEnable() {
		this.settings.add(SETTING_ENABLED, {
			default: true,
			ui: {
				sort: 0,
				path: 'Add-Ons > ReYohoho Anon Chat',
				title: 'Enable /part and /join chat commands',
				description:
					'When enabled, typing `/part` in chat will switch your IRC connection to an anonymous `justinfan` user so you no longer appear in the viewer list but can still read chat. Typing `/join` re-authenticates your real account.',
				component: 'setting-check-box'
			}
		});

		this.settings.add(SETTING_BLOCK_SEND, {
			default: true,
			ui: {
				sort: 1,
				path: 'Add-Ons > ReYohoho Anon Chat',
				title: 'Block outgoing messages while anon',
				description:
					'While anon chat is active (after `/part`), prevent the chat input from sending messages and show a reminder instead. Twitch would otherwise silently drop them.',
				component: 'setting-check-box'
			}
		});

		this.on('chat:pre-send-message', this.onPreSendMessage, this);
		this.on('chat:get-tab-commands', this.onGetTabCommands, this);
	}

	onDisable() {
		this.off('chat:pre-send-message', this.onPreSendMessage, this);
		this.off('chat:get-tab-commands', this.onGetTabCommands, this);
	}

	onPreSendMessage(event) {
		if (!this.settings.get(SETTING_ENABLED)) return;

		const trimmed = (event.message || '').trim();

		if (PART_REGEX.test(trimmed)) {
			event.preventDefault();
			this.part(event._inst);
			return;
		}

		if (JOIN_REGEX.test(trimmed)) {
			event.preventDefault();
			this.join(event._inst);
			return;
		}

		if (!this.settings.get(SETTING_BLOCK_SEND)) return;

		const inst = event._inst || this._getService();
		if (this._isAnon(inst)) {
			event.preventDefault();
			this._addNotice(inst, NOTICE_BLOCKED);
		}
	}

	onGetTabCommands(event) {
		if (!this.settings.get(SETTING_ENABLED)) return;
		if (!Array.isArray(event?.commands)) return;

		event.commands.push(
			{
				name: 'part',
				description: 'Temporarily leave the chat (anonymous mode).',
				permissionLevel: 0,
				ffz_group: 'ReYohoho'
			},
			{
				name: 'join',
				description: 'Rejoin the chat as yourself after /part.',
				permissionLevel: 0,
				ffz_group: 'ReYohoho'
			}
		);
	}

	part(inst) {
		const target = inst || this._getService();
		this._changeUser(target, ANON_USERNAME, true);
	}

	join(inst) {
		const user = this.site.getUser?.();
		const target = inst || this._getService();

		if (!user?.login) {
			this._addNotice(target, NOTICE_NOT_LOGGED_IN);
			return;
		}

		this._changeUser(target, user.login, false);
	}

	_getService() {
		return this.siteChat?.ChatService?.first || null;
	}

	_isAnon(inst) {
		const client = inst?.client;
		const name = client?.configuration?.username;
		return typeof name === 'string' && name.startsWith(ANON_USERNAME_PREFIX);
	}

	_changeUser(inst, username, logout) {
		if (!inst) return;

		const client = inst.client;
		if (!client) return;

		const socket = client.connection?.ws;
		if (!socket) return;

		if (client.configuration?.username === username) return;

		try {
			client.configuration.username = username;
		} catch (err) {
			this.log.error('Failed to update chat client username.', err);
			return;
		}

		this._addNotice(inst, logout ? NOTICE_PART : NOTICE_JOIN);

		try {
			socket.send('QUIT');
		} catch (_) {
			// socket may still be in CONNECTING state; the new username
			// will be picked up whenever the socket is (re)connected.
		}
	}

	_addNotice(inst, message) {
		if (!inst || typeof inst.addMessage !== 'function') return;

		const types = this.siteChat?.chat_types;
		const type = types?.Notice ?? 32;

		try {
			inst.addMessage({type, message});
		} catch (err) {
			this.log.error('Failed to push anon-chat notice.', err);
		}
	}
}

AnonChat.register();
