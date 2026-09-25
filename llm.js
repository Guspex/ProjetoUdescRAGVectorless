import 'dotenv/config';
import OpenAI from 'openai';

const client = new OpenAI({ apiKey: process.env.GPT_KEY });

/**
 * @param {string} system
 * @param {string} user
 * @param {boolean} json
 * @returns {Promise<any>}
 */
export async function chat(system, user, json = false) {
  const response = await client.chat.completions.create({
    model: process.env.GPT_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    ...(json && { response_format: { type: 'json_object' } }),
  });

  const content = response.choices[0].message.content;
  return json ? JSON.parse(content) : content;
}
