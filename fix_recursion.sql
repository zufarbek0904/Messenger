-- ===================================================================
-- ПАТЧ: исправление "infinite recursion detected in policy for
-- relation chat_members"
-- ===================================================================
-- Выполнить в Supabase: SQL Editor -> New query -> вставить целиком -> Run
--
-- Причина ошибки: политика SELECT на chat_members проверяла доступ,
-- читая ту же самую таблицу chat_members внутри себя — Postgres
-- зацикливался. Решение: helper-функция security definer обходит
-- RLS внутри себя и не вызывает рекурсию.
-- ===================================================================

-- 1. Функция-помощник: возвращает true, если auth.uid() состоит в данном чате.
--    security definer = выполняется с правами создателя функции, минуя RLS,
--    поэтому не вызывает повторного срабатывания политики.
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

-- 2. Удаляем старую рекурсивную политику
drop policy if exists "Users can view members of their own chats" on public.chat_members;

-- 3. Создаём новую политику на основе функции — без рекурсии
create policy "Users can view members of their own chats"
  on public.chat_members for select
  using ( public.is_chat_member(chat_id) );

-- 4. (Опционально, но рекомендуется) Переписываем политики chats и messages
--    через ту же функцию — работает быстрее и единообразно.
drop policy if exists "Users can view their own chats" on public.chats;
create policy "Users can view their own chats"
  on public.chats for select
  using ( public.is_chat_member(id) );

drop policy if exists "Members can update chat metadata" on public.chats;
create policy "Members can update chat metadata"
  on public.chats for update
  using ( public.is_chat_member(id) );

drop policy if exists "Members can read messages of their chats" on public.messages;
create policy "Members can read messages of their chats"
  on public.messages for select
  using ( public.is_chat_member(chat_id) );

drop policy if exists "Members can send messages as themselves" on public.messages;
create policy "Members can send messages as themselves"
  on public.messages for insert
  with check ( sender_id = auth.uid() and public.is_chat_member(chat_id) );

-- ===================================================================
-- ГОТОВО. Обновите страницу сайта — ошибка должна исчезнуть.
-- ===================================================================
