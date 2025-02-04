const PLATFORM = "PeerTube";

let config = {};

let state = {
	serverVersion: ''
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
			replaceUrlInstanceHost(v.url, { sufixSourceInstance: true }), 
			v.avatar ? `${plugin.config.constants.baseUrl}${v.avatar.path}` : ""
		);

	}), obj.total > (start + count), path, params, page);
}

function getVideoPager(path, params, page) {
	log(`getVideoPager page=${page}`, params)

	const count = 20;
	const start = (page ?? 0) * count;
	params = { ... params, start, count }

	const url = `${plugin.config.constants.baseUrl}${path}`;
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
		const contentUrl = v.url || `${plugin.config.constants.baseUrl}/videos/watch/${v.uuid}`

		return new PlatformVideo({
			id: new PlatformID(PLATFORM, v.uuid, config.id),
			name: v.name ?? "",
			thumbnails: new Thumbnails([new Thumbnail(`${plugin.config.constants.baseUrl}${v.thumbnailPath}`, 0)]),
			author: new PlatformAuthorLink(
				new PlatformID(PLATFORM, v.channel.name, config.id), 
				v.channel.displayName, 
				replaceUrlInstanceHost(v.channel.url, { sufixSourceInstance: true }),
				v.channel.avatar ? `${plugin.config.constants.baseUrl}${v.channel.avatar.path}` : ""),
			datetime: Math.round((new Date(v.publishedAt)).getTime() / 1000),
			duration: v.duration,
			viewCount: v.views,
			url: replaceUrlInstanceHost(contentUrl),
			isLive: v.isLive
		});

	}), obj.total > (start + count), path, params, page);
}

function getCommentPager(path, params, page) {
	log(`getCommentPager page=${page}`, params)

	const count = 20;
	const start = (page ?? 0) * count;
	params = { ... params, start, count }

	const url = `${plugin.config.constants.baseUrl}${path}`;
	const urlWithParams = `${url}${buildQuery(params)}`;
	log("GET " + urlWithParams);
	const res = http.GET(urlWithParams, {});

	if (res.code != 200) {
		log("Failed to get comments", res);
		return new CommentPager([], false);
	}

	const obj = JSON.parse(res.body);

	return new PeerTubeCommentPager(obj.data.map(v => {
		return new Comment({
			contextUrl: url,
			author: new PlatformAuthorLink(
				new PlatformID(PLATFORM, v.account.name, config.id),
				v.account.displayName, 
				 replaceUrlInstanceHost(`${plugin.config.constants.baseUrl}/api/v1/video-channels/${v.account.name}`, { sufixSourceInstance: true }), 
				 ""
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
		const res = http.GET(`${plugin.config.constants.baseUrl}/api/v1/config`, {});

		if(res.isOk) {
			const serverConfig = JSON.parse(res.body);
			state.serverVersion = serverConfig.serverVersion;
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
	return url.startsWith(`${plugin.config.constants.baseUrl}/video-channels/`);
};
source.getChannel = function (url) {
	const tokens = url.split('/');
	const handle = tokens[tokens.length - 1];
	const urlWithParams = `${plugin.config.constants.baseUrl}/api/v1/video-channels/${handle}`;
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
		thumbnail: obj.avatar ? `${plugin.config.constants.baseUrl}${obj.avatar.path}` : "",
		banner: null,
		subscribers: obj.followersCount,
		description: obj.description ?? "",
		url: replaceUrlInstanceHost(obj.url, { sufixSourceInstance: true }),
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

	const tokens = url.split('/');
	const handle = tokens[tokens.length - 1];
	return getVideoPager(`/api/v1/video-channels/${handle}/videos`, params, 0);
};

source.isContentDetailsUrl = function(url) {
	return url.startsWith(`${plugin.config.constants.baseUrl}/videos/watch/`);
};

const supportedResolutions = {
	'1080p': { width: 1920, height: 1080 },
	'720p': { width: 1280, height: 720 },
	'480p': { width: 854, height: 480 },
	'360p': { width: 640, height: 360 },
	'144p': { width: 256, height: 144 }
};

source.getContentDetails = function (url) {
    // Extract handle from URL
    function getHandleFromUrl(url) {
        try {
            const tokens = url.split('/');
            return tokens[tokens.length - 1];
        } catch (err) {
            log("Invalid URL format", err);
            return null;
        }
    }

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
        const handle = getHandleFromUrl(url);
        if (!handle) {
            return null;
        }

        const urlWithParams = `${plugin.config.constants.baseUrl}/api/v1/videos/${handle}`;
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
		const contentUrl = obj.url || `${plugin.config.constants.baseUrl}/videos/watch/${obj.uuid}`;
        
        return new PlatformVideoDetails({
            id: new PlatformID(PLATFORM, obj.uuid, config.id),
            name: obj.name,
            thumbnails: new Thumbnails([new Thumbnail(
                `${plugin.config.constants.baseUrl}${obj.thumbnailPath}`, 
                0
            )]),
            author: new PlatformAuthorLink(
                new PlatformID(PLATFORM, obj.channel.name, config.id),
                obj.channel.displayName,
                replaceUrlInstanceHost(obj.channel.url, { sufixSourceInstance: true }),
                obj.channel.avatar ? `${plugin.config.constants.baseUrl}${obj.channel.avatar.path}` : ""
            ),
            datetime: Math.round((new Date(obj.publishedAt)).getTime() / 1000),
            duration: obj.duration,
            viewCount: obj.views,
            url: replaceUrlInstanceHost(contentUrl),
            isLive: obj.isLive,
            description: obj.description,
            video: new VideoSourceDescriptor(sources)
        });
    } catch (err) {
        throw new ScriptException("Error processing video details", err);
    }
};

source.getComments = function (url) {
	const tokens = url.split('/');
	const handle = tokens[tokens.length - 1];
	return getCommentPager(`/api/v1/videos/${handle}/comment-threads`, {}, 0);
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


function replaceUrlInstanceHost(originalUrl, options = { sufixSourceInstance: false }) {
    try {

        if (typeof originalUrl !== 'string') {
            throw new Error('originalUrl must be a string');
        }

        // Parse original URL
        const url = new URL(originalUrl);
		const originalHost = url.host;
        
        const targetHost = new URL(plugin.config.constants.baseUrl).host;

        // Replace host only if different
        if (url.host.toLowerCase() !== targetHost.toLowerCase()) {
            url.host = targetHost;
        }

        let newUrl = url.toString();
        
        // Optional source instance suffix. This is needed to query the remote channel on the instance api
        if (options.sufixSourceInstance) {
            newUrl += `@${originalHost}`;
        }

        return newUrl;
    } catch (error) {
        // More informative error handling
        throw new ScriptException(`Error processing URL: ${originalUrl} - ${error.message}`);
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