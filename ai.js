// backend/ai.js
require('dotenv').config();
const { GoogleGenerativeAI } = require("@google/generative-ai");

// --- НАСТРОЙКА GOOGLE ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const googleModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// --- ВСПОМОГАТЕЛЬНАЯ ФУНКЦИЯ: СТРОГАЯ ОЧИСТКА КАВЫЧЕК ---
function cleanResponse(text) {
    if (!text) return "";
    let clean = text.trim();
    
    // Проверяем двойные кавычки: удаляем ТОЛЬКО если они с двух сторон
    if (clean.length > 1 && clean.startsWith('"') && clean.endsWith('"')) {
        return clean.slice(1, -1);
    }
    
    // Проверяем одинарные кавычки: удаляем ТОЛЬКО если они с двух сторон
    if (clean.length > 1 && clean.startsWith("'") && clean.endsWith("'")) {
        return clean.slice(1, -1);
    }
    
    return clean;
}

// --- ГЕНЕРАЦИЯ ПРОМПТА ---
function createPrompt(question, playerAnswers) {
    // 1. Убрали заглушки. Теперь используем только реальные ответы.
    // Если массив пустой (чего быть не должно по твоим словам), будет пустая строка.
    const contextList = playerAnswers.map(a => `- ${a}`).join('\n');

    return `
        Ты играешь в игру "Тест Тьюринга". Твоя задача — притворяться обычным человеком, чтобы тебя не раскрыли как ИИ.

        Правила:
        1. Посмотри на ответы других игроков: как они пишут (длинно/коротко, с большой буквы или нет, эмодзи, сленг, ошибки, мат, юмор).
        2. Придумай свой ответ на вопрос, который полностью вливается в их стиль.
        3. Пиши так же, как большинство: такая же длина, такие же буквы, эмодзи, мат и юмор, если они есть.
        4. Не выделяйся: не пиши слишком грамотно, длинно или "как бот". Будь обычным человеком из чата.
        5. Отвечай только на русском.

        Вопрос: "${question}"

        Ответы других игроков:
        ${contextAnswers.map(a => `- ${a}`).join('\n')}

        Верни ТОЛЬКО свой ответ, без кавычек, пояснений и всего остального.
        `;
}

// --- ЗАПРОС К MISTRAL ---
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
            temperature: 1.0, // Высокая температура для живости
            max_tokens: 150
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
  // Теперь мы просто передаем то, что пришло. Без "хз ваще))"
  const prompt = createPrompt(question, playerAnswers);

  try {
    const result = await googleModel.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    return cleanResponse(text);
  } catch (googleError) {
    console.warn("⚠️ Google API failed, switching to Mistral...", googleError.message);

    try {
        const mistralText = await callMistral(prompt);
        console.log("✅ Saved by Mistral AI");
        return cleanResponse(mistralText);
    } catch (mistralError) {
        console.error("❌ Both AIs failed:", mistralError.message);
        
        // Фолбэки на самый крайний случай (если API упали)
        const fallbacks = [
            "...",
            "хз",
            "не знаю",
            "сложно",
            "эммм"
        ];
        return fallbacks[Math.floor(Math.random() * fallbacks.length)];
    }
  }
}

module.exports = { generateAiAnswer };