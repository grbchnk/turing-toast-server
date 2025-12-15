// backend/ai.js
require('dotenv').config();
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Инициализация
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

async function generateAiAnswer(question, playerAnswers) {
  try {
    // Если ответов людей нет (играешь один), добавляем фейковые для контекста
    const contextAnswers = playerAnswers.length > 0 
        ? playerAnswers 
        : ["хз ваще))", "ну типа того", "я не знаю ахахах"];

    // ПРОМПТ (Инструкция для нейросети)
    const prompt = `
      Ты играешь в социальную игру "Тест Тьюринга". Твоя цель — притвориться человеком и не быть пойманным.
      
      ВОПРОС: "${question}"
      
      Вот ответы других реальных игроков:
      ${contextAnswers.map(a => `- ${a}`).join('\n')}
      
      ИНСТРУКЦИЯ:
      1. Проанализируй стиль ответов игроков (длина, наличие смайликов, отсутствие заглавных букв, сленг, ошибки).
      2. Придумай СВОЙ ответ на вопрос.
      3. Твой ответ должен сливаться с толпой. Если они пишут коротко и с маленькой буквы — делай так же. Если они шутят абсурдно — шути так же.
      4. НЕ пиши литературно, если другие так не делают. НЕ будь полезным ассистентом. Будь "своим в доску".
      5. Если они успользуют юмор или нецензурную брань - используй тоже.
      6. Верни ТОЛЬКО текст ответа, без кавычек и пояснений.
    `;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    let text = response.text();

    // Чистим текст от лишних пробелов и кавычек, если AI их добавил
    return text.trim().replace(/^["']|["']$/g, '');

  } catch (error) {
    console.error("AI Error:", error);
    // Запасной вариант, если Google API упадет или ключ неверный
    const fallbacks = [
        "У меня инет лагает, ща...",
        "Блин, сложно придумать",
        "Да я хз даже что ответить",
        "Ну это смотря с какой стороны посмотреть"
    ];
    return fallbacks[Math.floor(Math.random() * fallbacks.length)];
  }
}

module.exports = { generateAiAnswer };
