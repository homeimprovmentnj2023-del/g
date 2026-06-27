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

module.exports = { suggest };
