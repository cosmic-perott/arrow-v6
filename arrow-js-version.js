import express from 'express';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import axios from 'axios';
import { searchNews, searchText } from 'duckduckgo-search-scraped';
import { pipeline } from '@xenova/transformers';

const app = express();
const PORT = 8000;

let rankerPipeline;
async function initRanker() {
    console.log("Loading cross-encoder model...");
    rankerPipeline = await pipeline('text-classification', 'Xenova/ms-marco-MiniLM-L-6-v2');
    console.log("Model loaded successfully.");
}

async function scrapeUrl(url) {
    try {
        const response = await axios.get(url, {
            timeout: 5000,
            headers: {
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            }
        });

        if (response.status === 200) {
            const dom = new JSDOM(response.data, { url });
            const reader = new Readability(dom.window.document);
            const article = reader.parse();
            return article && article.textContent ? article.textContent.trim() : "";
        }
    } catch (error) {
    }
    return "";
}

function chunkText(text, chunkSize = 450) {
    const paragraphs = text.split("\n\n");
    const chunks = [];
    let currentChunk = "";

    for (let para of paragraphs) {
        para = para.strip ? para.strip() : para.trim();
        if (!para) continue;

        if (currentChunk.length + para.length < chunkSize) {
            currentChunk += " " + para;
        } else {
            if (currentChunk) chunks.push(currentChunk.trim());
            currentChunk = para;
        }
    }
    if (currentChunk) chunks.push(currentChunk.trim());
    return chunks;
}

app.get('/search', async (req, res) => {
    const query = req.query.query;
    if (!query) {
        return res.status(400).json({ error: "Query parameter 'query' is required." });
    }

    let cleanQuery = query.toLowerCase();
    const fluffWords = ["latest developments in", "latest news on", "what is", "updates on"];
    fluffWords.forEach(word => {
        cleanQuery = cleanQuery.replace(word, "");
    });
    cleanQuery = cleanQuery.trim();

    let rawResults = [];

    try {
        const newsQuery = `${cleanQuery} semiconductor nvidia amd bami tpu`;
        rawResults = await searchNews({ query: newsQuery, maxResults: 8 });
    } catch (e) {
    }

    if (!rawResults || rawResults.length === 0) {
        try {
            const textQuery = `${cleanQuery} hardware architecture`;
            rawResults = await searchText({ query: textQuery, maxResults: 8 });
        } catch (e) {
            return res.status(502).json({ query, error: "All upstream search services are failing." });
        }
    }

    if (!rawResults || rawResults.length === 0) {
        return res.json({ query, results: [], info: "No raw index hits." });
    }

    const targets = rawResults.map(item => ({
        url: item.url || item.href,
        title: item.title,
        body: item.body || item.snippet || ''
    })).filter(t => t.url && t.title);

    const scrapePromises = targets.map(t => scrapeUrl(t.url));
    const scrapedContents = await Promise.all(scrapePromises);

    const passages = [];
    let idCounter = 0;

    targets.forEach((item, index) => {
        const content = scrapedContents[index];
        const textToChunk = (content && content.length > 150) ? content : item.body;
        const chunks = chunkText(textToChunk);

        chunks.forEach(chunk => {
            passages.append ? passages.append() : passages.push({
                id: idCounter++,
                text: chunk,
                meta: { title: item.title, url: item.url }
            });
        });
    });

    let finalResults = [];
    if (passages.length > 0 && rankerPipeline) {
        try {
            const rerankPromises = passages.map(async (p) => {
                const result = await rankerPipeline(query, p.text); 
                return {
                    title: p.meta.title,
                    url: p.meta.url,
                    content: p.text,
                    score: result[0].score
                };
            });

            const evaluatedPassages = await Promise.all(rerankPromises);
            
            finalResults = evaluatedPassages
                .sort((a, b) => b.score - a.score)
                .slice(0, 5);

        } catch (err) {
            console.error("Error during reranking phase:", err);
        }
    }

    return res.json({
        query,
        results: finalResults
    });
});

initRanker().then(() => {
    app.listen(PORT, () => {
        console.log('Arrow listening at http://localhost:${PORT}`);
    });
});
