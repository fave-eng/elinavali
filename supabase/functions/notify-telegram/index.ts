import { createClient } from 'npm:@supabase/supabase-js@2'

const FUNCTION_VERSION = 'homework-reports-v11.1-multi-student-db-topics'
const DIAGNOSTIC_VERSION = 'multi-student-diagnostics-v2'
const DIAGNOSTIC_COOLDOWN_MS = 30_000


const encoder = new TextEncoder()

type AdminClient = ReturnType<typeof createClient>

type Recipient = {
  chat_id: number | string
  message_thread_id: number | null
  enabled: boolean
  source?: 'database' | 'github_actions_secret'
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-notify-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(
    { ...body, functionVersion: FUNCTION_VERSION },
    { status, headers: corsHeaders },
  )
}

function text(value: unknown, fallback = ''): string {
  return value === undefined || value === null ? fallback : String(value)
}

function escapeHtml(value: unknown): string {
  return text(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? 'Unknown error')
  return message
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot[hidden]')
    .replace(/eyJ[A-Za-z0-9._-]+/g, '[hidden key]')
    .slice(0, 500)
}

function secureEqual(left: string, right: string): boolean {
  const a = encoder.encode(left)
  const b = encoder.encode(right)
  if (a.length !== b.length) return false

  let diff = 0
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i]
  }
  return diff === 0
}

function normalizeStudentId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized) ? normalized : null
}

function requestApiKey(request: Request): string {
  const apiKey = (request.headers.get('apikey') || '').trim()
  if (apiKey) return apiKey

  const authorization = (request.headers.get('authorization') || '').trim()
  const match = authorization.match(/^Bearer\s+(.+)$/i)
  return match ? match[1].trim() : ''
}

function parseKeyDictionary(raw: string | undefined | null): string[] {
  if (!raw) return []

  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
    return Object.values(parsed).filter((value): value is string => typeof value === 'string' && value.length > 0)
  } catch {
    return []
  }
}

async function publicClientAuthorized(request: Request): Promise<boolean> {
  const apiKey = requestApiKey(request)
  if (!apiKey) return false

  const allowedKeys = [
    Deno.env.get('SITE_PUBLIC_API_KEY') || '',
    Deno.env.get('SUPABASE_ANON_KEY') || '',
    Deno.env.get('SUPABASE_PUBLISHABLE_KEY') || '',
    ...parseKeyDictionary(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS')),
  ].map((key) => key.trim()).filter(Boolean)

  if (allowedKeys.some((key) => secureEqual(apiKey, key))) return true

  const supabaseUrl = (Deno.env.get('SUPABASE_URL') || '').replace(/\/+$/, '')
  if (!supabaseUrl) return false

  try {
    const response = await fetch(`${supabaseUrl}/auth/v1/settings`, {
      method: 'GET',
      headers: { apikey: apiKey },
      signal: AbortSignal.timeout(5_000),
    })
    await response.body?.cancel().catch(() => undefined)
    return response.ok
  } catch {
    return false
  }
}

function secretAuthorized(request: Request): boolean {
  const expected = (Deno.env.get('NOTIFY_WEBHOOK_SECRET') || '').trim()
  const actual = (request.headers.get('x-notify-secret') || '').trim()
  return Boolean(expected && actual && secureEqual(actual, expected))
}

async function telegramApi(token: string, method: string, body?: Record<string, unknown>) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })

  const result = await response.json().catch(() => null)
  if (!response.ok || !result?.ok) {
    return { ok: false, error: result?.description || `Telegram HTTP ${response.status}` }
  }

  return { ok: true, result: result.result }
}

async function getRecipient(admin: AdminClient, studentId: string): Promise<Recipient> {
  const { data, error } = await admin
    .from('telegram_recipients')
    .select('chat_id,message_thread_id,enabled')
    .eq('student_id', studentId)
    .maybeSingle()

  if (error) throw error

  if (data) {
    if (!data.enabled) throw new Error('Telegram recipient is explicitly disabled')
    return {
      chat_id: data.chat_id,
      message_thread_id: data.message_thread_id === null || data.message_thread_id === undefined ? null : Number(data.message_thread_id),
      enabled: Boolean(data.enabled),
      source: 'database',
    }
  }

  const fallbackChatId = (Deno.env.get('TEACHER_CHAT_ID') || '').trim()
  if (!/^-?\d+$/.test(fallbackChatId)) {
    throw new Error('Telegram recipient is not configured')
  }

  return {
    chat_id: Number(fallbackChatId),
    message_thread_id: null,
    enabled: true,
    source: 'github_actions_secret',
  }
}

async function sendTelegram(
  token: string,
  recipient: Recipient,
  messageText: string,
  keyboard: Array<Array<{ text: string; url: string }>> = [],
) {
  const payload: Record<string, unknown> = {
    chat_id: recipient.chat_id,
    text: messageText,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  }

  if (recipient.message_thread_id !== null && recipient.message_thread_id !== undefined) {
    payload.message_thread_id = recipient.message_thread_id
  }

  if (keyboard.length) {
    payload.reply_markup = { inline_keyboard: keyboard }
  }

  const response = await telegramApi(token, 'sendMessage', payload)
  if (!response.ok) throw new Error(response.error)
  return response.result
}

function homeworkStateSuspicious(row: Record<string, any>): boolean {
  const status = String(row?.status || '')
  const report = String(row?.report_status || '')

  if (status === 'draft') return report !== 'not_sent'
  if (status === 'submitted_pending_report') return !['pending', 'failed'].includes(report)
  if (status === 'submitted') return report !== 'sent'
  return true
}

function lessonTitle(lessonId: string): string {
  const match = lessonId.match(/^lesson-(\d+)$/)
  return match ? `Homework ${match[1]}` : lessonId
}

function buildHomeworkReportText(row: Record<string, any>, lessonUrl: string | null): string {
  const correct = Number(row?.score_correct || 0)
  const total = Number(row?.score_total || 0)
  const percent = Number.isFinite(Number(row?.score_percent))
    ? Number(row.score_percent)
    : (total > 0 ? Math.round((correct / total) * 100) : 0)

  const title = text(row?.lesson_title, lessonTitle(text(row?.lesson_id)))
  const submittedAt = row?.submitted_at
    ? new Date(row.submitted_at).toLocaleString('en-GB', { timeZone: 'Asia/Yekaterinburg' })
    : ''

  return [
    '📝 <b>Homework report</b>',
    '',
    `<b>${escapeHtml(title)}</b>`,
    total > 0 ? `Score: <b>${correct}/${total}</b> (${percent}%)` : null,
    submittedAt ? `Submitted: ${escapeHtml(submittedAt)}` : null,
    lessonUrl ? '' : null,
    lessonUrl ? `<a href="${escapeHtml(lessonUrl)}">Open homework</a>` : null,
    '',
    'Keep going — small steps still count. ✨',
  ].filter((line) => line !== null).join('\n')
}

const NEW_HOMEWORK_GREETINGS = [
  '👋 <b>Hi! Your next English homework is ready.</b>',
  '✨ <b>Hello! A new English practice is waiting for you.</b>',
  '📚 <b>Hi there! Your new homework is ready to go.</b>',
  '🌟 <b>Hey! It’s time for your next English practice.</b>',
  '🚀 <b>Hello! Your next step in English is ready.</b>',
  '👋 <b>Hi! I’ve got a new homework task for you.</b>',
  '📖 <b>Hello! Your new English task is ready.</b>',
  '💫 <b>Hi there! Another bit of English practice is ready.</b>',
]

const NEW_HOMEWORK_INTROS = [
  (title: string) => `This time, you’ll work with <b>${escapeHtml(title)}</b>.`,
  (title: string) => `Today’s topic is <b>${escapeHtml(title)}</b>.`,
  (title: string) => `Your new task focuses on <b>${escapeHtml(title)}</b>.`,
  (title: string) => `This homework is about <b>${escapeHtml(title)}</b>.`,
  (title: string) => `For this homework, you’ll practise <b>${escapeHtml(title)}</b>.`,
]

const NEW_HOMEWORK_ENCOURAGEMENTS = [
  'Take your time and focus on accuracy rather than speed.',
  'Don’t rush — careful practice will help the new language stick.',
  'Try to notice patterns while you work, not just the correct answers.',
  'If something feels difficult, mark it and we can look at it together.',
  'A little focused practice is enough — quality matters more than speed.',
  'Use the examples, trust what you know, and keep going.',
  'The goal is progress, not a perfect first attempt.',
  'Pay attention to the small details — they make your English more natural.',
  'Give yourself time to think before you answer.',
  'You’re building stronger English one task at a time.',
]

const NEW_HOMEWORK_SIGN_OFFS = [
  'Good luck — you’ve got this! 💪',
  'Enjoy the practice! ✨',
  'Do your best, and we’ll discuss any questions in class. 🌟',
  'Keep going — your English is getting stronger. 🚀',
  'Have a good study session! 📚',
  'See how much you can do before checking your notes. 🙂',
]

function stableHash(value: string): number {
  let hash = 2166136261
  for (const character of value) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function pickBySeed<T>(items: T[], seed: string, salt: string): T {
  return items[stableHash(`${seed}:${salt}`) % items.length]
}

function materialGuidance(hasVocabulary: boolean, grammarCount: number, seed: string): string {
  if (hasVocabulary && grammarCount > 0) {
    return pickBySeed([
      'Start with the vocabulary, review the grammar if you need it, and then move on to the homework.',
      'You can check the vocabulary first, refresh the grammar, and then complete the homework tasks.',
      'Begin with the new vocabulary, use the grammar section as support, and work through the homework in order.',
    ], seed, 'guidance-both')
  }

  if (hasVocabulary) {
    return pickBySeed([
      'Take a quick look at the vocabulary first, then move on to the homework.',
      'Start with the vocabulary so the homework feels easier afterwards.',
      'Review the new words first, then use them while you work through the homework.',
    ], seed, 'guidance-vocabulary')
  }

  if (grammarCount > 0) {
    return pickBySeed([
      'Review the grammar section first if you need a reminder, then complete the homework.',
      'You can use the grammar page as support before you start the homework tasks.',
      'Refresh the grammar first, then try to use the rule actively in the homework.',
    ], seed, 'guidance-grammar')
  }

  return pickBySeed([
    'Go through the tasks in order and take your time.',
    'Work through the tasks one by one and check the details carefully.',
    'Start when you have a quiet moment and complete the tasks at your own pace.',
  ], seed, 'guidance-homework')
}

function buildLessonBundleText(payload: Record<string, any>): string {
  const homework = payload.homework && typeof payload.homework === 'object' ? payload.homework : {}
  const vocabulary = payload.vocabulary && typeof payload.vocabulary === 'object' ? payload.vocabulary : null
  const grammar = Array.isArray(payload.grammar) ? payload.grammar : []

  const title = text((homework as any).title || payload.materialId || 'New homework')
  const subtitle = text((homework as any).subtitle || '')
  const materialId = text(payload.materialId || (homework as any).id || title)
  const version = Number(payload.notificationVersion || 1)
  const seed = `${materialId}:${Number.isFinite(version) ? version : 1}`

  const greeting = pickBySeed(NEW_HOMEWORK_GREETINGS, seed, 'greeting')
  const introBuilder = pickBySeed(NEW_HOMEWORK_INTROS, seed, 'intro')
  const encouragement = pickBySeed(NEW_HOMEWORK_ENCOURAGEMENTS, seed, 'encouragement')
  const signOff = pickBySeed(NEW_HOMEWORK_SIGN_OFFS, seed, 'sign-off')

  const lines: Array<string | null> = [
    greeting,
    '',
    introBuilder(title),
    subtitle ? `<i>${escapeHtml(subtitle)}</i>` : null,
  ]

  if (vocabulary) {
    lines.push('', `📚 Vocabulary: <b>${escapeHtml((vocabulary as any).title || 'Lesson vocabulary')}</b>`)
    if ((vocabulary as any).wordCount) lines.push(`Words: ${escapeHtml((vocabulary as any).wordCount)}`)
  }

  if (grammar.length) {
    lines.push('', '📐 Grammar:')
    for (const topic of grammar) {
      lines.push(`• ${escapeHtml(topic?.title || 'Grammar topic')}`)
    }
  }

  lines.push(
    '',
    materialGuidance(Boolean(vocabulary), grammar.length, seed),
    encouragement,
    '',
    signOff,
  )

  return lines.filter((line) => line !== null).join('\n')
}

function buildLessonBundleKeyboard(payload: Record<string, any>) {
  const keyboard: Array<Array<{ text: string; url: string }>> = []
  const homework = payload.homework && typeof payload.homework === 'object' ? payload.homework : {}
  const vocabulary = payload.vocabulary && typeof payload.vocabulary === 'object' ? payload.vocabulary : null
  const grammar = Array.isArray(payload.grammar) ? payload.grammar : []

  if (typeof (homework as any).url === 'string' && (homework as any).url) {
    keyboard.push([{ text: 'Open homework', url: (homework as any).url }])
  }

  if (typeof (vocabulary as any)?.url === 'string' && (vocabulary as any).url) {
    keyboard.push([{ text: 'Open vocabulary', url: (vocabulary as any).url }])
  }

  for (const topic of grammar.slice(0, 3)) {
    if (typeof topic?.url === 'string' && topic.url) {
      keyboard.push([{ text: `Grammar: ${text(topic.title, 'topic').slice(0, 45)}`, url: topic.url }])
    }
  }

  return keyboard
}

async function handleHomeworkReport(
  request: Request,
  payload: Record<string, any>,
  admin: AdminClient,
  botToken: string,
) {
  if (!await publicClientAuthorized(request)) {
    return json({ ok: false, error: 'Unauthorized homework report request' }, 401)
  }

  const studentId = normalizeStudentId(payload.studentId)
  if (!studentId) {
    return json({ ok: false, error: 'Invalid studentId' }, 403)
  }

  const lessonId = text(payload.lessonId).trim()
  if (!/^lesson-\d+$/.test(lessonId) && !lessonId.startsWith('telegram-report-test')) {
    return json({ ok: false, error: 'Invalid lessonId' }, 400)
  }

  const recipient = await getRecipient(admin, studentId)
  const { data: row, error: readError } = await admin
    .from('homework_progress')
    .select('*')
    .eq('student_id', studentId)
    .eq('lesson_id', lessonId)
    .maybeSingle()

  if (readError) return json({ ok: false, error: safeError(readError) }, 500)
  if (!row) return json({ ok: false, error: 'Homework progress row was not found' }, 404)

  const now = new Date().toISOString()
  await admin.from('homework_progress').update({
    status: 'submitted_pending_report',
    report_status: 'pending',
    report_sent_at: null,
    report_error: null,
    updated_at: now,
  }).eq('student_id', studentId).eq('lesson_id', lessonId)

  try {
    const messageText = buildHomeworkReportText(row, typeof payload.lessonUrl === 'string' ? payload.lessonUrl : null)
    const telegramMessage = await sendTelegram(botToken, recipient, messageText)

    const sentAt = new Date().toISOString()
    const { error: updateError } = await admin.from('homework_progress').update({
      status: 'submitted',
      report_status: 'sent',
      report_sent_at: sentAt,
      report_error: null,
      updated_at: sentAt,
    }).eq('student_id', studentId).eq('lesson_id', lessonId)

    if (updateError) throw updateError

    return json({
      ok: true,
      telegramMessageId: telegramMessage.message_id,
      threadId: recipient.message_thread_id,
    })
  } catch (error) {
    const message = safeError(error)
    await admin.from('homework_progress').update({
      status: 'submitted_pending_report',
      report_status: 'failed',
      report_sent_at: null,
      report_error: message,
      updated_at: new Date().toISOString(),
    }).eq('student_id', studentId).eq('lesson_id', lessonId)

    return json({ ok: false, error: message }, 502)
  }
}

async function handleLessonBundle(
  request: Request,
  payload: Record<string, any>,
  admin: AdminClient,
  botToken: string,
) {
  if (!secretAuthorized(request)) {
    return json({ ok: false, error: 'Unauthorized notification request' }, 401)
  }

  const studentId = normalizeStudentId(payload.studentId)
  if (!studentId) {
    return json({ ok: false, error: 'Invalid studentId' }, 403)
  }

  const materialType = text(payload.materialType || payload.eventType || 'lesson_bundle')
  const materialId = text(payload.materialId || payload.homework?.id).trim()
  const notificationVersion = Math.max(1, Number(payload.notificationVersion || 1) || 1)

  if (!materialId) return json({ ok: false, error: 'materialId is required' }, 400)

  const recipient = await getRecipient(admin, studentId)

  const { data: existing, error: existingError } = await admin
    .from('material_publications')
    .select('id,status,telegram_message_id')
    .eq('student_id', studentId)
    .eq('material_type', materialType)
    .eq('material_id', materialId)
    .eq('notification_version', notificationVersion)
    .in('status', ['pending', 'sent'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (existingError) return json({ ok: false, error: safeError(existingError) }, 500)

  if (existing?.status === 'sent') {
    return json({
      ok: true,
      skipped: true,
      reason: 'already_sent',
      telegramMessageId: existing.telegram_message_id || null,
    })
  }

  let publicationId = existing?.id || null

  if (!publicationId) {
    const { data: publication, error: insertError } = await admin
      .from('material_publications')
      .insert({
        student_id: studentId,
        material_type: materialType,
        material_id: materialId,
        notification_version: notificationVersion,
        status: 'pending',
        payload,
      })
      .select('id')
      .single()

    if (insertError) return json({ ok: false, error: safeError(insertError) }, 500)
    publicationId = publication.id
  }

  try {
    const telegramMessage = await sendTelegram(
      botToken,
      recipient,
      buildLessonBundleText(payload),
      buildLessonBundleKeyboard(payload),
    )

    await admin.from('material_publications').update({
      status: 'sent',
      telegram_message_id: telegramMessage.message_id,
      sent_at: new Date().toISOString(),
      error_message: null,
    }).eq('id', publicationId)

    return json({
      ok: true,
      skipped: false,
      telegramMessageId: telegramMessage.message_id,
      threadId: recipient.message_thread_id,
    })
  } catch (error) {
    const message = safeError(error)
    await admin.from('material_publications').update({
      status: 'failed',
      error_message: message,
    }).eq('id', publicationId)

    return json({ ok: false, error: message }, 502)
  }
}

async function handleDiagnostics(
  request: Request,
  payload: Record<string, any>,
  admin: AdminClient,
  botToken: string,
) {
  if (!await publicClientAuthorized(request)) {
    return json({ ok: false, error: 'Unauthorized diagnostics request', diagnosticVersion: DIAGNOSTIC_VERSION }, 401)
  }

  const studentId = normalizeStudentId(payload.studentId)
  if (!studentId) {
    return json({ ok: false, error: 'Invalid diagnostics student_id', diagnosticVersion: DIAGNOSTIC_VERSION }, 400)
  }

  const kind = text(payload.kind)
  const homeworkTable = 'homework_progress'

  if (kind === 'diagnostics_cleanup_probe') {
    const lessonId = text(payload.lessonId)
    if (!lessonId.startsWith('__diagnostic_probe__')) {
      return json({ ok: false, error: 'Invalid diagnostics lesson id', diagnosticVersion: DIAGNOSTIC_VERSION }, 400)
    }

    const { error } = await admin.from(homeworkTable).delete().eq('student_id', studentId).eq('lesson_id', lessonId)
    return error
      ? json({ ok: false, error: safeError(error), diagnosticVersion: DIAGNOSTIC_VERSION }, 500)
      : json({ ok: true, cleaned: true, diagnosticVersion: DIAGNOSTIC_VERSION })
  }

  if (kind === 'diagnostics_homework_probe') {
    const lessonId = text(payload.lessonId)
    if (!lessonId.startsWith('__diagnostic_probe__')) {
      return json({ ok: false, error: 'Invalid diagnostics lesson id', diagnosticVersion: DIAGNOSTIC_VERSION }, 400)
    }

    const stages: Record<string, unknown> = {}

    try {
      const { data: draft, error: readError } = await admin
        .from(homeworkTable)
        .select('student_id,lesson_id,status,report_status')
        .eq('student_id', studentId)
        .eq('lesson_id', lessonId)
        .maybeSingle()

      if (readError) throw new Error(`service_read_draft: ${readError.message}`)
      if (!draft) throw new Error('service_read_draft: browser draft was not found')
      if (draft.status !== 'draft' || draft.report_status !== 'not_sent') {
        throw new Error(`service_read_draft: unexpected state ${draft.status}/${draft.report_status}`)
      }

      stages.browserDraft = 'ok'

      const submittedAt = new Date().toISOString()
      const { error: pendingError } = await admin.from(homeworkTable).update({
        status: 'submitted_pending_report',
        submitted_at: submittedAt,
        locked_at: submittedAt,
        report_status: 'pending',
        report_sent_at: null,
        report_error: null,
        updated_at: submittedAt,
      }).eq('student_id', studentId).eq('lesson_id', lessonId)

      if (pendingError) throw new Error(`pending_transition: ${pendingError.message}`)
      stages.pendingTransition = 'ok'

      const sentAt = new Date().toISOString()
      const { error: submittedError } = await admin.from(homeworkTable).update({
        status: 'submitted',
        report_status: 'sent',
        report_sent_at: sentAt,
        report_error: null,
        updated_at: sentAt,
      }).eq('student_id', studentId).eq('lesson_id', lessonId)

      if (submittedError) throw new Error(`submitted_transition: ${submittedError.message}`)
      stages.submittedTransition = 'ok'

      const { error: cleanupError } = await admin.from(homeworkTable).delete().eq('student_id', studentId).eq('lesson_id', lessonId)
      if (cleanupError) throw new Error(`cleanup: ${cleanupError.message}`)
      stages.cleanup = 'ok'

      return json({ ok: true, diagnosticVersion: DIAGNOSTIC_VERSION, stages })
    } catch (error) {
      await admin.from(homeworkTable).delete().eq('student_id', studentId).eq('lesson_id', lessonId)
      return json({ ok: false, error: safeError(error), diagnosticVersion: DIAGNOSTIC_VERSION, stages }, 500)
    }
  }

  const recipientResult = await (async () => {
    try {
      return { recipient: await getRecipient(admin, studentId), error: '' }
    } catch (error) {
      return { recipient: null, error: safeError(error) }
    }
  })()

  if (kind === 'diagnostics_send_report') {
    const recipient = recipientResult.recipient
    if (!recipient) {
      return json({
        ok: false,
        error: recipientResult.error || 'Telegram recipient is not configured',
        diagnosticVersion: DIAGNOSTIC_VERSION,
      }, 500)
    }

    const cutoff = new Date(Date.now() - DIAGNOSTIC_COOLDOWN_MS).toISOString()
    const { data: recent } = await admin
      .from('material_publications')
      .select('created_at')
      .eq('student_id', studentId)
      .eq('material_type', 'diagnostic')
      .eq('material_id', 'telegram-test')
      .gte('created_at', cutoff)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (recent?.created_at) {
      const elapsed = Date.now() - Date.parse(recent.created_at)
      return json({
        ok: true,
        skipped: true,
        retryAfterSeconds: Math.max(1, Math.ceil((DIAGNOSTIC_COOLDOWN_MS - elapsed) / 1000)),
        threadId: recipient.message_thread_id,
        diagnosticVersion: DIAGNOSTIC_VERSION,
      })
    }

    const { data: publication, error: publicationError } = await admin.from('material_publications').insert({
      student_id: studentId,
      material_type: 'diagnostic',
      material_id: 'telegram-test',
      notification_version: Math.max(1, Math.floor(Date.now() / 1000)),
      status: 'pending',
      payload: { kind, pageUrl: typeof payload.pageUrl === 'string' ? payload.pageUrl : null },
    }).select('id').single()

    if (publicationError) {
      return json({ ok: false, error: safeError(publicationError), diagnosticVersion: DIAGNOSTIC_VERSION }, 500)
    }

    try {
      const message = await sendTelegram(
        botToken,
        recipient,
        [
          '🧪 <b>English Space diagnostics test</b>',
          '',
          `<code>student_id=${escapeHtml(studentId)}</code>: browser → Supabase → Edge Function → Telegram works.`,
          '',
          'This is a service test message. Homework and progress were not changed.',
        ].join('\n'),
      )

      await admin.from('material_publications').update({
        status: 'sent',
        telegram_message_id: message.message_id,
        sent_at: new Date().toISOString(),
        error_message: null,
      }).eq('id', publication.id)

      return json({
        ok: true,
        skipped: false,
        diagnosticVersion: DIAGNOSTIC_VERSION,
        telegramMessageId: message.message_id,
        threadId: recipient.message_thread_id,
      })
    } catch (error) {
      const message = safeError(error)
      await admin.from('material_publications').update({ status: 'failed', error_message: message }).eq('id', publication.id)
      return json({ ok: false, error: message, diagnosticVersion: DIAGNOSTIC_VERSION }, 502)
    }
  }

  if (kind !== 'diagnostics_health') {
    return json({ ok: false, error: 'Unknown diagnostics request', diagnosticVersion: DIAGNOSTIC_VERSION }, 400)
  }

  const { data: rowsRaw, error: homeworkError } = await admin
    .from(homeworkTable)
    .select('lesson_id,status,report_status,migrated_from_legacy,submitted_at')
    .eq('student_id', studentId)

  const rowsBeforeCleanup = rowsRaw || []
  const staleProbeIds = rowsBeforeCleanup
    .map((row: any) => text(row.lesson_id))
    .filter((lessonId: string) => lessonId.startsWith('__diagnostic_probe__'))

  for (const lessonId of staleProbeIds) {
    await admin.from(homeworkTable).delete().eq('student_id', studentId).eq('lesson_id', lessonId)
  }

  const rows = rowsBeforeCleanup.filter((row: any) => !text(row.lesson_id).startsWith('__diagnostic_probe__'))
  const suspiciousHomework = homeworkError ? [] : rows.filter((row: any) => homeworkStateSuspicious(row)).map((row: any) => row.lesson_id)
  const pendingHomework = homeworkError ? [] : rows
    .filter((row: any) => row.status === 'submitted_pending_report')
    .map((row: any) => ({ lessonId: row.lesson_id, reportStatus: row.report_status, submittedAt: row.submitted_at || null }))
  const legacyHomework = homeworkError ? [] : rows.filter((row: any) => Boolean(row.migrated_from_legacy)).map((row: any) => row.lesson_id)

  const recipient = recipientResult.recipient
  const botResult = await telegramApi(botToken, 'getMe')
  const chatResult = recipient
    ? await telegramApi(botToken, 'getChat', { chat_id: recipient.chat_id })
    : { ok: false, error: recipientResult.error || 'Recipient is not configured' }

  const { data: reportLogRows, error: reportLogError } = await admin
    .from('material_publications')
    .select('material_id,status,error_message,created_at')
    .eq('student_id', studentId)
    .order('created_at', { ascending: false })
    .limit(20)

  return json({
    ok: !homeworkError && Boolean(recipient) && botResult.ok && chatResult.ok,
    diagnosticVersion: DIAGNOSTIC_VERSION,
    database: {
      ok: !homeworkError,
      error: homeworkError ? safeError(homeworkError) : null,
      homeworkRows: rows.length,
      staleDiagnosticProbesRemoved: staleProbeIds.length,
      suspiciousHomework,
      pendingHomework,
      legacyHomework,
    },
    recipient: {
      ok: Boolean(recipient),
      enabled: Boolean(recipient?.enabled),
      source: recipient?.source || 'database',
      threadId: recipient?.message_thread_id ?? null,
      error: recipientResult.error || null,
    },
    telegram: {
      bot: botResult.ok ? { ok: true, username: botResult.result?.username || null } : { ok: false, error: botResult.error },
      chat: chatResult.ok ? { ok: true, type: chatResult.result?.type || null } : { ok: false, error: chatResult.error },
    },
    reportLog: {
      ok: !reportLogError,
      error: reportLogError ? safeError(reportLogError) : null,
      pendingOrFailed: reportLogError ? [] : (reportLogRows || [])
        .filter((row: any) => ['pending', 'failed'].includes(row.status))
        .map((row: any) => ({ lessonId: row.material_id, status: row.status, error: row.error_message || null })),
    },
  })
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405)

  try {
    const supabaseUrl = (Deno.env.get('SUPABASE_URL') || '').replace(/\/+$/, '')
    const serviceRoleKey = (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '').trim()
    const botToken = (Deno.env.get('TELEGRAM_BOT_TOKEN') || '').trim()

    if (!supabaseUrl) return json({ ok: false, error: 'Missing SUPABASE_URL' }, 500)
    if (!serviceRoleKey) return json({ ok: false, error: 'Missing SUPABASE_SERVICE_ROLE_KEY' }, 500)
    if (!botToken) return json({ ok: false, error: 'Missing TELEGRAM_BOT_TOKEN' }, 500)

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const payload = await request.json().catch(() => ({}))
    const kind = text(payload.kind)
    const eventType = text(payload.eventType)
    const materialType = text(payload.materialType)

    if (kind.startsWith('diagnostics_')) {
      return await handleDiagnostics(request, payload, admin, botToken)
    }

    if (eventType === 'homework_report') {
      return await handleHomeworkReport(request, payload, admin, botToken)
    }

    if (materialType === 'lesson_bundle' || eventType === 'lesson_bundle' || eventType === 'new_materials') {
      return await handleLessonBundle(request, payload, admin, botToken)
    }

    return json({
      ok: false,
      error: 'Unknown action',
      received: {
        kind: kind || null,
        eventType: eventType || null,
        materialType: materialType || null,
      },
    }, 400)
  } catch (error) {
    return json({ ok: false, error: safeError(error) }, 500)
  }
})
