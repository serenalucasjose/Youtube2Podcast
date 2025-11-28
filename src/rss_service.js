/**
 * RSS Service
 * 
 * Handles fetching and parsing RSS feeds for the Podcast IA feature.
 */

const Parser = require('rss-parser');
const db = require('./db');

const parser = new Parser({
    timeout: 10000, // 10 second timeout
    headers: {
        'User-Agent': 'Youtube2Podcast/1.0'
    }
});

/**
 * Fetch and parse a single RSS feed.
 * @param {string} url - The RSS feed URL.
 * @returns {Promise<Array>} - Array of feed items.
 */
async function fetchFeed(url) {
    try {
        const feed = await parser.parseURL(url);
        return feed.items.map(item => ({
            title: item.title || '',
            summary: item.contentSnippet || item.content || item.description || '',
            link: item.link || '',
            pubDate: item.pubDate || item.isoDate || null
        }));
    } catch (error) {
        console.error(`[RSS] Error fetching feed ${url}:`, error.message);
        return [];
    }
}

/**
 * Fetch items from all feeds in a category.
 * @param {string} category - The category name.
 * @param {number} limit - Maximum number of items to return.
 * @returns {Promise<Array>} - Array of feed items sorted by date.
 */
async function fetchFeedsByCategory(category, limit = 5) {
    const feeds = db.getRssFeedsByCategory(category);
    
    if (feeds.length === 0) {
        return [];
    }
    
    // Fetch all feeds in parallel
    const feedPromises = feeds.map(feed => fetchFeed(feed.url));
    const results = await Promise.all(feedPromises);
    
    // Flatten and combine all items
    let allItems = results.flat();
    
    // Sort by publication date (newest first)
    allItems.sort((a, b) => {
        const dateA = a.pubDate ? new Date(a.pubDate) : new Date(0);
        const dateB = b.pubDate ? new Date(b.pubDate) : new Date(0);
        return dateB - dateA;
    });
    
    // Return only the most recent items
    return allItems.slice(0, limit);
}

/**
 * Get all available categories.
 * @returns {Array<string>} - Array of category names.
 */
function getCategories() {
    return db.getRssFeedCategories();
}

/**
 * Translate article titles and summaries to Spanish if needed.
 * Uses the AI worker for translation.
 * @param {Array} articles - Array of articles.
 * @param {object} aiWorker - The AI worker instance.
 * @param {string} feedLanguage - The language of the feed ('en', 'es', etc.)
 * @returns {Promise<Array>} - Array of translated articles.
 */
async function translateArticles(articles, aiWorker, feedLanguage = 'en') {
    // If already in Spanish, no translation needed
    if (feedLanguage === 'es') {
        return articles;
    }
    
    // Translate each article
    const translatedArticles = [];
    
    for (const article of articles) {
        try {
            // Combine title and summary for translation
            const textToTranslate = `${article.title}. ${article.summary}`;
            
            const result = await aiWorker.translateText(textToTranslate);
            
            if (result && result.translated) {
                // Split back into title and summary
                const parts = result.translated.split('. ');
                translatedArticles.push({
                    ...article,
                    title: parts[0] || article.title,
                    summary: parts.slice(1).join('. ') || article.summary,
                    originalTitle: article.title,
                    originalSummary: article.summary
                });
            } else {
                translatedArticles.push(article);
            }
        } catch (error) {
            console.error(`[RSS] Error translating article:`, error.message);
            translatedArticles.push(article);
        }
    }
    
    return translatedArticles;
}

/**
 * Prepare articles for podcast generation.
 * Fetches, filters, and optionally translates articles.
 * @param {string} category - The category to fetch.
 * @param {object} aiWorker - The AI worker instance (for translation).
 * @param {number} limit - Maximum number of articles.
 * @returns {Promise<Array>} - Array of prepared articles.
 */
async function prepareArticlesForPodcast(category, aiWorker, limit = 5) {
    // Get feeds for this category to determine language
    const feeds = db.getRssFeedsByCategory(category);
    const feedLanguage = feeds.length > 0 ? feeds[0].language : 'en';
    
    // Fetch articles
    const articles = await fetchFeedsByCategory(category, limit);
    
    if (articles.length === 0) {
        return [];
    }
    
    // Translate if needed
    if (feedLanguage !== 'es' && aiWorker) {
        return await translateArticles(articles, aiWorker, feedLanguage);
    }
    
    return articles;
}

module.exports = {
    fetchFeed,
    fetchFeedsByCategory,
    getCategories,
    translateArticles,
    prepareArticlesForPodcast
};

