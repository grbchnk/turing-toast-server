const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const TOPICS = require('./topics');
require('dotenv').config(); // Чтобы читать .env
const { generateAiAnswer } = require('./ai'); // Наш новый модуль

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const rooms = {}; 

io.on('connection', (socket) => {
  console.log(`🔌 Подключение: ${socket.id}`);

  // --- ЛОББИ ---
  socket.on('create_room', (playerData) => {
    const roomId = Math.random().toString(36).substring(2, 7).toUpperCase();
    rooms[roomId] = {
      id: roomId,
      hostId: socket.id,
      players: [{ ...playerData, socketId: socket.id, score: 0 }],
      state: 'lobby',
      round: 1,
      maxRounds: 5,
      timerDuration: 60,
      timerId: null,
      answers: [],
      votes: {}
    };
    socket.join(roomId);
    socket.emit('room_created', rooms[roomId]);
    console.log(`🏠 Создана комната ${roomId}`);
  });

  socket.on('join_room', ({ roomId, playerData }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit('error', 'Комната не найдена');
    if (room.state !== 'lobby') return socket.emit('error', 'Игра уже идет');

    const existingPlayer = room.players.find(p => p.id === playerData.id);
    if (!existingPlayer) {
        room.players.push({ ...playerData, socketId: socket.id, score: 0 });
    } else {
        existingPlayer.socketId = socket.id;
    }

    socket.join(roomId);
    socket.emit('joined_room', room);
    io.to(roomId).emit('update_players', room.players);
  });

  // Клиент просит список тем
  socket.on('get_topics', () => {
      // Превращаем объект тем в массив для фронтенда
      const list = Object.keys(TOPICS).map(key => ({
          id: key,
          emoji: TOPICS[key].emoji,
          name: TOPICS[key].name,
          desc: TOPICS[key].description // Мапим description -> desc
      }));
      
      socket.emit('topics_list', list);
  });

  // --- СТАРТ ИГРЫ ---
  socket.on('start_game', ({ roomId, settings }) => {
    const room = rooms[roomId];
    if (!room || room.hostId !== socket.id) return;

    if (settings) {
        room.maxRounds = Number(settings.rounds) || 5;
        room.timerDuration = Number(settings.timeLimit) || 60;
        room.selectedTopicIds = settings.topics || ['skeletons'];
    }

    // [FIX 1] Собираем вопросы ВМЕСТЕ с инфой о теме
    let questionPool = [];
    (room.selectedTopicIds || []).forEach(tid => {
        if (TOPICS[tid]) {
            // Превращаем просто строку вопроса в объект { text, topicEmoji, topicName }
            const richQuestions = TOPICS[tid].questions.map(q => ({
                text: q,
                topicEmoji: TOPICS[tid].emoji,
                topicName: TOPICS[tid].name
            }));
            questionPool.push(...richQuestions);
        }
    });
    
    // Фолбэк, если пусто
    if (questionPool.length === 0) {
         Object.values(TOPICS).forEach(t => {
             const richQuestions = t.questions.map(q => ({
                text: q,
                topicEmoji: t.emoji,
                topicName: t.name
            }));
            questionPool.push(...richQuestions);
         });
    }
    
    room.questions = questionPool.sort(() => 0.5 - Math.random()).slice(0, room.maxRounds);
    
    io.to(roomId).emit('game_started');
    startNewRound(roomId);
  });

  // --- ИГРОВОЙ ПРОЦЕСС ---
  socket.on('submit_answer', ({ roomId, text }) => {
      const room = rooms[roomId];
      if (!room || room.state !== 'writing') return;

      const player = room.players.find(p => p.socketId === socket.id);
      if (!player) return;
      if (room.answers.find(a => a.authorId === player.id)) return;

      room.answers.push({
          id: Math.random().toString(36).substr(2, 9),
          text: text,
          authorId: player.id
      });

      io.to(roomId).emit('player_submitted', player.id);

      if (room.answers.length === room.players.length) {
          clearTimeout(room.timerId);
          endWritingPhase(roomId);
      }
  });

  socket.on('submit_votes', ({ roomId, votes }) => {
      const room = rooms[roomId];
      if (!room || room.state !== 'voting') return;

      const player = room.players.find(p => p.socketId === socket.id);
      if (!player) return;

      room.votes[player.id] = votes;

      // [НОВОЕ] Сообщаем всем, что этот игрок проголосовал (для галочек)
      io.to(roomId).emit('player_voted', player.id);

      // Проверка на авто-скип (если все проголосовали)
      const votersCount = Object.keys(room.votes).length;
      if (votersCount === room.players.length) {
          clearTimeout(room.timerId);
          calculateAndShowResults(roomId);
      }
  });

  socket.on('dev_skip_timer', ({ roomId }) => {
      const room = rooms[roomId];
      if (room) {
          clearTimeout(room.timerId);
          if (room.state === 'writing') endWritingPhase(roomId);
          else if (room.state === 'voting') calculateAndShowResults(roomId);
      }
  });

  socket.on('next_round_request', ({ roomId }) => {
      const room = rooms[roomId];
      if (room && room.hostId === socket.id) {
          room.round++;
          startNewRound(roomId);
      }
  });
  
  // [FIX] Обновленный request_game_state
  socket.on('request_game_state', ({ roomId }) => {
      const room = rooms[roomId];
      if (!room) return;

      socket.emit('update_players', room.players);

      if (room.state === 'writing') {
          socket.emit('new_round', {
              round: room.round,
              totalRounds: room.maxRounds,
              question: room.currentQuestionObj?.text, // Отправляем текст
              topicEmoji: room.currentQuestionObj?.topicEmoji, // Отправляем тему
              topicName: room.currentQuestionObj?.topicName,
              endTime: room.endTime,
              duration: room.timerDuration
          });
      } 
      else if (room.state === 'voting') {
           const shuffled = [...room.answers]
                .map(a => ({ id: a.id, text: a.text }))
                .sort(() => 0.5 - Math.random());
           socket.emit('start_voting', {
               answers: shuffled,
               endTime: room.endTime,
               duration: 60
           });
      }
      socket.emit('phase_change', room.state);
  });
});

// --- ФУНКЦИИ ---

function startNewRound(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    if (room.round > room.maxRounds) {
        io.to(roomId).emit('game_over');
        room.state = 'finished';
        return;
    }

    room.state = 'writing';
    room.answers = [];
    room.votes = {};
    
    // [FIX 1] Теперь currentQuestion - это объект { text, topicEmoji, topicName }
    room.currentQuestionObj = room.questions[room.round - 1]; 
    const questionText = room.currentQuestionObj ? room.currentQuestionObj.text : "Вопрос потерялся";
    
    room.endTime = Date.now() + (room.timerDuration * 1000);

    io.to(roomId).emit('new_round', {
        round: room.round,
        totalRounds: room.maxRounds,
        question: questionText,
        // Передаем данные о теме
        topicEmoji: room.currentQuestionObj?.topicEmoji || '❓',
        topicName: room.currentQuestionObj?.topicName || 'Случайная тема',
        endTime: room.endTime,
        duration: room.timerDuration
    });

    console.log(`🏁 Раунд ${room.round}. Вопрос: ${questionText}`);

    room.timerId = setTimeout(() => {
        endWritingPhase(roomId);
    }, room.timerDuration * 1000 + 1000);
}

async function endWritingPhase(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    room.state = 'ai_processing';
    io.to(roomId).emit('phase_change', 'ai_processing');

    // 1. Собираем тексты ответов реальных игроков
    const humanAnswersText = room.answers.map(a => a.text);

    // 2. Генерируем ответ AI 
    // Здесь код сам "замрет" (await), пока Google Gemini думает.
    // Это и будет естественной задержкой.
    const aiAnswerText = await generateAiAnswer(
        room.currentQuestionObj?.text || "Вопрос потерялся", 
        humanAnswersText
    );
    
    room.answers.push({
        id: 'ai_answer_' + Date.now(),
        text: aiAnswerText,
        authorId: 'ai'
    });

    // 3. Как только ответ получен — СРАЗУ запускаем голосование
    startVotingPhase(roomId);
}

function startVotingPhase(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    room.state = 'voting';

    const shuffled = [...room.answers]
        .map(a => ({ id: a.id, text: a.text }))
        .sort(() => 0.5 - Math.random());

    room.endTime = Date.now() + 60000;

    io.to(roomId).emit('start_voting', {
        answers: shuffled,
        endTime: room.endTime,
        duration: 60
    });

    room.timerId = setTimeout(() => {
        calculateAndShowResults(roomId);
    }, 60000);
}

function calculateAndShowResults(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    room.state = 'reveal';
    const deltas = {};
    const votesSummary = {};

    room.players.forEach(p => deltas[p.id] = 0);

    room.players.forEach(player => {
        const playerVotes = room.votes[player.id];
        if (!playerVotes) return; // AFK

        Object.keys(playerVotes).forEach(ansId => {
            const vote = playerVotes[ansId];
            const targetAnswer = room.answers.find(a => a.id === ansId);
            if (!targetAnswer) return;

            if (!votesSummary[ansId]) votesSummary[ansId] = [];

            let isCorrect = false;

            if (vote.type === 'ai' && targetAnswer.authorId === 'ai') {
                deltas[player.id] += 100;
                isCorrect = true;
            }
            else if (vote.type === 'ai' && targetAnswer.authorId !== 'ai') {
                deltas[player.id] -= 50;
                if (deltas[targetAnswer.authorId] !== undefined) {
                    deltas[targetAnswer.authorId] += 70;
                }
            }
            else if (vote.type === 'human' && vote.playerId === targetAnswer.authorId) {
                deltas[player.id] += 50;
                if (deltas[targetAnswer.authorId] !== undefined) {
                    deltas[targetAnswer.authorId] -= 30;
                }
                isCorrect = true;
            }
            else if (vote.type === 'human') {
                deltas[player.id] -= 50;
            }

            votesSummary[ansId].push({
                playerId: player.id,
                isCorrect: isCorrect
            });
        });
    });

    // [FIX 3] Применяем очки (убрали проверку p.score < 0)
    room.players.forEach(p => {
        if (deltas[p.id]) p.score += deltas[p.id];
    });

    io.to(roomId).emit('round_results', {
        deltas: deltas,
        votes: votesSummary,
        fullAnswers: room.answers,
        players: room.players
    });
}

// --- ДИАГНОСТИКА: ПРОВЕРКА МОДЕЛЕЙ ---
const { GoogleGenerativeAI } = require("@google/generative-ai");
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function listModels() {
  try {
    console.log("🔍 Запрашиваю список доступных моделей...");
    // Получаем только модели, которые поддерживают генерацию текста (generateContent)
    const models = await genAI.listModels();
    
    console.log("✅ ДОСТУПНЫЕ МОДЕЛИ:");
    let found = false;
    for await (const model of models) {
      if (model.supportedGenerationMethods.includes("generateContent")) {
        console.log(`👉 ${model.name}`);
        found = true;
      }
    }
    if (!found) console.log("⚠️ Нет доступных моделей для генерации текста.");
  } catch (error) {
    console.error("❌ Ошибка при проверке моделей:", error.message);
  }
}

listModels();
// -------------------------------------

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Server running on ${PORT}`);
});