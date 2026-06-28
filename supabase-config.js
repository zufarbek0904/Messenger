// ===================================================================
// КОНФИГУРАЦИЯ SUPABASE
// ===================================================================
// Сюда нужно вставить данные ВАШЕГО проекта Supabase.
// Как их получить — подробно описано в файле SETUP.md
//
// Supabase Dashboard -> Project Settings -> API
// ===================================================================

const SUPABASE_URL = "https://rfvderxvxlxnletsykkj.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_Qa2wZVqjVukhA74zT2cicg_vLOoyXdQ";

// Инициализация клиента (не трогайте, если не уверены)
// Важно: переменную называем НЕ "supabase" — само название "supabase" уже
// занято глобальным объектом библиотеки, подключённой через CDN в index.html
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
