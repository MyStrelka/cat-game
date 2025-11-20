const socket = io();
let myId = null;
let state = null;
let selectedCtx = { index: -1, rotation: 0 }; // Выбранная карта

function joinGame() {
    const name = document.getElementById('username').value;
    if(!name) return alert("Введите имя");
    socket.emit('joinGame', name);
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('game-screen').style.display = 'block';
}

socket.on('connect', () => { myId = socket.id; });

socket.on('updateState', (newState) => {
    state = newState;
    renderBoard();
    renderHand();
    document.getElementById('status-bar').innerText = state.statusMessage;
    if(state.gameOver) alert(state.statusMessage);
});

socket.on('errorMsg', (msg) => alert(msg));

function renderBoard() {
    const boardEl = document.getElementById('board');
    boardEl.innerHTML = '';
    
    // Центр поля (1000, 1000 в пикселях внутри контейнера)
    const CX = 1000; 
    const CY = 1000;
    const SIZE = 60;

    // Рисуем существующие карты
    for(let key in state.board) {
        const [x, y] = key.split('_').map(Number);
        const card = state.board[key];
        const el = document.createElement('div');
        el.className = 'card';
        if(card.type === 'house') {
            el.className += ' house';
            el.innerText = "ДОМ";
        }
        if(card.type === 'block_start') {
            el.className += ' block-card';
            el.innerText = "X";
        }
        
        // Рисуем "внутренности" туннеля
        if(card.t) appendTunnel(el, 't-top');
        if(card.b) appendTunnel(el, 't-bottom');
        if(card.l) appendTunnel(el, 't-left');
        if(card.r) appendTunnel(el, 't-right');

        el.style.left = (CX + x * SIZE) + 'px';
        el.style.top = (CY + y * SIZE) + 'px';
        boardEl.appendChild(el);
    }

    // Добавляем обработчик клика на поле (делегирование)
    // Но лучше создать сетку "призраков" вокруг, куда можно кликнуть.
    // Для прототипа: ловим клик по всему полю и считаем координаты
    boardEl.onclick = (e) => {
        if(selectedCtx.index === -1) return;
        
        const rect = boardEl.getBoundingClientRect();
        const clickX = e.clientX - rect.left - CX; // Смещение от центра
        const clickY = e.clientY - rect.top - CY;
        
        // Округляем до сетки
        const gx = Math.floor(clickX / SIZE);
        const gy = Math.floor(clickY / SIZE); // тут небольшая погрешность из-за бордеров, но для теста ок
        
        // Точнее:
        // Клик внутри (0,0) должен быть от 0 до 60.
        // clickX может быть отрицательным. 
        // Math.floor(-5 / 60) = -1. Правильно.
        
        socket.emit('playCard', {
            cardIndex: selectedCtx.index,
            x: gx,
            y: gy,
            rotation: selectedCtx.rotation
        });
        
        // Сброс выбора
        selectedCtx.index = -1;
        selectedCtx.rotation = 0;
        renderHand();
    };
}

function appendTunnel(parent, cssClass) {
    let d = document.createElement('div');
    d.className = 'tunnel-visual ' + cssClass;
    parent.appendChild(d);
}

function renderHand() {
    const handEl = document.getElementById('hand');
    handEl.innerHTML = '';
    const myPlayer = state.players[myId];
    if(!myPlayer) return;

    myPlayer.hand.forEach((card, idx) => {
        const el = document.createElement('div');
        el.className = 'hand-card';
        if(selectedCtx.index === idx) el.className += ' selected';
        
        if(card.isAction) {
            el.className += ' action-card';
            el.innerText = card.actionType;
        } else {
            // Показываем туннель с учетом текущего ВРАЩЕНИЯ (только если выбрана)
            let rot = (selectedCtx.index === idx) ? selectedCtx.rotation : 0;
            
            // Симуляция вращения для отрисовки в руке
            let vals = [card.t, card.r, card.b, card.l];
            for(let i=0; i<rot; i++) vals.unshift(vals.pop());
            
            if(vals[0]) appendTunnel(el, 't-top'); // T
            if(vals[1]) appendTunnel(el, 't-right'); // R
            if(vals[2]) appendTunnel(el, 't-bottom'); // B
            if(vals[3]) appendTunnel(el, 't-left'); // L
        }

        el.onclick = (e) => {
            e.stopPropagation();
            if (card.isAction) {
                // Сразу играем событие
                if(confirm(`Сыграть карту "${card.actionType}"?`)) {
                    socket.emit('playCard', { cardIndex: idx });
                }
            } else {
                selectedCtx.index = idx;
                renderHand(); // перерисовка для подсветки
            }
        };
        handEl.appendChild(el);
    });
}

function rotateSelection() {
    if(selectedCtx.index === -1) return;
    selectedCtx.rotation = (selectedCtx.rotation + 1) % 4;
    renderHand(); // обновить визуал в руке
}

function passTurn() {
    socket.emit('drawCardAction');
}
