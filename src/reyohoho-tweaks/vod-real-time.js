import gql from 'graphql-tag';

const TIME_LABELS_SELECTOR = '.vod-seekbar-time-labels';
const CURRENT_TIME_SELECTOR = '[data-a-target="player-seekbar-current-time"]';
const REAL_TIME_CLASS = 'rte-vod-real-time';

const VOD_CREATED_AT_QUERY = gql`
	query RTEGetVodCreatedAt($id: ID!) {
		video(id: $id) {
			id
			createdAt
		}
	}
`;

function getVodId() {
	return window.location.pathname.match(/^\/videos\/(\d+)/)?.[1] ?? null;
}

function parseTimecode(text) {
	const parts = text.trim().split(':').map(Number);
	if (parts.length === 0 || parts.some(part => !Number.isFinite(part)))
		return null;
	return parts.reduce((total, part) => total * 60 + part, 0);
}

export default class VodRealTime {
	constructor(addon) {
		this.addon = addon;
		this.enabled = false;
		this.createdAtByVodId = new Map();
		this.Labels = addon.elemental.define('rte-vod-time-labels', TIME_LABELS_SELECTOR, null, null, 0);
	}

	update() {
		const enabled = this.addon.isOn('vod-real-time');
		if (enabled === this.enabled)
			return;
		this.enabled = enabled;

		if (enabled) {
			this.Labels.on('mount', this.attach, this);
			this.Labels.each(labels => this.attach(labels));
			return;
		}

		this.Labels.off('mount', this.attach, this);
		for (const node of document.querySelectorAll(`.${REAL_TIME_CLASS}`)) {
			node._rte_observer?.disconnect();
			node.remove();
		}
	}

	getCreatedAt(vodId) {
		if (!this.createdAtByVodId.has(vodId)) {
			const request = this.addon.apollo.client
				.query({query: VOD_CREATED_AT_QUERY, variables: {id: vodId}})
				.then(({data}) => (data?.video?.createdAt ? new Date(data.video.createdAt) : null))
				.catch(() => null)
				.then(createdAt => {
					if (createdAt == null)
						this.createdAtByVodId.delete(vodId);
					return createdAt;
				});
			this.createdAtByVodId.set(vodId, request);
		}
		return this.createdAtByVodId.get(vodId);
	}

	formatRealTime(date) {
		const options = {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit'};
		if (date.getFullYear() !== new Date().getFullYear())
			options.year = 'numeric';
		return date.toLocaleString(this.addon.i18n.locale || undefined, options);
	}

	async attach(labels) {
		const vodId = getVodId();
		const currentTime = labels.querySelector(CURRENT_TIME_SELECTOR);
		if (vodId == null || currentTime == null || labels.querySelector(`.${REAL_TIME_CLASS}`) != null)
			return;

		const createdAt = await this.getCreatedAt(vodId);
		if (createdAt == null || !this.enabled || !currentTime.isConnected || labels.querySelector(`.${REAL_TIME_CLASS}`) != null)
			return;

		const realTime = document.createElement('p');
		realTime.className = `${currentTime.className} ${REAL_TIME_CLASS}`;
		realTime.title = this.addon.t('vod-real-time.tooltip', 'Real time of the broadcast at this moment (your clock)');
		currentTime.after(realTime);

		// React rewrites the timecode text in place, so follow it instead of polling the player
		const update = () => {
			// The seekbar can survive navigation to another VOD
			if (getVodId() !== vodId) {
				observer.disconnect();
				realTime.remove();
				this.attach(labels);
				return;
			}
			const seconds = parseTimecode(currentTime.textContent);
			realTime.textContent = seconds == null ? '' : this.formatRealTime(new Date(createdAt.getTime() + seconds * 1000));
		};
		const observer = new MutationObserver(update);
		observer.observe(currentTime, {childList: true, characterData: true, subtree: true});
		realTime._rte_observer = observer;
		update();
	}
}
