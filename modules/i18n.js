// Perform substitutions for i18n in text and attributes
export function apply_i18n(doc) {
    for(let node of doc.querySelectorAll('[data-i18n]')) {
        let text = chrome.i18n.getMessage(node.dataset.i18n) || node.dataset.i18n;
        if(node.dataset.i18nAllowMarkup !== undefined) {
            node.insertAdjacentHTML('beforeend', text);
        } else {
            node.insertAdjacentText('beforeend', text);
        }
    }
    for(let node of doc.querySelectorAll('[data-i18n-attrs]')) {
        for(let substitution of node.dataset.i18nAttrs.trim().split(/\s+/g)) {
            let [attr, text] = substitution.split(':');
            text = chrome.i18n.getMessage(text) || text;
            node.setAttribute(attr, text);
        }
    }
}

// TODO: access key highlighting
