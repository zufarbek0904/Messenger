// ===================================================================
// ГЛОБАЛЬНОЕ СОСТОЯНИЕ
// ===================================================================
let currentUser = null;          // { id, name, avatar_url, email }
let currentChatId = null;
let currentChatData = null;      // { id, type, name, avatar_url, members: [...] }
let messagesChannel = null;      // подписка realtime на сообщения текущего чата
let chatsChannel = null;         // подписка realtime на изменения чатов
let selectedGroupMembers = {};   // { id: {name, avatar_url} }
let profilesCache = {};          // { id: {name, avatar_url, status} }

// ===================================================================
// УТИЛИТЫ
// ===================================================================
function $(id) { return document.getElementById(id); }

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function defaultAvatar(name) {
  const letter = (name || "?").trim().charAt(0).toUpperCase();
  return `https://ui-avatars.com/api/?name=${encodeURIComponent(letter)}&background=3390ec&color=fff&size=128`;
}

function formatTime(isoString) {
  if (!isoString) return "";
  const date = new Date(isoString);
  return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  $(screenId).classList.remove('hidden');
}

function showError(elId, message) {
  $(elId).textContent = message;
}

// ===================================================================
// AUTH: переключение форм логин/регистрация
// ===================================================================
$('show-register').addEventListener('click', () => {
  $('login-form').classList.add('hidden');
  $('register-form').classList.remove('hidden');
});
$('show-login').addEventListener('click', () => {
  $('register-form').classList.add('hidden');
  $('login-form').classList.remove('hidden');
});

// ===================================================================
// AUTH: регистрация
// ===================================================================
$('register-btn').addEventListener('click', async () => {
  const name = $('register-name').value.trim();
  const email = $('register-email').value.trim();
  const password = $('register-password').value;
  showError('register-error', "");

  if (!name || !email || !password) {
    showError('register-error', "Заполните все поля");
    return;
  }
  if (password.length < 6) {
    showError('register-error', "Пароль должен быть минимум 6 символов");
    return;
  }

  // Имя передаём в metadata — триггер в БД (handle_new_user) сам создаст
  // строку в таблице profiles при регистрации, см. schema.sql
  const { data, error } = await supabaseClient.auth.signUp({
    email: email,
    password: password,
    options: {
      data: { name: name }
    }
  });

  if (error) {
    showError('register-error', translateAuthError(error));
    return;
  }

  // Если в проекте Supabase включено подтверждение email, сессии не будет,
  // пока пользователь не подтвердит почту по ссылке из письма.
  if (!data.session) {
    showError('register-error', "Аккаунт создан! Проверьте почту и подтвердите email, затем войдите.");
  }
  // Если подтверждение email отключено — onAuthStateChange сработает сам
});

// ===================================================================
// AUTH: вход
// ===================================================================
$('login-btn').addEventListener('click', async () => {
  const email = $('login-email').value.trim();
  const password = $('login-password').value;
  showError('login-error', "");

  if (!email || !password) {
    showError('login-error', "Заполните все поля");
    return;
  }

  const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
  if (error) {
    showError('login-error', translateAuthError(error));
  }
});

function translateAuthError(err) {
  const msg = (err.message || "").toLowerCase();
  if (msg.includes('already registered') || msg.includes('already exists')) return "Этот email уже зарегистрирован";
  if (msg.includes('invalid login credentials')) return "Неверный email или пароль";
  if (msg.includes('email not confirmed')) return "Подтвердите email, перейдя по ссылке из письма";
  if (msg.includes('password should be at least')) return "Пароль слишком короткий";
  if (msg.includes('invalid email')) return "Неверный формат email";
  if (msg.includes('rate limit')) return "Слишком много попыток. Подождите немного";
  return "Ошибка: " + err.message;
}

// ===================================================================
// AUTH: выход
// ===================================================================
$('logout-btn').addEventListener('click', async () => {
  if (currentUser) {
    await supabaseClient.from('profiles').update({
      status: 'offline',
      last_seen: new Date().toISOString()
    }).eq('id', currentUser.id);
  }
  cleanupSubscriptions();
  await supabaseClient.auth.signOut();
});

function cleanupSubscriptions() {
  if (messagesChannel) { supabaseClient.removeChannel(messagesChannel); messagesChannel = null; }
  if (chatsChannel) { supabaseClient.removeChannel(chatsChannel); chatsChannel = null; }
}

// ===================================================================
// AUTH: слушатель состояния входа — главная точка входа в приложение
// ===================================================================
supabaseClient.auth.onAuthStateChange(async (event, session) => {
  if (session && session.user) {
    const { data: profile, error } = await supabaseClient
      .from('profiles')
      .select('*')
      .eq('id', session.user.id)
      .maybeSingle();

    if (error || !profile) {
      // Профиль ещё не успел создаться триггером — подождём и попробуем снова
      setTimeout(() => supabaseClient.auth.getSession().then(({ data }) => {
        if (data.session) location.reload();
      }), 1200);
      return;
    }

    currentUser = {
      id: session.user.id,
      email: session.user.email,
      name: profile.name,
      avatar_url: profile.avatar_url || defaultAvatar(profile.name)
    };

    $('my-name').textContent = currentUser.name;
    $('my-avatar').src = currentUser.avatar_url;

    await supabaseClient.from('profiles').update({
      status: 'online',
      last_seen: new Date().toISOString()
    }).eq('id', currentUser.id);

    showScreen('app-screen');
    loadChats();
    subscribeToChatChanges();
  } else {
    currentUser = null;
    cleanupSubscriptions();
    showScreen('auth-screen');
  }
});

// ===================================================================
// ПОИСК ПОЛЬЗОВАТЕЛЕЙ (для нового чата и для группы)
// ===================================================================
let searchTimeout = null;
$('search-input').addEventListener('input', (e) => {
  clearTimeout(searchTimeout);
  const query = e.target.value.trim();
  if (!query) {
    $('search-results').classList.add('hidden');
    return;
  }
  searchTimeout = setTimeout(() => searchUsers(query, 'search-results', openPrivateChatWithUser), 300);
});

$('new-chat-btn').addEventListener('click', () => {
  $('search-input').focus();
});

async function searchUsers(query, resultsContainerId, onSelectCallback) {
  const container = $(resultsContainerId);
  container.innerHTML = "";
  container.classList.remove('hidden');

  const { data, error } = await supabaseClient
    .from('profiles')
    .select('id, name, avatar_url, status')
    .ilike('name', `%${query}%`)
    .neq('id', currentUser.id)
    .limit(15);

  if (error) {
    container.innerHTML = `<div class="empty-list-hint">Ошибка поиска: ${escapeHtml(error.message)}</div>`;
    return;
  }

  if (!data || data.length === 0) {
    container.innerHTML = `<div class="empty-list-hint">Никто не найден</div>`;
    return;
  }

  data.forEach(profile => {
    profilesCache[profile.id] = profile;
    const item = document.createElement('div');
    item.className = 'search-result-item';
    item.innerHTML = `
      <img class="avatar" src="${escapeHtml(profile.avatar_url || defaultAvatar(profile.name))}" alt="">
      <div class="chat-item-info">
        <div class="chat-item-name">${escapeHtml(profile.name)}</div>
        <div class="chat-item-preview">${profile.status === 'online' ? '🟢 онлайн' : 'не в сети'}</div>
      </div>
    `;
    item.addEventListener('click', () => onSelectCallback(profile.id, profile));
    container.appendChild(item);
  });
}

async function openPrivateChatWithUser(otherUserId) {
  $('search-input').value = "";
  $('search-results').classList.add('hidden');

  // Ищем существующий приватный чат между текущим пользователем и собеседником:
  // берём все чаты, где состоит otherUserId, через chat_members,
  // затем проверяем, что текущий пользователь тоже там состоит и тип = private
  const { data: otherMemberships, error: err1 } = await supabaseClient
    .from('chat_members')
    .select('chat_id')
    .eq('user_id', otherUserId);

  if (!err1 && otherMemberships && otherMemberships.length > 0) {
    const chatIds = otherMemberships.map(m => m.chat_id);
    const { data: myMatchingChats } = await supabaseClient
      .from('chat_members')
      .select('chat_id, chats!inner(type)')
      .eq('user_id', currentUser.id)
      .in('chat_id', chatIds)
      .eq('chats.type', 'private');

    if (myMatchingChats && myMatchingChats.length > 0) {
      openChat(myMatchingChats[0].chat_id);
      return;
    }
  }

  // Создаём новый приватный чат
  const { data: newChat, error: chatErr } = await supabaseClient
    .from('chats')
    .insert({ type: 'private', created_by: currentUser.id, last_message: '', last_message_time: new Date().toISOString() })
    .select()
    .single();

  if (chatErr) {
    alert("Не удалось создать чат: " + chatErr.message);
    return;
  }

  const { error: membersErr } = await supabaseClient
    .from('chat_members')
    .insert([
      { chat_id: newChat.id, user_id: currentUser.id },
      { chat_id: newChat.id, user_id: otherUserId }
    ]);

  if (membersErr) {
    alert("Не удалось добавить участников: " + membersErr.message);
    return;
  }

  loadChats();
  openChat(newChat.id);
}

// ===================================================================
// СПИСОК ЧАТОВ
// ===================================================================
async function loadChats() {
  const listEl = $('chat-list');

  // Получаем id всех чатов, где состоит текущий пользователь
  const { data: memberships, error: memErr } = await supabaseClient
    .from('chat_members')
    .select('chat_id')
    .eq('user_id', currentUser.id);

  if (memErr) {
    listEl.innerHTML = `<div class="empty-list-hint">Ошибка загрузки чатов: ${escapeHtml(memErr.message)}</div>`;
    return;
  }

  if (!memberships || memberships.length === 0) {
    listEl.innerHTML = `<div class="empty-list-hint">Пока нет чатов.<br>Найдите собеседника через поиск выше 🔍</div>`;
    return;
  }

  const chatIds = memberships.map(m => m.chat_id);

  const { data: chats, error: chatsErr } = await supabaseClient
    .from('chats')
    .select('*')
    .in('id', chatIds)
    .order('last_message_time', { ascending: false });

  if (chatsErr) {
    listEl.innerHTML = `<div class="empty-list-hint">Ошибка загрузки чатов: ${escapeHtml(chatsErr.message)}</div>`;
    return;
  }

  listEl.innerHTML = "";

  for (const chat of chats) {
    let displayName, displayAvatar;

    if (chat.type === 'group') {
      displayName = chat.name || "Группа";
      displayAvatar = chat.avatar_url || defaultAvatar(chat.name || "G");
    } else {
      const otherProfile = await getOtherMemberProfile(chat.id);
      displayName = otherProfile ? otherProfile.name : "Пользователь";
      displayAvatar = otherProfile ? (otherProfile.avatar_url || defaultAvatar(otherProfile.name)) : defaultAvatar("?");
    }

    const item = document.createElement('div');
    item.className = 'chat-list-item' + (chat.id === currentChatId ? ' active' : '');
    item.innerHTML = `
      <img class="avatar" src="${escapeHtml(displayAvatar)}" alt="">
      <div class="chat-item-info">
        <div class="chat-item-name">${escapeHtml(displayName)}</div>
        <div class="chat-item-preview">${escapeHtml(chat.last_message || "Нет сообщений")}</div>
      </div>
    `;
    item.addEventListener('click', () => openChat(chat.id));
    listEl.appendChild(item);
  }
}

async function getOtherMemberProfile(chatId) {
  const { data: members } = await supabaseClient
    .from('chat_members')
    .select('user_id')
    .eq('chat_id', chatId)
    .neq('user_id', currentUser.id)
    .limit(1);

  if (!members || members.length === 0) return null;
  return await getProfile(members[0].user_id);
}

async function getProfile(userId) {
  if (profilesCache[userId]) return profilesCache[userId];
  const { data } = await supabaseClient.from('profiles').select('*').eq('id', userId).maybeSingle();
  if (data) profilesCache[userId] = data;
  return data;
}

// Realtime: подписываемся на изменения таблицы chats, чтобы список обновлялся
// сам при получении нового сообщения (last_message обновляется триггером в sendMessage)
function subscribeToChatChanges() {
  if (chatsChannel) supabaseClient.removeChannel(chatsChannel);

  chatsChannel = supabaseClient
    .channel('chats-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'chats' }, () => {
      loadChats();
    })
    .subscribe();
}

// ===================================================================
// ОТКРЫТИЕ ЧАТА И СООБЩЕНИЯ
// ===================================================================
async function openChat(chatId) {
  currentChatId = chatId;

  // На мобильном — переключаемся с экрана списка чатов на экран самого чата
  document.querySelector('.app-layout').classList.add('mobile-chat-open');

  const { data: chat, error } = await supabaseClient.from('chats').select('*').eq('id', chatId).single();
  if (error) {
    alert("Не удалось открыть чат: " + error.message);
    return;
  }

  const { data: members } = await supabaseClient
    .from('chat_members')
    .select('user_id')
    .eq('chat_id', chatId);

  currentChatData = { ...chat, members: members ? members.map(m => m.user_id) : [] };

  $('no-chat-selected').classList.add('hidden');
  $('chat-active').classList.remove('hidden');

  if (currentChatData.type === 'group') {
    $('chat-header-avatar').src = currentChatData.avatar_url || defaultAvatar(currentChatData.name || "G");
    $('chat-header-name').textContent = currentChatData.name || "Группа";
    $('chat-header-status').textContent = `${currentChatData.members.length} участников`;
  } else {
    const otherUserId = currentChatData.members.find(m => m !== currentUser.id);
    const otherProfile = await getProfile(otherUserId);
    $('chat-header-avatar').src = otherProfile ? (otherProfile.avatar_url || defaultAvatar(otherProfile.name)) : defaultAvatar("?");
    $('chat-header-name').textContent = otherProfile ? otherProfile.name : "Пользователь";
    $('chat-header-status').textContent = otherProfile && otherProfile.status === 'online' ? "в сети" : "не в сети";
  }

  document.querySelectorAll('.chat-list-item').forEach(el => el.classList.remove('active'));

  await loadMessages(chatId);
  subscribeToMessages(chatId);
}

async function loadMessages(chatId) {
  const container = $('messages-container');
  const { data: messages, error } = await supabaseClient
    .from('messages')
    .select('*')
    .eq('chat_id', chatId)
    .order('created_at', { ascending: true })
    .limit(100);

  if (error) {
    container.innerHTML = `<div class="empty-list-hint">Ошибка: ${escapeHtml(error.message)}</div>`;
    return;
  }

  container.innerHTML = "";
  for (const msg of messages) {
    await renderMessage(msg);
  }
  container.scrollTop = container.scrollHeight;
}

async function renderMessage(msg) {
  const container = $('messages-container');
  const isOut = msg.sender_id === currentUser.id;

  let senderName = "";
  if (currentChatData.type === 'group' && !isOut) {
    const senderProfile = await getProfile(msg.sender_id);
    senderName = senderProfile ? senderProfile.name : "";
  }

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble ' + (isOut ? 'out' : 'in');
  bubble.innerHTML = `
    ${senderName ? `<div class="message-sender">${escapeHtml(senderName)}</div>` : ""}
    <div>${escapeHtml(msg.text)}</div>
    <div class="message-time">${formatTime(msg.created_at)}</div>
  `;
  container.appendChild(bubble);
}

// Realtime: подписка на новые сообщения именно в открытом чате
function subscribeToMessages(chatId) {
  if (messagesChannel) supabaseClient.removeChannel(messagesChannel);

  messagesChannel = supabaseClient
    .channel(`messages-${chatId}`)
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages', filter: `chat_id=eq.${chatId}` },
      async (payload) => {
        await renderMessage(payload.new);
        const container = $('messages-container');
        container.scrollTop = container.scrollHeight;
      }
    )
    .subscribe();
}

// ===================================================================
// ОТПРАВКА СООБЩЕНИЯ
// ===================================================================
async function sendMessage() {
  const input = $('message-input');
  const text = input.value.trim();
  if (!text || !currentChatId) return;

  input.value = "";

  const { error: msgErr } = await supabaseClient.from('messages').insert({
    chat_id: currentChatId,
    sender_id: currentUser.id,
    text: text
  });

  if (msgErr) {
    alert("Не удалось отправить сообщение: " + msgErr.message);
    return;
  }

  await supabaseClient.from('chats').update({
    last_message: text,
    last_message_time: new Date().toISOString()
  }).eq('id', currentChatId);
}

$('send-btn').addEventListener('click', sendMessage);
$('message-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendMessage();
});

// ===================================================================
// СОЗДАНИЕ ГРУППЫ
// ===================================================================
$('new-group-btn').addEventListener('click', () => {
  selectedGroupMembers = {};
  $('group-name-input').value = "";
  $('group-member-search').value = "";
  $('group-member-results').innerHTML = "";
  $('group-selected-members').innerHTML = "";
  showError('group-error', "");
  $('group-modal').classList.remove('hidden');
});

$('group-cancel-btn').addEventListener('click', () => {
  $('group-modal').classList.add('hidden');
});

let groupSearchTimeout = null;
$('group-member-search').addEventListener('input', (e) => {
  clearTimeout(groupSearchTimeout);
  const query = e.target.value.trim();
  if (!query) {
    $('group-member-results').innerHTML = "";
    return;
  }
  groupSearchTimeout = setTimeout(() => {
    searchUsers(query, 'group-member-results', (userId, profile) => {
      selectedGroupMembers[userId] = profile;
      renderSelectedMembers();
      $('group-member-search').value = "";
      $('group-member-results').innerHTML = "";
    });
  }, 300);
});

function renderSelectedMembers() {
  const container = $('group-selected-members');
  container.innerHTML = "";
  Object.entries(selectedGroupMembers).forEach(([userId, profile]) => {
    const chip = document.createElement('div');
    chip.className = 'selected-member-chip';
    chip.innerHTML = `${escapeHtml(profile.name)} <span class="remove-chip" data-id="${userId}">✕</span>`;
    chip.querySelector('.remove-chip').addEventListener('click', () => {
      delete selectedGroupMembers[userId];
      renderSelectedMembers();
    });
    container.appendChild(chip);
  });
}

$('group-create-btn').addEventListener('click', async () => {
  const name = $('group-name-input').value.trim();

  if (!name) {
    showError('group-error', "Введите название группы");
    return;
  }
  const memberIds = Object.keys(selectedGroupMembers);
  if (memberIds.length === 0) {
    showError('group-error', "Добавьте хотя бы одного участника");
    return;
  }

  const { data: newChat, error: chatErr } = await supabaseClient
    .from('chats')
    .insert({
      type: 'group',
      name: name,
      avatar_url: defaultAvatar(name),
      created_by: currentUser.id,
      last_message: 'Группа создана',
      last_message_time: new Date().toISOString()
    })
    .select()
    .single();

  if (chatErr) {
    showError('group-error', "Ошибка: " + chatErr.message);
    return;
  }

  const allMembers = [currentUser.id, ...memberIds].map(uid => ({ chat_id: newChat.id, user_id: uid }));
  const { error: membersErr } = await supabaseClient.from('chat_members').insert(allMembers);

  if (membersErr) {
    showError('group-error', "Ошибка добавления участников: " + membersErr.message);
    return;
  }

  $('group-modal').classList.add('hidden');
  loadChats();
  openChat(newChat.id);
});

// ===================================================================
// ПРОФИЛЬ
// ===================================================================
$('open-my-profile').addEventListener('click', () => {
  $('profile-name-input').value = currentUser.name;
  $('profile-avatar-input').value = currentUser.avatar_url.startsWith('https://ui-avatars.com') ? "" : currentUser.avatar_url;
  $('profile-avatar-preview').src = currentUser.avatar_url;
  showError('profile-error', "");
  $('profile-modal').classList.remove('hidden');
});

$('profile-avatar-input').addEventListener('input', (e) => {
  const url = e.target.value.trim();
  $('profile-avatar-preview').src = url || defaultAvatar($('profile-name-input').value);
});

$('profile-cancel-btn').addEventListener('click', () => {
  $('profile-modal').classList.add('hidden');
});

$('profile-save-btn').addEventListener('click', async () => {
  const name = $('profile-name-input').value.trim();
  const avatarUrl = $('profile-avatar-input').value.trim();

  if (!name) {
    showError('profile-error', "Имя не может быть пустым");
    return;
  }

  const finalAvatar = avatarUrl || defaultAvatar(name);

  const { error } = await supabaseClient.from('profiles').update({
    name: name,
    avatar_url: finalAvatar
  }).eq('id', currentUser.id);

  if (error) {
    showError('profile-error', "Ошибка: " + error.message);
    return;
  }

  currentUser.name = name;
  currentUser.avatar_url = finalAvatar;
  $('my-name').textContent = name;
  $('my-avatar').src = finalAvatar;
  $('profile-modal').classList.add('hidden');
});

// ===================================================================
// ИНФО О ЧАТЕ / ГРУППЕ
// ===================================================================
$('chat-info-btn').addEventListener('click', async () => {
  if (!currentChatData) return;

  $('chatinfo-body').innerHTML = "";

  if (currentChatData.type === 'group') {
    $('chatinfo-title').textContent = currentChatData.name;
    const body = $('chatinfo-body');
    body.innerHTML = `<p style="margin-bottom:12px;color:var(--text-secondary)">Участники (${currentChatData.members.length}):</p>`;

    for (const userId of currentChatData.members) {
      const profile = await getProfile(userId);
      const row = document.createElement('div');
      row.className = 'chatinfo-member-item';
      row.innerHTML = `
        <img class="avatar" src="${escapeHtml(profile ? (profile.avatar_url || defaultAvatar(profile.name)) : defaultAvatar('?'))}" alt="">
        <span>${escapeHtml(profile ? profile.name : 'Пользователь')}${userId === currentUser.id ? ' (вы)' : ''}</span>
      `;
      body.appendChild(row);
    }
  } else {
    const otherUserId = currentChatData.members.find(m => m !== currentUser.id);
    const profile = await getProfile(otherUserId);
    $('chatinfo-title').textContent = "Информация о чате";
    $('chatinfo-body').innerHTML = `
      <div class="chatinfo-member-item">
        <img class="avatar" src="${escapeHtml(profile ? (profile.avatar_url || defaultAvatar(profile.name)) : defaultAvatar('?'))}" alt="">
        <span>${escapeHtml(profile ? profile.name : 'Пользователь')}</span>
      </div>
    `;
  }

  $('chatinfo-modal').classList.remove('hidden');
});

$('chatinfo-close-btn').addEventListener('click', () => {
  $('chatinfo-modal').classList.add('hidden');
});

// ===================================================================
// МОБИЛЬНАЯ НАВИГАЦИЯ: кнопка "назад" из чата к списку
// ===================================================================
$('back-to-list-btn').addEventListener('click', () => {
  document.querySelector('.app-layout').classList.remove('mobile-chat-open');
});

// ===================================================================
// НАСТРОЙКИ: тёмная тема (сохраняется в localStorage между визитами)
// ===================================================================
const THEME_KEY = 'messenger-theme';

function applyTheme(theme) {
  if (theme === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  $('theme-toggle').checked = (theme === 'dark');
}

// Применяем сохранённую тему сразу при загрузке страницы
applyTheme(localStorage.getItem(THEME_KEY) || 'light');

$('theme-toggle').addEventListener('change', (e) => {
  const theme = e.target.checked ? 'dark' : 'light';
  localStorage.setItem(THEME_KEY, theme);
  applyTheme(theme);
});

$('settings-btn').addEventListener('click', () => {
  $('settings-email-display').textContent = currentUser ? currentUser.email : "";
  $('settings-modal').classList.remove('hidden');
});

$('settings-close-btn').addEventListener('click', () => {
  $('settings-modal').classList.add('hidden');
});
