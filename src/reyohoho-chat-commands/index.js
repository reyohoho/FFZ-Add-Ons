import gql from 'graphql-tag';

const SETTING_PREFIX = 'addon.reyohoho-chat-commands';
const GROUP = 'ReYohoho';
const PASTA_API = 'https://ext.rte.net.ru:8443/api/pastas';
const STYLE_ID = 'rte-chat-commands-style';

const CHATTERS_QUERY = gql`
	query RTEGetChannelChattersCount($name: String!) {
		channel(name: $name) {
			id
			chatters {
				count
			}
		}
	}
`;

const STREAM_QUERY = gql`
	query RTEGetChannelStream($userId: ID!) {
		user(id: $userId) {
			id
			stream {
				id
				createdAt
				viewersCount
			}
		}
	}
`;

const FOLLOWERS_QUERY = gql`
	query RTEGetChannelFollowerCount($userId: ID!) {
		user(id: $userId) {
			id
			followers(first: 1) {
				totalCount
			}
		}
	}
`;

const FOLLOWED_QUERY = gql`
	query RTEGetFollowingChannel($userId: ID!) {
		user(id: $userId) {
			id
			self {
				follower {
					followedAt
				}
			}
		}
	}
`;

const COMMANDS = [
	{
		name: 'pasta',
		description: 'Usage: "/pasta query" - Search for copypastas',
		commandArgs: [{name: 'query', isRequired: true}],
		setting: 'pasta'
	},
	{name: 'chatters', description: 'Usage: "/chatters" - Show the number of chatters in the chat'},
	{name: 'uptime', description: 'Usage: "/uptime" - Show how long the channel has been live'},
	{name: 'viewers', description: 'Usage: "/viewers" - Show the current stream viewer count'},
	{name: 'follows', description: 'Usage: "/follows" - Show the channel follower count'},
	{name: 'followed', description: 'Usage: "/followed" - Show how long you have followed the channel'},
	{
		name: 'shrug',
		description: 'Usage: "/shrug [message]" - Append a shrug face',
		commandArgs: [{name: 'message', isRequired: false}]
	},
	{name: 'squishy', description: 'Usage: "/squishy" - Paste a Squishy5 copypasta'},
	{name: 'lurk', description: 'Usage: "/lurk" - Tell chat you are lurking'},
	{name: 'barrelroll', description: 'Usage: "/barrelroll" - Rotate the page'},
	{name: 'party', description: 'Usage: "/party" - Make the page flash colors'},
	{name: 'rte', description: 'Usage: "/rte" - ReYohoho Twitch Extension!'},
	{
		name: 'b',
		description: 'Usage: "/b <login> [reason]" - Shortcut for /ban',
		permissionLevel: 2,
		commandArgs: [{name: 'username', isRequired: true}, {name: 'reason', isRequired: false}]
	},
	{
		name: 'u',
		description: 'Usage: "/u <login>" - Shortcut for /unban',
		permissionLevel: 2,
		commandArgs: [{name: 'username', isRequired: true}]
	},
	{
		name: 'purge',
		description: 'Usage: "/purge <login> [reason]" - Purge a user from chat',
		permissionLevel: 2,
		commandArgs: [{name: 'username', isRequired: true}, {name: 'reason', isRequired: false}]
	},
	{
		name: 'p',
		description: 'Usage: "/p <login> [reason]" - Shortcut for /purge',
		permissionLevel: 2,
		commandArgs: [{name: 'username', isRequired: true}, {name: 'reason', isRequired: false}]
	},
	{name: 'sub', description: 'Usage: "/sub" - Shortcut for /subscribers', permissionLevel: 2},
	{name: 'suboff', description: 'Usage: "/suboff" - Shortcut for /subscribersoff', permissionLevel: 2}
];

const COMMAND_MAP = new Map(COMMANDS.map(command => [command.name, command]));

class ReYohohoChatCommands extends Addon {
	constructor(...args) {
		super(...args);

		this.inject('settings');
		this.inject('site');
		this.inject('site.apollo');
		this.injectAs('siteChat', 'site.chat');
		this.inject('site.chat.input');

		this._pastaWindow = null;
	}

	onEnable() {
		this.settings.add(`${SETTING_PREFIX}.enabled`, {
			default: true,
			ui: {
				sort: 0,
				path: 'Add-Ons > ReYohoho Chat Commands',
				title: 'Enable ReYohoho chat commands',
				description: 'Adds /pasta, /chatters, /uptime, /viewers, /follows, /followed and several convenience commands.',
				component: 'setting-check-box'
			}
		});

		this.settings.add(`${SETTING_PREFIX}.pasta`, {
			default: true,
			ui: {
				sort: 1,
				path: 'Add-Ons > ReYohoho Chat Commands',
				title: 'Enable /pasta',
				description: 'Search copypastas from the ReYohoho pasta dump and insert the selected result into the chat input.',
				component: 'setting-check-box'
			}
		});

		this._installStyles();
		this.on('chat:get-tab-commands', this.onGetTabCommands, this);
		this.on('chat:pre-send-message', this.onPreSendMessage, this);
	}

	onDisable() {
		this.off('chat:get-tab-commands', this.onGetTabCommands, this);
		this.off('chat:pre-send-message', this.onPreSendMessage, this);
		this._closePastaWindow();
		document.getElementById(STYLE_ID)?.remove();
	}

	onGetTabCommands(event) {
		if (!this.settings.get(`${SETTING_PREFIX}.enabled`)) return;
		if (!Array.isArray(event?.commands)) return;

		for (const command of COMMANDS) {
			if (command.setting && !this.settings.get(`${SETTING_PREFIX}.${command.setting}`)) continue;

			event.commands.push({
				prefix: '/',
				name: command.name,
				description: command.description,
				permissionLevel: command.permissionLevel ?? 0,
				commandArgs: command.commandArgs || [],
				ffz_group: GROUP
			});
		}
	}

	onPreSendMessage(event) {
		if (!this.settings.get(`${SETTING_PREFIX}.enabled`)) return;

		const parsed = this._parseCommand(event.message);
		if (!parsed) return;

		const command = COMMAND_MAP.get(parsed.name);
		if (!command) return;
		if (command.setting && !this.settings.get(`${SETTING_PREFIX}.${command.setting}`)) return;

		event.preventDefault();
		this._runCommand(command.name, parsed.args, event);
	}

	_runCommand(name, args, event) {
		try {
			switch (name) {
				case 'pasta':
					return this._openPastaWindow(args.trim(), event._inst);
				case 'chatters':
					return this._showChatters(event);
				case 'uptime':
					return this._showUptime(event);
				case 'viewers':
					return this._showViewers(event);
				case 'follows':
					return this._showFollows(event);
				case 'followed':
					return this._showFollowed(event);
				case 'shrug':
					return this._sendMessage(event, `${args.trim()}${args.trim() ? ' ' : ''}¯\\_(ツ)_/¯`);
				case 'squishy':
					return this._sendMessage(event, 'notsquishY WHEN YOU NEED HIM notsquishY IN A JIFFY notsquishY USE THIS EMOTE notsquishY TO SUMMON SQUISHY notsquishY');
				case 'lurk':
					return this._sendMessage(event, '/me is now lurking');
				case 'barrelroll':
					return this._temporaryBodyClass('rte-chat-command-barrel-roll', 2000);
				case 'party':
					return this._temporaryBodyClass('rte-chat-command-party', 5000);
				case 'rte':
					return this._sendMessage(event, 'ReYohoho Twitch Extension! reyohohoNice');
				case 'b':
					return this._sendAlias(event, '/ban', args);
				case 'u':
					return this._sendAlias(event, '/unban', args);
				case 'purge':
				case 'p':
					return this._sendAlias(event, '/timeout', this._withPurgeDuration(args));
				case 'sub':
					return this._sendMessage(event, '/subscribers');
				case 'suboff':
					return this._sendMessage(event, '/subscribersoff');
				default:
					return null;
			}
		} catch (err) {
			this.log.error(`Error running /${name}.`, err);
			this._addNotice(event._inst, `ReYohoho: /${name} failed.`);
			return null;
		}
	}

	async _showChatters(event) {
		const channel = this._getChannel(event);
		if (!channel.login) return this._addNotice(event._inst, 'Could not resolve channel.');

		const result = await this._query(CHATTERS_QUERY, {name: channel.login});
		const count = result?.data?.channel?.chatters?.count;
		if (typeof count === 'number')
			this._addNotice(event._inst, `Current Chatters: ${this._formatNumber(count)}`);
		else
			this._addNotice(event._inst, 'Could not fetch chatter count.');
	}

	async _showUptime(event) {
		const channel = this._getChannel(event);
		if (!channel.id) return this._addNotice(event._inst, 'Could not resolve channel.');

		const result = await this._query(STREAM_QUERY, {userId: channel.id});
		const createdAt = result?.data?.user?.stream?.createdAt;
		if (!createdAt) return this._addNotice(event._inst, 'Stream is not live.');

		const seconds = Math.max(0, Math.round((Date.now() - new Date(createdAt).getTime()) / 1000));
		this._addNotice(event._inst, `Current Uptime: ${this._formatDuration(seconds)}`);
	}

	async _showViewers(event) {
		const channel = this._getChannel(event);
		if (!channel.id) return this._addNotice(event._inst, 'Could not resolve channel.');

		const result = await this._query(STREAM_QUERY, {userId: channel.id});
		const count = result?.data?.user?.stream?.viewersCount;
		if (typeof count === 'number')
			this._addNotice(event._inst, `Current Viewers: ${this._formatNumber(count)}`);
		else
			this._addNotice(event._inst, 'Could not fetch stream.');
	}

	async _showFollows(event) {
		const channel = this._getChannel(event);
		if (!channel.id) return this._addNotice(event._inst, 'Could not resolve channel.');

		const result = await this._query(FOLLOWERS_QUERY, {userId: channel.id});
		const count = result?.data?.user?.followers?.totalCount;
		if (typeof count === 'number')
			this._addNotice(event._inst, `Current Followers: ${this._formatNumber(count)}`);
		else
			this._addNotice(event._inst, 'Could not fetch follower count.');
	}

	async _showFollowed(event) {
		const user = this.site.getUser?.();
		if (!user?.login) return this._addNotice(event._inst, 'You are not logged in.');

		const channel = this._getChannel(event);
		if (!channel.id) return this._addNotice(event._inst, 'Could not resolve channel.');

		const result = await this._query(FOLLOWED_QUERY, {userId: channel.id});
		const followedAt = result?.data?.user?.self?.follower?.followedAt;
		if (!followedAt) return this._addNotice(event._inst, `You do not follow ${channel.displayName || channel.login}.`);

		const followedDate = new Date(followedAt);
		const seconds = Math.max(0, Math.round((Date.now() - followedDate.getTime()) / 1000));
		this._addNotice(
			event._inst,
			`You followed ${channel.displayName || channel.login} ${this._formatDuration(seconds)} ago (${followedDate.toLocaleDateString()}).`
		);
	}

	_parseCommand(message) {
		if (typeof message !== 'string') return null;

		const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(message.trim());
		if (!match) return null;

		return {
			name: match[1].toLowerCase(),
			args: match[2] || ''
		};
	}

	_getChannel(event) {
		const props = event?._inst?.props || {};
		return {
			id: props.channelID,
			login: props.channelLogin || event?.channel,
			displayName: props.channelDisplayName || props.channelLogin || event?.channel
		};
	}

	_query(query, variables) {
		const apollo = this.apollo || this.resolve('site.apollo');
		if (!apollo?.client) throw new Error('Apollo client unavailable.');

		return apollo.client.query({
			query,
			variables,
			fetchPolicy: 'network-only'
		});
	}

	_sendAlias(event, command, args) {
		const trimmed = args.trim();
		if (!trimmed) return this._addNotice(event._inst, `Usage: ${command} <login>`);
		return this._sendMessage(event, `${command} ${trimmed}`);
	}

	_withPurgeDuration(args) {
		const [username, ...reason] = args.trim().split(/\s+/);
		if (!username) return '';

		return [username, '1', reason.join(' ')].filter(Boolean).join(' ');
	}

	_sendMessage(event, message) {
		if (!message) return null;
		if (typeof event.sendMessage === 'function') return event.sendMessage(message, event.extra);
		return null;
	}

	_addNotice(inst, message) {
		if (!inst || typeof inst.addMessage !== 'function') return;

		const type = this.siteChat?.chat_types?.Notice ?? this.site?.children?.chat?.chat_types?.Notice ?? 32;
		inst.addMessage({type, message});
	}

	_formatNumber(value) {
		try {
			return this.resolve('i18n')?.formatNumber?.(value) || new Intl.NumberFormat().format(value);
		} catch {
			return String(value);
		}
	}

	_formatDuration(totalSeconds) {
		const days = Math.floor(totalSeconds / 86400),
			hours = Math.floor(totalSeconds / 3600) % 24,
			minutes = Math.floor(totalSeconds / 60) % 60,
			seconds = totalSeconds % 60,
			parts = [];

		if (days) parts.push(`${days}d`);
		if (hours) parts.push(`${hours}h`);
		if (minutes) parts.push(`${minutes}m`);
		if (seconds || !parts.length) parts.push(`${seconds}s`);

		return parts.join(' ');
	}

	_temporaryBodyClass(className, duration) {
		document.body.classList.add(className);
		setTimeout(() => document.body.classList.remove(className), duration);
	}

	_openPastaWindow(query, inst) {
		if (!query) {
			this._addNotice(inst, 'Usage: /pasta <query>');
			return;
		}

		this._closePastaWindow();

		const overlay = document.createElement('div');
		overlay.className = 'rte-pasta-overlay';

		const modal = document.createElement('div');
		modal.className = 'rte-pasta-modal';

		const header = document.createElement('div');
		header.className = 'rte-pasta-header';

		const title = document.createElement('h2');
		title.textContent = `Pasta Search: "${query}"`;

		const close = document.createElement('button');
		close.className = 'rte-pasta-close';
		close.type = 'button';
		close.textContent = 'x';
		close.addEventListener('click', () => this._closePastaWindow());

		const content = document.createElement('div');
		content.className = 'rte-pasta-content';
		content.textContent = 'Loading...';

		header.append(title, close);
		modal.append(header, content);
		overlay.append(modal);
		overlay.addEventListener('mousedown', event => {
			if (event.target === overlay) this._closePastaWindow();
		});

		document.body.appendChild(overlay);
		this._pastaWindow = overlay;

		fetch(PASTA_API, {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({query, limit: 10})
		})
			.then(response => {
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				return response.json();
			})
			.then(data => this._renderPastas(content, this._normalizePastas(data), inst))
			.catch(err => {
				content.className = 'rte-pasta-content rte-pasta-error';
				content.textContent = `Error: ${err.message}`;
			});
	}

	_closePastaWindow() {
		this._pastaWindow?.remove();
		this._pastaWindow = null;
	}

	_normalizePastas(data) {
		if (Array.isArray(data)) return data;
		if (Array.isArray(data?.pastas)) return data.pastas;
		if (Array.isArray(data?.results)) return data.results;
		if (Array.isArray(data?.data)) return data.data;
		return [];
	}

	_renderPastas(container, pastas, inst) {
		container.textContent = '';
		container.className = 'rte-pasta-content';

		if (!pastas.length) {
			container.textContent = 'No copypastas found.';
			return;
		}

		const results = document.createElement('div');
		results.className = 'rte-pasta-results';

		for (const pasta of pastas) {
			const text = typeof pasta === 'object' ? (pasta.text || pasta.content || '') : String(pasta);
			if (!text) continue;

			const item = document.createElement('button');
			item.type = 'button';
			item.className = 'rte-pasta-item';

			const body = document.createElement('div');
			body.className = 'rte-pasta-text';
			body.textContent = text;
			item.appendChild(body);

			if (pasta?.author) {
				const author = document.createElement('div');
				author.className = 'rte-pasta-author';
				author.textContent = `by ${pasta.author}`;
				item.appendChild(author);
			}

			item.addEventListener('click', () => {
				this._replaceInputWithPasta(inst, text);
				this._closePastaWindow();
			});

			results.appendChild(item);
		}

		container.appendChild(results);
	}

	_replaceInputWithPasta(inst, text) {
		const target = this._getChatInputFromTarget(inst) || this._getVisibleChatInput();
		if (!target) return;

		const current = this._getInputValue(target);
		const prefix = current.replace(/^\/pasta(?:\s+[\s\S]*)?$/i, '').trim();
		const value = prefix ? `${prefix} ${text}` : text;

		this._setInputValue(target, value);
	}

	_getChatInputFromTarget(target) {
		if (!target) return null;
		if (target.autocompleteInputRef) return target;

		const channelLogin = target.props?.channelLogin;
		if (!channelLogin || !this.input?.ChatInput) return null;

		for (const inst of this.input.ChatInput.instances) {
			if (inst?.props?.channelLogin === channelLogin && inst.autocompleteInputRef)
				return inst;
		}

		return null;
	}

	_getVisibleChatInput() {
		const chatInput = this.input;
		if (!chatInput?.ChatInput) return null;

		for (const inst of chatInput.ChatInput.instances) {
			if (inst?.autocompleteInputRef && this._isInstanceVisible(inst)) return inst;
		}

		return chatInput.ChatInput.instances[0] || null;
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
		if (typeof inst?.ffzGetValue === 'function') return inst.ffzGetValue();
		if (typeof inst?.state?.value === 'string') return inst.state.value;
		if (typeof inst?.chatInputRef?.value === 'string') return inst.chatInputRef.value;
		return '';
	}

	_setInputValue(inst, value) {
		if (typeof inst?.autocompleteInputRef?.setValue === 'function') {
			inst.autocompleteInputRef.setValue(value);
			inst.autocompleteInputRef.componentRef?.focus?.();
			return;
		}

		const el = inst?.chatInputRef;
		if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
			el.value = value;
			el.dispatchEvent(new Event('input', {bubbles: true}));
			el.focus?.();
		}
	}

	_installStyles() {
		if (document.getElementById(STYLE_ID)) return;

		const style = document.createElement('style');
		style.id = STYLE_ID;
		style.textContent = `
.rte-pasta-overlay {
	align-items: center;
	background: rgba(0, 0, 0, 0.7);
	display: flex;
	inset: 0;
	justify-content: center;
	position: fixed;
	z-index: 10000;
}

.rte-pasta-modal {
	background: #18181b;
	border: 1px solid #3a3a3d;
	border-radius: 8px;
	box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
	color: #efeff1;
	display: flex;
	flex-direction: column;
	max-height: 80vh;
	width: min(450px, calc(100vw - 32px));
}

.rte-pasta-header {
	align-items: center;
	border-bottom: 1px solid #3a3a3d;
	display: flex;
	justify-content: space-between;
	padding: 16px 20px;
}

.rte-pasta-header h2 {
	font-size: 18px;
	font-weight: 600;
	margin: 0;
}

.rte-pasta-close {
	background: none;
	border: 0;
	border-radius: 4px;
	color: #efeff1;
	cursor: pointer;
	font-size: 20px;
	height: 30px;
	width: 30px;
}

.rte-pasta-close:hover {
	background: #3a3a3d;
}

.rte-pasta-content {
	flex: 1;
	overflow-y: auto;
	padding: 20px;
}

.rte-pasta-error {
	color: #ff6b6b;
	text-align: center;
}

.rte-pasta-results {
	display: flex;
	flex-direction: column;
	gap: 12px;
}

.rte-pasta-item {
	background: #1f1f23;
	border: 1px solid #3a3a3d;
	border-radius: 6px;
	color: #efeff1;
	cursor: pointer;
	padding: 12px;
	text-align: left;
}

.rte-pasta-item:hover {
	background: #26262c;
	border-color: #5c5c61;
}

.rte-pasta-text {
	font-size: 13px;
	line-height: 1.4;
	overflow-wrap: anywhere;
}

.rte-pasta-author {
	color: #adadb8;
	font-size: 12px;
	font-style: italic;
	margin-top: 4px;
}

.rte-chat-command-barrel-roll {
	animation: rte-barrel-roll 2s ease-in-out;
}

.rte-chat-command-party {
	animation: rte-party 0.5s linear infinite;
}

@keyframes rte-barrel-roll {
	from { transform: rotate(0deg); }
	to { transform: rotate(360deg); }
}

@keyframes rte-party {
	0% { filter: hue-rotate(0deg); }
	100% { filter: hue-rotate(360deg); }
}
`;
		document.head.appendChild(style);
	}
}

ReYohohoChatCommands.register();
