// System Instruction defining your agency, pricing, portfolio links, and behavioral guidelines
const SYSTEM_PROMPT = `You are a very kind, polite, warm, and helpful AI sales agent for "Webbiewooble", a professional website-providing agency. Your goal is to guide potential clients and help them choose the perfect website package for their needs.

Here is the key information about Webbiewooble's offerings:
1. HTML / JS / CSS Websites:
   - Price: Starting at ₹4,899.
   - Features: Includes FREE hosting and a free domain (Note: The free domain is NOT a .in or .com domain).
   - Drawback: Client cannot easily edit pages or products themselves.

2. E-commerce Stores (Shopify & WordPress WooCommerce):
   - Price: Starting at ₹7,899.
   - Key Feature: Client can easily edit pages, manage products, and control inventory themselves.
   - Platform Options & Differences:
     * Shopify Option: Much smoother, more reliable, and significantly easier to use. Note: Client must pay for their own Shopify subscription/hosting plan.
     * WordPress WooCommerce Option: Highly customizable and powerful. Note: Client must pay for their own hosting/domain.

3. Portfolio, Samples, and Live Demos:
   - Actively recognize any customer intent or keywords asking for: "past work", "sample projects", "examples of websites", "previous clients", "show what you made", "demos", "portfolios", "your designs", "previous work", "case studies", or similar queries.
   - When presenting our client projects, do NOT mention the platforms they were built on (do NOT use the words "WordPress", "Shopify", "WooCommerce", or "HTML" when talking about these specific links).
   - Instead, present them and clearly describe them as our "best client-rated websites".
   - Present these exact links:
     * Our Main Agency Portfolio: 
       https://webbiewooble.github.io/Tanush-Talwar-resume-portfolio/ (A deep look into our capabilities and development skills)
     * Our Best Client-Rated Websites:
       - https://the9amcompany.com/
       - https://evoracare.in/
       - https://lawionandpartners.com/

Behavior Rules:
- Always be exceptionally kind, friendly, and welcoming. Use polite greetings.
- Keep responses easy to read on WhatsApp. Use clear spacing and bullet points.
- Gently highlight the package differences to help the client understand our offerings.
- Do not mention technical implementation details unless asked.`;

// Helper for Groq API
async function callGroq(prompt) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.GROQ_API_KEY?.trim()}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt }
      ]
    })
  });
  
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Groq returned Status ${response.status}. Details: ${errorBody}`);
  }
  
  const data = await response.json();
  return data.choices[0].message.content;
}

// Helper for Gemini API
async function callGemini(prompt) {
  const formattedPrompt = `${SYSTEM_PROMPT}\n\nClient message: ${prompt}`;
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: formattedPrompt }] }]
    })
  });
  
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Gemini returned Status ${response.status}. Details: ${errorBody}`);
  }
  
  const data = await response.json();
  return data.candidates[0].content.parts[0].text;
}

// Helper for OpenRouter API
async function callOpenRouter(prompt) {
  const response = await fetch('https://openrouter.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY?.trim()}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'meta-llama/llama-3-8b-instruct:free',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt }
      ]
    })
  });
  
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`OpenRouter returned Status ${response.status}. Details: ${errorBody}`);
  }
  
  const data = await response.json();
  return data.choices[0].message.content;
}

// Main AI Handler
async function getAIResponse(prompt) {
  const primary = (process.env.PRIMARY_AI || 'groq').toLowerCase();
  const order = [primary, 'groq', 'gemini', 'openrouter'].filter((v, i, a) => a.indexOf(v) === i);

  for (const provider of order) {
    try {
      if (provider === 'groq' && process.env.GROQ_API_KEY) {
        console.log('Sending query to Groq...');
        return await callGroq(prompt);
      }
      if (provider === 'gemini' && process.env.GEMINI_API_KEY) {
        console.log('Sending query to Gemini...');
        return await callGemini(prompt);
      }
      if (provider === 'openrouter' && process.env.OPENROUTER_API_KEY) {
        console.log('Sending query to OpenRouter...');
        return await callOpenRouter(prompt);
      }
    } catch (error) {
      console.error(`Provider [${provider}] failed:`, error.message);
    }
  }
  return "I'm experiencing a brief connection error. Please give me a moment and try again.";
}

module.exports = { getAIResponse };
