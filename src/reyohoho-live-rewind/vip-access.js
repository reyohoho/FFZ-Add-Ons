const CACHE_TTL_MS = 5 * 60 * 1000;

let cachedHasSubscription = null;
let cacheTimestamp = 0;

export function invalidateVipAccessCache() {
	cachedHasSubscription = null;
	cacheTimestamp = 0;
}

function parseSubscriptionResult(data) {
	if (!data || typeof data !== 'object' || data.error) {
		return {has_subscription: false, error: true};
	}

	return {
		has_subscription: data.has_subscription === true,
		error: false
	};
}

export async function checkSubscription(proxyBase, twitchId) {
	try {
		if (!proxyBase || !twitchId) {
			return {has_subscription: false, error: true};
		}

		const response = await fetch(`${proxyBase}/api/subscription/check/${encodeURIComponent(twitchId)}`);
		if (!response.ok) {
			return {has_subscription: false, error: true};
		}

		return parseSubscriptionResult(await response.json());
	} catch (error) {
		return {has_subscription: false, error: true};
	}
}

export async function hasRteSubscription(proxyBase, twitchId, forceRefresh = false) {
	if (!twitchId) {
		return false;
	}

	const now = Date.now();
	if (!forceRefresh && cachedHasSubscription === true && now - cacheTimestamp < CACHE_TTL_MS) {
		return true;
	}

	const result = await checkSubscription(proxyBase, twitchId);

	if (result?.error) {
		invalidateVipAccessCache();
		return false;
	}

	cachedHasSubscription = result.has_subscription === true;
	cacheTimestamp = now;
	return cachedHasSubscription;
}

export function openSubscriptionPage() {
	window.open('https://ext.rte.net.ru', '_blank');
}
