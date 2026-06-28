-- ===================================================================
-- SQL-СХЕМА ДЛЯ МЕССЕНДЖЕРА (Supabase / Postgres)
-- ===================================================================
-- Как использовать: Supabase Dashboard -> SQL Editor -> New query
-- -> вставить весь этот файл -> Run
-- ===================================================================

-- -------------------------------------------------------------------
-- 1. ТАБЛИЦА ПРОФИЛЕЙ
-- -------------------------------------------------------------------
-- Связана 1-к-1 с auth.users (встроенная таблица Supabase Auth)
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  avatar_url text,
  status text default 'offline',
  last_seen timestamptz default now(),
  created_at timestamptz default now()
);

-- Включаем Row Level Security
alter table public.profiles enable row level security;

-- Любой залогиненный пользователь может читать профили (нужно для поиска людей)
create policy "Profiles are viewable by authenticated users"
  on public.profiles for select
  using ( auth.uid() is not null );

-- Пользователь может редактировать только свой профиль
create policy "Users can update own profile"
  on public.profiles for update
  using (auth.uid() = id);

-- Пользователь может создать только свой профиль
create policy "Users can insert own profile"
  on public.profiles for insert
  with check (auth.uid() = id);

-- -------------------------------------------------------------------
-- 2. ФУНКЦИЯ + ТРИГГЕР: авто-создание профиля при регистрации
-- -------------------------------------------------------------------
-- Когда пользователь регистрируется через auth.users, автоматически
-- создаём для него запись в profiles (имя берём из metadata при signUp)
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, name, avatar_url, status)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    'https://ui-avatars.com/api/?name=' || coalesce(new.raw_user_meta_data->>'name', 'U') || '&background=3390ec&color=fff&size=128',
    'online'
  );
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- -------------------------------------------------------------------
-- 3. ТАБЛИЦА ЧАТОВ
-- -------------------------------------------------------------------
create table public.chats (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('private', 'group')),
  name text,                          -- только для групп
  avatar_url text,                    -- только для групп
  created_by uuid references auth.users(id),
  last_message text,
  last_message_time timestamptz default now(),
  created_at timestamptz default now()
);

alter table public.chats enable row level security;

-- -------------------------------------------------------------------
-- 4. ТАБЛИЦА УЧАСТНИКОВ ЧАТА (связь many-to-many между users и chats)
-- -------------------------------------------------------------------
create table public.chat_members (
  chat_id uuid references public.chats(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  joined_at timestamptz default now(),
  primary key (chat_id, user_id)
);

alter table public.chat_members enable row level security;

-- -------------------------------------------------------------------
-- Helper-функция: проверяет, состоит ли текущий пользователь в чате.
-- security definer обходит RLS внутри себя, поэтому не вызывает
-- рекурсию при использовании в политиках для chat_members.
-- -------------------------------------------------------------------
create or replace function public.is_chat_member(p_chat_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.chat_members
    where chat_id = p_chat_id and user_id = auth.uid()
  );
$$;

-- Политики для chat_members: пользователь видит строки чатов, в которых сам состоит
create policy "Users can view members of their own chats"
  on public.chat_members for select
  using ( public.is_chat_member(chat_id) );

create policy "Users can add members when creating a chat"
  on public.chat_members for insert
  with check ( auth.uid() is not null );

-- Политики для chats: видеть/обновлять можно только чаты, где состоишь,
-- либо чаты, которые ты сам создал (нужно для RETURNING сразу после INSERT,
-- пока chat_members ещё не заполнен)
create policy "Users can view their own chats"
  on public.chats for select
  using ( public.is_chat_member(id) or created_by = auth.uid() );

create policy "Authenticated users can create chats"
  on public.chats for insert
  with check ( created_by = auth.uid() );

create policy "Members can update chat metadata"
  on public.chats for update
  using ( public.is_chat_member(id) );

-- -------------------------------------------------------------------
-- 5. ТАБЛИЦА СООБЩЕНИЙ
-- -------------------------------------------------------------------
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid references public.chats(id) on delete cascade,
  sender_id uuid references auth.users(id),
  text text not null,
  created_at timestamptz default now()
);

alter table public.messages enable row level security;

-- Читать сообщения может только участник чата
create policy "Members can read messages of their chats"
  on public.messages for select
  using ( public.is_chat_member(chat_id) );

-- Писать сообщения может только участник чата, и только от своего имени
create policy "Members can send messages as themselves"
  on public.messages for insert
  with check ( sender_id = auth.uid() and public.is_chat_member(chat_id) );

-- -------------------------------------------------------------------
-- 6. ИНДЕКСЫ для производительности
-- -------------------------------------------------------------------
create index idx_messages_chat_id_created on public.messages(chat_id, created_at);
create index idx_chat_members_user on public.chat_members(user_id);
create index idx_chat_members_chat on public.chat_members(chat_id);
create index idx_profiles_name on public.profiles(name);

-- -------------------------------------------------------------------
-- 7. ВКЛЮЧАЕМ REALTIME для таблицы сообщений и чатов
-- -------------------------------------------------------------------
-- Это позволит подписываться на новые сообщения в реальном времени
alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.chats;

-- ===================================================================
-- ГОТОВО. После выполнения этого скрипта в Table Editor должны
-- появиться 4 таблицы: profiles, chats, chat_members, messages
-- ===================================================================
