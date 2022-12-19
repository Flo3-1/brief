import {Database} from "/modules/database.js";
import {Prefs} from "/modules/prefs.js";
import {FeedUpdater} from "/modules/updater.js";
import * as RequestMonitor from "/modules/request-monitor.js";
import {Comm, debounced} from "/modules/utils.js";


const Brief = {
    // Port for receiving status updates
    _statusPort: null,
    // Latest status
    _status: null,
    // Feeds in known windows
    _windowFeeds: new Map(),
    // Hooks for debugging
    prefs: Prefs,
    db: Database,
    comm: Comm,

    // Use Firefox built-in feed previews instead of Brief's
    // (cannot make the transition smooth otherwise - no access to the feed preview)
    _firefoxPreviewWorkaround: false,

    // No deinit required, we'll be forcefully unloaded anyway
    async init() {
        Comm.initMaster();

        // @ts-ignore Types do not know about the temporary flag
        // to make this available in chrome
        if (typeof browser === "undefined") {
            var browser = chrome;
        }
        chrome.runtime.onInstalled.addListener(async ({temporary}) => {
            if(temporary) { // `web-ext run` or equivalent
                Comm.verbose = true;
                const TEST_INDEX = chrome.runtime.getURL('/test/index.xhtml');
                let tabs = await chrome.tabs.query({url: TEST_INDEX});
                let debugging = (await chrome.tabs.query({}))
                    .some(({url}) => url === 'about:debugging');
                if(tabs.length === 0 && !debugging) {
                    chrome.tabs.create({url: TEST_INDEX});
                } else {
                    for(let {id} of tabs) {
                        chrome.tabs.reload(id);
                    }
                }
            }
        });

        if (typeof chrome.browserAction === "undefined") {
            chrome.browserAction = chrome.action;

        }

        chrome.browserAction.onClicked.addListener(
            () => chrome.tabs.create({url: '/ui/brief.xhtml'}));
        chrome.browserAction.setBadgeBackgroundColor({color: '#666666'});

        let menus;
        if (typeof chrome === "undefined") {
            menus = chrome.menus;
        } else {
            menus = chrome.contextMenus;
        }

        menus.create({
            id: "brief-button-refresh",
            title: chrome.i18n.getMessage("briefCtxRefreshFeeds_label"),
            contexts: ["browser_action"]
        });
        menus.create({
            id: "brief-button-mark-read",
            title: chrome.i18n.getMessage("briefCtxMarkFeedsAsRead_label"),
            contexts: ["browser_action"]
        });
        menus.create({
            id: "brief-button-show-unread",
            type: "checkbox",
            title: chrome.i18n.getMessage("briefCtxShowUnreadCounter_label"),
            contexts: ["browser_action"]
        });
        menus.create({
            id: "brief-button-options",
            title: chrome.i18n.getMessage("briefCtxShowOptions_label"),
            contexts: ["browser_action"]
        });

        //I have no idea what this does so it has to leave
        // TODO: find out whtat the purpose is
        //chrome.menus.onClicked.addListener(info => this.onContext(info));

        if (typeof chrome.runtime.getBrowserInfo !== "undefined") {
            let browserInfo = await chrome.runtime.getBrowserInfo();
            let baseVersion = browserInfo.version.split('.')[0];
            if (Number(baseVersion) < 64) { // Early Firefox 64 nightlies have previews too
                this._firefoxPreviewWorkaround = true;
                console.log("Enabling Firefox built-in feed preview detection");
            } else {
            /*spawn*/ RequestMonitor.init();
            }
        }

        await Prefs.init();

        Prefs.addObserver('showUnreadCounter', () => this._updateUI());
        Comm.registerObservers({
            'feedlist-updated': () => this._updateUI(),
            'entries-updated': debounced(100, () => this._updateUI()),
            'subscribe-get-feeds': ({windowId}) => this._windowFeeds.get(windowId),
            'subscribe-add-feed': ({feed}) => Database.addFeeds(feed).catch(console.error),
        });

        await Database.init();

        await FeedUpdater.init({db: Database});

        this._updateUI();
        // TODO: first run page

        chrome.tabs.onUpdated.addListener((id, change, tab) => {
            if(tab.active === false) {
                return;
            }
            this.queryFeeds({
                tabId: id,
                url: tab.url,
                title: tab.title,
                windowId: tab.windowId,
                status: tab.status,
            });
        });
        chrome.tabs.onActivated.addListener((ids) => this.queryFeeds(ids));
        let activeTabs = await chrome.tabs.query({active: true});
        for(let tab of activeTabs) {
            this.queryFeeds({
                tabId: tab.id,
                url: tab.url,
                title: tab.title,
                windowId: tab.windowId,
                status: tab.status,
            });
        }
    },

    onContext: function({menuItemId, checked=null}) {
        if (typeof browser === "undefined") {
            var browser = chrome;
        }
        switch(menuItemId) {
            case 'brief-button-refresh':
                Comm.broadcast('update-all');
                break;
            case 'brief-button-mark-read':
                Database.query().markRead(true);
                break;
            case 'brief-button-show-unread':
                Prefs.set('showUnreadCounter', checked);
                break;
            case 'brief-button-options':
                chrome.runtime.openOptionsPage();
                break;
        }
    },

    // Should match `extensions.webextensions.restrictedDomains` pref
    RESTRICTED_DOMAINS: new Set([
        "accounts-static.cdn.mozilla.net",
        "accounts.firefox.com",
        "addons.cdn.mozilla.net",
        "addons.mozilla.org",
        "api.accounts.firefox.com",
        "content.cdn.mozilla.net",
        "content.cdn.mozilla.net",
        "discovery.addons.mozilla.org",
        "input.mozilla.org",
        "install.mozilla.org",
        "oauth.accounts.firefox.com",
        "profile.accounts.firefox.com",
        "support.mozilla.org",
        "sync.services.mozilla.com",
        "testpilot.firefox.com",
    ]),

    BRIEF_SUBSCRIBE: new RegExp(
        "(chrome://brief/content/brief\\.(xul|xhtml)\\?subscribe=|brief://subscribe/)(.*)"),

    async queryFeeds({windowId, tabId, url=undefined, title=undefined, status=undefined}) {
        if (typeof browser === "undefined") {
            var browser = chrome;
        }
        let replies = [[]];
        let matchSubscribe = this.BRIEF_SUBSCRIBE.exec(url);
        if(matchSubscribe) {
            let url = decodeURIComponent(matchSubscribe.pop());
            Database.addFeeds({url});
            // @ts-ignore Types do not know that the tab ID is optional
            chrome.tabs.update({url: '/ui/brief.xhtml'});
        }
        try {
            replies = /** @type {{kind, url}[][]} */(await chrome.scripting.executeScript(tabId, {
                file: '/content_scripts/scan-for-feeds.js',
                runAt: 'document_end',
            }));
        } catch(ex) {
            if(ex.message === 'Missing host permission for the tab') {
                // There are a few known cases: about:, restricted (AMO) and feed preview pages
                if(url === undefined) {
                    ({url, title, status} = await chrome.tabs.get(tabId));
                }
                let {host, protocol} = new URL(url);
                if(url === undefined || protocol === 'about:' || protocol === 'view-source:') {
                    // Ok, looks like there's nothing Brief can do
                    // (feeds from AMO cannot be fetched)
                } else if(Brief.RESTRICTED_DOMAINS.has(host)) {
                    // FIXME: maybe try fetching them as `restricted.domain.com.`?
                } else if(/\.pdf$/.test(title)) {
                    // Heuristics: looks like the PDF viewer, probably not a feed, ignore
                } else if(status === 'loading') {
                    // Intermediate states during loading cause this message too
                } else {
                    // Assume this is a feed preview/subscribe page
                    // Note: Firefox 64+ no longer supports feed previews, so this is for 60ESR only
                    if(this._firefoxPreviewWorkaround) {
                        replies = [[{url, linkTitle: title, kind: 'self'}]];
                    }
                }
            } else if(ex.message === 'No matching message handler') {
                // Happens during tab restore / history navigation (transient states?)
            } else if(ex.message === 'Message manager disconnected') {
                // Happens during redirect-to-feed (transient states?)
            }
        }
        // Default: fallback to "this is not a feed page"
        if(replies === undefined) {
            replies = [[]];
        }
        let feeds = replies[0];
        /*if(feeds.length > 0) {
            // Redirecting from the Firefox preview mode looks just ugly, let's keep it the old way
            if(feeds[0].kind === 'self' && !this._firefoxPreviewWorkaround) {
                let target = encodeURIComponent(feeds[0].url);
                let previewUrl = "/ui/brief.xhtml?preview=" + target;
                chrome.tabs.update(tabId, {url: previewUrl, loadReplace: true});
            }
            chrome.pageAction.show(tabId);
            let path = null;
            if(feeds[0].kind === 'self') {
                path = '/icons/brief.svg#pulsing';
            }
            chrome.pageAction.setIcon({path, tabId});
        } else {
            chrome.pageAction.hide(tabId);
        }
		*/
        this._windowFeeds.set(windowId, feeds);
    },

    _updateUI: async function() {
        if (typeof browser === "undefined") {
            var browser = chrome;
        }
        let menus;
        if (typeof chrome === "undefined") {
            menus = chrome.menus;
        } else {
            menus = chrome.contextMenus;
        }

        let enabled = Prefs.get('showUnreadCounter');
        menus.update('brief-button-show-unread', {checked: enabled});
        if(enabled) {
            let count = await Database.query({
                deleted: 0,
                read: 0,
                includeFeedsExcludedFromGlobalViews: 0,
            }).count();
            let text = "";
            if(count > 0) {
                text = count.toString();
                // We crop the badge manually to leave the least-significant digits
                if (text.length > 4)
                    text = '..' + text.substring(text.length - 3);
            }
            chrome.browserAction.setBadgeText({text});
        } else {
            chrome.browserAction.setBadgeText({text: ""});
        }
        //TODO: return tooltip
        /*
            _updateStatus: async function Brief__updateStatus() {
                let updated = "";
                let bundle = Services.strings.createBundle('chrome://brief/locale/brief.properties');

                let lastUpdateTime = this.prefs.getIntPref('update.lastUpdateTime') * 1000;
                let date = new Date(lastUpdateTime);
                let relativeDate = new this.common.RelativeDate(lastUpdateTime);

                let time, pluralForms, form;
                let lang = Brief.window.navigator.language;

                switch (true) {
                    case relativeDate.deltaMinutes === 0:
                        updated = bundle.GetStringFromName('lastUpdated.rightNow');
                        break;

                    case relativeDate.deltaHours === 0:
                        pluralForms = bundle.GetStringFromName('minute.pluralForms');
                        form = this.common.getPluralForm(relativeDate.deltaMinutes, pluralForms);
                        updated = bundle.formatStringFromName('lastUpdated.ago', [form], 1)
                                            .replace('#number', relativeDate.deltaMinutes);
                        break;

                    case relativeDate.deltaHours <= 12:
                        pluralForms = bundle.GetStringFromName('hour.pluralForms');
                        form = this.common.getPluralForm(relativeDate.deltaHours, pluralForms);
                        updated = bundle.formatStringFromName('lastUpdated.ago', [form], 1)
                                            .replace('#number', relativeDate.deltaHours);
                        break;

                    case relativeDate.deltaDaySteps === 0:
                        time = date.toLocaleTimeString(lang, {hour: 'numeric', minute: 'numeric'});
                        updated = bundle.formatStringFromName('lastUpdated.today', [time], 1);
                        break;

                    case relativeDate.deltaDaySteps === 1:
                        time = date.toLocaleTimeString(lang, {hour: 'numeric', minute: 'numeric'});
                        updated = bundle.formatStringFromName('lastUpdated.yesterday', [time], 1);
                        break;

                    case relativeDate.deltaDaySteps < 7:
                        pluralForms = bundle.GetStringFromName('day.pluralForms');
                        form = this.common.getPluralForm(relativeDate.deltaDays, pluralForms);
                        updated = bundle.formatStringFromName('lastUpdated.ago', [form], 1)
                                            .replace('#number', relativeDate.deltaDays);
                        break;

                    case relativeDate.deltaYearSteps === 0:
                        date = date.toLocaleDateString(lang, {month: 'long', day: 'numeric'});
                        updated = bundle.formatStringFromName('lastUpdated.fullDate', [date], 1);
                        break;

                    default:
                        date = date.toLocaleDateString(lang, {
                            year: 'numeric', month: 'long', day: 'numeric'});
                        updated = bundle.formatStringFromName('lastUpdated.fullDate', [date], 1);
                        break;
                }

                let rows = [];

                let feeds_query = new Query({
                    deleted: false,
                    read: false,
                    sortOrder: 'library',
                    sortDirection: 'asc'
                })

                let unreadFeeds = await feeds_query.getProperty('feedID', true);

                let noUnreadText = "";
                if(unreadFeeds.length == 0)
                    noUnreadText = bundle.GetStringFromName('noUnreadFeedsTooltip');

                for (let feed of unreadFeeds) {
                    let feedName = Storage.getFeed(feed).title;
                    if(feedName.length > 24)
                        feedName = feedName.substring(0, 24) + "...";

                    let query = new Query({
                        deleted: false,
                        feeds: [feed],
                        read: false
                    })

                    rows.push(query.getEntryCount().then(count => `${count}\t\t${feedName}`));
                }
                rows = await Promise.all(rows);
                let tooltip = `${updated}\n\n${noUnreadText}${rows.join('\n')}`;
            },
         */
        //chrome.browserAction.setTitle({title: tooltip});
    },
};

Brief.init();

// Debugging hook
// @ts-ignore
if (typeof window !== "undefined"){
   	window.Brief = Brief;
}
