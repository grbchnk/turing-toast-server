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
        : ["хз ваще))", "Ну типа того...", "Я не знаю ахахах"];

    return `
Ты играешь в социальную игру "Тест Тьюринга". Твоя цель — притвориться человеком и не быть пойманным.

ИНСТРУКЦИЯ:
1. Проанализируй стиль ответов игроков (длина, наличие эмодзи, сленг, ошибки).
2. Придумай СВОЙ ответ на вопрос.
3. Твой ответ должен сливаться с толпой. Если игроки пишут коротко — делай так же. Если пишут с большой буквы - пиши тоже с большой буквы. Если они шутят абсурдно — шути так же.
4. НЕ пиши литературно, если другие так не делают. НЕ будь полезным ассистентом. Будь "своим челиком".
5. Если они используют юмор или нецензурную брань - используй эту хуйню тоже.
6. Ответ должен быть на русском языке.
7. Длина сообщения должна быть такой же, как и длина сообщений игроков (не нужно выделяться).

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
            model: "open-mixtral-8x7b",
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

    console.log("🔍 Входящие ответы игроков:", prompt);

  // Вспомогательная функция для умной очистки кавычек
  const cleanResponse = (text) => {
      if (!text) return "";
      // 1. .replace(/["']/g, '') -> находит все " и ' и меняет их на пустоту
      // 2. .trim() -> убирает лишние пробелы по краям, если остались
      return text.replace(/["']/g, '').trim();
  };

  // 1. ПОПЫТКА ЧЕРЕЗ GOOGLE (ОСНОВНОЙ)
  try {
    const result = await googleModel.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    return cleanResponse(text); // <-- Используем новую функцию очистки
  } catch (googleError) {
    console.warn("⚠️ Google API failed, switching to Mistral...", googleError.message);

    // 2. ПОПЫТКА ЧЕРЕЗ MISTRAL (ЗАПАСНОЙ)
    try {
        const mistralText = await callMistral(prompt);
        console.log("✅ Saved by Mistral AI");
        return cleanResponse(mistralText); // <-- И здесь тоже
    } catch (mistralError) {
        console.error("❌ Both AIs failed:", mistralError.message);
        
        // 3. ЗАПАСНЫЕ ФРАЗЫ
        const fallbacks = [
            "У меня инет лагает, ща...",
            "Блин, сложно придумать",
            "Да я хз даже что ответить",
            "Ну это смотря с какой стороны посмотреть",
            "Ой, всё",
            "ошибка какая-то 404"
        ];
        return fallbacks[Math.floor(Math.random() * fallbacks.length)];
    }
  }
}

module.exports = { generateAiAnswer };