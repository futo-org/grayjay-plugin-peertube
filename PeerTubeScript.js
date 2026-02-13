const PLATFORM = "PeerTube";

let config = {};
let _settings = {};

let state = {
	serverVersion: '',
	isSearchEngineSepiaSearch: false,
	isHomeContentSepiaSearch: false
}

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

// Query parameter to flag private/unlisted playlists that require authentication
// This is added by getUserPlaylists and checked by getPlaylist
const PRIVATE_PLAYLIST_QUERY_PARAM = '&requiresAuth=1';

// instances are populated during deploy appended to the end of this javascript file
// this update process is done at update-instances.sh
let INDEX_INSTANCES = {
	instances: []
};

let SEARCH_ENGINE_OPTIONS = [];
let HOME_CONTENT_SOURCE_OPTIONS = [];

Type.Feed.Playlists = "PLAYLISTS";

source.enable = function (conf, settings, saveStateStr) {
	config = conf ?? {};
	_settings = settings ?? {};

	SEARCH_ENGINE_OPTIONS = loadOptionsForSetting('searchEngineIndex');
	HOME_CONTENT_SOURCE_OPTIONS = loadOptionsForSetting('homeContentSourceIndex');
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

	// Always recalculate these flags based on current settings
	state.isSearchEngineSepiaSearch = SEARCH_ENGINE_OPTIONS[parseInt(_settings.searchEngineIndex)] == 'Sepia Search'
	state.isHomeContentSepiaSearch = HOME_CONTENT_SOURCE_OPTIONS[parseInt(_settings.homeContentSourceIndex)] == 'Sepia Search'

	if (!didSaveState) {
		const [currentInstanceConfig] = http.batch()
			.GET(`${plugin.config.constants.baseUrl}/api/v1/config`, {})
			.execute();

		if (currentInstanceConfig.isOk) {
			const serverConfig = JSON.parse(currentInstanceConfig.body);
			state.serverVersion = serverConfig.serverVersion;
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

	// Determine source host and parameters based on home content source setting
	let sourceHost = '';
	let path = '';
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



	if (state.isHomeContentSepiaSearch) {
		// Use Sepia Search for home content
		sourceHost = 'https://sepiasearch.org';
		path = '/api/v1/search/videos';
		params.resultType = 'videos';

		// Apply category filtering for Sepia Search
		if (categoryIds.length > 0) {
			params.categoryOneOf = categoryIds;
		}

		// Apply language filtering for Sepia Search
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

		params.sort = sepiaSearchSortMap[sort] || 'match';
	} else {
		// Use current instance for home content
		sourceHost = plugin.config.constants.baseUrl;
		path = '/api/v1/videos';

		// Apply category filtering for current instance
		if (categoryIds.length > 0) {
			params.categoryOneOf = categoryIds;
		}

		// Apply language filtering for current instance
		if (languageCodes.length > 0) {
			params.languageOneOf = languageCodes;
		}
	}

	// The getVideoPager will handle API errors if the sort option is not supported
	return getVideoPager(path, params, 0, sourceHost, state.isHomeContentSepiaSearch);
};

source.searchSuggestions = function (query) {
	return [];
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
			} else if (scopeFilter === "local" && !state.isSearchEngineSepiaSearch) {
				params.searchTarget = "local";
			}
			// "federated" means federated (default), so no parameter needed
		}
	}

	let sourceHost = '';

	if (state.isSearchEngineSepiaSearch) {
		params.resultType = 'videos';
		params.sort = '-createdAt'
		sourceHost = 'https://sepiasearch.org'
	} else {
		sourceHost = plugin.config.constants.baseUrl;
	}

	const isSearch = true;

	return getVideoPager('/api/v1/search/videos', params, 0, sourceHost, isSearch);
};
source.searchChannels = function (query) {

	let sourceHost = '';

	if (state.isSearchEngineSepiaSearch) {
		sourceHost = 'https://sepiasearch.org'
	} else {
		sourceHost = plugin.config.constants.baseUrl;
	}

	const isSearch = true;

	return getChannelPager('/api/v1/search/video-channels', {
		search: query
	}, 0, sourceHost, isSearch);
};

source.searchPlaylists = function (query) {
	// Determine the search host based on settings
	let sourceHost = state.isSearchEngineSepiaSearch 
		? 'https://sepiasearch.org' 
		: plugin.config.constants.baseUrl;
	
	const params = {
		search: query
	};
	
	// For Sepia Search, add specific parameters
	if (state.isSearchEngineSepiaSearch) {
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
		const obj = httpGET({ url: urlWithParams, parseResponse: true });

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
	const initialRequestUrl = `${endpointUrl}${buildQuery(initialParams)}`;
	
	try {
		var initialResponseBody = httpGET({ url: initialRequestUrl, useAuthenticated: true, parseResponse: true });
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
		const batchRequest = http.batch();
		for (let pageIndex = 1; pageIndex <= remainingPages; pageIndex++) {
			const pageParams = { start: pageIndex * itemsPerPage, count: itemsPerPage };
			batchRequest.GET(`${endpointUrl}${buildQuery(pageParams)}`, {}, true);
		}
		const batchResponses = batchRequest.execute();
		
		batchResponses.forEach(batchResponse => {
			if (batchResponse.isOk && batchResponse.code === 200) {
				const batchResponseBody = JSON.parse(batchResponse.body);
				if (batchResponseBody.data) {
					batchResponseBody.data.forEach(subscription => {
						if (subscription.url) subscriptionUrls.push(subscription.url);
					});
				}
			}
		});
	} else {
		for (let pageIndex = 1; pageIndex <= remainingPages; pageIndex++) {
			const pageParams = { start: pageIndex * itemsPerPage, count: itemsPerPage };
			try {
				const pageResponseBody = httpGET({ url: `${endpointUrl}${buildQuery(pageParams)}`, useAuthenticated: true, parseResponse: true });
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
	try {
		var meData = httpGET({ url: `${plugin.config.constants.baseUrl}/api/v1/users/me`, useAuthenticated: true, parseResponse: true });
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

	try {
		var initialResponseBody = httpGET({ url: `${endpointUrl}${buildQuery({ ...baseParams, start: 0, count: itemsPerPage })}`, useAuthenticated: true, parseResponse: true });
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
		const batch = http.batch();
		for (let i = 1; i <= remainingPages; i++) {
			batch.GET(`${endpointUrl}${buildQuery({ ...baseParams, start: i * itemsPerPage, count: itemsPerPage })}`, {}, true);
		}
		batch.execute().forEach(r => {
			if (r.isOk && r.code === 200) {
				const data = JSON.parse(r.body).data;
				if (data) {
					data.forEach(p => {
						const url = buildPlaylistUrl(p);
						if (url) playlistUrls.push(url);
					});
				}
			}
		});
	} else {
		for (let i = 1; i <= remainingPages; i++) {
			try {
				const data = httpGET({ url: `${endpointUrl}${buildQuery({ ...baseParams, start: i * itemsPerPage, count: itemsPerPage })}`, useAuthenticated: true, parseResponse: true }).data;
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
	
	try {
		// Only use auth for private playlists from the base instance
		var playlist = httpGET({ url: urlWithParams, useAuthenticated: requiresAuth, parseResponse: true });
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

source.getContentDetails = function (url) {
	const videoId = extractVideoId(url);
	if (!videoId) {
		return null;
	}

	const sourceBaseUrl = getBaseUrl(url);
	
	// Create a batch request for both video details and captions
	const [videoDetails, captionsData, chaptersData] = http.batch()
		.GET(`${sourceBaseUrl}/api/v1/videos/${videoId}`, {})
		.GET(`${sourceBaseUrl}/api/v1/videos/${videoId}/captions`, {})
		.GET(`${sourceBaseUrl}/api/v1/videos/${videoId}/chapters`, {})
		.execute();
	
	if (!videoDetails.isOk) {
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
		description: obj.description,
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
			const videoData = httpGET({ url: `${sourceHost}/api/v1/videos/${videoId}`, parseResponse: true });
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
		const resp = httpGET(`${sourceBaseUrl}/api/v1/videos/${videoId}/chapters`);
		const obj = httpGET({ url: `${sourceBaseUrl}/api/v1/videos/${videoId}`, parseResponse: true });
		return extractChapters(resp, obj?.duration);
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
		const obj = httpGET({ url: apiUrl, parseResponse: true });
		
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
        const videoData = httpGET({ url: `${sourceBaseUrl}/api/v1/videos/${videoId}`, parseResponse: true });
        
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

		http.POST(url, JSON.stringify(body), {
			"Content-Type": "application/json"
		}, false);
	}
}

class PeerTubeVideoPager extends VideoPager {
	constructor(results, hasMore, path, params, page, sourceHost, isSearch, cbMap, useAuth) {
		super(results, hasMore, { path, params, page, sourceHost, isSearch, cbMap, useAuth });
	}

	nextPage() {
		return getVideoPager(this.context.path, this.context.params, (this.context.page ?? 0) + 1, this.context.sourceHost, this.context.isSearch, this.context.cbMap, this.context.useAuth);
	}
}

class PeerTubeChannelPager extends ChannelPager {
	constructor(results, hasMore, path, params, page) {
		super(results, hasMore, { path, params, page });
	}

	nextPage() {
		return getChannelPager(this.context.path, this.context.params, (this.context.page ?? 0) + 1);
	}
}

class PeerTubeCommentPager extends CommentPager {
	constructor(results, hasMore, videoId, params, page, sourceBaseUrl) {
		super(results, hasMore, { videoId, params, page, sourceBaseUrl });
	}

	nextPage() {
		return getCommentPager(this.context.videoId, this.context.params, (this.context.page ?? 0) + 1, this.context.sourceBaseUrl);
	}
}

class PeerTubePlaylistPager extends PlaylistPager {
	constructor(results, hasMore, path, params, page, sourceHost, isSearch) {
		super(results, hasMore, { path, params, page, sourceHost, isSearch });
	}

	nextPage() {
		return getPlaylistPager(this.context.path, this.context.params, (this.context.page ?? 0) + 1, this.context.sourceHost, this.context.isSearch);
	}
}

class PeerTubeHistoryVideoPager extends VideoPager {
	constructor(results, hasMore, path, params, page) {
		super(results, hasMore, { path, params, page });
	}

	nextPage() {
		return getHistoryVideoPager(this.context.path, this.context.params, (this.context.page ?? 0) + 1);
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
 * Gets the requested url and returns the response body either as a string or as a parsed json object
 * @param {Object|string} optionsOrUrl - The options object or URL string
 * @param {string} optionsOrUrl.url - The URL to call (when using object)
 * @param {boolean} [optionsOrUrl.useAuthenticated=false] - If true, will use authenticated headers (only for base instance URLs)
 * @param {boolean} [optionsOrUrl.parseResponse=false] - If true, will parse the response as json and check for errors
 * @param {Object} [optionsOrUrl.headers=null] - Custom headers to use for the request
 * @returns {Object} the response object or the parsed json object
 * @throws {ScriptException}
 */
function httpGET(optionsOrUrl) {
	// Check if parameter is a string URL
	let options;
	if (typeof optionsOrUrl === 'string') {
		if (!isValidUrl(optionsOrUrl)) {
			throw new ScriptException("Invalid URL provided: " + optionsOrUrl);
		}
		options = { url: optionsOrUrl };
	} else if (typeof optionsOrUrl === 'object' && optionsOrUrl !== null) {
		options = optionsOrUrl;
	} else {
		throw new ScriptException("httpGET requires either a URL string or options object");
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

	// Only use authentication for requests to the base instance
	const shouldAuthenticate = useAuthenticated && isBaseInstanceUrl(url);
	const localHeaders = headers ?? state.defaultHeaders;

	const resp = http.GET(
		url,
		localHeaders,
		shouldAuthenticate
	);

	if (!resp.isOk) {
		throw new ScriptException("Request [" + url + "] failed with code [" + resp.code + "]");
	}

	if (parseResponse) {
		const json = JSON.parse(resp.body);
		if (json.errors) {
			throw new ScriptException(json.errors[0].message);
		}
		return json;
	}

	return resp;
}

/**
 * Build a query
 * @param {{[key: string]: any}} params Query params
 * @returns {String} Query string
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

	return (query && query.length > 0) ? `?${query}` : "";
}

function getChannelPager(path, params, page, sourceHost = plugin.config.constants.baseUrl, isSearch = false) {

	const count = 20;
	const start = (page ?? 0) * count;
	params = { ...params, start, count }

	const url = `${sourceHost}${path}`;
	const urlWithParams = `${url}${buildQuery(params)}`;

	try {
		var obj = httpGET({ url: urlWithParams, parseResponse: true });
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

	}), obj.total > (start + count), path, params, page);
}

function getVideoPager(path, params, page, sourceHost = plugin.config.constants.baseUrl, isSearch = false, cbMap, useAuth = false) {

	const count = 20;
	const start = (page ?? 0) * count;
	params = { ...params, start, count };

	// Apply NSFW filtering based on policy and no explicit nsfw parameter is set
	if (!params.hasOwnProperty('nsfw')) {
		const nsfwPolicy = getNSFWPolicy();
		if (nsfwPolicy === "do_not_list") {
			params.nsfw = 'false';
		} else {
			// For "blur" and "display" policies, set nsfw=both to allow all content
			params.nsfw = 'both';
		}
	}

	const url = `${sourceHost}${path}`;

	const urlWithParams = `${url}${buildQuery(params)}`;

	try {
		var obj = httpGET({ url: urlWithParams, useAuthenticated: useAuth, parseResponse: true });
	} catch (e) {
		log("Failed to get videos", e);
		return new VideoPager([], false);
	}

	const hasMore = obj.total > (start + count);

	// check if cbMap is a function
	if (typeof cbMap === 'function') {
		obj.data = obj.data.map(cbMap);
	}

	const contentResultList = obj.data
	.filter(Boolean)//playlists may contain null values for private videos
	.map(v => {

		const baseUrl = [
			v.url,
			v.embedUrl,
			v.previewUrl,
			v?.thumbnailUrl,
			v?.account?.url,
			v?.channel?.url
		].filter(Boolean).map(getBaseUrl).find(Boolean);

		//Some older instance versions such as 3.0.0, may not contain the url property
		// Add URL hints using utility functions
		const contentUrl = addContentUrlHint(v.url || `${baseUrl}/videos/watch/${v.uuid}`);
		const instanceBaseUrl = isSearch ? baseUrl : sourceHost;
		const channelUrl = addChannelUrlHint(v.channel.url);

		// Handle NSFW content based on policy
		const nsfwPolicy = getNSFWPolicy();
		const isNSFW = v.nsfw === true;
		let thumbnails;

		if (isNSFW && nsfwPolicy === "blur") {
			// Create empty thumbnail for NSFW content
			thumbnails = new Thumbnails([]);
		} else {
			// Normal thumbnail
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

	return new PeerTubeVideoPager(contentResultList, hasMore, path, params, page, sourceHost, isSearch, cbMap, useAuth);
}

function getCommentPager(videoId, params, page, sourceBaseUrl = plugin.config.constants.baseUrl) {

	const count = 20;
	const start = (page ?? 0) * count;
	params = { ...params, start, count }

	// Build API URL internally
	const apiPath = `/api/v1/videos/${videoId}/comment-threads`;
	const apiUrl = `${sourceBaseUrl}${apiPath}`;
	const urlWithParams = `${apiUrl}${buildQuery(params)}`;
	
	// Build video URL internally
	const videoUrl = addContentUrlHint(`${sourceBaseUrl}/videos/watch/${videoId}`);
	
	try {
		var obj = httpGET({ url: urlWithParams, parseResponse: true });
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
	const count = 20;
	const start = (page ?? 0) * count;
	params = { ...params, start, count };

	const url = `${sourceHost}${path}`;
	const urlWithParams = `${url}${buildQuery(params)}`;
	
	try {
		var obj = httpGET({ url: urlWithParams, parseResponse: true });
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

function getHistoryVideoPager(path, params, page) {
	const count = 100;
	const start = (page ?? 0) * count;
	params = { ...params, start, count };

	const url = `${plugin.config.constants.baseUrl}${path}`;
	const urlWithParams = `${url}${buildQuery(params)}`;

	try {
		var obj = httpGET({ url: urlWithParams, useAuthenticated: true, parseResponse: true });
	} catch (e) {
		log("Failed to get user history", e);
		return new VideoPager([], false);
	}

	const results = obj.data.map(video => {
		const sourceHost = plugin.config.constants.baseUrl;
		
		const baseUrl = [
			video?.url,
			video?.account?.url,
			video?.channel?.url
		].filter(Boolean).map(getBaseUrl).find(Boolean) || sourceHost;

		const contentUrl = addContentUrlHint(video.url || `${baseUrl}/videos/watch/${video.uuid}`);
		const channelUrl = addChannelUrlHint(video.channel.url);
		
		const nsfwPolicy = getNSFWPolicy();
		const isNSFW = video.nsfw === true;
		let thumbnails;

		if (isNSFW && nsfwPolicy === "blur") {
			thumbnails = new Thumbnails([]);
		} else {
			thumbnails = new Thumbnails([new Thumbnail(`${baseUrl}${video.thumbnailPath}`, 0)]);
		}

		const platformVideo = new PlatformVideo({
			id: new PlatformID(PLATFORM, video.uuid, config.id),
			name: video.name ?? "",
			thumbnails: thumbnails,
			author: new PlatformAuthorLink(
				new PlatformID(PLATFORM, video.channel.name, config.id),
				video.channel.displayName,
				channelUrl,
				getAvatarUrl(video, baseUrl)
			),
			datetime: Math.round((new Date(video.publishedAt)).getTime() / 1000),
			duration: video.duration,
			viewCount: video.isLive ? (video.viewers ?? video.views) : video.views,
			url: contentUrl,
			isLive: video.isLive
		});
		
		
		if (video.userHistory && video.userHistory.currentTime) {
			platformVideo.playbackTime = video.userHistory.currentTime;
		}

		return platformVideo;
	});

	return new PeerTubeHistoryVideoPager(results, obj.total > (start + count), path, params, page);
}

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


function loadOptionsForSetting(settingKey, transformCallback) {
	transformCallback ??= (o) => o;
	const setting = config?.settings?.find((s) => s.variable == settingKey);
	return setting?.options?.map(transformCallback) ?? [];
}


function createAudioSource(file, duration) {
	return new AudioUrlSource({
		name: file.resolution.label,
		url: file.fileUrl ?? file.fileDownloadUrl,
		duration: duration,
		container: "audio/mp3",
		codec: "aac"
	});
}

// Create video source based on file and resolution
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

function getMediaDescriptor(obj) {

	let inputFileSources = [];

	const hlsOutputSources = [];

	const muxedVideoOutputSources = [];
	const unMuxedVideoOnlyOutputSources = [];
	const unMuxedAudioOnlyOutputSources = [];

	for (const playlist of (obj?.streamingPlaylists ?? [])) {

		hlsOutputSources.push(new HLSSource({
			name: "HLS",
			url: playlist.playlistUrl,
			duration: obj.duration ?? 0,
			priority: true
		}));

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


// Helper function to create a tag playlist from a tag search URL
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

// Helper function to map category indices to IDs
function getCategoryId(categoryIndex) {
	// Convert index to category ID
	// Index 0 = "" (no category), Index 1 = "1" (Music), Index 2 = "2" (Films), etc.

	const index = parseInt(categoryIndex);

	if (index >= 1 && index <= 18) {
		return index.toString();
	}
	return null;
}

// Helper function to map language indices to language codes
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
 * Helper function to get the NSFW policy from settings
 * @returns {string} The NSFW policy: "do_not_list", "blur", or "display"
 */
function getNSFWPolicy() {
	const policyIndex = parseInt(_settings.nsfwPolicy) || 0;
	const policies = ["do_not_list", "blur", "display"];
	return policies[policyIndex] || "do_not_list";
}

// Those instances were requested by users
// Those hostnames are exclusively used to help the plugin know if a hostname is a PeerTube instance
// Grayjay nor futo are associated, does not endorse or are responsible for the content in those instances.
INDEX_INSTANCES.instances = [
	...INDEX_INSTANCES.instances,'poast.tv','videos.upr.fr','peertube.red'
]

// BEGIN AUTOGENERATED INSTANCES
// This content is autogenerated during deployment using update-instances.sh
// Sources: https://instances.joinpeertube.org, https://api.fediverse.observer/, and https://api.fedidb.org/
// Those hostnames are exclusively used to help the plugin know if a hostname is a PeerTube instance
// Grayjay nor futo are associated, does not endorse or are responsible for the content in those instances.
// Last updated at: 2025-10-16
INDEX_INSTANCES.instances = ["0ch.tv","22x22.ru","2tonwaffle.tv","810video.com","ace-deec.inspe-bretagne.fr","aipi.video","all.electric.kitchen","alterscope.fr","anarchy.tube","andyrush.fedihost.io","angeltales.angellive.ru","annex.fedimovie.com","apathy.tv","aperi.tube","apertatube.net","apollo.lanofthedead.xyz","archive.hitness.club","archive.nocopyrightintended.tv","archive.reclaim.tv","arkm.tv","arson.video","artitube.artifaille.fr","asantube.stream","astrotube-ufe.obspm.fr","astrotube.obspm.fr","audio.freediverse.com","av.giplt.nl","avantwhatever.xyz","avone.me","ballhaus.media","bark.video","battlepenguin.video","bava.tv","beardedtek.net","beartrix-peertube-u29672.vm.elestio.app","bedheadbernie.net","bee-tube.fr","bengo.tube","beta.flimmerstunde.xyz","betamax.donotsta.re","bewegte-bilder.berlin","biblion.refchat.net","biblioteca.theowlclub.net","bideoak.argia.eus","bideoak.zeorri.eus","bideoteka.eus","bitcointv.com","bitforged.stream","bitube.ict-battenberg.ch","blurt.media","bodycam.leapjuice.com","bolha.tube","bonn.video","breeze.tube","bridport.tv","brioco.live","brocosoup.fr","c-tube.c-base.org","canal.bizarro.cc","canal.facil.services","canard.tube","canti.kmeuh.fr","caseyandbros.walker.id","cast.garden","ccutube.ccu.edu.tw","cdn01.tilvids.com","cdn7.dns04.com","cfnumerique.tv","channel.t25b.com","christian.freediverse.com","christube.malyon.co.uk","christuncensored.com","christunscripted.com","cine.nashe.be","classe.iro.umontreal.ca","clip.place","clipet.tv","clips.crcmz.me","cloudtube.ise.fraunhofer.de","commons.tube","communitymedia.video","conf.tube","content.haacksnetworking.org","content.wissen-ist-relevant.com","cookievideo.com","crank.recoil.org","crimecamz.com","csictv.csic.es","csptube.au","cubetube.tv","cuddly.tube","cumraci.tv","dalek.zone","dalliance.network","dangly.parts","darkvapor.nohost.me","davbot.media","ddi-video.cs.uni-paderborn.de","den.wtf","dev-my.sohobcom.ye","dev.itvplus.iiens.net","devwithzachary.com","digitalcourage.video","diler.tube","diode.zone","dioxitube.com","displayeurope.video","djtv.es","dob.media.fibodo.com","docker.videos.lecygnenoir.info","dreamspace.video","dreiecksnebel.alex-detsch.de","drovn.ninja","dud-video.inf.tu-dresden.de","dud175.inf.tu-dresden.de","dytube.com","earthclimate.tv","earthshiptv.nl","ebildungslabor.video","eburg.tube","edflix.nl","eggflix.foolbazar.eu","eleison.eu","env-0499245.wc.reclaim.cloud","epsilon.pw","evangelisch.video","evuo.online","exatas.tv","exo.tube","exode.me","expeer.eduge.ch","exquisite.tube","faf.watch","fair.tube","falkmx.ddns.net","fedi.video","fedimovie.com","feditubo.yt","fediverse.tv","fightforinfo.com","film.fjerland.no","film.k-prod.fr","film.node9.org","firehawks.htown.de","flappingcrane.com","flim.txmn.tk","flipboard.video","flooftube.net","fontube.fr","foss.video","fotogramas.politicaconciencia.org","foubtube.com","framatube.org","freediverse.com","freedomtv.pro","freesoto.tv","friprogramvarusyndikatet.tv","fstube.net","gabtoken.noho.st","gade.o-k-i.net","gallaghertube.com","garr.tv","gas.tube.sh","gbemkomla.jesuits-africa.education","gegenstimme.tv","gnulinux.tube","go3.site","goetterfunkentv.peertube-host.de","goldcountry.tube","goredb.com","greatview.video","grypstube.uni-greifswald.de","gultsch.video","haeckflix.org","handcuffedgirls.me","helisexual.live","hitchtube.fr","hosers.isurf.ca","hpstube.fr","humanreevolution.com","hyperreal.tube","ibbwstream.schule-bw.de","ibiala.nohost.me","icanteven.watch","indymotion.fr","infothema.net","inspeer.eduge.ch","intelligentia.tv","intratube-u25541.vm.elestio.app","irrsinn.video","itvplus.iiens.net","jetstream.watch","jnuk-peertube-u52747.vm.elestio.app","jnuk.media","johnydeep.net","joovideo.cfd","k-pop.22x22.ru","kadras.live","kamtube.ru","kanal-ri.click","karakun-peertube-codecamp.k8s.karakun.com","kiddotube.com","kilero.interior.edu.uy","killedinit.mooo.com","kino.kompot.si","kino.schuerz.at","kinowolnosc.pl","kirche.peertube-host.de","kiwi.froggirl.club","kodcast.com","kolektiva.media","koreus.tv","kpop.22x22.ru","kviz.leemoon.network","kyiv.tube","lakupatukka.tunk.org","lastbreach.tv","leffler.video","lenteratv.umt.edu.my","librepoop.de","lightchannel.tv","linhtran.eu","linux.tail065cae.ts.net","literatube.com","live.codinglab.ch","live.dcnh.cloud","live.libratoi.org","live.nanao.moe","live.oldskool.fi","live.solari.com","live.zawiya.one","lone.earth","lostpod.space","lounges.monster","lucarne.balsamine.be","luxtube.lu","lv.s-zensky.com","lyononline.dev","m.bbbdn.jp","makertube.net","matte.fedihost.io","mcast.mvideo.ru","media.apc.org","media.assassinate-you.net","media.caladona.org","media.chch.it","media.cooleysekula.net","media.curious.bio","media.exo.cat","media.fermalo.fr","media.fsfe.org","media.gadfly.ai","media.geekwisdom.org","media.gzevd.de","media.inno3.eu","media.interior.edu.uy","media.krashboyz.org","media.mwit.ac.th","media.mzhd.de","media.nolog.cz","media.notfunk.radio","media.opendigital.info","media.over-world.org","media.pelin.top","media.privacyinternational.org","media.repeat.is","media.selector.su","media.smz-ma.de","media.undeadnetwork.de","media.vzst.nl","media.zat.im","medias.debrouillonet.org","medias.pingbase.net","mediathek.fs1.tv","mediathek.ra-micro.de","mediathek.rzgierskopp.de","megatube.lilomoino.fr","megaultra.us","merci-la-police.fr","meshtube.net","mevideo.host","meyon.com.ye","micanal.encanarias.info","michaelheath.tv","mirror.peertube.metalbanana.net","mirtube.ru","misnina.tv","mix.video","mla.moe","monitor.grossermensch.eu","mooosetube.mooose.org","mootube.fans","mosk.tube","mountaintown.video","movie.nael-brun.com","mplayer.demouliere.eu","music.facb69.tec.br","mv.vannilla.org","my-sunshine.video","mystic.video","mytube.bijralph.com","mytube.cooltux.net","mytube.kn-cloud.de","mytube.madzel.de","mytube.malenfant.net","mytube.pyramix.ca","nadajemy.com","nanawel-peertube.dyndns.org","nastub.cz","neat.tube","nekopunktube.fr","neon.cybre.stream","neshweb.tv","nethack.tv","nicecrew.tv","nightshift.minnix.dev","nolog.media","notretube.asselma.eu","nuobodu.space","nvsk.tube","nya.show","nyltube.nylarea.com","ocfedtest.hosted.spacebear.ee","offenes.tv","ohayo.rally.guide","oldtube.aetherial.xyz","on24.at","onair.sbs","ontvkorea.com","openmedia.edunova.it","opsis.kyanos.one","outcast.am","ovaltube.codinglab.ch","owotube.ru","p.eertu.be","p.efg-ober-ramstadt.de","p.lu","p.ms.vg","p.nintendojo.fr","p2b.drjpdns.com","pace.rip","pantube.ovh","partners.eqtube.org","pastafriday.club","pbvideo.ru","peer.acidfog.com","peer.azurs.fr","peer.i6p.ru","peer.madiator.cloud","peer.philoxweb.be","peer.pvddhhnk.nl","peer.raise-uav.com","peer.taibsu.net","peer.theaterzentrum.at","peer.tube","peerate.fr","peertube-ardlead-u29325.vm.elestio.app","peertube-beeldverhalen-u36587.vm.elestio.app","peertube-demo.lern.link","peertube-docker.cpy.re","peertube-ecogather-u20874.vm.elestio.app","peertube-eu.howlround.com","peertube-ext.sovcombank.ru","peertube-ktgou-u11537.vm.elestio.app","peertube-us.howlround.com","peertube-wb4xz-u27447.vm.elestio.app","peertube.0011.lt","peertube.020.pl","peertube.123.in.th","peertube.1312.media","peertube.1984.cz","peertube.2i2l.net","peertube.2tonwaffle.com","peertube.30p87.de","peertube.42lausanne.ch","peertube.42paris.fr","peertube.adresse.data.gouv.fr","peertube.aegrel.ee","peertube.aldinet.duckdns.org","peertube.alpharius.io","peertube.am-networks.fr","peertube.amicale.net","peertube.anasodon.com","peertube.anduin.net","peertube.anija.mooo.com","peertube.anon-kenkai.com","peertube.anti-logic.com","peertube.anzui.dev","peertube.apcraft.jp","peertube.apse-asso.fr","peertube.arch-linux.cz","peertube.arnhome.ovh","peertube.art3mis.de","peertube.artica.center","peertube.askan.info","peertube.asp.krakow.pl","peertube.astral0pitek.synology.me","peertube.astrolabe.coop","peertube.atilla.org","peertube.atsuchan.page","peertube.aukfood.net","peertube.automat.click","peertube.axiom-paca.g1.lu","peertube.b38.rural-it.org","peertube.baptistentiel.nl","peertube.be","peertube.becycle.com","peertube.beeldengeluid.nl","peertube.behostings.net","peertube.bekucera.uk","peertube.bgeneric.net","peertube.bgzashtita.es","peertube.bilange.ca","peertube.bildung-ekhn.de","peertube.bingo-ev.de","peertube.blablalinux.be","peertube.boc47.org","peertube.boger.dev","peertube.boomjacky.art","peertube.br0.fr","peertube.brian70.tw","peertube.bridaahost.ynh.fr","peertube.brigadadigital.tec.br","peertube.bubbletea.dev","peertube.bubuit.net","peertube.bunseed.org","peertube.busana.lu","peertube.cainet.info","peertube.casasnow.noho.st","peertube.casually.cat","peertube.cevn.io","peertube.ch","peertube.chartilacorp.ru","peertube.chaunchy.com","peertube.chir.rs","peertube.chn.moe","peertube.chnops.info","peertube.christianpacaud.com","peertube.chrskly.net","peertube.chuggybumba.com","peertube.cif.su","peertube.cipherbliss.com","peertube.circlewithadot.net","peertube.cirkau.art","peertube.cloud.nerdraum.de","peertube.cloud.sans.pub","peertube.cloud68.co","peertube.cluster.wtf","peertube.co.uk","peertube.cobolworx.com","peertube.cocamserverguild.com","peertube.coderbunker.ca","peertube.communecter.org","peertube.cpy.re","peertube.craftum.pl","peertube.cratonsed.ge","peertube.crazy-to-bike.de","peertube.csparker.co.uk","peertube.ctseuro.com","peertube.cuatrolibertades.org","peertube.cube4fun.net","peertube.cyber-tribal.com","peertube.daemonlord.freeddns.org","peertube.dair-institute.org","peertube.darkness.services","peertube.datagueule.tv","peertube.dc.pini.fr","peertube.dcldesign.co.uk","peertube.debian.social","peertube.delfinpe.de","peertube.delta0189.xyz","peertube.demonix.fr","peertube.designersethiques.org","peertube.desmu.fr","peertube.devol.it","peertube.diem25.ynh.fr","peertube.diplopode.net","peertube.dixvaha.com","peertube.dk","peertube.doesstuff.social","peertube.doronichi.com","peertube.downes.ca","peertube.dsdrive.fr","peertube.dsmouse.net","peertube.dtth.ch","peertube.dubwise.dk","peertube.duckarmada.moe","peertube.dynlinux.io","peertube.easter.fr","peertube.eb8.org","peertube.ecologie.bzh","peertube.ecsodikas.eu","peertube.education-forum.com","peertube.ekosystems.fr","peertube.elforcer.ru","peertube.elobot.ch","peertube.eqver.se","peertube.ethibox.fr","peertube.eticadigital.eu","peertube.eu.org","peertube.european-pirates.eu","peertube.eus","peertube.euskarabildua.eus","peertube.existiert.ch","peertube.f-si.org","peertube.familie-berner.de","peertube.familleboisteau.fr","peertube.fedi-multi-verse.eu","peertube.fedi.zutto.fi","peertube.fedihost.website","peertube.fedihub.online","peertube.fediversity.eu","peertube.fenarinarsa.com","peertube.festnoz.de","peertube.fifthdread.com","peertube.flauschbereich.de","peertube.florentcurk.com","peertube.fomin.site","peertube.forteza.fr","peertube.fototjansterkalmar.com","peertube.foxfam.club","peertube.fr","peertube.funkfeuer.at","peertube.futo.org","peertube.g2od.ch","peertube.gaialabs.ch","peertube.gargantia.fr","peertube.geekgalaxy.fr","peertube.gegeweb.eu","peertube.gemlog.ca","peertube.genma.fr","peertube.get-racing.de","peertube.ghis94.ovh","peertube.gidikroon.eu","peertube.giftedmc.com","peertube.giz.berlin","peertube.graafschapcollege.nl","peertube.gravitywell.xyz","peertube.grosist.fr","peertube.gsugambit.com","peertube.guillaumeleguen.xyz","peertube.guiofamily.fr","peertube.gyatt.cc","peertube.gymnasium-ditzingen.de","peertube.gyptazy.com","peertube.h-u.social","peertube.habets.house","peertube.hackerfoo.com","peertube.hameln.social","peertube.havesexwith.men","peertube.headcrashing.eu","peertube.heise.de","peertube.helvetet.eu","peertube.henrywithu.com","peertube.heraut.eu","peertube.histoirescrepues.fr","peertube.hizkia.eu","peertube.hlpnet.dk","peertube.home.x0r.fr","peertube.hosnet.fr","peertube.hyperfreedom.org","peertube.ichigo.everydayimshuflin.com","peertube.ignifi.me","peertube.ii.md","peertube.imaag.de","peertube.in.ua","peertube.init-c.de","peertube.inparadise.se","peertube.interhop.org","peertube.intrapology.com","peertube.iriseden.eu","peertube.it","peertube.it-arts.net","peertube.iz5wga.radio","peertube.jackbot.fr","peertube.jarmvl.net","peertube.jimmy-b.se","peertube.jmsquared.net","peertube.joby.lol","peertube.june.ie","peertube.jussak.net","peertube.kaaosunlimited.fi","peertube.kaleidos.net","peertube.kalua.im","peertube.kameha.click","peertube.katholisch.social","peertube.kawateam.fr","peertube.keazilla.net","peertube.kerenon.com","peertube.kevinperelman.com","peertube.klaewyss.fr","peertube.kleph.eu","peertube.kobel.fyi","peertube.kompektiva.org","peertube.koolenboer.synology.me","peertube.kriom.net","peertube.kuenet.ch","peertube.kx.studio","peertube.kyriog.eu","peertube.la-famille-muller.fr","peertube.laas.fr","peertube.lab.how","peertube.labeuropereunion.eu","peertube.lagbag.com","peertube.lagob.fr","peertube.lagvoid.com","peertube.lagy.org","peertube.lanterne-rouge.info","peertube.laveinal.cat","peertube.le-cem.com","peertube.lesparasites.net","peertube.lhc.lu","peertube.lhc.net.br","peertube.li","peertube.libresolutions.network","peertube.libretic.fr","peertube.linagora.com","peertube.linsurgee.fr","peertube.linuxrocks.online","peertube.livingutopia.org","peertube.local.tilera.xyz","peertube.logilab.fr","peertube.louisematic.site","peertube.luanti.ru","peertube.luckow.org","peertube.luga.at","peertube.lyceeconnecte.fr","peertube.lyclpg.itereva.pf","peertube.lykle.stellarhosted.com","peertube.m2.nz","peertube.magicstone.dev","peertube.makotoworkshop.org","peertube.manalejandro.com","peertube.marcelsite.com","peertube.marienschule.de","peertube.martiabernathey.com","peertube.marud.fr","peertube.mdg-hamburg.de","peertube.meditationsteps.org","peertube.mesnumeriques.fr","peertube.metalbanana.net","peertube.metalphoenix.synology.me","peertube.mgtow.pl","peertube.miguelcr.me","peertube.mikemestnik.net","peertube.minetestserver.ru","peertube.miniwue.de","peertube.mldchan.dev","peertube.modspil.dk","peertube.monicz.dev","peertube.monlycee.net","peertube.moulon.inrae.fr","peertube.mpu.edu.mo","peertube.musicstudio.pro","peertube.muxika.org","peertube.mygaia.org","peertube.myhn.fr","peertube.nadeko.net","peertube.nashitut.ru","peertube.nayya.org","peertube.nazlo.space","peertube.nekosunevr.co.uk","peertube.netzbegruenung.de","peertube.nicolastissot.fr","peertube.nighty.name","peertube.nissesdomain.org","peertube.no","peertube.nodja.com","peertube.nogafam.fr","peertube.noiz.co.za","peertube.nomagic.uk","peertube.normalgamingcommunity.cz","peertube.northernvoice.app","peertube.novettam.dev","peertube.nthpyro.dev","peertube.nuage-libre.fr","peertube.offerman.com","peertube.officebot.io","peertube.ohioskates.com","peertube.on6zq.be","peertube.opencloud.lu","peertube.openrightsgroup.org","peertube.openstreetmap.fr","peertube.orderi.co","peertube.org.uk","peertube.otakufarms.com","peertube.pablopernot.fr","peertube.paladyn.org","peertube.parenti.net","peertube.paring.moe","peertube.pcservice46.fr","peertube.physfluids.fr","peertube.pix-n-chill.fr","peertube.pixnbits.de","peertube.plataformess.org","peertube.plaureano.nohost.me","peertube.pnpde.social","peertube.podverse.fm","peertube.pogmom.me","peertube.pp.ua","peertube.protagio.org","peertube.prozak.org","peertube.public.cat","peertube.puzyryov.ru","peertube.pve1.cluster.weinrich.dev","peertube.qontinuum.space","peertube.qtg.fr","peertube.r2.enst.fr","peertube.r5c3.fr","peertube.ra.no","peertube.radres.xyz","peertube.rainbowswingers.net","peertube.redgate.tv","peertube.redpill-insight.com","peertube.researchinstitute.at","peertube.revelin.fr","peertube.rezel.net","peertube.rezo-rm.fr","peertube.rhoving.com","peertube.rlp.schule","peertube.roflcopter.fr","peertube.rokugan.fr","peertube.rougevertbleu.tv","peertube.roundpond.net","peertube.rse43.com","peertube.rural-it.org","peertube.s2s.video","peertube.sarg.dev","peertube.satoshishop.de","peertube.sbbz-luise.de","peertube.scapior.dev","peertube.scd31.com","peertube.sct.pf","peertube.se","peertube.sebastienvigneau.xyz","peertube.securelab.eu","peertube.securitymadein.lu","peertube.seitendan.com","peertube.semperpax.com","peertube.semweb.pro","peertube.sensin.eu","peertube.server.we-cloud.de","peertube.seti-hub.org","peertube.shadowfr69.eu","peertube.shilohnewark.org","peertube.shultz.ynh.fr","peertube.sieprawski.pl","peertube.simounet.net","peertube.sjml.de","peertube.skorpil.cz","peertube.skydevs.me","peertube.slat.org","peertube.smertrios.com","peertube.socleo.org","peertube.solidev.net","peertube.spaceships.me","peertube.ssgmedia.net","peertube.stattzeitung.org","peertube.staudt.bayern","peertube.stream","peertube.swarm.solvingmaz.es","peertube.swiecanski.eu","peertube.swrs.net","peertube.takeko.cyou","peertube.tangentfox.com","peertube.teftera.com","peertube.terranout.mine.nu","peertube.teutronic-services.de","peertube.th3rdsergeevich.xyz","peertube.themcgovern.net","peertube.ti-fr.com","peertube.tiennot.net","peertube.timrowe.org","peertube.tmp.rcp.tf","peertube.tn","peertube.touhoppai.moe","peertube.travelpandas.eu","peertube.treffler.cloud","peertube.troback.com","peertube.tspu.edu.ru","peertube.tspu.ru","peertube.tv","peertube.tweb.tv","peertube.ucy.de","peertube.unipi.it","peertube.univ-montp3.fr","peertube.universiteruraledescevennes.org","peertube.unixweb.net","peertube.uno","peertube.vanderb.net","peertube.vapronva.pw","peertube.veen.world","peertube.vesdia.eu","peertube.vhack.eu","peertube.videoformes.com","peertube.videum.eu","peertube.virtual-assembly.org","peertube.vit-bund.de","peertube.viviers-fibre.net","peertube.vlaki.cz","peertube.waima.nu","peertube.waldstepperbu.de","peertube.we-keys.fr","peertube.weiling.de","peertube.winscloud.net","peertube.wirenboard.com","peertube.wivodaim.ch","peertube.woitschetzki.de","peertube.wtf","peertube.wtfayla.net","peertube.wuqiqi.space","peertube.xn--gribschi-o4a.ch","peertube.xrcb.cat","peertube.xwiki.com","peertube.yujiri.xyz","peertube.zalasur.media","peertube.zanoni.top","peertube.zergy.net","peertube.zmuuf.org","peertube.zveronline.ru","peertube.zwindler.fr","peertube2.assomption.bzh","peertube2.cpy.re","peertube3.cpy.re","peertube33.ethibox.fr","peertube400.pocketnet.app","peertube6.f-si.org","peertube601.pocketnet.app","peertubecz.duckdns.org","peertubevdb.de","peervideo.ru","periscope.numenaute.org","pete.warpnine.de","petitlutinartube.fr","pfideo.pfriedma.org","phijkchu.com","phoenixproject.group","piped.chrisco.me","piraten.space","pire.artisanlogiciel.net","pirtube.calut.fr","piter.tube","planetube.live","platt.video","play-my.video","play.cotv.org.br","play.dfri.se","play.dotlan.net","play.kontrabanda.net","play.kryta.app","play.mittdata.se","play.rejas.se","play.shirtless.gay","play.terminal9studios.com","player.ojamajo.moe","po0.online","poast.tv","podlibre.video","pointless.video","pon.tv","pony.tube","portal.digilab.nfa.cz","praxis.su","praxis.tube","private.fedimovie.com","prtb.crispius.ca","prtb.komaniya.work","pt.b0nfire.xyz","pt.bsuir.by","pt.condime.de","pt.erb.pw","pt.fourthievesvinegar.org","pt.freedomwolf.cc","pt.gogreenit.net","pt.gordons.gen.nz","pt.ilyamikcoder.com","pt.irnok.net","pt.lnklnx.com","pt.lunya.pet","pt.mezzo.moe","pt.minhinprom.ru","pt.na4.eu","pt.nest.norbipeti.eu","pt.netcraft.ch","pt.nijbakker.net","pt.oops.wtf","pt.pube.tk","pt.rikkalab.net","pt.rwx.ch","pt.sarahgebauer.com","pt.scrunkly.cat","pt.secnd.me","pt.teloschistes.ch","pt.thishorsie.rocks","pt.vern.cc","pt.xut.pl","pt.ywqr.icu","pt.z-y.win","pt01.lehrerfortbildung-bw.de","ptp01.w-vwa.de","ptube-test.mephi.ru","ptube.rousset.nom.fr","publicvideo.nl","punktube.net","puppet.zone","puptube.rodeo","qtube.qlyoung.net","quantube.win","quebec1.freediverse.com","rankett.net","raptube.antipub.org","reallibertymedia.xyz","reels.llamachile.tube","refuznik.video","regarder.sans.pub","regardons.logaton.fr","replay.jres.org","resist.video","retvrn.tv","ritatube.ritacollege.be","rofl.im","rotortube.jancokock.me","rrgeorge.video","runeclaw.net","s.vnchich.net","s1.vnchich.vip","sc.goodprax.is","sc07.tv","sdmtube.fr","see.ellipsenpark.de","seka.pona.la","sermons.luctorcrc.org","serv1.wiki-tube.de","serv2.wiki-tube.de","serv3.wiki-tube.de","sfba.video","share.tube","simify.tv","sizetube.com","skeptikon.fr","skeptube.fr","sntissste.ddns.net","social.fedimovie.com","softlyspoken.taylormadetech.dev","solarsystem.video","sovran.video","special.videovortex.tv","spectra.video","spook.tube","srv.messiah.cz","st.fdel.moe","starsreel.com","stl1988.peertube-host.de","store.tadreb.live","stream.andersonr.net","stream.biovisata.lt","stream.brentnorris.net","stream.conesphere.cloud","stream.edmonson.kyschools.us","stream.elven.pw","stream.gigaohm.bio","stream.homelab.gabb.fr","stream.ilc.upd.edu.ph","stream.indieagora.com","stream.jurnalfm.md","stream.k-prod.fr","stream.litera.tools","stream.messerli.ch","stream.nuemedia.se","stream.rlp-media.de","stream.ssyz.org.tr","stream.udk-berlin.de","stream.vrse.be","streamarchive.manicphase.me","streamouille.fr","streamsource.video","studio.lrnz.it","studios.racer159.com","stylite.live","styxhexenhammer666.com","subscribeto.me","sunutv-preprod.unchk.sn","suptube.cz","sv.jvideos.top","swannrack.tv","syrteplay.obspm.fr","systemofchips.net","tankie.tube","tarchivist.drjpdns.com","tbh.co-shaoghal.net","techlore.tv","telegenic.talesofmy.life","teregarde.icu","test.staging.fedihost.co","test.video.edu.nl","testube.distrilab.fr","theater.ethernia.net","thecool.tube","thevoid.video","tiktube.com","tilvids.com","tinkerbetter.tube","tinsley.video","titannebula.com","toobnix.org","trailers.ddigest.com","trentontube.trentonhoshiko.com","tube-action-educative.apps.education.fr","tube-arts-lettres-sciences-humaines.apps.education.fr","tube-cycle-2.apps.education.fr","tube-cycle-3.apps.education.fr","tube-education-physique-et-sportive.apps.education.fr","tube-enseignement-professionnel.apps.education.fr","tube-institutionnel.apps.education.fr","tube-langues-vivantes.apps.education.fr","tube-maternelle.apps.education.fr","tube-numerique-educatif.apps.education.fr","tube-sciences-technologies.apps.education.fr","tube-test.apps.education.fr","tube.2hyze.de","tube.3xd.eu","tube.4e6a.ru","tube.adriansnetwork.org","tube.aetherial.xyz","tube.alado.space","tube.alff.xyz","tube.alphonso.fr","tube.anjara.eu","tube.anufrij.de","tube.apolut.app","tube.aquilenet.fr","tube.ar.hn","tube.archworks.co","tube.area404.cloud","tube.arthack.nz","tube.artvage.com","tube.asmu.ru","tube.asulia.fr","tube.auengun.net","tube.azbyka.ru","tube.balamb.fr","tube.baraans-corner.de","tube.bawü.social","tube.beit.hinrichs.cc","tube.benzo.online","tube.bigpicture.watch","tube.bit-friends.de","tube.bitwaves.de","tube.blahaj.zone","tube.blueben.net","tube.bremen-social-sciences.de","tube.bsd.cafe","tube.bstly.de","tube.buchstoa-tv.at","tube.calculate.social","tube.cara.news","tube.cchgeu.ru","tube.chach.org","tube.chaoszone.tv","tube.chaun14.fr","tube.childrenshealthdefense.eu","tube.chispa.fr","tube.cms.garden","tube.communia.org","tube.contactsplus.live","tube.crapaud-fou.org","tube.croustifed.net","tube.cyano.at","tube.cybertopia.xyz","tube.dddug.in","tube.deadtom.me","tube.dembased.xyz","tube.destiny.boats","tube.dev.displ.eu","tube.dianaband.info","tube.dirt.social","tube.distrilab.fr","tube.doctors4covidethics.org","tube.doortofreedom.org","tube.drimplausible.com","tube.dsocialize.net","tube.dt-miet.ru","tube.dubyatp.xyz","tube.ebin.club","tube.edufor.me","tube.eggmoe.de","tube.elemac.fr","tube.emy.plus","tube.emy.world","tube.erzbistum-hamburg.de","tube.extinctionrebellion.fr","tube.fdn.fr","tube.fede.re","tube.fedisphere.net","tube.fediverse.at","tube.fediverse.games","tube.felinn.org","tube.fishpost.trade","tube.flokinet.is","tube.foi.hr","tube.foxarmy.org","tube.freeit247.eu","tube.freiheit247.de","tube.friloux.me","tube.froth.zone","tube.fulda.social","tube.funil.de","tube.futuretic.fr","tube.g1sms.fr","tube.g4rf.net","tube.gaiac.io","tube.gayfr.online","tube.geekyboo.net","tube.gen-europe.org","tube.genb.de","tube.ggbox.fr","tube.ghk-academy.info","tube.gi-it.de","tube.giesing.space","tube.govital.net","tube.grap.coop","tube.graz.social","tube.grin.hu","tube.gummientenmann.de","tube.hadan.social","tube.hamakor.org.il","tube.hamdorf.org","tube.helpsolve.org","tube.hoga.fr","tube.homecomputing.fr","tube.homelab.officebot.io","tube.hunterjozwiak.com","tube.informatique.u-paris.fr","tube.infrarotmedien.de","tube.inlinestyle.it","tube.int5.net","tube.interhacker.space","tube.io18.eu","tube.jeena.net","tube.jlserver.de","tube.jubru.fr","tube.juerge.nz","tube.kansanvalta.org","tube.kavocado.net","tube.kdy.ch","tube.kenfm.de","tube.kersnikova.org","tube.kh-berlin.de","tube.kher.nl","tube.kicou.info","tube.kjernsmo.net","tube.kla.tv","tube.kockatoo.org","tube.kotocoop.org","tube.kotur.org","tube.koweb.fr","tube.krserv.de","tube.kx-home.su","tube.lab.nrw","tube.lacaveatonton.ovh","tube.lastbg.com","tube.laurent-malys.fr","tube.laurentclaude.fr","tube.le-gurk.de","tube.leetdreams.ch","tube.linkse.media","tube.lins.me","tube.lokad.com","tube.loping.net","tube.lubakiagenda.net","tube.lucie-philou.com","tube.magaflix.fr","tube.marbleck.eu","tube.matrix.rocks","tube.me.jon-e.net","tube.mfraters.net","tube.mgppu.ru","tube.midov.pl","tube.midwaytrades.com","tube.moep.tv","tube.moncollege-valdoise.fr","tube.morozoff.pro","tube.mowetent.com","tube.n2.puczat.pl","tube.nestor.coop","tube.nevy.xyz","tube.nicfab.eu","tube.niel.me","tube.nieuwwestbrabant.nl","tube.nogafa.org","tube.nox-rhea.org","tube.numerique.gouv.fr","tube.nuxnik.com","tube.nx-pod.de","tube.objnull.net","tube.ofloo.io","tube.oisux.org","tube.onlinekirche.net","tube.opportunis.me","tube.org.il","tube.other.li","tube.otter.sh","tube.p2p.legal","tube.p3x.de","tube.pari.cafe","tube.parinux.org","tube.picasoft.net","tube.pifferi.io","tube.pilgerweg-21.de","tube.plaf.fr","tube.pmj.rocks","tube.pol.social","tube.polytech-reseau.org","tube.pompat.us","tube.ponsonaille.fr","tube.portes-imaginaire.org","tube.postblue.info","tube.public.apolut.net","tube.purser.it","tube.pustule.org","tube.raccoon.quest","tube.rdan.net","tube.rebellion.global","tube.reseau-canope.fr","tube.reszka.org","tube.revertron.com","tube.rfc1149.net","tube.rhythms-of-resistance.org","tube.risedsky.ovh","tube.rooty.fr","tube.rsi.cnr.it","tube.ryne.moe","tube.sadlads.com","tube.sador.me","tube.saik0.com","tube.sanguinius.dev","tube.sasek.tv","tube.sbcloud.cc","tube.schule.social","tube.sebastix.social","tube.sector1.fr","tube.sekretaerbaer.net","tube.shanti.cafe","tube.shela.nu","tube.sinux.pl","tube.sivic.me","tube.skrep.in","tube.sleeping.town","tube.sloth.network","tube.solidairesfinancespubliques.org","tube.solidcharity.net","tube.sp-codes.de","tube.spdns.org","tube.ssh.club","tube.statyvka.org.ua","tube.straub-nv.de","tube.surdeus.su","tube.swee.codes","tube.systemz.pl","tube.systerserver.net","tube.taker.fr","tube.taz.de","tube.tchncs.de","tube.techeasy.org","tube.teckids.org","tube.teqqy.social","tube.thechangebook.org","tube.theliberatededge.org","tube.theplattform.net","tube.tilera.xyz","tube.tinfoil-hat.net","tube.tkzi.ru","tube.todon.eu","tube.transgirl.fr","tube.trax.im","tube.trender.net.au","tube.ttk.is","tube.tuxfriend.fr","tube.tylerdavis.xyz","tube.uncomfortable.business","tube.undernet.uy","tube.unif.app","tube.utzer.de","tube.vencabot.com","tube.virtuelle-ph.at","tube.vrpnet.org","tube.waag.org","tube.whytheyfight.com","tube.wody.kr","tube.woe2you.co.uk","tube.wolfe.casa","tube.xd0.de","tube.xn--baw-joa.social","tube.xrtv.nl","tube.xy-space.de","tube.yapbreak.fr","tube.ynm.hu","tube.zendit.digital","tube4.apolut.net","tubedu.org","tubefree.org","tubes.thefreesocial.com","tubo.novababilonia.me","tubocatodico.bida.im","tubular.tube","tubulus.openlatin.org","tueb.telent.net","tutos-video.atd16.fr","tututu.tube","tuvideo.encanarias.info","tuvideo.txs.es","tv.adast.dk","tv.adn.life","tv.anarchy.bg","tv.animalcracker.art","tv.arns.lt","tv.atmx.ca","tv.cuates.net","tv.dilstories.com","tv.dyne.org","tv.farewellutopia.com","tv.filmfreedom.net","tv.gravitons.org","tv.kobold-cave.eu","tv.kreuder.me","tv.lumbung.space","tv.maechler.cloud","tv.manuelmaag.de","tv.nizika.tv","tv.pirateradio.social","tv.pirati.cz","tv.raslavice.sk","tv.ruesche.de","tv.s.hs3.pl","tv.santic-zombie.ru","tv.solarpunk.land","tv.speleo.mooo.com","tv.suwerenni.org","tv.terrapreta.org.br","tv.undersco.re","tv.zonepl.net","tvn7flix.fr","tvonline.wilamowice.pl","tvox.ru","twctube.twc-zone.eu","tweoo.com","tyrannosaurusgirl.com","uncast.net","urbanists.video","utube.ro","v.basspistol.org","v.blustery.day","v.esd.cc","v.eurorede.com","v.j4.lc","v.kisombrella.top","v.kretschmann.social","v.kyaru.xyz","v.lor.sh","v.mbius.io","v.mkp.ca","v.ocsf.in","v.pizda.world","v.toot.io","v0.trm.md","v1.smartit.nu","vamzdis.group.lt","varis.tv","vdo.greboca.com","vdo.unvanquished.greboca.com","veedeo.org","vhs.absturztau.be","vhs.f4club.ru","vhsky.cz","vibeos.grampajoe.online","vid.amat.us","vid.chaoticmira.gay","vid.cthos.dev","vid.digitaldragon.club","vid.fbxl.net","vid.femboyfurry.net","vid.fossdle.org","vid.freedif.org","vid.involo.ch","vid.jittr.click","vid.kinuseka.us","vid.mattedwards.org","vid.mawuki.de","vid.meow.boutique","vid.mkp.ca","vid.nocogabriel.fr","vid.norbipeti.eu","vid.northbound.online","vid.nsf-home.ip-dynamic.org","vid.ohboii.de","vid.plantplotting.co.uk","vid.pretok.tv","vid.prometheus.systems","vid.ryg.one","vid.samtripoli.com","vid.shadowkat.net","vid.sofita.noho.st","vid.suqu.be","vid.tstoll.me","vid.twhtv.club","vid.wildeboer.net","vid.y-y.li","vid.zeroes.ca","videa.inspirujici.cz","video-cave-v2.de","video.076.moe","video.076.ne.jp","video.1146.nohost.me","video.383.su","video.3cmr.fr","video.4d2.org","video.6p.social","video.9wd.eu","video.abraum.de","video.acra.cloud","video.adamwilbert.com","video.administrieren.net","video.admtz.fr","video.ados.accoord.fr","video.adullact.org","video.agileviet.vn","video.airikr.me","video.akk.moe","video.alee14.me","video.alicia.ne.jp","video.altertek.org","video.alton.cloud","video.amiga-ng.org","video.anaproy.nl","video.anartist.org","video.angrynerdspodcast.nl","video.anrichter.net","video.antopie.org","video.aokami.codelib.re","video.app.nexedi.net","video.apz.fi","video.arghacademy.org","video.aria.dog","video.arslansah.com.tr","video.asgardius.company","video.asonix.dog","video.asturias.red","video.audiovisuel-participatif.org","video.auridh.me","video.aus-der-not-darmstadt.org","video.baez.io","video.balfolk.social","video.barcelo.ynh.fr","video.bards.online","video.batuhan.basoglu.ca","video.beartrix.au","video.benedetta.com.br","video.benetou.fr","video.berocs.com","video.beyondwatts.social","video.bilecik.edu.tr","video.birkeundnymphe.de","video.bl.ag","video.blast-info.fr","video.blender.org","video.blinkyparts.com","video.blueline.mg","video.bmu.cloud","video.boxingpreacher.net","video.brothertec.eu","video.bsrueti.ch","video.canadiancivil.com","video.canc.at","video.cartoon-aa.xyz","video.caruso.one","video.catgirl.biz","video.cats-home.net","video.causa-arcana.com","video.chadwaltercummings.me","video.chalec.org","video.charlesbeadle.tech","video.chasmcity.net","video.chbmeyer.de","video.chipio.industries","video.cigliola.com","video.citizen4.eu","video.cm-en-transition.fr","video.cnil.fr","video.cnnumerique.fr","video.cnr.it","video.coales.co","video.codefor.de","video.coffeebean.social","video.colibris-outilslibres.org","video.collectifpinceoreilles.com","video.colmaris.fr","video.comune.trento.it","video.consultatron.com","video.coop","video.coop.tools","video.coyp.us","video.cpn.so","video.crem.in","video.csc49.fr","video.cybersystems.engineer","video.cymais.cloud","video.d20.social","video.danielaragay.net","video.davduf.net","video.davejansen.com","video.davidsterry.com","video.dhamdomum.ynh.fr","video.digisprong.be","video.discountbucketwarehouse.com","video.dlearning.nl","video.dnfi.no","video.dogmantech.com","video.dokoma.com","video.dresden.network","video.duskeld.dev","video.echelon.pl","video.echirolles.fr","video.edu.nl","video.eientei.org","video.elfhosted.com","video.ellijaymakerspace.org","video.emergeheart.info","video.erikkemp.eu","video.espr.cloud","video.espr.moe","video.europalestine.com","video.exon.name","video.expiredpopsicle.com","video.extremelycorporate.ca","video.f-hub.org","video.fabiomanganiello.com","video.fabriquedelatransition.fr","video.fdlibre.eu","video.fedi.bzh","video.fedihost.co","video.feep.org","video.fhtagn.org","video.firehawk-systems.com","video.firesidefedi.live","video.fiskur.ru","video.fj25.de","video.floor9.com","video.fnordkollektiv.de","video.foofus.com","video.fosshq.org","video.fox-romka.ru","video.franzgraf.de","video.fredix.xyz","video.freie-linke.de","video.fuss.bz.it","video.g3l.org","video.gamerstavern.online","video.gangneux.net","video.geekonweb.fr","video.gem.org.ru","video.gemeinde-pflanzen.net","video.graceenid.com","video.graine-pdl.org","video.grayarea.org","video.greenmycity.eu","video.grenat.art","video.gresille.org","video.gyt.is","video.habets.io","video.hacklab.fi","video.hainry.fr","video.hardlimit.com","video.heathenlab.net","video.holtwick.de","video.hoou.de","video.igem.org","video.immenhofkinder.social","video.index.ngo","video.infiniteloop.tv","video.infinito.nexus","video.infojournal.fr","video.infosec.exchange","video.innovationhub-act.org","video.internet-czas-dzialac.pl","video.interru.io","video.iphodase.fr","video.ipng.ch","video.irem.univ-paris-diderot.fr","video.ironsysadmin.com","video.jacen.moe","video.jadin.me","video.jeffmcbride.net","video.jigmedatse.com","video.katehildenbrand.com","video.kinkyboyspodcast.com","video.kms.social","video.kompektiva.org","video.kopp-verlag.de","video.kuba-orlik.name","video.kyzune.com","video.lacalligramme.fr","video.lala.ovh","video.lamer-ethos.site","video.lanceurs-alerte.fr","video.landtag.ltsh.de","video.laotra.red","video.laraffinerie.re","video.latavernedejohnjohn.fr","video.latribunedelart.com","video.lavolte.net","video.legalloli.net","video.lemediatv.fr","video.lern.link","video.lhed.fr","video.liberta.vip","video.libreti.net","video.linc.systems","video.linux.it","video.linuxtrent.it","video.livecchi.cloud","video.liveitlive.show","video.lmika.org","video.logansimic.com","video.lolihouse.top","video.lono.space","video.lqdn.fr","video.lunago.net","video.lundi.am","video.lw1.at","video.lycee-experimental.org","video.lykledevries.nl","video.macver.org","video.maechler.cloud","video.magical.fish","video.magikh.fr","video.manje.net","video.manu.quebec","video.marcorennmaus.de","video.mariorojo.es","video.mateuaguilo.com","video.matomocamp.org","video.medienzentrum-harburg.de","video.mentality.rip","video.metaccount.de","video.mgupp.ru","video.mikepj.dev","video.millironx.com","video.mobile-adenum.fr","video.mondoweiss.net","video.monsieurbidouille.fr","video.motoreitaliacarlonegri.it","video.mpei.ru","video.mshparisnord.fr","video.mttv.it","video.mugoreve.fr","video.mxsrv.de","video.mxtthxw.art","video.mycrowd.ca","video.na-prostem.si","video.ndqsphub.org","video.neliger.com","video.nesven.eu","video.netsyms.com","video.ngi.eu","video.niboe.info","video.nikau.io","video.nluug.nl","video.nstr.no","video.nuage-libre.fr","video.nuvon.io","video.nyc","video.ocs.nu","video.octofriends.garden","video.odenote.com","video.off-investigation.fr","video.oh14.de","video.olisti.co","video.olos311.org","video.omada.cafe","video.omniatv.com","video.onjase.quebec","video.onlyfriends.cloud","video.osgeo.org","video.ourcommon.cloud","video.outputarts.com","video.ozgurkon.org","video.passageenseine.fr","video.patiosocial.es","video.pavel-english.ru","video.pcf.fr","video.pcgaldo.com","video.pcpal.nl","video.phyrone.de","video.pizza.enby.city","video.pizza.ynh.fr","video.ploss-ra.fr","video.ploud.jp","video.podur.org","video.pop.coop","video.poul.org","video.procolix.eu","video.progressiv.dev","video.pronkiewicz.pl","video.publicspaces.net","video.pullopen.xyz","video.qoto.org","video.querdenken-711.de","video.qutic.com","video.r3s.nrw","video.radiodar.ru","video.raft-network.one","video.randomsonicnet.org","video.rastapuls.com","video.rejas.se","video.resolutions.it","video.retroedge.tech","video.rhizome.org","video.rijnijssel.nl","video.riquy.dev","video.rlp-media.de","video.root66.net","video.rs-einrich.de","video.rubdos.be","video.sadmin.io","video.sadrarin.com","video.sanin.dev","video.sbo.systems","video.secondwindtiming.com","video.selea.se","video.sethgoldstein.me","video.sharebright.net","video.shig.de","video.sidh.bzh","video.silex.me","video.simplex-software.ru","video.smokeyou.org","video.snug.moe","video.software-fuer-engagierte.de","video.sorokin.music","video.sotamedia.org","video.source.pub","video.staging.blender.org","video.starysacz.um.gov.pl","video.stevesworld.co","video.strathspey.org","video.stuve-bamberg.de","video.stwst.at","video.sueneeuniverse.cz","video.swits.org","video.systems.cogsys.wiai.uni-bamberg.de","video.taboulisme.com","video.taskcards.eu","video.team-lcbs.eu","video.tedomum.net","video.telemillevaches.net","video.thepolarbear.co.uk","video.thinkof.name","video.thoshis.net","video.tkz.es","video.toby3d.me","video.transcoded.fr","video.treuzel.de","video.triplea.fr","video.troed.se","video.tryptophonic.com","video.tsundere.love","video.turbo-kermis.fr","video.twitoot.com","video.typesafe.org","video.typica.us","video.uriopss-pdl.fr","video.ut0pia.org","video.uweb.ch","video.vaku.org.ua","video.valme.io","video.veen.world","video.veloma.org","video.veraciousnetwork.com","video.vide.li","video.violoncello.ch","video.voiceover.bar","video.windfluechter.org","video.worteks.com","video.writeas.org","video.wszystkoconajwazniejsze.pl","video.xaetacore.net","video.xmpp-it.net","video.xorp.hu","video.zeitgewinn.ai","video.zeroplex.tw","video.ziez.eu","video.zlinux.ru","video.zonawarpa.it","video01.imghost.club","video02.imghost.club","video02.videohost.top","video03.imghost.club","video05.imghost.club","video06.imghost.club","video2.echelon.pl","videoarchive.wawax.info","videohaven.com","videomensoif.ynh.fr","videos-libr.es","videos-passages.huma-num.fr","videos.80px.com","videos.aadtp.be","videos.aangat.lahat.computer","videos.abnormalbeings.space","videos.adhocmusic.com","videos.ahp-numerique.fr","videos.alamaisondulibre.org","videos.ananace.dev","videos.apprendre-delphi.fr","videos.ardmoreleader.com","videos.arretsurimages.net","videos.avency.de","videos.b4tech.org","videos.bik.opencloud.lu","videos.brookslawson.com","videos.c.lhardy.eu","videos.capas.se","videos.capitoledulibre.org","videos.cassidypunchmachine.com","videos.cemea.org","videos.chardonsbleus.org","videos.cloudron.io","videos.codingotaku.com","videos.coletivos.org","videos.conferences-gesticulees.net","videos.courat.fr","videos.danksquad.org","videos.devteams.at","videos.domainepublic.net","videos.draculo.net","videos.dromeadhere.fr","videos.elenarossini.com","videos.enisa.europa.eu","videos.erg.be","videos.espitallier.net","videos.evoludata.com","videos.explain-it.org","videos.fairetilt.co","videos.figucarolina.org","videos.foilen.com","videos.foilen.net","videos.fozfuncs.com","videos.freeculturist.com","videos.fsci.in","videos.gaboule.com","videos.gamercast.net","videos.gamolf.fr","videos.gianmarco.gg","videos.globenet.org","videos.gnieh.org","videos.hack2g2.fr","videos.hardcoredevs.com","videos.harrk.dev","videos.hauspie.fr","videos.hilariouschaos.com","videos.homeserverhq.com","videos.icum.to","videos.idiocy.xyz","videos.ikacode.com","videos.im.allmendenetz.de","videos.indryve.org","videos.irrelevant.me.uk","videos.iut-orsay.fr","videos.jacksonchen666.com","videos.jevalide.ca","videos.john-livingston.fr","videos.kaz.bzh","videos.koumoul.com","videos.kuoushi.com","videos.lacontrevoie.fr","videos.laguixeta.cat","videos.laliguepaysdelaloire.org","videos.lemouvementassociatif-pdl.org","videos.lescommuns.org","videos.leslionsfloorball.fr","videos.libervia.org","videos.librescrum.org","videos.livewyre.org","videos.lukazeljko.xyz","videos.luke.killarny.net","videos.lukesmith.xyz","videos.martyn.berlin","videos.metschkoll.de","videos.mgnosv.org","videos.miolo.org","videos.monstro1.com","videos.mykdeen.com","videos.myourentemple.org","videos.nerdout.online","videos.netwaver.xyz","videos.noeontheend.com","videos.npo.city","videos.offroad.town","videos.ookami.space","videos.pair2jeux.tube","videos.parleur.net","videos.pcorp.us","videos.pepicrft.me","videos.phegan.live","videos.pixelpost.uk","videos.pkutalk.com","videos.poweron.dk","videos.projets-libres.org","videos.rampin.org","videos.realnephestate.xyz","videos.rights.ninja","videos.ritimo.org","videos.rossmanngroup.com","videos.scanlines.xyz","videos.shendrick.net","videos.shmalls.pw","videos.side-ways.net","videos.spacebar.ca","videos.spacefun.ch","videos.spla.cat","videos.squat.net","videos.stadtfabrikanten.org","videos.sujets-libres.fr","videos.supertuxkart.net","videos.sutcliffe.xyz","videos.tcit.fr","videos.tcjc.uk","videos.testimonia.org","videos.tfcconnection.org","videos.thegreenwizard.win","videos.thinkerview.com","videos.tiffanysostar.com","videos.toromedia.com","videos.triceraprog.fr","videos.triplebit.net","videos.trom.tf","videos.trucs-de-developpeur-web.fr","videos.tuist.dev","videos.tusnio.me","videos.ubuntu-paris.org","videos.upr.fr","videos.utsukta.org","videos.viorsan.com","videos.weaponisedautism.com","videos.webcoaches.net","videos.wikilibriste.fr","videos.wirtube.de","videos.yesil.club","videos.yeswiki.net","videosafehaven.com","videoteca.ibict.br","videoteca.kenobit.it","videotheque.uness.fr","videotube.duckdns.org","videotvlive.nemethstarproductions.eu","videovortex.tv","videowisent.maw.best","viditube.site","vids.krserv.social","vids.mariusdavid.fr","vids.roshless.me","vids.stary.pc.pl","vids.tekdmn.me","vids.thewarrens.name","vids.ttlmakerspace.com","vids.witchcraft.systems","vidz.antifa.club","vidz.dou.bet","vidz.julien.ovh","views.southfox.me","vigilante.tv","virtual-girls-are.definitely-for.me","viste.pt","vizyon.kaubuntu.re","vlad.tube","vm02408.procolix.com","vn.jvideos.top","vn.zohup.net","vod.newellijay.tv","vods.198x.eu","vods.juni.tube","volk.love","voluntarytube.com","vstation.hsu.edu.hk","vtr.chikichiki.tube","vulgarisation-informatique.fr","vuna.no","wacha.punks.cc","wahrheitsministerium.xyz","walleyewalloping.fedihost.io","walsh.fallcounty.omg.lol","watch.bojidar-bg.dev","watch.caeses.com","watch.easya.solutions","watch.eeg.cl.cam.ac.uk","watch.goodluckgabe.life","watch.heehaw.space","watch.jimmydore.com","watch.littleshyfim.com","watch.makearmy.io","watch.nuked.social","watch.ocaml.org","watch.oroykhon.ru","watch.revolutionize.social","watch.rvtownsquare.com","watch.softinio.com","watch.tacticaltech.org","watch.thelema.social","watch.therisingeagle.info","watch.vinbrun.com","watch.weanimatethings.com","we.haydn.rocks","weare.dcnh.tv","webtv.vandoeuvre.net","westergaard.video","widemus.de","wiwi.video","woodland.video","worctube.com","wtfayla.com","wur.pm","www.aishaalrasheedmosque.tv","www.earthclimate.tv","www.elltube.gr","www.jvideos.top","www.komitid.tv","www.kotikoff.net","www.makertube.net","www.mypeer.tube","www.nadajemy.com","www.neptube.io","www.novatube.net","www.piratentube.de","www.pony.tube","www.videos-libr.es","www.vnchich.in","www.vnchich.top","www.vnshow.net","www.wtfayla.com","www.yiny.org","www.zappiens.br","www.zohup.in","www.zohup.link","x.vnchich.vip","x.zohup.top","x.zohup.vip","x1.vnchich.in","xn--fsein-zqa5f.xn--nead-na-bhfinleog-hpb.ie","xxivproduction.video","yawawi.com","yellowpages.video","youslots.tv","youtube.n-set.ru","ysm.info","yt.lostpod.space","yt.orokoro.ru","ytube.retronerd.at","yuitobe.wikiwiki.li","zappiens.br","zeitgewinn-peertube.tfrfia.easypanel.host","zensky-pj.com","zentube.org"];
// END AUTOGENERATED INSTANCES
