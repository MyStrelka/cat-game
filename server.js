const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);

app.use(express.static("public"));

// --- Глобальное состояние игры ---
let gameState = {
  board: {}, // x_y: { top, right, bottom, left, type }
  deck: [],
  players: {}, // id: { name, hand: [], id }
  turnOrder: [],
  currentTurnIndex: 0,
  gameOver: false,
  statusMessage: "Ожидание игроков...",
  catEscaped: false
};

// --- Константы карт ---
// 1 = Туннель, 0 = Стена
const CARD_TYPES = [
  { t: 1, r: 1, b: 0, l: 0, type: "turn" }, // Поворот
  { t: 1, r: 1, b: 1, l: 1, type: "cross" }, // Перекресток
  { t: 1, r: 1, b: 1, l: 0, type: "t-shape" }, // Т-образный
  { t: 1, r: 0, b: 1, l: 0, type: "line" }, // Прямая
  { t: 0, r: 0, b: 0, l: 0, type: "block" }  // Тупик (редкая)
];

// Карты действий
const ACTION_CARDS = [
  "КОТ_ИСПУГАЛСЯ", // Открывает выход
  "КОТ_ИГРАЕТ",    // Сброс карты
  "КОТ_ЛИЗНУЛ",    // Обмен карты
  "КОТ_СПИТ"       // Ничего (можно взять карту)
];

// Генерация колоды
function generateDeck() {
  let deck = [];
  // Добавляем 40 карт туннелей
  for (let i = 0; i < 40; i++) {
    let template = CARD_TYPES[Math.floor(Math.random() * CARD_TYPES.length)];
    deck.push({ ...template, id: `card_${i}`, isAction: false });
  }
  // Добавляем 10 карт действий
  for (let i = 0; i < 10; i++) {
    let action = ACTION_CARDS[Math.floor(Math.random() * ACTION_CARDS.length)];
    deck.push({ isAction: true, actionType: action, id: `act_${i}` });
  }
  return shuffle(deck);
}

function shuffle(array) {
  return array.sort(() => Math.random() - 0.5);
}

function initGame() {
  gameState.board = {};
  gameState.deck = generateDeck();
  gameState.gameOver = false;
  gameState.catEscaped = false;

  // Ставим Дом (0,0). У него 4 выхода.
  gameState.board["0_0"] = { t: 1, r: 1, b: 1, l: 1, type: "house", id: "house" };

  // Ставим "Заглушки" (стены), которые кот может выбить
  // Например, закрываем Лево и Право, оставляем Верх и Низ открытыми
  // -1_0 (Слева) - заглушка (Стена справа блокирует выход дома)
  gameState.board["-1_0"] = { t: 0, r: 0, b: 0, l: 0, type: "block_start", id: "start_block_1" }; 
  gameState.board["1_0"]  = { t: 0, r: 0, b: 0, l: 0, type: "block_start", id: "start_block_2" };
}

initGame();

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("joinGame", (name) => {
    if (!gameState.players[socket.id]) {
      gameState.players[socket.id] = {
        id: socket.id,
        name: name || "Игрок",
        hand: drawCards(3)
      };
      gameState.turnOrder.push(socket.id);
    }
    io.emit("updateState", gameState);
  });

  socket.on("playCard", (data) => {
    // data = { cardIndex, x, y, rotation }
    const player = gameState.players[socket.id];
    if (gameState.gameOver) return;
    if (gameState.turnOrder[gameState.currentTurnIndex] !== socket.id) return;

    const card = player.hand[data.cardIndex];

    // 1. Если это КАРТА ДЕЙСТВИЯ (авто-розыгрыш при попытке сыграть/выбрать)
    // В данном прототипе: игрок кликает на карту действия, она срабатывает
    if (card.isAction) {
      handleActionCard(card.actionType, socket.id, data.cardIndex);
      // След ход
      nextTurn(); 
      return;
    }

    // 2. Логика размещения Туннеля
    // Применяем вращение (0, 90, 180, 270)
    // Вращение меняет стороны: Top->Right->Bottom->Left
    let placedCard = rotateCard(card, data.rotation);
    
    // Проверка валидности
    if (isValidPlacement(placedCard, data.x, data.y)) {
      gameState.board[`${data.x}_${data.y}`] = placedCard;
      
      // Удаляем из руки и даем новую
      player.hand.splice(data.cardIndex, 1);
      let newCards = drawCards(1);
      if (newCards.length > 0) player.hand.push(newCards[0]);

      // Проверка победы
      checkWinCondition();

      if (!gameState.gameOver) nextTurn();
    } else {
      socket.emit("errorMsg", "Сюда нельзя положить эту карту!");
    }
  });

  socket.on("drawCardAction", () => {
     // Для карты "Кот спит" или пропуска хода
     const player = gameState.players[socket.id];
     if (gameState.turnOrder[gameState.currentTurnIndex] !== socket.id) return;
     let newCards = drawCards(1);
     if(newCards.length > 0) player.hand.push(newCards[0]);
     nextTurn();
  });
  
  socket.on("restart", () => {
      initGame();
      // Очищаем руки
      for(let pid in gameState.players) {
          gameState.players[pid].hand = drawCards(3);
      }
      gameState.statusMessage = "Новая игра началась!";
      io.emit("updateState", gameState);
  });

  socket.on("disconnect", () => {
    delete gameState.players[socket.id];
    gameState.turnOrder = gameState.turnOrder.filter(id => id !== socket.id);
    if (gameState.currentTurnIndex >= gameState.turnOrder.length) gameState.currentTurnIndex = 0;
    io.emit("updateState", gameState);
  });
});

function handleActionCard(type, playerId, cardIndex) {
  const player = gameState.players[playerId];
  player.hand.splice(cardIndex, 1); // Удаляем сыгранную карту
  
  let msg = `Игрок ${player.name} сыграл: ${type}! `;

  if (type === "КОТ_ИСПУГАЛСЯ") {
    // Удаляем одну из стартовых заглушек, если они есть
    const blocks = Object.keys(gameState.board).filter(k => gameState.board[k].type === 'block_start');
    if (blocks.length > 0) {
        const toRemove = blocks[Math.floor(Math.random() * blocks.length)];
        delete gameState.board[toRemove];
        msg += "Один из выходов открылся!";
    } else {
        msg += "Но коту некуда бежать, все заглушки уже выбиты.";
    }
  } 
  else if (type === "КОТ_ИГРАЕТ") {
    // Сброс случайной карты
    if (player.hand.length > 0) {
        player.hand.splice(Math.floor(Math.random() * player.hand.length), 1);
        msg += "Он потерял одну карту!";
    }
  }
  else if (type === "КОТ_ЛИЗНУЛ") {
      // Замена всей руки (для простоты) или 1 карты
      player.hand.push(drawCards(1)[0]);
      msg += "Получена новая карта.";
  }
  
  // Игрок берет карту на замену сыгранной карты действия
  player.hand.push(drawCards(1)[0]);

  gameState.statusMessage = msg;
  io.emit("updateState", gameState);
}

function rotateCard(card, rot) {
  // rot: 0, 1(90), 2(180), 3(270)
  let newCard = { ...card, rotation: rot };
  // Вращение значений (сдвиг массива)
  // Было: T R B L. Стало (90): L T R B
  const vals = [card.t, card.r, card.b, card.l];
  for (let i = 0; i < rot; i++) {
    vals.unshift(vals.pop());
  }
  newCard.t = vals[0]; newCard.r = vals[1]; 
  newCard.b = vals[2]; newCard.l = vals[3];
  return newCard;
}

function isValidPlacement(card, x, y) {
  // Проверка: клетка пуста?
  if (gameState.board[`${x}_${y}`]) return false;

  let hasNeighbor = false;
  const neighbors = [
    { dx: 0, dy: -1, mySide: card.t, oppSide: 'b' }, // Верх
    { dx: 1, dy: 0,  mySide: card.r, oppSide: 'l' }, // Право
    { dx: 0, dy: 1,  mySide: card.b, oppSide: 't' }, // Низ
    { dx: -1, dy: 0, mySide: card.l, oppSide: 'r' }  // Лево
  ];

  let validConnection = true;

  for (let n of neighbors) {
    const neighborKey = `${x + n.dx}_${y + n.dy}`;
    const neighbor = gameState.board[neighborKey];

    if (neighbor) {
      hasNeighbor = true;
      const nVal = neighbor[n.oppSide]; // Что у соседа с нашей стороны
      const myVal = n.mySide;           // Что у нас со стороны соседа

      // ПРАВИЛА СТЫКОВКИ:
      // 1. Туннель (1) в Стену (0) соседа (который уже лежит) -> НЕЛЬЗЯ.
      // 2. Стена (0) в Туннель (1) соседа -> МОЖНО (Блокируем).
      // 3. Туннель (1) в Туннель (1) -> МОЖНО.
      // 4. Стена (0) в Стену (0) -> МОЖНО.
      
      // Ошибка только если мы пытаемся продолжить туннель в стену соседа
      if (myVal === 1 && nVal === 0) {
          validConnection = false;
      }
    }
  }

  return hasNeighbor && validConnection;
}

function checkWinCondition() {
  // Простой алгоритм: ищем "открытые" туннели
  // Проходим по всем картам на поле. Если сторона == 1 (туннель), 
  // проверяем, есть ли сосед. Если соседа нет -> выход открыт.
  let openExits = 0;

  for (let key in gameState.board) {
    const [x, y] = key.split('_').map(Number);
    const card = gameState.board[key];

    // Проверяем 4 стороны
    // Верх
    if (card.t === 1 && !gameState.board[`${x}_${y-1}`]) openExits++;
    // Право
    if (card.r === 1 && !gameState.board[`${x+1}_${y}`]) openExits++;
    // Низ
    if (card.b === 1 && !gameState.board[`${x}_${y+1}`]) openExits++;
    // Лево
    if (card.l === 1 && !gameState.board[`${x-1}_${y}`]) openExits++;
  }

  if (openExits === 0) {
    gameState.gameOver = true;
    gameState.statusMessage = "ПОБЕДА! Кот пойман!";
    io.emit("updateState", gameState);
  } else if (gameState.deck.length === 0) {
      // Проверка: если карт нет, и ходы закончились у всех (упрощенно - колода пуста)
      gameState.gameOver = true;
      gameState.catEscaped = true;
      gameState.statusMessage = "ПОРАЖЕНИЕ! Карты кончились, Кот сбежал!";
      io.emit("updateState", gameState);
  }
}

function drawCards(count) {
  let res = [];
  for (let i = 0; i < count; i++) {
    if (gameState.deck.length > 0) res.push(gameState.deck.pop());
  }
  return res;
}

function nextTurn() {
  gameState.currentTurnIndex = (gameState.currentTurnIndex + 1) % gameState.turnOrder.length;
  gameState.statusMessage = `Ход игрока: ${gameState.players[gameState.turnOrder[gameState.currentTurnIndex]].name}`;
  io.emit("updateState", gameState);
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
