'use strict';

const UPDATE_TIMER_INTERVAL = 60000; // 1 minute
const FEED_FETCHER_TIMEOUT = 25000; // 25 seconds
const FAVICON_REFRESH_INTERVAL = 14*24*60*60*1000; // 2 weeks

const FEED_ICON_URL = '/skin/brief-icon-32.png';


let FeedUpdater = {
    queue: [],
    backgroundQueue: [],
    stats: {
        scheduled: 0,
        completed: 0,
    },
    active: false,

    async init() {
        await wait(Prefs.get('update.startupDelay'));

        /*spawn*/ this._scheduler();
    },

    async updateFeeds(feeds, {background}) {
        if(!Array.isArray(feeds)) {
            feeds = [feeds];
        }
        feeds = feeds.map(feed => feed.feedID || feed);
        feeds = feeds.filter(feed => !this.queue.includes(feed));
        if(background) {
            let feeds = feeds.filter(feed => !this.backgroundQueue.includes(feed));
            this.stats.scheduled += feeds.length;
            this.backgroundQueue.push(...feeds);
        } else {
            this.stats.scheduled += feeds.length;
            this.queue.push(...feeds);
            let background = this.backgroundQueue.length;
            this.backgroundQueue = this.backgroundQueue.filter(
                feed => !feeds.includes(feed));
            this.stats.scheduled -= background - this.backgroundQueue.length;
        }
        if(!this.active) {
            /*spawn*/ this._worker();
        }
    },

    async updateAllFeeds({background}) {
        let feeds = Database.feeds.filter(f => !f.hidden && !f.isFolder);
        this.updateFeeds(feeds, {background});
    },

    async stopUpdating() {
    },

    async _scheduler() {
    },

    async _worker() {
        while(this.queue.length || this.backgroundQueue.length) {
            break;
        }
    },
};


let FaviconFetcher = {
    async updateFavicon(feed) {
        let favicon = await this._fetchFavicon(feed);
        if(!favicon) {
            favicon = 'no-favicon';
        }
        await Database.modifyFeed({
            feedID: feed.feedID,
            lastFaviconRefresh: Date.now(),
            favicon
        });
    },
    async _fetchFavicon(feed) {
        if (!feed.websiteURL) {
            return;
        }

        // Use websiteURL instead of feedURL for resolving the favicon URL,
        // because many websites use services like Feedburner for generating their
        // feeds and we would get the Feedburner's favicon instead.
        let faviconUrl = new URL('/favicon.ico', feed.websiteURL);

        let response = await fetch(faviconUrl, {redirect: 'follow'});

        if(!response.ok) {
            return;
        }
        let blob = await response.blob();
        if(blob.size === 0) {
            return;
        }

        let reader = new FileReader();
        let favicon = await new Promise((resolve, reject) => {
            reader.onload = e => resolve(e.target.result);
            reader.onerror = e => reject(e);
            reader.readAsDataURL(blob);
        });

        return favicon;
    },
};


let FeedFetcher = {
    async fetchFeed(feed) {
        let url = feed.feedURL;
        let request = new XMLHttpRequest();
        request.open('GET', url);
        request.overrideMimeType('application/xml');
        //request.setRequestHeader('Cache-control', 'no-cache'); // FIXME: enable when done testing
        request.responseType = 'document';

        let doc = await Promise.race([
            xhrPromise(request),
            wait(FEED_FETCHER_TIMEOUT),
        ]);
        if(!doc) {
            console.error("failed to fetch", url);
            return;
        }

        if(doc.documentElement.localName === 'parseerror') {
            console.error("failed to parse as XML", url);
            return;
        }

        let root = doc.querySelector(this.ROOTS);
        let result = this._parseNode(root, this.FEED_PROPERTIES);
        if(!result || !result.items || !result.items.length > 0) {
            console.warn("failed to find any items in", url);
        }
        result.language = result.language || doc.documentElement.getAttribute('xml:lang');
        return result;
    },

    ROOTS: ['RDF, channel, *|feed'],

    _parseNode(node, properties) {
        let props = {};
        let keyMap = this._buildKeyMap(properties);
        //TODO: handle attributes
        let children = Array.from(node.children);
        children.push(...node.attributes);
        for(let child of children) {
            let nsPrefix = this._nsPrefix(child.namespaceURI);
            if(nsPrefix === 'IGNORE:') {
                continue;
            } else if(nsPrefix[0] === '[') {
                console.log('unknown namespace', nsPrefix, child);
                continue;
            }
            let nodeKey = nsPrefix + child.localName;
            let destinations = keyMap.get(nodeKey);
            if(destinations === undefined) {
                let parent = this._nsPrefix(node.namespaceURI) + node.localName;
                console.log('unknown key', nodeKey, 'in', node);
                continue;
            }
            for(let {name, type, array} of destinations) {
                if(name === 'IGNORE') {
                    continue;
                }
                let handler = this.handlers[type];
                if(handler) {
                    let value = handler.call(this, child);
                    if(value === undefined || value === null) {
                        continue;
                    }
                    if(name === '{merge}') {
                        Object.assign(props, value);
                        continue;
                    }
                    if(array) {
                        if(props[name] === undefined) {
                            props[name] = [];
                        }
                        props[name].push(value);
                    } else {
                        props[name] = value;
                    }
                } else {
                    console.log('missing handler', type);
                }
            }
        }
        return props;
    },

    _buildKeyMap(known_properties) {
        let map = new Map();
        for(let [name, type, tags] of known_properties) {
            let array = false;
            if(name.slice(name.length - 2) === '[]') {
                name = name.slice(0, name.length - 2);
                array = true;
            }
            for(let src of tags) {
                if(src.tag !== undefined) {
                    type = src.type || type;
                    src = src.tag;
                }
                let destinations = map.get(src) || [];
                destinations.push({name, type, array});
                map.set(src, destinations);
            }
        }
        return map;
    },

    FEED_PROPERTIES: [
        // Name, handler name, list of known direct children with it
        ['title', 'text', ["title", "rss1:title", "atom03:title", "atom:title"]],
        ['subtitle', 'text', ["description", "dc:description", "rss1:description",
                              "atom03:tagline", "atom:subtitle"]],
        ['link', 'url', ["link", "rss1:link"]],
        ['link', 'atomLinkAlternate', ["atom:link", "atom03:link"]],
        ['items[]', 'entry', ["item", "rss1:item", "atom:entry", "atom03:entry"]],
        ['generator', 'text', ["generator", "rss1:generator", "atom03:generator", "atom:generator"]],
        ['updated', 'date', ["pubDate", "rss1:pubDate", "lastBuildDate", "atom03:modified", "dc:date",
                             "dcterms:modified", "atom:updated"]],
        ['language', 'lang', ["language", "rss1:language", "xml:lang"]],

        ['{merge}', 'feed', ["rss1:channel"]],
        //and others Brief does not use anyway...
        //TODO: enclosures
        ['IGNORE', '', ["atom:id", "atom03:id", "atom:author", "atom03:author",
                        "category", "atom:category", "rss1:items"]],
    ],
    ENTRY_PROPERTIES: [
        ['title', 'text', ["title", "rss1:title", "atom03:title", "atom:title"]],
        ['link', 'url', ["link", "rss1:link"]],
        ['link', 'atomLinkAlternate', ["atom:link", "atom03:link"]],
        ['id', 'id', ["guid", "rss1:guid", "rdf:about", "atom03:id", "atom:id"]],
        ['authors[]', 'author', ["author", "rss1:author", "dc:creator", "dc:author",
                                  "atom03:author", "atom:author"]],
        //FIXME: _atomLinksToURI
        ['summary', 'text', ["description", "rss1:description", "dc:description",
                             "atom03:summary", "atom:summary"]],
        ['content', 'html', ["content:encoded", "atom03:content", "atom:content"]],

        ['published', 'date', ["pubDate", "rss1:pubDate",
                               "atom03:issued", "dcterms:issued", "atom:published"]],
        ['updated', 'date', ["pubDate", "rss1:pubDate", "atom03:modified",
                             "dc:date", "dcterms:modified", "atom:updated"]],
        //and others Brief does not use anyway...
        ['IGNORE', '', ["atom:category", "atom03:category", "category", "rss1:category",
                        "comments", "wfw:commentRss", "rss1:comments",
                        "dc:language", "dc:format", "xml:lang", "dc:subject",
                        "enclosure", "dc:identifier"
                       ]],
        // TODO: should these really be all ignored?
    ],
    AUTHOR_PROPERTIES: [
        ['name', 'text', ["name", "atom:name", "atom03:name"]],
        ['IGNORE', '', ["atom:uri", "atom:email"]],
    ],

    handlers: {
        entry(node) {
            let props = this._parseNode(node, this.ENTRY_PROPERTIES);
            if(props.link === undefined && props.guid !== undefined) {
                try {
                    props.link = new URL(props.guid); // Maybe a permalink as a GUID?
                } catch(e) { /* not the case */ }
            }
            return props;
        },

        feed(node) {
            return this._parseNode(node, this.FEED_PROPERTIES);
        },

        text(nodeOrAttr) {
            if(nodeOrAttr.children !== undefined) {
                for(let child of nodeOrAttr.childNodes) {
                    switch(child.nodeType) {
                        case Node.TEXT_NODE:
                        case Node.CDATA_SECTION_NODE:
                            continue;
                        default:
                            console.warn('possibly raw html in', nodeOrAttr);
                            break;
                    }
                }
                return nodeOrAttr.textContent.trim()
            } else {
                return nodeOrAttr.value.trim()
            }
        },

        html(nodeOrAttr) {
            return this.handlers.text.call(this, nodeOrAttr);
        },

        lang(nodeOrAttr) {
            return this.handlers.text.call(this, nodeOrAttr);
        },

        author(node) {
            if(node.children.length > 0) {
                return this._parseNode(node, this.AUTHOR_PROPERTIES);
            } else {
                return this.handlers.text.call(this, node);
            }
        },

        url(node) {
            try {
                return new URL(node.textContent);
            } catch(e) {
                console.warn('failed to parse URL', text)
            }
        },

        date(node) {
            let text = node.textContent;
            // Support for Z timezone marker for UTC (mb 682781)
            let date = new Date(text.replace(/z$/i, "-00:00"));
            if (!isNaN(date)) {
                return date.toUTCString();
            }
            console.warn('failed to parse date', text)
            return null;
        },

        id(nodeOrAttr) {
            return this.handlers.text.call(this, nodeOrAttr);
        },

        atomLinkAlternate(node) {
            let rel = node.getAttribute('rel') || 'alternate';
            let known = ['alternate', 'http://www.iana.org/assignments/relation/alternate'];
            if(known.includes(rel)) {
                return node.getAttribute('href') || undefined;
            }
        },
    },

    _nsPrefix(uri) {
        uri = uri || "";
        if(this.IGNORED_NAMESPACES[uri]) {
            return "IGNORE:";
        }
        if (uri.toLowerCase().indexOf("http://backend.userland.com") == 0) {
            return "";
        }
        let prefix = this.NAMESPACES[uri];
        if(prefix === undefined) {
            prefix = `[${uri}]`;
        }
        if(prefix) {
            return prefix + ":";
        } else {
            return "";
        }
    },

    NAMESPACES: {
        "": "",
        "http://webns.net/mvcb/": "admin",
        "http://backend.userland.com/rss": "",
        "http://blogs.law.harvard.edu/tech/rss": "",
        "http://www.w3.org/2005/Atom": "atom",
        "http://purl.org/atom/ns#": "atom03",
        "http://purl.org/rss/1.0/modules/content/": "content",
        "http://purl.org/dc/elements/1.1/": "dc",
        "http://purl.org/dc/terms/": "dcterms",
        "http://www.w3.org/1999/02/22-rdf-syntax-ns#": "rdf",
        "http://purl.org/rss/1.0/": "rss1",
        "http://my.netscape.com/rdf/simple/0.9/": "rss1",
        "http://wellformedweb.org/CommentAPI/": "wfw",
        "http://purl.org/rss/1.0/modules/wiki/": "wiki",
        "http://www.w3.org/XML/1998/namespace": "xml",
        "http://search.yahoo.com/mrss/": "media",
        "http://search.yahoo.com/mrss": "media",
    },
    IGNORED_NAMESPACES: {
        "http://www.w3.org/2000/xmlns/": "XML namespace definition",
        "http://purl.org/rss/1.0/modules/slash/": "Slashdot engine specific",
        "http://purl.org/rss/1.0/modules/syndication/": "Aggregator publishing schedule", // TODO: maybe use it?
        "http://www.livejournal.org/rss/lj/1.0/": "Livejournal metadata",
        "http://rssnamespace.org/feedburner/ext/1.0": "Feedburner metadata",
        "https://www.livejournal.com": "LJ",
        "com-wordpress:feed-additions:1": "wordpress",
    },
};
