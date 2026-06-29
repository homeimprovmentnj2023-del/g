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

Suggest 3 better titles that are concise, specific, and POLICY-SAFE for Facebook Marketplace: neutral and descriptive of the item, with NO contact info, no service-ad/hype/urgency language (no "free quote", "same-day", "call/DM now", ALL-CAPS, "guaranteed", "best price"). Respond with only the 3 titles, one per line.`,

    description: `You are a copywriter for Facebook Marketplace.
Current title: "${listing.title}"
Current price: ${listing.price}
Current description: "${listing.description || '(none)'}"

Suggest an improved description (max 150 words) that is accurate, clear, and trustworthy while staying COMPLIANT with Facebook Marketplace Commerce Policies: neutral and factual, NO contact details, NO service-ad cues ("same-day", "free quote", "book now", "we come to you"), no hype/urgency/guarantees, minimal punctuation. Respond with only the description.`,

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

// ── Facebook Marketplace Commerce Policy compliance ──────────────────────────
// Guidance injected into every generation prompt so titles/descriptions read as
// neutral, factual item descriptions — not flaggable service advertisements.
const POLICY_GUIDANCE = `FACEBOOK MARKETPLACE COMMERCE POLICY COMPLIANCE — TOP PRIORITY:
Write a natural, neutral, factual description of what is offered. It must be clear and accurate, but conservative enough to minimize the chance Facebook flags or removes the listing. Strictly avoid:
- Contact details or off-platform contact: NO phone numbers, emails, URLs, social handles, or "call/text/DM/WhatsApp". If inviting contact at all, only "message for details" (Marketplace messaging).
- Service-advertisement cues: NO "same-day", "fast service", "book now", "free quote", "we come to you", "mention this ad", "free estimate", "limited spots".
- Hype / spam cues: NO ALL-CAPS words, no "!!!", minimal/zero emojis, no "act now", "today only", "limited time", "guaranteed", "100%", "#1", "cheapest", "best/lowest price".
- Discount/coupon bait: no "X% off", "today only", "free" used as bait.
- Unverifiable, medical, safety, or warranty claims.
Keep the title a concise, descriptive name of the item/offering (not a sales pitch). Keep the description plain, professional, and truthful.`;

// Phrase-level rewrites applied to EVERY generated title/description before it is
// saved (rule-based, so it works even with no API key).
const RISKY_REPLACEMENTS = [
  [/\bfree\s+(quote|estimate)\b/gi, ''],
  [/\bsame[-\s]?day\b/gi, ''],
  [/\bfast\s+service\b/gi, ''],
  [/\bbook(ing)?\s+(now|today)\b/gi, ''],
  [/\b(call|text|dm)\s+(me|us|now|today)\b/gi, ''],
  [/\bcall\s+or\s+message\b/gi, 'Message'],
  [/\bwe\s+come\s+to\s+you\b/gi, ''],
  [/\bmention\s+this\s+ad\b/gi, ''],
  [/\bact\s+now\b/gi, ''],
  [/\blimited\s+(time|spots?|offer)\b/gi, ''],
  [/\b(today|now)\s+only\b/gi, ''],
  [/\breserve\s+today\b/gi, ''],
  [/\bguarantee(d|s)?\b/gi, ''],
  [/\b100\s*%/gi, ''],
  [/\b(cheapest|lowest\s+price|best\s+price|unbeatable)\b/gi, 'fair price'],
  [/#1\b/gi, ''],
  [/\bwhats?app\b/gi, ''],
  [/\b\$?\d+\s*%\s*off\b/gi, ''],
  [/\bfree\b(?!\s*(stuff|standing))/gi, ''],
];

// Evaluate a generated title/description for policy risk and rewrite it to be
// safer, WITHOUT changing meaning. Always runs (no API key required).
function policySanitize(text, opts = {}) {
  let s = String(text || '');
  s = s.replace(/\b(\+?\d[\d\-.\s()]{7,}\d)\b/g, ' ');                 // phone numbers
  s = s.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, ' ');                     // emails
  s = s.replace(/\b(?:https?:\/\/)?[\w-]+\.(?:com|net|org|io|co|biz)\b\S*/gi, ' '); // urls
  for (const [re, rep] of RISKY_REPLACEMENTS) s = s.replace(re, rep);
  s = s.replace(/\b[A-Z]{4,}\b/g, w => w.charAt(0) + w.slice(1).toLowerCase()); // de-shout
  s = s.replace(/[!?]{2,}/g, '.').replace(/!+/g, '.');                 // calm punctuation
  // tidy separators/spacing left by removed phrases
  s = s.replace(/\s*([-|·,])\s*(?=[-|·,])/g, ' ');
  s = s.replace(/\s{2,}/g, ' ').replace(/\s+([.,;:])/g, '$1').replace(/\.{2,}/g, '.');
  // tidy dangling separators left where a risky phrase was removed (", ." -> ".")
  s = s.replace(/([,;:]\s*)+([.,;:])/g, '$2').replace(/,(\s*,)+/g, ',').replace(/\s{2,}/g, ' ');
  s = s.replace(/^[\s\-|·,.;:]+/, '').replace(/[\s\-|·,;:]+$/, '').trim();
  if (opts.isTitle) s = s.slice(0, 80).trim();
  return s;
}

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
    // Heuristic fallback (no AI key) — neutral, policy-conscious wording.
    const guess = FB_CATEGORIES.find(c => seed.toLowerCase().includes(c.toLowerCase().split(' ')[0])) || category || 'Miscellaneous';
    return {
      title: policySanitize(seed, { isTitle: true }),
      description: policySanitize(`${seed}.${notes ? ' ' + notes : ''} In good condition. Message for more information.`),
      category: guess,
      condition: 'Used - Good',
      price: avg ? Math.max(1, Math.round(avg * 0.92)) : '',
      _ai: false,
    };
  }

  const compText = competitors.slice(0, 12)
    .map(c => `- "${c.title}" at ${c.price}${c.location ? ' (' + c.location + ')' : ''}`)
    .join('\n') || 'none available';

  const prompt = `You are an expert Facebook Marketplace seller. Create a complete listing that is accurate and effective but, above all, COMPLIANT with Facebook Marketplace Commerce Policies.

${POLICY_GUIDANCE}

ITEM / OFFERING: "${seed}"
SELLER NOTES: ${notes || '(none)'}
CATEGORY HINT: ${category || '(none)'}
COMPETITOR LISTINGS (for pricing context only):
${compText}

Goals: a clear, descriptive, neutral title; a calm, factual, trustworthy description that accurately describes the offering without sounding like an advertisement; the correct category; and a fair, competitive price (around the competitor average, not a suspicious lowball).

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
    return { title: policySanitize(seed, { isTitle: true }), description: policySanitize(seed), category: category || 'Miscellaneous', condition: 'Used - Good', price: avg ? Math.round(avg * 0.92) : '', _ai: false };
  }
  // Validate category against the allowed list.
  if (!FB_CATEGORIES.includes(parsed.category)) {
    parsed.category = FB_CATEGORIES.find(c => c.toLowerCase() === String(parsed.category).toLowerCase())
      || category || 'Miscellaneous';
  }
  // Policy pass: have the model evaluate + rewrite for compliance, then a
  // deterministic sanitizer as a final safety net before saving.
  const reviewed = await policyReview({ title: parsed.title, description: parsed.description });
  parsed.title = policySanitize(reviewed.title || parsed.title, { isTitle: true });
  parsed.description = policySanitize(reviewed.description || parsed.description);
  parsed._ai = true;
  parsed._policyChecked = true;
  return parsed;
}

// Second-pass compliance reviewer: evaluate a generated title/description for
// Facebook Marketplace policy risk and rewrite it to be safer while preserving
// the meaning. Falls back to the original (callers still run policySanitize).
async function policyReview({ title = '', description = '' }) {
  if (!process.env.ANTHROPIC_API_KEY) return { title, description };
  const prompt = `${POLICY_GUIDANCE}

Review the listing below. If anything could cause Facebook Marketplace to flag or remove it (especially language that reads like a service advertisement, contact info, hype, urgency, or claims), REWRITE it to be neutral and policy-safe while keeping it accurate and clear. If it is already compliant, return it unchanged.

TITLE: "${title}"
DESCRIPTION: "${description}"

Respond with ONLY valid JSON: {"title":"...","description":"..."}`;
  try {
    const msg = await getClient().messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 700,
      messages: [{ role: 'user', content: prompt }],
    });
    const parsed = parseJSONLoose(msg.content[0]?.text || '');
    if (parsed && (parsed.title || parsed.description)) {
      return { title: parsed.title || title, description: parsed.description || description };
    }
  } catch (_) { /* keep original; sanitizer still applies */ }
  return { title, description };
}

// Produce a FRESH variation of a listing's title + description so repeated
// posts aren't identical text (helps avoid duplicate detection). Keeps the same
// item/meaning. Heuristic fallback when no API key.
async function varyListing({ title = '', description = '', category = '', competitors = [] }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    const closers = ['Great condition.', 'Ready to go.', 'Serious buyers welcome.',
      'Message me for details.', 'Priced to sell.', 'Don\'t miss out.', 'Available now.'];
    const adjectives = ['Nice', 'Clean', 'Quality', 'Great'];
    const extra = closers[Math.floor(Math.random() * closers.length)];
    const desc = (description && description.trim()) ? `${description.trim()} ${extra}` : extra;
    // Lightly vary the title with a leading adjective ~half the time.
    const t = Math.random() < 0.5 ? `${adjectives[Math.floor(Math.random() * adjectives.length)]} ${title}` : title;
    return { title: t.slice(0, 100), description: desc, _ai: false };
  }
  const prompt = `Rewrite this Facebook Marketplace listing as a FRESH variation so it is not word-for-word identical to previous posts, while keeping the SAME item, meaning, and accuracy.

${POLICY_GUIDANCE}

Title: "${title}"
Description: "${description || '(none)'}"
Category: ${category || '(none)'}

Rules: keep the title an accurate, neutral, descriptive name under 80 characters; keep the description short (1-3 plain, factual sentences), neutral in tone, with no service-ad/contact/hype language. Do not invent specs that aren't implied.
Respond ONLY as JSON: {"title":"...","description":"..."}`;

  try {
    const msg = await getClient().messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    });
    const parsed = parseJSONLoose(msg.content[0]?.text || '');
    if (!parsed || !parsed.title) return { title: policySanitize(title, { isTitle: true }), description: policySanitize(description), _ai: false };
    return { title: policySanitize(String(parsed.title), { isTitle: true }), description: policySanitize(String(parsed.description || description)), _ai: true };
  } catch (_) {
    return { title: policySanitize(title, { isTitle: true }), description: policySanitize(description), _ai: false };
  }
}

module.exports = { suggest, composeListing, varyListing, policySanitize, FB_CATEGORIES };
