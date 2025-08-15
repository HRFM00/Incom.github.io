// Supabaseクライアント生成関数
// - 認証/ユーザー用: createAuthSupabaseClient
// - インカム（Realtime/通話用）: createIntercomSupabaseClient
// user-auth-utils.js は createSupabaseClient を呼ぶため、後方互換で認証用を返す

function createAuthSupabaseClient() {
  const SUPABASE_URL = window.APP_AUTH_SUPABASE_URL || "https://ppmbtoptcxelwewwompk.supabase.co";
  const SUPABASE_ANON_KEY = window.APP_AUTH_SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBwbWJ0b3B0Y3hlbHdld3dvbXBrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTQwNjE0NjcsImV4cCI6MjA2OTYzNzQ2N30.Q01_d75sc3j362CMulQwkhtp0SuTzU86X2ElmXPU518";
  if (!window.supabase) {
    console.error('supabase-js が読み込まれていません');
    return null;
  }
  try {
    return window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  } catch (e) {
    console.error('Auth Supabaseクライアント生成に失敗しました', e);
    return null;
  }
}

function createIntercomSupabaseClient() {
  const SUPABASE_URL = window.APP_COMMS_SUPABASE_URL || "https://ciqgnreltueuuyhymckr.supabase.co";
  const SUPABASE_ANON_KEY = window.APP_COMMS_SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNpcWducmVsdHVldXV5aHltY2tyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTUwMTUwNDcsImV4cCI6MjA3MDU5MTA0N30.oEJjTSMi3vHtoILRWv8z3E-PSkI9GOnkEuRCOzyGxec";
  if (!window.supabase) {
    console.error('supabase-js が読み込まれていません');
    return null;
  }
  try {
    return window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
        storageKey: 'sb-intercom-realtime-only'
      }
    });
  } catch (e) {
    console.error('Intercom Supabaseクライアント生成に失敗しました', e);
    return null;
  }
}

// 後方互換（user-auth-utils.js 用）
function createSupabaseClient() {
  return createAuthSupabaseClient();
}


