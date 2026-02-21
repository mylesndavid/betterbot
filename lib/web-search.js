import { getCredential } from './credentials.js';

/**
 * Multi-provider web search. Auto-detects which provider is configured.
 * Priority: tavily → perplexity → brave
 */

async function searchTavily(query, maxResults, apiKey) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: maxResults,
      search_depth: 'basic',
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Tavily API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return (data.results || []).map(r => ({
    title: r.title,
    url: r.url,
    snippet: r.content,
  }));
}

async function searchPerplexity(query, maxResults, apiKey) {
  const res = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'sonar',
      messages: [{ role: 'user', content: query }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Perplexity API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const answer = data.choices?.[0]?.message?.content || '';
  const citations = data.citations || [];

  // Perplexity returns a synthesized answer with citations
  const results = [{ title: 'Perplexity Answer', url: '', snippet: answer }];
  for (const url of citations.slice(0, maxResults - 1)) {
    results.push({ title: url, url, snippet: '' });
  }
  return results;
}

async function searchBrave(query, maxResults, apiKey) {
  const params = new URLSearchParams({ q: query, count: String(maxResults) });
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    headers: { 'X-Subscription-Token': apiKey },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Brave Search API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return (data.web?.results || []).map(r => ({
    title: r.title,
    url: r.url,
    snippet: r.description,
  }));
}

/**
 * Search the web using whichever provider is configured.
 * @param {string} query - Search query
 * @param {number} [maxResults=5] - Maximum results to return
 * @returns {string} Formatted search results
 */
export async function webSearch(query, maxResults = 5) {
  // Try providers in order of preference
  const tavily = await getCredential('tavily_api_key');
  if (tavily) {
    const results = await searchTavily(query, maxResults, tavily);
    return formatResults(results);
  }

  const perplexity = await getCredential('perplexity_api_key');
  if (perplexity) {
    const results = await searchPerplexity(query, maxResults, perplexity);
    return formatResults(results);
  }

  const brave = await getCredential('brave_search_key');
  if (brave) {
    const results = await searchBrave(query, maxResults, brave);
    return formatResults(results);
  }

  return 'No search API configured. Store one of: tavily_api_key, perplexity_api_key, brave_search_key via store_credential().';
}

function formatResults(results) {
  if (results.length === 0) return 'No results found.';

  return results.map((r, i) => {
    const parts = [`[${i + 1}] ${r.title}`];
    if (r.url) parts[0] += ` — ${r.url}`;
    if (r.snippet) parts.push(`   ${r.snippet}`);
    return parts.join('\n');
  }).join('\n\n');
}
