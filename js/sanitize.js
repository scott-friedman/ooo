/**
 * HTML Sanitization Utilities
 * Prevents XSS attacks by sanitizing user-generated content
 */

(function(global) {
    'use strict';

    /**
     * Allowed HTML tags for rich content (admin-created pages)
     * These are safe tags that don't execute scripts
     */
    const ALLOWED_TAGS = [
        'p', 'br', 'hr',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'strong', 'b', 'em', 'i', 'u', 's', 'strike',
        'ul', 'ol', 'li',
        'blockquote', 'pre', 'code',
        'a', 'img',
        'table', 'thead', 'tbody', 'tr', 'th', 'td',
        'div', 'span',
        'sup', 'sub'
    ];

    /**
     * Allowed attributes for each tag
     */
    const ALLOWED_ATTRS = {
        'a': ['href', 'title', 'target', 'rel'],
        'img': ['src', 'alt', 'title', 'width', 'height'],
        'td': ['colspan', 'rowspan'],
        'th': ['colspan', 'rowspan'],
        '*': ['class', 'id'] // Allowed on all tags
    };

    /**
     * Dangerous URL protocols
     */
    const DANGEROUS_PROTOCOLS = ['javascript:', 'data:', 'vbscript:'];

    /**
     * Escape HTML entities - use this for plain text content
     * Escapes quotes too, so output is also safe inside attribute values.
     * @param {string} str - String to escape
     * @returns {string} Escaped string safe for innerHTML
     */
    function escapeHtml(str) {
        if (str === null || str === undefined) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /**
     * Check if a URL is safe (not javascript:, data:, etc.)
     * @param {string} url - URL to check
     * @returns {boolean} True if safe
     */
    function isSafeUrl(url) {
        if (!url) return true;
        const normalized = url.toLowerCase().trim();
        return !DANGEROUS_PROTOCOLS.some(proto => normalized.startsWith(proto));
    }

    /**
     * Sanitize HTML - allows safe tags, removes dangerous ones
     * Use this for admin-created rich content
     * @param {string} html - HTML string to sanitize
     * @returns {string} Sanitized HTML
     */
    function sanitizeHtml(html) {
        if (!html) return '';

        // Create a temporary container
        const temp = document.createElement('div');
        temp.innerHTML = html;

        // Process all elements
        sanitizeNode(temp);

        return temp.innerHTML;
    }

    /**
     * Recursively sanitize a DOM node
     * @param {Node} node - Node to sanitize
     */
    function sanitizeNode(node) {
        const children = Array.from(node.childNodes);

        for (const child of children) {
            if (child.nodeType === Node.TEXT_NODE) {
                // Text nodes are safe
                continue;
            }

            if (child.nodeType === Node.COMMENT_NODE) {
                // Remove comments (could contain IE conditional comments)
                node.removeChild(child);
                continue;
            }

            if (child.nodeType === Node.ELEMENT_NODE) {
                const tagName = child.tagName.toLowerCase();

                // Check if tag is allowed
                if (!ALLOWED_TAGS.includes(tagName)) {
                    // Remove dangerous tags completely (script, iframe, object, etc.)
                    if (['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'style', 'link', 'meta', 'base'].includes(tagName)) {
                        node.removeChild(child);
                        continue;
                    }
                    // For other disallowed tags, unwrap (keep content)
                    while (child.firstChild) {
                        node.insertBefore(child.firstChild, child);
                    }
                    node.removeChild(child);
                    continue;
                }

                // Sanitize attributes
                const attrs = Array.from(child.attributes);
                for (const attr of attrs) {
                    const attrName = attr.name.toLowerCase();

                    // Remove event handlers
                    if (attrName.startsWith('on')) {
                        child.removeAttribute(attr.name);
                        continue;
                    }

                    // Check if attribute is allowed for this tag
                    const allowedForTag = ALLOWED_ATTRS[tagName] || [];
                    const allowedForAll = ALLOWED_ATTRS['*'] || [];
                    if (!allowedForTag.includes(attrName) && !allowedForAll.includes(attrName)) {
                        child.removeAttribute(attr.name);
                        continue;
                    }

                    // Validate URLs in href and src
                    if ((attrName === 'href' || attrName === 'src') && !isSafeUrl(attr.value)) {
                        child.removeAttribute(attr.name);
                        continue;
                    }
                }

                // Add rel="noopener noreferrer" to external links
                if (tagName === 'a' && child.hasAttribute('href')) {
                    const href = child.getAttribute('href');
                    if (href && (href.startsWith('http://') || href.startsWith('https://'))) {
                        child.setAttribute('rel', 'noopener noreferrer');
                    }
                }

                // Recursively sanitize children
                sanitizeNode(child);
            }
        }
    }

    /**
     * Sanitize a URL for use in href/src attributes
     * @param {string} url - URL to sanitize
     * @returns {string} Safe URL or empty string
     */
    function sanitizeUrl(url) {
        if (!url) return '';
        if (!isSafeUrl(url)) return '';
        return url;
    }

    /**
     * Create a safe link element
     * @param {string} href - Link URL
     * @param {string} text - Link text
     * @param {boolean} external - Whether link is external
     * @returns {string} Safe HTML for the link
     */
    function createSafeLink(href, text, external = false) {
        const safeHref = sanitizeUrl(href);
        const safeText = escapeHtml(text);

        if (!safeHref) {
            return safeText; // Return just text if URL is unsafe
        }

        const attrs = external
            ? ` target="_blank" rel="noopener noreferrer"`
            : '';

        return `<a href="${escapeHtml(safeHref)}"${attrs}>${safeText}</a>`;
    }

    /**
     * Sanitize content for embedding in iframes (for mixcloud, bandcamp, etc.)
     * Only allows known safe embed domains
     * @param {string} url - URL to check
     * @param {string} type - Type of embed (mixcloud, bandcamp, etc.)
     * @returns {string} Safe URL or empty string
     */
    function sanitizeEmbedUrl(url, type) {
        if (!url) return '';

        const allowedDomains = {
            'mixcloud': ['player-widget.mixcloud.com', 'www.mixcloud.com'],
            'bandcamp': ['bandcamp.com'],
            'dropbox': ['dl.dropboxusercontent.com', 'www.dropbox.com', 'dropbox.com'],
            'audio': [] // Direct audio URLs - validate separately
        };

        // For audio type, just check it's not a dangerous protocol
        if (type === 'audio') {
            return isSafeUrl(url) ? url : '';
        }

        const domains = allowedDomains[type];
        if (!domains) return '';

        try {
            const parsed = new URL(url);
            const hostname = parsed.hostname.toLowerCase();

            if (domains.some(domain => hostname === domain || hostname.endsWith('.' + domain))) {
                return url;
            }
        } catch (e) {
            // Invalid URL
        }

        return '';
    }

    // Export functions
    global.Sanitize = {
        escapeHtml,
        sanitizeHtml,
        sanitizeUrl,
        createSafeLink,
        sanitizeEmbedUrl,
        isSafeUrl
    };

})(window);
