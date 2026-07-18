// Vercel serverless function — powers the "live" next-ferry lookup.
//
// Without any setup this simply returns no departures, and the app falls
// back to its built-in approximate schedule. To enable live, web-search-backed
// lookups: get a key from console.anthropic.com, then in your Vercel project
// go to Settings -> Environment Variables and add ANTHROPIC_API_KEY. Redeploy.
//
// The key stays server-side here and is never sent to the browser.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ departures: [], note: 'method not allowed' });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(200).json({ departures: [], note: 'no API key configured' });
    return;
  }

  try {
    const { originName, destName, nowISO } = req.body || {};
    const nowStr = new Date(nowISO || Date.now()).toLocaleString('en-AU', {
      timeZone: 'Australia/Brisbane',
      dateStyle: 'full',
      timeStyle: 'short',
    });

    const prompt = `Respond with ONLY raw JSON. No markdown fences, no commentary before or after.
Search the web (translink.com.au and jp.translink.com.au) for the current live or scheduled TransLink SMBI ferry departures from ${originName || 'Russell Island ferry terminal'}, Southern Moreton Bay, Queensland, Australia, heading toward ${destName || 'Redland Bay Marina'}.
Right now it is: ${nowStr} (Australia/Brisbane time).
Return the next up to 4 upcoming departure times after this exact moment, in this exact JSON shape:
{"departures":["8:00 AM","8:30 AM"],"note":""}
Use 12-hour time with AM/PM. If you cannot find reliable current data, return {"departures":[],"note":"unavailable"}.`;

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      }),
    });

    const data = await anthropicRes.json();
    const text = (data.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text);
    res.status(200).json(parsed);
  } catch (e) {
    res.status(200).json({ departures: [], note: 'lookup failed' });
  }
}
