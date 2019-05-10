import {Database} from "./database.js";
import {Prefs} from "./prefs.js";
import {Comm, wait, xhrPromise, getPluralForm} from "./utils.js";
import {fetchFeed} from "./feed-fetcher.js";


export let FeedUpdater = {
    UPDATE_TIMER_INTERVAL: 60000, // 1 minute
    FAVICON_REFRESH_INTERVAL: 14*24*60*60*1000, // 2 weeks

    FEED_ICON_URL: '/skin/brief-icon-32.png',

    queue: [],
    priority: [],
    underway: [],
    completed: [],

    updatedFeeds: new Map(),

    get active() {
        return this.queue.length + this.underway.length > 0;
    },

    get progress() {
        let total = this.completed.length + this.underway.length + this.queue.length;
        if(total === 0) {
            return 1.0;
        } else {
            return this.completed.length / total;
        }
    },

    async init() {
        /*spawn*/ this._scheduler();

        Comm.registerObservers({
            'update-all': () => this.updateAllFeeds(),
            'update-feeds': ({feeds}) => this.updateFeeds(feeds),
            'update-stop': () => this.stopUpdating(),
            'update-query-status': () => this._broadcastStatus(),
        });
        browser.notifications.onClicked.addListener(() => {
            browser.tabs.create({url: '/ui/brief.xhtml'});
        });
    },

    async updateFeeds(feeds, options) {
        let queueLength = this.queue.length;
        let {background} = options || {};
        if(!Array.isArray(feeds)) {
            feeds = [feeds];
        }
        //TODO: process folders recursively
        feeds = feeds.map(feed => feed.feedID || feed);
        // Enqueue the feeds that are not underway
        feeds = feeds.filter(feed => !this.underway.includes(feed));
        if(feeds.length === 0) {
            return;
        }
        for(let id of feeds) {
            if(!background && !this.priority.includes(id)) {
                this.priority.push(id);
            }
            if(!this.queue.includes(id)) {
                this.queue.push(id);
                this.completed = this.completed.filter(f => f != id);
            }
        }
        this._broadcastStatus();
        console.log(`Brief: enqueued ${this.queue.length - queueLength} feeds`);

        if(queueLength === 0) {
            /*spawn*/ this._worker();
        }
    },

    async updateAllFeeds(options) {
        let {background} = options || {};
        let feeds = Database.feeds.filter(f => !f.hidden && !f.isFolder);
        this.updateFeeds(feeds, {background});
    },

    async stopUpdating() {
        this.priority = [];
        this.queue = [];
        this.underway = [];
        this._finish();
        this._broadcastStatus();
    },

    async _scheduler() {
        await wait(Prefs.get('update.startupDelay'));
        while(true) { // eslint-disable-line no-constant-condition
            let now = Date.now();

            let globalUpdatingEnabled = Prefs.get('update.enableAutoUpdate');
            // Prefs are in seconds due to legacy
            let lastGlobalUpdate = Prefs.get('update.lastUpdateTime') * 1000;
            let nextGlobalUpdate = lastGlobalUpdate + (Prefs.get('update.interval') * 1000);

            let doGlobalUpdate = globalUpdatingEnabled && now > nextGlobalUpdate;
            if(doGlobalUpdate) {
                Prefs.set('update.lastUpdateTime', now / 1000);
            }

            let candidates = [];
            for(let feed of Database.feeds.filter(f => !f.hidden && !f.isFolder)) {
                let update;
                if(feed.updateInterval === 0) {
                    update = doGlobalUpdate;
                } else {
                    update = now > (feed.lastUpdated + feed.updateInterval);
                }
                if(update) {
                    candidates.push(feed);
                }
            }
            if(candidates.length !== 0) {
                console.log("Brief: scheduling feeds", candidates);
                this.updateFeeds(candidates, {background: true});
            }
            await wait(this.UPDATE_TIMER_INTERVAL);
        }
    },

    async _worker() {
        while(this.queue.length > 0) {
            // Get a feed for update...
            let feedID = this.priority.shift();
            if(feedID === undefined) {
                feedID = this.queue.shift();
            } else {
                this.queue = this.queue.filter(f => f != feedID);
            }
            this.underway.push(feedID);
            this._broadcastStatus();

            /*spawn*/ this.update(feedID)
                .catch(err => console.error('Brief: fetch error', err))
                .then(() => {
                    this.underway = this.underway.filter(f => f !== feedID);
                    this.completed.push(feedID);
                    this._broadcastStatus();
                    if(this.queue.length === 0 && this.underway.length === 0) {
                        this._finish();
                    }
                });

            if(this.queue.length === 0) {
                return;
            }
            if(this.priority.length > 0) {
                await wait(Prefs.get('update.defaultFetchDelay'));
            } else {
                await wait(Prefs.get('update.backgroundFetchDelay'));
            }
        }
    },

    async update(feedID) {
        let feed = Database.getFeed(feedID);
        if(feed === undefined) { // Deleted from DB while in queue?
            return;
        }

        let parsedFeed = await fetchFeed(feed);
        if(parsedFeed) {
            let pushResults = await Database.pushUpdatedFeed({feed, parsedFeed});
            let {newEntries} = pushResults;
            if(newEntries.length > 0) {
                let entryCount = this.updatedFeeds.get(feedID);
                if(entryCount === undefined) {
                    entryCount = 0;
                }
                entryCount += newEntries.length;
                this.updatedFeeds.set(feedID, entryCount);
            }
        }

        //Do we need to refresh the favicon?
        let nextFaviconRefresh = feed.lastFaviconRefresh + this.FAVICON_REFRESH_INTERVAL;
        feed = Database.getFeed(feedID); // Updated websiteURL
        if(!feed.favicon || feed.favicon === 'no-favicon' || Date.now() > nextFaviconRefresh) {
            /*spawn*/ FaviconFetcher.updateFavicon(feed);
        }
    },

    async _finish() {
        this.completed = [];
        console.log('Brief: update finished');

        let feedCount = this.updatedFeeds.size;
        let entryCount = Array.from(this.updatedFeeds.values()).reduce((a, b) => a + b, 0);
        let firstFeed = Array.from(this.updatedFeeds.keys())[0];
        this.updatedFeeds = new Map();

        if(!Prefs.get('update.showNotification') || feedCount === 0) {
            return;
        }


        let alertTitle = browser.i18n.getMessage('updateAlertTitle');

        let newForms = browser.i18n.getMessage('updateAlertText_new_pluralForms');
        let newString = getPluralForm(entryCount, newForms);

        let itemForms = browser.i18n.getMessage('updateAlertText_item_pluralForms');
        let itemString = getPluralForm(entryCount, itemForms);

        let feedForms = browser.i18n.getMessage('updateAlertText_feed_pluralForms');
        let feedString = getPluralForm(feedCount, feedForms);

        let alertText;

        if (feedCount == 1) {
            let feedTitle = Database.getFeed(firstFeed).title;
            feedTitle = feedTitle.length < 35 ? feedTitle : feedTitle.substr(0, 35) + '\u2026';

            alertText = browser.i18n.getMessage(
                'updateAlertText_singleFeedMessage', [feedTitle, newString, itemString]);
            alertText = alertText.replace('#numItems', entryCount);
        }
        else {
            alertText = browser.i18n.getMessage(
                'updateAlertText_multpleFeedsMessage', [newString, itemString, feedString]);
            alertText = alertText
                .replace('#numItems', entryCount)
                .replace('#numFeeds', feedCount);
        }
        browser.notifications.create({
            type: 'basic',
            title: alertTitle,
            message: alertText,
        });
    },

    _broadcastStatus() {
        Comm.broadcast('update-status', {
            active: this.active,
            progress: this.progress,
            underway: this.underway,
        });
    },
};


export let FaviconFetcher = {
    TIMEOUT: 25000,

    async updateFavicon(feed) {
        if(Comm.verbose) {
            console.log("Brief: fetching favicon for", feed);
        }
        let updatedFeed = {
            feedID: feed.feedID,
            lastFaviconRefresh: Date.now()
        };
        // Try, in order, to get a favicon from
        // 1. favicon.ico relative to the website URL
        // 2. the image specified in the document at the web site 
        // 3. the image specified in the document at the web site origin
        let faviconHardcodedURL = await this._fetchFaviconHardcodedURL(feed);
        if(faviconHardcodedURL) {
            updatedFeed.favicon = faviconHardcodedURL;
        } else {
            let faviconWebsiteURL = await this._fetchFaviconWebsiteURL(feed);
            if(faviconWebsiteURL) {
                updatedFeed.favicon = faviconWebsiteURL;
            } else {
                let faviconOriginURL = await this._fetchFaviconOriginURL(feed);
                if(faviconOriginURL) {
                    updatedFeed.favicon = faviconOriginURL;
                }
            }
        }
        await Database.modifyFeed(updatedFeed);
    },

    async _fetchFaviconHardcodedURL(feed) {
        if (!feed.websiteURL) {
            return;
        }

        // Use websiteURL instead of feedURL for resolving the favicon URL,
        // because many websites use services like Feedburner for generating their
        // feeds and we would get the Feedburner's favicon instead.
        let faviconURL = new URL('/favicon.ico', feed.websiteURL);

        let favicon = await this._fetchFaviconFromURL(feed, faviconURL);
        return favicon;
    },
    async _fetchFaviconWebsiteURL(feed) {
        if (!feed.websiteURL) {
            return;
        }

        let url = feed.websiteURL;
        let doc = await this._fetchDocFromURL(url);

        let faviconURL = this._getFaviconURLFromDoc(feed, doc);
        if (!faviconURL) {
            return;
        }

        let favicon = await this._fetchFaviconFromURL(feed, faviconURL);
        return favicon;

    },
    async _fetchFaviconOriginURL(feed) {
        if (!feed.websiteURL) {
            return;
        }
        let url = new URL(feed.websiteURL).origin;
        let doc = await this._fetchDocFromURL(url);

        let faviconURL = this._getFaviconURLFromDoc(feed, doc);
        if (!faviconURL) {
            return;
        }

        let favicon = await this._fetchFaviconFromURL(feed, faviconURL);
        return favicon;

    },

    async _fetchDocFromURL(url) {
        if (!url) {
            return;
        }
        let websiteRequest = new XMLHttpRequest();
        websiteRequest.open('GET', url);
        websiteRequest.responseType = 'document';

        let doc = await Promise.race([
            xhrPromise(websiteRequest).catch(() => undefined),
            wait(this.TIMEOUT),
        ]);
        return doc;
    },

    async _fetchFaviconFromURL(feed, faviconURL) {
        let response = await fetch(faviconURL, {redirect: 'follow'});

        if(!response.ok) {
            if(Comm.verbose) {
                console.log(
                    "Brief: failed to resolve favicon for feed ",
                    feed.title,
                    " at",
                    faviconURL.href);
            }
            return;
        }

        let blob = await response.blob();
        if(blob.size === 0) {
            if(Comm.verbose) {
                console.log(
                    "Brief: no response body when fetching favicon for feed ",
                    feed.title,
                    " at ",
                    faviconURL.href);
            }
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
    _getFaviconURLFromDoc(feed, doc) {
        if(!doc) {
            if(Comm.verbose) { 
                console.log(
                    "Brief: when attempting to locate favicon for ",
                    feed.title,
                    ", failed to fetch feed web site");
            }
            return;
        }

        if(doc.documentElement.localName === 'parseerror') {
            if(Comm.verbose) {
                console.log(
                    "Brief: when attempting to locate favicon for ",
                    feed.title,
                    ", failed to parse web site");
            }
            return;
        }
        let linkElements = doc.querySelector('link[rel="icon"], link[rel="shortcut icon"]');
        if(!linkElements) {
            if(Comm.verbose) { 
                console.log(
                    "Brief: when attempting to locate favicon for ",
                    feed.title,
                    ", found no related link elements in web site");
            }
            return;
        }
        let faviconURL = new URL(linkElements.getAttribute("href"),feed.websiteURL);
            
        if(!faviconURL) {
            if(Comm.verbose) {
                console.log(
                    "Brief: when attempting to locate favicon for ",
                    feed.title,
                    ", no favicon locations were found in the web site");
            }
            return;
        }

        return faviconURL;

    },
};