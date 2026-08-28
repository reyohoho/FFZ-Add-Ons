const TWITCH_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const GQL_URL = 'https://gql.twitch.tv/gql';

const VOD_QUALITIES = ['chunked', '1080p60', '720p60', '480p30', '360p30', '160p30'];

const QUALITY_INFO = {
	chunked: {res: '1920x1080', fps: 60},
	'1080p60': {res: '1920x1080', fps: 60},
	'720p60': {res: '1280x720', fps: 60},
	'480p30': {res: '854x480', fps: 30},
	'360p30': {res: '640x360', fps: 30},
	'160p30': {res: '284x160', fps: 30},
};

function getAuthToken() {
	const match = document.cookie.match(/auth-token=([^;]+)/);
	return match ? match[1] : null;
}

async function gqlFetch(body) {
	const headers = {'Client-ID': TWITCH_CLIENT_ID, 'Content-Type': 'application/json'};
	const token = getAuthToken();
	if (token) headers.Authorization = `OAuth ${token}`;
	const res = await fetch(GQL_URL, {method: 'POST', headers, body: JSON.stringify(body)});
	if (!res.ok) throw new Error(`GQL ${res.status}`);
	return res.json();
}

export async function fetchVodMetadata(vodId) {
	const data = await gqlFetch({
		query: `query{video(id:"${vodId}"){broadcastType createdAt seekPreviewsURL owner{login}}}`,
	});
	return data?.data?.video ?? null;
}

export async function isSubscribed(login) {
	try {
		const data = await gqlFetch({
			query: `query($login:String!){user(login:$login){self{subscriptionBenefit{id}}}}`,
			variables: {login},
		});
		return !!data?.data?.user?.self?.subscriptionBenefit?.id;
	} catch (_) {
		return false;
	}
}

export async function fetchCurrentVod(login) {
	const data = await gqlFetch({
		query: `query($login:String!){user(login:$login){videos(first:5,sort:TIME,type:ARCHIVE){edges{node{id createdAt status}}}}}`,
		variables: {login},
	});
	const edges = data?.data?.user?.videos?.edges;
	if (!edges?.length) return null;
	const recording = edges.find((edge) => edge.node.status === 'RECORDING');
	return recording ? recording.node : null;
}

export async function fetchVodToken(vodId) {
	const data = await gqlFetch({
		operationName: 'PlaybackAccessToken_Template',
		query: `query PlaybackAccessToken_Template($login:String!,$isLive:Boolean!,$vodID:ID!,$isVod:Boolean!,$playerType:String!){videoPlaybackAccessToken(id:$vodID,params:{platform:"web",playerBackend:"mediaplayer",playerType:$playerType})@include(if:$isVod){value signature __typename}}`,
		variables: {login: '', isLive: false, vodID: vodId, isVod: true, playerType: 'site'},
	});
	return data?.data?.videoPlaybackAccessToken ?? null;
}

export function vodPlaylistUrl(vodId, token, sig) {
	const params = new URLSearchParams({
		allow_source: 'true',
		allow_audio_only: 'true',
		allow_spectre: 'true',
		player: 'twitchweb',
		playlist_include_framerate: 'true',
		nauth: token,
		nauthsig: sig,
	});
	return `https://usher.ttvnw.net/vod/${vodId}.m3u8?${params}`;
}

function buildDirectVodUrl(meta, vodId, quality) {
	if (!meta?.seekPreviewsURL) return null;
	const url = new URL(meta.seekPreviewsURL);
	const domain = url.host;
	const parts = url.pathname.split('/');
	const sbIdx = parts.findIndex((part) => part.includes('storyboards'));
	if (sbIdx < 1) return null;
	const vodSpecialId = parts[sbIdx - 1];
	const type = (meta.broadcastType || '').toLowerCase();
	const login = meta.owner?.login || '';
	const createdAt = meta.createdAt || '';

	if (type === 'highlight') {
		return `https://${domain}/${vodSpecialId}/${quality}/highlight-${vodId}.m3u8`;
	}
	if (type === 'upload') {
		const created = new Date(createdAt);
		const cutoff = new Date();
		cutoff.setDate(cutoff.getDate() - 7);
		if (created < cutoff) {
			return `https://${domain}/${login}/${vodId}/${vodSpecialId}/${quality}/index-dvr.m3u8`;
		}
	}
	return `https://${domain}/${vodSpecialId}/${quality}/index-dvr.m3u8`;
}

export async function buildSyntheticVodPlaylistUrl(vodId) {
	const meta = await fetchVodMetadata(vodId);
	if (!meta?.seekPreviewsURL) return null;

	const lines = [
		'#EXTM3U',
		'#EXT-X-TWITCH-INFO:ORIGIN="s3",B="false",REGION="EU",USER-IP="0.0.0.0",SERVING-ID="na",CLUSTER="cloudfront_vod",USER-COUNTRY="US",MANIFEST-CLUSTER="cloudfront_vod"',
	];
	let bandwidth = 8534030;

	for (const quality of VOD_QUALITIES) {
		const url = buildDirectVodUrl(meta, vodId, quality);
		if (!url) continue;
		const info = QUALITY_INFO[quality];
		lines.push(
			`#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},CODECS="avc1.4D001E,mp4a.40.2",RESOLUTION=${info.res},FRAME-RATE=${info.fps},STABLE-VARIANT-ID="${quality}",IVS-NAME="${quality}",IVS-VARIANT-SOURCE="transcode"`
		);
		lines.push(url);
		bandwidth -= 100000;
	}

	if (lines.length <= 2) return null;

	const blob = new Blob([`${lines.join('\n')}\n`], {type: 'application/vnd.apple.mpegurl'});
	return URL.createObjectURL(blob);
}

export function revokeVodPlaybackUrl(url) {
	if (url?.startsWith('blob:')) {
		URL.revokeObjectURL(url);
	}
}

export async function resolveVodPlaybackUrl(vodId, {synthetic = false} = {}) {
	if (!synthetic) {
		const token = await fetchVodToken(vodId);
		if (token) {
			return vodPlaylistUrl(vodId, token.value, token.signature);
		}
	}

	return buildSyntheticVodPlaylistUrl(vodId);
}
