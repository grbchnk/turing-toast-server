const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const TOPICS = require('./topics');
require('dotenv').config();
const { generateAiAnswer } = require('./ai');

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
      votes: {},
      history: [] // [NEW] История для ачивок
    };
    socket.join(roomId);
    socket.emit('room_created', rooms[roomId]);
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

  socket.on('get_topics', () => {
      const list = Object.keys(TOPICS).map(key => ({
          id: key,
          emoji: TOPICS[key].emoji,
          name: TOPICS[key].name,
          desc: TOPICS[key].description
      }));
      socket.emit('topics_list', list);
  });

  // --- СТАРТ ИГРЫ ---
  socket.on('start_game', ({ roomId, settings }) => {
    const room = rooms[roomId];
    if (!room || room.hostId !== socket.id) return;

    // [NEW] Проверка на кол-во игроков
    if (room.players.length < 2) {
        return; 
    }

    if (settings) {
        room.maxRounds = Number(settings.rounds) || 5;
        room.timerDuration = Number(settings.timeLimit) || 60;
        room.selectedTopicIds = settings.topics || ['skeletons'];
    }

    let questionPool = [];
    (room.selectedTopicIds || []).forEach(tid => {
        if (TOPICS[tid]) {
            const richQuestions = TOPICS[tid].questions.map(q => ({
                text: q,
                topicEmoji: TOPICS[tid].emoji,
                topicName: TOPICS[tid].name
            }));
            questionPool.push(...richQuestions);
        }
    });
    
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
      
      // [NEW] Валидация на сервере тоже нужна
      if (text.length < 3) return;

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
      io.to(roomId).emit('player_voted', player.id);

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
  
  socket.on('request_game_state', ({ roomId }) => {
    console.log(`📡 Запрос состояния игры для комнаты ${roomId}`); // ЛОГ
    const room = rooms[roomId];
    if (!room) {
        console.log(`❌ Комната ${roomId} не найдена при запросе состояния`); // ЛОГ
        return;
    }

    socket.emit('update_players', room.players);

    if (room.state === 'writing') {
        console.log(`🔄 Отправка текущего раунда игроку (Writing)`); // ЛОГ
        socket.emit('new_round', {
            round: room.round,
            totalRounds: room.maxRounds,
            question: room.currentQuestionObj?.text,
            topicEmoji: room.currentQuestionObj?.topicEmoji,
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
      console.log(`📢 Отправка смены фазы: ${room.state}`); // ЛОГ
      socket.emit('phase_change', room.state);
  });
});

// --- ФУНКЦИИ ---

function startNewRound(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    console.log(`🏁 Старт нового раунда: ${room.round} в комнате ${roomId}`); // ЛОГ

    if (room.round > room.maxRounds) {
        finishGame(roomId);
        return;
    }

    room.state = 'writing';
    room.answers = [];
    room.votes = {};
    
    // БЕЗОПАСНОЕ ПОЛУЧЕНИЕ ВОПРОСА
    if (!room.questions || room.questions.length === 0) {
        console.error("❌ ОШИБКА: Список вопросов пуст!");
        room.currentQuestionObj = { text: "Ошибка: вопросы не загрузились", topicEmoji: '⚠️', topicName: 'Error' };
    } else {
        room.currentQuestionObj = room.questions[room.round - 1]; 
    }

    room.endTime = Date.now() + (room.timerDuration * 1000);

    const roundData = {
        round: room.round,
        totalRounds: room.maxRounds,
        question: room.currentQuestionObj?.text || "...",
        topicEmoji: room.currentQuestionObj?.topicEmoji || '❓',
        topicName: room.currentQuestionObj?.topicName || 'Тема',
        endTime: room.endTime,
        duration: room.timerDuration
    };

    console.log("📤 Отправка события new_round всем игрокам:", roundData.question); // ЛОГ
    io.to(roomId).emit('new_round', roundData);

    room.timerId = setTimeout(() => {
        endWritingPhase(roomId);
    }, room.timerDuration * 1000 + 1000);
}

async function endWritingPhase(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    room.state = 'ai_processing';
    io.to(roomId).emit('phase_change', 'ai_processing');

    const humanAnswersText = room.answers.map(a => a.text);
    const aiAnswerText = await generateAiAnswer(room.currentQuestionObj?.text, humanAnswersText);
    
    room.answers.push({
        id: 'ai_answer_' + Date.now(),
        text: aiAnswerText,
        authorId: 'ai'
    });

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

// [NEW] Обновленная логика подсчета очков
function calculateAndShowResults(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    room.state = 'reveal';
    const deltas = {};
    const votesSummary = {}; // Для отображения галочек

    room.players.forEach(p => deltas[p.id] = 0);

    // Сохраняем статистику раунда
    const roundStats = {
        question: room.currentQuestionObj.text,
        votes: []
    };

    room.players.forEach(player => { // Тот КТО голосует (P1)
        const playerVotes = room.votes[player.id];
        if (!playerVotes) return; 

        Object.keys(playerVotes).forEach(ansId => {
            const vote = playerVotes[ansId]; // { type: 'ai'|'human', playerId?: string }
            const targetAnswer = room.answers.find(a => a.id === ansId);
            if (!targetAnswer) return;

            if (!votesSummary[ansId]) votesSummary[ansId] = [];

            let isCorrect = false;

            // 1. P1 угадал, что это AI (ответ Тоста)
            if (vote.type === 'ai' && targetAnswer.authorId === 'ai') {
                deltas[player.id] += 100; // Бонус за поимку бота
                isCorrect = true;
            }
            // 2. P1 ошибся: подумал что это AI, а это Человек (P2)
            else if (vote.type === 'ai' && targetAnswer.authorId !== 'ai') {
                deltas[player.id] -= 50; // Штраф за ошибку
                // [NEW] P2 (Автор ответа) получает бонус за обман
                if (deltas[targetAnswer.authorId] !== undefined) {
                    deltas[targetAnswer.authorId] += 108; 
                }
            }
            // 3. P1 угадал Человека (угадал автора P2)
            else if (vote.type === 'human' && vote.playerId === targetAnswer.authorId) {
                deltas[player.id] += 25; // Небольшой бонус за знание друзей
                // Автор (P2) ничего не теряет
                isCorrect = true;
            }
            // 4. P1 ошибся с Человеком (думал это P2, а это P3 или AI)
            else {
                deltas[player.id] -= 50; // Штраф
            }

            // Запись для визуализации
            votesSummary[ansId].push({
                playerId: player.id,
                isCorrect: isCorrect,
                isDeceived: (vote.type === 'ai' && targetAnswer.authorId !== 'ai') // [NEW] Флаг "Обманут"
            });
            
            // Запись в историю
            roundStats.votes.push({
                voterId: player.id,
                targetId: targetAnswer.authorId,
                guessType: vote.type,
                guessedPlayerId: vote.playerId,
                isCorrect: isCorrect
            });
        });
    });

    // Применяем очки
    room.players.forEach(p => {
        if (deltas[p.id]) p.score += deltas[p.id];
    });

    // Сохраняем историю
    room.history.push(roundStats);

    io.to(roomId).emit('round_results', {
        deltas: deltas,
        votes: votesSummary,
        fullAnswers: room.answers,
        players: room.players
    });
}

// [NEW] Функция завершения игры и подсчета ачивок
function finishGame(roomId) {
    const room = rooms[roomId];
    room.state = 'finished';

    // Считаем ачивки
    const stats = {}; 
    room.players.forEach(p => {
        stats[p.id] = { 
            timesGuessedCorrectlyAsHuman: 0, // Его угадали (предсказуемый)
            timesMistakenForAI: 0,          // Его приняли за бота (скрытный)
            correctGuessesMade: 0           // Он угадал верно (детектив)
        };
    });

    room.history.forEach(round => {
        round.votes.forEach(v => {
            // Детектив (voter)
            if (v.isCorrect && stats[v.voterId]) {
                stats[v.voterId].correctGuessesMade++;
            }
            // Предсказуемый (target is human, guessed as human correct)
            if (v.targetId !== 'ai' && v.isCorrect && v.guessType === 'human' && stats[v.targetId]) {
                stats[v.targetId].timesGuessedCorrectlyAsHuman++;
            }
            // Скрытный (target is human, guessed as AI)
            if (v.targetId !== 'ai' && v.guessType === 'ai' && stats[v.targetId]) {
                stats[v.targetId].timesMistakenForAI++;
            }
        });
    });

    const findMax = (field) => {
        let maxVal = -1;
        let pId = null;
        room.players.forEach(p => {
            if (stats[p.id][field] > maxVal) {
                maxVal = stats[p.id][field];
                pId = p.id;
            }
        });
        return { playerId: pId, count: maxVal };
    };

    const achievements = [
        { 
            title: "🕵️ Шерлок Холмс", 
            desc: "Чаще всех угадывал других", 
            ...findMax('correctGuessesMade') 
        },
        { 
            title: "🤖 Киборг-убийца", 
            desc: "Чаще всех притворялся ботом", 
            ...findMax('timesMistakenForAI') 
        },
        { 
            title: "📖 Открытая книга", 
            desc: "Самый предсказуемый игрок", 
            ...findMax('timesGuessedCorrectlyAsHuman') 
        }
    ];

    io.to(roomId).emit('game_over_stats', {
        players: room.players.sort((a,b) => b.score - a.score),
        achievements: achievements
    });
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Server running on ${PORT}`);
});