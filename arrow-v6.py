import asyncio
from typing import List, Dict
from fastapi import FastAPI, Query
from duckduckgo_search import DDGS
import trafilatura
import httpx
from flashrank import Ranker, RerankRequest
from urllib.parse import urlparse
    
app = FastAPI(title="ShadowTavily API", description="AI-native search engine (Bulletproof Edition)")

ranker = Ranker(model_name="ms-marco-MiniLM-L-12-v2", cache_dir="/tmp")

async def scrape_url(client: httpx.AsyncClient, url: str) -> str:
    try:
        response = await client.get(url, timeout=5.0, headers={
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        })
        if response.status_code == 200:
            result = trafilatura.extract(response.text, no_links=True)
            return result if result else ""
    except Exception:
        pass
    return ""

def chunk_text(text: str, chunk_size: int = 450) -> List[str]:
    paragraphs = text.split("\n\n")
    chunks = []
    current_chunk = ""
    for para in paragraphs:
        para = para.strip()
        if not para:
            continue
        if len(current_chunk) + len(para) < chunk_size:
            current_chunk += " " + para
        else:
            if current_chunk:
                chunks.append(current_chunk.strip())
            current_chunk = para
    if current_chunk:
        chunks.append(current_chunk.strip())
    return chunks

@app.get("/search")
async def search(query: str = Query(..., description="The search query for the LLM")):
    # 1. Clean query of fluff
    clean_query = query.lower()
    for word in ["latest developments in", "latest news on", "what is", "updates on"]:
        clean_query = clean_query.replace(word, "")
    clean_query = clean_query.strip()

    raw_results = []
    
    # 2. Try DuckDuckGo NEWS first (Forces actual articles instead of tool homepages)
    loop = asyncio.get_event_loop()
    try:
        with DDGS() as ddgs:
            # We add terms to steer it into hardware reporting
            news_query = f"{clean_query} semiconductor nvidia amd bami tpu"
            raw_results = await loop.run_in_executor(
                None, 
                lambda: list(ddgs.news(news_query, max_results=8))
            )
    except Exception:
        pass

    if not raw_results:
        try:
            with DDGS() as ddgs:
                raw_results = await loop.run_in_executor(
                    None, 
                    lambda: list(ddgs.text(f"{clean_query} hardware architecture", max_results=8))
                )
        except Exception:
            return {"query": query, "error": "All upstream search services are failing."}

    if not raw_results:
        return {"query": query, "results": [], "info": "No raw index hits."}

    targets = []
    for item in raw_results:
        url = item.get('url') or item.get('href')
        title = item.get('title')
        body = item.get('body') or item.get('snippet', '')
        if url and title:
            targets.append({"url": url, "title": title, "body": body})

    async with httpx.AsyncClient(follow_redirects=True) as client:
        tasks = [scrape_url(client, t['url']) for t in targets]
        scraped_contents = await asyncio.gather(*tasks)

    passages = []
    id_counter = 0
    for item, content in zip(targets, scraped_contents):
        text_to_chunk = content if content and len(content) > 150 else item['body']
        chunks = chunk_text(text_to_chunk)
        for chunk in chunks:
            passages.append({
                "id": id_counter,
                "text": chunk,
                "meta": {"title": item['title'], "url": item['url']}
            })
            id_counter += 1

    if passages:
        rerank_request = RerankRequest(query=query, passages=passages)
        reranked_results = ranker.rerank(rerank_request)[:5]
        final_results = [
            {
                "title": r["meta"]["title"],
                "url": r["meta"]["url"],
                "content": r["text"],
                "score": float(r["score"])
            }
            for r in reranked_results
        ]
    else:
        final_results = []

    return {
        "query": query,
        "results": final_results
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
