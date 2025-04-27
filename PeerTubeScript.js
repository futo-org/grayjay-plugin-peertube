const PLATFORM = "PeerTube";

let config = {};
let _settings = {};

let state = {
	serverVersion: '',
	isSearchEngineSepiaSearch: false
}

// instances are populated during deploy appended to the end of this javascript file
// this update process is done at update-instances.sh
let INDEX_INSTANCES = {
	instances: []
};

let SEARCH_ENGINE_OPTIONS = [];

source.enable = function (conf, settings, saveStateStr) {
	config = conf ?? {};
	_settings = settings ?? {};

	SEARCH_ENGINE_OPTIONS = loadOptionsForSetting('searchEngineIndex');

	let didSaveState = false;

	if (IS_TESTING) {
		plugin.config = {
			constants: {
				baseUrl: "https://peertube.futo.org"
			}
		}

		_settings.searchEngineIndex = 0; //Current Instance
		_settings.submitActivity = true;
	}

	state.isSearchEngineSepiaSearch = SEARCH_ENGINE_OPTIONS[_settings.searchEngineIndex] == 'Sepia Search'

	try {
		if (saveStateStr) {
			state = JSON.parse(saveStateStr);
			didSaveState = true;
		}
	} catch (ex) {
		log('Failed to parse saveState:' + ex);
	}

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

	// https://docs.joinpeertube.org/CHANGELOG#v3-1-0
	// old versions will fail when using the 'best' sorting param
	if (ServerInstanceVersionIsSameOrNewer(state.serverVersion, '3.1.0')) {
		sort = 'best'
	}

	return getVideoPager('/api/v1/videos', {
		sort
	}, 0);
};

source.searchSuggestions = function (query) {
	return [];
};
source.getSearchCapabilities = () => {
	return {
		types: [Type.Feed.Mixed, Type.Feed.Streams, Type.Feed.Videos],
		sorts: [Type.Order.Chronological, "publishedAt"]
	};
};
source.search = function (query, type, order, filters) {
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

	let sourceHost = '';

	if (state.isSearchEngineSepiaSearch) {
		params.resultType = 'videos';
		params.nsfw = false;
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

source.isChannelUrl = function (url) {
	try {

		log(`isChannel: ${url}`)

		if (!url) return false;

		// Check if the URL belongs to the base instance
		const baseUrl = plugin.config.constants.baseUrl;
		const isInstanceChannel = url.startsWith(`${baseUrl}/video-channels/`) || url.startsWith(`${baseUrl}/c/`);
		if (isInstanceChannel) return true;

		const urlTest = new URL(url);
		const { host, pathname } = urlTest;

		// Check if the URL is from a known PeerTube instance
		const isKnownInstanceUrl = INDEX_INSTANCES.instances.includes(host);

		// Match PeerTube channel paths:
		// - /c/{channel}
		// - /c/{channel}/video
		// - /c/{channel}/videos
		// - /video-channels/{channel}
		// - /video-channels/{channel}/videos
		// - Allow optional trailing slash
		const isPeerTubeChannelPath = /^\/(c|video-channels)\/[a-zA-Z0-9-_.]+(\/(video|videos)?)?\/?$/.test(pathname);

		return isKnownInstanceUrl && isPeerTubeChannelPath;
	} catch (error) {
		console.error('Error checking PeerTube channel URL:', error);
		return false;
	}
};



source.getChannel = function (url) {

	const handle = extractChannelId(url);
	const sourceBaseUrl = getBaseUrl(url);

	const urlWithParams = `${sourceBaseUrl}/api/v1/video-channels/${handle}`;
	log("GET " + urlWithParams);
	const res = http.GET(urlWithParams, {});

	if (res.code != 200) {
		log("Failed to get channel", res);
		return null;
	}

	const obj = JSON.parse(res.body);

	return new PlatformChannel({
		id: new PlatformID(PLATFORM, obj.name, config.id),
		name: obj.displayName,
		thumbnail: getAvatarUrl(obj, sourceBaseUrl),
		banner: null,
		subscribers: obj.followersCount,
		description: obj.description ?? "",
		url: obj.url,
		links: {}
	});
};
source.getChannelCapabilities = () => {
	return {
		types: [Type.Feed.Mixed, Type.Feed.Streams, Type.Feed.Videos],
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

	if (type == Type.Feed.Streams) {
		params.isLive = true;
	} else if (type == Type.Feed.Videos) {
		params.isLive = false;
	}

	const handle = extractChannelId(url);

	const sourceBaseUrl = getBaseUrl(url);

	return getVideoPager(`/api/v1/video-channels/${handle}/videos`, params, 0, sourceBaseUrl);
};

source.isContentDetailsUrl = function (url) {
	try {
		if (!url) return false;

		// Check if URL belongs to the base instance and matches content patterns
		const baseUrl = plugin.config.constants.baseUrl;
		const isInstanceContentDetails = url.startsWith(`${baseUrl}/videos/watch/`) || url.startsWith(`${baseUrl}/w/`);
		if (isInstanceContentDetails) return true;

		const urlTest = new URL(url);
		const { host, pathname } = urlTest;

		// Check if the path follows a known PeerTube video format
		const isPeerTubeVideoPath = /^\/(videos\/(watch|embed)|w)\/[a-zA-Z0-9-_]+$/.test(pathname);

		// Check if the URL is from a known PeerTube instance
		const isKnownInstanceUrl = INDEX_INSTANCES.instances.includes(host);

		return isInstanceContentDetails || (isKnownInstanceUrl && isPeerTubeVideoPath);
	} catch (error) {
		console.error('Error checking PeerTube content URL:', error);
		return false;
	}
};


const supportedResolutions = {
	'1080p': { width: 1920, height: 1080 },
	'720p': { width: 1280, height: 720 },
	'480p': { width: 854, height: 480 },
	'360p': { width: 640, height: 360 },
	'240p': { width: 426, height: 240 },
	'144p': { width: 256, height: 144 }
};

source.getContentDetails = function (url) {


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

	// Process files and create sources
	function processFiles(files, duration) {
		const sources = [];
		for (const file of (files ?? [])) {
			const source = createVideoSource(file, duration);
			if (source) {
				sources.push(source);
			}
		}
		return sources;
	}

	try {
		const videoId = extractVideoId(url);
		if (!videoId) {
			return null;
		}

		const sourceBaseUrl = getBaseUrl(url);
		const urlWithParams = `${sourceBaseUrl}/api/v1/videos/${videoId}`;
		log("GET " + urlWithParams);
		const res = http.GET(urlWithParams, {});
		if (!res.isOk) {
			log("Failed to get video detail", res);
			return null;
		}

		const obj = JSON.parse(res.body);
		if (!obj) {
			log("Failed to parse response");
			return null;
		}

		const sources = [];

		// Process streaming playlists
		for (const playlist of (obj?.streamingPlaylists ?? [])) {
			sources.push(new HLSSource({
				name: "HLS",
				url: playlist.playlistUrl,
				duration: obj.duration ?? 0,
				priority: true
			}));

			sources.push(...processFiles(playlist?.files, obj.duration));
		}

		// Process direct files (older versions)
		sources.push(...processFiles(obj?.files, obj.duration));

		//Some older instance versions such as 3.0.0, may not contain the url property
		const contentUrl = obj.url || `${sourceBaseUrl}/videos/watch/${obj.uuid}`;

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
				obj.channel.url,
				getAvatarUrl(obj, sourceBaseUrl)
			),
			datetime: Math.round((new Date(obj.publishedAt)).getTime() / 1000),
			duration: obj.duration,
			viewCount: obj.views,
			url: contentUrl,
			isLive: obj.isLive,
			description: obj.description,
			video: new VideoSourceDescriptor(sources)
		});

		if (IS_TESTING) {
			source.getContentRecommendations(url, obj);
		} else {
			result.getContentRecommendations = function () {
				return source.getContentRecommendations(url, obj);
			};
		}

		return result;

	} catch (err) {
		throw new ScriptException("Error processing video details", err);
	}
};

source.getContentRecommendations = function (url, obj) {

	const sourceHost = getBaseUrl(url);
	const videoId = extractVideoId(url);

	let tagsOneOf = obj?.tags ?? [];

	if (!obj && videoId) {
		const res = http.GET(`${sourceHost}/api/v1/videos/${videoId}`, {});
		if (res.isOk) {
			const obj = JSON.parse(res.body);
			if (obj) {
				tagsOneOf = obj?.tags ?? []
			}
		}
	}

	const params = {
		skipCount: false,
		nsfw: false,
		tagsOneOf,
		sort: "-publishedAt",
		searchTarget: "local"
	}

	const pager = getVideoPager('/api/v1/search/videos', params, 0, sourceHost, false);

	pager.results = pager.results.filter(v => v.id.value != videoId);
	return pager;
}

source.getComments = function (url) {
	const videoId = extractVideoId(url);
	const sourceBaseUrl = getBaseUrl(url);
	return getCommentPager(`/api/v1/videos/${videoId}/comment-threads`, {}, 0, sourceBaseUrl);
}
source.getSubComments = function (comment) {
	return getCommentPager(`/api/v1/videos/${comment.context.id}/comment-threads`, {}, 0);
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
	constructor(results, hasMore, path, params, page, sourceHost, isSearch) {
		super(results, hasMore, { path, params, page, sourceHost, isSearch });
	}

	nextPage() {
		return getVideoPager(this.context.path, this.context.params, (this.context.page ?? 0) + 1, this.context.sourceHost, this.context.isSearch);
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
	constructor(results, hasMore, path, params, page) {
		super(results, hasMore, { path, params, page });
	}

	nextPage() {
		return getCommentPager(this.context.path, this.context.params, (this.context.page ?? 0) + 1);
	}
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
	log(`getChannelPager page=${page}`, params)

	const count = 20;
	const start = (page ?? 0) * count;
	params = { ...params, start, count }

	const url = `${sourceHost}${path}`;
	const urlWithParams = `${url}${buildQuery(params)}`;
	log("GET " + urlWithParams);
	const res = http.GET(urlWithParams, {});

	if (res.code != 200) {
		log("Failed to get channels", res);
		return new ChannelPager([], false);
	}

	const obj = JSON.parse(res.body);

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

function getVideoPager(path, params, page, sourceHost = plugin.config.constants.baseUrl, isSearch = false) {
	log(`getVideoPager page=${page}`, params)

	const count = 20;
	const start = (page ?? 0) * count;
	params = { ...params, start, count }

	const url = `${sourceHost}${path}`;

	const urlWithParams = `${url}${buildQuery(params)}`;

	log("GET " + urlWithParams);
	const res = http.GET(urlWithParams, {});


	if (res.code != 200) {
		log("Failed to get videos", res);
		return new VideoPager([], false);
	}

	const obj = JSON.parse(res.body);

	const hasMore = obj.total > (start + count);

	const contentResultList = obj.data.map(v => {

		const baseUrl = [
			v.url,
			v.embedUrl,
			v.previewUrl,
			v?.thumbnailUrl,
			v?.account?.url,
			v?.channel?.url
		].filter(Boolean).map(getBaseUrl).find(Boolean);

		//Some older instance versions such as 3.0.0, may not contain the url property
		const contentUrl = v.url || `${baseUrl}/videos/watch/${v.uuid}`;

		const instanceBaseUrl = isSearch ? baseUrl : sourceHost;

		return new PlatformVideo({
			id: new PlatformID(PLATFORM, v.uuid, config.id),
			name: v.name ?? "",
			thumbnails: new Thumbnails([new Thumbnail(`${instanceBaseUrl}${v.thumbnailPath}`, 0)]),
			author: new PlatformAuthorLink(
				new PlatformID(PLATFORM, v.channel.name, config.id),
				v.channel.displayName,
				v.channel.url,
				getAvatarUrl(v, instanceBaseUrl)
			),
			datetime: Math.round((new Date(v.publishedAt)).getTime() / 1000),
			duration: v.duration,
			viewCount: v.views,
			url: contentUrl,
			isLive: v.isLive
		});

	});

	return new PeerTubeVideoPager(contentResultList, hasMore, path, params, page, sourceHost, isSearch);
}

function getCommentPager(path, params, page, sourceBaseUrl = plugin.config.constants.baseUrl) {
	log(`getCommentPager page=${page}`, params)

	const count = 20;
	const start = (page ?? 0) * count;
	params = { ...params, start, count }

	const url = `${sourceBaseUrl}${path}`;
	const urlWithParams = `${url}${buildQuery(params)}`;
	log("GET " + urlWithParams);
	const res = http.GET(urlWithParams, {});

	if (res.code != 200) {
		log("Failed to get comments", res);
		return new CommentPager([], false);
	}

	const obj = JSON.parse(res.body);

	return new PeerTubeCommentPager(obj.data
		.filter(v => !v.isDeleted || (v.isDeleted && v.totalReplies > 0)) // filter out deleted comments without replies. TODO: handle soft deleted comments with replies
		.map(v => {
			return new Comment({
				contextUrl: url,
				author: new PlatformAuthorLink(
					new PlatformID(PLATFORM, v.account.name, config.id),
					v.account.displayName,
					`${sourceBaseUrl}/api/v1/video-channels/${v.account.name}`,
					getAvatarUrl(v)
				),
				message: v.text,
				rating: new RatingLikes(0),
				date: Math.round((new Date(v.createdAt)).getTime() / 1000),
				replyCount: v.totalReplies,
				context: { id: v.id }
			});
		}), obj.total > (start + count), path, params, page);
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

	return "";
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

function extractChannelId(url) {
	try {
		if (!url) return null;

		const urlTest = new URL(url);
		const { pathname } = urlTest;

		// Regex to match and extract the channel ID from both /c/ and /video-channels/ URLs
		const match = pathname.match(/^\/(c|video-channels)\/([a-zA-Z0-9-_.]+)(?:\/(video|videos)?)?\/?$/);

		return match ? match[2] : null; // match[2] contains the extracted channel ID
	} catch (error) {
		console.error('Error extracting PeerTube channel ID:', error);
		return null;
	}
}


function extractVideoId(url) {
	try {
		if (!url) return null;

		const urlTest = new URL(url);
		const { pathname } = urlTest;

		// Regex to match and extract the video ID from various video URL patterns
		const match = pathname.match(/^\/(videos\/(watch|embed)\/|w\/)([a-zA-Z0-9-_]+)(?:\/.*)?$/);

		return match ? match[3] : null; // match[3] contains the extracted video ID
	} catch (error) {
		console.error('Error extracting PeerTube video ID:', error);
		return null;
	}
}


function loadOptionsForSetting(settingKey, transformCallback) {
	transformCallback ??= (o) => o;
	const setting = config?.settings?.find((s) => s.variable == settingKey);
	return setting?.options?.map(transformCallback) ?? [];
}

// Those instances were requested by users
// Those hostnames are exclusively used to help the plugin know if a hostname is a PeerTube instance
// Grayjay nor futo are associated, does not endorse or are responsible for the content in those instances.
INDEX_INSTANCES.instances = [
	...INDEX_INSTANCES.instances,'poast.tv','videos.upr.fr','peertube.red'
]

// BEGIN AUTOGENERATED INSTANCES
// This content is autogenerated during deployment using update-instances.sh and content from https://instances.joinpeertube.org
// Those hostnames are exclusively used to help the plugin know if a hostname is a PeerTube instance
// Grayjay nor futo are associated, does not endorse or are responsible for the content in those instances.
// Last updated at: 2025-04-25
INDEX_INSTANCES.instances = [...INDEX_INSTANCES.instances,"tube.sanguinius.dev","planetube.live","videos.alamierda.eu","videos.spacefun.ch","asantube.stream","peertube.baptistentiel.nl","partners.eqtube.org","tube.kjernsmo.net","rofl.im","peertube.orderi.co","tv.solarpunk.land","peertube.diem25.ynh.fr","peertube.2tonwaffle.com","runeclaw.net","peertube.graafschapcollege.nl","peertube.delta0189.xyz","tube.dnet.one","videos.rights.ninja","video02.imghost.club","video03.imghost.club","video04.imghost.club","video01.imghost.club","video05.imghost.club","video06.imghost.club","peertube.ii.md","peertube.gyatt.cc","peertube.cratonsed.ge","st.fdel.moe","tube.statyvka.org.ua","peertube.chn.moe","tube.giesing.space","peertube.lab.how","video.0xc0edba.be","tube.bremen-social-sciences.de","video.aokami.codelib.re","peertube.zveronline.ru","pt.secnd.me","mv.vannilla.org","peertube.teutronic-services.de","mooosetube.mooose.org","video.interru.io","tube.loping.net","peertube.joby.lol","lyononline.dev","matte.fedihost.io","video.be4.pw","peertube.jmsquared.net","store.tadreb.live","video.exon.name","tube.io18.eu","eleison.eu","resist.video","vidz.antifa.club","video.tsundere.love","peertube.katholisch.social","peertube.mldchan.dev","peertube.chaunchy.com","video.progressiv.dev","peertube.lagy.org","peertube.revelin.fr","tube.fediverse.games","breeze.tube","peertube.inparadise.se","videos.arretsurimages.net","peertube.themcgovern.net","dev.itvplus.iiens.net","peertube.noiz.co.za","exatas.tv","videos.noeontheend.com","peertube.doesnotexist.club","peertube.ekosystems.fr","mirror.peertube.metalbanana.net","teregarde.icu","peertube.cif.su","peertube.la-famille-muller.fr","peertube.diplopode.net","v.kyaru.xyz","video.grenat.art","video.espr.cloud","video.toby3d.me","tube.risedsky.ovh","tube.cnr.it","video.csc49.fr","videos.squat.net","video.habets.io","peertube.sieprawski.pl","peer.i6p.ru","peertube.woitschetzki.de","edflix.nl","stream.homelab.gabb.fr","gabtoken.noho.st","videos.ubuntu-paris.org","vid.suqu.be","tube.homelab.officebot.io","test.staging.fedihost.co","peertube.waima.nu","peertube.iriseden.eu","video.greenmycity.eu","peertube-ifrjt-u26837.vm.elestio.app","video.caruso.one","peertube.librelabucm.org","video.phyrone.de","peertube.2i2l.net","tube.straub-nv.de","media.selector.su","peertube.0011.lt","video.kinkyboyspodcast.com","peertube.30p87.de","video.p3x.de","video.chadwaltercummings.me","video.benedetta.com.br","tube.hunterjozwiak.com","media.privacyinternational.org","videomensoif.ynh.fr","video.blender.org","pon.tv","peertube.nekosunevr.co.uk","videos.gamolf.fr","videos.apprendre-delphi.fr","peertube.ecsodikas.eu","video.fosshq.org","live.zawiya.one","peertube.pnpde.social","peer.pvddhhnk.nl","peertube.spaceships.me","peertube.mgtow.pl","peertube.guiofamily.fr","softlyspoken.taylormadetech.dev","tv.kreuder.me","vid.involo.ch","vid.freedif.org","peertube.kalua.im","peertube.flauschbereich.de","live.oldskool.fi","videos.nerdout.online","peertube.xn--gribschi-o4a.ch","video.asturias.red","vid.mawuki.de","tube.ssh.club","video.zlinux.ru","publicvideo.nl","beartrix-peertube-u29672.vm.elestio.app","platt.video","tube.jesusgomez.me","v0.trm.md","prtb.komaniya.work","videos.netwaver.xyz","peertube.funkfeuer.at","pt.scrunkly.cat","tv.adn.life","gnulinux.tube","feditubo.yt","video.nluug.nl","v.mbius.io","video.birkeundnymphe.de","videa.inspirujici.cz","watch.oroykhon.ru","play.kryta.app","peertube.arnhome.ovh","video.cartoon-aa.xyz","peertube.axiom-paca.g1.lu","video.stuve-bamberg.de","tube.gummientenmann.de","bitforged.stream","v.blustery.day","vibeos.grampajoe.online","we.haydn.rocks","tube.cybertopia.xyz","peertube.plaureano.nohost.me","peertube.chartilacorp.ru","p.efg-ober-ramstadt.de","tube.bsd.cafe","peertube-ardlead-u29325.vm.elestio.app","avantwhatever.xyz","andyrush.fedihost.io","bridport.tv","tube.raccoon.quest","yt.orokoro.ru","peertube.astrolabe.coop","peertube.kameha.click","film.fjerland.no","peertube.fedihub.online","video.cybersystems.engineer","tube.gi-it.de","video.pizza.enby.city","kviz.leemoon.network","bideoak.zeorri.eus","play.shirtless.gay","video.codefor.de","video.niboe.info","play-my.video","woodland.video","tube.le-gurk.de","video.gyt.is","puptube.rodeo","peertube.yujiri.xyz","v.esd.cc","streamarchive.manicphase.me","peertube.h-u.social","nethack.tv","vids.krserv.social","peertube.monicz.dev","exquisite.tube","videos.devteams.at","misnina.tv","video.franzgraf.de","peertubevdb.de","peertube.rlp.schule","videos.jevalide.ca","mevideo.host","kiwi.froggirl.club","wur.pm","telegenic.talesofmy.life","stream.conesphere.cloud","see.ellipsenpark.de","tube.fulda.social","video.edu.nl","yuitobe.wikiwiki.li","video.magical.fish","video.akk.moe","retvrn.tv","tube.swee.codes","sc07.tv","beta.flimmerstunde.xyz","peertube.g2od.ch","vidz.dou.bet","ballhaus.media","peertube.waldstepperbu.de","m.bbbdn.jp","regarder.sans.pub","studio.lrnz.it","tv.nizika.tv","videos.imjessewellman.blog","tv.anarchy.bg","v1.smartit.nu","peertube.anzui.dev","sfba.video","videos.grafo.zone","play.rejas.se","peertube.xrcb.cat","stream.nuemedia.se","media.mzhd.de","media.curious.bio","peertube-ecogather-u20874.vm.elestio.app","video.na-prostem.si","media.smz-ma.de","tube.bit-friends.de","peertube.tata.casa","peertube.ucy.de","peer.philoxweb.be","ohayo.rally.guide","media.notfunk.radio","mystic.video","video.linc.systems","vid.ohboii.de","ysm.info","peertube.musicstudio.pro","v.posm.gay","peertube-ktgou-u11537.vm.elestio.app","peertube.dubwise.dk","peertube.1984.cz","tube.aetherial.xyz","video.olisti.co","videowisent.maw.best","peertube.automat.click","all.electric.kitchen","peertube.eqver.se","video.veen.world","leffler.video","tubocatodico.bida.im","peertube.asp.krakow.pl","video.xorp.hu","video.anaproy.nl","tube.tilera.xyz","video.mikepj.dev","vods.juni.tube","video.fnordkollektiv.de","video.livecchi.cloud","vid.ryg.one","peertube.tspu.edu.ru","peertube.public.cat","video.mentality.rip","peertube.tspu.ru","video.manicphase.me","video.coffeebean.social","faf.watch","videos.erg.be","tube.trax.im","peertube.bingo-ev.de","www.piratentube.de","outcast.am","librepoop.de","videos.avency.de","watch.eeg.cl.cam.ac.uk","intratube-u25541.vm.elestio.app","ibbwstream.schule-bw.de","tube.die-rote-front.de","video.starysacz.um.gov.pl","video.apz.fi","peertube.lhc.lu","peertube.louisematic.site","mountaintown.video","cfnumerique.tv","tube.xd0.de","peertube.020.pl","tuvideo.encanarias.info","tube.buchstoa-tv.at","tube.moep.tv","tv.lumbung.space","kamtube.ru","peertube.terranout.mine.nu","video.angrynerdspodcast.nl","tv.animalcracker.art","video.emergeheart.info","tube.2hyze.de","tube.io18.top","video.wszystkoconajwazniejsze.pl","go3.site","mediathek.rzgierskopp.de","video.076.ne.jp","media.mwit.ac.th","peertube.nighty.name","tube.hamakor.org.il","peertube.local.tilera.xyz","tube.infrarotmedien.de","peertube.existiert.ch","classe.iro.umontreal.ca","videos-libr.es","tube.beit.hinrichs.cc","stream.udk-berlin.de","hyperreal.tube","videos.irrelevant.me.uk","peertube.gravitywell.xyz","tube.matrix.rocks","peertube.lyclpg.itereva.pf","canard.tube","tube.ar.hn","tube.pari.cafe","study.miet.ru","video.pavel-english.ru","tube.unif.app","videos.foilen.net","tube.fedisphere.net","pt.nijbakker.net","video.boxingpreacher.net","tube.mfraters.net","video.lunago.net","tv.zonepl.net","tueb.telent.net","peertube.aukfood.net","coldfishvideo.ddns.net","stream.andersonr.net","video.thoshis.net","tube.nx12.net","peertube.winscloud.net","video.gemeinde-pflanzen.net","peertube.unixweb.net","tv.cuates.net","peertube.hellsite.net","tube.me.jon-e.net","pire.artisanlogiciel.net","feditubo.labaudric.net","peertube.nadeko.net","videos.espitallier.net","peertube.parenti.net","tube.govital.net","peertube.monlycee.net","videos.fozfuncs.com","peertube.troback.com","peertube.marcelsite.com","christuncensored.com","foubtube.com","peertube.dixvaha.com","peertube.tangentfox.com","video.consultatron.com","tube.hapyyr.com","vids.ttlmakerspace.com","peertube.offerman.com","v.eurorede.com","tv.speleo.mooo.com","videos.ardmoreleader.com","peertube.anija.mooo.com","watch.weanimatethings.com","video.foofus.com","tube.whytheyfight.com","videos.tiffanysostar.com","peertube.anasodon.com","flappingcrane.com","video.worteks.com","video.elfhosted.com","peertube.becycle.com","videos.pkutalk.com","peertube.martiabernathey.com","pt.sarahgebauer.com","videos.hardcoredevs.com","literatube.com","peertube.intrapology.com","wtfayla.com","videos.monstro1.com","video.expiredpopsicle.com","peertube.redpill-insight.com","video.sadrarin.com","videos.kuoushi.com","videotube.duckdns.org","vid.fossdle.org","tube.chach.org","pfideo.pfriedma.org","video.lmika.org","video.writeas.org","video.arghacademy.org","media.over-world.org","video.ozgurkon.org","media.geekwisdom.org","tube.polytech-reseau.org","peertubecz.duckdns.org","peertube.cuatrolibertades.org","videos.chardonsbleus.org","peertube.protagio.org","peertube.boc47.org","videos.tfcconnection.org","raptube.antipub.org","video.fhtagn.org","watch.tacticaltech.org","sermons.luctorcrc.org","video.poul.org","videos.capitoledulibre.org","tube.waag.org","linhtran.eu","tv.kobold-cave.eu","peertube.fediversity.eu","video.brothertec.eu","tube.freeit247.eu","notretube.asselma.eu","peertube.hizkia.eu","video.ngi.eu","video.procolix.eu","peertube.rokugan.fr","video.nuage-libre.fr","tube.balamb.fr","video.cm-en-transition.fr","peertube.nuage-libre.fr","videos.gl75.fr","peertube.am-networks.fr","video.dhamdomum.ynh.fr","video.hainry.fr","video.mobile-adenum.fr","video.pizza.ynh.fr","tube.chaun14.fr","peertube.linsurgee.fr","tube.alphonso.fr","video.ploss-ra.fr","peertube.pablopernot.fr","peer.azurs.fr","tube.fdn.fr","tube.laurent-malys.fr","music.facb69.tec.br","videos.ahp-numerique.fr","www.makertube.net","www.earthclimate.tv","videos.abnormalbeings.space","videos.phegan.live","clip.place","video.patiosocial.es","peertube.florentcurk.com","peertube.craftum.pl","peertube.everypizza.im","yt.lostpod.space","video.blazma.st","video.kompektiva.org","peertube.pogmom.me","koreus.tv","videos.brookslawson.com","earthclimate.tv","peertube.havesexwith.men","video.firesidefedi.live","video2.echelon.pl","video.echelon.pl","piped.chrisco.me","freediverse.com","video.mshparisnord.fr","vid.nsf-home.ip-dynamic.org","video.collectifpinceoreilles.com","tube.pompat.us","peertube.rhoving.com","peertube.jarmvl.net","video.innovationhub-act.org","peertube.zalasur.media","video.colmaris.fr","tube.tkzi.ru","peertube.wtf","video.voiceover.bar","video.balfolk.social","videos.spacebar.ca","videos.pixelpost.uk","video.3cmr.fr","810video.com","peertube.iz5wga.radio","peertube-wb4xz-u27447.vm.elestio.app","peertube.blablalinux.be","yt.antebeot.world","videos.triceraprog.fr","videos.ikacode.com","video.silex.me","videos.libervia.org","video.383.su","peertube.apse-asso.fr","video.riquy.dev","video.infiniteloop.tv","peertube.casually.cat","media.nolog.cz","peertube.sjml.de","tube.niel.me","video.beartrix.au","sizetube.com","video.omniatv.com","video.selea.se","video.sorokin.music","hitchtube.fr","quantube.win","peertube.shilohnewark.org","content.haacksnetworking.org","user800.one","videos.conferences-gesticulees.net","blurt.media","video.davejansen.com","wacha.punks.cc","yt.novelity.tech","vhsky.cz","video.magikh.fr","tube.g1sms.fr","video.fedihost.co","tube.systemz.pl","videos.80px.com","video.adamwilbert.com","video.turbo-kermis.fr","video.sidh.bzh","dalek.zone","peertube.dtth.ch","video.millironx.com","video.onjase.quebec","peertube.apcraft.jp","video.4d2.org","peertube.qontinuum.space","video.floor9.com","video.xmpp-it.net","cuddly.tube","video.lala.ovh","peertube.mesnumeriques.fr","tube.artvage.com","neshweb.tv","video.osgeo.org","vid.digitaldragon.club","lone.earth","tube.uncomfortable.business","meshtube.net","peertube.cluster.wtf","pt.minhinprom.ru","peertube.eticadigital.eu","p.nintendojo.fr","watch.ocaml.org","pbvideo.ru","peertube.nashitut.ru","peertube.wirenboard.com","peertube.ra.no","gultsch.video","video.076.moe","peertube.br0.fr","video.laotra.red","peertube.cube4fun.net","tube.sadlads.com","video.tryptophonic.com","peertube.vhack.eu","tube.sector1.fr","peertube.sensin.eu","video.mondoweiss.net","peertube.aegrel.ee","tube.sbcloud.cc","tube.techeasy.org","varis.tv","tube.yapbreak.fr","video.thinkof.name","peertube.get-racing.de","play.dfri.se","video.bgeneric.net","tube.purser.it","videos.ananace.dev","videos.shendrick.net","tube.teckids.org","video.windfluechter.org","tube.mediasculp.com","media.assassinate-you.net","xn--fsein-zqa5f.xn--nead-na-bhfinleog-hpb.ie","videos.adhocmusic.com","video.hdys.band","video.fabriquedelatransition.fr","peertube.eus","video.medienzentrum-harburg.de","lucarne.balsamine.be","tube.thechangebook.org","hpstube.fr","vidz.julien.ovh","pt.hexor.cy","tube.anufrij.de","video.mycrowd.ca","videos.draculo.net","seka.pona.la","tv.dyne.org","cumraci.tv","peertube.zmuuf.org","peertube.logilab.fr","peertube.alpharius.io","peertube.familie-berner.de","tube.4e6a.ru","tv.pirateradio.social","tube.archworks.co","peer.acidfog.com","peertube.meditationsteps.org","videohaven.com","tube.vencabot.com","fedifilm.com","video.europalestine.com","k-pop.22x22.ru","den.wtf","friprogramvarusyndikatet.tv","tube.pifferi.io","tux-edu.tv","v.pizda.world","tube.sasek.tv","vid.jittr.click","video.mxtthxw.art","videos.danksquad.org","peertube.wtfayla.net","vdo.greboca.com","nekopunktube.fr","mplayer.demouliere.eu","tube.rfc1149.net","video.lamer-ethos.site","peertube.fr","flooftube.net","tube.kdy.ch","tube.chaoszone.tv","tube.transgirl.fr","peertube.lesparasites.net","videoteca.kenobit.it","video.zonawarpa.it","peertube.jussak.net","peertube.normalgamingcommunity.cz","mytube.cooltux.net","eggflix.foolbazar.eu","tube.vrpnet.org","tube-test.apps.education.fr","videos.martyn.berlin","vdo.unvanquished.greboca.com","peertube.dc.pini.fr","tube.chispa.fr","peertube.keazilla.net","video.valme.io","tube.alado.space","play.mittdata.se","peertube.fedi.zutto.fi","peertube.rainbowswingers.net","www.videos-libr.es","peertube.devol.it","peertube.qtg.fr","peertube.forteza.fr","neon.cybre.stream","watch.softinio.com","itvplus.iiens.net","peertube.atilla.org","video.altertek.org","tube.croustifed.net","video.omada.cafe","video.chalec.org","peertube.universiteruraledescevennes.org","videos.coletivos.org","vulgarisation-informatique.fr","peertube.ch","video.infosec.exchange","videos.globenet.org","video.pronkiewicz.pl","video.barcelo.ynh.fr","videovortex.tv","tube.kotocoop.org","videos.idiocy.xyz","spook.tube","intelligentia.tv","tube.helpsolve.org","video.alton.cloud","video.katehildenbrand.com","thecool.tube","tube.gayfr.online","mla.moe","punktube.net","video.gamerstavern.online","peertube.ghis94.ovh","videos.npo.city","flim.txmn.tk","peertube.hosnet.fr","peertube.cirkau.art","peertube.behostings.net","video.administrieren.net","peertube.modspil.dk","video.metaccount.de","video.espr.moe","jetstream.watch","peertube.futo.org","bolha.tube","tube.todon.eu","peertube.habets.house","tube.lubakiagenda.net","video.cpn.so","video.canadiancivil.com","dreiecksnebel.alex-detsch.de","video.chasmcity.net","media.inno3.eu","peertube.nodja.com","peertube.inubo.ch","video.olos311.org","videos.enisa.europa.eu","peertube.manalejandro.com","video.hacklab.fi","vamzdis.group.lt","my-sunshine.video","video.chipio.industries","peertube.ignifi.me","peertube.th3rdsergeevich.xyz","videos.mykdeen.com","peertube.marud.fr","davbot.media","peertube.nissesdomain.org","tube.area404.cloud","video.echirolles.fr","apollo.lanofthedead.xyz","quebec1.freediverse.com","video.oh14.de","peertube.touhoppai.moe","22x22.ru","christunscripted.com","peertube.crazy-to-bike.de","peertube.laveinal.cat","peertube.ecologie.bzh","tube.extinctionrebellion.fr","video.iphodase.fr","video.taboulisme.com","peertube.minetestserver.ru","tube.funil.de","media.cooleysekula.net","peertube.plataformess.org","po0.online","subscribeto.me","video.fedi.bzh","kpop.22x22.ru","video.maechler.cloud","peertube.dk","peertube.geekgalaxy.fr","videos.offroad.town","special.videovortex.tv","video.coyp.us","video.abraum.de","tv.arns.lt","voluntarytube.com","vid.northbound.online","peertube.doesstuff.social","kadras.live","trailers.ddigest.com","pastafriday.club","peertube.teftera.com","video.rastapuls.com","peertube.nogafam.fr","puppet.zone","tv.atmx.ca","vid.norbipeti.eu","nadajemy.com","displayeurope.video","flipboard.video","video.lacalligramme.fr","video.tkz.es","peertube.otakufarms.com","videos.viorsan.com","peertube.stattzeitung.org","peertube.it-arts.net","peertube.anti-logic.com","pt.thishorsie.rocks","video.ironsysadmin.com","peertube-docker.cpy.re","videos.utsukta.org","pt.vern.cc","videos.stadtfabrikanten.org","film.node9.org","peertube.vesdia.eu","watch.jimmydore.com","views.southfox.me","peer.raise-uav.com","tinkerbetter.tube","peertube.christianpacaud.com","videos.dromeadhere.fr","peertube.fedihost.website","freesoto.tv","peer.madiator.cloud","video.9wd.eu","video.bilecik.edu.tr","pirtube.calut.fr","ptube.rousset.nom.fr","peertube.pix-n-chill.fr","peertube.helvetet.eu","video.dlearning.nl","video.thepolarbear.co.uk","www.nadajemy.com","peertube.cipherbliss.com","serv3.wiki-tube.de","tube.doortofreedom.org","tube.dev.displ.eu","communitymedia.video","video.fabiomanganiello.com","tube.felinn.org","alterscope.fr","peertube.festnoz.de","video.firehawk-systems.com","phoenixproject.group","peertube.researchinstitute.at","tube.sekretaerbaer.net","peertube.communecter.org","tube.toldi.eu","video.fuss.bz.it","videos.side-ways.net","vtr.chikichiki.tube","peertube.dair-institute.org","peertube.swarm.solvingmaz.es","peertube.jackbot.fr","videos.hack2g2.fr","peertube.giftedmc.com","videos.gianmarco.gg","garr.tv","stream.rlp-media.de","video.rlp-media.de","videos.foilen.com","tube.pastwind.top","video.infojournal.fr","peertube.astral0pitek.synology.me","pt.na4.eu","tube.pol.social","nolog.media","peertube.roundpond.net","peertube.chuggybumba.com","p.lu","video.lanceurs-alerte.fr","private.fedimovie.com","0ch.tv","tube.nieuwwestbrabant.nl","video.ziez.eu","stl1988.peertube-host.de","video.rubdos.be","tube.flokinet.is","tube.g4rf.net","stream.biovisata.lt","brioco.live","johnydeep.net","bava.tv","archive.nocopyrightintended.tv","peertube.in.ua","media.exo.cat","archive.reclaim.tv","tv.farewellutopia.com","pt.rwx.ch","peertube.vapronva.pw","peertube.histoirescrepues.fr","tinsley.video","tube.dembased.xyz","bark.video","video.gresille.org","videos.librescrum.org","peertube.lhc.net.br","viste.pt","tube.asulia.fr","tube.parinux.org","peertube.bildung-ekhn.de","www.mypeer.tube","vids.stary.pc.pl","video.jeffmcbride.net","tv.undersco.re","video.lono.space","video.jadin.me","peertube.rougevertbleu.tv","dangly.parts","bonn.video","peertube.chir.rs","vid.cthos.dev","biblion.refchat.net","tube.ttk.is","peertube.ohioskates.com","pt.netcraft.ch","dalliance.network","commons.tube","peertube.familleboisteau.fr","tube.ryne.moe","watch.goodluckgabe.life","petitlutinartube.fr","peertube.hyperfreedom.org","video.pullopen.xyz","videos.explain-it.org","tube.tinfoil-hat.net","video.pcgaldo.com","stream.vrse.be","biblioteca.theowlclub.net","watch.easya.solutions","mix.video","podlibre.video","qtube.qlyoung.net","video.beyondwatts.social","tube.pustule.org","tube.fediverse.at","vid.kinuseka.us","theater.ethernia.net","video.irem.univ-paris-diderot.fr","video.nesven.eu","peertube.tmp.rcp.tf","peervideo.ru","peertube.magicstone.dev","peertube.r2.enst.fr","tube.numerique.gouv.fr","tube.linkse.media","social.fedimovie.com","tv.gravitons.org","peertube.simounet.net","video.lapineige.fr","peertube.skorpil.cz","tube.tuxfriend.fr","video.ourcommon.cloud","peertube.kyriog.eu","peertube.libresolutions.network","video.fdlibre.eu","brocosoup.fr","peertube.labeuropereunion.eu","peertube.interhop.org","video.lavolte.net","peertube.ti-fr.com","merci-la-police.fr","peertube.dsmouse.net","megatube.lilomoino.fr","foss.video","makertube.net","peertube.kaleidos.net","peertube.veen.world","video.laraffinerie.re","tv.adast.dk","peertube.mikemestnik.net","veedeo.org","neat.tube","video.nstr.no","videos.gamercast.net","tube.morozoff.pro","apertatube.net","video.asgardius.company","vid.nocogabriel.fr","video.causa-arcana.com","urbanists.video","video.ipng.ch","peertube.tv","ytube.retronerd.at","video.taskcards.eu","peertube.hackerfoo.com","videos.miolo.org","peertube.adresse.data.gouv.fr","syrteplay.obspm.fr","cloudtube.ise.fraunhofer.de","videos.jacksonchen666.com","virtual-girls-are.definitely-for.me","peertube.nayya.org","ebildungslabor.video","portal.digilab.nfa.cz","peertube.libretic.fr","astrotube-ufe.obspm.fr","vod.newellijay.tv","videos.leslionsfloorball.fr","peertube.grosist.fr","video.cnnumerique.fr","peertube.semperpax.com","media.zat.im","fedi.video","birdtu.be","tube.leetdreams.ch","tube.lab.nrw","live.libratoi.org","pt.freedomwolf.cc","videos.wikilibriste.fr","videos.icum.to","video.jacen.moe","astrotube.obspm.fr","video.simplex-software.ru","videos.thinkerview.com","peertube.b38.rural-it.org","periscope.numenaute.org","v.basspistol.org","kino.schuerz.at","tube.xn--baw-joa.social","pete.warpnine.de","sovran.video","video.software-fuer-engagierte.de","peertube.rural-it.org","bideoteka.eus","peer.tube","docker.videos.lecygnenoir.info","tv.filmfreedom.net","peertube.viviers-fibre.net","peertube.elforcer.ru","peertube.metalbanana.net","peertube.marienschule.de","cdn01.tilvids.com","sdmtube.fr","video.team-lcbs.eu","medias.debrouillonet.org","dytube.com","video.jigmedatse.com","tube.kh-berlin.de","videos.codingotaku.com","video.cnr.it","nanawel-peertube.dyndns.org","video.catgirl.biz","video.bmu.cloud","tbh.co-shaoghal.net","video.vegafjord.me","peertube-us.howlround.com","peertube-eu.howlround.com","videos.parleur.net","peertube.askan.info","rankett.net","video.ut0pia.org","tube.nogafa.org","www.neptube.io","tube.ghk-academy.info","tube-sciences-technologies.apps.education.fr","tube-institutionnel.apps.education.fr","tube-cycle-3.apps.education.fr","tubulus.openlatin.org","video.graine-pdl.org","tube-cycle-2.apps.education.fr","video.davduf.net","tube-langues-vivantes.apps.education.fr","tube-arts-lettres-sciences-humaines.apps.education.fr","videos.scanlines.xyz","tube.reseau-canope.fr","tube-maternelle.apps.education.fr","video.occm.cc","video.uriopss-pdl.fr","tube-action-educative.apps.education.fr","videos.yesil.club","tube-numerique-educatif.apps.education.fr","video.ados.accoord.fr","tube-education-physique-et-sportive.apps.education.fr","videos.lemouvementassociatif-pdl.org","tube-enseignement-professionnel.apps.education.fr","videos.laliguepaysdelaloire.org","twctube.twc-zone.eu","vhs.absturztau.be","phijkchu.com","video.lycee-experimental.org","video.fox-romka.ru","watch.thelema.social","vid.mkp.ca","nightshift.minnix.dev","tube.friloux.me","peertube.virtual-assembly.org","v.mkp.ca","infothema.net","video.colibris-outilslibres.org","videos.alamaisondulibre.org","tube.nestor.coop","tube.genb.de","tube.rooty.fr","www.kotikoff.net","peertube.nz","openmedia.edunova.it","ocfedtest.hosted.spacebear.ee","tube.kicou.info","videos-passages.huma-num.fr","video.retroedge.tech","pt.ilyamikcoder.com","video.sadmin.io","stream.jurnalfm.md","video.publicspaces.net","video.eientei.org","tube.erzbistum-hamburg.de","video.mttv.it","peertube.cloud.nerdraum.de","vid.pretok.tv","tv.santic-zombie.ru","video.snug.moe","videos.ritimo.org","pt.mezzo.moe","tube.dsocialize.net","video.linux.it","bee-tube.fr","vid.prometheus.systems","videos.yeswiki.net","video.r3s.nrw","peertube.semweb.pro","testube.distrilab.fr","tube.koweb.fr","peertube.genma.fr","peertube.satoshishop.de","peertube.zwindler.fr","videos.fsci.in","video.chbmeyer.de","video.rs-einrich.de","dud175.inf.tu-dresden.de","peertube.fenarinarsa.com","exode.me","video.anartist.org","peertube.home.x0r.fr","skeptube.fr","tube.pilgerweg-21.de","peertube.bubbletea.dev","peertube.art3mis.de","tube.interhacker.space","tube.otter.sh","replay.jres.org","peertube.lagob.fr","video.extremelycorporate.ca","videos.b4tech.org","video.off-investigation.fr","stream.litera.tools","peertube.kriom.net","peertube.gemlog.ca","live.solari.com","live.codinglab.ch","dud-video.inf.tu-dresden.de","media.interior.edu.uy","tube.ponsonaille.fr","tube.int5.net","peertube.arch-linux.cz","tube.spdns.org","tube.onlinekirche.net","tube.systerserver.net","video.antopie.org","fedimovie.com","video.audiovisuel-participatif.org","video.liveitlive.show","vid.plantplotting.co.uk","video.telemillevaches.net","tv.pirati.cz","tube.nuxnik.com","tube.froth.zone","peertube.ethibox.fr","tube.communia.org","video.citizen4.eu","video.matomocamp.org","media.fsfe.org","tube.geekyboo.net","canal.facil.services","pt.gordons.gen.nz","video.ellijaymakerspace.org","peertube.expi.studio","crank.recoil.org","peertube.education-forum.com","apathy.tv","peertube.paladyn.org","anarchy.tube","tube.elemac.fr","videos.bik.opencloud.lu","videos.aadtp.be","pt01.lehrerfortbildung-bw.de","video.benetou.fr","bideoak.argia.eus","tube.kher.nl","peertube.kleph.eu","pony.tube","video.rhizome.org","video.libreti.net","videos.supertuxkart.net","v.kisombrella.top","tube.sp-codes.de","peertube.bridaahost.ynh.fr","tube.arthack.nz","kino.kompot.si","tube.kockatoo.org","stream.k-prod.fr","tube.tylerdavis.xyz","video.marcorennmaus.de","peertube.atsuchan.page","peertube.vlaki.cz","video-cave-v2.de","vids.tekdmn.me","piraten.space","tube.bstly.de","tube.futuretic.fr","peertube.beeldengeluid.nl","tube.ebin.club","irrsinn.video","darkvapor.nohost.me","peertube.klaewyss.fr","peertube.takeko.cyou","videos.shmalls.pw","peertube.kx.studio","stream.elven.pw","videos.rampin.org","bitcointv.com","media.gzevd.de","video.resolutions.it","tube.cms.garden","peertube.luckow.org","video.linuxtrent.it","video.comune.trento.it","tube.org.il","peertube.eu.org","video.blast-info.fr","peertube.bubuit.net","fair.tube","tube.lokad.com","tube.pmj.rocks","peertube.ctseuro.com","spectra.video","watch.libertaria.space","video.triplea.fr","tube.kotur.org","peertube.euskarabildua.eus","tube.rhythms-of-resistance.org","peertube.luga.at","peertube.roflcopter.fr","peertube.swrs.net","tube.shanti.cafe","videos.cloudron.io","video.bards.online","peertube.gargantia.fr","tube.grap.coop","webtv.vandoeuvre.net","peertube.european-pirates.eu","kirche.peertube-host.de","v.lor.sh","peertube.be","grypstube.uni-greifswald.de","wiwi.video","tube.distrilab.fr","kinowolnosc.pl","videos.trom.tf","videos.john-livingston.fr","evangelisch.video","media.undeadnetwork.de","peertube.nicolastissot.fr","tube.lucie-philou.com","tube.schule.social","tube.xy-space.de","studios.racer159.com","fediverse.tv","xxivproduction.video","digitalcourage.video","tvox.ru","video.kuba-orlik.name","video.pcf.fr","tube.rsi.cnr.it","peertube.bilange.ca","tube.schleuss.online","lastbreach.tv","video.coales.co","film.k-prod.fr","peertube.tweb.tv","kodcast.com","tube.oisux.org","tube.lacaveatonton.ovh","peertube.anduin.net","peertube.r5c3.fr","fotogramas.politicaconciencia.org","video.dresden.network","peertube.tiennot.net","tututu.tube","tube.picasoft.net","videos.pair2jeux.tube","video.internet-czas-dzialac.pl","peertube.chtisurel.net","tube.cyano.at","tube.nox-rhea.org","peertube.securitymadein.lu","mytube.kn-cloud.de","peertube.stream","player.ojamajo.moe","video.cigliola.com","tube.jeena.net","peertube.xwiki.com","peertube.s2s.video","peertube.travelpandas.eu","video.igem.org","tube.skrep.in","vid.wildeboer.net","battlepenguin.video","peertube.cloud.sans.pub","refuznik.video","tube.shela.nu","video.1146.nohost.me","vod.ksite.de","tube.grin.hu","peertube.zergy.net","videos.tcit.fr","video.violoncello.ch","peertube.gidikroon.eu","tubedu.org","tilvids.com","peertube.designersethiques.org","tube.aquilenet.fr","peertube.lyceeconnecte.fr","vids.roshless.me","peertube.netzbegruenung.de","tube.opportunis.me","tube.graz.social","kolektiva.media","peertube.ichigo.everydayimshuflin.com","video.lundi.am","peertube.lagvoid.com","video.mugoreve.fr","tube.portes-imaginaire.org","p.eertu.be","video.hardlimit.com","peertube.debian.social","peertube.demonix.fr","videos.hauspie.fr","video.liberta.vip","tube.plaf.fr","tube.hoga.fr","medias.pingbase.net","mytube.madzel.de","tube.azbyka.ru","greatview.video","media.krashboyz.org","toobnix.org","tube.rebellion.global","videos.koumoul.com","tube.undernet.uy","peertube.opencloud.lu","peertube.desmu.fr","tube.nx-pod.de","video.monsieurbidouille.fr","tube.crapaud-fou.org","lostpod.space","tube.taker.fr","peertube.dynlinux.io","v.kretschmann.social","tube.calculate.social","peertube.laas.fr","video.ploud.jp","conf.tube","peertube.f-si.org","peertube.slat.org","peertube.uno","tube.tchncs.de","peertube.anon-kenkai.com","video.lemediatv.fr","peertube.artica.center","indymotion.fr","tube.fede.re","peertube.mygaia.org","peertube.livingutopia.org","tube.anjara.eu","video.latavernedejohnjohn.fr","peertube.pcservice46.fr","video.coop.tools","peertube.openstreetmap.fr","scitech.video","tube.postblue.info","videos.domainepublic.net","peertube.makotoworkshop.org","video.netsyms.com","vid.y-y.li","diode.zone","peertube.nomagic.uk","peertube.we-keys.fr","artitube.artifaille.fr","peertube.amicale.net","aperi.tube","video.lw1.at","www.yiny.org","video.typica.us","videos.lescommuns.org","peertube.1312.media","skeptikon.fr","tube.homecomputing.fr","video.tedomum.net","video.g3l.org","fontube.fr","peertube.gaialabs.ch","tube.p2p.legal","peertube.solidev.net","videos.cemea.org","video.passageenseine.fr","share.tube","peertube.heraut.eu","peertube.gegeweb.eu","framatube.org","peertube.datagueule.tv","video.lqdn.fr","peertube3.cpy.re","peertube2.cpy.re","peertube.cpy.re",];
// END AUTOGENERATED INSTANCES
