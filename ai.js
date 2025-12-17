require('dotenv').config();

// Константы
const MISTRAL_URL = "https://api.mistral.ai/v1/chat/completions";
const MODEL_NAME = "open-mixtral-8x7b";

// --- ГЕНЕРАЦИЯ ПРОМПТА ---
function createPrompt(question, playerAnswers) {
    return `
    Вопрос: "${question}"

    Ответы разных людей:
    ${playerAnswers.map(a => `- ${a}`).join('\n')}

    Напиши еще один ответ. Он должен быть похож на остальные по длине, стилю и оформлению (регистр букв, знаки препинания, юмор).
    Пришли ТОЛЬКО ответ:
    `;
}

// --- ГЛАВНАЯ ФУНКЦИЯ ---
async function generateAiAnswer(question, playerAnswers) {
    if (!process.env.MISTRAL_API_KEY) {
        console.error("❌ ОШИБКА: Не найден MISTRAL_API_KEY в .env");
        return "Админ забыл оплатить инет...";
    }

    const prompt = createPrompt(question, playerAnswers);

    try {
        const response = await fetch(MISTRAL_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${process.env.MISTRAL_API_KEY}`
            },
            body: JSON.stringify({
                model: MODEL_NAME,
                messages: [{ role: "user", content: prompt }],
                temperature: 1, 
                max_tokens: 100
            })
        });

        if (!response.ok) {
            throw new Error(`Статус ответа: ${response.status}`);
        }

        const data = await response.json();
        
        let answer = data.choices[0].message.content.trim();
        
        // ОЧИСТКА:
        answer = answer.replace(/^-\s*/, '')   // Убираем дефис в начале (если есть)
                       .replace(/["'`]/g, ''); // ⚠️ Убираем ВСЕ кавычки (", ', `) из всего текста

        return answer;

    } catch (error) {
        console.error("❌ Ошибка AI:", error.message);
        
        const fallbacks = [
            "У меня инет лагает, ща...",
            "Блин, сложно придумать",
            "Да я хз даже что ответить",
            "Ой, всё",
            "ошибка 404, мозг не найден"
        ];
        return fallbacks[Math.floor(Math.random() * fallbacks.length)];
    }
}

module.exports = { generateAiAnswer };