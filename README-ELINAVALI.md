# English Space — Elina (Элина)

## Site settings
- Student ID: **`elinavali`** (distinct from `elina` and `viktoria`).
- Level: **B1**.
- Main textbook: **English File B1+**.
- New student space with an initially empty Homework, Vocabulary and Grammar catalog.
- Shared Supabase project URL and public anon key inherited from the site's template. This does **not** mean the new student’s access, RLS policies, or cloud writes have been verified.

## What is in the ZIP
- `index.html` — student home and progress overview.
- `homework.html`, `lesson.html` — homework list and exercises.
- `grammar.html`, `grammar-topic.html` — grammar topics and practice.
- `vocabulary-hub.html`, `vocabulary.html` — vocabulary topics and practice.
- `app.js`, `styles.css`, `config.js` — reusable site logic, design, new student configuration.
- `data/lessons/lesson-template.json` — structure for the first assignment.
- `data/vocabulary-data.js`, `data/grammar-data.js` — EMPTY catalogs ready for the student's own materials.
- `audio/`, `images/` — EMPTY asset folders; do not reuse Viktoria's exercise media by accident.
- `.github/workflows/` — optional GitHub actions; Telegram actions are guarded until configured.
- `supabase/functions/notify-telegram/` — original multi-student Edge Function source; deployment to a shared backend affects other students, so only deploy after verifying compatibility.
- `diagnostics.html` — technical diagnostics.

No Viktoria homework, grammar, vocabulary, or Telegram recipient information has been copied into the new student material files. Existing remote progress has **not** been migrated or deleted. No remote services were changed.

## Publish new homework
1. Copy `data/lessons/lesson-template.json` to `data/lessons/lesson-1.json`.
2. Replace all placeholder title/text and add the lesson blocks; change `status` to `available`, set a real `publishedAt`, and calculate `totalPoints` according to the exercise design. Do not publish empty demo blocks.
3. Optionally add the lesson vocabulary in `data/vocabulary-data.js`, link by `vocabularyId`; add its grammar topics in `data/grammar-data.js`, link by `grammarIds` / `linkedLessonId`.
4. Place audio files in `audio/` and pictures in `images/` without changing filenames referenced from homework JSON.
5. For later assignments use `lesson-2.json`, `lesson-3.json` and so on.
6. To notify about new lessons in Telegram, first complete Telegram setup described below.

## Deployment and cloud progress
- Create a **new** GitHub repository for `elinavali` and upload all site files, **including `.github/workflows`**. Do not reuse Viktoria's repository and do not copy her `.git` history.
- Enable GitHub Pages in the new repository (typically Settings → Pages → Deploy from branch). The HTML/JS files must be served over HTTP(S), not `file://`, because lessons are loaded via `fetch()`.
- Current configuration points to the existing shared Supabase project and uses `student_id='elinavali'` in progress records. **This namespacing alone is not access control.** Test read and write on the published site with `diagnostics.html`. Review RLS/auth for student data before giving public access.
- A successful local static-file test is not proof that remote Supabase works: the backend is not accessed by this ZIP build.

## Telegram: configured for Elina (2026-10-12)
- Telegram topic link: https://t.me/c/4295118907/5
- Only `student_id='elinavali'` was added to the existing shared `public.telegram_recipients` table:
  `chat_id=-1004295118907`, `message_thread_id=5`, `enabled=true`.
- The Supabase database reported a successful upsert. The records of `elina` (another student), `viktoria`, and all other students were not changed.
- `config.js`: `telegram.expectedTopicId=5` and `features.telegramNotifications=true`.
- The existing deployed `notify-telegram` function in the shared project was inspected and already supports `telegram_recipients` and `multi-student-diagnostics-v2`. **It was not redeployed or modified**.
- Real delivery to the topic **has not yet been tested**, so confirm that the bot can post to that topic before treating notifications as operational.
- On the published site, open `diagnostics.html`, click **Проверить всё**, then **Отправить тестовый отчёт в Telegram**. Confirm that Telegram accepted the message and that it appeared in the target topic. The test does not change Elina's real homework.
- The SQL for future re-application is at `supabase/telegram-recipient-setup.sql`. It has already been executed; **do not run it again unless changing/restoring the recipient**.
- `.github/workflows/1-setup-telegram.yml` has been made a **read-only verification** workflow. It no longer deploys the shared Edge Function or changes secrets. Use it only after pushing the site to a GitHub repository if you need an additional remote verification.
- Homework-submission reports are sent by the site itself via the shared Edge Function after cloud submission, conditional on that function and the bot being reachable.
- For manual **new-homework announcements**, `.github/workflows/2-notify-new-materials.yml` still requires GitHub Actions secret `NOTIFY_WEBHOOK_SECRET` in **this new repo** matching the existing Supabase Edge Function secret. Do not place the secret in `config.js`, a ZIP archive, or a commit. A lesson must be `status: available` and have `notification.enabled: true`.


## Important
Only static files were prepared and locally validated. Publication, account provisioning, Supabase access, and Telegram delivery were not performed.
