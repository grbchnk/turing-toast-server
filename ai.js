// ai.js
require('dotenv').config();

// ==========================================
// 1. ГЛОБАЛЬНЫЕ ПАРАМЕТРЫ (КОНСТАНТЫ)
// ==========================================
const MISTRAL_URL = "https://api.mistral.ai/v1/chat/completions";
const MODEL_NAME = "open-mixtral-8x7b";

// Параметры гуманизации
const MSG_ERROR_CHANCE = 0.2;       // Шанс, что сообщение будет "испорчено"
const WORD_ERROR_CHANCE = 0.1;      // Шанс ошибки в конкретном слове
const COMMA_ERROR_CHANCE = 0.3;     // Шанс смещения пробела у запятой
const MISSING_SPACE_CHANCE = 0.05;  // Шанс слипания слов
const COMMA_DELETE_CHANCE = 0.8;    // Шанс удаления конкретной запятой

// ==========================================
// 2. СПРАВОЧНЫЕ ДАННЫЕ (KEYBOARD MAP)
// ==========================================
// Карта соседей для имитации промахов (RU + EN)
const KEYBOARD_LAYOUT = {
    // RU
    'й': ['ц', 'ф', 'ы', '1', '2'], 'ц': ['й', 'у', 'ы', 'в', 'ф'], 'у': ['ц', 'к', 'в', 'а', 'ы'], 'к': ['у', 'е', 'а', 'п', 'м'], 'е': ['к', 'н', 'п', 'р'], 'н': ['е', 'г', 'р', 'о'], 'г': ['н', 'ш', 'о', 'л'], 'ш': ['г', 'щ', 'л', 'д'], 'щ': ['ш', 'з', 'д', 'ж'], 'з': ['щ', 'х', 'ж', 'э'], 'х': ['з', 'ъ', 'э'], 'ъ': ['х', 'э'],
    'ф': ['й', 'ц', 'ы', 'я'], 'ы': ['ц', 'у', 'ф', 'в', 'я', 'ч'], 'в': ['у', 'к', 'ы', 'а', 'ч', 'с'], 'а': ['к', 'е', 'в', 'п', 'с', 'м'], 'п': ['е', 'н', 'а', 'р', 'м', 'и'], 'р': ['н', 'г', 'п', 'о', 'и', 'т'], 'о': ['г', 'ш', 'р', 'л', 'т', 'ь'], 'л': ['ш', 'щ', 'о', 'д', 'ь', 'б'], 'д': ['щ', 'з', 'л', 'ж', 'б', 'ю'], 'ж': ['з', 'х', 'д', 'э', 'ю'], 'э': ['ж', 'х', 'ъ', 'ю'],
    'я': ['ф', 'ы', 'ч'], 'ч': ['ы', 'в', 'я', 'с'], 'с': ['в', 'а', 'ч', 'м'], 'м': ['а', 'п', 'с', 'и'], 'и': ['п', 'р', 'м', 'т'], 'т': ['р', 'о', 'и', 'ь'], 'ь': ['о', 'л', 'т', 'б'], 'б': ['л', 'д', 'ь', 'ю'], 'ю': ['д', 'ж', 'б'],

    // EN (основные)
    'q': ['w', 'a', '1', '2'], 'w': ['q', 'e', 'a', 's'], 'e': ['w', 'r', 's', 'd'], 'r': ['e', 't', 'd', 'f'], 't': ['r', 'y', 'f', 'g'], 'y': ['t', 'u', 'g', 'h'], 'u': ['y', 'i', 'h', 'j'], 'i': ['u', 'o', 'j', 'k'], 'o': ['i', 'p', 'k', 'l'], 'p': ['o', 'l'],
    'a': ['q', 'w', 's', 'z'], 's': ['w', 'e', 'a', 'd', 'z', 'x'], 'd': ['e', 'r', 's', 'f', 'x', 'c'], 'f': ['r', 't', 'd', 'g', 'c', 'v'], 'g': ['t', 'y', 'f', 'h', 'v', 'b'], 'h': ['y', 'u', 'g', 'j', 'b', 'n'], 'j': ['u', 'i', 'h', 'k', 'n', 'm'], 'k': ['i', 'o', 'j', 'l', 'm'], 'l': ['o', 'p', 'k'],
    'z': ['a', 's', 'x'], 'x': ['s', 'd', 'z', 'c'], 'c': ['d', 'f', 'x', 'v'], 'v': ['f', 'g', 'c', 'b'], 'b': ['g', 'h', 'v', 'n'], 'n': ['h', 'j', 'b', 'm'], 'm': ['j', 'k', 'n']
};

// ==========================================
// 3. ФУНКЦИИ ГУМАНИЗАЦИИ
// ==========================================

// Вспомогательная: получить соседа или вернуть тот же символ
function getNeighborChar(char) {
    const lower = char.toLowerCase();
    const neighbors = KEYBOARD_LAYOUT[lower];
    if (!neighbors || neighbors.length === 0) return char;
    
    const randomNeighbor = neighbors[Math.floor(Math.random() * neighbors.length)];
    return isUpperCase(char) ? randomNeighbor.toUpperCase() : randomNeighbor;
}

function isUpperCase(char) {
    return char !== char.toLowerCase();
}

// Применение опечатки к одному слову
function applyWordTypo(word) {
    if (word.length < 2) return word; // Не трогаем слишком короткие слова

    const type = Math.floor(Math.random() * 4); // 0..3
    const idx = Math.floor(Math.random() * word.length);
    const char = word[idx];
    
    let chars = word.split('');

    switch (type) {
        case 0: // Замена на соседа
            chars[idx] = getNeighborChar(char);
            break;
        case 1: // Перестановка (swap)
            if (idx < chars.length - 1) {
                const temp = chars[idx];
                chars[idx] = chars[idx + 1];
                chars[idx + 1] = temp;
            } else if (idx > 0) {
                const temp = chars[idx];
                chars[idx] = chars[idx - 1];
                chars[idx - 1] = temp;
            }
            break;
        case 2: // Пропуск символа
            if (word.length > 2) {
                chars.splice(idx, 1);
            }
            break;
        case 3: // Дублирование
            chars.splice(idx, 0, char);
            break;
    }
    return chars.join('');
}

// Главная функция гуманизации
function humanizeText(text) {
    // 1. Проверка глобального шанса
    if (Math.random() > MSG_ERROR_CHANCE) {
        return text;
    }

    // 2. Внутрисловные опечатки
    // Разбиваем по пробелам, чтобы сохранить структуру, но знаки препинания могут прилипнуть к словам.
    // Для упрощения считаем "словом" то, что разделено пробелами.
    let words = text.split(' ');
    words = words.map(word => {
        // Не трогаем слова с цифрами или спецсимволами, чтобы не ломать смайлики сильно
        if (Math.random() < WORD_ERROR_CHANCE && /^[a-zA-Zа-яА-ЯёЁ]+[.,!?-]?$/.test(word)) {
            return applyWordTypo(word);
        }
        return word;
    });
    
    let result = words.join(' ');

    // 3. Структурные ошибки
    
    // 3.1 Ошибки запятых (Паттерн ", " -> " ," или " , ")
    result = result.replace(/, /g, (match) => {
        if (Math.random() < COMMA_ERROR_CHANCE) {
            return Math.random() < 0.5 ? ' ,' : ' , ';
        }
        return match;
    });

    // 3.2 Удаление запятых (Каждая запятая может быть удалена)
    result = result.replace(/,/g, (match) => {
        return Math.random() < COMMA_DELETE_CHANCE ? '' : match;
    });

    // 3.3 Слипание слов (Удаление пробелов)
    // Используем replace с callback для каждого пробела
    result = result.replace(/ /g, (match) => {
        return Math.random() < MISSING_SPACE_CHANCE ? '' : match;
    });

    return result;
}

// ==========================================
// 4. ЛОГИКА AI (MISTRAL)
// ==========================================

function createPrompt(question, playerAnswers) {
    return `
    Вопрос: "${question}"

    Ответы разных людей:
    ${playerAnswers.map(a => `- ${a}`).join('\n')}

    Напиши еще один ответ. Он должен быть похож на остальные по длине, стилю и оформлению (регистр букв, знаки препинания, юмор).
    Пришли ТОЛЬКО ответ:
    `;
}

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
        
        // 1. БАЗОВАЯ ОЧИСТКА (Артефакты AI)
        answer = answer.replace(/^-\s*/, '')   // Убираем дефис в начале
                       .replace(/["'`]/g, ''); // Убираем ВСЕ кавычки
        
        // 2. ГУМАНИЗАЦИЯ (Внесение ошибок)
        answer = humanizeText(answer);

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