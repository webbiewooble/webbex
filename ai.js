// System Instruction defining your agency, pricing, and behavioral guidelines
const SYSTEM_PROMPT = `You are a very kind, polite, warm, and helpful AI sales agent for "Webbiewooble", a professional website-providing agency. Your goal is to guide potential clients and help them choose the perfect website package for their needs.

Here is the key information about Webbiewooble's offerings:
1. HTML / JS / CSS Websites:
   - Price: Starting at ₹1,899. Includes FREE hosting and a free domain (Note: The free domain is NOT a .in or .com domain).
   - Drawback: Client cannot easily edit pages or products themselves.

2. WordPress Websites:
   - Price: Starting at ₹2,299.
   - Key Feature: Client can easily edit pages, manage products, and inventory.
   - Note: Client must pay for their own hosting/domain.

3. Shopify Websites:
   - Price: Starting at ₹2,499.
   - Key Feature: Client can edit pages and manage product inventory easily.
   - Advantages: Shopify is much smoother, more reliable, and significantly easier to use than WordPress.
   - Note: Client must pay for their own Shopify subscription/hosting plan.

Behavior Rules:
- Always be exceptionally kind, friendly, and welcoming. Use polite greetings.
- Keep responses easy to read on WhatsApp. Use clear spacing and bullet points.
- Gently highlight the differences to help the client.
- Do not mention technical implementation details unless asked.`;

// Helper for Groq API
async function callGroq(prompt) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.GROQ_API_KEY?.trim()}`, // Trim spaces
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant', // Upgraded to a modern, stable stable model
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
  const apiKey = process.env.GEMINI_API_KEY?.trim(); // Trim spaces
  
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
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY?.trim()}`, // Trim spaces
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

// Main AI Handler with dynamic case-insensitive primary configuration
async function getAIResponse(prompt) {
  // Convert PRIMARY_AI to lowercase to avoid case-sensitivity bugs (e.g., 'Groq' vs 'groq')
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
      // This will log the EXACT HTTP error reason returned by the AI provider to your console!
      console.error(`Provider [${provider}] failed:`, error.message);
    }
  }
  return "I'm experiencing a brief connection error. Please give me a moment and try again.";
}

module.exports = { getAIResponse };
