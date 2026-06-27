// AI suggestions powered by Claude.
const Anthropic = require('@anthropic-ai/sdk');

let client;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

async function suggest({ listing, competitors, type }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return 'Add ANTHROPIC_API_KEY to backend/.env to enable AI suggestions.';
  }

  const competitorSummary = competitors.slice(0, 10).map(c =>
    `- "${c.title}" at ${c.price} (${c.location})`
  ).join('\n');

  const prompts = {
    title: `You are a copywriter helping sell items on Facebook Marketplace.
Current listing title: "${listing.title}"
Current price: ${listing.price}
Description: ${listing.description || '(none)'}

Competitor listings in this category:
${competitorSummary}

Suggest 3 better, more clickable titles that are concise and specific. Respond with only the 3 titles, one per line.`,

    description: `You are a copywriter for Facebook Marketplace.
Current title: "${listing.title}"
Current price: ${listing.price}
Current description: "${listing.description || '(none)'}"

Suggest an improved description (max 150 words) that highlights key selling points, builds trust, and drives inquiries. Respond with only the description.`,

    price: `You are a pricing strategist for Facebook Marketplace.
My listing: "${listing.title}" at ${listing.price}

Competitor prices:
${competitorSummary}

Suggest the optimal price to maximize inquiries while staying competitive. Give one price and a one-sentence reason.`,

    timing: `You are a Facebook Marketplace expert.
Based on general best practices and the fact that FB Marketplace peaks on evenings and weekends, when are the best times to post or re-post a listing for maximum visibility? Give 2-3 specific time windows and why.`,
  };

  const prompt = prompts[type] || prompts.title;

  const msg = await getClient().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  });

  return msg.content[0]?.text || '';
}

// Valid Facebook Marketplace top-level categories the AI must choose from.
const FB_CATEGORIES = [
  'Vehicles', 'Property Rentals', 'Apparel', 'Electronics', 'Entertainment',
  'Family', 'Free Stuff', 'Garden & Outdoor', 'Hobbies', 'Home Goods',
  'Home Improvement', 'Home Sales', 'Musical Instruments', 'Office Supplies',
  'Pet Supplies', 'Sporting Goods', 'Toys & Games', 'Furniture', 'Tools',
  'Appliances', 'Health & Beauty', 'Baby & Kids', 'Books, Movies & Music',
  'Cell Phones', 'Jewelry & Accessories', 'Arts & Crafts', 'Miscellaneous',
];

function parseJSONLoose(text) {
  // Strip code fences and grab the first {...} block.
  const cleaned = String(text).replace(/```json|```/gi, '').trim();
  const m = cleaned.match(/\{[\s\S]*\}/);
  try { return JSON.parse(m ? m[0] : cleaned); } catch (_) { return null; }
}

function avgCompetitorPrice(competitors) {
  const nums = competitors
    .map(c => parseFloat(String(c.price).replace(/[^0-9.]/g, '')))
    .filter(n => !isNaN(n) && n > 0);
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

// Compose a complete, optimized listing from minimal input. Falls back to a
// simple heuristic when no API key is configured, so it always returns usable
// fields.
async function composeListing({ title = '', notes = '', category = '', competitors = [] }) {
  const seed = (title || notes || 'Item for sale').trim();
  const avg  = avgCompetitorPrice(competitors);

  if (!process.env.ANTHROPIC_API_KEY) {
    // Heuristic fallback (no AI key).
    const guess = FB_CATEGORIES.find(c => seed.toLowerCase().includes(c.toLowerCase().split(' ')[0])) || category || 'Miscellaneous';
    return {
      title: seed.slice(0, 80),
      description: `${seed}.${notes ? ' ' + notes : ''}\n\nIn great condition and priced to sell. Message me if interested — serious buyers welcome!`,
      category: guess,
      condition: 'Used - Good',
      price: avg ? Math.max(1, Math.round(avg * 0.92)) : '',
      _ai: false,
    };
  }

  const compText = competitors.slice(0, 12)
    .map(c => `- "${c.title}" at ${c.price}${c.location ? ' (' + c.location + ')' : ''}`)
    .join('\n') || 'none available';

  const prompt = `You are an expert Facebook Marketplace seller who consistently outsells competitors.
Create a complete, optimized listing.

ITEM / SERVICE: "${seed}"
SELLER NOTES: ${notes || '(none)'}
CATEGORY HINT: ${category || '(none)'}
COMPETITOR LISTINGS (for pricing + differentiation):
${compText}

Goals: a scroll-stopping title, a persuasive description that builds trust and asks the buyer to message, the correct category, and a price that BEATS the competition while staying profitable (undercut the average competitor slightly unless that would be unreasonably low).

Choose the category from EXACTLY this list: ${FB_CATEGORIES.join(', ')}.
Condition must be one of: New, Used - Like New, Used - Good, Used - Fair.

Respond with ONLY valid JSON (no prose, no code fence) of the form:
{"title": "...", "description": "...", "category": "...", "condition": "...", "price": 0}`;

  const msg = await getClient().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 900,
    messages: [{ role: 'user', content: prompt }],
  });

  const parsed = parseJSONLoose(msg.content[0]?.text || '');
  if (!parsed) {
    return { title: seed.slice(0, 80), description: seed, category: category || 'Miscellaneous', condition: 'Used - Good', price: avg ? Math.round(avg * 0.92) : '', _ai: false };
  }
  // Validate category against the allowed list.
  if (!FB_CATEGORIES.includes(parsed.category)) {
    parsed.category = FB_CATEGORIES.find(c => c.toLowerCase() === String(parsed.category).toLowerCase())
      || category || 'Miscellaneous';
  }
  parsed._ai = true;
  return parsed;
}

module.exports = { suggest, composeListing, FB_CATEGORIES };
