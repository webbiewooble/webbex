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
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!response.ok) throw new Error(`Groq HTTP error! status: ${response.status}`);
  const data = await response.json();
  return data.choices[0].message.content;
}

// Helper for Gemini API
async function callGemini(prompt) {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }]
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
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!response.ok) throw new Error(`OpenRouter HTTP error! status: ${response.status}`);
  const data = await response.json();
  return data.choices[0].message.content;
}

// Main AI Handler with seamless fallback capability
async function getAIResponse(prompt) {
  const primary = process.env.PRIMARY_AI || 'groq';
  
  // Create fallback order based on the user's primary choice
  const order = [primary, 'groq', 'gemini', 'openrouter'].filter((value, index, self) => self.indexOf(value) === index);

  for (const provider of order) {
    try {
      if (provider === 'groq' && process.env.GROQ_API_KEY) {
        console.log('Routing request to Groq...');
        return await callGroq(prompt);
      }
      if (provider === 'gemini' && process.env.GEMINI_API_KEY) {
        console.log('Routing request to Gemini...');
        return await callGemini(prompt);
      }
      if (provider === 'openrouter' && process.env.OPENROUTER_API_KEY) {
        console.log('Routing request to OpenRouter...');
        return await callOpenRouter(prompt);
      }
    } catch (error) {
      console.error(`Provider [${provider}] failed:`, error.message);
    }
  }
  return "I'm having trouble reaching my AI models at the moment. Please try again shortly.";
}

module.exports = { getAIResponse };
