// =============================================================================
// Constants
// =============================================================================

const PLATFORM = "PeerTube";

const getUserAgent = () => bridge.authUserAgent ?? bridge.captchaUserAgent ?? 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.200 Mobile Safari/537.36';

const IS_DESKTOP = bridge.buildPlatform === "desktop";

const IMPERSONATION_TARGET = IS_DESKTOP ? 'chrome136' : 'chrome131_android';

const IS_IMPERSONATION_AVAILABLE = (typeof httpimp !== 'undefined');

const supportedResolutions = {
	'1080p': { width: 1920, height: 1080 },
	'720p': { width: 1280, height: 720 },
	'480p': { width: 854, height: 480 },
	'360p': { width: 640, height: 360 },
	'240p': { width: 426, height: 240 },
	'144p': { width: 256, height: 144 }
};

const URLS = {
	PEERTUBE_LOGO: "https://plugins.grayjay.app/PeerTube/peertube.png"
}

const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_HISTORY = 100;

// Query parameter to flag private/unlisted playlists that require authentication
// This is added by getUserPlaylists and checked by getPlaylist

const PRIVATE_PLAYLIST_QUERY_PARAM = '&requiresAuth=1';

// instances are populated during deploy appended to the end of this javascript file
// this update process is done at update-instances.sh

// =============================================================================
// Regex patterns
// =============================================================================

// =============================================================================
// State
// =============================================================================

let config = {};

let _settings = {};

let state = {
	serverVersion: '',
	defaultHeaders: {
		'User-Agent': getUserAgent()
	}
}

let INDEX_INSTANCES = {
	instances: []
};



if (IS_IMPERSONATION_AVAILABLE) {
	const httpImpClient = httpimp.getDefaultClient(true);
	if (httpImpClient.setDefaultImpersonateTarget) {
		httpImpClient.setDefaultImpersonateTarget(IMPERSONATION_TARGET);
	}
}

Type.Feed.Playlists = "PLAYLISTS";

// =============================================================================
// Source functions
// =============================================================================

source.enable = function (conf, settings, saveStateStr) {
	config = conf ?? {};
	_settings = settings ?? {};

	let didSaveState = false;

	if (IS_TESTING && !plugin?.config?.constants?.baseUrl) {
		plugin = {
			config: {
				constants: {
					baseUrl: "https://peertube.futo.org"
				}
			}
		};
	}

	try {
		if (saveStateStr) {
			state = JSON.parse(saveStateStr);
			didSaveState = true;
		}
	} catch (ex) {
		log('Failed to parse saveState:' + ex);
	}

	if (!didSaveState) {
		try {
			const [{ body: serverConfig }] = httpGET({ url: `${plugin.config.constants.baseUrl}/api/v1/config`, parseResponse: true });
			state.serverVersion = serverConfig.serverVersion;
		} catch (e) {
			log("Failed to detect server version, continuing with defaults: " + e);
		}
	}

};

source.saveState = function () {
	return JSON.stringify(state)
}

source.getHome = function () {

	let sort = '';

	// Get the sorting preference from settings
	const sortOptions = [
		'best',        // 0: Best (Algorithm)
		'-publishedAt', // 1: Newest
		'publishedAt',  // 2: Oldest
		'-views',       // 3: Most Views
		'-likes',       // 4: Most Likes
		'-trending',    // 5: Trending
		'-hot'          // 6: Hot
	];

	const homeFeedSortIndex = _settings.homeFeedSortIndex || 0;
	sort = sortOptions[homeFeedSortIndex] || 'best';

	// Check version compatibility for certain sorting options
	// v3.1.0+ introduced best, trending, and hot algorithms
	// https://docs.joinpeertube.org/CHANGELOG#v3-1-0
	const requiresV3_1 = ['best', '-trending', '-hot'];

	if (requiresV3_1.includes(sort) && !ServerInstanceVersionIsSameOrNewer(state.serverVersion, '3.1.0')) {
		// Fallback to newest for old versions
		log(`Sort option '${sort}' requires PeerTube v3.1.0+, falling back to '-publishedAt'`);
		sort = '-publishedAt';
	}

	const params = { sort };


	// Collect category filters from settings
	const settingSet = new Set([
		_settings.mainCategoryIndex,
		_settings.secondCategoryIndex,
		_settings.thirdCategoryIndex,
		_settings.fourthCategoryIndex,
		_settings.fifthCategoryIndex
	]);

	const categoryIds = Array.from(settingSet)
		.filter(categoryIndex => categoryIndex && parseInt(categoryIndex) > 0)
		.map(categoryIndex => getCategoryId(categoryIndex))
		.filter(Boolean);

	// Collect language filters from settings
	const languageSettingSet = new Set([
		_settings.firstLanguageIndex,
		_settings.secondLanguageIndex,
		_settings.thirdLanguageIndex
	]);

	const languageCodes = Array.from(languageSettingSet)
		.filter(languageIndex => languageIndex && parseInt(languageIndex) > 0)
		.map(languageIndex => getLanguageCode(languageIndex))
		.filter(Boolean);


	// Apply category and language filters (shared across all sources)
	if (categoryIds.length > 0) {
		params.categoryOneOf = categoryIds;
	}
	if (languageCodes.length > 0) {
		params.languageOneOf = languageCodes;
	}

	// Map PeerTube sort options to Sepia Search equivalents
	const sepiaSearchSortMap = {
		'best': 'match',           // Best algorithm -> relevance match
		'-publishedAt': '-createdAt', // Newest -> most recent
		'publishedAt': 'createdAt',   // Oldest -> least recent
		'-views': '-views',        // Most Views -> same
		'-likes': '-likes',        // Most Likes -> same
		'-trending': '-views',     // Trending -> most views (closest equivalent)
		'-hot': '-views'           // Hot -> most views (closest equivalent)
	};

	if (_settings.homeSourceCurrentInstance === true && _settings.homeSourceSepiaSearch === true) {
		// Both sources: fetch in parallel, merge, deduplicate
		const localContext = {
			path: '/api/v1/videos',
			params: { ...params },
			page: 0,
			sourceHost: plugin.config.constants.baseUrl
		};
		const sepiaContext = {
			path: '/api/v1/search/videos',
			params: { ...params, resultType: 'videos', sort: sepiaSearchSortMap[sort] || 'match' },
			page: 0,
			sourceHost: 'https://sepiasearch.org'
		};
		return getMixedVideoPager(localContext, sepiaContext);
	} else if (_settings.homeSourceSepiaSearch === true) {
		// Sepia Search only
		params.resultType = 'videos';
		params.sort = sepiaSearchSortMap[sort] || 'match';
		return getVideoPager('/api/v1/search/videos', params, 0, 'https://sepiasearch.org', true);
	} else {
		// Current instance only (default)
		return getVideoPager('/api/v1/videos', params, 0, plugin.config.constants.baseUrl, false);
	}
};

source.searchSuggestions = function (query) {
	if (!_settings.enableSearchSuggestions) return [];
	if (!query || query.trim().length < 2) return [];

	try {
		const nsfwPolicy = getNSFWPolicy();
		const baseParams = {
			search: query.trim(),
			start: 0,
			count: 10
		};
		if (nsfwPolicy !== 'display') {
			baseParams.nsfw = false;
		}

		// Fetch from enabled sources
		const requests = [];
		if (_settings.searchCurrentInstance === true) {
			requests.push(`${plugin.config.constants.baseUrl}/api/v1/search/videos?${buildQuery(baseParams)}`);
		}
		if (_settings.searchSepiaSearch === true) {
			requests.push(`https://sepiasearch.org/api/v1/search/videos?${buildQuery({ ...baseParams, resultType: 'videos' })}`);
		}
		if (requests.length === 0) {
			requests.push(`${plugin.config.constants.baseUrl}/api/v1/search/videos?${buildQuery(baseParams)}`);
		}

		const allVideos = [];
		if (requests.length === 1) {
			const [resp] = httpGET(requests[0]);
			const data = JSON.parse(resp.body);
			if (data?.data) allVideos.push(...data.data);
		} else {
			const responses = httpGET(requests);
			for (const resp of responses) {
				if (!resp.isOk) continue;
				try {
					const data = JSON.parse(resp.body);
					if (data?.data) allVideos.push(...data.data);
				} catch (e) { /* ignore */ }
			}
		}
		if (!allVideos.length) return [];

		// Collect unique tags and video titles that match the query
		const queryLower = query.trim().toLowerCase();
		const seen = new Set();
		const suggestions = [];

		for (const video of allVideos) {
			// Add matching video titles
			if (video.name && video.name.toLowerCase().includes(queryLower)) {
				const key = video.name.toLowerCase();
				if (!seen.has(key)) {
					seen.add(key);
					suggestions.push(video.name);
				}
			}

			// Add matching tags
			for (const tag of (video.tags ?? [])) {
				if (tag.toLowerCase().includes(queryLower)) {
					const key = tag.toLowerCase();
					if (!seen.has(key)) {
						seen.add(key);
						suggestions.push(tag);
					}
				}
			}
		}

		return suggestions.slice(0, 10);
	} catch (e) {
		log("Failed to get search suggestions", e);
		return [];
	}
};

source.getSearchCapabilities = () => {
	return new ResultCapabilities([Type.Feed.Mixed, Type.Feed.Videos], [], [
		new FilterGroup("Upload Date", [
			new FilterCapability("Last Hour", Type.Date.LastHour),
			new FilterCapability("This Day", Type.Date.Today),
			new FilterCapability("This Week", Type.Date.LastWeek),
			new FilterCapability("This Month", Type.Date.LastMonth),
			new FilterCapability("This Year", Type.Date.LastYear),
		], false, "date"),
		new FilterGroup("Duration", [
			new FilterCapability("Under 4 minutes", Type.Duration.Short),
			new FilterCapability("4-20 minutes", Type.Duration.Medium),
			new FilterCapability("Over 20 minutes", Type.Duration.Long)
		], false, "duration"),
		new FilterGroup("Features", [
			new FilterCapability("Live", "live", "live"),
		], true, "features"),
		new FilterGroup("License", [
			new FilterCapability("Attribution", "1"),
			new FilterCapability("Attribution - Share Alike", "2"),
			new FilterCapability("Attribution - No Derivatives", "3"),
			new FilterCapability("Attribution - Non Commercial", "4"),
			new FilterCapability("Attribution - Non Commercial - Share Alike", "5"),
			new FilterCapability("Attribution - Non Commercial - No Derivatives", "6"),
			new FilterCapability("Public Domain Dedication", "7"),
		], true, "license"),
		new FilterGroup("Content", [
			new FilterCapability("All Content", "all_content"),
			new FilterCapability("Safe Content Only", "safe_only"),
			new FilterCapability("NSFW Content Only", "nsfw_only"),
		], false, "nsfw"),
		new FilterGroup("Category", [
			new FilterCapability("Music", "1"),
			new FilterCapability("Films", "2"),
			new FilterCapability("Vehicles", "3"),
			new FilterCapability("Art", "4"),
			new FilterCapability("Sports", "5"),
			new FilterCapability("Travels", "6"),
			new FilterCapability("Gaming", "7"),
			new FilterCapability("People", "8"),
			new FilterCapability("Comedy", "9"),
			new FilterCapability("Entertainment", "10"),
			new FilterCapability("News & Politics", "11"),
			new FilterCapability("How To", "12"),
			new FilterCapability("Education", "13"),
			new FilterCapability("Activism", "14"),
			new FilterCapability("Science & Technology", "15"),
			new FilterCapability("Animals", "16"),
			new FilterCapability("Kids", "17"),
			new FilterCapability("Food", "18"),
		], true, "category"),
		new FilterGroup("Language", [
			new FilterCapability("English", "en"),
			new FilterCapability("Français", "fr"),
			new FilterCapability("العربية", "ar"),
			new FilterCapability("Català", "ca"),
			new FilterCapability("Čeština", "cs"),
			new FilterCapability("Deutsch", "de"),
			new FilterCapability("ελληνικά", "el"),
			new FilterCapability("Esperanto", "eo"),
			new FilterCapability("Español", "es"),
			new FilterCapability("Euskara", "eu"),
			new FilterCapability("فارسی", "fa"),
			new FilterCapability("Suomi", "fi"),
			new FilterCapability("Gàidhlig", "gd"),
			new FilterCapability("Galego", "gl"),
			new FilterCapability("Hrvatski", "hr"),
			new FilterCapability("Magyar", "hu"),
			new FilterCapability("Íslenska", "is"),
			new FilterCapability("Italiano", "it"),
			new FilterCapability("日本語", "ja"),
			new FilterCapability("Taqbaylit", "kab"),
			new FilterCapability("Nederlands", "nl"),
			new FilterCapability("Norsk", "no"),
			new FilterCapability("Occitan", "oc"),
			new FilterCapability("Polski", "pl"),
			new FilterCapability("Português (Brasil)", "pt"),
			new FilterCapability("Português (Portugal)", "pt-PT"),
			new FilterCapability("Pусский", "ru"),
			new FilterCapability("Slovenčina", "sk"),
			new FilterCapability("Shqip", "sq"),
			new FilterCapability("Svenska", "sv"),
			new FilterCapability("ไทย", "th"),
			new FilterCapability("Toki Pona", "tok"),
			new FilterCapability("Türkçe", "tr"),
			new FilterCapability("украї́нська мо́ва", "uk"),
			new FilterCapability("Tiếng Việt", "vi"),
			new FilterCapability("简体中文（中国）", "zh-Hans"),
			new FilterCapability("繁體中文（台灣）", "zh-Hant"),
		], true, "language"),
		new FilterGroup("Search Scope", [
			new FilterCapability("Federated Network", "federated"),
			new FilterCapability("Local Instance Only", "local"),
			new FilterCapability("Sepia Search", "sepia"),
		], false, "scope")
	]);
};

source.search = function (query, type, order, filters) {
	
	if(IS_TESTING) {
		/*
		//filter example: 
			{"duration": ["SHORT"]}
		*/
		if(typeof filters === 'string') {	
			filters = JSON.parse(filters);
		}
	}

	if(source.isContentDetailsUrl(query)) {
		return new ContentPager([source.getContentDetails(query)], false);
	}

	// Handle tag search URLs as playlists
	if(source.isPlaylistUrl(query)) {
		return new PlaylistPager([source.getPlaylist(query)], false);
	}

	let sort = order;
	if (sort === Type.Order.Chronological) {
		sort = "-publishedAt";
	}

	const params = {
		search: query,
		sort
	};

	if (type == Type.Feed.Streams) {
		params.isLive = true;
	} else if (type == Type.Feed.Videos) {
		params.isLive = false;
	}

	// Apply filters (YouTube-style object structure)
	if (filters) {
		// Date filter
		if (filters.date && filters.date.length > 0) {
			const dateFilter = filters.date[0];
			const now = new Date();
			if (dateFilter === Type.Date.LastHour) {
				const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
				params.publishedAfter = oneHourAgo.toISOString();
			} else if (dateFilter === Type.Date.Today) {
				const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
				params.publishedAfter = startOfDay.toISOString();
			} else if (dateFilter === Type.Date.LastWeek) {
				const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
				params.publishedAfter = oneWeekAgo.toISOString();
			} else if (dateFilter === Type.Date.LastMonth) {
				const oneMonthAgo = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
				params.publishedAfter = oneMonthAgo.toISOString();
			} else if (dateFilter === Type.Date.LastYear) {
				const startOfYear = new Date(now.getFullYear(), 0, 1);
				params.publishedAfter = startOfYear.toISOString();
			}
		}

		// Duration filter
		if (filters.duration && filters.duration.length > 0) {
			const durationFilter = filters.duration[0];
			if (durationFilter === Type.Duration.Short) {
				params.durationMax = 240; // Under 4 minutes
			} else if (durationFilter === Type.Duration.Medium) {
				params.durationMin = 240; // 4 minutes
				params.durationMax = 1200; // 20 minutes
			} else if (durationFilter === Type.Duration.Long) {
				params.durationMin = 1200; // Over 20 minutes
			}
		}

		// Features filter (multi-select)
		if (filters.features && filters.features.length > 0) {
			// Check if "live" is selected
			const hasLive = filters.features.includes("live");
			if (hasLive) {
				params.isLive = true;
			}
			// Note: If live is not selected, we don't set isLive parameter
			// This allows both live and non-live videos to be returned
		}

		// NSFW Content filter
		if (filters.nsfw && filters.nsfw.length > 0) {
			const nsfwFilter = filters.nsfw[0];
			if (nsfwFilter === "safe_only") {
				params.nsfw = "false";
			} else if (nsfwFilter === "nsfw_only") {
				params.nsfw = "true";
			}
			// "all_content" doesn't set any filter
		}

		// Category filter (multi-select)
		if (filters.category && filters.category.length > 0) {
			params.categoryOneOf = filters.category;
		}

		// Language filter (multi-select)
		if (filters.language && filters.language.length > 0) {
			params.languageOneOf = filters.language;
		}

		// License filter (multi-select)
		if (filters.license && filters.license.length > 0) {
			params.licenceOneOf = filters.license;
		}

		// Search Scope filter
		if (filters.scope && filters.scope.length > 0) {
			const scopeFilter = filters.scope[0];
			if (scopeFilter === "sepia") {
				// Force Sepia Search mode - use Sepia Search directly
				const sepiaParams = {
					search: query,
					resultType: 'videos',
					sort: '-createdAt'
				};

				// Apply other filters to Sepia Search
				if (params.categoryOneOf) sepiaParams.categoryOneOf = params.categoryOneOf;
				if (params.languageOneOf) sepiaParams.languageOneOf = params.languageOneOf;
				if (params.durationMin) sepiaParams.durationMin = params.durationMin;
				if (params.durationMax) sepiaParams.durationMax = params.durationMax;
				if (params.publishedAfter) sepiaParams.publishedAfter = params.publishedAfter;
				if (params.isLive !== undefined) sepiaParams.isLive = params.isLive;
				if (params.licenceOneOf) sepiaParams.licenceOneOf = params.licenceOneOf;
				if (params.nsfw) sepiaParams.nsfw = params.nsfw;

				return getVideoPager('/api/v1/search/videos', sepiaParams, 0, 'https://sepiasearch.org', true);
			} else if (scopeFilter === "local" && _settings.searchCurrentInstance === true) {
				params.searchTarget = "local";
			}
			// "federated" means federated (default), so no parameter needed
		}
	}

	if (_settings.searchCurrentInstance === true && _settings.searchSepiaSearch === true) {
		// Both sources: fetch in parallel, merge, deduplicate, sort
		const localContext = {
			path: '/api/v1/search/videos',
			params: { ...params },
			page: 0,
			sourceHost: plugin.config.constants.baseUrl
		};
		const sepiaContext = {
			path: '/api/v1/search/videos',
			params: { ...params, resultType: 'videos', sort: '-createdAt' },
			page: 0,
			sourceHost: 'https://sepiasearch.org'
		};
		return getMixedVideoPager(localContext, sepiaContext);
	} else if (_settings.searchSepiaSearch === true) {
		params.resultType = 'videos';
		params.sort = '-createdAt';
		return getVideoPager('/api/v1/search/videos', params, 0, 'https://sepiasearch.org', true);
	} else {
		return getVideoPager('/api/v1/search/videos', params, 0, plugin.config.constants.baseUrl, true);
	}
};

source.searchChannels = function (query) {

	// Channel search doesn't support mixed pager (different result type),
	// so use Sepia Search if enabled, otherwise current instance
	const sourceHost = _settings.searchSepiaSearch === true
		? 'https://sepiasearch.org'
		: plugin.config.constants.baseUrl;

	return getChannelPager('/api/v1/search/video-channels', {
		search: query
	}, 0, sourceHost, true);
};

source.searchPlaylists = function (query) {
	// Playlist search doesn't support mixed pager (different result type),
	// so use Sepia Search if enabled, otherwise current instance
	const sourceHost = _settings.searchSepiaSearch === true
		? 'https://sepiasearch.org'
		: plugin.config.constants.baseUrl;

	const params = {
		search: query
	};

	if (_settings.searchSepiaSearch === true) {
		params.resultType = 'video-playlists';
		params.sort = '-createdAt';
	}

	return getPlaylistPager('/api/v1/search/video-playlists', params, 0, sourceHost, true);
};

source.isChannelUrl = function (url) {
	try {
		if (!url) return false;

		// Check for URL hint
		if (url.includes('isPeertubeChannel=1')) {
			return true;
		}

		// Check if the URL belongs to the base instance
		const baseUrl = plugin.config.constants.baseUrl;
		const isInstanceChannel = url.startsWith(`${baseUrl}/video-channels/`) || url.startsWith(`${baseUrl}/c/`);
		if (isInstanceChannel) return true;

		const urlTest = new URL(url);
		const { host, pathname, searchParams } = urlTest;

		// Check for URL hint in searchParams
		if (searchParams.has('isPeertubeChannel')) {
			return true;
		}

		// Check if the URL is from a known PeerTube instance
		const isKnownInstanceUrl = INDEX_INSTANCES.instances.includes(host);

		// Match PeerTube channel paths:
		// - /c/{channel} - Short form channel URL
		// - /c/{channel}/videos - Channel videos listing
		// - /c/{channel}/video - Alternate channel videos listing
		// - /video-channels/{channel} - Long form channel URL
		// - /video-channels/{channel}/videos - Channel videos listing
		// - /api/v1/video-channels/{channel} - API URL (for compatibility)
		// - Allow optional trailing slash
		const isPeerTubeChannelPath = /^\/(c|video-channels|api\/v1\/video-channels)\/[a-zA-Z0-9-_.]+(\/(video|videos)?)?\/?$/.test(pathname);

		return isKnownInstanceUrl && isPeerTubeChannelPath;
	} catch (error) {
		log('Error checking PeerTube channel URL:', error);
		return false;
	}
};

source.getChannel = function (url) {

	const handle = extractChannelId(url);

	if (!handle) {
		throw new ScriptException(`Failed to extract channel ID from URL: ${url}`);
	}
	
	const sourceBaseUrl = getBaseUrl(url);
	const urlWithParams = `${sourceBaseUrl}/api/v1/video-channels/${handle}`;

	try {
		const [{ body: obj }] = httpGET({ url: urlWithParams, parseResponse: true });

		// Add URL hint using utility function
		const channelUrl = obj.url || `${sourceBaseUrl}/video-channels/${handle}`;
		const channelUrlWithHint = addChannelUrlHint(channelUrl);
		
		return new PlatformChannel({
			id: new PlatformID(PLATFORM, obj.name, config.id),
			name: obj.displayName || obj.name || handle,
			thumbnail: getAvatarUrl(obj, sourceBaseUrl),
			banner: getBannerUrl(obj, sourceBaseUrl),
			subscribers: obj.followersCount || 0,
			description: obj.description ?? "",
			url: channelUrlWithHint,
			links: {},
			urlAlternatives: [
				channelUrl,
				channelUrlWithHint
			]
		});
	} catch (e) {
		log("Failed to get channel", e);
		return null;
	}

};

/**
 * Retrieves the list of subscriptions for the authenticated user.
 * 
 * This function fetches all subscriptions from the PeerTube instance.
 * It handles pagination automatically, using batch requests if multiple pages are needed
 * 
 * @returns {string[]} An array of subscription URLs.
 */

source.getUserSubscriptions = function() {

	if (!bridge.isLoggedIn()) {
		bridge.log("Failed to retrieve subscriptions page because not logged in.");
		throw new ScriptException("Not logged in");
	}

	const itemsPerPage = 100;
	let subscriptionUrls = [];
	
	const initialParams = { start: 0, count: itemsPerPage };
	const endpointUrl = `${plugin.config.constants.baseUrl}/api/v1/users/me/subscriptions`;
	const initialRequestUrl = `${endpointUrl}?${buildQuery(initialParams)}`;
	
	let initialResponseBody;
	try {
		[{ body: initialResponseBody }] = httpGET({ url: initialRequestUrl, useAuthenticated: true, parseResponse: true });
	} catch (e) {
		log("Failed to get user subscriptions", e);
		return [];
	}
	
	if (initialResponseBody.data && initialResponseBody.data.length > 0) {
		initialResponseBody.data.forEach(subscription => {
			if (subscription.url) subscriptionUrls.push(subscription.url);
		});
	}

	const totalSubscriptions = initialResponseBody.total;
	if (subscriptionUrls.length >= totalSubscriptions) {
		return subscriptionUrls;
	}

	const remainingSubscriptions = totalSubscriptions - subscriptionUrls.length;
	const remainingPages = Math.ceil(remainingSubscriptions / itemsPerPage);

	if (remainingPages > 1) {
		const batchUrls = [];
		for (let pageIndex = 1; pageIndex <= remainingPages; pageIndex++) {
			const pageParams = { start: pageIndex * itemsPerPage, count: itemsPerPage };
			batchUrls.push({ url: `${endpointUrl}?${buildQuery(pageParams)}`, useAuthenticated: true, parseResponse: true });
		}
		const batchResponses = httpGET(batchUrls);

		batchResponses.forEach(batchResponse => {
			if (batchResponse.isOk && batchResponse.code === 200) {
				if (batchResponse.body.data) {
					batchResponse.body.data.forEach(subscription => {
						if (subscription.url) subscriptionUrls.push(subscription.url);
					});
				}
			}
		});
	} else {
		for (let pageIndex = 1; pageIndex <= remainingPages; pageIndex++) {
			const pageParams = { start: pageIndex * itemsPerPage, count: itemsPerPage };
			try {
				const [{ body: pageResponseBody }] = httpGET({ url: `${endpointUrl}?${buildQuery(pageParams)}`, useAuthenticated: true, parseResponse: true });
				if (pageResponseBody.data) {
					pageResponseBody.data.forEach(subscription => {
						if (subscription.url) subscriptionUrls.push(subscription.url);
					});
				}
			} catch (e) {
				// Continue to next page on error
			}
		}
	}
	
	return subscriptionUrls;
};

// source.getUserHistory = function() {

// 	if (!bridge.isLoggedIn()) {
// 		bridge.log("Failed to retrieve history page because not logged in.");
// 		throw new ScriptException("Not logged in");
// 	}

// 	return getHistoryVideoPager("/api/v1/users/me/history/videos", {}, 0);
// };

source.getUserPlaylists = function() {
	let meData;
	try {
		[{ body: meData }] = httpGET({ url: `${plugin.config.constants.baseUrl}/api/v1/users/me`, useAuthenticated: true, parseResponse: true });
	} catch (e) {
		return [];
	}
	
	const username = meData.account?.name;
	if (!username) return [];

	const itemsPerPage = 50;
	let playlistUrls = [];
	const endpointUrl = `${plugin.config.constants.baseUrl}/api/v1/accounts/${username}/video-playlists`;
	const baseParams = { sort: '-updatedAt' };
	
	// Helper to build playlist URL with auth flag for private/unlisted playlists
	const buildPlaylistUrl = (p) => {
		let url = p.uuid 
			? `${plugin.config.constants.baseUrl}/w/p/${p.uuid}` 
			: p.url;
		if (url && p.privacy?.id !== 1) {
			url += PRIVATE_PLAYLIST_QUERY_PARAM;
		}
		return url;
	};

	let initialResponseBody;
	try {
		[{ body: initialResponseBody }] = httpGET({ url: `${endpointUrl}?${buildQuery({ ...baseParams, start: 0, count: itemsPerPage })}`, useAuthenticated: true, parseResponse: true });
	} catch (e) {
		return [];
	}
	if (initialResponseBody.data) {
		initialResponseBody.data.forEach(p => {
			const url = buildPlaylistUrl(p);
			if (url) playlistUrls.push(url);
		});
	}

	const total = initialResponseBody.total;
	if (playlistUrls.length >= total) return playlistUrls;

	const remainingPages = Math.ceil((total - playlistUrls.length) / itemsPerPage);

	if (remainingPages > 1) {
		const batchUrls = [];
		for (let i = 1; i <= remainingPages; i++) {
			batchUrls.push({ url: `${endpointUrl}?${buildQuery({ ...baseParams, start: i * itemsPerPage, count: itemsPerPage })}`, useAuthenticated: true, parseResponse: true });
		}
		httpGET(batchUrls).forEach(r => {
			if (r.isOk && r.code === 200) {
				if (r.body.data) {
					r.body.data.forEach(p => {
						const url = buildPlaylistUrl(p);
						if (url) playlistUrls.push(url);
					});
				}
			}
		});
	} else {
		for (let i = 1; i <= remainingPages; i++) {
			try {
				const [{ body: { data } }] = httpGET({ url: `${endpointUrl}?${buildQuery({ ...baseParams, start: i * itemsPerPage, count: itemsPerPage })}`, useAuthenticated: true, parseResponse: true });
				if (data) {
					data.forEach(p => {
						const url = buildPlaylistUrl(p);
						if (url) playlistUrls.push(url);
					});
				}
			} catch (e) {
				// Continue to next page on error
			}
		}
	}
	
	return playlistUrls;
};

source.getChannelCapabilities = () => {
	return {
		types: [Type.Feed.Mixed, Type.Feed.Streams, Type.Feed.Videos, Type.Feed.Playlists],
		sorts: [Type.Order.Chronological, "publishedAt"]
	};
};

source.getChannelContents = function (url, type, order, filters) {
	let sort = order;
	if (sort === Type.Order.Chronological) {
		sort = "-publishedAt";
	}

	const params = {
		sort
	};

	const handle = extractChannelId(url);
	const sourceBaseUrl = getBaseUrl(url);

	// Handle different content type requests
	if (type === Type.Feed.Playlists) {
		// For playlists from a channel
		return source.getChannelPlaylists(url, order, filters);
	} else {
		// For video types (Mixed, Streams, Videos)
		if (type == Type.Feed.Streams) {
			params.isLive = true;
		} else if (type == Type.Feed.Videos) {
			params.isLive = false;
		}

		return getVideoPager(`/api/v1/video-channels/${handle}/videos`, params, 0, sourceBaseUrl, false, null, true);
	}
};

source.searchChannelContents = function (channelUrl, query, type, order, filters) {

	const handle = extractChannelId(channelUrl);
	const sourceBaseUrl = getBaseUrl(channelUrl);

	if (!handle) {
		throw new ScriptException(`Failed to extract channel ID from URL: ${channelUrl}`);
	}

	const params = {
		search: query.trim(),
		sort: "-publishedAt"
	};

	// Use the channel-specific videos endpoint with search parameter
	return getVideoPager(`/api/v1/video-channels/${handle}/videos`, params, 0, sourceBaseUrl, false, null, true);
};

source.getChannelPlaylists = function (url, order, filters) {
	let sort = order;
	if (sort === Type.Order.Chronological) {
		sort = "-publishedAt";
	}

	const params = {
		sort
	};

	const handle = extractChannelId(url);
	if (!handle) {
		return new PlaylistPager([], false);
	}

	const sourceBaseUrl = getBaseUrl(url);
	return getPlaylistPager(`/api/v1/video-channels/${handle}/video-playlists`, params, 0, sourceBaseUrl);
};

// Adds support for checking if a URL is a playlist URL

source.isPlaylistUrl = function(url) {
	try {
		if (!url) return false;

		// Check for URL hint
		if (url.includes('isPeertubePlaylist=1') || url.includes('isPeertubeTagSearch=1')) {
			return true;
		}

		// Check for tag search URLs
		const urlObj = new URL(url);
		if (urlObj.pathname === '/search' && urlObj.searchParams.has('tagsOneOf')) {
			return true;
		}

		// Check if URL belongs to the base instance and matches playlist pattern
		const baseUrl = plugin.config.constants.baseUrl;
		const isInstancePlaylist = url.startsWith(`${baseUrl}/videos/watch/playlist/`) || 
								  url.startsWith(`${baseUrl}/w/p/`) ||
								  url.startsWith(`${baseUrl}/video-playlists/`) ||
								  (url.startsWith(`${baseUrl}/video-channels/`) && url.includes('/video-playlists/')) ||
								  (url.startsWith(`${baseUrl}/c/`) && url.includes('/video-playlists/'));
		if (isInstancePlaylist) return true;

		const urlTest = new URL(url);
		const { host, pathname, searchParams } = urlTest;

		// Check for URL hint in searchParams
		if (searchParams.has('isPeertubePlaylist')) {
			return true;
		}

		// Check if the URL is from a known PeerTube instance
		const isKnownInstanceUrl = INDEX_INSTANCES.instances.includes(host);

		// Match PeerTube playlist paths:
		// - /videos/watch/playlist/{uuid} - Standard playlist URL
		// - /w/p/{uuid} - Short form playlist URL
		// - /video-playlists/{uuid} - Direct playlist URL format
		// - /video-channels/{channelName}/video-playlists/{playlistId} - Channel playlist URL
		// - /c/{channelName}/video-playlists/{playlistId} - Short form channel playlist URL
		// - /api/v1/video-playlists/{uuid} - API URL (for compatibility)
		const isPeerTubePlaylistPath = /^\/(videos\/watch\/playlist|w\/p)\/[a-zA-Z0-9-_]+$/.test(pathname) ||
										/^\/(video-playlists|api\/v1\/video-playlists)\/[a-zA-Z0-9-_]+$/.test(pathname) ||
										/^\/(video-channels|c)\/[a-zA-Z0-9-_.]+\/video-playlists\/[a-zA-Z0-9-_]+$/.test(pathname);

		return isKnownInstanceUrl && isPeerTubePlaylistPath;
	} catch (error) {
		log('Error checking PeerTube playlist URL:', error);
		return false;
	}
};

// Gets a playlist and its information

source.getPlaylist = function(url) {
	// Check if this is a tag search URL
	try {
		const urlObj = new URL(url);
		if (urlObj.pathname === '/search' && urlObj.searchParams.has('tagsOneOf')) {
			return getTagPlaylist(url);
		}
	} catch (e) {
		// Continue with regular playlist handling
	}

	// Check if this is a private playlist that requires authentication
	// Private playlists are flagged with PRIVATE_PLAYLIST_QUERY_PARAM by getUserPlaylists
	// We also verify that the URL belongs to the base instance to prevent bad actors from triggering auth on external domains
	const requiresAuth = url.includes(PRIVATE_PLAYLIST_QUERY_PARAM) && isBaseInstanceUrl(url);
	
	// Remove the auth flag from URL before processing
	const cleanUrl = url.replace(PRIVATE_PLAYLIST_QUERY_PARAM, '');

	const playlistId = extractPlaylistId(cleanUrl);
	if (!playlistId) {
		return null;
	}

	const sourceBaseUrl = getBaseUrl(cleanUrl);
	const urlWithParams = `${sourceBaseUrl}/api/v1/video-playlists/${playlistId}`;
	
	let playlist;
	try {
		// Only use auth for private playlists from the base instance
		[{ body: playlist }] = httpGET({ url: urlWithParams, useAuthenticated: requiresAuth, parseResponse: true });
	} catch (e) {
		log("Failed to get playlist", e);
		return null;
	}
	
	const thumbnailUrl = playlist.thumbnailPath ? 
		`${sourceBaseUrl}${playlist.thumbnailPath}` : 
		URLS.PEERTUBE_LOGO;
	
	// Add URL hints using utility functions
	const channelUrl = addChannelUrlHint(playlist.ownerAccount?.url);
	const playlistUrl = addPlaylistUrlHint(`${sourceBaseUrl}/w/p/${playlist.uuid}`);
	
	return new PlatformPlaylistDetails({
		id: new PlatformID(PLATFORM, playlist.uuid, config.id),
		name: playlist.displayName || playlist.name,
		author: new PlatformAuthorLink(
			new PlatformID(PLATFORM, playlist.ownerAccount?.name, config.id),
			playlist.ownerAccount?.displayName || playlist.ownerAccount?.name || "",
			channelUrl,
			getAvatarUrl(playlist.ownerAccount, sourceBaseUrl)
		),
		thumbnail: thumbnailUrl,
		videoCount: playlist.videosLength || 0,
		url: playlistUrl,
		contents: getVideoPager(
			`/api/v1/video-playlists/${playlistId}/videos`, 
			{}, 
			0, 
			sourceBaseUrl,
			false,
			(playlistItem) => {
				
				return playlistItem.video;
			},
			requiresAuth
		)
	});
};

source.isContentDetailsUrl = function (url) {
	try {
		if (!url) return false;

		// Check for URL hint
		if (url.includes('isPeertubeContent=1')) {
			return true;
		}

		// Check if URL belongs to the base instance and matches content patterns
		const baseUrl = plugin.config.constants.baseUrl;
		const isInstanceContentDetails = url.startsWith(`${baseUrl}/videos/watch/`) || url.startsWith(`${baseUrl}/w/`);
		if (isInstanceContentDetails) return true;

		const urlTest = new URL(url);
		const { host, pathname, searchParams } = urlTest;

		// Check for URL hint in searchParams
		if (searchParams.has('isPeertubeContent')) {
			return true;
		}

		// Check if the path follows a known PeerTube video format
		// Supports:
		// - /videos/watch/{videoId}
		// - /videos/embed/{videoId}
		// - /w/{videoId}
		// - /api/v1/videos/{videoId} - API URL (for compatibility)
		const isPeerTubeVideoPath = /^\/(videos\/(watch|embed)|w|api\/v1\/videos)\/[a-zA-Z0-9-_]+$/.test(pathname);

		// Check if the URL is from a known PeerTube instance
		const isKnownInstanceUrl = INDEX_INSTANCES.instances.includes(host);

		return isInstanceContentDetails || (isKnownInstanceUrl && isPeerTubeVideoPath);
	} catch (error) {
		log('Error checking PeerTube content URL:', error);
		return false;
	}
};


source.getContentDetails = function (url) {
	const videoId = extractVideoId(url);
	if (!videoId) {
		return null;
	}

	const sourceBaseUrl = getBaseUrl(url);
	
	// Create a batch request for video details, captions, chapters and instance config
	const [videoDetails, captionsData, chaptersData, instanceConfig] = httpGET([
		`${sourceBaseUrl}/api/v1/videos/${videoId}`,
		`${sourceBaseUrl}/api/v1/videos/${videoId}/captions`,
		`${sourceBaseUrl}/api/v1/videos/${videoId}/chapters`,
		`${sourceBaseUrl}/api/v1/config`
	]);
	
	if (!videoDetails.isOk) {
		throwIfCaptcha(videoDetails);
		log("Failed to get video detail", videoDetails);
		return null;
	}

	const obj = JSON.parse(videoDetails.body);
	if (!obj) {
		log("Failed to parse response");
		return null;
	}

	// Check if content is sensitive and if playing NSFW content is disabled
	if (obj.nsfw && !_settings.allowPlayNsfwContent) {
		throw new UnavailableException("This video contains mature or explicit content. This warning can be disabled in the plugin settings.");
	}

	//Some older instance versions such as 3.0.0, may not contain the url property
	// Add URL hints using utility functions
	const contentUrl = addContentUrlHint(obj.url || `${sourceBaseUrl}/videos/watch/${obj.uuid}`);
	const channelUrl = addChannelUrlHint(obj.channel.url);
	
	// Process subtitles data
	const subtitles = processSubtitlesData(captionsData);

	// Parse source instance version for feature detection
	const sourceInstanceVersion = getInstanceVersion(instanceConfig);

	// PeerTube < v5.0.0 truncates description to 250 chars in /api/v1/videos/{id}.
	// Full description requires /api/v1/videos/{id}/description (deprecated in v5.0.0+).
	// See: https://github.com/Chocobozzz/PeerTube/releases/tag/v5.0.0
	let fullDescription = obj.description;
	if (!ServerInstanceVersionIsSameOrNewer(sourceInstanceVersion, '5.0.0')
		&& fullDescription && fullDescription.length >= 250 && fullDescription.endsWith('...')) {
		try {
			const descId = obj.uuid || videoId;
			const [descResp] = httpGET(`${sourceBaseUrl}/api/v1/videos/${descId}/description`);
			fullDescription = getFullDescription(descResp, fullDescription);
		} catch (e) {
			log("Failed to fetch full description", e);
		}
	}

	const result = new PlatformVideoDetails({
		id: new PlatformID(PLATFORM, obj.uuid, config.id),
		name: obj.name,
		thumbnails: new Thumbnails([new Thumbnail(
			`${sourceBaseUrl}${obj.thumbnailPath}`,
			0
		)]),
		author: new PlatformAuthorLink(
			new PlatformID(PLATFORM, obj.channel.name, config.id),
			obj.channel.displayName,
			channelUrl,
			getAvatarUrl(obj, sourceBaseUrl)
		),
		datetime: Math.round((new Date(obj.publishedAt)).getTime() / 1000),
		duration: obj.duration,
		viewCount: obj.isLive ? (obj.viewers ?? obj.views) : obj.views,
		url: contentUrl,
		isLive: obj.isLive,
		description: fullDescription,
		video: getMediaDescriptor(obj),
		subtitles: subtitles,
		rating: new RatingLikesDislikes(
			obj?.likes ?? 0,
			obj?.dislikes ?? 0
		)
	});

	if (IS_TESTING) {
		source.getContentRecommendations(url, obj);
		source.getContentChapters(url, chaptersData, obj.duration);
	} else {
		result.getContentRecommendations = function () {
			return source.getContentRecommendations(url, obj);
		};
		result.getContentChapters = function () {
			return source.getContentChapters(url, chaptersData, obj.duration);
		};
	}

	return result;
};

source.getContentRecommendations = function (url, obj) {

	const sourceHost = getBaseUrl(url);
	const videoId = extractVideoId(url);

	let tagsOneOf = obj?.tags ?? [];

	if (!obj && videoId) {
		try {
			const [{ body: videoData }] = httpGET({ url: `${sourceHost}/api/v1/videos/${videoId}`, parseResponse: true });
			if (videoData) {
				tagsOneOf = videoData?.tags ?? []
			}
		} catch (e) {
			// Continue with empty tags
		}
	}

	const params = {
		skipCount: false,
		tagsOneOf,
		sort: "-publishedAt",
		searchTarget: "local"
	}

	const pager = getVideoPager('/api/v1/search/videos', params, 0, sourceHost, false);

	pager.results = pager.results.filter(v => v.id.value != videoId);
	return pager;
}

source.getContentChapters = function (url, chaptersData, videoDuration) {
	if (chaptersData) {
		return extractChapters(chaptersData, videoDuration);
	}

	const videoId = extractVideoId(url);
	if (!videoId) return [];

	const sourceBaseUrl = getBaseUrl(url);
	try {
		const [chaptersResp, videoData] = httpGET([
			`${sourceBaseUrl}/api/v1/videos/${videoId}/chapters`,
			{ url: `${sourceBaseUrl}/api/v1/videos/${videoId}`, parseResponse: true }
		]);
		return extractChapters(chaptersResp, videoData?.body?.duration);
	} catch (e) {
		return [];
	}
}

source.getComments = function (url) {
	const videoId = extractVideoId(url);
	const sourceBaseUrl = getBaseUrl(url);
	return getCommentPager(videoId, {}, 0, sourceBaseUrl);
}

source.getSubComments = function (comment) {
	if (typeof comment === 'string') {
		try {
			comment = JSON.parse(comment);
		} catch (parseError) {
			bridge.log("Failed to parse comment string: " + parseError);
			return new CommentPager([], false);
		}
	}
	
	// Validate required parameters
	if (!comment || !comment.contextUrl) {
		bridge.log("getSubComments: Missing contextUrl in comment");
		return new CommentPager([], false);
	}
	
	if (!comment.context || !comment.context.id) {
		bridge.log("getSubComments: Missing comment context or ID");
		return new CommentPager([], false);
	}
	
	// Extract video ID from the contextUrl
	const videoId = extractVideoId(comment.contextUrl);
	if (!videoId) {
		bridge.log("getSubComments: Could not extract video ID from contextUrl");
		return new CommentPager([], false);
	}
	
	const sourceBaseUrl = getBaseUrl(comment.contextUrl);
	
	// PeerTube uses a specific endpoint to get a comment thread with its replies
	// GET /api/v1/videos/{id}/comment-threads/{threadId}
	const commentId = comment.context.id;
	const apiUrl = `${sourceBaseUrl}/api/v1/videos/${videoId}/comment-threads/${commentId}`;
	
	try {
		const [{ body: obj }] = httpGET({ url: apiUrl, parseResponse: true });
		
		// Extract replies from the comment thread response
		const replies = obj.children || [];
		
		const comments = replies.map(v => {
			// Ensure all string values are properly handled
			const accountName = (v.comment?.account?.name || 'unknown').toString();
			const displayName = (v.comment?.account?.displayName || v.comment?.account?.name || 'Unknown User').toString();
			const messageText = (v.comment?.text || '').toString();
			const replyCommentId = (v.comment?.id || 'unknown').toString();
			const platformId = (config.id || 'peertube').toString();
			
			return new Comment({
				contextUrl: comment.contextUrl,
				author: new PlatformAuthorLink(
					new PlatformID(PLATFORM, accountName, platformId),
					displayName,
					addChannelUrlHint(`${sourceBaseUrl}/c/${accountName}`),
					getAvatarUrl(v.comment, sourceBaseUrl)
				),
				message: messageText,
				rating: new RatingLikes(v.comment?.likes ?? 0),
				date: Math.round((new Date(v.comment?.createdAt ?? Date.now())).getTime() / 1000),
				replyCount: v.comment?.totalReplies ?? 0,
				context: { id: replyCommentId }
			});
		});
		
		return new CommentPager(comments, false);
		
	} catch (error) {
		bridge.log("Error getting sub-comments: " + error);
		return new CommentPager([], false);
	}
}

/**
 * Returns chat window information for live PeerTube videos with chat
 * @param {string} url - The video URL
 * @returns {Object|null} Chat window configuration or null if chat not available
 */

source.getLiveChatWindow = function (url) {
    // Extract video ID and base URL
    const videoId = extractVideoId(url);
    if (!videoId) {
        return null;
    }
    
    const sourceBaseUrl = getBaseUrl(url);
    
    // Check if the video is live and has chat enabled
    try {
        const [{ body: videoData }] = httpGET({ url: `${sourceBaseUrl}/api/v1/videos/${videoId}`, parseResponse: true });
        
        // Only proceed if the video is live
        if (!videoData.isLive) {
            return null;
        }
        
        // Check if the livechat plugin is enabled for this video
        const hasLiveChat = !!videoData.pluginData?.['livechat-active'];
        
        if (!hasLiveChat) {
            return null;
        }
        
        // Use the correct chat URL format
        const chatUrl = `${sourceBaseUrl}/p/livechat/room?room=${videoId}`;
        
        // Return the chat window configuration
        return {
            url: chatUrl,
            // Remove header elements that might be present in the chat iframe
            removeElements: ["header.root-header"],
            // Elements to periodically remove (like banners, etc.)
            removeElementsInterval: []
        };
    } catch (ex) {
        log("Error getting live chat window:", ex);
        return null;
    }
}


// Add PlaybackTracker implementation

source.getPlaybackTracker = function (url) {

	if (!_settings.submitActivity) {
		return null;
	}

	const videoId = extractVideoId(url);
	if (!videoId) {
		return null;
	}
	
	const sourceBaseUrl = getBaseUrl(url);
	
	return new PeerTubePlaybackTracker(videoId, sourceBaseUrl);

};

//https://docs.joinpeertube.org/api-rest-reference.html#tag/Video/operation/addView

// =============================================================================
// Pager classes
// =============================================================================

class PeerTubePlaybackTracker extends PlaybackTracker {
	/**
	 * Creates a new PeerTube playback tracker
	 * @param {string} videoId - The ID of the video
	 * @param {string} baseUrl - The base URL of the PeerTube instance
	 */
	constructor(videoId, baseUrl) {
		// Send update approximately every 5 seconds
		super(5000);
		this.videoId = videoId;
		this.baseUrl = baseUrl;
		this.lastReportedTime = 0;
		this.seekOccurred = false;
	}

	/**
	 * Called when tracking is initialized with the current position
	 * @param {number} seconds - Current position in seconds
	 */
	onInit(seconds) {
		this.lastReportedTime = Math.floor(seconds);
		this.reportView(this.lastReportedTime);
	}

	/**
	 * Called periodically when video is playing
	 * @param {number} seconds - Current position in seconds
	 * @param {boolean} isPlaying - Whether the video is currently playing
	 */
	onProgress(seconds, isPlaying) {
		
		if (!isPlaying) return;
		
		const currentTime = Math.floor(seconds);

		// Detect if a seek has occurred (non-continuous playback)
		if (Math.abs(currentTime - this.lastReportedTime) > 10) {
			this.seekOccurred = true;
		}

		this.lastReportedTime = currentTime;
		this.reportView(currentTime);
	}

	/**
	 * Called when playback concludes
	 */
	onConcluded() {
		// Send a final view report
		this.reportView(this.lastReportedTime);
	}

	/**
	 * Reports the current view status to the PeerTube server
	 * @param {number} currentTime - Current position in seconds
	 */
	reportView(currentTime) {
		// https://docs.joinpeertube.org/api-rest-reference.html#tag/Video/operation/addView
		const url = `${this.baseUrl}/api/v1/videos/${this.videoId}/views`;

		const body = {
			currentTime,
			client: "GrayJay.app",
			// device: "mobile",
			// operatingSystem: "Android",
			// sessionId: this.sessionId
		};

		// Add viewEvent if a seek occurred
		if (this.seekOccurred) {
			body.viewEvent = "seek";
			this.seekOccurred = false;
		}

		getHttpClient().POST(url, JSON.stringify(body), {
			...state.defaultHeaders,
			"Content-Type": "application/json"
		}, false);
	}
}

/**
 * Paginated video results from a PeerTube instance
 * @extends VideoPager
 */
class PeerTubeVideoPager extends VideoPager {
	/**
	 * @param {Array} results - Array of PlatformVideo objects
	 * @param {boolean} hasMore - Whether more pages are available
	 * @param {string} path - API path
	 * @param {Object} params - Query parameters
	 * @param {number} page - Current page number
	 * @param {string} sourceHost - Base URL of the PeerTube instance
	 * @param {boolean} isSearch - Whether this is a search request
	 * @param {Function} cbMap - Optional mapping callback for results
	 * @param {boolean} useAuth - Whether to use authenticated requests
	 */
	constructor(results, hasMore, path, params, page, sourceHost, isSearch, cbMap, useAuth) {
		super(results, hasMore, { path, params, page, sourceHost, isSearch, cbMap, useAuth });
	}

	/** @returns {PeerTubeVideoPager} The next page of video results */
	nextPage() {
		return getVideoPager(this.context.path, this.context.params, (this.context.page ?? 0) + 1, this.context.sourceHost, this.context.isSearch, this.context.cbMap, this.context.useAuth);
	}
}

class PeerTubeMixedVideoPager extends VideoPager {
	constructor(results, hasMore, localContext, sepiaContext) {
		super(results, hasMore, { localContext, sepiaContext });
	}

	nextPage() {
		const nextLocal = { ...this.context.localContext, page: (this.context.localContext.page ?? 0) + 1 };
		const nextSepia = { ...this.context.sepiaContext, page: (this.context.sepiaContext.page ?? 0) + 1 };
		return getMixedVideoPager(nextLocal, nextSepia);
	}
}

/**
 * Paginated channel results from a PeerTube instance
 * @extends ChannelPager
 */
class PeerTubeChannelPager extends ChannelPager {
	/**
	 * @param {Array} results - Array of PlatformAuthorLink objects
	 * @param {boolean} hasMore - Whether more pages are available
	 * @param {string} path - API path
	 * @param {Object} params - Query parameters
	 * @param {number} page - Current page number
	 * @param {string} sourceHost - Base URL of the PeerTube instance
	 * @param {boolean} isSearch - Whether this is a search request
	 */
	constructor(results, hasMore, path, params, page, sourceHost, isSearch) {
		super(results, hasMore, { path, params, page, sourceHost, isSearch });
	}

	/** @returns {PeerTubeChannelPager} The next page of channel results */
	nextPage() {
		return getChannelPager(this.context.path, this.context.params, (this.context.page ?? 0) + 1, this.context.sourceHost, this.context.isSearch);
	}
}

/**
 * Paginated comment results from a PeerTube video
 * @extends CommentPager
 */
class PeerTubeCommentPager extends CommentPager {
	/**
	 * @param {Array} results - Array of Comment objects
	 * @param {boolean} hasMore - Whether more pages are available
	 * @param {string} videoId - The video ID
	 * @param {Object} params - Query parameters
	 * @param {number} page - Current page number
	 * @param {string} sourceBaseUrl - Base URL of the PeerTube instance
	 */
	constructor(results, hasMore, videoId, params, page, sourceBaseUrl) {
		super(results, hasMore, { videoId, params, page, sourceBaseUrl });
	}

	/** @returns {PeerTubeCommentPager} The next page of comment results */
	nextPage() {
		return getCommentPager(this.context.videoId, this.context.params, (this.context.page ?? 0) + 1, this.context.sourceBaseUrl);
	}
}

/**
 * Paginated playlist results from a PeerTube instance
 * @extends PlaylistPager
 */
class PeerTubePlaylistPager extends PlaylistPager {
	/**
	 * @param {Array} results - Array of PlatformPlaylist objects
	 * @param {boolean} hasMore - Whether more pages are available
	 * @param {string} path - API path
	 * @param {Object} params - Query parameters
	 * @param {number} page - Current page number
	 * @param {string} sourceHost - Base URL of the PeerTube instance
	 * @param {boolean} isSearch - Whether this is a search request
	 */
	constructor(results, hasMore, path, params, page, sourceHost, isSearch) {
		super(results, hasMore, { path, params, page, sourceHost, isSearch });
	}

	/** @returns {PeerTubePlaylistPager} The next page of playlist results */
	nextPage() {
		return getPlaylistPager(this.context.path, this.context.params, (this.context.page ?? 0) + 1, this.context.sourceHost, this.context.isSearch);
	}
}

/**
 * Paginated video history results from an authenticated user's watch history
 * @extends VideoPager
 */
class PeerTubeHistoryVideoPager extends VideoPager {
	/**
	 * @param {Array} results - Array of PlatformVideo objects
	 * @param {boolean} hasMore - Whether more pages are available
	 * @param {string} path - API path
	 * @param {Object} params - Query parameters
	 * @param {number} page - Current page number
	 */
	constructor(results, hasMore, path, params, page) {
		super(results, hasMore, { path, params, page });
	}

	/** @returns {PeerTubeHistoryVideoPager} The next page of history results */
	nextPage() {
		return getHistoryVideoPager(this.context.path, this.context.params, (this.context.page ?? 0) + 1);
	}
}

// =============================================================================
// Helper functions
// =============================================================================

/**
 * Transforms raw PeerTube video API data into PlatformVideo objects with NSFW filtering
 * @param {Array} data - Raw video data from PeerTube API
 * @param {boolean} isSearch - Whether these results came from a search request
 * @param {string} sourceHost - Base URL of the PeerTube instance
 * @returns {Array} Array of PlatformVideo objects
 */
function transformVideoResults(data, isSearch, sourceHost) {
	const nsfwPolicy = getNSFWPolicy();

	return data
		.filter(Boolean)
		.map(v => {
			const baseUrl = [
				v.url,
				v.embedUrl,
				v.previewUrl,
				v?.thumbnailUrl,
				v?.account?.url,
				v?.channel?.url
			].filter(Boolean).map(getBaseUrl).find(Boolean);

			const contentUrl = addContentUrlHint(v.url || `${baseUrl}/videos/watch/${v.uuid}`);
			const instanceBaseUrl = isSearch ? baseUrl : sourceHost;
			const channelUrl = addChannelUrlHint(v.channel.url);

			const isNSFW = v.nsfw === true;
			let thumbnails;

			if (isNSFW && nsfwPolicy === "blur") {
				thumbnails = new Thumbnails([]);
			} else {
				thumbnails = new Thumbnails([new Thumbnail(`${instanceBaseUrl}${v.thumbnailPath}`, 0)]);
			}

			return new PlatformVideo({
				id: new PlatformID(PLATFORM, v.uuid, config.id),
				name: v.name ?? "",
				thumbnails: thumbnails,
				author: new PlatformAuthorLink(
					new PlatformID(PLATFORM, v.channel.name, config.id),
					v.channel.displayName,
					channelUrl,
					getAvatarUrl(v, instanceBaseUrl)
				),
				datetime: Math.round((new Date(v.publishedAt)).getTime() / 1000),
				duration: v.duration,
				viewCount: v.isLive ? (v.viewers ?? v.views) : v.views,
				url: contentUrl,
				isLive: v.isLive
			});
		});
}

/**
 * Returns the appropriate HTTP client based on impersonation settings
 * @returns {Object} The HTTP client (httpimp if impersonation is enabled, otherwise http)
 */
function getHttpClient() {
	return (IS_IMPERSONATION_AVAILABLE && _settings?.enableBrowserImpersonation) ? httpimp : http;
}

/**
 * Extracts the full description from a video description API response
 * @param {Object} descriptionResponse - HTTP response containing the full description
 * @param {string} fallback - Fallback description to use if response is invalid
 * @returns {string} The full description or the fallback value
 */
function getFullDescription(descriptionResponse, fallback) {
	if (!descriptionResponse || !descriptionResponse.isOk) return fallback;
	try {
		const data = JSON.parse(descriptionResponse.body);
		if (data?.description) return data.description;
	} catch (e) {
		// ignore
	}
	return fallback;
}

/**
 * Processes captions data from API response into GrayJay subtitle format
 * @param {Object} subtitlesResponse - HTTP response containing captions data
 * @returns {Array} - Array of subtitle objects or empty array if none available
 */

function processSubtitlesData(subtitlesResponse) {
	if (!subtitlesResponse.isOk) {
		log("Failed to get video subtitles", subtitlesResponse);
		return [];
	}

	try {

		const baseUrl = getBaseUrl(subtitlesResponse.url);

		const captionsData = JSON.parse(subtitlesResponse.body);
		if (!captionsData || !captionsData.data || captionsData.total === 0) {
			return [];
		}

		// Convert PeerTube captions to GrayJay subtitle format
		return captionsData.data
			.map(caption => {

				const subtitleUrl = caption?.fileUrl
					?? (caption.captionPath ? `${baseUrl}${caption.captionPath}` : ""); //6.1.0

				return {
					name: `${caption?.language?.label ?? caption?.language?.id} ${caption.automaticallyGenerated ? "(auto-generated)" : ""}`,
					url: subtitleUrl,
					format: "text/vtt",
					language: caption.language.id
				};
			})
			.filter(caption => caption.url);
	} catch (e) {
		log("Error parsing captions data", e);
		return [];
	}
}

/**
 * Extracts chapter markers from a video's chapters API response
 * @param {Object} chaptersData - HTTP response containing chapter data
 * @param {number} videoDuration - Total duration of the video in seconds
 * @returns {Array<Object>} Array of chapter objects with name, timeStart, timeEnd, and type
 */
function extractChapters(chaptersData, videoDuration) {
	if (!chaptersData || !chaptersData.isOk) return [];

	try {
		const data = JSON.parse(chaptersData.body);
		if (!data?.chapters?.length) return [];

		return data.chapters.map(function (chapter, i) {
			const nextChapter = data.chapters[i + 1];
			return {
				name: chapter.title,
				timeStart: chapter.timecode,
				timeEnd: nextChapter ? nextChapter.timecode : (videoDuration || 999999),
				type: Type.Chapter.NORMAL
			};
		});
	} catch (e) {
		return [];
	}
}

/**
 * Validates if a string is a valid URL
 * @param {string} str - The string to validate
 * @returns {boolean} True if the string is a valid URL, false otherwise
 */
function isValidUrl(str) {
	if (typeof str !== 'string') {
		return false;
	}

	// Basic URL validation - checks for http:// or https:// and a domain
	const urlPattern = /^https?:\/\/.+/i;
	return urlPattern.test(str);
}

/**
 * Checks if a URL belongs to the configured base instance
 * @param {string} url - The URL to check
 * @returns {boolean} True if the URL is for the base instance
 */

function isBaseInstanceUrl(url) {
	if (!url || !plugin?.config?.constants?.baseUrl) {
		return false;
	}
	try {
		const urlHost = new URL(url).host.toLowerCase();
		const baseHost = new URL(plugin.config.constants.baseUrl).host.toLowerCase();
		return urlHost === baseHost;
	} catch (e) {
		return false;
	}
}

/**
 * Performs GET request(s) with error handling and optional JSON parsing.
 * Always returns an array of response objects.
 *
 * Single:  const [resp] = httpGET(url)
 * Parsed:  const [{ body: data }] = httpGET({ url, parseResponse: true })
 * Batch:   const [r1, r2] = httpGET([url1, url2])
 *
 * Each response has the same shape as http.GET(): { isOk, code, body }.
 * When parseResponse is true, body contains the parsed JSON instead of a string.
 *
 * @param {string|Object|Array<string|Object>} optionsOrUrl - URL string, options object, or array for batch
 * @param {string} optionsOrUrl.url - The URL to call
 * @param {boolean} [optionsOrUrl.useAuthenticated=false] - Use authenticated headers (base instance only)
 * @param {boolean} [optionsOrUrl.parseResponse=false] - Parse body as JSON
 * @param {Object} [optionsOrUrl.headers=null] - Custom headers (defaults to state.defaultHeaders)
 * @returns {Array<{isOk: boolean, code: number, body: string|Object}>} Array of responses
 * @throws {ScriptException}
 */

function httpGET(optionsOrUrl) {
	const client = getHttpClient();

	if (Array.isArray(optionsOrUrl)) {
		const batch = client.batch();
		const parseFlags = [];
		for (const req of optionsOrUrl) {
			const isString = typeof req === 'string';
			const url = isString ? req : req.url;
			const headers = (isString ? null : req.headers) ?? state.defaultHeaders;
			const useAuth = !!(req.useAuthenticated && isBaseInstanceUrl(url));
			parseFlags.push(!isString && !!req.parseResponse);
			batch.GET(url, headers, useAuth);
		}
		const responses = batch.execute();
		return responses.map((resp, i) => {
			if (parseFlags[i] && resp.isOk) {
				const json = JSON.parse(resp.body);
				if (json.errors) {
					throw new ScriptException(json.errors[0].message);
				}
				return { isOk: resp.isOk, code: resp.code, body: json };
			}
			return resp;
		});
	}

	let options;
	if (typeof optionsOrUrl === 'string') {
		if (!isValidUrl(optionsOrUrl)) {
			throw new ScriptException("Invalid URL provided: " + optionsOrUrl);
		}
		options = { url: optionsOrUrl };
	} else if (typeof optionsOrUrl === 'object' && optionsOrUrl !== null) {
		options = optionsOrUrl;
	} else {
		throw new ScriptException("httpGET requires a URL string, options object, or array for batch");
	}

	const {
		url,
		useAuthenticated = false,
		parseResponse = false,
		headers = null
	} = options;

	if (!url) {
		throw new ScriptException("URL is required");
	}

	const shouldAuthenticate = useAuthenticated && isBaseInstanceUrl(url);
	const localHeaders = headers ?? state.defaultHeaders;

	const resp = client.GET(url, localHeaders, shouldAuthenticate);

	if (!resp.isOk) {
		throwIfCaptcha(resp);
		throw new ScriptException("Request [" + url + "] failed with code [" + resp.code + "]");
	}

	if (parseResponse) {
		const json = JSON.parse(resp.body);
		if (json.errors) {
			throw new ScriptException(json.errors[0].message);
		}
		return [{ isOk: resp.isOk, code: resp.code, body: json }];
	}

	return [resp];
}

/**
 * Build a query string from parameters (without leading '?').
 * Callers are responsible for prefixing with '?'.
 * @param {{[key: string]: any}} params Query params
 * @returns {string} Query string, e.g. "key=val&key2=val2" or ""
 */

function buildQuery(params) {
	let query = "";
	let first = true;
	for (const [key, value] of Object.entries(params)) {
		// Skip empty values
		if (!value && value !== 0) continue;

		// Handle arrays for duplicate parameters
		if (Array.isArray(value)) {
			for (const item of value) {
				if (item || item === 0) {
					if (first) {
						first = false;
					} else {
						query += "&";
					}
					query += `${key}=${encodeURIComponent(item)}`;
				}
			}
		} else {
			// Handle single values
			if (first) {
				first = false;
			} else {
				query += "&";
			}
			query += `${key}=${encodeURIComponent(value)}`;
		}
	}

	return (query && query.length > 0) ? query : "";
}

/**
 * Fetches channels and creates a PeerTubeChannelPager
 * @param {string} path - The API path to fetch channels from
 * @param {Object} params - Query parameters
 * @param {number} page - Page number for pagination
 * @param {string} sourceHost - The base URL of the PeerTube instance
 * @param {boolean} isSearch - Whether this is a search request
 * @returns {PeerTubeChannelPager} Pager for channel results
 */
function getChannelPager(path, params, page, sourceHost = plugin.config.constants.baseUrl, isSearch = false) {

	const count = PAGE_SIZE_DEFAULT;
	const start = (page ?? 0) * count;
	params = { ...params, start, count }

	const url = `${sourceHost}${path}`;
	const urlWithParams = `${url}?${buildQuery(params)}`;

	let obj;
	try {
		[{ body: obj }] = httpGET({ url: urlWithParams, parseResponse: true });
	} catch (e) {
		log("Failed to get channels", e);
		return new ChannelPager([], false);
	}

	return new PeerTubeChannelPager(obj.data.map(v => {

		const instanceBaseUrl = isSearch ? getBaseUrl(v.url) : sourceHost;

		return new PlatformAuthorLink(
			new PlatformID(PLATFORM, v.name, config.id),
			v.displayName,
			v.url,
			getAvatarUrl(v, instanceBaseUrl),
			v?.followersCount ?? 0
		);

	}), obj.total > (start + count), path, params, page, sourceHost, isSearch);
}

/**
 * Fetches videos and creates a PeerTubeVideoPager with NSFW filtering
 * @param {string} path - The API path to fetch videos from
 * @param {Object} params - Query parameters
 * @param {number} page - Page number for pagination
 * @param {string} sourceHost - The base URL of the PeerTube instance
 * @param {boolean} isSearch - Whether this is a search request
 * @param {Function} [cbMap] - Optional callback to transform each video data item
 * @param {boolean} [useAuth=false] - Whether to use authenticated requests
 * @returns {PeerTubeVideoPager} Pager for video results
 */
function getVideoPager(path, params, page, sourceHost = plugin.config.constants.baseUrl, isSearch = false, cbMap, useAuth = false) {

	const count = PAGE_SIZE_DEFAULT;
	const start = (page ?? 0) * count;
	params = { ...params, start, count };

	applyNSFWFilter(params);

	const url = `${sourceHost}${path}`;

	const urlWithParams = `${url}?${buildQuery(params)}`;

	let obj;
	try {
		[{ body: obj }] = httpGET({ url: urlWithParams, useAuthenticated: useAuth, parseResponse: true });
	} catch (e) {
		log("Failed to get videos", e);
		return new VideoPager([], false);
	}

	const hasMore = obj.total > (start + count);

	// check if cbMap is a function
	if (typeof cbMap === 'function') {
		obj.data = obj.data.map(cbMap);
	}

	const contentResultList = transformVideoResults(obj.data, isSearch, sourceHost);

	return new PeerTubeVideoPager(contentResultList, hasMore, path, params, page, sourceHost, isSearch, cbMap, useAuth);
}

function getMixedVideoPager(localContext, sepiaContext) {
	const count = PAGE_SIZE_DEFAULT;
	const localStart = (localContext.page ?? 0) * count;
	const sepiaStart = (sepiaContext.page ?? 0) * count;

	const localParams = { ...localContext.params, start: localStart, count };
	const sepiaParams = { ...sepiaContext.params, start: sepiaStart, count };

	applyNSFWFilter(localParams);
	applyNSFWFilter(sepiaParams);

	const localUrl = `${localContext.sourceHost}${localContext.path}?${buildQuery(localParams)}`;
	const sepiaUrl = `${sepiaContext.sourceHost}${sepiaContext.path}?${buildQuery(sepiaParams)}`;

	let localData = [];
	let sepiaData = [];
	let localHasMore = false;
	let sepiaHasMore = false;

	try {
		const [localResp, sepiaResp] = httpGET([
			{ url: localUrl, parseResponse: true },
			{ url: sepiaUrl, parseResponse: true }
		]);

		if (localResp.isOk && localResp.body?.data) {
			localData = localResp.body.data;
			localHasMore = localResp.body.total > (localStart + count);
		}
		if (sepiaResp.isOk && sepiaResp.body?.data) {
			sepiaData = sepiaResp.body.data;
			sepiaHasMore = sepiaResp.body.total > (sepiaStart + count);
		}
	} catch (e) {
		log("Failed to get mixed videos", e);
		return new VideoPager([], false);
	}

	// Transform both sets
	const localResults = transformVideoResults(localData, false, localContext.sourceHost);
	const sepiaResults = transformVideoResults(sepiaData, true, sepiaContext.sourceHost);

	// Deduplicate by UUID (prefer local version)
	const seen = new Set();
	const merged = [];

	for (const video of [...localResults, ...sepiaResults]) {
		const uuid = video.id.value;
		if (!seen.has(uuid)) {
			seen.add(uuid);
			merged.push(video);
		}
	}

	// Sort merged results according to the user's chosen sort order
	const sort = localContext.params.sort;
	if (sort === '-publishedAt' || sort === '-createdAt') {
		merged.sort((a, b) => b.datetime - a.datetime);
	} else if (sort === 'publishedAt' || sort === 'createdAt') {
		merged.sort((a, b) => a.datetime - b.datetime);
	} else if (sort === '-views') {
		merged.sort((a, b) => b.viewCount - a.viewCount);
	} else if (sort === '-likes') {
		// likes not available on PlatformVideo, fall back to newest
		merged.sort((a, b) => b.datetime - a.datetime);
	} else {
		// best, trending, hot are algorithmic — fall back to newest
		merged.sort((a, b) => b.datetime - a.datetime);
	}

	const hasMore = localHasMore || sepiaHasMore;
	return new PeerTubeMixedVideoPager(merged, hasMore, localContext, sepiaContext);
}

/**
 * Fetches comment threads for a video and creates a PeerTubeCommentPager
 * @param {string} videoId - The video ID to fetch comments for
 * @param {Object} params - Query parameters
 * @param {number} page - Page number for pagination
 * @param {string} sourceBaseUrl - The base URL of the PeerTube instance
 * @returns {PeerTubeCommentPager} Pager for comment results
 */
function getCommentPager(videoId, params, page, sourceBaseUrl = plugin.config.constants.baseUrl) {

	const count = PAGE_SIZE_DEFAULT;
	const start = (page ?? 0) * count;
	params = { ...params, start, count }

	// Build API URL internally
	const apiPath = `/api/v1/videos/${videoId}/comment-threads`;
	const apiUrl = `${sourceBaseUrl}${apiPath}`;
	const urlWithParams = `${apiUrl}?${buildQuery(params)}`;
	
	// Build video URL internally
	const videoUrl = addContentUrlHint(`${sourceBaseUrl}/videos/watch/${videoId}`);
	
	let obj;
	try {
		[{ body: obj }] = httpGET({ url: urlWithParams, parseResponse: true });
	} catch (e) {
		log("Failed to get comments", e);
		return new CommentPager([], false);
	}

	return new PeerTubeCommentPager(obj.data
		.filter(v => !v.isDeleted || (v.isDeleted && v.totalReplies > 0)) // filter out deleted comments without replies. TODO: handle soft deleted comments with replies
		.map(v => {
			// Ensure all string values are properly handled
			const accountName = (v.account?.name || 'unknown').toString();
			const displayName = (v.account?.displayName || v.account?.name || 'Unknown User').toString();
			const messageText = (v.text || '').toString();
			const commentId = (v.id || 'unknown').toString();
			const platformId = (config.id || 'peertube').toString();
			
			return new Comment({
				contextUrl: videoUrl || '',
				author: new PlatformAuthorLink(
					new PlatformID(PLATFORM, accountName, platformId),
					displayName,
					addChannelUrlHint(`${sourceBaseUrl}/c/${accountName}`),
					getAvatarUrl(v, sourceBaseUrl)
				),
				message: messageText,
				rating: new RatingLikes(v.likes ?? 0),
				date: Math.round((new Date(v.createdAt ?? Date.now())).getTime() / 1000),
				replyCount: v.totalReplies ?? 0,
				context: { id: commentId }
			});
		}), obj.total > (start + count), videoId, params, page, sourceBaseUrl);
}

/**
 * Fetches playlists and creates a PeerTubePlaylistPager
 * @param {string} path - The API path to fetch playlists from
 * @param {Object} params - Query parameters
 * @param {number} page - Page number for pagination
 * @param {string} sourceHost - The base URL of the PeerTube instance
 * @param {boolean} isSearch - Whether this is a search request
 * @returns {PlaylistPager} - Pager for playlists
 */

function getPlaylistPager(path, params, page, sourceHost = plugin.config.constants.baseUrl, isSearch = false) {
	const count = PAGE_SIZE_DEFAULT;
	const start = (page ?? 0) * count;
	params = { ...params, start, count };

	const url = `${sourceHost}${path}`;
	const urlWithParams = `${url}?${buildQuery(params)}`;

	let obj;
	try {
		[{ body: obj }] = httpGET({ url: urlWithParams, parseResponse: true });
	} catch (e) {
		log("Failed to get playlists", e);
		return new PlaylistPager([], false);
	}

	const hasMore = obj.total > (start + count);
	
	const playlistResults = obj.data.map(playlist => {
		// Determine the base URL for this playlist
		const playlistBaseUrl = isSearch ? getBaseUrl(playlist.url) : sourceHost;
		const thumbnailUrl = playlist.thumbnailPath ? 
			`${playlistBaseUrl}${playlist.thumbnailPath}` : 
			URLS.PEERTUBE_LOGO;
			
		// Add URL hints using utility functions
		const channelUrl = addChannelUrlHint(playlist.ownerAccount?.url);
		const playlistUrl = addPlaylistUrlHint(`${playlistBaseUrl}/w/p/${playlist.uuid}`);
		
		return new PlatformPlaylist({
			id: new PlatformID(PLATFORM, playlist.uuid, config.id),
			name: playlist.displayName || playlist.name,
			author: new PlatformAuthorLink(
				new PlatformID(PLATFORM, playlist.ownerAccount?.name, config.id),
				playlist.ownerAccount?.displayName || playlist.ownerAccount?.name || "",
				channelUrl,
				getAvatarUrl(playlist.ownerAccount, playlistBaseUrl)
			),
			thumbnail: thumbnailUrl,
			videoCount: playlist.videosLength || 0,
			url: playlistUrl
		});
	});
	
	return new PeerTubePlaylistPager(playlistResults, hasMore, path, params, page, sourceHost, isSearch);
}

/**
 * Fetches the authenticated user's video watch history and creates a PeerTubeHistoryVideoPager
 * @param {string} path - The API path to fetch history from
 * @param {Object} params - Query parameters
 * @param {number} page - Page number for pagination
 * @returns {PeerTubeHistoryVideoPager} Pager for history video results
 */
function getHistoryVideoPager(path, params, page) {
	const count = PAGE_SIZE_HISTORY;
	const start = (page ?? 0) * count;
	params = { ...params, start, count };

	const url = `${plugin.config.constants.baseUrl}${path}`;
	const urlWithParams = `${url}?${buildQuery(params)}`;

	let obj;
	try {
		[{ body: obj }] = httpGET({ url: urlWithParams, useAuthenticated: true, parseResponse: true });
	} catch (e) {
		log("Failed to get user history", e);
		return new VideoPager([], false);
	}

	const results = transformVideoResults(obj.data, true, plugin.config.constants.baseUrl);

	// Attach playback position from watch history
	for (let i = 0; i < results.length; i++) {
		const history = obj.data[i]?.userHistory;
		if (history && history.currentTime) {
			results[i].playbackTime = history.currentTime;
		}
	}

	return new PeerTubeHistoryVideoPager(results, obj.total > (start + count), path, params, page);
}

/**
 * Parses a version string into an array of numeric parts
 * @param {string} version - Version string (e.g. "6.1.0" or "v6.1.0")
 * @returns {number[]} Array of at least 3 numeric version parts [major, minor, patch]
 */
function extractVersionParts(version) {
	// Convert to string and trim any 'v' prefix
	const versionStr = String(version).replace(/^v/, '');

	// Split version into numeric parts
	const parts = versionStr.split('.').map(part => {
		// Ensure each part is a number, default to 0 if not
		const num = parseInt(part, 10);
		return isNaN(num) ? 0 : num;
	});

	// Pad with zeros to ensure at least 3 parts
	while (parts.length < 3) {
		parts.push(0);
	}

	return parts;
}

/**
 * Extracts the server version string from an instance config API response.
 * @param {Object} configResponse - HTTP response from /api/v1/config
 * @returns {string|null} The server version string or null
 */

function getInstanceVersion(configResponse) {
	if (!configResponse || !configResponse.isOk) return null;
	try {
		return JSON.parse(configResponse.body).serverVersion ?? null;
	} catch (e) {
		return null;
	}
}

/**
 * Checks if a server version is the same as or newer than an expected version
 * @param {string} testVersion - The version to test
 * @param {string} expectedVersion - The minimum expected version
 * @returns {boolean} True if testVersion >= expectedVersion
 */
function ServerInstanceVersionIsSameOrNewer(testVersion, expectedVersion) {
	// Handle null or undefined inputs
	if (testVersion == null || expectedVersion == null) {
		return false;
	}

	// Extract numeric parts of both versions
	const testParts = extractVersionParts(testVersion);
	const expectedParts = extractVersionParts(expectedVersion);

	// Compare each part sequentially
	for (let i = 0; i < 3; i++) {
		if (testParts[i] > expectedParts[i]) {
			return true;  // Current version is newer
		}
		if (testParts[i] < expectedParts[i]) {
			return false;  // Current version is older
		}
	}

	return true;
}

/** 
* Find and return the avatar URL from various potential locations to support different Peertube instance versions 
* @param {object} obj  
* @returns {String} Avatar URL 
*/

function getAvatarUrl(obj, baseUrl = plugin.config.constants.baseUrl) {

	const relativePath = [
		obj?.avatar?.path,
		obj?.channel?.avatar?.path,
		obj?.account?.avatar?.path,// When channel don't have avatar, fallback to account avatar (if one) 
		obj?.ownerAccount?.avatar?.path, //found in channel details 
		// Peertube v6.0.0 
		obj?.avatars?.length ? obj.avatars[obj.avatars.length - 1].path : "",//channel 
		obj?.channel?.avatars?.length ? obj.channel.avatars[obj.channel.avatars.length - 1].path : "",//Videos details 
		obj?.account?.avatars?.length ? obj.account.avatars[obj.account.avatars.length - 1].path : "",//comments 
		obj?.ownerAccount?.avatars?.length ? obj.ownerAccount.avatars[obj.ownerAccount.avatars.length - 1].path : ""//channel details 
	].find(v => v); // Get the first non-empty value 

	if (relativePath) {
		return `${baseUrl}${relativePath}`;
	}

	return URLS.PEERTUBE_LOGO;
}

/**
* Find and return the banner URL from various potential locations to support different Peertube instance versions
* @param {object} obj
* @param {string} baseUrl - The base URL of the PeerTube instance
* @returns {String} Banner URL or null if no banner is available
*/

function getBannerUrl(obj, baseUrl = plugin.config.constants.baseUrl) {

	const relativePath = [
		// PeerTube v6.0.0+ - banners array (get the largest banner)
		obj?.banners?.length ? obj.banners[obj.banners.length - 1].path : "",
		obj?.channel?.banners?.length ? obj.channel.banners[obj.channel.banners.length - 1].path : "",
		obj?.account?.banners?.length ? obj.account.banners[obj.account.banners.length - 1].path : "",
		obj?.ownerAccount?.banners?.length ? obj.ownerAccount.banners[obj.ownerAccount.banners.length - 1].path : "",
		// Legacy single banner support (if it exists in older versions)
		obj?.banner?.path,
		obj?.channel?.banner?.path,
		obj?.account?.banner?.path,
		obj?.ownerAccount?.banner?.path
	].find(v => v); // Get the first non-empty value

	if (relativePath) {
		return `${baseUrl}${relativePath}`;
	}

	// Return null instead of a fallback banner to maintain clean UI
	return null;
}

/**
 * Extracts the base URL (protocol + host) from a given URL string.
 * Validates input and throws appropriate exceptions for invalid URLs.
 * 
 * @param {string} url - The URL to extract the base from
 * @returns {string} - The base URL (protocol + host)
 * @throws {ScriptException} - If input is not a string, is empty, or is not a valid URL
 * @throws {ScriptException} - If the URL doesn't contain a valid host or protocol
 * @example
 * // Returns "https://example.com"
 * getBaseUrl("https://example.com/path/to/page?query=123");
 * 
 * // Throws ScriptException: "URL must be a string"
 * getBaseUrl(null);
 * 
 * // Throws ScriptException: "Invalid URL format: invalid-url"
 * getBaseUrl("invalid-url");
 */

function getBaseUrl(url) {
    if (typeof url !== 'string') {
        throw new ScriptException('URL must be a string');
    }
    
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
        throw new ScriptException('URL cannot be empty');
    }
    
    try {
        // Try to create a URL object
        const urlTest = new URL(trimmedUrl);
        
        const host = urlTest.host;
        const protocol = urlTest.protocol;
        
        // Check if both host and protocol exist
        if (!host) {
            throw new ScriptException(`URL must contain a valid host: ${url}`);
        }
        
        if (!protocol) {
            throw new ScriptException(`URL must contain a valid protocol: ${url}`);
        }
        
        return `${protocol}//${host}`;
    } catch (error) {
        // If the error is already our ScriptException, rethrow it
        if (error instanceof ScriptException) {
            throw error;
        }
        
        // Otherwise, create a new ScriptException for URL parsing errors
        throw new ScriptException(`Invalid URL format: ${url}`);
    }
}

/**
 * Adds a URL hint parameter to a URL if it doesn't already have one
 * @param {string} url - The URL to add the hint to
 * @param {string} hintParam - The hint parameter name (without the value)
 * @param {string} hintValue - The value for the hint parameter
 * @returns {string} - The URL with the hint parameter added
 */

function addUrlHint(url, hintParam, hintValue = '1') {
    if (!url) {
        return url;
    }
    
    // Check if hint already exists
    if (url.includes(`${hintParam}=${hintValue}`)) {
        return url;
    }
    
    try {
        const urlObj = new URL(url);
        urlObj.searchParams.append(hintParam, hintValue);
        return urlObj.toString();
    } catch (error) {
        // If URL parsing fails, return the original URL
        log(`Error adding URL hint to ${url}:`, error);
        return url;
    }
}

/**
 * Adds content URL hint to a PeerTube video URL
 * @param {string} url - The video URL
 * @returns {string} - The URL with content hint parameter
 */

function addContentUrlHint(url) {
    return addUrlHint(url, 'isPeertubeContent');
}

/**
 * Adds channel URL hint to a PeerTube channel URL
 * @param {string} url - The channel URL
 * @returns {string} - The URL with channel hint parameter
 */

function addChannelUrlHint(url) {
    return addUrlHint(url, 'isPeertubeChannel');
}

/**
 * Adds playlist URL hint to a PeerTube playlist URL
 * @param {string} url - The playlist URL
 * @returns {string} - The URL with playlist hint parameter
 */

function addPlaylistUrlHint(url) {
    return addUrlHint(url, 'isPeertubePlaylist');
}

/**
 * Extracts channel ID from PeerTube channel URLs
 * @param {string} url - PeerTube channel URL (e.g. /c/{id}, /video-channels/{id})
 * @returns {string|null} Channel ID or null if not a valid channel URL
 */
function extractChannelId(url) {
	try {
		if (!url) return null;

		const urlTest = new URL(url);
		const { pathname } = urlTest;

		// Regex to match and extract the channel ID from /c/, /video-channels/, and /api/v1/video-channels/ URLs
		const match = pathname.match(/^\/(c|video-channels|api\/v1\/video-channels)\/([a-zA-Z0-9-_.@]+)(?:\/(video|videos)?)?\/?$/);

		return match ? match[2] : null; // match[2] contains the extracted channel ID
	} catch (error) {
		log('Error extracting PeerTube channel ID:', error);
		return null;
	}
}

/**
 * Extracts video ID from PeerTube video URLs
 * @param {string} url - PeerTube video URL (e.g. /w/{id}, /videos/watch/{id})
 * @returns {string|null} Video ID or null if not a valid video URL
 */
function extractVideoId(url) {
	try {
		if (!url) return null;

		const urlTest = new URL(url);
		const { pathname } = urlTest;

		// Regex to match and extract the video ID from various video URL patterns including API URLs
		const match = pathname.match(/^\/(videos\/(watch|embed)\/|w\/|api\/v1\/videos\/)([a-zA-Z0-9-_]+)(?:\/.*)?$/);

		return match ? match[3] : null; // match[3] contains the extracted video ID
	} catch (error) {
		log('Error extracting PeerTube video ID:', error);
		return null;
	}
}

/**
 * Extracts playlist ID from PeerTube playlist URLs
 * @param {string} url - PeerTube playlist URL
 * @returns {string|null} - Playlist ID or null if not a valid playlist URL
 */

function extractPlaylistId(url) {
	try {
		if (!url) return null;

		const urlTest = new URL(url);
		const { pathname } = urlTest;

		// Try to match standard playlist URL patterns
		// - /videos/watch/playlist/{uuid}
		// - /w/p/{uuid}
		// Allow a wider range of characters in the ID to support more instances
		let match = pathname.match(/^\/(videos\/watch\/playlist\/|w\/p\/)([a-zA-Z0-9-_]+)(?:\/.*)?$/);
		// If no match, try another pattern that allows more characters in the ID
		if (!match) {
			match = pathname.match(/^\/w\/p\/([a-zA-Z0-9]+)(?:\/.*)?$/);
		}
		if (match) return match[match.length-1];
		
		// Try to match direct playlist URL pattern
		// - /video-playlists/{uuid}
		// - /api/v1/video-playlists/{uuid}
		match = pathname.match(/^\/(video-playlists|api\/v1\/video-playlists)\/([a-zA-Z0-9-_]+)(?:\/.*)?$/);
		if (match) return match[2];
		
		// Try to match channel playlist URL patterns
		// - /video-channels/{channelName}/video-playlists/{playlistId}
		// - /c/{channelName}/video-playlists/{playlistId}
		match = pathname.match(/^\/(video-channels|c)\/[a-zA-Z0-9-_.]+\/video-playlists\/([a-zA-Z0-9-_]+)(?:\/.*)?$/);
		if (match) return match[2];

		return null;
	} catch (error) {
		log('Error extracting PeerTube playlist ID:', error);
		return null;
	}
}

/**
 * Creates an AudioUrlSource from a PeerTube file object
 * @param {Object} file - PeerTube file object with resolution and URL info
 * @param {number} duration - Duration of the audio in seconds
 * @returns {AudioUrlSource} Audio source descriptor
 */
function createAudioSource(file, duration) {
	return new AudioUrlSource({
		name: file.resolution.label,
		url: file.fileUrl ?? file.fileDownloadUrl,
		duration: duration,
		container: "audio/mp3",
		codec: "aac"
	});
}

/**
 * Creates a VideoUrlSource from a PeerTube file object with resolution lookup
 * @param {Object} file - PeerTube file object with resolution and URL info
 * @param {number} duration - Duration of the video in seconds
 * @returns {VideoUrlSource} Video source descriptor
 */
function createVideoSource(file, duration) {
	const supportedResolution = file.resolution.width && file.resolution.height
		? { width: file.resolution.width, height: file.resolution.height }
		: supportedResolutions[file.resolution.label];
		
	return new VideoUrlSource({
		name: file.resolution.label,
		url: file.fileUrl ?? file.fileDownloadUrl,
		width: supportedResolution?.width,
		height: supportedResolution?.height,
		duration: duration,
		container: "video/mp4"
	});
}

/**
 * Builds a media source descriptor from a PeerTube video object, handling HLS, muxed, unmuxed, and audio-only sources
 * @param {Object} obj - PeerTube video object containing streamingPlaylists and files
 * @returns {VideoSourceDescriptor|UnMuxVideoSourceDescriptor} Media source descriptor for playback
 */
function getMediaDescriptor(obj) {

	let inputFileSources = [];

	const hlsOutputSources = [];

	const muxedVideoOutputSources = [];
	const unMuxedVideoOnlyOutputSources = [];
	const unMuxedAudioOnlyOutputSources = [];

	for (const playlist of (obj?.streamingPlaylists ?? [])) {

		const hlsSourceOpts = {
			name: "HLS",
			url: playlist.playlistUrl,
			duration: obj.duration ?? 0,
			priority: true
		};

		if (IS_IMPERSONATION_AVAILABLE && _settings?.enableBrowserImpersonation) {
			hlsSourceOpts.requestModifier = {
				options: {
					applyAuthClient: "",
					applyCookieClient: "",
					applyOtherHeaders: false,
					impersonateTarget: IMPERSONATION_TARGET
				}
			};
		}

		hlsOutputSources.push(new HLSSource(hlsSourceOpts));

		// exclude transcoded files for now due to some incompatibility issues (no length metadata (invalid duration on android devices) and performance issues loading the files on desktop
		// those are the same videos used for HLS
		// (playlist?.files ?? []).forEach((file) => {
		// 	inputFileSources.push(file);
		// });
	}

	(obj?.files ?? []).forEach((file) => {
		inputFileSources.push(file);
	});

	for (const file of inputFileSources) {
		const isAudioOnly = (file.hasAudio == undefined && file.hasVideo == undefined && file.resolution.id === 0) || (file.hasAudio && !file.hasVideo);

		if (isAudioOnly) {
			unMuxedAudioOnlyOutputSources.push(createAudioSource(file, obj.duration));
		}

		const isMuxedVideo = (file.hasAudio == undefined && file.hasVideo == undefined && file.resolution.id !== 0) || (file.hasAudio && file.hasVideo);
		if (isMuxedVideo) {
			muxedVideoOutputSources.push(createVideoSource(file, obj.duration));
		}

		const isUnMuxedVideoOnly = (!file.hasAudio && file.hasVideo);
		if (isUnMuxedVideoOnly) {
			unMuxedVideoOnlyOutputSources.push(createVideoSource(file, obj.duration));
		}
	}

	const isAudioMode = !unMuxedVideoOnlyOutputSources.length
		&& !muxedVideoOutputSources.length
		&& !hlsOutputSources.length;

	if (isAudioMode) {
		return new UnMuxVideoSourceDescriptor([], unMuxedAudioOnlyOutputSources);
	} else {
		if (hlsOutputSources.length && !unMuxedVideoOnlyOutputSources.length) {
			return new VideoSourceDescriptor(hlsOutputSources);
		}
		else if (muxedVideoOutputSources.length) {
			return new VideoSourceDescriptor(muxedVideoOutputSources);
		}
		else if (unMuxedVideoOnlyOutputSources.length && unMuxedAudioOnlyOutputSources.length) {
			return new UnMuxVideoSourceDescriptor(unMuxedVideoOnlyOutputSources, unMuxedAudioOnlyOutputSources);
		}
		// Fallback to empty video source descriptor if no sources are found
		return new VideoSourceDescriptor([]);
	}
}


/**
 * Creates a PlatformPlaylistDetails from a PeerTube tag search URL
 * @param {string} url - Tag search URL containing a tagsOneOf parameter
 * @returns {PlatformPlaylistDetails|null} Playlist details for the tag, or null on failure
 */
function getTagPlaylist(url) {
	try {
		const urlObj = new URL(url);
		const sourceBaseUrl = `${urlObj.protocol}//${urlObj.host}`;
		const tagsOneOf = urlObj.searchParams.get('tagsOneOf');

		if (!tagsOneOf) {
			return null;
		}

		// Create playlist URL with hint
		const playlistUrl = `${url}&isPeertubeTagSearch=1`;

		return new PlatformPlaylistDetails({
			id: new PlatformID(PLATFORM, `tag-${tagsOneOf}`, config.id),
			name: `Tag: ${tagsOneOf}`,
			author: new PlatformAuthorLink(
				new PlatformID(PLATFORM, "tags", config.id),
				sourceBaseUrl.replace(/^https?:\/\//, ''),
				sourceBaseUrl,
				null
			),
			thumbnail: null,
			videoCount: -1,
			url: playlistUrl,
			contents: getVideoPager(
				'/api/v1/search/videos',
				{
					tagsOneOf: tagsOneOf,
					sort: '-match',
					searchTarget: 'local'
				},
				0,
				sourceBaseUrl,
				true
			)
		});
	} catch (e) {
		log("Error creating tag playlist", e);
		return null;
	}
}

/**
 * Maps a category setting index to a PeerTube category ID
 * @param {number|string} categoryIndex - Index from settings (1-18 map to category IDs)
 * @returns {string|null} Category ID string or null if index is out of range
 */
function getCategoryId(categoryIndex) {
	// Convert index to category ID
	// Index 0 = "" (no category), Index 1 = "1" (Music), Index 2 = "2" (Films), etc.

	const index = parseInt(categoryIndex);

	if (index >= 1 && index <= 18) {
		return index.toString();
	}
	return null;
}

/**
 * Maps a language setting index to an ISO language code
 * @param {number|string} languageIndex - Index from settings (1-37 map to language codes)
 * @returns {string|null} ISO language code or null if index is out of range
 */
function getLanguageCode(languageIndex) {
	const languageMap = [
		"", // Index 0 = empty
		"en", // Index 1 = English
		"fr", // Index 2 = Français
		"ar", // Index 3 = العربية
		"ca", // Index 4 = Català
		"cs", // Index 5 = Čeština
		"de", // Index 6 = Deutsch
		"el", // Index 7 = ελληνικά
		"eo", // Index 8 = Esperanto
		"es", // Index 9 = Español
		"eu", // Index 10 = Euskara
		"fa", // Index 11 = فارسی
		"fi", // Index 12 = Suomi
		"gd", // Index 13 = Gàidhlig
		"gl", // Index 14 = Galego
		"hr", // Index 15 = Hrvatski
		"hu", // Index 16 = Magyar
		"is", // Index 17 = Íslenska
		"it", // Index 18 = Italiano
		"ja", // Index 19 = 日本語
		"kab", // Index 20 = Taqbaylit
		"nl", // Index 21 = Nederlands
		"no", // Index 22 = Norsk
		"oc", // Index 23 = Occitan
		"pl", // Index 24 = Polski
		"pt", // Index 25 = Português (Brasil)
		"pt-PT", // Index 26 = Português (Portugal)
		"ru", // Index 27 = Pусский
		"sk", // Index 28 = Slovenčina
		"sq", // Index 29 = Shqip
		"sv", // Index 30 = Svenska
		"th", // Index 31 = ไทย
		"tok", // Index 32 = Toki Pona
		"tr", // Index 33 = Türkçe
		"uk", // Index 34 = украї́нська мо́ва
		"vi", // Index 35 = Tiếng Việt
		"zh-Hans", // Index 36 = 简体中文（中国）
		"zh-Hant" // Index 37 = 繁體中文（台灣）
	];

	const index = parseInt(languageIndex);
	if (index >= 1 && index < languageMap.length) {
		return languageMap[index];
	}
	return null;
}



/**
 * Returns the user's NSFW content policy from settings
 * @returns {string} The NSFW policy: "do_not_list", "blur", or "display"
 */
function getNSFWPolicy() {
	const policyIndex = parseInt(_settings.nsfwPolicy) || 0;
	const policies = ["do_not_list", "blur", "display"];
	return policies[policyIndex] || "do_not_list";
}

/**
 * Sets the nsfw query parameter on params based on the user's NSFW policy,
 * unless an explicit nsfw value is already set.
 * @param {Object} params - Query parameters object to modify in place
 */
function applyNSFWFilter(params) {
	if (params.hasOwnProperty('nsfw')) return;
	const nsfwPolicy = getNSFWPolicy();
	params.nsfw = nsfwPolicy === "do_not_list" ? 'false' : 'both';
}

/**
 * Throws a CaptchaRequiredException if the response contains a Cloudflare challenge.
 * Only active when the Cloudflare captcha setting is enabled.
 * @param {Object} resp - The HTTP response object
 * @throws {CaptchaRequiredException} If the response body contains a captcha challenge
 */

function throwIfCaptcha(resp) {
	if (!_settings.enableCloudflareCaptcha) return;
	if (resp?.body && resp?.code == 403) {
		if (/Just a moment\.\.\./i.test(resp.body)) {
			throw new CaptchaRequiredException(resp.url, resp.body);
		}
	}
}

log("loaded");

// Those instances were requested by users
// Those hostnames are exclusively used to help the plugin know if a hostname is a PeerTube instance
// Neither Grayjay nor FUTO is associated with, endorses, or is responsible for the content on those instances.
INDEX_INSTANCES.instances = [
	...INDEX_INSTANCES.instances,'poast.tv','videos.upr.fr','peertube.red'
]
// BEGIN AUTOGENERATED INSTANCES
// This content is autogenerated during deployment using update-instances.sh
// Sources: https://instances.joinpeertube.org, https://api.fediverse.observer/, and https://api.fedidb.org/
// Those hostnames are exclusively used to help the plugin know if a hostname is a PeerTube instance
// Neither Grayjay nor FUTO is associated with, endorses, or is responsible for the content on those instances.
// Last updated at: 2026-03-13
INDEX_INSTANCES.instances = ["0ch.tv","22x22.ru","2tonwaffle.tv","404again.com","810video.com","ace-deec.inspe-bretagne.fr","agora.votemap.eu","aipi.video","ai-stage1.ph-burgenland.at","all.electric.kitchen","alterscope.fr","anarchy.tube","andyrush.fedihost.io","angeltales.angellive.ru","annex.fedimovie.com","apathy.tv","aperi.tube","apertatube.net","apollo.lanofthedead.xyz","archive.hitness.club","archive.nocopyrightintended.tv","archive.reclaim.tv","arkm.tv","arson.video","artitube.artifaille.fr","asantube.stream","astrotube.obspm.fr","astrotube-ufe.obspm.fr","audio.freediverse.com","autonomy.tube","avantwhatever.xyz","av.giplt.nl","avone.me","av.ontariostreet.org","ballhaus.media","bark.video","battlepenguin.video","bava.tv","beardedtek.net","beartrix-peertube-u29672.vm.elestio.app","bedheadbernie.net","bee-tube.fr","bellestudio.org","bengo.tube","benktube.benkdanas.synology.me","beta.flimmerstunde.xyz","betamax.donotsta.re","bewegte-bilder.berlin","biblion.refchat.net","biblioteca.theowlclub.net","bideoak.argia.eus","bideoak.zeorri.eus","bideoteka.eus","bimbo.video","bitcointv.com","bitforged.stream","bitube.ict-battenberg.ch","bluefox.video","blurt.media","bodycam.leapjuice.com","bolha.tube","bonn.video","breeze.tube","bridport.tv","brioco.live","brocosoup.fr","canal.bizarro.cc","canal.facil.services","canard.tube","canti.kmeuh.fr","caseyandbros.walker.id","cast.garden","ccutube.ccu.edu.tw","cdn01.tilvids.com","cdn7.dns04.com","cec-ptube.mpu.edu.mo","cfnumerique.tv","channel.t25b.com","christian.freediverse.com","christube.malyon.co.uk","christuncensored.com","christunscripted.com","cine.nashe.be","classe.iro.umontreal.ca","clipet.tv","clip.place","clips.crcmz.me","clips.regenpfeifer.net","cloudtube.ise.fraunhofer.de","codec.au","commons.tube","communitymedia.video","conf.tube","content.haacksnetworking.org","content.wissen-ist-relevant.com","cookievideo.com","crank.recoil.org","crimecamz.com","csictv.csic.es","csptube.au","c-tube.c-base.org","cubetube.tv","cuddly.tube","cumraci.tv","dalek.zone","dalliance.network","dangly.parts","darkvapor.nohost.me","davbot.media","ddi-video.cs.uni-paderborn.de","den.wtf","dev.itvplus.iiens.net","dev-my.sohobcom.ye","devwithzachary.com","digitalcourage.video","diler.tube","diode.zone","dioxi.ddns.net","dioxitube.com","displayeurope.video","djtv.es","dob.media.fibodo.com","docker.videos.lecygnenoir.info","dreamspace.video","dreiecksnebel.alex-detsch.de","drovn.ninja","drumpeer.xyz","dud175.inf.tu-dresden.de","dudelike.wtf","dud-video.inf.tu-dresden.de","dytube.com","earthclimate.tv","earthshiptv.nl","ebildungslabor.video","eburg.tube","edflix.nl","eggflix.foolbazar.eu","eleison.eu","eloquer.de","env-0499245.wc.reclaim.cloud","epsilon.pw","espertubo.eu","evangelisch.video","evuo.online","exatas.tv","exode.me","exo.tube","expeer.eduge.ch","exquisite.tube","faf.watch","fair.tube","falkmx.ddns.net","fedimovie.com","feditubo.yt","fediverse.tv","fedi.video","fedtv.girolab.foo","fightforinfo.com","film.fjerland.no","film.k-prod.fr","film.node9.org","film.opensoos.nl","filmspace.lightcurvefilms.com","firehawks.htown.de","fire.itwien.net","físeáin.nead-na-bhfáinleog.ie","flappingcrane.com","flimmerstunde.moellus.net","flim.txmn.tk","flipboard.video","flooftube.net","fontube.fr","formationsvideos.de","foss.video","fotogramas.politicaconciencia.org","foubtube.com","framatube.org","francetube.infojournal.fr","freediverse.com","freedomtv.pro","freesoto.tv","friprogramvarusyndikatet.tv","fstube.net","gabtoken.noho.st","gade.o-k-i.net","gallaghertube.com","garr.tv","gas.tube.sh","gbemkomla.jesuits-africa.education","gegenstimme.tv","glan.no","gnulinux.tube","go3.site","goetterfunkentv.peertube-host.de","goldcountry.tube","goredb.com","goresee.com","greatview.video","grypstube.uni-greifswald.de","gultsch.video","haeckflix.org","handcuffedgirls.me","hauntshadetube.nl","helisexual.live","hitchtube.fr","hive-tube.f5.htw-berlin.de","holm.video","homoplaza.tv","hosers.isurf.ca","hpstube.fr","humanreevolution.com","hyperreal.tube","ibbwstream.schule-bw.de","ibiala.nohost.me","icanteven.watch","indymotion.fr","infothema.net","inspeer.eduge.ch","intelligentia.tv","intratube-u25541.vm.elestio.app","irrsinn.video","itvplus.iiens.net","jetstream.watch","jnuk.media","jnuk-peertube-u52747.vm.elestio.app","joeltube.com","johnydeep.net","joovideo.cfd","kadras.live","kamtube.ru","kanal-ri.click","karakun-peertube-codecamp.k8s.karakun.com","kiddotube.com","kilero.interior.edu.uy","killedinit.mooo.com","kino.kompot.si","kino.schuerz.at","kinowolnosc.pl","kirche.peertube-host.de","kiwi.froggirl.club","kodcast.com","kolektiva.media","koreus.tv","k-pop.22x22.ru","kpop.22x22.ru","kviz.leemoon.network","kyiv.tube","lakupatukka.tunk.org","lastbreach.tv","leffler.video","lenteratv.umt.edu.my","librepoop.de","libretube.ru","lightchannel.tv","lillychan.tv","linhtran.eu","linux.tail065cae.ts.net","literatube.com","live.codinglab.ch","live.dcnh.cloud","live.libratoi.org","live.nanao.moe","live.oldskool.fi","live.solari.com","live.virtualabs.fr","live.zawiya.one","lokalmedial.de","lone.earth","loquendotv.net","loquendotv.zsh.jp","lostpod.space","lounges.monster","lte-tube.obspm.fr","lucarne.balsamine.be","ludra.ch","luxtube.lu","lv.s-zensky.com","lyononline.dev","makertube.net","maspree.asia","matte.fedihost.io","m.bbbdn.jp","mcast.mvideo.ru","media.apc.org","media.assassinate-you.net","media.caladona.org","media.chch.it","media.cooleysekula.net","media.curious.bio","media.exo.cat","media.fermalo.fr","media.fsfe.org","media.gadfly.ai","media.geekwisdom.org","media.gzevd.de","media.inno3.eu","media.interior.edu.uy","media.krashboyz.org","media.mwit.ac.th","media.mzhd.de","media.natoinnovation.network","media.no42.org","media.nolog.cz","media.notfunk.radio","media.opendigital.info","media.outline.rocks","media.over-world.org","media.pelin.top","media.privacyinternational.org","media.repeat.is","medias.debrouillonet.org","media.selector.su","media.smz-ma.de","medias.pingbase.net","mediathek.fs1.tv","mediathek.ra-micro.de","mediathek.rzgierskopp.de","media.tildefriends.net","media.undeadnetwork.de","media.vzst.nl","media.zat.im","megatube.lilomoino.fr","megaultra.us","merci-la-police.fr","meshtube.net","metacafe.su.gy","mevideo.host","meyon.com.ye","micanal.encanarias.info","michaelheath.tv","mirar.comun.red","mirror.peertube.metalbanana.net","mirtube.ru","misnina.tv","mix.video","mla.moe","modvid.com","monitor.grossermensch.eu","mooosetube.mooose.org","mootube.fans","mosk.tube","motube.smithandtech.com","mountaintown.video","movie.nael-brun.com","mplayer.demouliere.eu","mtube.mooo.com","muku.dk","murduk.thundercleess.com","music.calculate.social","music.facb69.tec.br","music.imagcon.com","mv.vannilla.org","mystic.video","my-sunshine.video","mytube.bijralph.com","mytube.cooltux.net","mytube.kn-cloud.de","mytube.madzel.de","mytube.malenfant.net","mytube.pyramix.ca","nadajemy.com","nanawel-peertube.dyndns.org","nastub.cz","neat.tube","nekopunktube.fr","neon.cybre.stream","neshweb.tv","nethack.tv","nicecrew.tv","nightshift.minnix.dev","nolog.media","northtube.ca","notretube.asselma.eu","nuobodu.space","nvsk.tube","nya.show","nyltube.nylarea.com","ocfedtest.hosted.spacebear.ee","offenes.tv","ohayo.rally.guide","oldtube.aetherial.xyz","on24.at","onair.sbs","online.obstbaumschnittschule.de","onlyeddie.net","ontvkorea.com","openmedia.edunova.it","open.movie","opsis.kyanos.one","outcast.am","ovaltube.codinglab.ch","owotube.ru","p2b.drjpdns.com","p2ptube.speednetssh.com","pace.rip","pallenberg.video","pantube.ovh","partners.eqtube.org","pastafriday.club","pbvideo.ru","peer.acidfog.com","peer.adalta.social","peerate.fr","peer.azurs.fr","peer.grantserve.uk","peer.i6p.ru","peer.madiator.cloud","peer.mrschneeball.xyz","peer.philoxweb.be","peer.pvddhhnk.nl","peer.raise-uav.com","peer.taibsu.net","peer.theaterzentrum.at","p.eertu.be","peer.tube","peertube.0011.lt","peertube.020.pl","peertube.0gb.de","peertube.123.in.th","peertube.1312.media","peertube.1984.cz","peertube.21314.de","peertube.22f.uk","peertube2.assomption.bzh","peertube2.cpy.re","peertube.2i2l.net","peertube.2tonwaffle.com","peertube.30p87.de","peertube33.ethibox.fr","peertube3.cpy.re","peertube400.pocketnet.app","peertube.42lausanne.ch","peertube.42paris.fr","peertube601.pocketnet.app","peertube6.f-si.org","peertube.adresse.data.gouv.fr","peertube.aegrel.ee","peertube.ai6yr.org","peertube.aldinet.duckdns.org","peertube.alexma.top","peertube.alpaga-libre.fr","peertube.alpharius.io","peertube.amicale.net","peertube.am-networks.fr","peertube.anasodon.com","peertube.anduin.net","peertube.anija.mooo.com","peertube.anon-kenkai.com","peertube.anti-logic.com","peertube.anzui.dev","peertube.apcraft.jp","peertube.apse-asso.fr","peertube.archive.pocketnet.app","peertube.arch-linux.cz","peertube-ardlead-u29325.vm.elestio.app","peertube.arknet.media","peertube.arnhome.ovh","peertube.art3mis.de","peertube.artica.center","peertube.askan.info","peertube.asp.krakow.pl","peertube.astral0pitek.synology.me","peertube.astrolabe.coop","peertube.atilla.org","peertube.atsuchan.page","peertube.aukfood.net","peertube.automat.click","peertube.awit.at","peertube.axiom-paca.g1.lu","peertube.b38.rural-it.org","peertube.baptistentiel.nl","peertube.bbrks.me","peertube.be","peertube.becycle.com","peertube.beeldengeluid.nl","peertube-beeldverhalen-u36587.vm.elestio.app","peertube.behostings.net","peertube.bekucera.uk","peertube.bgeneric.net","peertube.bgzashtita.es","peertube.bilange.ca","peertube.bildung-ekhn.de","peertube.bingo-ev.de","peertube.blablalinux.be","peertube.blindskeleton.one","peertube.boc47.org","peertube.boger.dev","peertube.boomjacky.art","peertube.br0.fr","peertube.brian70.tw","peertube.bridaahost.ynh.fr","peertube.brigadadigital.tec.br","peertube.bubbletea.dev","peertube.bubuit.net","peertube.bunseed.org","peertube.busana.lu","peertube.c44.com.au","peertube.cainet.info","peertube.carmin.tv","peertube.casasnow.noho.st","peertube.casually.cat","peertube.ccrow.org","peertube.cevn.io","peertube.ch","peertube.chartilacorp.ru","peertube.chaunchy.com","peertube.chickenmunt.com","peertube.chir.rs","peertube.chn.moe","peertube.chnops.info","peertube.christianpacaud.com","peertube.chrskly.net","peertube.chuggybumba.com","peertube.cif.su","peertube.cipherbliss.com","peertube.circlewithadot.net","peertube.cirkau.art","peertube.cloud68.co","peertube.cloud.nerdraum.de","peertube.cloud.sans.pub","peertube.cluster.wtf","peertube.cobolworx.com","peertube.cocamserverguild.com","peertube.codeheap.dev","peertube.coderbunker.ca","peertube.commonshub.social","peertube.communecter.org","peertube.conangle.org","peertube.co.uk","peertube.cpy.re","peertube.craftum.pl","peertube.cratonsed.ge","peertube.crazy-to-bike.de","peertube.csparker.co.uk","peertube.ctrl-c.liu.se","peertube.ctseuro.com","peertube.cuatrolibertades.org","peertube.cube4fun.net","peertube.cyber-tribal.com","peertubecz.duckdns.org","peertube.daemonlord.freeddns.org","peertube.dair-institute.org","peertube.darkness.services","peertube.datagueule.tv","peertube.dcldesign.co.uk","peertube.dc.pini.fr","peertube.deadpilots.net","peertube.debian.social","peertube.delfinpe.de","peertube.delta0189.xyz","peertube-demo.lern.link","peertube.demonix.fr","peertube.designersethiques.org","peertube.desmu.fr","peertube.devol.it","peertube.diem25.ynh.fr","peertube.diplopode.net","peertube.dixvaha.com","peertube.dk","peertube-docker.cpy.re","peertube.doesstuff.social","peertube.doronichi.com","peertube.downes.ca","peertube.dryusdan.fr","peertube.dsdrive.fr","peertube.dsmouse.net","peertube.dtth.ch","peertube.dubwise.dk","peertube.duckarmada.moe","peertube.dynlinux.io","peertube.easter.fr","peertube.eb8.org","peertube-ecogather-u20874.vm.elestio.app","peertube.ecologie.bzh","peertube.ecsodikas.eu","peertube.education-forum.com","peertube.ekosystems.fr","peertube.elforcer.ru","peertube.elobot.ch","peertube.emy.lu","peertube.enterz.net","peertube.eqver.se","peertube.err404.numericore.com","peertube.ethibox.fr","peertube.eticadigital.eu","peertube-eu.howlround.com","peertube.eu.org","peertube.european-pirates.eu","peertube.eus","peertube.euskarabildua.eus","peertube.evilmeow.com","peertube.existiert.ch","peertube-ext.sovcombank.ru","peertube.familie-berner.de","peertube.familleboisteau.fr","peertube.feddit.social","peertube.fedihost.website","peertube.fedihub.online","peertube.fedi-multi-verse.eu","peertube.fediversity.eu","peertube.fedi.zutto.fi","peertube.fenarinarsa.com","peertube.ferox.cc","peertube.festnoz.de","peertube.fifthdread.com","peertube.flauschbereich.de","peertube.florentcurk.com","peertube.fomin.site","peertube.forteza.fr","peertube.fototjansterkalmar.com","peertube.foxfam.club","peertube.fr","peertube.freespeech.club","peertube.fschaupp.me","peertube.f-si.org","peertube.funkfeuer.at","peertube.futo.org","peertube.g2od.ch","peertube.gaialabs.ch","peertube.galasmayren.com","peertube.gargantia.fr","peertube.gd-events.fr","peertube.geekgalaxy.fr","peertube.geekgo.tech","peertube.geekheads.net","peertube.gegeweb.eu","peertube.gemlog.ca","peertube.genma.fr","peertube.get-racing.de","peertube.ghis94.ovh","peertube.gidikroon.eu","peertube.giftedmc.com","peertube.giz.berlin","peertube.graafschapcollege.nl","peertube.grambo.fr","peertube.gravitywell.xyz","peertube.gröibschi.ch","peertube.grosist.fr","peertube.gsugambit.com","peertube.guillaumeleguen.xyz","peertube.guiofamily.fr","peertube.gyatt.cc","peertube.gymnasium-ditzingen.de","peertube.gyptazy.com","peertube.habets.house","peertube.hackerfoo.com","peertube.hameln.social","peertube.havesexwith.men","peertube.headcrashing.eu","peertube.heise.de","peertube.helvetet.eu","peertube.henrywithu.com","peertube.heraut.eu","peertube.hethapsishuis.nl","peertube.hibiol.eu","peertube.histoirescrepues.fr","peertube.hizkia.eu","peertube.hlpnet.dk","peertube.holm.chat","peertube.home.x0r.fr","peertube.hosnet.fr","peertube.h-u.social","peertube.hyperfreedom.org","peertube.ichigo.everydayimshuflin.com","peertube.ignifi.me","peertube.ii.md","peertube.imaag.de","peertube.init-c.de","peertube.inparadise.se","peertube.interhop.org","peertube.intrapology.com","peertube.in.ua","peertube.iridescent.nz","peertube.iriseden.eu","peertube.it","peertube.it-arts.net","peertube.iterikviscelanova.com","peertube.iz5wga.radio","peertube.jackbot.fr","peertube.jancokock.me","peertube.jarmvl.net","peertube.jimmy-b.se","peertube.jmsquared.net","peertube.joby.lol","peertube.johntheserg.al","peertube.june.ie","peertube.jussak.net","peertube.kaaosunlimited.fi","peertube.kaleidos.net","peertube.kalua.im","peertube.kameha.click","peertube.katholisch.social","peertube.kawateam.fr","peertube.keazilla.net","peertube.keisanki.net","peertube.kerenon.com","peertube.kevinperelman.com","peertube.kitsun.gay","peertube.klaewyss.fr","peertube.klemtu.ca","peertube.kleph.eu","peertube.kobel.fyi","peertube.kompektiva.org","peertube.koolenboer.synology.me","peertube.kriom.net","peertube-ktgou-u11537.vm.elestio.app","peertube.kuenet.ch","peertube.kx.studio","peertube.kyriog.eu","peertube.laas.fr","peertube.labeuropereunion.eu","peertube.labfox.fr","peertube.lab.how","peertube.la-famille-muller.fr","peertube.lagbag.com","peertube.lagob.fr","peertube.lagvoid.com","peertube.lagy.org","peertube.lanterne-rouge.info","peertube.laurahargreaves.com","peertube.laveinal.cat","peertube.le-cem.com","peertube.legoujon.fr","peertube.lesparasites.net","peertube.lhc.lu","peertube.lhc.net.br","peertube.li","peertube.librelabucm.org","peertube.libresolutions.network","peertube.libretic.fr","peertube.linagora.com","peertube.linsurgee.fr","peertube.linuxrocks.online","peertube.liodie.fr","peertube.livespotting.com","peertube.livingutopia.org","peertube.local.tilera.xyz","peertube.logilab.fr","peertube.louisematic.site","peertube.luanti.ru","peertube.luckow.org","peertube.luga.at","peertube.luismarques.me","peertube.lyceeconnecte.fr","peertube.lyclpg.itereva.pf","peertube.lykle.stellarhosted.com","peertube.m2.nz","peertube.macnemo.social","peertube.magicstone.dev","peertube.makotoworkshop.org","peertube.manalejandro.com","peertube.marcelsite.com","peertube.marienschule.de","peertube.mariustimmer.de","peertube.martiabernathey.com","peertube.marud.fr","peertube.mauve.haus","peertube.mdg-hamburg.de","peertube.meditationsteps.org","peertube.mesnumeriques.fr","peertube.metalbanana.net","peertube.metalphoenix.synology.me","peertube.mgtow.pl","peertube.miguelcr.me","peertube.mikemestnik.net","peertube.minetestserver.ru","peertube.miniwue.de","peertube.mit.edu","peertube.mitikas.de","peertube.mldchan.dev","peertube.modspil.dk","peertube.monicz.dev","peertube.monlycee.net","peertube.moulon.inrae.fr","peertube.mpu.edu.mo","peertube.musicstudio.pro","peertube.muxika.org","peertube.mygaia.org","peertube.myhn.fr","peertube.myjhdiy.net","peertube-myvideos.de","peertube.nadeko.net","peertube.naln1.ca","peertube.nashitut.ru","peertube.nayya.org","peertube.nazlo.space","peertube.nekosunevr.co.uk","peertube.netlogon.dk","peertube.netzbegruenung.de","peertube.nextcloud.com","peertube.nicolastissot.fr","peertube.nighty.name","peertube.nissesdomain.org","peertube.no","peertube.nodja.com","peertube.nogafam.fr","peertube.noiz.co.za","peertube.nomagic.uk","peertube.normalgamingcommunity.cz","peertube.northernvoice.app","peertube.novettam.dev","peertube.nthpyro.dev","peertube.nuage-libre.fr","peertube.nudecri.unicamp.br","peertube.nwps.fi","peertube.offerman.com","peertube.officebot.io","peertube.ohioskates.com","peertube.on6zq.be","peertube.ondevice.eu","peertube.opencloud.lu","peertube.openrightsgroup.org","peertube.openstreetmap.fr","peertube.orderi.co","peertube.org.uk","peertube.otakufarms.com","peertube.otterlord.dev","peertube.paahtimo.games","peertube.pablopernot.fr","peertube.paladyn.org","peertube.palermo.nohost.me","peertube.parenti.net","peertube.paring.moe","peertube.pcservice46.fr","peertube.physfluids.fr","peertube.pierregaignet.fr","peertube.pixnbits.de","peertube.pix-n-chill.fr","peertube.plataformess.org","peertube.platta.at","peertube.plaureano.nohost.me","peertube.pnpde.social","peertube.podverse.fm","peertube.pogmom.me","peertube.pp.ua","peertube.pressthebutton.pw","peertube-private.johntheserg.al","peertube.protagio.org","peertube.prozak.org","peertube.public.cat","peertube.pueseso.club","peertube.puzyryov.ru","peertube.pve1.cluster.weinrich.dev","peertube.qontinuum.space","peertube.qtg.fr","peertube.r2.enst.fr","peertube.r5c3.fr","peertube.radres.xyz","peertube.rainbowswingers.net","peertube.ra.no","peertube.redgate.tv","peertube.redpill-insight.com","peertube.researchinstitute.at","peertube.revelin.fr","peertube.rezel.net","peertube.rezo-rm.fr","peertube.rhoving.com","peertube.rlp.schule","peertube.roflcopter.fr","peertube.rogu.fr","peertube.rokugan.fr","peertube.rouesoify.fr","peertube.rougevertbleu.tv","peertube.roundpond.net","peertube.rse43.com","peertube.rural-it.org","peertube.s2s.video","peertube.sarg.dev","peertube.satoshishop.de","peertube.sbbz-luise.de","peertube.scapior.dev","peertube.scd31.com","peertube.sciphy.de","peertube.sct.pf","peertube.se","peertube.sebastienvigneau.xyz","peertube.securelab.eu","peertube.securitymadein.lu","peertube.seitendan.com","peertube.semperpax.com","peertube.semweb.pro","peertube.sensin.eu","peertube.server.we-cloud.de","peertube.serveur.slv-valbonne.fr","peertube.seti-hub.org","peertube.shadowfr69.eu","peertube.shi4home.com","peertube.shilohnewark.org","peertube.shultz.ynh.fr","peertube.sieprawski.pl","peertube.simon-franek.de","peertube.simounet.net","peertube.sjml.de","peertube.skbpunk.de","peertube.skorpil.cz","peertube.skydevs.me","peertube.slat.org","peertube.smertrios.com","peertube.socinfo.fr","peertube.socleo.org","peertube.solidev.net","peertube.spaceships.me","peertube.spv.sh","peertube.ssgmedia.net","peertube.stattzeitung.org","peertube.staudt.bayern","peertube.stream","peertube.sushi.ynh.fr","peertube.swarm.solvingmaz.es","peertube.swiecanski.eu","peertube.swrs.net","peertube.takeko.cyou","peertube.tallulah.fi","peertube.tangentfox.com","peertube.tata.casa","peertube.tech","peertube.techora.cat","peertube.teftera.com","peertube.terranout.mine.nu","peertube.teutronic-services.de","peertube.th3rdsergeevich.xyz","peertube.themcgovern.net","peertube.tiennot.net","peertube.ti-fr.com","peertube.timrowe.org","peertube.tmp.rcp.tf","peertube.tn","peertube.tnxip.de","peertube.touhoppai.moe","peertube.travelpandas.eu","peertube.treffler.cloud","peertube.troback.com","peertube.tspu.edu.ru","peertube.tspu.ru","peertube.turningheadsfilme.de","peertube.tv","peertube.tweb.tv","peertube-u1744.vm.elestio.app","peertube.ucy.de","peertube.un-ihe.org","peertube.unipi.it","peertube.universiteruraledescevennes.org","peertube.univ-montp3.fr","peertube.unixweb.net","peertube.uno","peertube-us.howlround.com","peertube.vanderb.net","peertube.vapronva.pw","peertube.varri.fi","peertubevdb.de","peertube.veen.world","peertube.vesdia.eu","peertube.vhack.eu","peertube.videoformes.com","peertube.videowolke.de","peertube.videum.eu","peertube.virtual-assembly.org","peertube.vit-bund.de","peertube.viviers-fibre.net","peertube.vladexa.xyz","peertube.vlaki.cz","peertube.waima.nu","peertube.waldstepperbu.de","peertube-wb4xz-u27447.vm.elestio.app","peertube.weiling.de","peertube.weindl.biz","peertube.we-keys.fr","peertube.wesensstern.net","peertube.winscloud.net","peertube.wirenboard.com","peertube.wivodaim.ch","peertube.woitschetzki.de","peertube.world","peertube.wtf","peertube.wtfayla.net","peertube.wuqiqi.space","peertube.xn--gribschi-o4a.ch","peertube.xrcb.cat","peertube.xwiki.com","peertube.ynerant.fr","peertube.yujiri.xyz","peertube.zalasur.media","peertube.zanoni.top","peertube.zergy.net","peertube.zmuuf.org","peertube.zveronline.ru","peertube.zwindler.fr","peervideo.ru","p.efg-ober-ramstadt.de","peopleandmedia.tv","periscope.numenaute.org","pete.warpnine.de","petitlutinartube.fr","pfideo.pfriedma.org","phijkchu.com","phoenixproject.group","phpc.tv","piped.chrisco.me","piraten.space","pire.artisanlogiciel.net","pirtube.calut.fr","piter.tube","p-js.efg-ober-ramstadt.de","planetube.live","platt.video","play.cotv.org.br","play.dfri.se","play.dotlan.net","player.ojamajo.moe","play.kontrabanda.net","play.kryta.app","play.mittdata.se","play-my.video","play.rejas.se","play.shirtless.gay","play.terminal9studios.com","playtube.su.gy","p.lu","p.ms.vg","pneumanode.com","p.nintendojo.fr","po0.online","poast.tv","podlibre.video","pointless.video","polis.video","pon.tv","pony.tube","portal.digilab.nfa.cz","praxis.su","praxis.tube","private.fedimovie.com","prozone.media","prtb.crispius.ca","prtb.fname.ca","prtb.komaniya.work","pt01.lehrerfortbildung-bw.de","pt8.dev.cyber4edu.org","pt.app.htlab.dev","pt.b0nfire.xyz","ptb.ndu.wtf","pt.bsuir.by","pt.condime.de","pt.erb.pw","pt.fourthievesvinegar.org","pt.freedomwolf.cc","pt.gogreenit.net","pt.gordons.gen.nz","pt.ilyamikcoder.com","pt.irnok.net","pt.lnklnx.com","pt.lunya.pet","pt.mezzo.moe","pt.minhinprom.ru","pt.na4.eu","pt.nest.norbipeti.eu","pt.netcraft.ch","pt.nijbakker.net","pt.oax.rhizomatica.org","pt.oops.wtf","pt.opensourceisawesome.com","ptp01.w-vwa.de","pt.pube.tk","pt.rikkalab.net","pt.rwx.ch","pt.sarahgebauer.com","pt.scrunkly.cat","pt.secnd.me","pt.teloschistes.ch","pt.thishorsie.rocks","ptube.rousset.nom.fr","ptube.sumiinix.moe","ptube-test.mephi.ru","pt.vern.cc","pt.xiupos.net","pt.xut.pl","pt.ywqr.icu","pt.z-y.win","publicvideo.nl","punktube.net","puppet.zone","puptube.rodeo","qtube.qlyoung.net","quantube.win","quebec1.freediverse.com","rankett.net","raptube.antipub.org","raveboy.messiah.cz","reallibertymedia.xyz","reels.llamachile.tube","refuznik.video","regarder.sans.pub","regardons.logaton.fr","replay.jres.org","resist.video","retvrn.tv","ritatube.ritacollege.be","robot.wales","rodacy.tv","rofl.im","rotortube.jancokock.me","rrgeorge.video","runeclaw.net","runtube.re","s1.vnchich.vip","sc07.tv","sc.goodprax.is","sdmtube.fr","secure.icn.press","see.ellipsenpark.de","seka.pona.la","sermons.luctorcrc.org","serv1.wiki-tube.de","serv2.wiki-tube.de","serv3.wiki-tube.de","sfba.video","share.tube","simify.tv","sizetube.com","skeptikon.fr","skeptube.fr","skiptube.redskip.sbs","sntissste.ddns.net","social.fedimovie.com","softlyspoken.taylormadetech.dev","solarsystem.video","sondheim.family","sovran.video","special.videovortex.tv","spectra.video","spook.tube","srv.messiah.cz","starlink.p2ptube.us","starsreel.com","st.fdel.moe","stl1988.peertube-host.de","stopwastingeverybodystime.de","store.tadreb.live","stream.andersonr.net","streamarchive.manicphase.me","stream.biovisata.lt","stream.brentnorris.net","stream.conesphere.cloud","stream.edmonson.kyschools.us","stream.elven.pw","stream.gigaohm.bio","stream.homelab.gabb.fr","stream.housatonic.live","stream.ilc.upd.edu.ph","stream.indieagora.com","stream.inparadise.se","stream.jurnalfm.md","stream.k-prod.fr","stream.litera.tools","stream.messerli.ch","stream.nuemedia.se","streamouille.fr","stream.rlp-media.de","streamsource.video","stream.ssyz.org.tr","streamtube.cloud","stream.udk-berlin.de","stream.uxd.uni-bamberg.de","stream.vrse.be","studio.lrnz.it","studios.racer159.com","stylite.live","styxhexenhammer666.com","subscribeto.me","sunutv-preprod.unchk.sn","suptube.cz","sv.jvideos.top","s.vnchich.com","s.vnchich.net","s.vnshow.vip","swannrack.tv","swebbtv.se","syrteplay.obspm.fr","systemofchips.net","tankie.tube","tarchivist.drjpdns.com","tbh.co-shaoghal.net","techlore.tv","telegenic.talesofmy.life","terakoya-backstage.com","teregarde.icu","test.staging.fedihost.co","testube.distrilab.fr","test.video.edu.nl","theater.ethernia.net","thecool.tube","thevoid.video","tiktube.com","tilvids.com","tinkerbetter.tube","tinsley.video","titannebula.com","toobnix.org","trailers.ddigest.com","trentontube.trentonhoshiko.com","tube.2hyze.de","tube.3xd.eu","tube4.apolut.net","tube.4e6a.ru","tube-action-educative.apps.education.fr","tube.adriansnetwork.org","tube.aetherial.xyz","tube.alado.space","tube.alff.xyz","tube.alphonso.fr","tube.andmc.ca","tube.anjara.eu","tube.anufrij.de","tube.apolut.app","tube.aquilenet.fr","tube.archworks.co","tube.area404.cloud","tube.ar.hn","tube.arthack.nz","tube-arts-lettres-sciences-humaines.apps.education.fr","tube.artvage.com","tube.asmu.ru","tube.asulia.fr","tube.auengun.net","tube.azbyka.ru","tube.balamb.fr","tube.baraans-corner.de","tube.bawü.social","tube.beit.hinrichs.cc","tube.bennetts.cc","tube.benzo.online","tube.bigpicture.watch","tube.bit-friends.de","tube.bitsnbytes.dev","tube.bitwaves.de","tube.blahaj.zone","tube.blueben.net","tube.bremen-social-sciences.de","tube.bsd.cafe","tube.bstly.de","tube.buchstoa-tv.at","tube.calculate.social","tube.cara.news","tube.cchgeu.ru","tube.chach.org","tube.chaoszone.tv","tube.chaun14.fr","tube.childrenshealthdefense.eu","tube.chispa.fr","tube.cms.garden","tube.communia.org","tube.contactsplus.live","tube.cosmicflow.space","tube.crapaud-fou.org","tube.croustifed.net","tube.cyano.at","tube.cybertopia.xyz","tube-cycle-2.apps.education.fr","tube-cycle-3.apps.education.fr","tube.darfweb.ynh.fr","tube.dddug.in","tube.deadtom.me","tube.dednet.co","tube.dembased.xyz","tube.destiny.boats","tube.dev.displ.eu","tube.devlabz.eu","tube.devwithzachary.com","tube.diagonale.org","tube.dianaband.info","tube.dirt.social","tube.distrilab.fr","tube.doctors4covidethics.org","tube.doortofreedom.org","tube.drimplausible.com","tube.dsocialize.net","tube.dt-miet.ru","tube.dubvee.org","tube.dubyatp.xyz","tubedu.org","tube.ebin.club","tube-education-physique-et-sportive.apps.education.fr","tube.edufor.me","tube.eggmoe.de","tube.e-jeremy.com","tube.elemac.fr","tube.emy.plus","tube.emy.world","tube.engagetv.com","tube-enseignement-professionnel.apps.education.fr","tube.erzbistum-hamburg.de","tube.extinctionrebellion.fr","tube.fantastic-rolls.fr","tube.fdn.fr","tube.fede.re","tube.fedisphere.net","tube.fediverse.at","tube.fediverse.games","tube.felinn.org","tube.fishpost.trade","tube.fjards.fr","tube.flokinet.is","tube.foi.hr","tube.forge.unibw.de","tube.foxarmy.org","tube.freeit247.eu","tubefree.org","tube.freiheit247.de","tube.friloux.me","tube.froth.zone","tube.fulda.social","tube.funfacts.de","tube.funil.de","tube.futuretic.fr","tube.g1sms.fr","tube.g4rf.net","tube.gaiac.io","tube.gayfr.online","tube.geekyboo.net","tube.genb.de","tube.gen-europe.org","tube.ggbox.fr","tube.ghk-academy.info","tube.giesing.space","tube.gi-it.de","tube.govital.net","tube.grap.coop","tube.graz.social","tube.grin.hu","tube.gryf-kujawy.pl","tube.gummientenmann.de","tube.hadan.social","tube.hamakor.org.il","tube.hamdorf.org","tube.helpsolve.org","tube.hoga.fr","tube.homecomputing.fr","tube.homelab.officebot.io","tube.hunter.camera","tube.hunterjozwiak.com","tube.hurel.me","tube.hu-social.de","tube.informatique.u-paris.fr","tube.infrarotmedien.de","tube.inlinestyle.it","tube-institutionnel.apps.education.fr","tube.int5.net","tube.interhacker.space","tube.interior.edu.uy","tube.io18.eu","tube.jeena.net","tube.jlserver.de","tube.jubru.fr","tube.juerge.nz","tube.kaiserflur.de","tube.kai-stuht.com","tube.kansanvalta.org","tube.kavocado.net","tube.kdy.ch","tube.keithsachs.com","tube.kenfm.de","tube.kersnikova.org","tube.kh-berlin.de","tube.kher.nl","tube.kicou.info","tube.kjernsmo.net","tube.kla.tv","tube.kockatoo.org","tube.kotocoop.org","tube.kotur.org","tube.koweb.fr","tube.krserv.de","tube.kx-home.su","tube.lab.nrw","tube.labus.life","tube.lacaveatonton.ovh","tube-langues-vivantes.apps.education.fr","tube.lastbg.com","tube.laurentclaude.fr","tube.laurent-malys.fr","tube.leetdreams.ch","tube.le-gurk.de","tube.leshley.ca","tube.linkse.media","tube.lins.me","tube.lokad.com","tube.loping.net","tube.lubakiagenda.net","tube.lucie-philou.com","tube.magaflix.fr","tube.marbleck.eu","tube.martins-almeida.com","tube-maternelle.apps.education.fr","tube.mathe.social","tube.matrix.rocks","tube.mc-thomas3.de","tube.mediainformationcenter.de","tube.me.jon-e.net","tube.mfraters.net","tube.mgppu.ru","tube.midov.pl","tube.midwaytrades.com","tube.miyaku.media","tube.moep.tv","tube.moncollege-valdoise.fr","tube.moongatas.com","tube.morozoff.pro","tube.mowetent.com","tube.n2.puczat.pl","tube.nestor.coop","tube.nevy.xyz","tube.nicfab.eu","tube.niel.me","tube.nieuwwestbrabant.nl","tube.nogafa.org","tube.nox-rhea.org","tube.nuages.cloud","tube-numerique-educatif.apps.education.fr","tube.numerique.gouv.fr","tube.nuxnik.com","tube.nx-pod.de","tube.objnull.net","tube.ofloo.io","tube.oisux.org","tube.onlinekirche.net","tube.opensocial.space","tube.opportunis.me","tube.org.il","tube.other.li","tube.otter.sh","tube.p2p.legal","tube.p3x.de","tube.pari.cafe","tube.parinux.org","tube.patrolbase.eu","tube.picasoft.net","tube.pifferi.io","tube.pilgerweg-21.de","tube.plaf.fr","tube.pmj.rocks","tube.pol.social","tube.polytech-reseau.org","tube.pompat.us","tube.ponsonaille.fr","tube.portes-imaginaire.org","tube.postblue.info","tube.pspodcasting.net","tube.public.apolut.net","tube.purser.it","tube.pustule.org","tube.raccoon.quest","tube.ramforth.net","tube.rdan.net","tube.rebellion.global","tube.reseau-canope.fr","tube.reszka.org","tube.revertron.com","tube.rfc1149.net","tube.rhythms-of-resistance.org","tube.risedsky.ovh","tube.rooty.fr","tube.rsi.cnr.it","tube.ryne.moe","tube.sadlads.com","tube.sador.me","tube.safegrow.eu","tube.saik0.com","tube.sanguinius.dev","tube.sasek.tv","tube.sbcloud.cc","tube.schule.social","tube-sciences-technologies.apps.education.fr","tube.sebastix.social","tube.sector1.fr","tube.sekretaerbaer.net","tube.shanti.cafe","tube.shela.nu","tube.sinux.pl","tube.sivic.me","tube.skrep.in","tube.sleeping.town","tube.sloth.network","tube.smithandtech.com","tube.social-pflege.de","tube.solidairesfinancespubliques.org","tube.solidcharity.net","tube.sp-codes.de","tube.spdns.org","tube.ssh.club","tube.statyvka.org.ua","tube.steffo.cloud","tubes.thefreesocial.com","tube.straub-nv.de","tube.surdeus.su","tube.swee.codes","tube.systemz.pl","tube.systerserver.net","tube.taker.fr","tube.taz.de","tube.tchncs.de","tube.t-dose.org","tube.techeasy.org","tube.techniverse.net","tube.teckids.org","tube.teqqy.social","tube-test.apps.education.fr","tube.thechangebook.org","tube.theliberatededge.org","tube.theplattform.net","tube.thierrytalbert.fr","tube.tilera.xyz","tube.tinfoil-hat.net","tube.tkzi.ru","tube.todon.eu","tube.transgirl.fr","tube.trax.im","tube.traydent.info","tube.trender.net.au","tube.ttk.is","tube.tuxfriend.fr","tube.tylerdavis.xyz","tube.ullihome.de","tube.uncomfortable.business","tube.undernet.uy","tube.unif.app","tube.utzer.de","tube.vencabot.com","tube.vikezor.click","tube.villejuif.fr","tube.virtuelle-ph.at","tube.vrpnet.org","tube.waag.org","tube.webcontact.de","tube.whytheyfight.com","tube.wody.kr","tube.woe2you.co.uk","tube.wolboom.nl","tube.wolfe.casa","tube.wtmo.cloud","tube.xd0.de","tube.xn--baw-joa.social","tube.xrtv.nl","tube.xy-space.de","tube.yahweasel.com","tube.yapbreak.fr","tube.ynm.hu","tube.yourdata.network","tube.zala-aero.com","tube.zendit.digital","tube.zenmaya.xyz","tubocatodico.bida.im","tubo.novababilonia.me","tubular.tube","tubulus.openlatin.org","tueb.telent.net","tutos-video.atd16.fr","tututu.tube","tuvideo.encanarias.info","tuvideo.txs.es","tv.adast.dk","tv.adn.life","tv.anarchy.bg","tv.animalcracker.art","tv.arns.lt","tv.atmx.ca","tv.cuates.net","tv.dilstories.com","tv.dyne.org","tv.farewellutopia.com","tv.filmfreedom.net","tv.fracturedpneuma.com","tv.gravitons.org","tv.hs3.pl","tv.kobold-cave.eu","tv.kreuder.me","tv.lumbung.space","tv.maechler.cloud","tv.manuelmaag.de","tvn7flix.fr","tv.navi.social","tv.nizika.tv","tvonline.wilamowice.pl","tvox.ru","tv.pirateradio.social","tv.pirati.cz","tv.raslavice.sk","tv.ruesche.de","tv.santic-zombie.ru","tv.s.hs3.pl","tv.solarpunk.land","tv.speleo.mooo.com","tv.suwerenni.org","tv.takios.de","tv.terrapreta.org.br","tv.undersco.re","tv.ursal.nl","tv.zonepl.net","twctube.twc-zone.eu","tweoo.com","tyrannosaurusgirl.com","tzr.txne.org","ufasofilmebi.net","uncast.net","urbanists.video","utube.ro","v0.trm.md","v1.smartit.nu","vamzdis.group.lt","varis.tv","v.basspistol.org","v.blustery.day","vdo.greboca.com","vdo.unvanquished.greboca.com","veedeo.org","veedeo.sncft.com.tn","veelvo.org","v.esd.cc","v.eurorede.com","vhs.absturztau.be","vhs.f4club.ru","vhsky.cz","vibeos.grampajoe.online","vid.amat.us","vid.chaoticmira.gay","vid.cthos.dev","vid.cult9.xyz","vid.digitaldragon.club","videa.inspirujici.cz","video01.imghost.club","video01.videohost.top","video02.imghost.club","video02.videohost.top","video03.imghost.club","video04.imghost.club","video05.imghost.club","video06.imghost.club","video.076.moe","video.076.ne.jp","video.1146.nohost.me","video.2bpencil.online","video2.echelon.pl","video2.icic.law","video2.jigmedatse.com","video.383.su","video.3cmr.fr","video.4d2.org","video.6p.social","video.9wd.eu","video.abraum.de","video.acra.cloud","video.adamwilbert.com","video.administrieren.net","video.admtz.fr","video.ados.accoord.fr","video.adullact.org","video.agileviet.vn","video.airikr.me","video.akk.moe","video.aldeapucela.org","video.alee14.me","video.alexdebosnia.eu","video.alicia.ne.jp","video.altertek.org","video.alton.cloud","video.amiga-ng.org","video.anaproy.nl","video.anartist.org","video.angrynerdspodcast.nl","video.anrichter.net","video.antopie.org","video.aokami.codelib.re","video.app.nexedi.net","video.apz.fi","videoarchive.wawax.info","video.arghacademy.org","video.aria.dog","video.arslansah.com.tr","video.asgardius.company","video.asonix.dog","video.asturias.red","video.atkin.engineer","video.audiovisuel-participatif.org","video.auridh.me","video.aus-der-not-darmstadt.org","video.baez.io","video.balfolk.social","video.barcelo.ynh.fr","video.bards.online","video.batuhan.basoglu.ca","video.beartrix.au","video.benedetta.com.br","video.benetou.fr","video.berocs.com","video.beyondwatts.social","video.bilecik.edu.tr","video.binarydigit.net","video.birkeundnymphe.de","video.bl.ag","video.blast-info.fr","video.blender.org","video.blinkyparts.com","video.blois.fr","video.blueline.mg","video.bmu.cloud","video.boxingpreacher.net","video.brothertec.eu","video.bsrueti.ch","video.calculate-linux.org","video.canadiancivil.com","video.canc.at","video.cartoon-aa.xyz","video.caruso.one","video.catgirl.biz","video.cats-home.net","video.causa-arcana.com","video-cave-v2.de","video.chadwaltercummings.me","video.chainagnostic.org","video.chalec.org","video.charlesbeadle.tech","video.chasmcity.net","video.chbmeyer.de","video.chipio.industries","video.chobycat.com","video.chomps.you","video.cigliola.com","video.citizen4.eu","video.cloud.idsub.de","video.cm-en-transition.fr","video.cnil.fr","video.cnnumerique.fr","video.cnr.it","video.coales.co","video.codefor.de","video.coffeebean.social","video.colibris-outilslibres.org","video.collectifpinceoreilles.com","video.colmaris.fr","video.comun.al","video.comune.trento.it","video.consultatron.com","video.coop","video.coop.tools","video.coqui.codes","video.coyp.us","video.cpn.so","video.crem.in","video.csc49.fr","video.cybersystems.engineer","video.cymais.cloud","video.d20.social","video.danielaragay.net","video.davduf.net","video.davejansen.com","video.davidsterry.com","video.dhamdomum.ynh.fr","video.diachron.net","video.digisprong.be","video.discountbucketwarehouse.com","video.dlearning.nl","video.dnfi.no","video.dogmantech.com","video.dokoma.com","video.dragoncat.org","video.drcassone.com","video.dresden.network","video.duskeld.dev","video.echelon.pl","video.echirolles.fr","video.edu.nl","video.eientei.org","video.elbacho.de","video.elfhosted.com","video.ellijaymakerspace.org","video.emergeheart.info","video.erikkemp.eu","videoer.link","video.espr.cloud","video.espr.moe","video.europalestine.com","video.exon.name","video.expiredpopsicle.com","video.extremelycorporate.ca","video.fabiomanganiello.com","video.fabriquedelatransition.fr","video.familie-will.at","video.fantastischepause.de","video.fassberg.app","video.fdlibre.eu","video.fedi.bzh","video.fedihost.co","video.feep.org","video.fhtagn.org","video.f-hub.org","video.firehawk-systems.com","video.firesidefedi.live","video.fiskur.ru","video.fj25.de","video.floor9.com","video.fnordkollektiv.de","video.folkdata.se","video.foofus.com","video.fosshq.org","video.fox-romka.ru","video.franzgraf.de","video.fraxoweb.com","video.fredix.xyz","video.freie-linke.de","video.french-take.pt","video.fuss.bz.it","video.g3l.org","video.gamerstavern.online","video.gangneux.net","video.geekonweb.fr","video.gemeinde-pflanzen.net","video.gem.org.ru","video.graceenid.com","video.graine-pdl.org","video.grandiras.net","video.grayarea.org","video.greenmycity.eu","video.grenat.art","video.gresille.org","video.gyt.is","video.habets.io","video.hacklab.fi","video.hainry.fr","video.hammons.llc","video.hardlimit.com","videohaven.com","video.heathenlab.net","video.holtwick.de","video.home.thomsen-jones.dk","video.hoou.de","video.icic.law","video.igem.org","video.immenhofkinder.social","video.index.ngo","video.infiniteloop.tv","video.infinito.nexus","video.infojournal.fr","video.infosec.exchange","video.innovationhub-act.org","video.internet-czas-dzialac.pl","video.interru.io","video.iphodase.fr","video.ipng.ch","video.irem.univ-paris-diderot.fr","video.ironsysadmin.com","video.it-service-commander.de","video.itsmy.social","video.jacen.moe","video.jadin.me","video.jeffmcbride.net","video.jigmedatse.com","video.k2pk.com","video.katehildenbrand.com","video.kayzoka.net","video.kinkyboyspodcast.com","video.kms.social","video.kompektiva.org","video.kopp-verlag.de","video.kuba-orlik.name","video.kyzune.com","video.lacalligramme.fr","video.lala.ovh","video.lamer-ethos.site","video.lanceurs-alerte.fr","video.landtag.ltsh.de","video.laotra.red","video.laraffinerie.re","video.latavernedejohnjohn.fr","video.latribunedelart.com","video.lavolte.net","video.legalloli.net","video.lemediatv.fr","video.lernado-base.ru","video.lern.link","video.lhed.fr","video.liberta.vip","video.libreti.net","video.linc.systems","video.linuxgame.dev","video.linux.it","video.linuxtrent.it","video.livecchi.cloud","video.liveitlive.show","video.lmika.org","video.logansimic.com","video.lolihouse.top","video.lono.space","video.lqdn.fr","video.lunago.net","video.lundi.am","video.lw1.at","video.lycee-experimental.org","video.lykledevries.nl","video.macver.org","video.maechler.cloud","video.magical.fish","video.magikh.fr","video.manje.net","video.manu.quebec","video.marcorennmaus.de","video.mariorojo.es","video.mateuaguilo.com","video.matomocamp.org","video.medienzentrum-harburg.de","video.melijn.me","video.mendoresist.org","videomensoif.ynh.fr","video.mentality.rip","video.metaccount.de","video.mgupp.ru","video.mikepj.dev","video.mikka.md","video.millironx.com","video.mobile-adenum.fr","video.mondoweiss.net","video.monsieurbidouille.fr","video.motoreitaliacarlonegri.it","video.mpei.ru","video.mshparisnord.fr","video.mttv.it","video.mugoreve.fr","video.mundodesconocido.com","video.mxsrv.de","video.mxtthxw.art","video.mycrowd.ca","video.na-prostem.si","video.ndqsphub.org","video.neliger.com","video.neondystopia.world","video.nesven.eu","video.netsyms.com","video.ngi.eu","video.niboe.info","video.nikau.io","video.nintendolesite.com","video.nluug.nl","video.nomadische-erzaehlkunst.de","video.notizlab.de","video.nstr.no","video.nuage-libre.fr","video.nuvon.io","video.nyc","video.ocs.nu","video.octofriends.garden","video.odenote.com","video.off-investigation.fr","video.oh14.de","video.olisti.co","video.olos311.org","video.olsberg.social","video.omada.cafe","video.omniatv.com","video.onjase.quebec","video.onlyfriends.cloud","video.opensourcesociety.net","video.openstudio.su","video.osgeo.org","video.ourcommon.cloud","video.outputarts.com","video.ozgurkon.org","video.pa3weg.nl","video.passageenseine.fr","video.patiosocial.es","video.pavel-english.ru","video.pcf.fr","video.pcgaldo.com","video.pcpal.nl","video.phyrone.de","video.pizza.enby.city","video.pizza.ynh.fr","video.ploss-ra.fr","video.ploud.fr","video.ploud.jp","video.podur.org","video.pop.coop","video.poul.org","video.procolix.eu","video.progressiv.dev","video.pronkiewicz.pl","video.publicspaces.net","video.pullopen.xyz","video.qlub.social","video.qoto.org","video.querdenken-711.de","video.quibcoding.fr","video.qutic.com","video.r3s.nrw","video.radiodar.ru","video.raft-network.one","video.randomsonicnet.org","video.rastapuls.com","video.reimu.info","video.rejas.se","video.resolutions.it","video.retroedge.tech","video.rhizome.org","video.rijnijssel.nl","video.riquy.dev","video.rlp-media.de","video.root66.net","video.rs-einrich.de","video.rubdos.be","videos.2mg.club","videos.80px.com","videos.aadtp.be","videos.aangat.lahat.computer","videos.aard.at","videos.abnormalbeings.space","videos.adhocmusic.com","video.sadmin.io","video.sadrarin.com","videosafehaven.com","videos.ahp-numerique.fr","videos.alamaisondulibre.org","videos.alexhyett.com","videos.ananace.dev","video.sanin.dev","videos.apprendre-delphi.fr","videos.ardmoreleader.com","videos.arretsurimages.net","videos.avency.de","videos.b4tech.org","videos.bik.opencloud.lu","video.sbo.systems","videos.brookslawson.com","videos.capas.se","videos.capitoledulibre.org","videos.cassidypunchmachine.com","videos.cemea.org","videos.chardonsbleus.org","videos.c.lhardy.eu","videos.cloudron.io","videos.codingotaku.com","videos.coletivos.org","videos.conferences-gesticulees.net","videos.courat.fr","videos.danksquad.org","videos.devteams.at","videos.domainepublic.net","videos.draculo.net","videos.dromeadhere.fr","video.secondwindtiming.com","video.selea.se","videos.elenarossini.com","videos.enisa.europa.eu","videos.erg.be","videos.espitallier.net","video.sethgoldstein.me","videos.evoludata.com","videos.explain-it.org","videos.fairetilt.co","videos.fb3i.fr","videos.figucarolina.org","videos.foilen.com","videos.foilen.net","videos.foundmediaarchive.com","videos.fozfuncs.com","videos.freeculturist.com","videos.fsci.in","videos.gaboule.com","videos.gamercast.net","videos.gamolf.fr","videos.gianmarco.gg","videos.globenet.org","videos.gnieh.org","videos.hack2g2.fr","videos.hardcoredevs.com","video.sharebright.net","videos.harrk.dev","videos.hauspie.fr","video.shig.de","videos.hilariouschaos.com","videos.homeserverhq.com","videos.icum.to","video.sidh.bzh","videos.idiocy.xyz","videos.ijug.eu","videos.ikacode.com","video.silex.me","videos.im.allmendenetz.de","video.simoneviaggiatore.com","video.simplex-software.ru","videos.indryve.org","videos.irrelevant.me.uk","videos.iut-orsay.fr","videos.jacksonchen666.com","videos.jevalide.ca","videos.joelavalos.me","videos.john-livingston.fr","videos.kaz.bzh","videos.koumoul.com","videos.kuoushi.com","videos.lacontrevoie.fr","videos.laguixeta.cat","videos.laliguepaysdelaloire.org","videos.lemouvementassociatif-pdl.org","videos.lescommuns.org","videos.leslionsfloorball.fr","videos.libervia.org","videos-libr.es","videos.librescrum.org","videos.livewyre.org","videos.lukazeljko.xyz","videos.luke.killarny.net","videos.lukesmith.xyz","videos.m14b.eu","videos.maitregeek.eu","videos.martyn.berlin","videos.metschkoll.de","videos.mgnosv.org","videos.miliukhin.xyz","videos.miolo.org","video.smokeyou.org","videos.monstro1.com","video.smspool.net","videos.mykdeen.com","videos.myourentemple.org","videos.nerdout.online","videos.netwaver.xyz","videos.noeontheend.com","videos.notnapoleon.net","videos.npo.city","video.snug.moe","videos.nunesdennis.me","videos.offroad.town","video.software-fuer-engagierte.de","videos.olfsoftware.fr","videos.ookami.space","videos.opensource-experts.com","video.sorokin.music","video.sotamedia.org","video.source.pub","videos.pair2jeux.tube","videos.parleur.net","videos-passages.huma-num.fr","videos.pcorp.us","videos.pepicrft.me","videos.phegan.live","videos.pixelpost.uk","videos.pkutalk.com","videos.poweron.dk","videos.projets-libres.org","videos.qwast-gis.com","videos.rampin.org","videos.realnephestate.xyz","videos.rights.ninja","videos.ritimo.org","videos.rossmanngroup.com","videos.scanlines.xyz","videos.shendrick.net","videos.shmalls.pw","videos.side-ways.net","videos.solomon.tech","videos.spacebar.ca","videos.spacefun.ch","videos.spla.cat","videos.squat.net","videos.stackgui.de","videos.stadtfabrikanten.org","videos.sujets-libres.fr","videos.supertuxkart.net","videos.sutcliffe.xyz","video.staging.blender.org","video.starysacz.um.gov.pl","videos.tcit.fr","videos.tcjc.uk","videos.tena.dnshome.de","videos.testimonia.org","video.stevesworld.co","videos.tfcconnection.org","videos.thegreenwizard.win","videos.thinkerview.com","videos.tiffanysostar.com","videos.toromedia.com","video.strathspey.org","videos.triceraprog.fr","videos.triplebit.net","videos.trom.tf","videos.trucs-de-developpeur-web.fr","videos.tuist.dev","videos.tuist.io","videos.tusnio.me","video.stuve-bamberg.de","video.stwst.at","videos.ubuntu-paris.org","video.sudden.ninja","video.sueneeuniverse.cz","videos.upr.fr","video.surillya.com","videos.utsukta.org","videos.v4rg.io","videos.veen.world","videos.viorsan.com","videos.weaponisedautism.com","videos.webcoaches.net","videos.wikilibriste.fr","videos.wirtube.de","video.swits.org","videos.yesil.club","videos.yeswiki.net","video.systems.cogsys.wiai.uni-bamberg.de","video.taboulisme.com","video.taskcards.eu","video.team-lcbs.eu","videoteca.ibict.br","videoteca.kenobit.it","video.tedomum.net","video.telemillevaches.net","video.teqqy.de","video.thepolarbear.co.uk","videotheque.uness.fr","video.thinkof.name","video.thistleandmoss.org","video.thoshis.net","video.tkz.es","video.toby3d.me","video.transcoded.fr","video.treuzel.de","video.triplea.fr","video.troed.se","video.tryptophonic.com","video.tsundere.love","videotube.duckdns.org","video.turbo-kermis.fr","videotvlive.nemethstarproductions.eu","video.twitoot.com","video.typesafe.org","video.typica.us","video.up.edu.ph","video.uriopss-pdl.fr","video.ut0pia.org","video.uweb.ch","video.vaku.org.ua","video.valme.io","video.veen.world","video.veloma.org","video.veraciousnetwork.com","video.vide.li","video.violoncello.ch","video.voiceover.bar","videovortex.tv","video.wakkeren.nl","video.windfluechter.org","videowisent.maw.best","video.worteks.com","video.writeas.org","video.wszystkoconajwazniejsze.pl","video.xaetacore.net","video.xmpp-it.net","video.xorp.hu","video.zeitgewinn.ai","video.zeroplex.tw","video.ziez.eu","video.zlinux.ru","video.zonawarpa.it","vid.fbxl.net","vid.femboyfurry.net","vid.fossdle.org","vid.freedif.org","vidhub.cyou","vid.involo.ch","viditube.site","vid.jittr.click","vid.kinuseka.us","vid.lake.codes","vid.mattedwards.org","vid.mawuki.de","vid.meow.boutique","vid.mkp.ca","vid.nocogabriel.fr","vid.norbipeti.eu","vid.northbound.online","vid.nsf-home.ip-dynamic.org","vid.ohboii.de","vid.plantplotting.co.uk","vid.pretok.tv","vid.prometheus.systems","vid.ryg.one","vid.samtripoli.com","vid.shadowkat.net","vids.krserv.social","vids.mariusdavid.fr","vid.sofita.noho.st","vids.roshless.me","vids.stary.pc.pl","vids.tahomavideo.com","vids.tekdmn.me","vids.thewarrens.name","vids.ttlmakerspace.com","vid.suqu.be","vids.witchcraft.systems","vid.tstoll.me","vid.twhtv.club","vid.wildeboer.net","vid.y-y.li","vidz.antifa.club","vidz.dou.bet","vid.zeroes.ca","vidz.julien.ovh","views.southfox.me","vigilante.tv","virtual-girls-are.definitely-for.me","viste.pt","vizyon.kaubuntu.re","v.j4.lc","v.kisombrella.top","v.kretschmann.social","v.kyaru.xyz","vlad.tube","v.lor.sh","vm02408.procolix.com","v.mbius.io","v.mkp.ca","vnchich.com","vn.jvideos.top","vn.zohup.net","v.ocsf.in","vod.newellijay.tv","vods.198x.eu","vods.juni.tube","vods.moonbunny.cafe","volk.love","voluntarytube.com","v.pizda.world","v.rakow.pl","vstation.hsu.edu.hk","vt.marco-ml.com","v.toot.io","vtr.chikichiki.tube","vulgarisation-informatique.fr","vuna.no","vv.rdgx.fr","wacha.punks.cc","wahrheitsministerium.xyz","walleyewalloping.fedihost.io","walsh.fallcounty.omg.lol","watch.bojidar-bg.dev","watch.caeses.com","watch.easya.solutions","watch.eeg.cl.cam.ac.uk","watch.goodluckgabe.life","watch.heehaw.space","watch.jimmydore.com","watch.leonardaisfunny.com","watch.littleshyfim.com","watch.makearmy.io","watch.nuked.social","watch.ocaml.org","watch.oroykhon.ru","watch.otherwise.one","watch.revolutionize.social","watch.rvtownsquare.com","watch.softinio.com","watch.tacticaltech.org","watch.thelema.social","watch.therisingeagle.info","watch.vinbrun.com","watch.weanimatethings.com","weare.dcnh.tv","webtv.vandoeuvre.net","we.haydn.rocks","westergaard.video","widemus.de","wideo.fedika.pl","wirtube.de","wiwi.video","woodland.video","worctube.com","wtfayla.com","wur.pm","www.aishaalrasheedmosque.tv","www.earthclimate.tv","www.elltube.gr","www.jvideos.top","www.komitid.tv","www.kotikoff.net","www.makertube.net","www.mypeer.tube","www.nadajemy.com","www.neptube.io","www.novatube.net","www.piratentube.de","www.pony.tube","www.teutronic-services.de","www.vidbel.com","www.videos-libr.es","www.vnchich.in","www.vnchich.lat","www.vnchich.lol","www.vnchich.top","www.vnchich.vip","www.vnshow.net","www.wiki-tube.de","www.wtfayla.com","www.yiny.org","www.zappiens.br","www.zohup.in","www.zohup.link","x1.vnchich.in","xn--fsein-zqa5f.xn--nead-na-bhfinleog-hpb.ie","x-tv.ru","x.vnchich.in","x.vnchich.vip","xxivproduction.video","x.zohup.top","x.zohup.vip","yawawi.com","yellowpages.video","youslots.tv","youtube.n-set.ru","youtube.trollers.es","ysm.info","yt.lostpod.space","yt.orokoro.ru","ytube.retronerd.at","yuitobe.wikiwiki.li","yunopeertube.myddns.me","zappiens.br","zeitgewinn-peertube.tfrfia.easypanel.host","zensky-pj.com","zentube.org","zohup.net"];
// END AUTOGENERATED INSTANCES
