// backend/ai.js
require('dotenv').config();
const { GoogleGenerativeAI } = require("@google/generative-ai");

// --- НАСТРОЙКА GOOGLE ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// Используем стабильную версию 1.5, у нее большие лимиты
const googleModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// --- ВСПОМОГАТЕЛЬНАЯ ФУНКЦИЯ: ГЕНЕРАЦИЯ ПРОМПТА ---
function createPrompt(question, playerAnswers) {
    const contextAnswers = playerAnswers.length > 0 
        ? playerAnswers 
        : ["хз ваще))", "ну типа того", "я не знаю ахахах"];

    return `
      Ты играешь в социальную игру "Тест Тьюринга". Твоя цель — притвориться человеком и не быть пойманным.
      
      ИНСТРУКЦИЯ:
      1. Проанализируй стиль ответов игроков (длина, наличие смайликов, отсутствие заглавных букв, сленг, ошибки).
      2. Придумай СВОЙ ответ на вопрос.
      3. Твой ответ должен сливаться с толпой. Если они пишут коротко и с маленькой буквы — делай так же. Если они шутят абсурдно — шути так же.
      4. НЕ пиши литературно, если другие так не делают. НЕ будь полезным ассистентом. Будь "своим в доску".
      5. Если они используют юмор или нецензурную брань - используй тоже.
      6. Ответ должен быть на русском языке.
      7. Длина сообщения должна быть такой же, как и длина сообщений игроков.

      ВОПРОС: "${question}"
      
      Вот ответы других реальных игроков:
      ${contextAnswers.map(a => `- ${a}`).join('\n')}
      
      Верни ТОЛЬКО текст ответа, без кавычек и пояснений.
    `;
}

// --- ФУНКЦИЯ ЗАПРОСА К MISTRAL ---
async function callMistral(prompt) {
    if (!process.env.MISTRAL_API_KEY) throw new Error("No Mistral Key");

    const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${process.env.MISTRAL_API_KEY}`
        },
        body: JSON.stringify({
            model: "open-mistral-7b", // Актуальное название (бывший mistral-tiny)
            messages: [{ role: "user", content: prompt }],
            temperature: 0.9,
            max_tokens: 100
        })
    });

    if (!response.ok) {
        throw new Error(`Mistral API Error: ${response.statusText}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
}

// --- ГЛАВНАЯ ФУНКЦИЯ ---
async function generateAiAnswer(question, playerAnswers) {
  const prompt = createPrompt(question, playerAnswers);

  // 1. ПОПЫТКА ЧЕРЕЗ GOOGLE (ОСНОВНОЙ)
  try {
    const result = await googleModel.generateContent(prompt);
    const response = await result.response;
    let text = response.text();
    return text.trim().replace(/^["']|["']$/g, '');
  } catch (googleError) {
    console.warn("⚠️ Google API failed, switching to Mistral...", googleError.message);

    // 2. ПОПЫТКА ЧЕРЕЗ MISTRAL (ЗАПАСНОЙ)
    try {
        const mistralText = await callMistral(prompt);
        console.log("✅ Saved by Mistral AI");
        return mistralText.trim().replace(/^["']|["']$/g, '');
    } catch (mistralError) {
        console.error("❌ Both AIs failed:", mistralError.message);
        
        // 3. ЗАПАСНЫЕ ФРАЗЫ (ЕСЛИ ВСЕ УПАЛО)
        const fallbacks = [
            "У меня инет лагает, ща...",
            "Блин, сложно придумать",
            "Да я хз даже что ответить",
            "Ну это смотря с какой стороны посмотреть",
            "Ой, всё",
            "404 Brain not found"
        ];
        return fallbacks[Math.floor(Math.random() * fallbacks.length)];
    }
  }
}

module.exports = { generateAiAnswer };