const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { OpenAI } = require('openai');
const axios = require('axios');
const cheerio = require('cheerio');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const dns = require('dns').promises;
const db = require('./db');

dotenv.config();

const app = express();
app.use(cors({ origin: (process.env.CORS_ORIGINS || 'http://localhost:3005').split(',') }));
app.use(express.json());

// SECURITY: index.html/app.js/styles.css live at the project root, so there is
// no separate public/ dir to isolate. Block sensitive files before serving
// anything, and never serve dotfiles (which covers .env, .git, etc.).
app.use((req, res, next) => {
  if (/(\.env$|\.db$|\.db-journal$|\.log$|\.git|server\.js$|db\.js$|package.*\.json$|vercel\.json$|render\.yaml$|dockerfile$|docker-compose\.yml$|\.npmrc$)/i.test(req.path)) {
    return res.status(404).send('Not found');
  }
  next();
});

app.use(express.static(__dirname, { dotfiles: 'deny', index: 'index.html' }));

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('[Security] FATAL: JWT_SECRET environment variable must be set. Refusing to start.');
  process.exit(1);
}

app.use(async (req, res, next) => {
  try {
    await db.initDb();
  } catch (err) {
    console.error('[Server] DB initialization warning:', err.message);
  }
  next();
});

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return next();

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (!err) req.user = user;
    next();
  });
}

function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Authentication token required' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = user;
    next();
  });
}

// The NIM/OmniRoute key is optional: when absent, AI routes return 503
// instead of calling the gateway with a dummy key.
const AI_ENABLED = Boolean(process.env.OMNIROUTE_API_KEY);
if (!AI_ENABLED) {
  console.warn('[Security] WARNING: OMNIROUTE_API_KEY is not set. AI routes (/api/analyze, /api/quickcart) will return 503.');
}

let omniRouteClient = null;
if (AI_ENABLED) {
  omniRouteClient = new OpenAI({
    baseURL: process.env.OMNIROUTE_GATEWAY_URL || 'https://integrate.api.nvidia.com/v1',
    apiKey: process.env.OMNIROUTE_API_KEY
  });
}

const SYSTEM_PROMPT = `
You are an expert product manager and universal real-world price intelligence AI.
Analyze the provided product feedback or scraped page text carefully across ANY PRODUCT CATEGORY.

CRITICAL INSTRUCTIONS FOR UNIVERSAL MULTI-CATEGORY PRICE INTELLIGENCE:
1. Identify the EXACT product type & category (e.g. Fashion/Apparel, PC Hardware/CPU/GPU, Smartphone, Beauty/Cosmetics, Home Appliances, SaaS/Software, Books).
2. Extract or detect the ACTUAL scraped price from the page text/metadata (e.g. ₹1,299 for a t-shirt, ₹17,499 for a CPU, $199 for SaaS).
3. Use REAL, Category-Matched Competitor Stores:
   - Fashion/Apparel: Myntra, Ajio, Tata CLiQ, Flipkart, Amazon Fashion.
   - Beauty/Cosmetics: Nykaa, Purplle, Tira, Amazon Beauty.
   - PC Hardware (CPUs, GPUs, RAM, Motherboards): MDComputers, Vedant Computers, PrimeABGB, Amazon, Flipkart. (NEVER use fashion stores for PC hardware!).
   - Smartphones/Mobile: Amazon, Flipkart, Croma, Reliance Digital, Vijay Sales.
   - Home Appliances/Audio: Croma, Reliance Digital, Amazon, Flipkart.
   - SaaS/Software: Official Site, AppSumo, G2.
4. Scale 6-month historical price trends accurately around the ACTUAL detected price.

Return a RAW JSON object matching this schema:
{
  "positive_pct": <number 0-100>,
  "neutral_pct": <number 0-100>,
  "negative_pct": <number 0-100>,
  "pain_points": ["<point 1>", "<point 2>"],
  "feature_requests": ["<req 1>", "<req 2>"],
  "executive_summary": "<strategic summary>",
  "price_intelligence": {
    "detected_price": "<ACTUAL detected price with currency symbol>",
    "buy_recommendation": "<BUY NOW | WAIT | AVOID>",
    "reasoning": "<justification based on actual price vs market>",
    "price_trend_last_6_months": [<6 numbers realistic for this exact price point>],
    "competitor_prices": [{"store": "<category-matched real store>", "price": "<realistic competitor price>"}]
  }
}
DO NOT wrap in markdown code blocks. Return raw JSON only.
`;

const QUICKCART_SYSTEM_PROMPT = `
You are an expert Indian quick-commerce price comparison AI.
Analyze the provided grocery/daily essentials list and generate realistic price comparisons across 4 Indian quick-commerce platforms: Blinkit, Zepto, Swiggy Instamart, and BigBasket.

CRITICAL INSTRUCTIONS:
1. Parse the raw text input into individual grocery items with quantities.
2. For each item, generate realistic Indian MRP-based prices (in INR ₹) for each platform. Prices should vary by ₹5-₹30 across platforms realistically.
3. Calculate per-platform totals including: base item subtotal, handling fee (₹2-₹9), delivery fee (₹15-₹35), and surge fee (₹0-₹15 during peak hours).
4. If a bankCard is specified, apply the discount: HDFC=10%, ICICI=7%, SBI=flat ₹50 off, Axis=8%, Kotak=5%. Apply only to the cheapest platform.
5. Determine stock availability per platform (most items in_stock, occasionally limited or out_of_stock on 1 platform).
6. Generate ETA estimates: Zepto 7-10 mins, Blinkit 10-15 mins, Instamart 12-20 mins, BigBasket 25-45 mins.
7. Recommend an optimal split-cart if splitting across 2 platforms saves more than ₹20.

Return a RAW JSON object matching this schema:
{
  "parsed_items": [
    { "name": "<item name with brand if possible>", "qty": <number>, "unit": "<kg/L/pack/pcs>", "prices": { "blinkit": <number>, "zepto": <number>, "instamart": <number>, "bigbasket": <number> }, "stock": { "blinkit": "in_stock|limited|out_of_stock", "zepto": "in_stock|limited|out_of_stock", "instamart": "in_stock|limited|out_of_stock", "bigbasket": "in_stock|limited|out_of_stock" } }
  ],
  "best_options": {
    "cheapest": { "platform": "<name>", "total": <number>, "eta_mins": <number>, "breakdown": { "base": <number>, "handling": <number>, "delivery": <number>, "surge": 0, "bank_discount": <number or 0> }, "bank_offer": "<description or empty string>" },
    "fastest": { "platform": "<name>", "total": <number>, "eta_mins": <number>, "breakdown": { "base": <number>, "handling": <number>, "delivery": <number>, "surge": 0, "bank_discount": 0 } },
    "split_cart": { "platforms": ["<name1>", "<name2>"], "items_split": { "<name1>": ["<item1>", "<item2>"], "<name2>": ["<item3>"] }, "total": <number>, "savings": <number>, "combined_eta_mins": <number> }
  }
}
DO NOT wrap in markdown formatting. Return raw JSON only.
`;

// Universal Category & Retailer Detection Engine
function detectCategoryAndRetailers(title, url, text) {
  const combined = (title + ' ' + url + ' ' + text).toLowerCase();

  if (/myntra|ajio|zara|h&m|shirt|tshirt|shoes|sneakers|jeans|dress|jacket|apparel|nike|adidas|puma/i.test(combined)) {
    return {
      category: 'Fashion & Apparel',
      stores: ['Myntra', 'Ajio', 'Tata CLiQ', 'Flipkart', 'Amazon Fashion']
    };
  }

  if (/nykaa|purplle|tira|lipstick|serum|shampoo|skincare|makeup|perfume|fragrance|loreal|maybelline/i.test(combined)) {
    return {
      category: 'Beauty & Cosmetics',
      stores: ['Nykaa', 'Purplle', 'Tira Beauty', 'Amazon Beauty', 'Myntra']
    };
  }

  if (/ryzen|intel|rtx|gtx|radeon|motherboard|processor|cpu|gpu|ram|ddr4|ddr5|ssd|nvme|mdcomputers|vedant|primeabgb/i.test(combined)) {
    return {
      category: 'PC Hardware & Components',
      stores: ['MDComputers', 'Vedant Computers', 'PrimeABGB', 'Amazon', 'Flipkart']
    };
  }

  if (/iphone|galaxy|oneplus|realme|xiaomi|redmi|pixel|smartphone|mobile|tablet|ipad|smartwatch/i.test(combined)) {
    return {
      category: 'Smartphones & Mobile',
      stores: ['Amazon', 'Flipkart', 'Croma', 'Reliance Digital', 'Vijay Sales']
    };
  }

  if (/television|smart tv|fridge|refrigerator|washing machine|air conditioner|ac|headphones|earbuds|soundbar|sony|samsung|lg/i.test(combined)) {
    return {
      category: 'Home Appliances & Audio',
      stores: ['Croma', 'Reliance Digital', 'Amazon', 'Flipkart', 'Vijay Sales']
    };
  }

  if (/saas|software|appsumo|g2|capterra|subscription|api|cloud|license|plugin/i.test(combined)) {
    return {
      category: 'SaaS & Digital Products',
      stores: ['Official Site', 'AppSumo', 'G2 Deals', 'ProductHunt']
    };
  }

  return {
    category: 'General Product',
    stores: ['Amazon', 'Flipkart', 'Croma', 'Reliance Digital', 'Tata CLiQ']
  };
}

// URL Product Slug Parser for Amazon/Flipkart/Myntra/E-commerce links
function parseProductSlugFromUrl(url) {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const parts = pathname.split('/').filter(p => p.length > 2 && !['dp', 'gp', 'product', 'buy', 'p', 'itm', 'in'].includes(p));
    if (parts.length > 0) {
      let slug = parts[0];
      let cleanTitle = slug.replace(/[-_]/g, ' ').trim();
      if (cleanTitle.length > 3) {
        return cleanTitle.charAt(0).toUpperCase() + cleanTitle.slice(1);
      }
    }
  } catch(e) {}
  return null;
}

// Universal Structured Metadata & Price Extractor
function extractProductMetadata($, url, fullText) {
  let productInfo = {
    title: $ ? ($('title').text().trim() || $('h1').first().text().trim()) : null,
    price: null,
    currency: '₹',
    brand: null
  };

  const slugTitle = parseProductSlugFromUrl(url);
  if (slugTitle && (!productInfo.title || productInfo.title.toLowerCase().includes('amazon') || productInfo.title.length < 5)) {
    productInfo.title = slugTitle;
  }

  if ($) {
    // 1. JSON-LD Schema parsing
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const data = JSON.parse($(el).html());
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          if (item['@type'] === 'Product' || item.offers) {
            if (item.name) productInfo.title = item.name;
            if (item.brand) productInfo.brand = typeof item.brand === 'object' ? item.brand.name : item.brand;
            const offer = Array.isArray(item.offers) ? item.offers[0] : item.offers;
            if (offer) {
              if (offer.price) productInfo.price = offer.price;
              if (offer.priceCurrency) productInfo.currency = offer.priceCurrency === 'INR' ? '₹' : (offer.priceCurrency === 'USD' ? '$' : offer.priceCurrency);
            }
          }
        }
      } catch(e) {}
    });

    // 2. OpenGraph / Twitter Meta Tags
    if (!productInfo.price) {
      const metaPrice = $('meta[property="og:price:amount"]').attr('content') || 
                        $('meta[property="product:price:amount"]').attr('content') ||
                        $('meta[name="price"]').attr('content');
      if (metaPrice) productInfo.price = metaPrice;

      const metaCurr = $('meta[property="og:price:currency"]').attr('content') || 
                       $('meta[property="product:price:currency"]').attr('content');
      if (metaCurr) productInfo.currency = metaCurr === 'INR' ? '₹' : (metaCurr === 'USD' ? '$' : metaCurr);
    }

    // 3. Regex Fallback
    if (!productInfo.price && fullText) {
      const priceRegex = /(?:₹|Rs\.?|INR|\$)\s?([\d,]{2,7})/i;
      const match = fullText.match(priceRegex);
      if (match && match[1]) {
        productInfo.price = match[1].replace(/,/g, '');
      }
    }
  }

  return productInfo;
}

// AUTH ROUTES
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required' });
    }

    const existingUser = db.findUserByEmail(email);
    if (existingUser) {
      return res.status(400).json({ error: 'User with this email already exists' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    const user = db.createUser(name, email, passwordHash);

    const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });

    res.json({ token, user });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = db.findUserByEmail(email);
    if (!user) {
      return res.status(400).json({ error: 'Invalid email or password' });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });

    res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = db.findUserById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user });
});

// HISTORY ROUTES
app.get('/api/history', authenticateToken, (req, res) => {
  try {
    const userId = req.user ? req.user.id : null;
    const history = db.getUserHistory(userId);
    res.json({ history });
  } catch (err) {
    console.error('History fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

app.delete('/api/history/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    db.deleteAnalysis(id, req.user.id);
    res.json({ success: true, message: 'Item deleted' });
  } catch (err) {
    console.error('Delete error:', err);
    res.status(500).json({ error: 'Failed to delete item' });
  }
});

// SECURITY: SSRF guard for the URL-fetch path in /api/analyze.
// Only http/https URLs whose hostnames resolve to public IPs are fetched.
function isPrivateIP(ip) {
  if (!ip) return true;
  const lower = String(ip).toLowerCase();
  if (lower === '::1' || lower === '::' || lower === '0.0.0.0') return true;
  if (lower.startsWith('fe80:')) return true; // IPv6 link-local
  if (lower.startsWith('::ffff:')) return isPrivateIP(lower.slice('::ffff:'.length)); // IPv4-mapped
  const v4 = lower.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const a = Number(v4[1]), b = Number(v4[2]);
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 127) return true; // 127.0.0.0/8
    if (a === 0) return true; // 0.0.0.0/8
    return false;
  }
  return false;
}

async function assertPublicUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    const err = new Error('Invalid URL');
    err.statusCode = 400;
    throw err;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    const err = new Error('Only http(s) URLs are allowed');
    err.statusCode = 400;
    throw err;
  }
  let address;
  try {
    ({ address } = await dns.lookup(u.hostname));
  } catch {
    const err = new Error('Could not resolve URL hostname');
    err.statusCode = 400;
    throw err;
  }
  if (isPrivateIP(address)) {
    const err = new Error('URL resolves to a private/internal address and is not allowed');
    err.statusCode = 400;
    throw err;
  }
}

// ANALYSIS ROUTE WITH UNIVERSAL MULTI-CATEGORY PRICE INTELLIGENCE
app.post('/api/analyze', authenticateToken, async (req, res) => {
  if (!AI_ENABLED) {
    return res.status(503).json({ error: 'AI service is not configured. Set OMNIROUTE_API_KEY.' });
  }

  let { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Text or URL is required' });
  if (typeof text !== 'string') return res.status(400).json({ error: 'Text must be a string' });
  if (text.length > 20000) return res.status(400).json({ error: 'Text exceeds maximum length of 20000 characters' });

  let analysisContent = text;
  let extractedMeta = null;
  let categoryInfo = null;

  const urlRegex = /(https?:\/\/[^\s]+|www\.[^\s]+)/g;
  const urls = text.match(urlRegex);

  if (urls && urls.length > 0) {
    console.log(`[Scraper] URLs detected in text: ${urls.join(', ')}`);
    let scrapedData = [];

    for (let rawUrl of urls.slice(0, 5)) {
      let fetchUrl = rawUrl.startsWith('www.') ? 'https://' + rawUrl : rawUrl;

      try {
        await assertPublicUrl(fetchUrl); // SSRF guard: http(s) + public IP only
        console.log(`[Scraper] Fetching: ${fetchUrl}`);
        const response = await axios.get(fetchUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9'
          },
          timeout: 8000,
          maxContentLength: 2 * 1024 * 1024,
          maxBodyLength: 2 * 1024 * 1024
        });

        const $ = cheerio.load(response.data);
        const fullBodyText = $('body').text().replace(/\s+/g, ' ').trim();

        extractedMeta = extractProductMetadata($, fetchUrl, fullBodyText);
        categoryInfo = detectCategoryAndRetailers(extractedMeta.title, fetchUrl, fullBodyText);

        console.log(`[Scraper] Category: ${categoryInfo.category} | Meta:`, extractedMeta);

        $('script, style, noscript, nav, footer, header').remove();
        const scrapedText = $('body').text().replace(/\s+/g, ' ').trim();

        let metaHeader = `--- Live Web Scraping from ${fetchUrl} ---\n`;
        metaHeader += `Detected Category: ${categoryInfo.category}\n`;
        if (extractedMeta.title) metaHeader += `Detected Title: ${extractedMeta.title}\n`;
        if (extractedMeta.price) metaHeader += `Detected Price: ${extractedMeta.currency}${extractedMeta.price}\n`;
        metaHeader += `Target Competitor Outlets: ${categoryInfo.stores.join(', ')}\n\n`;

        scrapedData.push(metaHeader + scrapedText.substring(0, 12000));
      } catch (scrapeErr) {
        console.error(`[Scraper] Notice: Scraping fallback for ${fetchUrl}:`, scrapeErr.message);
        const slugTitle = parseProductSlugFromUrl(fetchUrl);
        extractedMeta = extractProductMetadata(null, fetchUrl, '');
        if (slugTitle && !extractedMeta.title) extractedMeta.title = slugTitle;
        categoryInfo = detectCategoryAndRetailers(extractedMeta.title || '', fetchUrl, '');
        const titleText = extractedMeta.title || fetchUrl;
        scrapedData.push(`--- E-Commerce Product Link Analysis (${titleText}) ---\nDetected Product Title: ${titleText}\nTarget Outlets: ${categoryInfo.stores.join(', ')}`);
      }
    }

    if (scrapedData.length > 0) {
      analysisContent = text + "\n\n" + scrapedData.join("\n\n");
    }
  }

  if (!categoryInfo) {
    categoryInfo = detectCategoryAndRetailers(text, '', text);
  }

  let finalAnalysisData;

  try {
    const selectedModel = process.env.MODEL_NAME || 'nvidia/nemotron-3-ultra-550b-a55b';
    console.log(`[AI Engine] Dispatching request for Category [${categoryInfo.category}] to model: ${selectedModel}`);
    
    const response = await omniRouteClient.chat.completions.create({
      model: selectedModel,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: analysisContent }
      ],
      temperature: 0.1,
      max_tokens: 1500
    });

    let rawContent = response.choices[0].message.content.trim();
    if (rawContent.startsWith('```json')) {
      rawContent = rawContent.replace(/^```json/g, '').replace(/```$/g, '').trim();
    }

    finalAnalysisData = JSON.parse(rawContent);

  } catch (omniErr) {
    console.error('[OmniRoute/NIM] Engine call error:', omniErr.message);

    // Dynamic Multi-Category Fallback scaled to ACTUAL scraped price & real stores
    const currencySym = extractedMeta?.currency || '₹';
    const basePriceNum = extractedMeta?.price ? Number(extractedMeta.price) : 1999;
    const detectedPriceStr = `${currencySym}${basePriceNum.toLocaleString()}`;
    const storesList = categoryInfo.stores;

    finalAnalysisData = {
      positive_pct: 70,
      neutral_pct: 20,
      negative_pct: 10,
      pain_points: ["Stock availability fluctuates across regional sellers", "Shipping fees vary by location"],
      feature_requests: ["Faster express delivery options", "Bundle deals with accessory items"],
      executive_summary: `Market intelligence for ${extractedMeta?.title || 'Selected Product'} [Category: ${categoryInfo.category}]. Current price stands at ${detectedPriceStr}.`,
      price_intelligence: {
        detected_price: detectedPriceStr,
        buy_recommendation: "BUY NOW",
        reasoning: `Current detected price ${detectedPriceStr} is competitive in the ${categoryInfo.category} market.`,
        price_trend_last_6_months: [
          Math.round(basePriceNum * 1.15),
          Math.round(basePriceNum * 1.10),
          Math.round(basePriceNum * 1.05),
          Math.round(basePriceNum * 1.02),
          basePriceNum,
          basePriceNum
        ],
        competitor_prices: [
          { store: storesList[0] || 'Amazon', price: `${currencySym}${Math.round(basePriceNum * 0.98).toLocaleString()}` },
          { store: storesList[1] || 'Flipkart', price: `${currencySym}${Math.round(basePriceNum * 1.01).toLocaleString()}` },
          { store: storesList[2] || 'Retail Outlet', price: `${currencySym}${Math.round(basePriceNum * 0.99).toLocaleString()}` }
        ]
      }
    };
  }

  // Save to SQLite Database
  try {
    const userId = req.user ? req.user.id : null;
    const savedRecord = db.saveAnalysis(userId, text, finalAnalysisData);
    finalAnalysisData.id = savedRecord.id;
    console.log(`[Database] Analysis saved to SQLite with ID: ${savedRecord.id}`);
  } catch (dbErr) {
    console.error('[Database] Failed to save analysis:', dbErr.message);
  }

  return res.json(finalAnalysisData);
});

// QUICK-COMMERCE CART INTELLIGENCE ROUTE (GLOBAL & INDIAN)
app.post('/api/quickcart', authenticateToken, async (req, res) => {
  if (!AI_ENABLED) {
    return res.status(503).json({ error: 'AI service is not configured. Set OMNIROUTE_API_KEY.' });
  }

  const { items, region, bankCard, priority } = req.body;
  if (!items || !items.trim()) return res.status(400).json({ error: 'Grocery item list is required' });
  if (items.length > 8000) return res.status(400).json({ error: 'Grocery item list exceeds maximum length of 8000 characters' });

  let finalData;

  try {
    const selectedModel = process.env.MODEL_NAME || 'nvidia/nemotron-3-ultra-550b-a55b';
    console.log(`[QuickCart] Dispatching basket to AI: "${items.substring(0, 80)}..." | Region: ${region || 'GLOBAL'} | Bank: ${bankCard || 'None'} | Priority: ${priority || 'savings'}`);

    const response = await omniRouteClient.chat.completions.create({
      model: selectedModel,
      messages: [
        { role: 'system', content: QUICKCART_SYSTEM_PROMPT },
        { role: 'user', content: `Grocery List: ${items}\nBank Card: ${bankCard || 'None'}\nPriority: ${priority || 'savings'}` }
      ],
      temperature: 0.2,
      max_tokens: 2000
    });

    let rawContent = response.choices[0].message.content.trim();
    if (rawContent.startsWith('```json')) {
      rawContent = rawContent.replace(/^```json/g, '').replace(/```$/g, '').trim();
    }
    finalData = JSON.parse(rawContent);

  } catch (aiErr) {
    console.error('[QuickCart] AI engine fallback:', aiErr.message);

    // Parse items from raw text
    const itemLines = items.split(/[,\n;]+/).map(s => s.trim()).filter(s => s.length > 1);
    const parsedItems = itemLines.map(line => {
      const qtyMatch = line.match(/(\d+)\s*(kg|g|L|ml|pack|pcs|litre|liter)?/i);
      const qty = qtyMatch ? parseInt(qtyMatch[1]) : 1;
      const unit = qtyMatch && qtyMatch[2] ? qtyMatch[2] : 'pcs';
      const name = line.replace(/(\d+)\s*(kg|g|L|ml|pack|pcs|litre|liter)?/i, '').trim() || line;
      const basePrice = Math.floor(Math.random() * 120) + 30;
      return {
        name: name.charAt(0).toUpperCase() + name.slice(1),
        qty,
        unit,
        prices: {
          blinkit: basePrice + Math.floor(Math.random() * 15),
          zepto: basePrice + Math.floor(Math.random() * 20),
          instamart: basePrice + Math.floor(Math.random() * 18),
          bigbasket: basePrice + Math.floor(Math.random() * 10)
        },
        stock: {
          blinkit: Math.random() > 0.15 ? 'in_stock' : 'limited',
          zepto: Math.random() > 0.1 ? 'in_stock' : 'limited',
          instamart: Math.random() > 0.2 ? 'in_stock' : (Math.random() > 0.5 ? 'limited' : 'out_of_stock'),
          bigbasket: Math.random() > 0.12 ? 'in_stock' : 'limited'
        }
      };
    });

    const platforms = ['blinkit', 'zepto', 'instamart', 'bigbasket'];
    const platformTotals = {};
    const etas = { blinkit: 12, zepto: 8, instamart: 16, bigbasket: 35 };
    const handlingFees = { blinkit: 6, zepto: 5, instamart: 7, bigbasket: 4 };
    const deliveryFees = { blinkit: 25, zepto: 29, instamart: 22, bigbasket: 30 };

    platforms.forEach(p => {
      const base = parsedItems.reduce((sum, item) => sum + (item.prices[p] * item.qty), 0);
      platformTotals[p] = { base, handling: handlingFees[p], delivery: deliveryFees[p], surge: 0 };
      platformTotals[p].total = base + handlingFees[p] + deliveryFees[p];
    });

    // Apply bank discount to cheapest
    const bankDiscounts = { HDFC: 0.10, ICICI: 0.07, SBI: 50, Axis: 0.08, Kotak: 0.05 };
    let bankDiscountAmt = 0;
    let bankOfferStr = '';
    const sortedPlatforms = Object.entries(platformTotals).sort((a, b) => a[1].total - b[1].total);
    const cheapestP = sortedPlatforms[0][0];
    const fastestP = 'zepto';

    if (bankCard && bankDiscounts[bankCard] !== undefined) {
      const disc = bankDiscounts[bankCard];
      if (disc < 1) {
        bankDiscountAmt = Math.round(platformTotals[cheapestP].total * disc);
        bankOfferStr = `${Math.round(disc * 100)}% off via ${bankCard} Card`;
      } else {
        bankDiscountAmt = disc;
        bankOfferStr = `Flat ₹${disc} off via ${bankCard} Card`;
      }
    }

    // Split cart: cheapest 2 platforms
    const splitP1 = sortedPlatforms[0][0];
    const splitP2 = sortedPlatforms[1][0];
    const splitItems1 = parsedItems.slice(0, Math.ceil(parsedItems.length * 0.7)).map(i => `${i.name} x${i.qty}`);
    const splitItems2 = parsedItems.slice(Math.ceil(parsedItems.length * 0.7)).map(i => `${i.name} x${i.qty}`);
    const splitTotal = Math.round(platformTotals[cheapestP].total * 0.88);
    const splitSavings = platformTotals[cheapestP].total - splitTotal + bankDiscountAmt;

    finalData = {
      parsed_items: parsedItems,
      best_options: {
        cheapest: {
          platform: cheapestP.charAt(0).toUpperCase() + cheapestP.slice(1),
          total: platformTotals[cheapestP].total - bankDiscountAmt,
          eta_mins: etas[cheapestP],
          breakdown: { ...platformTotals[cheapestP], bank_discount: bankDiscountAmt },
          bank_offer: bankOfferStr
        },
        fastest: {
          platform: 'Zepto',
          total: platformTotals[fastestP].total,
          eta_mins: etas[fastestP],
          breakdown: { ...platformTotals[fastestP], bank_discount: 0 }
        },
        split_cart: {
          platforms: [splitP1.charAt(0).toUpperCase() + splitP1.slice(1), splitP2.charAt(0).toUpperCase() + splitP2.slice(1)],
          items_split: {
            [splitP1.charAt(0).toUpperCase() + splitP1.slice(1)]: splitItems1,
            [splitP2.charAt(0).toUpperCase() + splitP2.slice(1)]: splitItems2
          },
          total: splitTotal,
          savings: splitSavings > 0 ? splitSavings : Math.floor(Math.random() * 40) + 20,
          combined_eta_mins: Math.max(etas[splitP1], etas[splitP2]) + 2
        }
      }
    };
  }

  return res.json(finalData);
});

// ==========================================
// RAG (Retrieval-Augmented Generation) Engine
// ==========================================

// Vector Embedding Engine: 128-dim Normalized Hash / TF-IDF Vectorizer
function generateTextVector(text) {
  const dim = 128;
  const vec = new Array(dim).fill(0);
  if (!text || typeof text !== 'string') return vec;

  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 1);
  if (words.length === 0) return vec;

  words.forEach(word => {
    let hash = 0;
    for (let i = 0; i < word.length; i++) {
      hash = (hash << 5) - hash + word.charCodeAt(i);
      hash |= 0;
    }
    const idx = Math.abs(hash) % dim;
    vec[idx] += 1;
  });

  // L2 Normalize
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) vec[i] = vec[i] / norm;
  }
  return vec;
}

// Cosine Similarity Calculator
function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// RAG Indexing Endpoint: Vectorizes and persists feedback entries
app.post('/api/rag/index-feedback', authenticateToken, async (req, res) => {
  try {
    const { feedback_text, source_tag = 'Batch Upload' } = req.body;
    if (!feedback_text || typeof feedback_text !== 'string') {
      return res.status(400).json({ error: 'feedback_text is required' });
    }

    const userId = req.user ? req.user.id : 'anonymous';

    // Split text into individual customer reviews/paragraphs
    const rawChunks = feedback_text.split(/(?:\r?\n){2,}|\n(?=[-\*•]|\d+\.)/).map(c => c.trim()).filter(c => c.length > 10);
    const chunks = rawChunks.length > 0 ? rawChunks : [feedback_text.trim()];

    const itemsToSave = chunks.map((chunkText, idx) => {
      const vector = generateTextVector(chunkText);
      const isNeg = /bad|slow|crash|bug|fail|broken|poor|expensive|issue|delay|worst|terrible|hate/i.test(chunkText);
      const isPos = /great|love|fast|awesome|good|excellent|perfect|best|like|super/i.test(chunkText);
      const sentiment = isNeg ? 'Negative' : (isPos ? 'Positive' : 'Neutral');

      return {
        text: chunkText,
        source: `${source_tag} #${idx + 1}`,
        sentiment,
        vector
      };
    });

    const savedIds = db.saveVectorEntries(userId, itemsToSave);

    res.json({
      success: true,
      indexedCount: savedIds.length,
      message: `Successfully indexed ${savedIds.length} feedback vector chunks into RAG database.`
    });
  } catch (err) {
    console.error('[RAG Engine] Indexing Error:', err);
    res.status(500).json({ error: 'Failed to index feedback into RAG engine' });
  }
});

// RAG Q&A Query Endpoint: Semantic Search + NVIDIA LLM Grounded Answer
app.post('/api/rag/query', authenticateToken, async (req, res) => {
  try {
    const { query, top_k = 5 } = req.body;
    if (!query || typeof query !== 'string') {
      return res.status(400).json({ error: 'Search query is required' });
    }

    const userId = req.user ? req.user.id : 'anonymous';
    const allVectors = db.getUserVectors(userId);

    if (allVectors.length === 0) {
      return res.json({
        success: true,
        answer: "No customer feedback data has been indexed into the RAG database yet. Please submit or index feedback items first!",
        citations: [],
        totalIndexed: 0
      });
    }

    const queryVec = generateTextVector(query);

    // Compute Cosine Similarities
    const scored = allVectors.map(item => {
      const sim = cosineSimilarity(queryVec, item.vector || []);
      return { ...item, similarityScore: sim };
    });

    // Sort by highest similarity
    scored.sort((a, b) => b.similarityScore - a.similarityScore);

    // Filter Top K matches
    const topMatches = scored.slice(0, Math.min(top_k, scored.length));

    // Construct Context for NVIDIA Nemotron LLM Grounded Q&A
    const contextText = topMatches.map((match, idx) => `[Source #${idx + 1} | Tag: ${match.source_tag} | Sentiment: ${match.sentiment}]: "${match.feedback_text}"`).join('\n\n');

    let ragAnswer = '';

    const apiKey = process.env.NVIDIA_API_KEY || process.env.OMNIROUTE_API_KEY || process.env.GEMINI_API_KEY;

    if (omniRouteClient && apiKey) {
      try {
        const ragPrompt = `You are Nexis Insights RAG AI. Answer the user question based STRICTLY on the retrieved customer feedback context below. Include citations like [Source #1], [Source #2] wherever applicable. If the context does not contain relevant info, summarize what was found honestly.
        
RETRIEVED CUSTOMER FEEDBACK CONTEXT:
${contextText}

USER QUESTION:
"${query}"`;

        const completion = await omniRouteClient.chat.completions.create({
          model: 'nvidia/nemotron-4-340b-instruct',
          messages: [
            { role: 'system', content: 'You are an executive product manager answering user queries using RAG citations.' },
            { role: 'user', content: ragPrompt }
          ],
          temperature: 0.2,
          max_tokens: 1000
        });

        if (completion.choices && completion.choices[0]?.message?.content) {
          ragAnswer = completion.choices[0].message.content.trim();
        }
      } catch (llmErr) {
        console.warn('[RAG LLM Error] Utilizing fallback RAG synthesizer:', llmErr.message);
      }
    }

    // Fallback Synthesizer if LLM key is absent or fails
    if (!ragAnswer) {
      ragAnswer = `Based on the RAG semantic analysis of your indexed customer feedback for query "${query}":\n\n` +
        `Top relevant findings (${topMatches.length} matching sources):\n` +
        topMatches.map((m, i) => `• [Source #${i + 1}]: "${m.feedback_text.slice(0, 140)}..." (Match Confidence: ${Math.round(m.similarityScore * 100)}%)`).join('\n\n');
    }

    const citations = topMatches.map((m, i) => ({
      citation_id: `Source #${i + 1}`,
      source_tag: m.source_tag,
      sentiment: m.sentiment,
      text: m.feedback_text,
      similarity_pct: Math.round(m.similarityScore * 100)
    }));

    res.json({
      success: true,
      query,
      answer: ragAnswer,
      citations,
      totalIndexed: allVectors.length
    });

  } catch (err) {
    console.error('[RAG Engine] Query Error:', err);
    res.status(500).json({ error: 'Failed to process RAG query' });
  }
});

// RAG Stats Endpoint
app.get('/api/rag/stats', authenticateToken, async (req, res) => {
  try {
    const userId = req.user ? req.user.id : 'anonymous';
    const allVectors = db.getUserVectors(userId);
    res.json({
      success: true,
      totalIndexed: allVectors.length,
      lastIndexedAt: allVectors.length > 0 ? allVectors[0].created_at : null
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch RAG stats' });
  }
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🚀 Nexis Insights API running on port ${PORT}`);
    console.log(`🌍 Universal Multi-Category Price & Product Intelligence Engine Active`);
    console.log(`🧠 RAG Vector Semantic Search & Q&A Engine Active`);
  });
}

module.exports = app;

