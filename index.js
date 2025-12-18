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
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 5000, 
  pingInterval: 10000
});

const rooms = {}; 

// --- AUTH & MIDDLEWARE ---
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

io.use(async (socket, next) => {
  const initData = socket.handshake.auth.initData;
  const tgUser = verifyTelegramAuth(initData);

  if (tgUser) {
    try {
      const { data: dbUser } = await supabase
        .from('users')
        .select('id, first_name, username, avatar_url')
        .eq('id', String(tgUser.id))
        .maybeSingle();

      if (dbUser) {
        // Логика обновления существующего юзера
        await supabase.from('users').update({
            username: tgUser.username || dbUser.username,
            avatar_url: tgUser.photo_url || dbUser.avatar_url
        }).eq('id', String(tgUser.id));

        socket.user = {
          id: String(tgUser.id),
          name: dbUser.first_name || tgUser.first_name,
          avatar: dbUser.avatar_url || tgUser.photo_url,
          isGuest: false
        };
      } else {
        // Создание нового
        await supabase.from('users').upsert({
            id: String(tgUser.id),
            first_name: tgUser.first_name || tgUser.username,
            username: tgUser.username,
            avatar_url: tgUser.photo_url
        });
        socket.user = {
          id: String(tgUser.id),
          name: tgUser.first_name || tgUser.username,
          avatar: tgUser.photo_url,
          isGuest: false
        };
      }
    } catch (e) {
      console.error('Auth error:', e);
      // Fallback при ошибке базы
      socket.user = { id: String(tgUser.id), name: tgUser.first_name, isGuest: false };
    }
  } else {
    socket.user = {
      id: 'guest_' + Math.random().toString(36).substr(2, 9),
      name: 'Guest',
      isGuest: true
    };
  }
  socket.emit('profile', socket.user);
  next();
});

// --- SOCKET EVENTS ---
io.on('connection', (socket) => {
  console.log(`Connection: ${socket.user.name} (${socket.user.id})`);

  socket.on('disconnect', () => {
      console.log(`Disconnect: ${socket.user.name}`);
      const room = Object.values(rooms).find(r => r.players.some(p => p.socketId === socket.id));
      
      if (room) {
          const player = room.players.find(p => p.socketId === socket.id);
          if (player) {
              player.isOnline = false;
              io.to(room.id).emit('update_players', room.players); 

              if (room.state === 'lobby') {
                  room.players = room.players.filter(p => p.id !== player.id);
                  if (room.players.length === 0) {
                      delete rooms[room.id];
                  } else {
                      handleHostTransfer(room, socket.user.id);
                      io.to(room.id).emit('update_players', room.players);
                  }
              } else {
                 // В игре не удаляем сразу, ждем реконнекта
                 checkEmptyRoomCleanup(room.id);
              }
          }
      }
  });

socket.on('get_rooms_list', () => {
    const roomsList = Object.values(rooms)
      .filter(r => r.state !== 'game_over' && r.players.length > 0)
      .map(room => {
        const hostName = room.players.find(p => p.id === room.hostUserId)?.name || 'Неизвестный';
        
        // [FIX] Проверяем, находится ли текущий пользователь уже в этой комнате
        const isMyRoom = room.players.some(p => p.id === socket.user.id);

        return {
          id: room.id,
          hostName: hostName,
          playersCount: room.players.length,
          state: room.state,
          round: room.round,
          maxRounds: room.maxRounds,
          statusText: room.state === 'lobby' 
            ? 'В лобби' 
            : `${room.currentQuestionObj?.topicEmoji || ''} ${room.currentQuestionObj?.topicName || 'Игра идет'}`,
          isJoinable: room.state === 'lobby',
          isMyRoom: isMyRoom // [FIX] Отправляем флаг клиенту
        };
      });

    socket.emit('rooms_list_update', roomsList);
  });

socket.on('check_reconnect', () => {
    const room = Object.values(rooms).find(r => r.players.some(p => p.id === socket.user.id));

    if (room) {
        // [FIX] Если игра окончена, разрываем связь с комнатой для этого игрока
        if (room.state === 'game_over') {
            socket.emit('session_not_found');
            return;
        }

        // Удаляем лобби-призрак
        if (room.state === 'lobby' && room.players.length === 1 && !room.players[0].isOnline) {
            delete rooms[room.id];
            socket.emit('session_not_found');
            return;
        }

        const player = room.players.find(p => p.id === socket.user.id);
        if (player) {
            player.socketId = socket.id;
            player.isOnline = true;
        }
        
        if (room.hostUserId === socket.user.id) {
            room.hostId = socket.id;
        }

        socket.join(room.id);
        socket.emit('reconnect_success', getReconnectData(room, socket.user.id));
        io.to(room.id).emit('update_players', room.players);
    } else {
        socket.emit('session_not_found');
    }
});

  socket.on('leave_room', ({ roomId }) => {
      const room = rooms[roomId];
      if (!room) return;

      room.players = room.players.filter(p => p.id !== socket.user.id);
      socket.leave(roomId);

      if (room.players.length === 0) {
          delete rooms[roomId];
      } else {
          handleHostTransfer(room, socket.user.id);
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
      hostId: socket.id,
      hostUserId: socket.user.id,
      players: [hostPlayer],
      state: 'lobby',
      round: 1,
      maxRounds: 5,
      timerDuration: 60,
      timerId: null,
      answers: [],
      votes: {},
      history: [],
      questions: [],
      currentQuestionObj: null
    };
    socket.join(roomId);
    socket.emit('room_created', rooms[roomId]);
  });

  socket.on('join_room', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit('error', 'Комната не найдена');
    
    // [FIX] Запрещаем вход в завершенную игру всем (и новым, и старым)
    if (room.state === 'game_over') {
        return socket.emit('error', 'Эта игра уже завершена');
    }
    
    const existingPlayer = room.players.find(p => p.id === socket.user.id);

    // Запрещаем вход новым игрокам во время игры
    if (room.state !== 'lobby' && !existingPlayer) {
        return socket.emit('error', 'Игра уже идет');
    }
    
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
        existingPlayer.isOnline = true;
        if (room.hostUserId === socket.user.id) room.hostId = socket.id;
        
        if (room.state !== 'lobby') {
            socket.join(roomId);
            // [FIX] Отправляем полные данные
            socket.emit('reconnect_success', getReconnectData(room, socket.user.id));
            io.to(roomId).emit('update_players', room.players);
            return;
        }
    }

    socket.join(roomId);
    socket.emit('joined_room', room);
    io.to(roomId).emit('update_players', room.players);
  });

  socket.on('update_profile', async ({ name }) => {
    if (!name || !socket.user) return;
    // Оптимизация: не ждать ответа БД для UI, но обрабатывать ошибку
    socket.user.name = name;
    
    // Обновляем во всех комнатах в памяти
    Object.values(rooms).forEach(room => {
        const player = room.players.find(p => p.id === socket.user.id);
        if (player) {
            player.name = name;
            io.to(room.id).emit('update_players', room.players);
        }
    });

    await supabase.from('users').update({ first_name: name }).eq('id', socket.user.id);
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
      io.to(roomId).emit('animate_reaction', { 
          emoji, 
          id: Math.random(), 
          senderId: socket.user.id 
      });
  });

  socket.on('start_game', ({ roomId, settings }) => {
    const room = rooms[roomId];
    if (!room || room.hostId !== socket.id) return;
    if (room.players.length < 2) return socket.emit('error', 'Нужно минимум 2 игрока');

    if (settings) {
        room.maxRounds = Number(settings.rounds) || 5;
        room.timerDuration = Number(settings.timeLimit) || 60;
        room.selectedTopicIds = settings.topics || ['skeletons'];
    }

    // Формирование пула вопросов
    let questionPool = [];
    (room.selectedTopicIds || []).forEach(tid => {
        if (TOPICS[tid]) {
            questionPool.push(...TOPICS[tid].questions.map(q => ({
                text: q,
                topicEmoji: TOPICS[tid].emoji,
                topicName: TOPICS[tid].name
            })));
        }
    });
    
    // Fallback если пул пуст
    if (questionPool.length === 0) {
         Object.values(TOPICS).forEach(t => {
            questionPool.push(...t.questions.map(q => ({
                text: q, topicEmoji: t.emoji, topicName: t.name
            })));
         });
    }
    
    room.questions = questionPool.sort(() => 0.5 - Math.random()).slice(0, room.maxRounds);
    
    io.to(roomId).emit('game_started');
    startNewRound(roomId);
  });

  // [FIX] ВОССТАНОВЛЕННАЯ ЛОГИКА ОТВЕТОВ
socket.on('submit_answer', ({ roomId, text }) => {
      const room = rooms[roomId];
      if (!room || room.state !== 'writing') return;
      
      // Проверка/Обновление ответа
      const existing = room.answers.find(a => a.authorId === socket.user.id);
      if (existing) {
          existing.text = text;
      } else {
          room.answers.push({
              id: 'ans_' + socket.user.id,
              text: text,
              authorId: socket.user.id
          });
      }
      
      // [FIX] БЫЛО: socket.emit(...) -> видели только мы
      // [FIX] СТАЛО: io.to(roomId).emit(...) -> видят ВСЕ (галочка + звук)
      io.to(roomId).emit('player_submitted', socket.user.id);
      
      // Обновляем счетчик (для UI)
      io.to(roomId).emit('update_submitted_count', room.answers.length);
      
      checkTimerSkip(roomId);
  });

  // [FIX] ВОССТАНОВЛЕННАЯ ЛОГИКА ГОЛОСОВ
  socket.on('submit_votes', ({ roomId, votes }) => {
      const room = rooms[roomId];
      if (!room || room.state !== 'voting') return;

      room.votes[socket.user.id] = votes;
      
      // [FIX] Отправляем ВСЕМ в комнате, чтобы загорелась галочка у проголосовавшего
      io.to(roomId).emit('player_voted', socket.user.id);
      
      checkTimerSkip(roomId);
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
        // [FIX] Не увеличиваем раунд, если мы уже на пределе
        if (room.round >= room.maxRounds) {
            finishGame(roomId);
            return;
        }
        
        room.round++;
        startNewRound(roomId);
    }
  });
  
  socket.on('request_game_state', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    socket.emit('update_players', room.players);
    socket.emit('phase_change', room.state);

    // [FIX] Всегда отправляем инфо о раунде, если игра не в лобби
    if (room.state !== 'lobby') {
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

    const myExistingAnswer = room.answers.find(a => a.authorId === socket.user.id);
    if (myExistingAnswer) {
        socket.emit('restore_my_answer', myExistingAnswer.text);
    }

    // Далее специфичная логика фаз (как у тебя и было)...
    if (room.state === 'writing') {
        const hasAnswered = room.answers.some(a => a.authorId === socket.user.id);
        if (hasAnswered) socket.emit('player_submitted', socket.user.id);
     }
     else if (room.state === 'voting') {
        socket.emit('start_voting', {
            answers: room.currentShuffledAnswers || [],
            endTime: room.endTime,
            duration: 60
        });
        if (room.votes[socket.user.id]) socket.emit('player_voted', socket.user.id);
     }
     else if (room.state === 'reveal') {
        socket.emit('round_results', room.lastRoundResults || { deltas: {}, votes: {}, fullAnswers: [], players: room.players });
     }
  });
});

const getReconnectData = (room, userId) => ({
    roomId: room.id,
    isHost: room.hostUserId === userId,
    gameState: room.state,
    players: room.players,
    // [FIX] Всегда отправляем данные о текущем раунде, если игра идет
    roundData: room.state !== 'lobby' ? {
        round: room.round,
        maxRounds: room.maxRounds,
        question: room.currentQuestionObj?.text,
        topicEmoji: room.currentQuestionObj?.topicEmoji,
        topicName: room.currentQuestionObj?.topicName,
        endTime: room.endTime,
        duration: room.timerDuration
    } : null
});

// --- HELPER FUNCTIONS ---

function startNewRound(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    // [FIX] Сбрасываем старый таймер, чтобы не было наложений
    if (room.timerId) clearTimeout(room.timerId);

    if (room.round > room.maxRounds) {
        finishGame(roomId);
        return;
    }

    room.state = 'writing';
    room.answers = [];
    room.votes = {};
    
    // Защита от выхода за границы массива
    room.currentQuestionObj = room.questions[room.round - 1] || { text: "Вопрос не найден", topicEmoji: "❓" };

    room.endTime = Date.now() + (room.timerDuration * 1000);

    io.to(roomId).emit('new_round', {
        round: room.round,
        totalRounds: room.maxRounds,
        question: room.currentQuestionObj.text,
        topicEmoji: room.currentQuestionObj.topicEmoji,
        topicName: room.currentQuestionObj.topicName,
        endTime: room.endTime,
        duration: room.timerDuration
    });

    room.timerId = setTimeout(() => {
        endWritingPhase(roomId);
    }, room.timerDuration * 1000 + 1000); // +1 сек буфер
}

function handleHostTransfer(room, leaverId) {
    if (room.hostUserId === leaverId) {
        const newHost = room.players.find(p => p.id !== leaverId && p.isOnline);
        if (newHost) {
            room.hostUserId = newHost.id;
            room.hostId = newHost.socketId;
            io.to(room.id).emit('host_transferred', { newHostId: newHost.id });
        } else if (room.players.length > 0) {
             // Назначаем оффлайн игрока, если никого нет онлайн, чтобы комната жила
             room.hostUserId = room.players[0].id;
        }
    }
}

function checkEmptyRoomCleanup(roomId) {
    setTimeout(() => {
        const room = rooms[roomId];
        if (room) {
            const anyoneOnline = room.players.some(p => p.isOnline);
            if (!anyoneOnline) {
                console.log(`Cleaning up abandoned room ${roomId}`);
                delete rooms[roomId];
            }
        }
    }, 300000); // 5 min
}

function checkTimerSkip(roomId) {
    const room = rooms[roomId];
    if(!room) return;
    
    // Считаем только тех, кто онлайн, чтобы не ждать вылетевших
    const activePlayersCount = room.players.filter(p => p.isOnline).length;
    
    if (room.state === 'writing') {
        const answersCount = room.answers.length;
        if (answersCount >= activePlayersCount && activePlayersCount > 0) {
             clearTimeout(room.timerId);
             endWritingPhase(roomId);
        }
    } else if (room.state === 'voting') {
        const votesCount = Object.keys(room.votes).length;
        if (votesCount >= activePlayersCount && activePlayersCount > 0) {
             clearTimeout(room.timerId);
             calculateAndShowResults(roomId);
        }
    }
}

async function endWritingPhase(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    if (room.timerId) clearTimeout(room.timerId);

    room.state = 'ai_processing';
    io.to(roomId).emit('phase_change', 'ai_processing');

    let aiAnswerText = "ИИ устал и молчит :(";
    try {
        const humanAnswersText = room.answers.map(a => a.text);
        aiAnswerText = await generateAiAnswer(room.currentQuestionObj?.text, humanAnswersText);
    } catch (e) {
        console.error("AI Gen Error:", e);
    }
    
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
    if (room.timerId) clearTimeout(room.timerId);

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
    if (room.timerId) clearTimeout(room.timerId);

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

            // Логика начисления очков (СТАРАЯ ВЕРСИЯ)
            if (vote.type === 'ai' && targetAnswer.authorId === 'ai') {
                deltas[player.id] += 100; // Нашел ИИ
                isCorrect = true;
            }
            else if (vote.type === 'ai' && targetAnswer.authorId !== 'ai') {
                deltas[player.id] -= 50; // Ошибся, принял человека за ИИ
                if (deltas[targetAnswer.authorId] !== undefined) {
                    deltas[targetAnswer.authorId] += 108; // Человек обманул другого (вернули 108)
                }
            }
            else if (vote.type === 'human' && vote.playerId === targetAnswer.authorId) {
                deltas[player.id] += 25; // Угадал автора (вернули 25)
                isCorrect = true;
            }
            else {
                deltas[player.id] -= 50; // Просто не угадал (вернули штраф -50)
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

    // Применяем очки
    room.players.forEach(p => {
        if (deltas[p.id]) p.score += deltas[p.id];
    });

    room.history.push(roundStats);
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
    if (!room) return;
    
    room.state = 'game_over'; 

    const stats = {}; 
    room.players.forEach(p => {
        stats[p.id] = { 
            timesGuessedCorrectlyAsHuman: 0,
            timesMistakenForAI: 0,
            correctGuessesMade: 0
        };
    });

    // Подсчет достижений
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
        { title: "🕵️ Шерлок", desc: "Больше всех угадывал", ...findMax('correctGuessesMade') },
        { title: "🤖 Киборг", desc: "Чаще всех путали с ботом", ...findMax('timesMistakenForAI') },
        { title: "📖 Открытая книга", desc: "Самый предсказуемый", ...findMax('timesGuessedCorrectlyAsHuman') }
    ];

    io.to(roomId).emit('game_over_stats', {
        players: room.players.sort((a,b) => b.score - a.score),
        achievements: achievements
    });

    console.log(`Game over in room ${roomId}. Auto-delete in 3 mins.`);
    setTimeout(() => {
        if (rooms[roomId]) delete rooms[roomId];
    }, 180000); 
}



const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Server running on ${PORT}`);
});