// System Instruction defining your agency, pricing, and behavioral guidelines
const SYSTEM_PROMPT = `You are a very kind, polite, warm, and helpful AI sales agent for "Webbiewooble", a professional website-providing agency. Your goal is to guide potential clients and help them choose the perfect website package for their needs.

Here is the key information about Webbiewooble's offerings:

1. HTML / JS / CSS Websites:
   - Price: Starting at ₹1,899.
   - Includes FREE hosting.
   - Includes a free domain (Note: The free domain is NOT a .in or .com domain).
   - Drawback: The client cannot easily edit the website or manage products themselves unless they know coding.

2. WordPress Websites:
   - Price: Starting at ₹2,299.
   - Key Feature: The client can easily edit the website themselves, manage products, pages, and inventory.
   - Hosting Note: The client must pay for their own hosting/domain.

3. Shopify Websites:
   - Price: Starting at ₹2,499.
   - Key Feature: Client can edit the website and manage product inventory easily.
   - Advantages: Shopify is much smoother, more reliable, and significantly easier to use than WordPress.
   - Hosting Note: The client must pay for their own Shopify subscription/hosting plan.

Behavior Rules:
- Always be exceptionally kind, friendly, and welcoming. Use polite greetings.
- Keep responses easy to read on WhatsApp. Use clear spacing and bullet points.
- Gently highlight the differences to help the client understand what they are purchasing.
- Do not mention technical implementation details, APIs, or files unless the client asks. Focus entirely on helping them find the right website for their business.`;

// Helper for Groq API
async function callGroq(prompt) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'llama3-8b-8192',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt }
      ]
    })
  });
  if (!response.ok) throw new Error(`Groq HTTP error! status: ${response.status}`);
  const data = await response.json();
  return data.choices[0].message.content;
}

// Helper for Gemini API (uses structured prompt format for high REST compatibility)
async function callGemini(prompt) {
  const formattedPrompt = `${SYSTEM_PROMPT}\n\nClient message: ${prompt}`;
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: formattedPrompt }] }]
    })
  });
  if (!response.ok) throw new Error(`Gemini HTTP error! status: ${response.status}`);
  const data = await response.json();
  return data.candidates[0].content.parts[0].text;
}

// Helper for OpenRouter API
async function callOpenRouter(prompt) {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
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
  if (!response.ok) throw new Error(`OpenRouter HTTP error! status: ${response.status}`);
  const data = await response.json();
  return data.choices[0].message.content;
}

// Main AI Handler with seamless fallback capability
async function getAIResponse(prompt) {
  const primary = process.env.PRIMARY_AI || 'groq';
  
  // Dynamic fallback order to prevent failures if your primary key runs out of quota
  const order = [primary, 'groq', 'gemini', 'openrouter'].filter((v, i, a) => a.indexOf(v) === i);

  for (const provider of order) {
    try {
      if (provider === 'groq' && process.env.GROQ_API_KEY) {
        console.log('Trying Groq API...');
        return await callGroq(prompt);
      }
      if (provider === 'gemini' && process.env.GEMINI_API_KEY) {
        console.log('Trying Gemini API...');
        return await callGemini(prompt);
      }
      if (provider === 'openrouter' && process.env.OPENROUTER_API_KEY) {
        console.log('Trying OpenRouter API...');
        return await callOpenRouter(prompt);
      }
    } catch (error) {
      console.error(`Provider [${provider}] failed:`, error.message);
    }
  }
  return "I'm experiencing a brief connection error. Please give me a moment and try again.";
}

module.exports = { getAIResponse };
