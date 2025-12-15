// backend/ai.js
require('dotenv').config();
const { GoogleGenerativeAI } = require("@google/generative-ai");

// --- НАСТРОЙКА GOOGLE ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const googleModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

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
    const contextAnswers = playerAnswers.map(a => `- ${a}`).join('\n');

    return `
        Ты играешь в социальную игру "Тест Тьюринга". Твоя цель — притвориться человеком и не быть пойманным. 
        ИНСТРУКЦИЯ: 
        1. Проанализируй стиль ответов игроков (длина, наличие эмодзи, сленг, ошибки). 
        2. Придумай СВОЙ ответ на вопрос. 
        3. Твой ответ должен сливаться с толпой. Если они пишут коротко и с большой буквы — делай так же. 
        Если они шутят абсурдно — шути жестко как только можешь. 
        4. НЕ пиши литературно, если другие так не делают. НЕ будь полезным ассистентом. Будь "своим челиком". 
        5. Если они используют юмор или нецензурную брань - используй эту хуйню тоже. 
        6. Ответ должен быть на русском языке. 
        7. Длина сообщения должна быть такой же, как и длина сообщений игроков (не нужно выделяться). 

        ВОПРОС: "${question}" 

        Вот ответы других реальных игроков: ${contextAnswers} 

        Ты должен писать так же, как и они, ты должен замаскироваться под них.
        Верни ТОЛЬКО текст ответа, без кавычек и пояснений. ;
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
            "Хз",
            "Не знаю",
            "Сложно",
            "Эммм"
        ];
        return fallbacks[Math.floor(Math.random() * fallbacks.length)];
    }
  }
}

module.exports = { generateAiAnswer };