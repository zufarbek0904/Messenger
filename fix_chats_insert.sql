-- ===================================================================
-- ПАТЧ №2: исправление "new row violates row-level security policy
-- for table chats" при создании группы/чата
-- ===================================================================
-- Выполнить в Supabase: SQL Editor -> New query -> вставить целиком -> Run
--
-- Причина: Supabase делает INSERT ... RETURNING (через .select().single()
-- в коде). RETURNING проверяется политикой SELECT на chats. Но на момент
-- создания чата строк в chat_members ещё нет (участников добавляем
-- отдельным запросом сразу после) — поэтому is_chat_member() возвращает
-- false и Supabase блокирует возврат только что созданной строки.
--
-- Решение: разрешаем SELECT на chats также автору чата (created_by),
-- даже если он пока не вписан в chat_members.
-- ===================================================================

drop policy if exists "Users can view their own chats" on public.chats;

create policy "Users can view their own chats"
  on public.chats for select
  using (
    public.is_chat_member(id)
    or created_by = auth.uid()
  );

-- ===================================================================
-- Также: insert в chats должен сразу записывать created_by = auth.uid(),
-- а не доверять полю из запроса (на случай если кто-то его не передал
-- или подделал). Эта политика это обеспечивает.
-- ===================================================================

drop policy if exists "Authenticated users can create chats" on public.chats;

create policy "Authenticated users can create chats"
  on public.chats for insert
  with check ( created_by = auth.uid() );

-- ===================================================================
-- ГОТОВО. Обновите страницу сайта и попробуйте создать группу снова.
-- ===================================================================

-- ===================================================================
-- ДОПОЛНИТЕЛЬНО: более надёжная проверка авторизации для поиска людей.
-- auth.role() в некоторых конфигурациях ведёт себя нестабильно,
-- auth.uid() is not null — надёжный аналог "пользователь залогинен".
-- ===================================================================

drop policy if exists "Profiles are viewable by authenticated users" on public.profiles;

create policy "Profiles are viewable by authenticated users"
  on public.profiles for select
  using ( auth.uid() is not null );

drop policy if exists "Users can add members when creating a chat" on public.chat_members;

create policy "Users can add members when creating a chat"
  on public.chat_members for insert
  with check ( auth.uid() is not null );

drop policy if exists "Authenticated users can create chats" on public.chats;

create policy "Authenticated users can create chats"
  on public.chats for insert
  with check ( created_by = auth.uid() );

