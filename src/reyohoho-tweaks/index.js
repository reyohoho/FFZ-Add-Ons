import Ambilight from './ambilight.js';
import ChannelTweaks from './channel-tweaks.js';
import ChatResize from './chat-resize.js';
import LiveCatchup from './live-catchup.js';
import VodRealTime from './vod-real-time.js';
import VolumeWheel from './volume-wheel.js';
import STYLE_URL from './style.css';

const {createElement} = FrankerFaceZ.utilities.dom;

const PREFIX = 'addon.reyohoho-tweaks';
const PATH = 'Add-Ons > ReYohoho Tweaks';
const STYLE_ID = 'rte-tweaks-style';

// Each entry inherits the section of the previous one; entries with min/max are numeric text boxes
const SETTINGS = [
	{key: 'ambilight.enabled', default: true, section: 'Ambilight', title: 'Ambilight',
		description: 'Light up the area around the player with the colors of the stream. Needs the dark Twitch theme and hardware acceleration (WebGL 2).'},
	{key: 'ambilight.button', default: true, title: 'Show the Ambilight button in the player',
		description: 'Click toggles the light, right click opens these settings.'},
	{key: 'ambilight.brightness', default: 75, min: 20, max: 100, title: 'Brightness, %'},
	{key: 'ambilight.size', default: 100, min: 50, max: 200, title: 'Glow size, %'},
	{key: 'ambilight.blur', default: 60, min: 10, max: 100, title: 'Blur, px'},
	{key: 'ambilight.saturation', default: 125, min: 100, max: 300, title: 'Saturation, %'},
	{key: 'ambilight.smoothness', default: 66, min: 0, max: 95, title: 'Smoothness of color changes, %'},
	{key: 'ambilight.fill-bars', default: true, title: 'Light up the black bars around the video in theatre mode'},

	{key: 'live-catchup.enabled', default: false, section: 'Live Catch-Up', title: 'Live catch-up',
		description: 'Slightly speed up the live stream until the delay drops to the target. Pauses after buffering so the player can rebuild its buffer.'},
	{key: 'live-catchup.target', default: 3, min: 1, max: 30, title: 'Target delay, seconds'},
	{key: 'live-catchup.rate', default: 1.1, min: 1.05, max: 2, title: 'Catch-up speed',
		description: 'Above 1.25 may be noticeable or unstable.'},

	{key: 'vod-real-time', default: true, section: 'VODs', title: 'Show the real time of the broadcast on VODs',
		description: 'Show the real date and time of the broadcast next to the timecode when watching a VOD.'},

	{key: 'chat-resize', default: true, section: 'Chat', title: 'Resize the chat by dragging its edge',
		description: 'Drag the edge of the chat column next to the player. Double-click the edge to reset. Changes the Chat > Appearance > Width setting.'},
	{key: 'hide.ai-summary', default: false, title: 'Hide AI stream summaries',
		description: 'Hide the AI-generated mid-stream summary recaps Twitch shows in chat.'},

	{key: 'hide.sub-upgrade', default: false, section: 'Channel', title: 'Hide the "Upgrade subscription" button'},
	{key: 'hide.notifications', default: false, title: 'Hide the channel notifications bell'},
	{key: 'hide.bits-balance', default: false, title: 'Hide the Bits balance under the chat input'},
	{key: 'hide.bits-offer', default: false, title: 'Hide the "Bits" discount offer button'},

	{key: 'sidebar.sort-by-viewers', default: false, section: 'Sidebar', title: 'Sort followed channels by viewers',
		description: 'Switch the followed channels list to the "Viewers (High to Low)" sort.'}
];

function numberProcessor(min, max, fallback) {
	return val => {
		const number = parseFloat(val);
		return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
	};
}

class ReyohohoTweaks extends Addon {
	constructor(...args) {
		super(...args);

		this.inject('settings');
		this.inject('i18n');
		this.inject('site');
		this.inject('site.fine');
		this.inject('site.elemental');
		this.inject('site.apollo');
		this.inject('site.player');

		this.active = false;
		this.update = this.update.bind(this);

		let section;
		SETTINGS.forEach((entry, sort) => {
			section = entry.section ?? section;
			const numeric = entry.min != null;
			this.settings.add(`${PREFIX}.${entry.key}`, {
				default: entry.default,
				ui: {
					sort,
					path: `${PATH} >> ${section}`,
					title: entry.title,
					description: entry.description,
					component: numeric ? 'setting-text-box' : 'setting-check-box',
					process: numeric ? numberProcessor(entry.min, entry.max, entry.default) : undefined
				},
				changed: this.update
			});
		});

		this.ambilight = new Ambilight(this);
		this.liveCatchup = new LiveCatchup(this);
		this.vodRealTime = new VodRealTime(this);
		this.chatResize = new ChatResize(this);
		this.channelTweaks = new ChannelTweaks(this);
		this.volumeWheel = new VolumeWheel(this);
	}

	onEnable() {
		this.active = true;
		if (!document.getElementById(STYLE_ID))
			document.head.appendChild(createElement('link', {
				id: STYLE_ID,
				href: STYLE_URL,
				rel: 'stylesheet',
				type: 'text/css',
				crossOrigin: 'anonymous'
			}));

		this.on('site.player:update-gui', this.ambilight.addButton, this.ambilight);
		this.update();
	}

	onDisable() {
		this.active = false;
		this.off('site.player:update-gui', this.ambilight.addButton, this.ambilight);
		this.update();
		document.getElementById(STYLE_ID)?.remove();
	}

	update() {
		this.ambilight.update();
		this.liveCatchup.update();
		this.vodRealTime.update();
		this.chatResize.update();
		this.channelTweaks.update();
		this.volumeWheel.update();
	}

	get(key) {
		return this.settings.get(`${PREFIX}.${key}`);
	}

	isOn(key) {
		return this.active && !!this.get(key);
	}

	// Into the active profile the current value comes from (the first one that has the key), so the change is not
	// shadowed by it; the default profile when no profile sets the key
	setValue(key, value) {
		const profile = [...this.settings.main_context.profiles()].find(p => p.has(key)) ?? this.settings.profile(0);
		if (value == null)
			profile?.delete(key);
		else
			profile?.set(key, value);
	}

	openSettings() {
		const menu = this.resolve('main_menu');
		if (!menu)
			return;
		menu.requestPage('add_ons.re_yohoho_tweaks');
		if (!menu.showing)
			menu.emit('site.menu_button:clicked');
	}

	t(key, fallback, data) {
		return this.i18n.t(`${PREFIX}.${key}`, fallback, data);
	}
}

ReyohohoTweaks.register();
