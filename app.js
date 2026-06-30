// ===================================================================
// ГЛОБАЛЬНОЕ СОСТОЯНИЕ
// ===================================================================
let currentUser = null;          // { id, name, avatar_url, email }
let currentChatId = null;
let currentChatData = null;      // { id, type, name, avatar_url, members: [...] }
let messagesChannel = null;      // подписка realtime на сообщения текущего чата
let chatsChannel = null;         // подписка realtime на изменения чатов
let reactionsChannel = null;     // подписка realtime на реакции текущего чата
let typingChannel = null;        // канал broadcast для индикатора "печатает"
let selectedGroupMembers = {};   // { id: {name, avatar_url} }
let profilesCache = {};          // { id: {name, avatar_url, status} }
let isCurrentUserAdmin = false;  // флаг прав администратора
let contextMenuTarget = null;    // данные текущей цели для ПКМ-меню

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
$('burger-logout').addEventListener('click', async () => {
  closeBurgerMenu();
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
  if (reactionsChannel) { supabaseClient.removeChannel(reactionsChannel); reactionsChannel = null; }
  if (typingChannel) { supabaseClient.removeChannel(typingChannel); typingChannel = null; }
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

    // Если пользователь заблокирован — предупреждаем (но не выгоняем:
    // он сможет читать сообщения, просто не сможет их отправлять —
    // это уже обеспечено политикой RLS is_not_banned())
    const isBanned = profile.is_banned && (!profile.banned_until || new Date(profile.banned_until) > new Date());
    if (isBanned) {
      const untilText = profile.banned_until ? ` до ${new Date(profile.banned_until).toLocaleString('ru-RU')}` : ' навсегда';
      alert(`Ваш аккаунт заблокирован администратором${untilText}.${profile.ban_reason ? '\nПричина: ' + profile.ban_reason : ''}\n\nВы можете читать сообщения, но не можете их отправлять.`);
    }

    await supabaseClient.from('profiles').update({
      status: 'online',
      last_seen: new Date().toISOString()
    }).eq('id', currentUser.id);

    // Проверяем, есть ли у пользователя права администратора
    const { data: adminRow } = await supabaseClient
      .from('admins')
      .select('user_id')
      .eq('user_id', currentUser.id)
      .maybeSingle();
    isCurrentUserAdmin = !!adminRow;

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
    let displayName, displayAvatar, preview;

    if (chat.type === 'group') {
      displayName = chat.name || "Группа";
      displayAvatar = chat.avatar_url || defaultAvatar(chat.name || "G");
      preview = chat.last_message || "Нет сообщений";
    } else if (chat.type === 'channel') {
      displayName = "📢 " + (chat.name || "Канал");
      displayAvatar = chat.avatar_url || defaultAvatar(chat.name || "K");
      preview = chat.last_message || "Нет сообщений";
    } else {
      const otherProfile = await getOtherMemberProfile(chat.id);
      displayName = otherProfile ? otherProfile.name : "Пользователь";
      displayAvatar = otherProfile ? (otherProfile.avatar_url || defaultAvatar(otherProfile.name)) : defaultAvatar("?");
      preview = chat.last_message || "Нет сообщений";

      // Read receipt: показываем галочку, если последнее сообщение моё
      // и собеседник его прочитал (last_read_at >= last_message_time)
      const { data: lastMsg } = await supabaseClient
        .from('messages').select('sender_id').eq('chat_id', chat.id)
        .order('created_at', { ascending: false }).limit(1).maybeSingle();

      if (lastMsg && lastMsg.sender_id === currentUser.id) {
        const { data: otherMember } = await supabaseClient
          .from('chat_members').select('last_read_at')
          .eq('chat_id', chat.id).neq('user_id', currentUser.id).maybeSingle();

        const isRead = otherMember && chat.last_message_time &&
          new Date(otherMember.last_read_at) >= new Date(chat.last_message_time);
        preview = (isRead ? '✓✓ ' : '✓ ') + preview;
      }
    }

    const item = document.createElement('div');
    item.className = 'chat-list-item' + (chat.id === currentChatId ? ' active' : '');
    item.innerHTML = `
      <img class="avatar" src="${escapeHtml(displayAvatar)}" alt="">
      <div class="chat-item-info">
        <div class="chat-item-name">${escapeHtml(displayName)}</div>
        <div class="chat-item-preview">${escapeHtml(preview)}</div>
      </div>
    `;
    item.addEventListener('click', () => openChat(chat.id));
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showChatContextMenu(e, chat);
    });
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

  // Сбрасываем состояние, оставшееся от предыдущего чата
  pendingImageFile = null;
  $('image-file-input').value = "";
  $('image-preview-row').classList.add('hidden');
  $('typing-indicator').classList.add('hidden');

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
    $('message-input-row').classList.remove('hidden');
  } else if (currentChatData.type === 'channel') {
    $('chat-header-avatar').src = currentChatData.avatar_url || defaultAvatar(currentChatData.name || "K");
    $('chat-header-name').textContent = "📢 " + (currentChatData.name || "Канал");
    $('chat-header-status').textContent = `${currentChatData.members.length} подписчиков`;
    // Писать в канал может только его создатель — остальные только читают
    const isOwner = currentChatData.created_by === currentUser.id;
    $('message-input-row').classList.toggle('hidden', !isOwner);
  } else {
    const otherUserId = currentChatData.members.find(m => m !== currentUser.id);
    const otherProfile = await getProfile(otherUserId);
    $('chat-header-avatar').src = otherProfile ? (otherProfile.avatar_url || defaultAvatar(otherProfile.name)) : defaultAvatar("?");
    $('chat-header-name').textContent = otherProfile ? otherProfile.name : "Пользователь";
    $('chat-header-status').textContent = otherProfile && otherProfile.status === 'online' ? "в сети" : "не в сети";
    $('message-input-row').classList.remove('hidden');
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

  await loadReactionsForChat(messages.map(m => m.id));
  markChatAsRead(chatId);
}

async function markChatAsRead(chatId) {
  await supabaseClient.from('chat_members').update({
    last_read_at: new Date().toISOString()
  }).eq('chat_id', chatId).eq('user_id', currentUser.id);
}

// Кэш реакций по сообщению: { messageId: [{user_id, emoji}, ...] }
let reactionsCache = {};
let pendingImageFile = null; // выбранный файл картинки перед отправкой

const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];

async function renderMessage(msg) {
  const container = $('messages-container');
  const isOut = msg.sender_id === currentUser.id;

  let senderName = "";
  if ((currentChatData.type === 'group' || currentChatData.type === 'channel') && !isOut) {
    const senderProfile = await getProfile(msg.sender_id);
    senderName = senderProfile ? senderProfile.name : "";
  }

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble ' + (isOut ? 'out' : 'in');
  bubble.dataset.messageId = msg.id;
  renderMessageContent(bubble, msg, senderName);

  bubble.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showMessageContextMenu(e, msg, isOut);
  });
  bubble.addEventListener('dblclick', () => toggleReactionPicker(bubble, msg.id));

  container.appendChild(bubble);

  // Подгружаем реакции, если уже есть в кэше (после realtime-события)
  if (reactionsCache[msg.id]) renderReactions(bubble, msg.id);
}

function renderMessageContent(bubble, msg, senderName) {
  const editedTag = msg.edited_at ? `<span class="message-edited-tag">(ред.)</span>` : "";
  bubble.innerHTML = `
    ${senderName ? `<div class="message-sender">${escapeHtml(senderName)}</div>` : ""}
    ${msg.image_url ? `<img class="message-image" src="${escapeHtml(msg.image_url)}" alt="" onclick="window.open(this.src, '_blank')">` : ""}
    ${msg.text ? `<div class="message-text">${escapeHtml(msg.text)}</div>` : ""}
    <div class="message-time">${formatTime(msg.created_at)}${editedTag}</div>
    <div class="message-reactions" data-reactions-for="${msg.id}"></div>
  `;
}

function renderReactions(bubble, messageId) {
  const container = bubble.querySelector(`[data-reactions-for="${messageId}"]`);
  if (!container) return;
  const reactions = reactionsCache[messageId] || [];

  // Группируем по эмодзи: { emoji: { count, mine } }
  const grouped = {};
  reactions.forEach(r => {
    if (!grouped[r.emoji]) grouped[r.emoji] = { count: 0, mine: false };
    grouped[r.emoji].count++;
    if (r.user_id === currentUser.id) grouped[r.emoji].mine = true;
  });

  container.innerHTML = Object.entries(grouped).map(([emoji, info]) => `
    <span class="reaction-chip${info.mine ? ' mine' : ''}" data-emoji="${emoji}">${emoji} ${info.count}</span>
  `).join('');

  container.querySelectorAll('.reaction-chip').forEach(chip => {
    chip.addEventListener('click', () => toggleReaction(messageId, chip.dataset.emoji));
  });
}

function toggleReactionPicker(bubble, messageId) {
  let picker = bubble.querySelector('.reaction-picker');
  if (picker) { picker.remove(); return; }

  picker = document.createElement('div');
  picker.className = 'reaction-picker';
  picker.innerHTML = REACTION_EMOJIS.map(e => `<span data-emoji="${e}">${e}</span>`).join('');
  picker.querySelectorAll('span').forEach(span => {
    span.addEventListener('click', () => {
      toggleReaction(messageId, span.dataset.emoji);
      picker.remove();
    });
  });
  bubble.appendChild(picker);
}

async function toggleReaction(messageId, emoji) {
  const existing = (reactionsCache[messageId] || []).find(r => r.user_id === currentUser.id && r.emoji === emoji);

  if (existing) {
    await supabaseClient.from('message_reactions').delete()
      .eq('message_id', messageId).eq('user_id', currentUser.id).eq('emoji', emoji);
  } else {
    await supabaseClient.from('message_reactions').insert({
      message_id: messageId, user_id: currentUser.id, emoji
    });
  }
  // UI обновится через realtime-подписку subscribeToReactions
}

async function loadReactionsForChat(messageIds) {
  if (messageIds.length === 0) return;
  const { data } = await supabaseClient
    .from('message_reactions')
    .select('message_id, user_id, emoji')
    .in('message_id', messageIds);

  reactionsCache = {};
  (data || []).forEach(r => {
    if (!reactionsCache[r.message_id]) reactionsCache[r.message_id] = [];
    reactionsCache[r.message_id].push(r);
  });

  document.querySelectorAll('.message-bubble').forEach(bubble => {
    renderReactions(bubble, bubble.dataset.messageId);
  });
}

function subscribeToReactions(chatId) {
  if (reactionsChannel) supabaseClient.removeChannel(reactionsChannel);

  reactionsChannel = supabaseClient
    .channel(`reactions-${chatId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'message_reactions' }, (payload) => {
      const msgId = (payload.new && payload.new.message_id) || (payload.old && payload.old.message_id);
      if (!msgId) return;

      // Просто перезапрашиваем реакции для этого сообщения — надёжнее, чем
      // вручную патчить локальный кэш по insert/delete
      supabaseClient.from('message_reactions').select('message_id, user_id, emoji').eq('message_id', msgId)
        .then(({ data }) => {
          reactionsCache[msgId] = data || [];
          const bubble = document.querySelector(`[data-message-id="${msgId}"]`);
          if (bubble) renderReactions(bubble, msgId);
        });
    })
    .subscribe();
}

// Realtime: подписка на новые/изменённые сообщения именно в открытом чате
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
        markChatAsRead(chatId);
      }
    )
    .on('postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'messages', filter: `chat_id=eq.${chatId}` },
      async (payload) => {
        const bubble = document.querySelector(`[data-message-id="${payload.new.id}"]`);
        if (bubble) {
          const isOut = payload.new.sender_id === currentUser.id;
          let senderName = "";
          if ((currentChatData.type === 'group' || currentChatData.type === 'channel') && !isOut) {
            const p = await getProfile(payload.new.sender_id);
            senderName = p ? p.name : "";
          }
          renderMessageContent(bubble, payload.new, senderName);
          if (reactionsCache[payload.new.id]) renderReactions(bubble, payload.new.id);
        }
      }
    )
    .on('postgres_changes',
      { event: 'DELETE', schema: 'public', table: 'messages' },
      (payload) => {
        const bubble = document.querySelector(`[data-message-id="${payload.old.id}"]`);
        if (bubble) bubble.remove();
      }
    )
    .subscribe();

  subscribeToReactions(chatId);
  subscribeToTyping(chatId);
}

// ===================================================================
// ВЫБОР И ПРЕВЬЮ КАРТИНКИ ПЕРЕД ОТПРАВКОЙ
// ===================================================================
$('attach-image-btn').addEventListener('click', () => $('image-file-input').click());

$('image-file-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  pendingImageFile = file;
  $('image-preview').src = URL.createObjectURL(file);
  $('image-preview-row').classList.remove('hidden');
});

$('image-preview-remove').addEventListener('click', () => {
  pendingImageFile = null;
  $('image-file-input').value = "";
  $('image-preview-row').classList.add('hidden');
});

// ===================================================================
// ОТПРАВКА СООБЩЕНИЯ (текст и/или картинка)
// ===================================================================
async function sendMessage() {
  const input = $('message-input');
  const text = input.value.trim();
  if (!text && !pendingImageFile) return;
  if (!currentChatId) return;

  input.value = "";
  const fileToSend = pendingImageFile;
  pendingImageFile = null;
  $('image-file-input').value = "";
  $('image-preview-row').classList.add('hidden');

  let imageUrl = null;
  if (fileToSend) {
    const filePath = `${currentUser.id}/${Date.now()}_${fileToSend.name}`;
    const { error: uploadErr } = await supabaseClient.storage
      .from('chat-images')
      .upload(filePath, fileToSend);

    if (uploadErr) {
      alert("Не удалось загрузить изображение: " + uploadErr.message);
      return;
    }
    const { data: urlData } = supabaseClient.storage.from('chat-images').getPublicUrl(filePath);
    imageUrl = urlData.publicUrl;
  }

  const { error: msgErr } = await supabaseClient.from('messages').insert({
    chat_id: currentChatId,
    sender_id: currentUser.id,
    text: text || null,
    image_url: imageUrl
  });

  if (msgErr) {
    if (msgErr.message && msgErr.message.includes('row-level security')) {
      alert("Вы не можете отправлять сообщения: ваш аккаунт заблокирован администратором.");
    } else {
      alert("Не удалось отправить сообщение: " + msgErr.message);
    }
    return;
  }

  await supabaseClient.from('chats').update({
    last_message: text || '📷 Изображение',
    last_message_time: new Date().toISOString()
  }).eq('id', currentChatId);

  stopTyping();
}

$('send-btn').addEventListener('click', sendMessage);
$('message-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendMessage();
});

// ===================================================================
// РЕДАКТИРОВАНИЕ СВОИХ СООБЩЕНИЙ
// ===================================================================
async function startEditMessage(msg) {
  const bubble = document.querySelector(`[data-message-id="${msg.id}"]`);
  if (!bubble) return;

  const textDiv = bubble.querySelector('.message-text');
  const currentText = msg.text || "";

  const editBox = document.createElement('div');
  editBox.className = 'message-edit-box';
  editBox.innerHTML = `
    <input type="text" class="message-edit-input" value="${escapeHtml(currentText)}">
    <div class="message-edit-actions">
      <span data-action="save">Сохранить</span>
      <span data-action="cancel">Отмена</span>
    </div>
  `;

  if (textDiv) textDiv.replaceWith(editBox); else bubble.insertBefore(editBox, bubble.querySelector('.message-time'));

  const editInput = editBox.querySelector('.message-edit-input');
  editInput.focus();

  editBox.querySelector('[data-action="save"]').addEventListener('click', async () => {
    const newText = editInput.value.trim();
    if (!newText) return;
    const { error } = await supabaseClient.from('messages').update({
      text: newText, edited_at: new Date().toISOString()
    }).eq('id', msg.id);
    if (error) alert('Не удалось сохранить: ' + error.message);
    // UI обновится через realtime UPDATE-подписку
  });

  editBox.querySelector('[data-action="cancel"]').addEventListener('click', async () => {
    renderMessageContent(bubble, msg, "");
    if (reactionsCache[msg.id]) renderReactions(bubble, msg.id);
  });
}

// ===================================================================
// ИНДИКАТОР "ПЕЧАТАЕТ..." (через Supabase Realtime Presence/Broadcast)
// ===================================================================
let typingTimeout = null;

function subscribeToTyping(chatId) {
  if (typingChannel) supabaseClient.removeChannel(typingChannel);

  typingChannel = supabaseClient.channel(`typing-${chatId}`, {
    config: { broadcast: { self: false } }
  });

  typingChannel.on('broadcast', { event: 'typing' }, async ({ payload }) => {
    if (payload.userId === currentUser.id) return;
    const profile = await getProfile(payload.userId);
    $('typing-indicator').textContent = `${profile ? profile.name : 'Собеседник'} печатает...`;
    $('typing-indicator').classList.remove('hidden');
    clearTimeout(window._typingHideTimeout);
    window._typingHideTimeout = setTimeout(() => $('typing-indicator').classList.add('hidden'), 3000);
  });

  typingChannel.subscribe();
}

function broadcastTyping() {
  if (!typingChannel || !currentChatId) return;
  typingChannel.send({ type: 'broadcast', event: 'typing', payload: { userId: currentUser.id } });
}

function stopTyping() {
  clearTimeout(typingTimeout);
}

$('message-input').addEventListener('input', () => {
  broadcastTyping();
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(stopTyping, 1500);
});

// ===================================================================
// БУРГЕР-МЕНЮ
// ===================================================================
function openBurgerMenu() {
  $('burger-avatar').src = currentUser.avatar_url;
  $('burger-name').textContent = currentUser.name;
  $('burger-email').textContent = currentUser.email;
  $('burger-admin').classList.toggle('hidden', !isCurrentUserAdmin);
  $('burger-admin-login').classList.toggle('hidden', isCurrentUserAdmin);
  $('burger-overlay').classList.remove('hidden');
}
function closeBurgerMenu() {
  $('burger-overlay').classList.add('hidden');
}

$('burger-btn').addEventListener('click', openBurgerMenu);
$('burger-overlay').addEventListener('click', (e) => {
  if (e.target === $('burger-overlay')) closeBurgerMenu();
});

$('burger-profile').addEventListener('click', () => {
  closeBurgerMenu();
  $('open-my-profile').click();
});

$('burger-new-group').addEventListener('click', () => {
  closeBurgerMenu();
  openGroupModal();
});

$('burger-new-channel').addEventListener('click', () => {
  closeBurgerMenu();
  openChannelModal();
});

$('burger-settings').addEventListener('click', () => {
  closeBurgerMenu();
  $('settings-email-display').textContent = currentUser ? currentUser.email : "";
  $('settings-modal').classList.remove('hidden');
});

$('burger-admin').addEventListener('click', () => {
  closeBurgerMenu();
  openAdminPanel();
});

$('burger-admin-login').addEventListener('click', () => {
  closeBurgerMenu();
  $('admincode-input').value = "";
  showError('admincode-error', "");
  $('admincode-modal').classList.remove('hidden');
});

// ===================================================================
// СОЗДАНИЕ ГРУППЫ
// ===================================================================
function openGroupModal() {
  selectedGroupMembers = {};
  $('group-name-input').value = "";
  $('group-member-search').value = "";
  $('group-member-results').innerHTML = "";
  $('group-selected-members').innerHTML = "";
  showError('group-error', "");
  $('group-modal').classList.remove('hidden');
}

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
// СОЗДАНИЕ КАНАЛА
// ===================================================================
function openChannelModal() {
  $('channel-name-input').value = "";
  $('channel-desc-input').value = "";
  showError('channel-error', "");
  $('channel-modal').classList.remove('hidden');
}

$('channel-cancel-btn').addEventListener('click', () => {
  $('channel-modal').classList.add('hidden');
});

$('channel-create-btn').addEventListener('click', async () => {
  const name = $('channel-name-input').value.trim();
  const description = $('channel-desc-input').value.trim();

  if (!name) {
    showError('channel-error', "Введите название канала");
    return;
  }

  const { data: newChat, error: chatErr } = await supabaseClient
    .from('chats')
    .insert({
      type: 'channel',
      name: name,
      description: description,
      avatar_url: defaultAvatar(name),
      created_by: currentUser.id,
      last_message: 'Канал создан',
      last_message_time: new Date().toISOString()
    })
    .select()
    .single();

  if (chatErr) {
    showError('channel-error', "Ошибка: " + chatErr.message);
    return;
  }

  const { error: memberErr } = await supabaseClient
    .from('chat_members')
    .insert({ chat_id: newChat.id, user_id: currentUser.id });

  if (memberErr) {
    showError('channel-error', "Ошибка: " + memberErr.message);
    return;
  }

  $('channel-modal').classList.add('hidden');
  loadChats();
  openChat(newChat.id);
});

// ===================================================================
// АДМИНКА: вход по коду
// ===================================================================
$('admincode-cancel-btn').addEventListener('click', () => {
  $('admincode-modal').classList.add('hidden');
});

$('admincode-submit-btn').addEventListener('click', async () => {
  const code = $('admincode-input').value.trim();
  if (!code) {
    showError('admincode-error', "Введите код");
    return;
  }

  const { data, error } = await supabaseClient.rpc('redeem_admin_code', { code });

  if (error) {
    showError('admincode-error', "Ошибка: " + error.message);
    return;
  }

  if (data === true) {
    isCurrentUserAdmin = true;
    $('admincode-modal').classList.add('hidden');
    openAdminPanel();
  } else {
    showError('admincode-error', "Неверный код доступа");
  }
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

  if (currentChatData.type === 'group' || currentChatData.type === 'channel') {
    const label = currentChatData.type === 'channel' ? 'Подписчики' : 'Участники';
    $('chatinfo-title').textContent = currentChatData.name;
    const body = $('chatinfo-body');
    body.innerHTML = `<p style="margin-bottom:12px;color:var(--dusk)">${label} (${currentChatData.members.length}):</p>`;

    for (const userId of currentChatData.members) {
      const profile = await getProfile(userId);
      const row = document.createElement('div');
      row.className = 'chatinfo-member-item';
      row.innerHTML = `
        <img class="avatar" src="${escapeHtml(profile ? (profile.avatar_url || defaultAvatar(profile.name)) : defaultAvatar('?'))}" alt="">
        <span>${escapeHtml(profile ? profile.name : 'Пользователь')}${userId === currentUser.id ? ' (вы)' : ''}${userId === currentChatData.created_by ? ' 👑' : ''}</span>
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

$('settings-close-btn').addEventListener('click', () => {
  $('settings-modal').classList.add('hidden');
});

// ===================================================================
// КОНТЕКСТНОЕ МЕНЮ (ПКМ)
// ===================================================================
function showContextMenu(x, y, items) {
  const menu = $('context-menu');
  menu.innerHTML = "";

  items.forEach(item => {
    const row = document.createElement('div');
    row.className = 'context-menu-item' + (item.danger ? ' danger' : '');
    row.innerHTML = `<span>${item.icon || ''}</span><span>${escapeHtml(item.label)}</span>`;
    row.addEventListener('click', () => {
      hideContextMenu();
      item.action();
    });
    menu.appendChild(row);
  });

  menu.classList.remove('hidden');

  // Не даём меню вылезти за правый/нижний край экрана
  const menuWidth = 200, menuHeight = items.length * 42 + 12;
  const finalX = Math.min(x, window.innerWidth - menuWidth - 8);
  const finalY = Math.min(y, window.innerHeight - menuHeight - 8);
  menu.style.left = finalX + 'px';
  menu.style.top = finalY + 'px';
}

function hideContextMenu() {
  $('context-menu').classList.add('hidden');
}

document.addEventListener('click', (e) => {
  if (!$('context-menu').contains(e.target)) hideContextMenu();
});
document.addEventListener('scroll', hideContextMenu, true);

// ПКМ на сообщении: копировать всегда, удалить — если своё или ты админ канала/группы
function showMessageContextMenu(e, msg, isOut) {
  const items = [];

  if (msg.text) {
    items.push({ icon: '📋', label: 'Копировать текст', action: () => {
      navigator.clipboard.writeText(msg.text).catch(() => {});
    }});
  }

  items.push({ icon: '😀', label: 'Реакция', action: () => {
    const bubble = document.querySelector(`[data-message-id="${msg.id}"]`);
    if (bubble) toggleReactionPicker(bubble, msg.id);
  }});

  if (isOut && msg.text) {
    items.push({ icon: '✏️', label: 'Редактировать', action: () => startEditMessage(msg) });
  }

  if (isOut || isCurrentUserAdmin) {
    items.push({ icon: '🗑️', label: 'Удалить сообщение', danger: true, action: async () => {
      const { error } = await supabaseClient.from('messages').delete().eq('id', msg.id);
      if (!error) {
        const el = document.querySelector(`[data-message-id="${msg.id}"]`);
        if (el) el.remove();
      } else {
        alert('Не удалось удалить: ' + error.message);
      }
    }});
  }

  showContextMenu(e.clientX, e.clientY, items);
}

// ПКМ на чате в списке: выйти из чата / удалить (если ты владелец или админ)
function showChatContextMenu(e, chat) {
  const isOwner = chat.created_by === currentUser.id;
  const items = [];

  const chatLabel = chat.type === 'group' ? 'группы' : (chat.type === 'channel' ? 'канала' : 'чата');

  if (!isOwner) {
    items.push({ icon: '🚪', label: `Покинуть ${chatLabel}`, danger: true, action: async () => {
      await supabaseClient.from('chat_members').delete()
        .eq('chat_id', chat.id).eq('user_id', currentUser.id);
      if (currentChatId === chat.id) {
        currentChatId = null;
        $('chat-active').classList.add('hidden');
        $('no-chat-selected').classList.remove('hidden');
      }
      loadChats();
    }});
  }

  if (isOwner || isCurrentUserAdmin) {
    items.push({ icon: '🗑️', label: `Удалить ${chatLabel}`, danger: true, action: async () => {
      await supabaseClient.from('chats').delete().eq('id', chat.id);
      if (currentChatId === chat.id) {
        currentChatId = null;
        $('chat-active').classList.add('hidden');
        $('no-chat-selected').classList.remove('hidden');
      }
      loadChats();
    }});
  }

  if (items.length === 0) {
    items.push({ icon: 'ℹ️', label: 'Нет доступных действий', action: () => {} });
  }

  showContextMenu(e.clientX, e.clientY, items);
}

// ===================================================================
// АДМИН-ПАНЕЛЬ
// ===================================================================
let allAdminUsers = [];   // кэш для локального поиска
let allAdminChats = [];   // кэш для локального поиска

async function openAdminPanel() {
  showScreen('admin-screen');
  await loadAdminStats();
  switchAdminTab('stats');
}

$('admin-back-btn').addEventListener('click', () => {
  showScreen('app-screen');
});

document.querySelectorAll('.admin-tab').forEach(tab => {
  tab.addEventListener('click', () => switchAdminTab(tab.dataset.tab));
});

function switchAdminTab(tabName) {
  document.querySelectorAll('.admin-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
  document.querySelectorAll('.admin-tab-content').forEach(c => c.classList.add('hidden'));
  $(`admin-tab-${tabName}`).classList.remove('hidden');

  if (tabName === 'users') loadAdminUsers();
  if (tabName === 'chats') loadAdminChats();
  if (tabName === 'charts') loadAdminCharts();
  if (tabName === 'logs') loadAdminLogs();
}

async function loadAdminStats() {
  const grid = $('admin-stats-grid');
  grid.innerHTML = `<div class="empty-list-hint">Загрузка...</div>`;

  const { data, error } = await supabaseClient.rpc('get_admin_stats');

  if (error) {
    grid.innerHTML = `<div class="empty-list-hint">Ошибка: ${escapeHtml(error.message)}</div>`;
    return;
  }

  const cards = [
    { label: 'Всего пользователей', value: data.total_users },
    { label: 'Сейчас онлайн', value: data.online_users },
    { label: 'Заблокировано', value: data.banned_users },
    { label: 'Администраторов', value: data.total_admins },
    { label: 'Всего чатов', value: data.total_chats },
    { label: 'Групп', value: data.total_groups },
    { label: 'Каналов', value: data.total_channels },
    { label: 'Всего сообщений', value: data.total_messages },
    { label: 'Сообщений сегодня', value: data.messages_today },
  ];

  grid.innerHTML = cards.map(c => `
    <div class="admin-stat-card">
      <div class="admin-stat-value">${c.value}</div>
      <div class="admin-stat-label">${escapeHtml(c.label)}</div>
    </div>
  `).join('');
}

// ===================================================================
// АДМИНКА: ГРАФИКИ АКТИВНОСТИ
// ===================================================================
async function loadAdminCharts() {
  const container = $('admin-charts-container');
  container.innerHTML = `<div class="empty-list-hint">Загрузка...</div>`;

  const { data, error } = await supabaseClient.rpc('get_activity_chart');

  if (error) {
    container.innerHTML = `<div class="empty-list-hint">Ошибка: ${escapeHtml(error.message)}</div>`;
    return;
  }

  container.innerHTML = `
    <div class="chart-block">
      <div class="chart-title">Регистрации за 30 дней</div>
      <div class="chart-bars" id="chart-registrations"></div>
    </div>
    <div class="chart-block">
      <div class="chart-title">Сообщения за 30 дней</div>
      <div class="chart-bars" id="chart-messages"></div>
    </div>
  `;

  renderChartBars('chart-registrations', data.registrations);
  renderChartBars('chart-messages', data.messages);
}

function renderChartBars(containerId, points) {
  const container = $(containerId);
  if (!points || points.length === 0) {
    container.innerHTML = `<div class="empty-list-hint">Нет данных за этот период</div>`;
    return;
  }

  // Строим непрерывный диапазон последних 30 дней, заполняя пропуски нулями
  const map = {};
  points.forEach(p => { map[p.day] = p.count; });

  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    days.push({ key, count: map[key] || 0 });
  }

  const maxCount = Math.max(...days.map(d => d.count), 1);

  container.innerHTML = days.map(d => {
    const heightPct = Math.max((d.count / maxCount) * 100, 2);
    const dateLabel = new Date(d.key).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
    return `<div class="chart-bar" style="height:${heightPct}%" data-tooltip="${dateLabel}: ${d.count}"></div>`;
  }).join('');
}

// ===================================================================
// АДМИНКА: ПОЛЬЗОВАТЕЛИ (бан, роли, удаление, поиск)
// ===================================================================
async function loadAdminUsers() {
  const list = $('admin-users-list');
  list.innerHTML = `<div class="empty-list-hint">Загрузка...</div>`;

  const { data: profiles, error } = await supabaseClient
    .from('profiles')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    list.innerHTML = `<div class="empty-list-hint">Ошибка: ${escapeHtml(error.message)}</div>`;
    return;
  }

  const { data: admins } = await supabaseClient.from('admins').select('user_id');
  const adminIds = new Set((admins || []).map(a => a.user_id));

  allAdminUsers = (profiles || []).map(p => ({ ...p, is_admin: adminIds.has(p.id) }));
  renderAdminUsersList(allAdminUsers);
}

$('admin-users-search').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  const filtered = q ? allAdminUsers.filter(u => u.name.toLowerCase().includes(q)) : allAdminUsers;
  renderAdminUsersList(filtered);
});

function renderAdminUsersList(users) {
  const list = $('admin-users-list');

  if (!users || users.length === 0) {
    list.innerHTML = `<div class="empty-list-hint">Пользователей не найдено</div>`;
    return;
  }

  list.innerHTML = "";
  users.forEach(profile => {
    const banned = profile.is_banned && (!profile.banned_until || new Date(profile.banned_until) > new Date());
    const row = document.createElement('div');
    row.className = 'admin-list-row';
    row.innerHTML = `
      <img class="avatar" src="${escapeHtml(profile.avatar_url || defaultAvatar(profile.name))}" alt="">
      <div class="admin-list-row-info">
        <div class="admin-list-row-name">
          ${escapeHtml(profile.name)}
          ${profile.is_admin ? '<span class="badge badge-admin">админ</span>' : ''}
          ${banned ? '<span class="badge badge-banned">блокирован</span>' : ''}
        </div>
        <div class="admin-list-row-meta">${profile.status === 'online' ? '🟢 онлайн' : 'не в сети'}</div>
      </div>
      <select data-action="role">
        <option value="user" ${!profile.is_admin ? 'selected' : ''}>Пользователь</option>
        <option value="admin" ${profile.is_admin ? 'selected' : ''}>Администратор</option>
      </select>
      <button data-action="ban">${banned ? 'Разблок.' : 'Блок.'}</button>
      <button class="danger" data-action="delete">Удалить</button>
    `;

    row.querySelector('[data-action="role"]').addEventListener('change', async (ev) => {
      const makeAdmin = ev.target.value === 'admin';
      if (profile.id === currentUser.id && !makeAdmin) {
        alert('Нельзя снять права администратора с самого себя');
        ev.target.value = 'admin';
        return;
      }
      const { error: roleErr } = await supabaseClient.rpc('set_admin_role', {
        target_user_id: profile.id, make_admin: makeAdmin
      });
      if (roleErr) { alert('Ошибка: ' + roleErr.message); return; }
      loadAdminUsers();
    });

    row.querySelector('[data-action="ban"]').addEventListener('click', () => {
      if (banned) {
        confirmUnban(profile);
      } else {
        openBanModal(profile);
      }
    });

    row.querySelector('[data-action="delete"]').addEventListener('click', async () => {
      if (profile.id === currentUser.id) {
        alert('Нельзя удалить свой собственный аккаунт через админку');
        return;
      }
      if (!confirm(`Удалить пользователя «${profile.name}»? Это действие нельзя отменить.`)) return;

      const { error: delErr } = await supabaseClient.rpc('admin_delete_user', { target_user_id: profile.id });
      if (delErr) { alert('Не удалось удалить: ' + delErr.message); return; }
      loadAdminUsers();
      loadAdminStats();
    });

    list.appendChild(row);
  });
}

async function confirmUnban(profile) {
  if (!confirm(`Разблокировать пользователя «${profile.name}»?`)) return;
  const { error } = await supabaseClient.rpc('set_user_ban', { target_user_id: profile.id, ban: false });
  if (error) { alert('Ошибка: ' + error.message); return; }
  loadAdminUsers();
}

let banTargetUser = null;

function openBanModal(profile) {
  banTargetUser = profile;
  $('ban-reason-input').value = "";
  $('ban-duration-select').value = "";
  showError('ban-error', "");
  $('ban-modal').classList.remove('hidden');
}

$('ban-cancel-btn').addEventListener('click', () => {
  $('ban-modal').classList.add('hidden');
});

$('ban-confirm-btn').addEventListener('click', async () => {
  if (!banTargetUser) return;
  const reason = $('ban-reason-input').value.trim() || null;
  const durationVal = $('ban-duration-select').value;
  const hours = durationVal ? parseInt(durationVal, 10) : null;

  const { error } = await supabaseClient.rpc('set_user_ban', {
    target_user_id: banTargetUser.id, ban: true, reason, hours
  });

  if (error) {
    showError('ban-error', 'Ошибка: ' + error.message);
    return;
  }

  $('ban-modal').classList.add('hidden');
  loadAdminUsers();
  loadAdminStats();
});

// ===================================================================
// АДМИНКА: ЧАТЫ И МОДЕРАЦИЯ (поиск, удаление через RPC с логом)
// ===================================================================
async function loadAdminChats() {
  const list = $('admin-chats-list');
  list.innerHTML = `<div class="empty-list-hint">Загрузка...</div>`;
  $('admin-chat-messages').innerHTML = `<p class="empty-list-hint">Выберите чат, чтобы посмотреть сообщения</p>`;

  const { data, error } = await supabaseClient
    .from('chats')
    .select('*')
    .order('last_message_time', { ascending: false });

  if (error) {
    list.innerHTML = `<div class="empty-list-hint">Ошибка: ${escapeHtml(error.message)}</div>`;
    return;
  }

  allAdminChats = data || [];
  renderAdminChatsList(allAdminChats);
}

$('admin-chats-search').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  const filtered = q ? allAdminChats.filter(c => (c.name || '').toLowerCase().includes(q)) : allAdminChats;
  renderAdminChatsList(filtered);
});

function renderAdminChatsList(chats) {
  const list = $('admin-chats-list');

  if (!chats || chats.length === 0) {
    list.innerHTML = `<div class="empty-list-hint">Чатов не найдено</div>`;
    return;
  }

  list.innerHTML = "";
  chats.forEach(chat => {
    const typeLabel = chat.type === 'group' ? '👥 Группа' : (chat.type === 'channel' ? '📢 Канал' : '💬 Личный чат');
    const row = document.createElement('div');
    row.className = 'admin-list-row';
    row.innerHTML = `
      <div class="admin-list-row-info">
        <div class="admin-list-row-name">${escapeHtml(chat.name || typeLabel)}</div>
        <div class="admin-list-row-meta">${typeLabel}</div>
      </div>
      <button class="danger" data-action="delete">Удалить</button>
    `;
    row.querySelector('[data-action="delete"]').addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (!confirm('Удалить этот чат целиком вместе со всеми сообщениями?')) return;
      await supabaseClient.rpc('admin_delete_chat', { target_chat_id: chat.id });
      loadAdminChats();
      loadAdminStats();
    });
    row.addEventListener('click', () => loadAdminChatMessages(chat));
    list.appendChild(row);
  });
}

async function loadAdminChatMessages(chat) {
  const container = $('admin-chat-messages');
  container.innerHTML = `<div class="empty-list-hint">Загрузка сообщений...</div>`;

  const { data, error } = await supabaseClient
    .from('messages')
    .select('*')
    .eq('chat_id', chat.id)
    .order('created_at', { ascending: true })
    .limit(200);

  if (error) {
    container.innerHTML = `<div class="empty-list-hint">Ошибка: ${escapeHtml(error.message)}</div>`;
    return;
  }

  if (!data || data.length === 0) {
    container.innerHTML = `<div class="empty-list-hint">В этом чате пока нет сообщений</div>`;
    return;
  }

  container.innerHTML = "";
  for (const msg of data) {
    const senderProfile = await getProfile(msg.sender_id);
    const row = document.createElement('div');
    row.className = 'admin-msg-row';
    row.innerHTML = `
      <span class="admin-msg-del" data-id="${msg.id}">удалить</span>
      <b>${escapeHtml(senderProfile ? senderProfile.name : 'Пользователь')}:</b>
      ${escapeHtml(msg.text || '📷 изображение')}
      <div style="color:var(--dusk);font-size:11px;margin-top:2px;">${formatTime(msg.created_at)}</div>
    `;
    row.querySelector('.admin-msg-del').addEventListener('click', async () => {
      await supabaseClient.rpc('admin_delete_message', { target_message_id: msg.id });
      row.remove();
    });
    container.appendChild(row);
  }
}

// ===================================================================
// АДМИНКА: РАССЫЛКА ВСЕМ
// ===================================================================
$('admin-broadcast-btn').addEventListener('click', () => {
  $('broadcast-text-input').value = "";
  showError('broadcast-error', "");
  $('broadcast-modal').classList.remove('hidden');
});

$('broadcast-cancel-btn').addEventListener('click', () => {
  $('broadcast-modal').classList.add('hidden');
});

$('broadcast-send-btn').addEventListener('click', async () => {
  const text = $('broadcast-text-input').value.trim();
  if (!text) {
    showError('broadcast-error', "Введите текст объявления");
    return;
  }

  const { error } = await supabaseClient.rpc('broadcast_announcement', { message_text: text });

  if (error) {
    showError('broadcast-error', "Ошибка: " + error.message);
    return;
  }

  $('broadcast-modal').classList.add('hidden');
  alert('Объявление отправлено всем пользователям');
});

// ===================================================================
// АДМИНКА: ЛОГИ ДЕЙСТВИЙ
// ===================================================================
const ACTION_LABELS = {
  ban_user: '🚫 Блокировка пользователя',
  unban_user: '✅ Разблокировка пользователя',
  grant_admin: '🛡️ Выдача прав админа',
  revoke_admin: '⬇️ Снятие прав админа',
  delete_user: '🗑️ Удаление пользователя',
  delete_chat: '🗑️ Удаление чата',
  delete_message: '🗑️ Удаление сообщения',
  broadcast: '📣 Рассылка'
};

async function loadAdminLogs() {
  const list = $('admin-logs-list');
  list.innerHTML = `<div class="empty-list-hint">Загрузка...</div>`;

  const { data, error } = await supabaseClient
    .from('admin_logs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) {
    list.innerHTML = `<div class="empty-list-hint">Ошибка: ${escapeHtml(error.message)}</div>`;
    return;
  }

  if (!data || data.length === 0) {
    list.innerHTML = `<div class="empty-list-hint">Логов пока нет</div>`;
    return;
  }

  list.innerHTML = "";
  for (const log of data) {
    const adminProfile = await getProfile(log.admin_id);
    let targetLabel = "";
    if (log.target_user_id) {
      const targetProfile = await getProfile(log.target_user_id);
      targetLabel = ` → ${targetProfile ? targetProfile.name : 'пользователь'}`;
    }

    const row = document.createElement('div');
    row.className = 'log-row';
    row.innerHTML = `
      <span class="log-time">${new Date(log.created_at).toLocaleString('ru-RU')}</span>
      <span class="log-action">${ACTION_LABELS[log.action] || log.action}</span>${escapeHtml(targetLabel)}
      <div style="color:var(--dusk);margin-top:2px;">
        Админ: ${escapeHtml(adminProfile ? adminProfile.name : 'неизвестно')}
        ${log.details ? ' · ' + escapeHtml(log.details) : ''}
      </div>
    `;
    list.appendChild(row);
  }
}
