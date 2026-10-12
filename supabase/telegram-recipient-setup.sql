-- Elina (student_id = elinavali), Telegram group topic from https://t.me/c/4295118907/5
-- This is idempotent and changes no recipients except elinavali.
-- Applied to the shared Supabase project on 2026-10-12.
INSERT INTO public.telegram_recipients
  (student_id, chat_id, message_thread_id, enabled)
VALUES
  ('elinavali', -1004295118907, 5, true)
ON CONFLICT (student_id)
DO UPDATE SET
  chat_id = EXCLUDED.chat_id,
  message_thread_id = EXCLUDED.message_thread_id,
  enabled = EXCLUDED.enabled,
  updated_at = now();

-- Check this row without exposing other students:
SELECT student_id, chat_id, message_thread_id, enabled
FROM public.telegram_recipients
WHERE student_id = 'elinavali';
