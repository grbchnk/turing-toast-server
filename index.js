const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const TOPICS = require('./topics');
require('dotenv').config();
const { generateAiAnswer } = require('./ai');
const crypto = require('crypto');
const supabase = require('./supabase');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const rooms = {}; 

// --- ФУНКЦИЯ ВЕРИФИКАЦИИ (вынесена наверх, до middleware) ---
const verifyTelegramAuth = (initData) => {
    if (!initData) return null;
    
    const urlParams = new URLSearchParams(initData);
    const hash = urlParams.get('hash');
    urlParams.delete('hash');

    const checkString = Array.from(urlParams.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([key, val]) => `${key}=${val}`)
        .join('\n');

    const secret = crypto.createHmac('sha256', 'WebAppData')
        .update(process.env.TELEGRAM_BOT_TOKEN)
        .digest();

    const calculatedHash = crypto.createHmac('sha256', secret)
        .update(checkString)
        .digest('hex');

    if (calculatedHash === hash) {
        const userStr = urlParams.get('user');
        return userStr ? JSON.parse(userStr) : null;
    }
    return null;
};

// --- MIDDLEWARE СОКЕТОВ ---
io.use(async (socket, next) => {
  const initData = socket.handshake.auth.initData;
  const tgUser = verifyTelegramAuth(initData);

  if (tgUser) {
    try {
      const { data: dbUser, error: selectError } = await supabase
        .from('users')
        .select('id, first_name, username, avatar_url')
        .eq('id', String(tgUser.id))
        .maybeSingle();

      if (selectError) console.error('Supabase select error:', selectError);

      if (dbUser) {
        const name = dbUser.first_name || tgUser.first_name || tgUser.username || `tg_${tgUser.id}`;
        const avatar = dbUser.avatar_url || tgUser.photo_url || null;

        const { error: updateError } = await supabase
          .from('users')
          .update({
            username: tgUser.username || dbUser.username,
            avatar_url: tgUser.photo_url || dbUser.avatar_url
          })
          .eq('id', String(tgUser.id));

        if (updateError) console.error('Supabase update error:', updateError);

        socket.user = {
          id: String(tgUser.id),
          name,
          avatar,
          isGuest: false
        };
      } else {
        const { error: upsertError } = await supabase
          .from('users')
          .upsert({
            id: String(tgUser.id),
            first_name: tgUser.first_name || tgUser.username,
            username: tgUser.username,
            avatar_url: tgUser.photo_url
          });

        if (upsertError) console.error('Supabase upsert error:', upsertError);

        socket.user = {
          id: String(tgUser.id),
          name: tgUser.first_name || tgUser.username || `tg_${tgUser.id}`,
          avatar: tgUser.photo_url || null,
          isGuest: false
        };
      }
    } catch (e) {
      console.error('Error while reading/updating supabase user:', e);
      socket.user = {
        id: String(tgUser.id),
        name: tgUser.first_name || tgUser.username || `tg_${tgUser.id}`,
        avatar: tgUser.photo_url || null,
        isGuest: false
      };
    }
  } else {
    socket.user = {
      id: 'guest_' + Math.random().toString(36).substr(2, 9),
      name: 'Guest',
      isGuest: true
    };
  }

  // Отправляем профиль клиенту
  socket.emit('profile', socket.user);
  next();
});

// --- SOCKET EVENTS ---
io.on('connection', (socket) => {
  console.log(`Подключился: ${socket.user.name} (ID: ${socket.user.id})`);

    socket.on('check_reconnect', () => {
      // Ищем комнату, где есть этот юзер
      const room = Object.values(rooms).find(r => 
          r.players.some(p => p.id === socket.user.id)
      );

      if (room) {
          // ЛОГИКА "УМНОГО" РЕКОННЕКТА
          
          // 1. Если игра закончена — выкидываем
          if (room.state === 'finished' || room.state === 'game_over') {
             return; 
          }

          // 2. Если это ЛОББИ и игрок там ОДИН (и он вышел из приложения) ->
          // Считаем, что комната умерла. Удаляем её и не реконнектим.
          if (room.state === 'lobby' && room.players.length === 1) {
              delete rooms[room.id];
              console.log(`Комната ${room.id} удалена (хост покинул лобби через закрытие)`);
              return; // Клиент останется в меню
          }

          // 3. Восстанавливаем игрока
          const player = room.players.find(p => p.id === socket.user.id);
          if (player) {
              player.socketId = socket.id; // Обновляем сокет
              player.isOnline = true;
          }
          
          // 4. ВОССТАНОВЛЕНИЕ ПРАВ ХОСТА (По ID юзера, а не сокета!)
          // Если ID юзера совпадает с hostUserId комнаты
          if (room.hostUserId === socket.user.id) {
              room.hostId = socket.id; // Обновляем активный сокет хоста
          }

          socket.join(room.id);
          
          socket.emit('reconnect_success', {
              roomId: room.id,
              isHost: room.hostUserId === socket.user.id, // Надежная проверка
              gameState: room.state,
              players: room.players 
          });
          
          console.log(`Игрок ${socket.user.name} реконнект в ${room.id}`);
      } else {
          // Если комнаты нет, явно говорим клиенту "сессии нет"
          socket.emit('session_not_found');
      }
  });

  socket.on('leave_room', ({ roomId }) => {
      const room = rooms[roomId];
      if (!room) return;

      console.log(`Игрок ${socket.user.name} покинул комнату ${roomId}`);

      room.players = room.players.filter(p => p.id !== socket.user.id);
      socket.leave(roomId);

      if (room.players.length === 0) {
          delete rooms[roomId];
          console.log(`Комната ${roomId} удалена (пустая)`);
      } else {
          // Если ушел ХОСТ -> передаем права следующему
          if (room.hostUserId === socket.user.id) {
              const newHost = room.players[0]; // Берем первого попавшегося (обычно следующий по списку)
              room.hostUserId = newHost.id; 
              room.hostId = newHost.socketId; 
              
              console.log(`Права хоста переданы игроку ${newHost.name} (ID: ${newHost.id})`);
              
              // --- [ВАЖНО] Сообщаем всем, кто теперь новый хост ---
              io.to(roomId).emit('host_transferred', { newHostId: newHost.id });
          }
          io.to(roomId).emit('update_players', room.players);
      }
  });

  socket.on('create_room', () => {
    const roomId = Math.random().toString(36).substring(2, 7).toUpperCase();
    
    const hostPlayer = {
        id: socket.user.id,
        name: socket.user.name,
        avatar: socket.user.avatar,
        socketId: socket.id,
        score: 0,
        isOnline: true
    };

    rooms[roomId] = {
      id: roomId,
      hostId: socket.id,       // Текущий сокет (для emits)
      hostUserId: socket.user.id, // [FIX] ID пользователя (для прав)
      players: [hostPlayer],
      state: 'lobby',
      round: 1,
      maxRounds: 5,
      timerDuration: 60,
      timerId: null,
      answers: [],
      votes: {},
      history: []
    };
    socket.join(roomId);
    socket.emit('room_created', rooms[roomId]);
    console.log(`Комната ${roomId} создана ${hostPlayer.name}`);
  });

  socket.on('join_room', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit('error', 'Комната не найдена');
    if (room.state !== 'lobby') return socket.emit('error', 'Игра уже идет');

    const existingPlayer = room.players.find(p => p.id === socket.user.id);
    
    if (!existingPlayer) {
        const newPlayer = {
            id: socket.user.id,
            name: socket.user.name,
            avatar: socket.user.avatar,
            socketId: socket.id,
            score: 0,
            isOnline: true
        };
        room.players.push(newPlayer);
    } else {
        existingPlayer.socketId = socket.id;
    }

    socket.join(roomId);
    socket.emit('joined_room', room);
    io.to(roomId).emit('update_players', room.players);
  });

  socket.on('update_profile', async ({ name }) => {
    if (!name || !socket.user) return;

    const { error } = await supabase
        .from('users')
        .update({ first_name: name })
        .eq('id', socket.user.id);

    if (error) {
        console.error('Supabase Error:', error);
        return socket.emit('error', 'Не удалось обновить имя');
    }

    socket.user.name = name;

    Object.values(rooms).forEach(room => {
        const player = room.players.find(p => p.id === socket.user.id);
        if (player) {
            player.name = name;
            io.to(room.id).emit('update_players', room.players);
        }
    });
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

  
    socket.on('send_reaction', ({ roomId, emoji }) => {
      // [UPDATED] Добавляем senderId: socket.user.id
      io.to(roomId).emit('animate_reaction', { 
          emoji, 
          id: Math.random(), 
          senderId: socket.user.id // <-- Важно!
      });
  });

  socket.on('start_game', ({ roomId, settings }) => {
    const room = rooms[roomId];
    if (!room || room.hostId !== socket.id) return;
    if (room.players.length < 2) return;

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

  socket.on('submit_answer', ({ roomId, text }) => {
      const room = rooms[roomId];
      if (!room || room.state !== 'writing') return;

      const player = room.players.find(p => p.socketId === socket.id);
      if (!player) return;
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
    const room = rooms[roomId];
    if (!room) return;

    // 1. Сначала обновляем список игроков и фазу
    socket.emit('update_players', room.players);
    socket.emit('phase_change', room.state);

    // 2. В зависимости от фазы отправляем актуальные данные
    if (room.state === 'writing') {
        socket.emit('new_round', {
            round: room.round,
            totalRounds: room.maxRounds,
            question: room.currentQuestionObj?.text,
            topicEmoji: room.currentQuestionObj?.topicEmoji,
            topicName: room.currentQuestionObj?.topicName,
            endTime: room.endTime,
            duration: room.timerDuration
        });
        
        // Если игрок уже отправил ответ, сообщаем ему об этом (чтобы скрыть поле ввода)
        const hasAnswered = room.answers.some(a => a.authorId === socket.user.id);
        if (hasAnswered) {
             socket.emit('player_submitted', socket.user.id);
        }
    } 
    else if (room.state === 'voting') {
        // Отдаем сохраненные перемешанные ответы
        if (room.currentShuffledAnswers) {
            socket.emit('start_voting', {
                answers: room.currentShuffledAnswers,
                endTime: room.endTime,
                duration: 60
            });
        }
        
        // Если игрок уже проголосовал
        if (room.votes[socket.user.id]) {
            socket.emit('player_voted', socket.user.id); // Это может потребоваться обработать на клиенте, если нужно блокировать UI
        }
    }
    else if (room.state === 'reveal') {
        // Отдаем сохраненные результаты
        if (room.lastRoundResults) {
            socket.emit('round_results', room.lastRoundResults);
        }
    }
    // Для 'ai_processing' ничего слать не нужно, клиент просто показывает лоадер по phase_change
  });
  });

// --- GAME LOGIC FUNCTIONS ---
function startNewRound(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    if (room.round > room.maxRounds) {
        finishGame(roomId);
        return;
    }

    room.state = 'writing';
    room.answers = [];
    room.votes = {};
    
    if (!room.questions || room.questions.length === 0) {
        room.currentQuestionObj = { text: "Ошибка: вопросы не загрузились", topicEmoji: '⚠️', topicName: 'Error' };
    } else {
        room.currentQuestionObj = room.questions[room.round - 1]; 
    }

    room.endTime = Date.now() + (room.timerDuration * 1000);

    io.to(roomId).emit('new_round', {
        round: room.round,
        totalRounds: room.maxRounds,
        question: room.currentQuestionObj?.text || "...",
        topicEmoji: room.currentQuestionObj?.topicEmoji || '❓',
        topicName: room.currentQuestionObj?.topicName || 'Тема',
        endTime: room.endTime,
        duration: room.timerDuration
    });

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
    
    room.currentShuffledAnswers = shuffled;

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

    const roundStats = {
        question: room.currentQuestionObj.text,
        votes: []
    };

    room.players.forEach(player => {
        const playerVotes = room.votes[player.id];
        if (!playerVotes) return; 

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
                    deltas[targetAnswer.authorId] += 108; 
                }
            }
            else if (vote.type === 'human' && vote.playerId === targetAnswer.authorId) {
                deltas[player.id] += 25;
                isCorrect = true;
            }
            else {
                deltas[player.id] -= 50;
            }

            votesSummary[ansId].push({
                playerId: player.id,
                isCorrect: isCorrect,
                isDeceived: (vote.type === 'ai' && targetAnswer.authorId !== 'ai')
            });
            
            roundStats.votes.push({
                voterId: player.id,
                targetId: targetAnswer.authorId,
                guessType: vote.type,
                guessedPlayerId: vote.playerId,
                isCorrect: isCorrect
            });
        });
    });

    room.players.forEach(p => {
        if (deltas[p.id]) p.score += deltas[p.id];
    });

    room.history.push(roundStats);

    // [FIX] Сохраняем результаты, чтобы отдать реконнектнувшимся
    room.lastRoundResults = {
        deltas: deltas,
        votes: votesSummary,
        fullAnswers: room.answers,
        players: room.players
    };

    io.to(roomId).emit('round_results', room.lastRoundResults);
}

function finishGame(roomId) {
    const room = rooms[roomId];
    if (!room) return; // Защита от краша

    // [FIX] Ставим статус game_over, чтобы check_reconnect его отсекал
    room.state = 'game_over'; 

    const stats = {}; 
    room.players.forEach(p => {
        stats[p.id] = { 
            timesGuessedCorrectlyAsHuman: 0,
            timesMistakenForAI: 0,
            correctGuessesMade: 0
        };
    });

    room.history.forEach(round => {
        round.votes.forEach(v => {
            if (v.isCorrect && stats[v.voterId]) {
                stats[v.voterId].correctGuessesMade++;
            }
            if (v.targetId !== 'ai' && v.isCorrect && v.guessType === 'human' && stats[v.targetId]) {
                stats[v.targetId].timesGuessedCorrectlyAsHuman++;
            }
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

    console.log(`Комната ${roomId} завершена. Будет удалена через 10 минут.`);
    
    setTimeout(() => {
        if (rooms[roomId]) {
            delete rooms[roomId];
            console.log(`🗑️ Комната ${roomId} удалена из памяти (очистка).`);
        }
    }, 180000); // через 3 минуты
    
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Server running on ${PORT}`);
});