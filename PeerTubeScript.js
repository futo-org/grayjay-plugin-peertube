const PLATFORM = "PeerTube";

let config = {};

let state = {
	serverVersion: '',
	peertubeIndexedInstances: []
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
		if (value) {
			if (first) {
				first = false;
			} else {
				query += "&";
			}

			query += `${key}=${value}`;
		}
	}

	return (query && query.length > 0) ? `?${query}` : ""; 
}

function getChannelPager(path, params, page) {
	log(`getChannelPager page=${page}`, params)

	const count = 20;
	const start = (page ?? 0) * count;
	params = { ... params, start, count }

	const url = `${plugin.config.constants.baseUrl}${path}`;
	const urlWithParams = `${url}${buildQuery(params)}`;
	log("GET " + urlWithParams);
	const res = http.GET(urlWithParams, {});

	if (res.code != 200) {
		log("Failed to get channels", res);
		return new ChannelPager([], false);
	}

	const obj = JSON.parse(res.body);

	return new PeerTubeChannelPager(obj.data.map(v => {
		return new PlatformAuthorLink(
			new PlatformID(PLATFORM, v.name, config.id), 
			v.displayName, 
			v.url, 
			getAvatarUrl(v)
		);

	}), obj.total > (start + count), path, params, page);
}

function getVideoPager(path, params, page, sourceHost = plugin.config.constants.baseUrl) {
	log(`getVideoPager page=${page}`, params)

	const count = 20;
	const start = (page ?? 0) * count;
	params = { ... params, start, count }

	const url = `${sourceHost}${path}`;
	
	const urlWithParams = `${url}${buildQuery(params)}`;
	log("GET " + urlWithParams);
	const res = http.GET(urlWithParams, {});

	if (res.code != 200) {
		log("Failed to get videos", res);
		return new VideoPager([], false);
	}

	const obj = JSON.parse(res.body);

	return new PeerTubeVideoPager(obj.data.map(v => {

		//Some older instance versions such as 3.0.0, may not contain the url property
		const contentUrl = v.url || `${sourceHost}/videos/watch/${v.uuid}`

		return new PlatformVideo({
			id: new PlatformID(PLATFORM, v.uuid, config.id),
			name: v.name ?? "",
			thumbnails: new Thumbnails([new Thumbnail(`${sourceHost}${v.thumbnailPath}`, 0)]),
			author: new PlatformAuthorLink(
				new PlatformID(PLATFORM, v.channel.name, config.id), 
				v.channel.displayName, 
				v.channel.url,
				getAvatarUrl(v, sourceHost)
			),
			datetime: Math.round((new Date(v.publishedAt)).getTime() / 1000),
			duration: v.duration,
			viewCount: v.views,
			url: contentUrl,
			isLive: v.isLive
		});

	}), obj.total > (start + count), path, params, page);
}

function getCommentPager(path, params, page, sourceBaseUrl = plugin.config.constants.baseUrl) {
	log(`getCommentPager page=${page}`, params)

	const count = 20;
	const start = (page ?? 0) * count;
	params = { ... params, start, count }

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

source.enable = function (conf, settings, saveStateStr) {
	config = conf ?? {};
	let didSaveState = false;

	if(IS_TESTING) {
		plugin.config = {
			constants : {
				baseUrl: "https://peertube.futo.org"
			}
		}
	}

	try {
		if (saveStateStr) {
		  state = JSON.parse(saveStateStr);
		  didSaveState = true;
		}
	  } catch (ex) {
		log('Failed to parse saveState:' + ex);
	  }

	if(!didSaveState) {
		const [currentInstanceConfig, knownInstances] = http.batch()
		.GET(`${plugin.config.constants.baseUrl}/api/v1/config`, {})
		.GET(`https://instances.joinpeertube.org/api/v1/instances?start=0&count=1000`, {})
		.execute();

		if(currentInstanceConfig.isOk) {
			const serverConfig = JSON.parse(currentInstanceConfig.body);
			state.serverVersion = serverConfig.serverVersion;
		}

		if(knownInstances.isOk) {
			const instancesResponse = JSON.parse(knownInstances.body);
			state.peertubeIndexedInstances = instancesResponse.data.map(i => i.host);
		}
	}

};

source.saveState = function() {
	return JSON.stringify(state)
}

source.getHome = function () {

	let sort = '';

	// https://docs.joinpeertube.org/CHANGELOG#v3-1-0
	// old versions will fail when using the 'best' sorting param
	if(ServerInstanceVersionIsSameOrNewer(state.serverVersion, '3.1.0')) {
		sort = 'best'
	}

	return getVideoPager('/api/v1/videos', {
		sort
	}, 0);
};

source.searchSuggestions = function(query) {
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

	return getVideoPager('/api/v1/search/videos', params, 0);
};
source.searchChannels = function (query) {
	return getChannelPager('/api/v1/search/video-channels', {
		search: query
	}, 0);
};

source.isChannelUrl = function(url) {
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
        const isKnownInstanceUrl = state.peertubeIndexedInstances.includes(host);

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

source.isContentDetailsUrl = function(url) {
    try {
        if (!url) return false;

        // Check if URL belongs to the base instance and matches content patterns
        const baseUrl = plugin.config.constants.baseUrl;
        const isInstanceContentDetails = url.startsWith(`${baseUrl}/videos/watch/`) || url.startsWith(`${baseUrl}/w/`);
		if(isInstanceContentDetails) return true;

		const urlTest = new URL(url);
        const { host, pathname } = urlTest;

        // Check if the path follows a known PeerTube video format
        const isPeerTubeVideoPath = /^\/(videos\/(watch|embed)|w)\/[a-zA-Z0-9-_]+$/.test(pathname);

        // Check if the URL is from a known PeerTube instance
        const isKnownInstanceUrl = state.peertubeIndexedInstances.includes(host);

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
	'144p': { width: 256, height: 144 }
};

source.getContentDetails = function (url) {


    // Create video source based on file and resolution
    function createVideoSource(file, duration) {
        const supportedResolution = file.resolution.width && file.resolution.height
            ? { width: file.resolution.width, height: file.resolution.height }
            : supportedResolutions[file.resolution.label];

        if (!supportedResolution) {
            return null;
        }

        return new VideoUrlSource({
            name: file.resolution.label,
            url: file.fileDownloadUrl,
            width: supportedResolution.width,
            height: supportedResolution.height,
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
        
        return new PlatformVideoDetails({
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
    } catch (err) {
        throw new ScriptException("Error processing video details", err);
    }
};

source.getComments = function (url) {
	const videoId = extractVideoId(url);
	const sourceBaseUrl = getBaseUrl(url);
	return getCommentPager(`/api/v1/videos/${videoId}/comment-threads`, {}, 0, sourceBaseUrl);
}
source.getSubComments = function(comment) {
	return getCommentPager(`/api/v1/videos/${comment.context.id}/comment-threads`, {}, 0);
}

class PeerTubeVideoPager extends VideoPager {
	constructor(results, hasMore, path, params, page) {
		super(results, hasMore, { path, params, page });
	}
	
	nextPage() {
		return getVideoPager(this.context.path, this.context.params, (this.context.page ?? 0) + 1);
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

function getBaseUrl(url) {
	const urlTest = new URL(url);
	const host = urlTest?.host || '';
	const protocol = urlTest?.protocol || '';
	const port = urlTest?.port ? `:${urlTest?.port}` : ''
	return `${protocol}//${host}${port}`;
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
