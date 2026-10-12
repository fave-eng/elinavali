(() => {
  'use strict';

  const config = window.APP_CONFIG || {};
  const student = config.student || {};
  let HOMEWORK_DATA = [];
  const RAW_VOCABULARY_DATA = Array.isArray(window.VOCABULARY_DATA) ? window.VOCABULARY_DATA : [];
  const GRAMMAR_DATA = Array.isArray(window.GRAMMAR_DATA) ? window.GRAMMAR_DATA : [];
  const lessonCache = new Map();
  const lessonsPath = 'data/lessons';
  const maxLessonNumber = 200;
  const maxConsecutiveMissingLessons = 3;

  const safeText = (value, fallback = '') => value === undefined || value === null ? fallback : String(value);
  const escapeHtml = (value) => safeText(value)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  const byId = (id) => document.getElementById(id);
  const queryParam = (name) => new URLSearchParams(window.location.search).get(name) || '';
  const unique = (items) => [...new Set(Array.isArray(items) ? items : [])];
  const safePercent = (value, total) => {
    const numerator = Number(value) || 0;
    const denominator = Number(total) || 0;
    if (denominator <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((numerator / denominator) * 100)));
  };
  const shuffled = (items) => {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  };
  const dateMs = (value) => {
    const time = Date.parse(value || '');
    return Number.isFinite(time) ? time : 0;
  };

  function normalizeLesson(rawLesson, requestedId = '') {
    if (!rawLesson || typeof rawLesson !== 'object') return null;
    const id = safeText(rawLesson.id || requestedId).trim();
    if (!/^lesson-\d+$/.test(id)) return null;
    const inferredNumber = Number(id.replace('lesson-', '')) || 0;
    return {
      ...rawLesson,
      id,
      // The homework number is always derived from the lesson-N.json file name.
      // This keeps homework numbering sequential when vocabulary or grammar materials are added.
      number: inferredNumber,
      title: safeText(rawLesson.title, `Lesson ${inferredNumber}`),
      subtitle: safeText(rawLesson.subtitle, 'Interactive homework assignment'),
      status: safeText(rawLesson.status, 'available'),
      page: `lesson.html?id=${encodeURIComponent(id)}`,
      blocks: Array.isArray(rawLesson.blocks) ? rawLesson.blocks : []
    };
  }

  async function fetchLessonFile(id) {
    const cleanId = safeText(id).trim();
    if (!/^lesson-\d+$/.test(cleanId)) return null;
    if (lessonCache.has(cleanId)) return lessonCache.get(cleanId);

    const promise = (async () => {
      const url = new URL(`${lessonsPath}/${cleanId}.json`, document.baseURI);
      const response = await fetch(url, { cache: 'no-store' });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`Could not load ${cleanId}.json: ${response.status}`);
      const lesson = normalizeLesson(await response.json(), cleanId);
      if (!lesson) throw new Error(`File ${cleanId}.json has an invalid structure.`);
      return lesson;
    })();

    lessonCache.set(cleanId, promise);
    try {
      return await promise;
    } catch (error) {
      lessonCache.delete(cleanId);
      throw error;
    }
  }

  async function discoverHomeworkData() {
    const lessons = [];
    let consecutiveMissing = 0;

    for (let number = 1; number <= maxLessonNumber; number += 1) {
      const lesson = await fetchLessonFile(`lesson-${number}`);
      if (lesson) {
        lessons.push(lesson);
        consecutiveMissing = 0;
      } else {
        consecutiveMissing += 1;
        if (consecutiveMissing >= maxConsecutiveMissingLessons) break;
      }
    }

    return lessons.sort((a, b) => Number(a.number || 0) - Number(b.number || 0));
  }

  async function loadHomeworkData() {
    const view = document.body?.dataset?.view || '';
    const requestedId = queryParam('id');

    if (view === 'lesson' && requestedId) {
      const lesson = await fetchLessonFile(requestedId);
      HOMEWORK_DATA = lesson ? [lesson] : [];
    } else {
      HOMEWORK_DATA = await discoverHomeworkData();
    }

    window.HOMEWORK_DATA = HOMEWORK_DATA;
    return HOMEWORK_DATA;
  }

  async function resolveLessonContent(lesson) {
    return lesson || null;
  }

  function normalizeWordKey(value) {
    return safeText(value)
      .normalize('NFKC')
      .toLocaleLowerCase('en')
      .replace(/[’‘`]/g, "'")
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/^[\s.,!?;:()[\]{}"“”]+|[\s.,!?;:()[\]{}"“”]+$/g, '');
  }

  function buildVocabularyCatalog(topics) {
    const seen = new Map();
    const byKey = new Map();
    const idToKey = new Map();
    const duplicates = [];
    const preparedTopics = topics.map((topic) => {
      const words = [];
      (Array.isArray(topic.words) ? topic.words : []).forEach((sourceWord) => {
        const wordKey = normalizeWordKey(sourceWord.uniqueKey || sourceWord.en);
        if (!wordKey) return;
        idToKey.set(safeText(sourceWord.id), wordKey);
        if (seen.has(wordKey)) {
          duplicates.push({ wordKey, skippedTopicId: topic.id, firstTopicId: seen.get(wordKey).topicId });
          return;
        }
        const word = { ...sourceWord, __wordKey: wordKey };
        const record = { word, topicId: topic.id };
        seen.set(wordKey, record);
        byKey.set(wordKey, record);
        words.push(word);
      });
      return { ...topic, words };
    });
    if (duplicates.length) {
      console.info('Duplicate words were excluded from the vocabulary:', duplicates);
    }
    return {
      topics: preparedTopics.filter((topic) => topic.words.length > 0),
      allTopics: preparedTopics,
      allWords: [...byKey.values()].map((item) => item.word),
      byKey,
      idToKey,
      duplicates
    };
  }

  const VOCABULARY_CATALOG = buildVocabularyCatalog(RAW_VOCABULARY_DATA);
  const VOCABULARY_DATA = VOCABULARY_CATALOG.topics;

  function showToast(message) {
    const toast = byId('app-toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => toast.classList.remove('show'), 3000);
  }

  const storage = {
    read(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch (error) {
        console.warn('Could not read local progress:', error);
        return fallback;
      }
    },
    write(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch (error) {
        console.warn('Could not save local progress:', error);
        return false;
      }
    }
  };

  const studentId = safeText(student.id, 'student').toLowerCase().trim().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'student';
  const key = (section) => `english_space_${studentId}_${section}`;
  const tables = {
    homework: config.supabase?.tables?.homework || 'homework_progress',
    vocabulary: config.supabase?.tables?.vocabulary || 'vocabulary_progress',
    vocabularyTopics: config.supabase?.tables?.vocabularyTopics || 'vocabulary_topic_progress',
    grammar: config.supabase?.tables?.grammar || 'grammar_progress'
  };

  const CloudService = {
    client: null,
    syncing: false,
    timers: {},
    isConfigured() {
      return Boolean(
        config.features?.cloudSync &&
        safeText(config.supabase?.url).trim() &&
        safeText(config.supabase?.anonKey).trim() &&
        window.supabase?.createClient
      );
    },
    async init() {
      if (!this.isConfigured()) return null;
      if (!this.client) {
        // Remove the stored session from the previous site version.
        // Otherwise Supabase may send requests as authenticated,
        // although the current setup expects the anon role.
        try {
          const projectRef = new URL(config.supabase.url).hostname.split('.')[0];
          window.localStorage.removeItem(`sb-${projectRef}-auth-token`);
        } catch (error) {
          console.warn('Could not clear the old Supabase session:', error);
        }

        const emptyAuthStorage = {
          getItem() { return null; },
          setItem() {},
          removeItem() {}
        };

        this.client = window.supabase.createClient(
          config.supabase.url,
          config.supabase.anonKey,
          {
            auth: {
              persistSession: false,
              autoRefreshToken: false,
              detectSessionInUrl: false,
              storage: emptyAuthStorage
            }
          }
        );
      }
      return this.client;
    },
    queue(section) {
      if (!this.isConfigured() || !this.client || this.syncing) return;
      window.clearTimeout(this.timers[section]);
      this.timers[section] = window.setTimeout(() => {
        window.ProgressService.syncToCloud(section).catch((error) => {
          console.error('Cloud save error:', error);
          showToast('Could not save progress to Supabase');
        });
      }, 450);
    }
  };


  const HomeworkReportService = {
    isConfigured() {
      return Boolean(
        config.features?.telegramNotifications &&
        CloudService.isConfigured()
      );
    },
    async send(lessonId) {
      if (!this.isConfigured()) {
        return { ok: false, skipped: true, reason: 'not_configured' };
      }

      const baseUrl = safeText(config.supabase?.url).replace(/\/+$/, '');
      const anonKey = safeText(config.supabase?.anonKey).trim();
      const endpoint = `${baseUrl}/functions/v1/notify-telegram`;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          apikey: anonKey,
          authorization: `Bearer ${anonKey}`
        },
        body: JSON.stringify({
          eventType: 'homework_report',
          studentId,
          lessonId,
          lessonUrl: window.location.href
        })
      });

      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.ok) {
        throw new Error(result?.error || `Homework report error: HTTP ${response.status}`);
      }
      return result;
    }
  };

  function normalizeVocabularyProgress(value) {
    const words = value?.words && typeof value.words === 'object' ? { ...value.words } : {};
    const topics = {};
    Object.entries(value?.topics && typeof value.topics === 'object' ? value.topics : {}).forEach(([topicId, topic]) => {
      topics[topicId] = { tests: Array.isArray(topic?.tests) ? topic.tests : [] };
      unique(topic?.known).forEach((legacyId) => {
        const wordKey = VOCABULARY_CATALOG.idToKey.get(safeText(legacyId));
        if (wordKey) words[wordKey] = { status: 'known', topicId, learnedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      });
      unique(topic?.difficult).forEach((legacyId) => {
        const wordKey = VOCABULARY_CATALOG.idToKey.get(safeText(legacyId));
        if (wordKey && words[wordKey]?.status !== 'known') words[wordKey] = { status: 'difficult', topicId, updatedAt: new Date().toISOString() };
      });
    });
    Object.entries(words).forEach(([wordKey, item]) => {
      if (!['known', 'difficult'].includes(item?.status)) delete words[wordKey];
    });
    return { words, topics };
  }

  window.ProgressService = {
    loadHomeworkProgress() {
      const value = storage.read(key('homework'), {});
      return {
        completedIds: unique(value.completedIds),
        results: value.results && typeof value.results === 'object' ? value.results : {},
        submissions: value.submissions && typeof value.submissions === 'object' ? value.submissions : {}
      };
    },
    saveHomeworkProgress(progress) {
      const ok = storage.write(key('homework'), progress || {});
      CloudService.queue('homework');
      return ok;
    },
    loadVocabularyProgress() {
      return normalizeVocabularyProgress(storage.read(key('vocabulary'), {}));
    },
    saveVocabularyProgress(progress) {
      const normalized = normalizeVocabularyProgress(progress || {});
      const ok = storage.write(key('vocabulary'), normalized);
      const difficult = Object.entries(normalized.words)
        .filter(([, item]) => item.status === 'difficult')
        .map(([wordKey]) => wordKey);
      storage.write(key('difficult_words'), difficult);
      CloudService.queue('vocabulary');
      return ok;
    },
    loadGrammarProgress() {
      const value = storage.read(key('grammar'), {});
      return { topics: value.topics && typeof value.topics === 'object' ? value.topics : {} };
    },
    saveGrammarProgress(progress) {
      const ok = storage.write(key('grammar'), progress || {});
      CloudService.queue('grammar');
      return ok;
    },
    async syncFromCloud() {
      if (!CloudService.isConfigured()) return false;
      if (!CloudService.client) await CloudService.init();
      CloudService.syncing = true;
      try {
        const client = CloudService.client;
        const [homeworkResponse, vocabularyResponse, vocabularyTopicsResponse, grammarResponse] = await Promise.all([
          client.from(tables.homework).select('*').eq('student_id', studentId),
          client.from(tables.vocabulary).select('*').eq('student_id', studentId),
          client.from(tables.vocabularyTopics).select('*').eq('student_id', studentId),
          client.from(tables.grammar).select('*').eq('student_id', studentId)
        ]);
        [homeworkResponse, vocabularyResponse, vocabularyTopicsResponse, grammarResponse].forEach((response) => {
          if (response.error) throw response.error;
        });

        const homework = this.loadHomeworkProgress();
        (homeworkResponse.data || []).forEach((row) => {
          const localResult = homework.results[row.lesson_id];
          if (!localResult || dateMs(row.updated_at) >= dateMs(localResult.checkedAt)) {
            homework.results[row.lesson_id] = {
              correct: Number(row.score_correct || 0),
              total: Number(row.score_total || 0),
              percent: Number(row.score_percent || 0),
              answers: row.answers && typeof row.answers === 'object' ? row.answers : {},
              checkedAt: row.checked_at || row.updated_at
            };
          }
          if (row.status === 'submitted') {
            homework.submissions[row.lesson_id] = { savedAt: row.submitted_at || row.updated_at, status: 'cloud' };
            // A homework assignment is counted as complete after it is submitted,
            // even if some answers are incorrect.
            homework.completedIds.push(row.lesson_id);
          } else if (Number(row.score_total) > 0 && Number(row.score_correct) === Number(row.score_total)) {
            homework.completedIds.push(row.lesson_id);
          }
        });
        homework.completedIds = unique(homework.completedIds);
        storage.write(key('homework'), homework);

        const vocabulary = this.loadVocabularyProgress();
        (vocabularyResponse.data || []).forEach((row) => {
          const local = vocabulary.words[row.word_key];
          if (!local || dateMs(row.updated_at) >= dateMs(local.updatedAt)) {
            vocabulary.words[row.word_key] = {
              status: row.status,
              topicId: row.source_topic_id || '',
              learnedAt: row.learned_at || null,
              updatedAt: row.updated_at
            };
          }
        });
        (vocabularyTopicsResponse.data || []).forEach((row) => {
          const localTests = vocabulary.topics[row.topic_id]?.tests || [];
          const cloudTests = Array.isArray(row.tests) ? row.tests : [];
          const merged = new Map();
          [...localTests, ...cloudTests].forEach((test) => merged.set(test.completedAt || JSON.stringify(test), test));
          vocabulary.topics[row.topic_id] = { tests: [...merged.values()] };
        });
        storage.write(key('vocabulary'), normalizeVocabularyProgress(vocabulary));

        const grammar = this.loadGrammarProgress();
        (grammarResponse.data || []).forEach((row) => {
          const local = grammar.topics[row.topic_id] || {};
          grammar.topics[row.topic_id] = {
            passed: Boolean(local.passed || row.passed),
            attempts: Math.max(Number(local.attempts || 0), Number(row.attempts || 0)),
            bestScore: Math.max(Number(local.bestScore || 0), Number(row.best_score || 0)),
            answers: local.answers && typeof local.answers === 'object' ? local.answers : {},
            updatedAt: dateMs(row.updated_at) >= dateMs(local.updatedAt) ? row.updated_at : local.updatedAt
          };
        });
        storage.write(key('grammar'), grammar);
        await this.syncToCloud();
        return true;
      } finally {
        CloudService.syncing = false;
      }
    },
    async syncToCloud(section = 'all') {
      if (!CloudService.isConfigured()) return false;
      if (!CloudService.client) await CloudService.init();
      const client = CloudService.client;
      const sections = section === 'all' ? ['homework', 'vocabulary', 'grammar'] : [section];

      if (sections.includes('homework')) {
        const progress = this.loadHomeworkProgress();
        const lessonIds = unique([...Object.keys(progress.results), ...Object.keys(progress.submissions)]);
        const rows = lessonIds.map((lessonId) => {
          const result = progress.results[lessonId] || {};
          const submission = progress.submissions[lessonId];
          const lesson = HOMEWORK_DATA.find((item) => item.id === lessonId) || {};
          const total = Number(result.total || 0);
          const correct = Number(result.correct || 0);
          return {
            student_id: studentId,
            student_name: safeText(student.nameEn || student.nameRu),
            lesson_id: lessonId,
            lesson_title: [safeText(lesson.title, lessonId), safeText(lesson.subtitle)].filter(Boolean).join(' — '),
            status: submission ? 'submitted' : 'draft',
            answers: result.answers && typeof result.answers === 'object' ? result.answers : {},
            score_correct: total > 0 ? correct : null,
            score_total: total > 0 ? total : null,
            score_percent: total > 0 ? safePercent(correct, total) : null,
            checked_at: result.checkedAt || null,
            submitted_at: submission?.savedAt || null,
            locked_at: submission?.savedAt || null
          };
        });
        if (rows.length) {
          const { error } = await client.from(tables.homework).upsert(rows, { onConflict: 'student_id,lesson_id' });
          if (error) throw error;
        }
      }

      if (sections.includes('vocabulary')) {
        const progress = this.loadVocabularyProgress();
        const wordRows = Object.entries(progress.words).filter(([wordKey]) => VOCABULARY_CATALOG.byKey.has(wordKey)).map(([wordKey, state]) => {
          const record = VOCABULARY_CATALOG.byKey.get(wordKey);
          return {
            student_id: studentId,
            word_key: wordKey,
            word_id: safeText(record?.word?.id, wordKey),
            en: safeText(record?.word?.en, wordKey),
            ru: safeText(record?.word?.ru),
            source_topic_id: state.topicId || record?.topicId || null,
            status: state.status,
            learned_at: state.status === 'known' ? (state.learnedAt || new Date().toISOString()) : null
          };
        });
        if (wordRows.length) {
          const { error } = await client.from(tables.vocabulary).upsert(wordRows, { onConflict: 'student_id,word_key' });
          if (error) throw error;
        }
        const topicRows = Object.entries(progress.topics)
          .filter(([, topic]) => Array.isArray(topic.tests) && topic.tests.length)
          .map(([topicId, topic]) => ({ student_id: studentId, topic_id: topicId, tests: topic.tests }));
        if (topicRows.length) {
          const { error } = await client.from(tables.vocabularyTopics).upsert(topicRows, { onConflict: 'student_id,topic_id' });
          if (error) throw error;
        }
      }

      if (sections.includes('grammar')) {
        const progress = this.loadGrammarProgress();
        const rows = Object.entries(progress.topics).map(([topicId, state]) => ({
          student_id: studentId,
          topic_id: topicId,
          passed: Boolean(state.passed),
          attempts: Number(state.attempts || 0),
          best_score: Number(state.bestScore || 0)
        }));
        if (rows.length) {
          const { error } = await client.from(tables.grammar).upsert(rows, { onConflict: 'student_id,topic_id' });
          if (error) throw error;
        }
      }
      return true;
    }
  };

  function fillConfig() {
    const values = {
      nameRu: student.nameRu,
      nameEn: student.nameEn,
      level: student.level,
      textbook: student.textbook,
      textbookEdition: student.textbookEdition
    };
    document.querySelectorAll('[data-config]').forEach((node) => {
      node.textContent = safeText(values[node.dataset.config]);
    });
    if (student.nameEn) document.title = `${document.title} · ${student.nameEn}`;
  }

  function markNavigation() {
    const page = document.body.dataset.page;
    document.querySelectorAll('[data-nav]').forEach((link) => {
      const active = link.dataset.nav === page;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'page');
    });
  }

  function progressMarkup(label, value, total, tone = '') {
    const percent = safePercent(value, total);
    return `<div class="progress-row">
      <div class="progress-row-head"><strong>${escapeHtml(label)}</strong><span>${Number(value) || 0} of ${Number(total) || 0}</span></div>
      <div class="progress-track" role="progressbar" aria-label="${escapeHtml(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}">
        <div class="progress-fill ${tone}" style="width:${percent}%"></div>
      </div>
    </div>`;
  }

  function totals() {
    const hwProgress = window.ProgressService.loadHomeworkProgress();
    const vocabProgress = window.ProgressService.loadVocabularyProgress();
    const grammarProgress = window.ProgressService.loadGrammarProgress();
    const publishedHomework = HOMEWORK_DATA.filter((item) => ['available', 'completed', 'locked'].includes(item.status));
    const completedHomework = publishedHomework.filter((item) => hwProgress.completedIds.includes(item.id) || item.status === 'completed').length;
    const knownWordKeys = Object.entries(vocabProgress.words).filter(([wordKey, item]) => VOCABULARY_CATALOG.byKey.has(wordKey) && item.status === 'known').map(([wordKey]) => wordKey);
    const passedGrammar = GRAMMAR_DATA.filter((topic) => grammarProgress.topics[topic.id]?.passed === true || topic.passed === true).length;
    return {
      homeworkTotal: publishedHomework.length,
      homeworkCompleted: completedHomework,
      vocabularyTotal: VOCABULARY_CATALOG.allWords.length,
      vocabularyKnown: knownWordKeys.length,
      vocabularyTopics: VOCABULARY_DATA.length,
      grammarTotal: GRAMMAR_DATA.filter((topic) => topic.status !== 'draft').length,
      grammarPassed: passedGrammar
    };
  }

  function emptyState(icon, title, text) {
    return `<div class="card empty-state"><div class="empty-state-icon">${icon}</div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(text)}</p></div>`;
  }

  function materialGroupMarkup(title, description, items, options = {}) {
    const list = Array.isArray(items) ? items.filter(Boolean) : [];
    const tone = options.tone === 'completed' ? 'completed' : 'new';
    const emptyText = safeText(options.emptyText).trim();
    const body = list.length
      ? `<div class="list material-group-list">${list.join('')}</div>`
      : `<div class="material-group-empty">${escapeHtml(emptyText || 'Nothing here yet.')}</div>`;
    return `<section class="material-group material-group-${tone}" aria-label="${escapeHtml(title)}">
      <div class="material-group-heading">
        <div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p></div>
        <span class="material-group-count">${list.length}</span>
      </div>
      ${body}
    </section>`;
  }

  function numericSuffix(value) {
    const match = safeText(value).match(/(\d+)(?!.*\d)/);
    return match ? Number(match[1]) || 0 : 0;
  }

  function renderHome() {
    const t = totals();
    if (byId('home-stat-completed')) byId('home-stat-completed').textContent = t.homeworkCompleted;
    if (byId('vocab-stat-known')) byId('vocab-stat-known').textContent = t.vocabularyKnown;
    if (byId('grammar-stat-passed')) byId('grammar-stat-passed').textContent = t.grammarPassed;
    const list = byId('home-progress-list');
    if (list) list.innerHTML = [
      progressMarkup('Homework', t.homeworkCompleted, t.homeworkTotal),
      progressMarkup('Vocabulary', t.vocabularyKnown, t.vocabularyTotal, 'rose'),
      progressMarkup('Grammar', t.grammarPassed, t.grammarTotal, 'green')
    ].join('');
    const current = byId('current-material');
    if (current) {
      const homeworkProgress = window.ProgressService.loadHomeworkProgress();
      const currentHomework = HOMEWORK_DATA
        .filter((item) => item.status === 'available' && !homeworkProgress.completedIds.includes(item.id))
        .sort((a, b) => dateMs(b.publishedAt) - dateMs(a.publishedAt) || Number(b.number || 0) - Number(a.number || 0))[0];

      if (currentHomework) {
        const href = currentHomework.page || `lesson.html?id=${encodeURIComponent(currentHomework.id)}`;
        current.innerHTML = `<a class="card interactive item-card current-material-card" href="${escapeHtml(href)}">
          <div class="item-icon">✨</div>
          <div class="item-main"><span class="homework-number">Homework #${Number(currentHomework.number || 0)}</span><h3>${escapeHtml(safeText(currentHomework.title, 'Current assignment'))}</h3><p>${escapeHtml(safeText(currentHomework.subtitle, 'Continue working with the published material.'))}</p></div>
          <span class="status-badge status-available">Continue</span>
        </a>`;
      } else {
        const publishedHomework = HOMEWORK_DATA.filter((item) => ['available', 'completed'].includes(item.status));
        const everythingCompleted = publishedHomework.length > 0 && publishedHomework.every((item) => item.status === 'completed' || homeworkProgress.completedIds.includes(item.id));
        current.innerHTML = everythingCompleted
          ? '<a class="card interactive item-card current-material-card" href="homework.html"><div class="item-icon">✅</div><div class="item-main"><h3>All published materials are complete</h3><p>New material will appear after the teacher publishes it.</p></div><span class="arrow" aria-hidden="true">→</span></a>'
          : '<div class="card disabled empty-state"><div class="empty-state-icon">✨</div><h3>No current material has been published yet</h3><p>The latest available homework assignment will appear here automatically.</p></div>';
      }
    }
  }


  function getLessonVocabularyTopic(lesson) {
    const vocabularyId = safeText(lesson?.vocabularyId).trim();
    return VOCABULARY_CATALOG.allTopics.find((topic) => topic.id === vocabularyId)
      || VOCABULARY_CATALOG.allTopics.find((topic) => topic.linkedLessonId === lesson?.id)
      || null;
  }

  function getLessonGrammarTopics(lesson) {
    const ids = Array.isArray(lesson?.grammarIds) ? lesson.grammarIds.map((id) => safeText(id).trim()).filter(Boolean) : [];
    const topics = ids.map((id) => GRAMMAR_DATA.find((topic) => topic.id === id)).filter(Boolean);
    GRAMMAR_DATA.filter((topic) => topic.linkedLessonId === lesson?.id).forEach((topic) => topics.push(topic));
    return [...new Map(topics.map((topic) => [topic.id, topic])).values()];
  }

  function compactGrammarTitle(topic) {
    const id = safeText(topic?.id).toLowerCase();
    if (id.includes('suffix')) return 'Suffixes';
    if (id.includes('pronoun')) return 'Pronouns';
    const title = safeText(topic?.title, 'Grammar').split(':')[0].trim();
    return title.length > 22 ? `${title.slice(0, 20).trim()}…` : title;
  }

  function lessonMaterialLinks(lesson, mode = 'hub') {
    const vocabulary = getLessonVocabularyTopic(lesson);
    const grammarTopics = getLessonGrammarTopics(lesson);
    if (!vocabulary && !grammarTopics.length) return '';

    const entries = [];
    const seen = new Set();

    if (vocabulary) {
      const href = vocabulary.page || `vocabulary.html?id=${encodeURIComponent(vocabulary.id)}`;
      const key = `vocab:${href}`;
      if (!seen.has(key)) {
        seen.add(key);
        entries.push({
          type: 'vocab',
          icon: '💥',
          label: 'Vocabulary',
          shortLabel: 'Vocab',
          title: safeText(vocabulary.title, 'Vocabulary'),
          href
        });
      }
    }

    grammarTopics.forEach((topic) => {
      if (topic.status === 'locked' || topic.status === 'draft') return;
      const href = topic.page || `grammar-topic.html?id=${encodeURIComponent(topic.id)}`;
      const key = `grammar:${href}`;
      if (seen.has(key)) return;
      seen.add(key);
      entries.push({
        type: 'grammar',
        icon: '📐',
        label: 'Grammar',
        shortLabel: compactGrammarTitle(topic),
        title: safeText(topic.title, 'Grammar'),
        href
      });
    });

    if (!entries.length) return '';

    if (mode === 'hub') {
      const links = entries.map((entry) => `<a class="lesson-material-chip ${escapeHtml(entry.type)}" href="${escapeHtml(entry.href)}" aria-label="Open: ${escapeHtml(entry.label)} — ${escapeHtml(entry.title)}" title="${escapeHtml(entry.title)}"><span class="lesson-material-chip-icon" aria-hidden="true">${escapeHtml(entry.icon)}</span><span class="lesson-material-chip-label">${escapeHtml(entry.shortLabel)}</span><span class="lesson-material-chip-arrow" aria-hidden="true">→</span></a>`).join('');
      return `<div class="lesson-materials lesson-materials-hub"><span class="lesson-materials-compact-label">Materials</span><div class="lesson-material-links">${links}</div></div>`;
    }

    const links = entries.map((entry) => `<a class="lesson-material-link ${escapeHtml(entry.type)}" href="${escapeHtml(entry.href)}"><span class="lesson-material-link-main"><span class="lesson-material-icon" aria-hidden="true">${escapeHtml(entry.icon)}</span><span class="lesson-material-text"><strong>${escapeHtml(entry.label)}</strong><small>${escapeHtml(entry.title)}</small></span></span><span class="lesson-material-arrow" aria-hidden="true">→</span></a>`).join('');
    return `<div class="lesson-materials lesson-materials-lesson"><div class="lesson-materials-heading"><span class="eyebrow">Open lesson materials</span><p>Vocabulary and grammar for this homework assignment.</p></div><div class="lesson-material-links">${links}</div></div>`;
  }

  function renderHomework() {
    const progress = window.ProgressService.loadHomeworkProgress();
    const published = HOMEWORK_DATA.filter((item) => item.status !== 'draft');
    const completed = published.filter((item) => progress.completedIds.includes(item.id) || item.status === 'completed').length;
    const percent = safePercent(completed, published.length);
    byId('hw-completed').textContent = completed;
    byId('hw-total').textContent = published.length;
    byId('hw-percent').textContent = `${percent}%`;
    byId('hw-overall-progress').innerHTML = progressMarkup('Overall progress', completed, published.length);
    const root = byId('homework-list');
    if (!published.length) {
      root.innerHTML = emptyState('📝', 'No homework assignments yet', 'The teacher will add an interactive assignment here after the first lesson.');
      return;
    }

    const homeworkCard = (item) => {
      const locked = item.status === 'locked';
      const complete = progress.completedIds.includes(item.id) || item.status === 'completed';
      const title = locked ? '🔒 Coming soon' : safeText(item.title, 'Assignment');
      const subtitle = locked ? 'The material will open after the teacher publishes it.' : safeText(item.subtitle, 'Interactive assignment');
      const status = complete ? 'completed' : safeText(item.status, 'available');
      const label = complete ? 'Completed' : status === 'available' ? 'Available' : status === 'locked' ? 'Locked' : 'Draft';
      if (locked) {
        return `<article class="card lesson-hub-card disabled"><div class="lesson-hub-main"><div class="item-icon">🔒</div><div class="item-main"><span class="homework-number">Homework #${Number(item.number || 0)}</span><h3>${escapeHtml(title)}</h3><p>${escapeHtml(subtitle)}</p></div><span class="status-badge status-locked">${escapeHtml(label)}</span></div></article>`;
      }
      const href = item.page || `lesson.html?id=${encodeURIComponent(item.id)}`;
      return `<article class="card lesson-hub-card">
        <a class="lesson-hub-main interactive" href="${escapeHtml(href)}">
          <div class="item-icon">${complete ? '✅' : '📝'}</div>
          <div class="item-main"><span class="homework-number">Homework #${Number(item.number || 0)}</span><h3>${escapeHtml(title)}</h3><p>${escapeHtml(subtitle)}</p></div>
          <span class="status-badge status-${escapeHtml(status)}">${escapeHtml(label)}</span>
        </a>
        ${lessonMaterialLinks(item, 'hub')}
      </article>`;
    };

    const newestFirst = [...published].sort((a, b) => {
      const aLocked = a.status === 'locked' ? 1 : 0;
      const bLocked = b.status === 'locked' ? 1 : 0;
      return aLocked - bLocked
        || dateMs(b.publishedAt) - dateMs(a.publishedAt)
        || Number(b.number || 0) - Number(a.number || 0);
    });
    const newHomework = newestFirst.filter((item) => !progress.completedIds.includes(item.id) && item.status !== 'completed');
    const finishedHomework = newestFirst.filter((item) => progress.completedIds.includes(item.id) || item.status === 'completed');

    root.innerHTML = [
      materialGroupMarkup('New', 'Start with the latest homework assignment.', newHomework.map(homeworkCard), {
        emptyText: 'No new homework assignments. Everything published has been completed.'
      }),
      materialGroupMarkup('Completed', 'Finished homework is kept below for review.', finishedHomework.map(homeworkCard), {
        tone: 'completed',
        emptyText: 'Completed homework will appear here.'
      })
    ].join('');
  }

  function renderGrammar() {
    const progress = window.ProgressService.loadGrammarProgress();
    const published = GRAMMAR_DATA.filter((topic) => topic.status !== 'draft');
    const passed = published.filter((topic) => progress.topics[topic.id]?.passed || topic.passed).length;
    byId('grammar-passed').textContent = passed;
    byId('grammar-total').textContent = published.length;
    byId('grammar-overall-progress').innerHTML = progressMarkup('Overall progress', passed, published.length, 'green');
    const root = byId('grammar-list');
    if (!published.length) {
      root.innerHTML = emptyState('📐', 'No grammar topics have been published yet', `Materials will be added in line with the lessons and the coursebook “${safeText(student.textbook)}”.`);
      return;
    }

    const grammarCard = (topic) => {
      const locked = topic.status === 'locked';
      const isPassed = progress.topics[topic.id]?.passed || topic.passed;
      const title = locked ? '🔒 Coming soon' : safeText(topic.title, 'Grammar topic');
      const tag = locked ? 'div' : 'a';
      const href = locked ? '' : ` href="${escapeHtml(topic.page || `grammar-topic.html?id=${encodeURIComponent(topic.id)}`)}"`;
      return `<${tag} class="card item-card ${locked ? 'disabled' : 'interactive'}"${href}>
        <div class="item-icon">${isPassed ? '✅' : locked ? '🔒' : '📐'}</div>
        <div class="item-main"><h3>${escapeHtml(title)}</h3><p>${locked ? 'The material has not been published yet.' : `${escapeHtml(topic.level || student.level)} · ${Number(progress.topics[topic.id]?.attempts || topic.attempts || 0)} attempts`}</p></div>
        <span class="status-badge status-${isPassed ? 'completed' : locked ? 'locked' : 'available'}">${isPassed ? 'Completed' : locked ? 'Locked' : 'Open'}</span>
      </${tag}>`;
    };

    const newestFirst = [...published].sort((a, b) => {
      const aLocked = a.status === 'locked' ? 1 : 0;
      const bLocked = b.status === 'locked' ? 1 : 0;
      return aLocked - bLocked
        || dateMs(b.publishedAt) - dateMs(a.publishedAt)
        || Number(b.order || numericSuffix(b.linkedLessonId || b.id)) - Number(a.order || numericSuffix(a.linkedLessonId || a.id));
    });
    const newTopics = newestFirst.filter((topic) => !(progress.topics[topic.id]?.passed || topic.passed));
    const completedTopics = newestFirst.filter((topic) => progress.topics[topic.id]?.passed || topic.passed);

    root.innerHTML = [
      materialGroupMarkup('New', 'Open grammar topics, newest first.', newTopics.map(grammarCard), {
        emptyText: 'No new grammar topics. All published topics are completed.'
      }),
      materialGroupMarkup('Completed', 'Completed grammar topics are kept below for review.', completedTopics.map(grammarCard), {
        tone: 'completed',
        emptyText: 'Completed grammar topics will appear here.'
      })
    ].join('');
  }

  function renderVocabularyHub() {
    const progress = window.ProgressService.loadVocabularyProgress();
    const totalWords = VOCABULARY_CATALOG.allWords.length;
    const knownCount = Object.entries(progress.words).filter(([wordKey, item]) => VOCABULARY_CATALOG.byKey.has(wordKey) && item.status === 'known').length;
    byId('vocab-known').textContent = knownCount;
    byId('vocab-total').textContent = totalWords;
    byId('vocab-topics').textContent = VOCABULARY_DATA.length;
    byId('vocab-percent').textContent = `${safePercent(knownCount, totalWords)}%`;
    byId('vocab-overall-progress').innerHTML = progressMarkup('Overall progress', knownCount, totalWords, 'rose');
    const root = byId('vocabulary-list');
    const filters = byId('vocab-filters');
    const sourceOrder = new Map(VOCABULARY_DATA.map((topic, index) => [topic.id, index]));

    const topicIsComplete = (topic) => {
      const topicKnown = topic.words.filter((word) => progress.words[word.__wordKey]?.status === 'known').length;
      return topic.words.length > 0 && topicKnown >= topic.words.length;
    };

    const vocabularyCard = (topic) => {
      const wordCount = topic.words.length;
      const topicKnown = topic.words.filter((word) => progress.words[word.__wordKey]?.status === 'known').length;
      const complete = wordCount > 0 && topicKnown >= wordCount;
      return `<a class="card item-card interactive" href="${escapeHtml(topic.page || `vocabulary.html?id=${encodeURIComponent(topic.id)}`)}">
        <div class="item-icon">${escapeHtml(topic.icon || '💬')}</div>
        <div class="item-main"><h3>${escapeHtml(topic.title || 'Vocabulary topic')}</h3><p>${escapeHtml(topic.label || '')} · ${topicKnown} of ${wordCount} words</p></div>
        <span class="status-badge status-${complete ? 'completed' : 'available'}">${complete ? 'Completed' : 'Open'}</span>
      </a>`;
    };

    const draw = (filter = 'all') => {
      const filtered = VOCABULARY_DATA.filter((topic) => {
        const complete = topicIsComplete(topic);
        if (filter === 'completed') return complete;
        if (filter === 'lesson') return topic.type === 'lesson';
        if (filter === 'extra') return topic.type === 'extra';
        return true;
      });
      if (!filtered.length) {
        root.innerHTML = emptyState('💥', 'No vocabulary practice topics yet', 'New topics will appear after lessons. Duplicate words are excluded automatically.');
        return;
      }

      const newestFirst = [...filtered].sort((a, b) => {
        return dateMs(b.publishedAt) - dateMs(a.publishedAt)
          || Number(b.order || numericSuffix(b.linkedLessonId || b.id)) - Number(a.order || numericSuffix(a.linkedLessonId || a.id))
          || Number(sourceOrder.get(b.id) || 0) - Number(sourceOrder.get(a.id) || 0);
      });
      const newTopics = newestFirst.filter((topic) => !topicIsComplete(topic));
      const completedTopics = newestFirst.filter(topicIsComplete);

      if (filter === 'completed') {
        root.innerHTML = materialGroupMarkup('Completed', 'Vocabulary topics where all words are learned.', completedTopics.map(vocabularyCard), {
          tone: 'completed',
          emptyText: 'Completed vocabulary topics will appear here.'
        });
        return;
      }

      root.innerHTML = [
        materialGroupMarkup('New', 'Vocabulary topics still in progress, newest first.', newTopics.map(vocabularyCard), {
          emptyText: 'No new vocabulary topics. All visible topics are completed.'
        }),
        materialGroupMarkup('Completed', 'Topics where all words are learned are kept below.', completedTopics.map(vocabularyCard), {
          tone: 'completed',
          emptyText: 'Completed vocabulary topics will appear here.'
        })
      ].join('');
    };
    if (filters) {
      filters.onclick = (event) => {
        const button = event.target.closest('[data-filter]');
        if (!button) return;
        filters.querySelectorAll('[data-filter]').forEach((item) => item.classList.toggle('active', item === button));
        draw(button.dataset.filter);
      };
    }
    draw();
  }

  function renderReadingSections(block) {
    const sections = Array.isArray(block.sections) ? block.sections : [];
    if (!sections.length) {
      const text = escapeHtml(block.text || '').replaceAll('\n', '<br>');
      return `<div class="reading-copy-wrap"><p class="reading-copy">${text}</p></div>`;
    }
    return `<div class="reading-sections">${sections.map((section) => `<section class="reading-section">
      <div class="reading-section-heading"><span class="reading-number">${escapeHtml(section.number || '')}</span><h4>${escapeHtml(section.heading || '')}</h4></div>
      <p class="reading-section-copy">${escapeHtml(section.text || '')}</p>
    </section>`).join('')}</div>`;
  }

  function renderExerciseContext(item) {
    const parts = Array.isArray(item.contextParts) ? item.contextParts : [];
    if (!parts.length) return '';
    const content = parts.map((part) => {
      if (typeof part === 'string') return escapeHtml(part);
      const className = part?.highlight ? ' class="exercise-source-highlight"' : '';
      return `<span${className}>${escapeHtml(part?.text || '')}</span>`;
    }).join('');
    return `<div class="exercise-source-line">${content}</div>`;
  }

  function renderRSelection(text, inputName, selectedIndexes = [], interactive = true) {
    let occurrence = 0;
    const selected = new Set((Array.isArray(selectedIndexes) ? selectedIndexes : []).map(Number));
    return [...safeText(text)].map((char) => {
      if (char.toLocaleLowerCase('en') !== 'r') return escapeHtml(char);
      const current = occurrence;
      occurrence += 1;
      if (!interactive) {
        return `<span class="r-letter${selected.has(current) ? ' is-pronounced' : ''}">${escapeHtml(char)}</span>`;
      }
      return `<label class="r-choice${selected.has(current) ? ' is-restored' : ''}"><input type="checkbox" name="${escapeHtml(inputName)}" value="${current}" data-r-index="${current}"${selected.has(current) ? ' checked' : ''}><span>${escapeHtml(char)}</span></label>`;
    }).join('');
  }

  function updatePronunciationPreview(itemNode, selectedIndexes = null) {
    if (!itemNode) return;
    const input = itemNode.querySelector('[data-pronunciation-input]');
    const preview = itemNode.querySelector('[data-pronunciation-preview]');
    if (!input || !preview) return;
    const selected = selectedIndexes === null
      ? [...preview.querySelectorAll('[data-r-index]:checked')].map((control) => Number(control.value))
      : (Array.isArray(selectedIndexes) ? selectedIndexes.map(Number) : []);
    const inputName = safeText(preview.dataset.rInputName, `pronunciation-r-${Date.now()}`);
    preview.innerHTML = renderRSelection(input.value, inputName, selected, true);
  }

  function crosswordLetters(value) {
    return [...safeText(value).normalize('NFKC')].filter((char) => /[a-z]/i.test(char));
  }

  function renderCrosswordRow(item, blockId, index) {
    const itemId = safeText(item.id, `${index + 1}`);
    const number = item.number === undefined ? index + 1 : item.number;
    const letters = crosswordLetters(item.answer);
    const hiddenIndex = Math.max(1, Number(item.hiddenLetterIndex) || 1);
    const hiddenColumn = 8;
    const startColumn = hiddenColumn - (hiddenIndex - 1);
    const separators = new Map((Array.isArray(item.separators) ? item.separators : []).map((entry) => [Number(entry.after), safeText(entry.text)]));
    const wordBreaks = new Set((Array.isArray(item.wordBreaks) ? item.wordBreaks : []).map(Number));
    const rowCells = letters.map((letter, letterIndex) => {
      const letterNumber = letterIndex + 1;
      const isHidden = letterNumber === hiddenIndex;
      const separator = separators.get(letterNumber) || '';
      const separatorClass = separator === '-' ? ' has-hyphen-after' : separator ? ' has-apostrophe-after' : '';
      const breakClass = wordBreaks.has(letterNumber) ? ' has-word-break-after' : '';
      const value = item.example ? letter.toUpperCase() : '';
      const disabled = item.example ? ' disabled' : '';
      const numberMarkup = letterIndex === 0 ? `<span class="crossword-cell-number">${escapeHtml(number)}</span>` : '';
      return `<span class="crossword-cell-wrap${isHidden ? ' is-hidden-letter' : ''}${separatorClass}${breakClass}" style="grid-column:${startColumn + letterIndex};grid-row:${index + 1}">${numberMarkup}<input class="crossword-cell" data-crossword-letter data-letter-index="${letterIndex}"${isHidden ? ' data-crossword-hidden' : ''} maxlength="1" inputmode="text" autocomplete="off" autocapitalize="characters" aria-label="${escapeHtml(`Clue ${number}, letter ${letterNumber}`)}" value="${escapeHtml(value)}"${disabled}></span>`;
    }).join('');
    return `<div class="crossword-row${item.example ? ' exercise-example' : ''}" data-exercise-item="${escapeHtml(itemId)}" data-input-type="crossword-word" data-crossword-row="${escapeHtml(itemId)}">${rowCells}</div>`;
  }

  function renderCrosswordExercise(block, blockId) {
    const items = Array.isArray(block.items) ? block.items : [];
    const crosswordItems = items.filter((item) => item.input === 'crossword-word');
    const followUpItems = items.filter((item) => item.input !== 'crossword-word');
    const rows = crosswordItems.map((item, itemIndex) => renderCrosswordRow(item, blockId, itemIndex)).join('');
    const clues = crosswordItems.map((item) => `<button class="crossword-clue${item.example ? ' is-example' : ''}" type="button" data-crossword-clue-for="${escapeHtml(safeText(item.id))}"><span class="crossword-clue-number">${escapeHtml(item.number)}</span><span>${escapeHtml(item.clue || '')}</span></button>`).join('');
    const followUp = followUpItems.length
      ? `<div class="crossword-follow-up exercise-items">${followUpItems.map((item, itemIndex) => renderExerciseItem(item, blockId, crosswordItems.length + itemIndex, true)).join('')}</div>`
      : '';
    return `<div class="crossword-workspace" data-crossword-workspace>
      <div class="crossword-grid-panel"><div class="crossword-grid" role="group" aria-label="Interactive crossword">${rows}</div><div class="crossword-hidden-answer"><span class="eyebrow">Hidden kind of shop</span><strong data-crossword-hidden-preview aria-live="polite"></strong></div></div>
      <div class="crossword-clues" aria-label="Crossword clues">${clues}</div>
    </div>${followUp}`;
  }



  function buildCrosswordGridMap(block) {
    const entries = Array.isArray(block.entries) ? block.entries : [];
    const cellMap = new Map();
    const entryMap = new Map();

    entries.forEach((entry, entryIndex) => {
      const entryId = safeText(entry.id, `${entryIndex + 1}`);
      const direction = safeText(entry.direction) === 'down' ? 'down' : 'across';
      const answerLetters = crosswordLetters(entry.answer);
      const pattern = safeText(entry.pattern || entry.answer);
      const patternChars = [...pattern];
      const prefill = new Set((Array.isArray(entry.prefill) ? entry.prefill : []).map(Number));
      const cells = [];
      let answerIndex = 0;

      patternChars.forEach((char, patternIndex) => {
        const row = Number(entry.row) + (direction === 'down' ? patternIndex : 0);
        const col = Number(entry.col) + (direction === 'across' ? patternIndex : 0);
        const key = `${row}-${col}`;

        if (/\s/.test(char)) {
          if (!cellMap.has(key)) {
            cellMap.set(key, { row, col, entries: [], number: null, separator: true, fixedValue: '' });
          } else {
            cellMap.get(key).separator = true;
          }
          return;
        }

        const answerLetter = safeText(answerLetters[answerIndex]).toUpperCase();
        if (!cellMap.has(key)) {
          cellMap.set(key, { row, col, entries: [], number: null, separator: false, fixedValue: '' });
        }
        const cell = cellMap.get(key);
        const isFixed = entry.example === true || prefill.has(answerIndex);
        cell.entries.push({
          id: entryId,
          number: Number(entry.number),
          direction,
          letterIndex: answerIndex,
          answerLetter,
          clue: safeText(entry.clue),
          example: entry.example === true
        });
        if (answerIndex === 0) cell.number = Number(entry.number);
        if (isFixed) cell.fixedValue = answerLetter;
        cells.push({ row, col, key, letterIndex: answerIndex });
        answerIndex += 1;
      });

      entryMap.set(entryId, { ...entry, id: entryId, direction, letters: answerLetters, cells });
    });

    return { cellMap, entryMap };
  }

  function renderCrosswordGridExercise(block, blockId) {
    const columns = Math.max(1, Number(block.gridColumns) || 18);
    const rows = Math.max(1, Number(block.gridRows) || 18);
    const { cellMap, entryMap } = buildCrosswordGridMap(block);
    const entryList = [...entryMap.values()];
    const defaultEntry = entryList.find((entry) => !entry.example) || entryList[0];
    const cellsMarkup = [];

    for (let row = 1; row <= rows; row += 1) {
      for (let col = 1; col <= columns; col += 1) {
        const key = `${row}-${col}`;
        const cell = cellMap.get(key);
        if (!cell) {
          cellsMarkup.push(`<span class="crossword-grid-empty" style="grid-column:${col};grid-row:${row}"></span>`);
          continue;
        }
        if (cell.separator) {
          cellsMarkup.push(`<span class="crossword-grid-separator" aria-hidden="true" style="grid-column:${col};grid-row:${row}"></span>`);
          continue;
        }

        const cluesForCell = cell.entries
          .map((entry) => `${entry.number} ${entry.direction === 'across' ? 'Across' : 'Down'}: ${entry.clue}`)
          .join(' • ');
        const entryIds = cell.entries.map((entry) => entry.id);
        const primaryEntryId = safeText(entryIds[0]);
        const numberMarkup = cell.number ? `<span class="crossword-cell-number">${escapeHtml(cell.number)}</span>` : '';
        const fixed = safeText(cell.fixedValue);
        const fixedAttr = fixed ? ' disabled' : '';
        const fixedClass = fixed ? ' is-given' : '';

        cellsMarkup.push(`<span class="crossword-grid-cell-wrap${fixedClass}" data-crossword-grid-cell-wrap data-cell-key="${key}" data-entry-ids="${escapeHtml(entryIds.join('|'))}" data-primary-entry="${escapeHtml(primaryEntryId)}" data-clue-preview="${escapeHtml(cluesForCell)}" style="grid-column:${col};grid-row:${row}">${numberMarkup}<input class="crossword-cell crossword-grid-cell" data-crossword-grid-input data-cell-key="${key}" maxlength="1" inputmode="text" autocomplete="off" autocapitalize="characters" aria-label="Crossword cell ${row}-${col}" value="${escapeHtml(fixed)}"${fixedAttr}></span>`);
      }
    }

    const clueMarkup = (direction) => {
      const list = entryList.filter((entry) => entry.direction === direction);
      return `<section class="crossword-clue-column"><h4>${direction === 'across' ? 'ACROSS →' : 'DOWN ↓'}</h4><div class="crossword-clue-list">${list.map((entry) => `<button class="crossword-clue-row${entry.example ? ' is-example' : ''}" type="button" data-crossword-grid-clue="${escapeHtml(entry.id)}"><span class="crossword-clue-number">${escapeHtml(entry.number)}</span><span>${escapeHtml(entry.clue || '')}</span></button>`).join('')}</div></section>`;
    };

    const defaultLabel = defaultEntry
      ? `${defaultEntry.number} ${defaultEntry.direction === 'across' ? 'Across' : 'Down'}: ${safeText(defaultEntry.clue)}`
      : '';

    return `<div class="crossword-grid-workspace" data-crossword-grid-workspace>
      <div class="crossword-grid-main">
        <div class="crossword-hover-panel" aria-live="polite"><span class="crossword-hover-label">Clue</span><div class="crossword-active-clue" data-crossword-active-clue>${escapeHtml(defaultLabel)}</div></div>
        <div class="crossword-grid crossword-grid-true" role="group" aria-label="Interactive crossword" style="--crossword-cols:${columns};--crossword-rows:${rows};">${cellsMarkup.join('')}</div>
      </div>
      <div class="crossword-grid-clues">${clueMarkup('down')}${clueMarkup('across')}</div>
    </div>`;
  }

  function collectCrosswordGridCells(node) {
    const actual = {};
    node.querySelectorAll('[data-crossword-grid-input]').forEach((input) => {
      actual[safeText(input.dataset.cellKey)] = safeText(input.value).trim().toUpperCase();
    });
    return actual;
  }

  function readCrosswordGridEntryValue(entry, savedCells) {
    return entry.cells.map((cell) => safeText(savedCells[cell.key]).trim().toUpperCase()).join('');
  }

  function checkCrosswordGridBlock(block, node) {
    const { cellMap, entryMap } = buildCrosswordGridMap(block);
    const actual = collectCrosswordGridCells(node);
    let correctCount = 0;
    let total = 0;
    const entryResults = new Map();

    entryMap.forEach((entry) => {
      const typed = readCrosswordGridEntryValue(entry, actual);
      const correct = normalizeAnswer(typed) === normalizeAnswer(entry.answer);
      entryResults.set(entry.id, correct);
      const clueNode = node.querySelector(`[data-crossword-grid-clue="${CSS.escape(entry.id)}"]`);
      if (clueNode) {
        clueNode.classList.remove('is-correct', 'is-wrong');
        if (!entry.example) clueNode.classList.add(correct ? 'is-correct' : 'is-wrong');
      }
      if (!entry.example) {
        total += 1;
        if (correct) correctCount += 1;
      }
    });

    cellMap.forEach((cell) => {
      if (cell.separator) return;
      const wrap = node.querySelector(`[data-crossword-grid-cell-wrap][data-cell-key="${CSS.escape(cell.row + '-' + cell.col)}"]`);
      if (!wrap) return;
      wrap.classList.remove('is-correct', 'is-wrong');
      if (cell.fixedValue) return;
      const related = cell.entries.filter((entry) => !entry.example);
      if (!related.length) return;
      const allCorrect = related.every((entry) => entryResults.get(entry.id));
      wrap.classList.add(allCorrect ? 'is-correct' : 'is-wrong');
    });

    return { actual, correctCount, total };
  }

  function restoreCrosswordGridAnswers(block, node, saved) {
    if (!saved || typeof saved !== 'object') return;
    Object.entries(saved).forEach(([key, value]) => {
      const input = node.querySelector(`[data-crossword-grid-input][data-cell-key="${CSS.escape(key)}"]`);
      if (input && !input.disabled) input.value = safeText(value).slice(0, 1).toUpperCase();
    });
  }

  function renderContinuousGapsExercise(block, blockId) {
    const paragraphs = Array.isArray(block.paragraphs) ? block.paragraphs : [];
    const content = paragraphs.map((paragraph) => {
      const parts = Array.isArray(paragraph) ? paragraph : [];
      return `<p class="continuous-gaps-paragraph">${parts.map((part) => {
        if (typeof part === 'string') return escapeHtml(part);
        if (!part || part.type !== 'gap') return '';
        const gapId = safeText(part.id);
        const verb = part.verb ? `<span class="continuous-verb-hint">(${escapeHtml(part.verb)})</span>` : '';
        if (part.example) {
          return `<span class="continuous-gap continuous-gap-example" data-continuous-gap-example="${escapeHtml(gapId)}"><sup>${escapeHtml(gapId)}</sup><span class="continuous-example-label">EXAMPLE</span><span class="continuous-example-input" aria-label="Example answer for gap ${escapeHtml(gapId)}">${escapeHtml(part.answer || '')}</span>${verb}</span>`;
        }
        const widthClass = safeText(part.width) === 'wide' ? ' is-wide' : safeText(part.width) === 'medium' ? ' is-medium' : '';
        if (part.input === 'select') {
          const options = Array.isArray(part.options) ? part.options : [];
          const select = `<select class="continuous-gap-input continuous-gap-select" data-continuous-gap="${escapeHtml(gapId)}" aria-label="Gap ${escapeHtml(gapId)}"><option value="">Choose</option>${options.map((option) => `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`).join('')}</select>`;
          return `<span class="continuous-gap${widthClass}" data-continuous-gap-wrap="${escapeHtml(gapId)}"><sup>${escapeHtml(gapId)}</sup>${select}${verb}</span>`;
        }
        const placeholder = part.placeholder ? ` placeholder="${escapeHtml(part.placeholder)}"` : '';
        return `<span class="continuous-gap${widthClass}" data-continuous-gap-wrap="${escapeHtml(gapId)}"><sup>${escapeHtml(gapId)}</sup><input class="continuous-gap-input" data-continuous-gap="${escapeHtml(gapId)}" autocomplete="off" aria-label="Gap ${escapeHtml(gapId)}"${placeholder}>${verb}</span>`;
      }).join('')}</p>`;
    }).join('');
    return `<div class="continuous-gaps" data-continuous-gaps>${content}</div>`;
  }

  function renderEdPronunciationExercise(block, blockId) {
    const verbs = Array.isArray(block.verbs) ? block.verbs : [];
    const columns = Array.isArray(block.columns) ? block.columns : [];
    const verbList = `<div class="ed-verb-list" aria-label="Regular verbs">${verbs.map((verb) => `<span>${escapeHtml(verb)}</span>`).join('')}</div>`;
    const table = `<div class="ed-pronunciation-table" data-ed-pronunciation>${columns.map((column) => {
      const key = safeText(column.key);
      const answers = Array.isArray(column.answers) ? column.answers : [];
      const example = column.example ? `<div class="ed-example-cell"><span class="continuous-example-label">EXAMPLE</span><strong>${escapeHtml(column.example)}</strong></div>` : '';
      const slots = answers.map((_, index) => `<div class="ed-answer-cell"><input class="text-field ed-answer-input" data-ed-column="${escapeHtml(key)}" data-ed-slot="${index}" autocomplete="off" aria-label="${escapeHtml(column.label || key)} answer ${index + 1}"></div>`).join('');
      return `<section class="ed-column" data-ed-column-wrap="${escapeHtml(key)}"><header><strong>${escapeHtml(column.label || key)}</strong>${column.cue ? `<span>${escapeHtml(column.cue)}</span>` : ''}</header>${example}${slots}</section>`;
    }).join('')}</div>`;
    return `${verbList}${table}`;
  }

  function renderPresentPastTable(block, blockId) {
    const rows = Array.isArray(block.rows) ? block.rows : [];
    return `<div class="present-past-table" data-present-past-table>
      <div class="present-past-head"><span></span><strong>Present</strong><strong>Past</strong></div>
      ${rows.map((row, index) => {
        const id = safeText(row.id, `${index + 1}`);
        const number = row.number === undefined ? id : row.number;
        if (row.example) {
          return `<div class="present-past-row is-example" data-present-past-row="${escapeHtml(id)}"><span class="present-past-number">${escapeHtml(number)}</span><span>${escapeHtml(row.present || '')}</span><span>${escapeHtml(row.past || '')}${row.past ? '<span class="continuous-example-label">EXAMPLE</span>' : ''}</span></div>`;
        }
        return `<div class="present-past-row" data-present-past-row="${escapeHtml(id)}"><span class="present-past-number">${escapeHtml(number)}</span><input class="text-field" data-present-past="present" autocomplete="off" aria-label="Sentence ${escapeHtml(number)} present verb"><input class="text-field" data-present-past="past" autocomplete="off" aria-label="Sentence ${escapeHtml(number)} past verb"></div>`;
      }).join('')}
    </div>`;
  }

  function checkContinuousGapsBlock(block, node) {
    const actual = {};
    let correctCount = 0;
    let total = 0;
    const gapDefs = (Array.isArray(block.paragraphs) ? block.paragraphs : []).flat().filter((part) => part && typeof part === 'object' && part.type === 'gap' && !part.example);
    gapDefs.forEach((gap) => {
      const id = safeText(gap.id);
      const input = node.querySelector(`[data-continuous-gap="${CSS.escape(id)}"]`);
      if (!input) return;
      const value = input.value;
      actual[id] = value;
      const accepted = Array.isArray(gap.acceptedAnswers) && gap.acceptedAnswers.length ? gap.acceptedAnswers : [gap.answer];
      const correct = accepted.some((answer) => normalizeAnswer(answer) !== '' && normalizeAnswer(answer) === normalizeAnswer(value));
      total += 1;
      if (correct) correctCount += 1;
      input.classList.toggle('is-correct', correct);
      input.classList.toggle('is-wrong', !correct);
    });
    return { actual, correctCount, total };
  }

  function checkEdPronunciationBlock(block, node) {
    const actual = {};
    let correctCount = 0;
    let total = 0;
    (Array.isArray(block.columns) ? block.columns : []).forEach((column) => {
      const key = safeText(column.key);
      const expected = new Set((Array.isArray(column.answers) ? column.answers : []).map((answer) => normalizeAnswer(answer)));
      const used = new Set();
      const inputs = [...node.querySelectorAll(`[data-ed-column="${CSS.escape(key)}"]`)];
      const values = inputs.map((input) => input.value);
      actual[key] = values;
      inputs.forEach((input) => {
        total += 1;
        const normalized = normalizeAnswer(input.value);
        const correct = normalized !== '' && expected.has(normalized) && !used.has(normalized);
        if (correct) {
          used.add(normalized);
          correctCount += 1;
        }
        input.classList.toggle('is-correct', correct);
        input.classList.toggle('is-wrong', !correct);
      });
    });
    return { actual, correctCount, total };
  }

  function checkPresentPastTableBlock(block, node) {
    const actual = {};
    let correctCount = 0;
    let total = 0;
    (Array.isArray(block.rows) ? block.rows : []).forEach((row, index) => {
      if (row.example) return;
      const id = safeText(row.id, `${index + 1}`);
      const rowNode = node.querySelector(`[data-present-past-row="${CSS.escape(id)}"]`);
      if (!rowNode) return;
      const present = rowNode.querySelector('[data-present-past="present"]')?.value || '';
      const past = rowNode.querySelector('[data-present-past="past"]')?.value || '';
      actual[id] = { present, past };
      const expectedColumn = safeText(row.column);
      const expectedVerb = normalizeAnswer(row.answer);
      const expectedValue = expectedColumn === 'present' ? present : past;
      const otherValue = expectedColumn === 'present' ? past : present;
      const correct = normalizeAnswer(expectedValue) === expectedVerb && normalizeAnswer(otherValue) === '';
      total += 1;
      if (correct) correctCount += 1;
      rowNode.classList.toggle('is-correct', correct);
      rowNode.classList.toggle('is-wrong', !correct);
    });
    return { actual, correctCount, total };
  }

  function restoreContinuousGapsAnswers(block, node, saved) {
    if (!saved || typeof saved !== 'object') return;
    Object.entries(saved).forEach(([id, value]) => {
      const input = node.querySelector(`[data-continuous-gap="${CSS.escape(id)}"]`);
      if (input) input.value = safeText(value);
    });
  }

  function restoreEdPronunciationAnswers(block, node, saved) {
    if (!saved || typeof saved !== 'object') return;
    Object.entries(saved).forEach(([key, values]) => {
      const list = Array.isArray(values) ? values : [];
      node.querySelectorAll(`[data-ed-column="${CSS.escape(key)}"]`).forEach((input, index) => { input.value = safeText(list[index]); });
    });
  }

  function restorePresentPastTableAnswers(block, node, saved) {
    if (!saved || typeof saved !== 'object') return;
    Object.entries(saved).forEach(([id, value]) => {
      const row = node.querySelector(`[data-present-past-row="${CSS.escape(id)}"]`);
      if (!row) return;
      const present = row.querySelector('[data-present-past="present"]');
      const past = row.querySelector('[data-present-past="past"]');
      if (present) present.value = safeText(value?.present);
      if (past) past.value = safeText(value?.past);
    });
  }

  function updateCrosswordHiddenAnswer(workspace) {
    if (!workspace) return;
    const preview = workspace.querySelector('[data-crossword-hidden-preview]');
    if (!preview) return;
    const letters = [...workspace.querySelectorAll('[data-crossword-hidden]')].map((input) => safeText(input.value).trim().toUpperCase() || '_');
    const chunks = [letters.slice(0, 6), letters.slice(6, 10), letters.slice(10, 15)].filter((chunk) => chunk.length);
    preview.textContent = chunks.map((chunk) => chunk.join('')).join(' ');
  }

  function wireLessonInteractiveInputs(root) {
    root.querySelectorAll('[data-image-spelling-grid]').forEach((grid) => {
      grid.querySelectorAll('[data-exercise-item][data-input-type="image-spelling"]').forEach((item) => {
        const inputs = [...item.querySelectorAll('[data-spelling-letter]')];
        inputs.forEach((input, index) => {
          input.addEventListener('input', () => {
            input.value = safeText(input.value).replace(/[^a-zA-Z]/g, '').slice(-1);
            if (input.value && inputs[index + 1]) inputs[index + 1].focus();
          });
          input.addEventListener('keydown', (event) => {
            if (event.key === 'Backspace' && !input.value && inputs[index - 1]) {
              event.preventDefault();
              inputs[index - 1].focus();
            }
          });
          input.addEventListener('paste', (event) => {
            const pasted = safeText(event.clipboardData?.getData('text')).replace(/[^a-zA-Z]/g, '');
            if (pasted.length <= 1) return;
            event.preventDefault();
            pasted.split('').forEach((letter, offset) => {
              const target = inputs[index + offset];
              if (target) target.value = letter;
            });
            const next = inputs[Math.min(index + pasted.length, inputs.length - 1)];
            if (next) next.focus();
          });
        });
      });
    });

    root.querySelectorAll('[data-pronunciation-input]').forEach((input) => {
      const itemNode = input.closest('[data-exercise-item]');
      updatePronunciationPreview(itemNode);
      input.addEventListener('input', () => updatePronunciationPreview(itemNode));
    });


    root.querySelectorAll('[data-crossword-grid-workspace]').forEach((workspace) => {
      const activeClue = workspace.querySelector('[data-crossword-active-clue]');
      let activeEntryId = '';

      const showClue = (text) => {
        if (activeClue) activeClue.textContent = safeText(text);
      };

      const getEntryIds = (input) => safeText(input.closest('[data-crossword-grid-cell-wrap]')?.dataset.entryIds)
        .split('|').map((value) => value.trim()).filter(Boolean);

      const getEntryCells = (entryId) => [...workspace.querySelectorAll(`[data-entry-ids~="${CSS.escape(entryId)}"]`)]
        .map((wrap) => wrap.querySelector('[data-crossword-grid-input]'))
        .filter(Boolean);

      const chooseEntryForInput = (input) => {
        const ids = getEntryIds(input);
        if (activeEntryId && ids.includes(activeEntryId)) return activeEntryId;
        return ids[0] || '';
      };

      const focusNextInEntry = (input, delta) => {
        const entryId = chooseEntryForInput(input);
        if (!entryId) return false;
        activeEntryId = entryId;
        const cells = getEntryCells(entryId);
        const index = cells.indexOf(input);
        let nextIndex = index + delta;
        while (nextIndex >= 0 && nextIndex < cells.length) {
          const target = cells[nextIndex];
          if (target && !target.disabled) {
            target.focus();
            return true;
          }
          nextIndex += delta;
        }
        return false;
      };

      workspace.querySelectorAll('[data-crossword-grid-input]').forEach((input) => {
        const wrap = input.closest('[data-crossword-grid-cell-wrap]');
        const cluePreview = safeText(wrap?.dataset.cluePreview);
        const entryIds = getEntryIds(input);

        const activate = () => {
          if (entryIds.length && !activeEntryId) activeEntryId = entryIds[0];
          if (cluePreview) showClue(cluePreview);
        };
        input.addEventListener('focus', activate);
        wrap?.addEventListener('mouseenter', activate);

        input.addEventListener('input', () => {
          const letters = crosswordLetters(input.value);
          input.value = safeText(letters[0]).toUpperCase();
          if (input.value) focusNextInEntry(input, 1);
        });

        input.addEventListener('keydown', (event) => {
          if (event.key === 'ArrowRight') { event.preventDefault(); focusNextInEntry(input, 1); }
          if (event.key === 'ArrowLeft') { event.preventDefault(); focusNextInEntry(input, -1); }
          if (event.key === 'Backspace' && !input.value) { event.preventDefault(); focusNextInEntry(input, -1); }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            const ids = getEntryIds(input);
            const desired = ids.find((id) => id.endsWith('-down'));
            if (desired) {
              activeEntryId = desired;
              event.preventDefault();
              focusNextInEntry(input, event.key === 'ArrowDown' ? 1 : -1);
            }
          }
        });
      });

      workspace.querySelectorAll('[data-crossword-grid-clue]').forEach((button) => {
        const entryId = safeText(button.dataset.crosswordGridClue);
        const text = button.textContent.replace(/\s+/g, ' ').trim();
        const activateClue = () => {
          activeEntryId = entryId;
          showClue(text);
        };
        button.addEventListener('mouseenter', activateClue);
        button.addEventListener('focus', activateClue);
        button.addEventListener('click', () => {
          activateClue();
          const cells = getEntryCells(entryId);
          const firstEditable = cells.find((input) => !input.disabled);
          if (firstEditable) firstEditable.focus();
        });
      });
    });

    root.querySelectorAll('[data-crossword-workspace]').forEach((workspace) => {
      const rows = [...workspace.querySelectorAll('[data-crossword-row]')];
      const rowInputs = (row) => [...row.querySelectorAll('[data-crossword-letter]:not(:disabled)')];
      const focusRelative = (row, input, delta) => {
        const inputs = rowInputs(row);
        const index = inputs.indexOf(input);
        const target = inputs[index + delta];
        if (target) target.focus();
      };

      rows.forEach((row) => {
        row.addEventListener('input', (event) => {
          const input = event.target.closest('[data-crossword-letter]');
          if (!input) return;
          const letters = crosswordLetters(input.value);
          input.value = safeText(letters[0]).toUpperCase();
          if (input.value) focusRelative(row, input, 1);
          updateCrosswordHiddenAnswer(workspace);
        });
        row.addEventListener('keydown', (event) => {
          const input = event.target.closest('[data-crossword-letter]');
          if (!input) return;
          if (event.key === 'ArrowRight') { event.preventDefault(); focusRelative(row, input, 1); }
          if (event.key === 'ArrowLeft') { event.preventDefault(); focusRelative(row, input, -1); }
          if (event.key === 'Backspace' && !input.value) { event.preventDefault(); focusRelative(row, input, -1); }
        });
        row.addEventListener('paste', (event) => {
          const input = event.target.closest('[data-crossword-letter]');
          if (!input) return;
          const pasted = crosswordLetters(event.clipboardData?.getData('text') || '');
          if (pasted.length <= 1) return;
          event.preventDefault();
          const inputs = rowInputs(row);
          const start = inputs.indexOf(input);
          pasted.forEach((letter, offset) => {
            const target = inputs[start + offset];
            if (target) target.value = letter.toUpperCase();
          });
          const finalTarget = inputs[Math.min(start + pasted.length, inputs.length - 1)];
          if (finalTarget) finalTarget.focus();
          updateCrosswordHiddenAnswer(workspace);
        });
      });

      workspace.querySelectorAll('[data-crossword-clue-for]').forEach((clue) => {
        clue.addEventListener('click', () => {
          const row = workspace.querySelector(`[data-crossword-row="${CSS.escape(safeText(clue.dataset.crosswordClueFor))}"]`);
          if (!row) return;
          const inputs = rowInputs(row);
          const target = inputs.find((input) => !input.value) || inputs[0];
          if (target) target.focus();
        });
      });
      updateCrosswordHiddenAnswer(workspace);
    });
  }

  function renderExerciseItem(item, blockId, index, inlineNumberedItems = false) {
    const itemId = safeText(item.id, `${index + 1}`);
    const number = item.number === undefined ? index + 1 : item.number;
    const prompt = escapeHtml(item.prompt || '');
    const inputId = `exercise-${blockId}-${itemId}`.replace(/[^a-zA-Z0-9_-]/g, '-');
    const exampleLabel = item.example && item.exampleLabel ? safeText(item.exampleLabel) : '';
    const baseNumberMarkup = number === '' || number === null ? '' : `<span class="exercise-number">${escapeHtml(number)}</span>`;
    const numberMarkup = exampleLabel
      ? `${item.showExampleNumber === true ? baseNumberMarkup : ''}<span class="exercise-example-label">${escapeHtml(exampleLabel)}</span>`
      : baseNumberMarkup;
    const context = renderExerciseContext(item);

    if (item.displayOnly) {
      const className = item.displayStyle === 'heading' ? 'exercise-display-heading' : 'exercise-display-copy';
      return `<div class="${className}" data-exercise-item="${escapeHtml(itemId)}">${prompt}</div>`;
    }

    if (item.input === 'r-circle') {
      const textValue = safeText(item.text || item.prompt);
      const content = `<div class="pronunciation-r-line">${renderRSelection(textValue, inputId, item.example ? item.answer : [], !item.example)}</div>`;
      return `<div class="exercise-item${item.example ? ' exercise-example' : ''}" data-exercise-item="${escapeHtml(itemId)}" data-input-type="r-circle">
        <div class="exercise-item-inline-row">${numberMarkup}<div class="exercise-item-inline-content">${content}</div></div>
        ${item.example ? '' : '<div class="feedback" aria-live="polite"></div>'}
      </div>`;
    }

    if (item.input === 'pronunciation-sentence') {
      if (item.example) {
        const sentence = safeText(item.exampleAnswer || item.answer);
        const content = `<div class="pronunciation-r-line">${renderRSelection(sentence, inputId, item.rAnswer || [], false)}</div>`;
        return `<div class="exercise-item exercise-example" data-exercise-item="${escapeHtml(itemId)}" data-input-type="pronunciation-sentence"><div class="exercise-item-inline-row">${numberMarkup}<div class="exercise-item-inline-content">${content}</div></div></div>`;
      }
      const rInputName = `${inputId}-r`;
      return `<div class="exercise-item" data-exercise-item="${escapeHtml(itemId)}" data-input-type="pronunciation-sentence">
        <div class="exercise-item-inline-row">${numberMarkup}<div class="exercise-item-inline-content pronunciation-sentence-control"><input class="text-field" data-pronunciation-input autocomplete="off" aria-label="Sentence ${escapeHtml(number)}"><div class="pronunciation-r-preview" data-pronunciation-preview data-r-input-name="${escapeHtml(rInputName)}" aria-label="Circle r where it is pronounced"></div></div></div>
        <div class="feedback" aria-live="polite"></div>
      </div>`;
    }

    if (item.example && item.input === 'circle-or-tick') {
      const selected = safeText(item.answer);
      const segments = Array.isArray(item.segments) ? item.segments : [];
      const options = Array.isArray(item.options) ? item.options : [];
      const sentence = `<div class="circle-or-tick-sentence"><span>${escapeHtml(segments[0] || '')}</span>${options.map((option, optionIndex) => `<span class="circle-choice ${selected === String(optionIndex) ? 'selected' : ''}">${escapeHtml(option)}</span>${optionIndex === 0 ? '<span class="choice-slash"> / </span>' : ''}`).join('')}<span>${escapeHtml(segments[1] || '')}</span>${selected === 'both' ? '<span class="circle-tick example-tick" aria-label="Both are correct">✓</span>' : ''}</div>`;
      if (inlineNumberedItems && !prompt) {
        return `<div class="exercise-item exercise-example" data-exercise-item="${escapeHtml(itemId)}">
          <div class="exercise-item-inline-row">${numberMarkup}<div class="exercise-item-inline-content">${sentence}</div></div>
        </div>`;
      }
      return `<div class="exercise-item exercise-example" data-exercise-item="${escapeHtml(itemId)}">
        <div class="exercise-item-header">${numberMarkup}<div class="exercise-prompt">${prompt}</div></div>
        <div class="exercise-control">${sentence}</div>
      </div>`;
    }

    if (item.example && item.exampleTarget) {
      if (inlineNumberedItems && !prompt) {
        return `<div class="exercise-item exercise-example" data-exercise-item="${escapeHtml(itemId)}">
          <div class="exercise-item-inline-row">${numberMarkup}<div class="exercise-item-inline-content">${context}<div class="exercise-example-target">${escapeHtml(item.exampleTarget)}</div></div></div>
        </div>`;
      }
      return `<div class="exercise-item exercise-example" data-exercise-item="${escapeHtml(itemId)}">
        <div class="exercise-item-header">${numberMarkup}<div class="exercise-prompt">${prompt}</div></div>
        <div class="exercise-control">${context}<div class="exercise-example-target">${escapeHtml(item.exampleTarget)}</div></div>
      </div>`;
    }

    if (item.example && item.input === 'odd-one-out') {
      const selectedIndex = Number(item.answer);
      const options = (item.options || []).map((option, optionIndex) => `<span class="odd-option ${optionIndex === selectedIndex ? 'selected' : ''}">${escapeHtml(option)}</span>`).join('');
      return `<div class="exercise-item exercise-example" data-exercise-item="${escapeHtml(itemId)}">
        <div class="exercise-item-header">${numberMarkup}<div class="exercise-prompt">${prompt}</div></div>
        <div class="exercise-control"><div class="odd-options">${options}</div><div class="odd-reason">The others are all <strong>${escapeHtml(item.reasonAnswer || '')}</strong>.</div></div>
      </div>`;
    }

    if (item.example && item.exampleMode === 'choice') {
      const rawPrompt = safeText(item.prompt);
      const answerText = safeText(item.exampleAnswer);
      const answerIndex = answerText ? rawPrompt.indexOf(answerText) : -1;
      const completedPrompt = answerIndex >= 0
        ? `${escapeHtml(rawPrompt.slice(0, answerIndex))}<span class="example-choice-selected">${escapeHtml(answerText)}</span>${escapeHtml(rawPrompt.slice(answerIndex + answerText.length))}`
        : escapeHtml(rawPrompt);
      return `<div class="exercise-item exercise-example" data-exercise-item="${escapeHtml(itemId)}">
        <div class="exercise-item-header">${numberMarkup}<div class="exercise-prompt exercise-example-prompt">${completedPrompt}</div></div>
      </div>`;
    }

    if (item.example && item.exampleMode === 'select') {
      const segments = Array.isArray(item.segments) ? item.segments : [];
      const options = Array.isArray(item.options) ? item.options : [];
      const answerIndex = Number(item.answer);
      const selected = Number.isInteger(answerIndex) && answerIndex >= 0 && answerIndex < options.length ? options[answerIndex] : '';
      const sentence = `<div class="sentence-gaps example-sentence-gaps"><span>${escapeHtml(segments[0] || '')}</span><span class="sentence-select-gap example-select-gap"><select disabled aria-label="Example selection"><option selected>${escapeHtml(selected)}</option></select></span><span>${escapeHtml(segments[1] || '')}</span></div>`;
      if (inlineNumberedItems && numberMarkup) {
        return `<div class="exercise-item exercise-example" data-exercise-item="${escapeHtml(itemId)}">
          <div class="exercise-item-inline-row${exampleLabel ? ' is-example-labeled' : ''}">${numberMarkup}<div class="exercise-item-inline-content">${sentence}</div></div>
        </div>`;
      }
      return `<div class="exercise-item exercise-example" data-exercise-item="${escapeHtml(itemId)}">
        <div class="exercise-item-header">${numberMarkup}<div class="exercise-prompt exercise-example-prompt">${sentence}</div></div>
      </div>`;
    }

    if (item.example && item.exampleMode === 'text') {
      const value = safeText(item.exampleAnswer || item.answer || item.prompt);
      const field = `<input class="text-field example-text-field" value="${escapeHtml(value)}" disabled aria-label="Example answer">`;
      if (inlineNumberedItems) {
        return `<div class="exercise-item exercise-example" data-exercise-item="${escapeHtml(itemId)}">
          <div class="exercise-item-inline-row${exampleLabel ? ' is-example-labeled' : ''}">${numberMarkup}<div class="exercise-item-inline-content">${field}</div></div>
        </div>`;
      }
      return `<div class="exercise-item exercise-example" data-exercise-item="${escapeHtml(itemId)}"><div class="exercise-item-header">${numberMarkup}<div class="exercise-prompt exercise-example-prompt">${field}</div></div></div>`;
    }

    if (item.example && item.exampleMode === 'gaps') {
      const segments = Array.isArray(item.segments) ? item.segments : [];
      const exampleAnswers = Array.isArray(item.exampleAnswers) ? item.exampleAnswers : [];
      const sentence = `<div class="sentence-gaps example-sentence-gaps">${exampleAnswers.map((answer, gapIndex) => `${gapIndex < segments.length ? `<span>${escapeHtml(segments[gapIndex])}</span>` : ''}<span class="example-gap-answer">${escapeHtml(answer)}</span>`).join('')}${segments.length > exampleAnswers.length ? `<span>${escapeHtml(segments[segments.length - 1])}</span>` : ''}</div>`;
      if (inlineNumberedItems && numberMarkup) {
        return `<div class="exercise-item exercise-example" data-exercise-item="${escapeHtml(itemId)}">
          <div class="exercise-item-inline-row${exampleLabel ? ' is-example-labeled' : ''}">${numberMarkup}<div class="exercise-item-inline-content">${sentence}</div></div>
        </div>`;
      }
      return `<div class="exercise-item exercise-example" data-exercise-item="${escapeHtml(itemId)}">
        <div class="exercise-item-header">${numberMarkup}<div class="exercise-prompt exercise-example-prompt">${sentence}</div></div>
      </div>`;
    }

    if (item.example) {
      if (inlineNumberedItems && numberMarkup && item.exampleTextOnly) {
        return `<div class="exercise-item exercise-example" data-exercise-item="${escapeHtml(itemId)}">
          <div class="exercise-item-inline-row${exampleLabel ? ' is-example-labeled' : ''}">${numberMarkup}<div class="exercise-item-inline-content exercise-example-copy">${prompt}</div></div>
        </div>`;
      }
      if (exampleLabel && !item.exampleTextOnly) {
        const exampleContent = `<div class="exercise-example-copy"><strong>${escapeHtml(item.exampleAnswer || '')}</strong></div>`;
        if (inlineNumberedItems && numberMarkup) {
          return `<div class="exercise-item exercise-example" data-exercise-item="${escapeHtml(itemId)}">
            <div class="exercise-item-inline-row is-example-labeled">${numberMarkup}<div class="exercise-item-inline-content">${exampleContent}</div></div>
          </div>`;
        }
        return `<div class="exercise-item exercise-example" data-exercise-item="${escapeHtml(itemId)}">
          <div class="exercise-item-header">${numberMarkup}${exampleContent}</div>
        </div>`;
      }
      return `<div class="exercise-item exercise-example" data-exercise-item="${escapeHtml(itemId)}">
        <div class="exercise-item-header">${numberMarkup}<div class="exercise-prompt">${prompt}</div></div>
        ${item.exampleTextOnly ? '' : `<div class="example-answer"><span>Example</span><strong>${escapeHtml(item.exampleAnswer || '')}</strong></div>`}
      </div>`;
    }

    let control = '';
    if (item.input === 'example-gap') {
      const segments = Array.isArray(item.segments) ? item.segments : [];
      control = `<div class="sentence-gaps numbered-example-gap"><span>${escapeHtml(segments[0] || '')}</span><span class="inline-example-answer"><b>${escapeHtml(item.exampleNumber || 1)}</b> ${escapeHtml(item.exampleAnswer || '')}</span><span>${escapeHtml(segments[1] || '')}</span><span class="inline-gap-number">${escapeHtml(item.gapNumber || 2)}</span><input class="gap-input" data-example-gap autocomplete="off"><span>${escapeHtml(segments[2] || '')}</span></div>`;
    } else if (item.input === 'odd-one-out') {
      control = `<div class="odd-one-out-control"><div class="odd-options">${(item.options || []).map((option, optionIndex) => `<label class="odd-option"><input type="radio" name="${escapeHtml(inputId)}" value="${optionIndex}"><span>${escapeHtml(option)}</span></label>`).join('')}</div><label class="odd-reason" for="${escapeHtml(inputId)}-reason">The others are all <input class="gap-input odd-reason-input" id="${escapeHtml(inputId)}-reason" data-odd-reason autocomplete="off">.</label></div>`;
    } else if (item.input === 'circle-or-tick') {
      const segments = Array.isArray(item.segments) ? item.segments : [];
      const options = Array.isArray(item.options) ? item.options : [];
      control = `<div class="circle-or-tick-sentence"><span>${escapeHtml(segments[0] || '')}</span>${options.map((option, optionIndex) => `<label class="circle-choice"><input type="radio" name="${escapeHtml(inputId)}" value="${optionIndex}"><span>${escapeHtml(option)}</span></label>${optionIndex === 0 ? '<span class="choice-slash"> / </span>' : ''}`).join('')}<span>${escapeHtml(segments[1] || '')}</span><label class="circle-tick" title="Both are correct"><input type="radio" name="${escapeHtml(inputId)}" value="both"><span aria-hidden="true">✓</span><span class="sr-only">Both are correct</span></label></div>`;
    } else if (item.input === 'single' && Array.isArray(item.segments) && item.segments.length >= 2) {
      const options = Array.isArray(item.options) ? item.options : [];
      control = `<div class="circle-or-tick-sentence inline-single-sentence"><span>${escapeHtml(item.segments[0] || '')}</span>${options.map((option, optionIndex) => `<label class="circle-choice"><input type="radio" name="${escapeHtml(inputId)}" value="${optionIndex}"><span>${escapeHtml(option)}</span></label>${optionIndex < options.length - 1 ? '<span class="choice-slash"> / </span>' : ''}`).join('')}<span>${escapeHtml(item.segments[1] || '')}</span></div>`;
    } else if (item.input === 'multiple' || item.input === 'single') {
      const inputType = item.input === 'multiple' ? 'checkbox' : 'radio';
      control = `<div class="option-list compact-options">${(item.options || []).map((option, optionIndex) => `<label class="option"><input type="${inputType}" name="${escapeHtml(inputId)}" value="${optionIndex}"><span>${escapeHtml(option)}</span></label>`).join('')}</div>`;
    } else if (item.input === 'select') {
      const selectControl = `<select id="${escapeHtml(inputId)}"><option value="">Choose an answer</option>${(item.options || []).map((option, optionIndex) => `<option value="${optionIndex}">${escapeHtml(option)}</option>`).join('')}</select>`;
      const segments = Array.isArray(item.segments) ? item.segments : [];
      control = segments.length >= 2
        ? `<div class="sentence-gaps sentence-select-gap" aria-label="${prompt}"><span>${escapeHtml(segments[0] || '')}</span>${selectControl}<span>${escapeHtml(segments[1] || '')}</span></div>`
        : selectControl;
    } else if (item.input === 'textarea') {
      control = `<textarea id="${escapeHtml(inputId)}" placeholder="${escapeHtml(item.placeholder || '')}"></textarea>`;
    } else if (item.input === 'gaps') {
      const answers = Array.isArray(item.answers) ? item.answers : [];
      const segments = Array.isArray(item.segments) ? item.segments : [];
      const gapClass = item.inputSize === 'wide' ? 'gap-input gap-input-wide' : 'gap-input';
      control = `<div class="sentence-gaps" aria-label="${prompt}">${answers.map((answer, gapIndex) => `${gapIndex < segments.length ? `<span>${escapeHtml(segments[gapIndex])}</span>` : ''}<input class="${gapClass}" data-gap-index="${gapIndex}" aria-label="Gap ${gapIndex + 1}" autocomplete="off">`).join('')}${segments.length > answers.length ? `<span>${escapeHtml(segments[segments.length - 1])}</span>` : ''}</div>`;
    } else if (item.input === 'checkbox') {
      control = `<label class="task-checkbox"><input type="checkbox" id="${escapeHtml(inputId)}"><span>${prompt || escapeHtml(item.label || 'Done')}</span></label>`;
    } else {
      control = `<input class="text-field" id="${escapeHtml(inputId)}" autocomplete="off" placeholder="${escapeHtml(item.placeholder || '')}">`;
    }

    if (inlineNumberedItems && numberMarkup && !prompt && (item.input === 'gaps' || item.input === 'circle-or-tick' || ((item.input === 'select' || item.input === 'single') && Array.isArray(item.segments)))) {
      return `<div class="exercise-item" data-exercise-item="${escapeHtml(itemId)}" data-input-type="${escapeHtml(item.input || 'text')}">
        <div class="exercise-item-inline-row">${numberMarkup}<div class="exercise-item-inline-content">${context}${control}</div></div>
        <div class="feedback" aria-live="polite"></div>
      </div>`;
    }

    const itemHeader = numberMarkup || prompt
      ? `<div class="exercise-item-header">${numberMarkup}<label class="exercise-prompt" for="${escapeHtml(inputId)}">${prompt}</label></div>`
      : '';
    return `<div class="exercise-item" data-exercise-item="${escapeHtml(itemId)}" data-input-type="${escapeHtml(item.input || 'text')}">
      ${itemHeader}
      <div class="exercise-control">${context}${control}</div>
      <div class="feedback" aria-live="polite"></div>
    </div>`;
  }


  function renderDialogueItem(item, blockId, index) {
    const itemId = safeText(item.id, `${index + 1}`);
    const number = item.number === undefined ? index + 1 : item.number;
    const segments = Array.isArray(item.segments) ? item.segments : [];
    const inputId = `dialogue-${blockId}-${itemId}`.replace(/[^a-zA-Z0-9_-]/g, '-');
    const gapNumber = number === '' || number === null
      ? ''
      : `<sup class="dialogue-gap-number">${escapeHtml(number)}</sup>`;

    if (item.example) {
      if (segments.length >= 2) {
        return `<span class="dialogue-item dialogue-example" data-exercise-item="${escapeHtml(itemId)}"><span>${escapeHtml(segments[0])}</span>${gapNumber}<span class="dialogue-example-answer">${escapeHtml(item.exampleAnswer || '')}</span><span>${escapeHtml(segments[1])}</span></span>`;
      }
      return `<span class="dialogue-item dialogue-example" data-exercise-item="${escapeHtml(itemId)}">${gapNumber}<span>${escapeHtml(item.prompt || '')}</span></span>`;
    }

    if (item.input !== 'gaps') {
      return `<span class="dialogue-item" data-exercise-item="${escapeHtml(itemId)}" data-input-type="${escapeHtml(item.input || 'text')}">${gapNumber}<input class="text-field dialogue-text-input" id="${escapeHtml(inputId)}" autocomplete="off" placeholder="${escapeHtml(item.placeholder || '')}"><span class="feedback" aria-live="polite"></span></span>`;
    }

    const answers = Array.isArray(item.answers) ? item.answers : [];
    const content = answers.map((answer, gapIndex) => {
      const before = gapIndex < segments.length ? `<span>${escapeHtml(segments[gapIndex])}</span>` : '';
      const numberBeforeFirstGap = gapIndex === 0 ? gapNumber : '';
      return `${before}${numberBeforeFirstGap}<input class="gap-input dialogue-gap-input" data-gap-index="${gapIndex}" aria-label="Gap ${escapeHtml(number || gapIndex + 1)}${answers.length > 1 ? `, part ${gapIndex + 1}` : ''}" autocomplete="off">`;
    }).join('');
    const tail = segments.length > answers.length ? `<span>${escapeHtml(segments[segments.length - 1])}</span>` : '';

    return `<span class="dialogue-item" data-exercise-item="${escapeHtml(itemId)}" data-input-type="gaps">${content}${tail}<span class="feedback" aria-live="polite"></span></span>`;
  }


  function renderArticleMcqExercise(block, blockId) {
    const items = Array.isArray(block.items) ? block.items : [];
    const articleTitle = escapeHtml(block.articleTitle || '');
    const articleText = escapeHtml(block.articleText || '').replaceAll('\n', '<br>');
    const questions = items.map((item, itemIndex) => renderExerciseItem(item, blockId, itemIndex, false)).join('');
    return `<div class="article-mcq-layout">
      <article class="article-mcq-copy" aria-label="Article">
        ${articleTitle ? `<h4>${articleTitle}</h4>` : ''}
        <p>${articleText}</p>
      </article>
      <div class="article-mcq-questions exercise-items">${questions}</div>
    </div>`;
  }


  function renderImageSpellingGrid(block, blockId) {
    const items = Array.isArray(block.items) ? block.items : [];
    const renderPattern = (item) => {
      if (item.example) {
        return `<div class="image-spelling-word is-example-word"><span class="exercise-example-label">${escapeHtml(item.exampleLabel || 'EXAMPLE')}</span><strong>${escapeHtml(item.answer || '')}</strong></div>`;
      }
      let blankIndex = 0;
      return `<div class="image-spelling-word" aria-label="Complete the word">${[...safeText(item.pattern)].map((char) => {
        if (char === '_') {
          const index = blankIndex++;
          return `<input class="image-spelling-letter" data-spelling-letter="${index}" maxlength="1" autocomplete="off" aria-label="Missing letter ${index + 1}">`;
        }
        if (char === ' ') return '<span class="image-spelling-space" aria-hidden="true"></span>';
        return `<span class="image-spelling-fixed">${escapeHtml(char)}</span>`;
      }).join('')}</div>`;
    };
    return `<div class="image-spelling-grid" data-image-spelling-grid>${items.map((item, itemIndex) => {
      const itemId = safeText(item.id, `${itemIndex + 1}`);
      const number = item.number === undefined ? itemIndex + 1 : item.number;
      return `<div class="image-spelling-item exercise-item${item.example ? ' exercise-example' : ''}" data-exercise-item="${escapeHtml(itemId)}" data-input-type="image-spelling">
        <div class="image-spelling-number">${escapeHtml(number)}</div>
        <div class="image-spelling-picture-wrap"><img class="image-spelling-picture" src="${escapeHtml(item.image || '')}" alt="${escapeHtml(item.imageAlt || '')}" loading="lazy"></div>
        ${renderPattern(item)}
        ${item.example ? '' : '<div class="feedback" aria-live="polite"></div>'}
      </div>`;
    }).join('')}</div>`;
  }

  function renderPronunciationChoiceTable(block, blockId) {
    const items = Array.isArray(block.items) ? block.items : [];
    return `<div class="pronunciation-choice-table" role="table" aria-label="Pronunciation exercise">
      ${items.map((item, itemIndex) => {
        const itemId = safeText(item.id, `${itemIndex + 1}`);
        const inputId = `exercise-${blockId}-${itemId}`.replace(/[^a-zA-Z0-9_-]/g, '-');
        const number = item.number === undefined ? itemIndex + 1 : item.number;
        const reference = escapeHtml(item.reference || '');
        const answerIndex = Number(item.answer);
        if (item.example) {
          const choices = (item.options || []).map((option, optionIndex) => `<span class="pronunciation-example-choice${optionIndex === answerIndex ? ' is-selected' : ''}">${escapeHtml(option)}</span>`).join('');
          return `<div class="pronunciation-choice-row exercise-item exercise-example" role="row" data-exercise-item="${escapeHtml(itemId)}">
            <div class="pronunciation-choice-reference" role="cell"><span class="exercise-number">${escapeHtml(number)}</span><strong>${reference}</strong><span class="exercise-example-label">EXAMPLE</span></div>
            <div class="pronunciation-choice-options" role="cell">${choices}</div>
          </div>`;
        }
        const choices = (item.options || []).map((option, optionIndex) => `<label class="pronunciation-table-choice"><input type="radio" name="${escapeHtml(inputId)}" value="${optionIndex}"><span>${escapeHtml(option)}</span></label>`).join('');
        return `<div class="pronunciation-choice-row exercise-item" role="row" data-exercise-item="${escapeHtml(itemId)}" data-input-type="single">
          <div class="pronunciation-choice-reference" role="cell"><span class="exercise-number">${escapeHtml(number)}</span><strong>${reference}</strong></div>
          <div class="pronunciation-choice-options" role="cell">${choices}</div>
          <div class="feedback" aria-live="polite"></div>
        </div>`;
      }).join('')}
    </div>`;
  }

  function renderDialogueExercise(block, blockId) {
    const items = Array.isArray(block.items) ? block.items : [];
    const itemMap = new Map(items.map((item, index) => [safeText(item.id, `${index + 1}`), { item, index }]));
    const lines = Array.isArray(block.dialogueLines) ? block.dialogueLines : [];

    if (!lines.length) {
      return `<div class="exercise-items">${items.map((item, itemIndex) => renderExerciseItem(item, blockId, itemIndex)).join('')}</div>`;
    }

    return `<div class="dialogue-exercise" role="group" aria-label="Conversation exercise">${lines.map((line) => {
      const speaker = escapeHtml(line.speaker || '');
      const text = line.text ? `<span class="dialogue-plain-text">${escapeHtml(line.text)}</span>` : '';
      const lineItems = (Array.isArray(line.itemIds) ? line.itemIds : []).map((itemId) => {
        const entry = itemMap.get(safeText(itemId));
        return entry ? renderDialogueItem(entry.item, blockId, entry.index) : '';
      }).filter(Boolean).join(' ');
      return `<div class="dialogue-line"><span class="dialogue-speaker" aria-label="Speaker ${speaker}">${speaker}</span><div class="dialogue-utterance">${text}${text && lineItems ? ' ' : ''}${lineItems}</div></div>`;
    }).join('')}</div>`;
  }

  function renderLessonBlock(block, index) {
    const id = safeText(block.id, `task-${index}`);
    const title = escapeHtml(block.title || block.prompt || `Task ${index + 1}`);
    const text = escapeHtml(block.text || '').replaceAll('\n', '<br>');

    if (block.type === 'section') {
      const sectionEyebrow = Object.prototype.hasOwnProperty.call(block, 'eyebrow')
        ? safeText(block.eyebrow)
        : 'Material';
      const explicitSectionNumber = block.sectionNumber === undefined || block.sectionNumber === null || block.sectionNumber === ''
        ? null
        : block.sectionNumber;
      const sectionNumber = explicitSectionNumber ?? block.__sectionNumber ?? index + 1;
      const titleLead = safeText(block.titleLead);
      const titleTail = safeText(block.titleTail);
      const sectionTitle = titleLead
        ? `<span class="lesson-section-title-main">${escapeHtml(titleLead)}</span>${titleTail ? `<span class="lesson-section-title-tail">${escapeHtml(titleTail)}</span>` : ''}`
        : title;
      const sectionTitleClass = titleLead ? ' class="lesson-section-title-composite"' : '';
      return `<header id="lesson-section-${index}" class="lesson-section-title lesson-block" data-lesson-section><span class="lesson-section-step">${escapeHtml(sectionNumber)}</span><div>${sectionEyebrow ? `<span class="eyebrow">${escapeHtml(sectionEyebrow)}</span>` : ''}<h2${sectionTitleClass}>${sectionTitle}</h2>${text ? `<p class="muted">${text}</p>` : ''}</div></header>`;
    }
    if (block.type === 'info') return `<article class="card info-card lesson-block"><h3>${title}</h3><p>${text}</p></article>`;
    if (block.type === 'tip') return `<article class="card tip-card lesson-block"><h3>${title}</h3><p>${text}</p></article>`;
    if (block.type === 'reading') {
      const sectionCount = Array.isArray(block.sections) ? block.sections.length : 0;
      return `<article class="card lesson-block reading-card"><div class="reading-title"><div><span class="eyebrow">Reading</span><h3>${title}</h3></div>${sectionCount ? `<span class="reading-count">${sectionCount} sections</span>` : ''}</div>${renderReadingSections(block)}</article>`;
    }
    if (block.type === 'exercise') {
      const items = Array.isArray(block.items) ? block.items : [];
      const wordBankLabel = Object.prototype.hasOwnProperty.call(block, 'wordBankLabel') ? safeText(block.wordBankLabel) : 'Word bank';
      const wordBank = Array.isArray(block.wordBank) && block.wordBank.length
        ? `<div class="word-bank" aria-label="${escapeHtml(wordBankLabel || 'Word list')}">${wordBankLabel ? `<strong class="word-bank-label">${escapeHtml(wordBankLabel)}</strong>` : ''}${block.wordBank.map((word) => `<span>${escapeHtml(word)}</span>`).join('')}</div>`
        : '';
      const wordBanks = Array.isArray(block.wordBanks) && block.wordBanks.length
        ? `<div class="word-bank-groups">${block.wordBanks.map((group) => `<div class="word-bank" aria-label="${escapeHtml(group.label || 'Word bank')}"><strong class="word-bank-label">${escapeHtml(group.label || 'Word bank')}</strong>${(group.words || []).map((word) => `<span>${escapeHtml(word)}</span>`).join('')}</div>`).join('')}</div>`
        : '';
      const player = block.audio ? `<audio class="audio-player" controls preload="none" src="${escapeHtml(block.audio)}"></audio>` : '';
      const imageEntries = Array.isArray(block.images) && block.images.length
        ? block.images
        : block.image
          ? [{ src: block.image, alt: block.imageAlt || '', label: '' }]
          : [];
      const image = imageEntries.length
        ? `<div class="exercise-images${imageEntries.length > 1 ? ' exercise-images-multiple' : ''}">${imageEntries.map((entry) => {
            const src = typeof entry === 'string' ? entry : entry?.src;
            const alt = typeof entry === 'string' ? '' : entry?.alt || '';
            const label = typeof entry === 'string' ? '' : entry?.label || '';
            if (!src) return '';
            return `<figure class="exercise-image-figure"><a class="exercise-image-link" href="${escapeHtml(src)}" target="_blank" rel="noopener"><img class="exercise-image" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy"></a>${label ? `<figcaption>${escapeHtml(label)}</figcaption>` : ''}</figure>`;
          }).join('')}</div>`
        : '';
      const intro = block.introTitle || block.introText ? `<div class="exercise-source"><h4>${escapeHtml(block.introTitle || '')}</h4>${block.introText ? `<p>${escapeHtml(block.introText)}</p>` : ''}</div>` : '';
      const exerciseContent = block.layout === 'dialogue'
        ? renderDialogueExercise(block, id)
        : block.layout === 'crossword'
          ? renderCrosswordExercise(block, id)
          : block.layout === 'crossword-grid'
            ? renderCrosswordGridExercise(block, id)
            : block.layout === 'continuous-gaps'
            ? renderContinuousGapsExercise(block, id)
            : block.layout === 'ed-pronunciation'
              ? renderEdPronunciationExercise(block, id)
              : block.layout === 'present-past-table'
                ? renderPresentPastTable(block, id)
                : block.layout === 'article-mcq'
                  ? renderArticleMcqExercise(block, id)
                  : block.layout === 'pronunciation-choice-table'
                    ? renderPronunciationChoiceTable(block, id)
                    : block.layout === 'image-spelling-grid'
                      ? renderImageSpellingGrid(block, id)
                      : `<div class="exercise-items">${items.map((item, itemIndex) => renderExerciseItem(item, id, itemIndex, block.inlineNumberedItems === true)).join('')}</div>`;
      const hasStickyImage = block.stickyImage === true && imageEntries.length === 1;
      const exerciseBody = hasStickyImage
        ? `<div class="exercise-sticky-layout"><div class="exercise-sticky-media">${image}</div><div class="exercise-sticky-content">${intro}${exerciseContent}</div></div>`
        : `${image}${intro}${exerciseContent}`;
      return `<article class="card lesson-block exercise-card${block.layout === 'dialogue' ? ' dialogue-card' : ''}${hasStickyImage ? ' has-sticky-image' : ''}" data-task="${escapeHtml(id)}" data-type="exercise">
        <div class="exercise-heading">${Object.prototype.hasOwnProperty.call(block, 'eyebrow') ? (safeText(block.eyebrow) ? `<span class="eyebrow">${escapeHtml(safeText(block.eyebrow))}</span>` : '') : '<span class="eyebrow">Exercise</span>'}<h3>${title}</h3>${block.instructions ? `<p class="muted exercise-instructions">${escapeHtml(block.instructions)}</p>` : ''}${player}${wordBank}${wordBanks}</div>
        ${exerciseBody}
      </article>`;
    }
    if (block.type === 'text' || block.type === 'translate') return `<article class="card lesson-block" data-task="${escapeHtml(id)}" data-type="${escapeHtml(block.type)}"><label class="field-label" for="${escapeHtml(id)}">${title}</label>${block.source ? `<p class="muted">${escapeHtml(block.source)}</p>` : ''}<input class="text-field" id="${escapeHtml(id)}" name="${escapeHtml(id)}" autocomplete="off"><div class="feedback"></div></article>`;
    if (block.type === 'textarea') return `<article class="card lesson-block" data-task="${escapeHtml(id)}" data-type="textarea"><label class="field-label" for="${escapeHtml(id)}">${title}</label><textarea id="${escapeHtml(id)}" name="${escapeHtml(id)}"></textarea><div class="feedback"></div></article>`;
    if (block.type === 'single' || block.type === 'multiple') {
      const inputType = block.type === 'single' ? 'radio' : 'checkbox';
      const options = (block.options || []).map((option, optionIndex) => `<label class="option"><input type="${inputType}" name="${escapeHtml(id)}" value="${optionIndex}"><span>${escapeHtml(option)}</span></label>`).join('');
      return `<article class="card lesson-block" data-task="${escapeHtml(id)}" data-type="${escapeHtml(block.type)}"><h3>${title}</h3><div class="option-list">${options}</div><div class="feedback"></div></article>`;
    }
    if (block.type === 'select') {
      const options = (block.options || []).map((option, optionIndex) => `<option value="${optionIndex}">${escapeHtml(option)}</option>`).join('');
      return `<article class="card lesson-block" data-task="${escapeHtml(id)}" data-type="select"><label class="field-label" for="${escapeHtml(id)}">${title}</label><select id="${escapeHtml(id)}"><option value="">Choose an answer</option>${options}</select><div class="feedback"></div></article>`;
    }
    if (block.type === 'match') {
      const rights = (block.pairs || []).map((pair) => pair.right);
      const rows = (block.pairs || []).map((pair, pairIndex) => `<div>${escapeHtml(pair.left)}</div><select data-match-index="${pairIndex}"><option value="">Choose a match</option>${rights.map((right, rightIndex) => `<option value="${rightIndex}">${escapeHtml(right)}</option>`).join('')}</select>`).join('');
      return `<article class="card lesson-block" data-task="${escapeHtml(id)}" data-type="match"><h3>${title}</h3><div class="match-grid">${rows}</div><div class="feedback"></div></article>`;
    }
    if (block.type === 'reorder') {
      const chips = shuffled(block.words || []).map((word) => `<button class="word-chip" type="button" data-word="${escapeHtml(word)}">${escapeHtml(word)}</button>`).join('');
      return `<article class="card lesson-block" data-task="${escapeHtml(id)}" data-type="reorder"><h3>${title}</h3><div class="word-chips" data-reorder-source>${chips}</div><label class="field-label" for="${escapeHtml(id)}">Your sentence</label><input class="text-field" id="${escapeHtml(id)}" readonly><div class="feedback"></div></article>`;
    }
    if (block.type === 'audio') {
      const player = block.audio ? `<audio class="audio-player" controls preload="none" src="${escapeHtml(block.audio)}"></audio>` : '<p class="muted">The audio file has not been added yet.</p>';
      const response = block.response === false ? '' : `<input class="text-field" id="${escapeHtml(id)}" aria-label="Audio task answer"><div class="feedback"></div>`;
      const taskAttrs = block.response === false ? '' : ` data-task="${escapeHtml(id)}" data-type="audio"`;
      return `<article class="card lesson-block audio-card"${taskAttrs}><div class="audio-icon" aria-hidden="true">🎧</div><div class="audio-content"><h3>${title}</h3>${text ? `<p class="muted">${text}</p>` : ''}${player}${response}</div></article>`;
    }
    return '';
  }

  function normalizeAnswer(value) {
    return safeText(value)
      .normalize('NFKC')
      .replace(/[’‘`]/g, "'")
      .trim()
      .toLocaleLowerCase('en')
      .replace(/[.!?,;:]+$/g, '')
      .replace(/\s+/g, ' ');
  }

  function textAnswerMatches(item, actual) {
    const accepted = Array.isArray(item.acceptedAnswers) && item.acceptedAnswers.length
      ? item.acceptedAnswers
      : Array.isArray(item.answer) ? item.answer : [item.answer];
    return accepted.some((answer) => normalizeAnswer(answer) !== '' && normalizeAnswer(answer) === normalizeAnswer(actual));
  }

  function checkExerciseItem(item, itemNode) {
    const inputType = item.input || 'text';
    let actual;
    let correct = false;

    if (inputType === 'example-gap') {
      actual = itemNode.querySelector('[data-example-gap]')?.value ?? '';
      correct = textAnswerMatches(item, actual);
    } else if (inputType === 'r-circle') {
      actual = [...itemNode.querySelectorAll('[data-r-index]:checked')].map((input) => Number(input.value)).sort((a, b) => a - b);
      const expected = [...(Array.isArray(item.answer) ? item.answer : [])].map(Number).sort((a, b) => a - b);
      correct = JSON.stringify(actual) === JSON.stringify(expected);
    } else if (inputType === 'pronunciation-sentence') {
      const text = itemNode.querySelector('[data-pronunciation-input]')?.value ?? '';
      const r = [...itemNode.querySelectorAll('[data-r-index]:checked')].map((input) => Number(input.value)).sort((a, b) => a - b);
      const expectedR = [...(Array.isArray(item.rAnswer) ? item.rAnswer : [])].map(Number).sort((a, b) => a - b);
      actual = { text, r };
      correct = textAnswerMatches(item, text) && JSON.stringify(r) === JSON.stringify(expectedR);
    } else if (inputType === 'crossword-word') {
      actual = [...itemNode.querySelectorAll('[data-crossword-letter]')].map((input) => safeText(input.value)).join('');
      correct = textAnswerMatches(item, actual);
    } else if (inputType === 'odd-one-out') {
      const selected = itemNode.querySelector('input[type="radio"]:checked')?.value ?? '';
      const reason = itemNode.querySelector('[data-odd-reason]')?.value ?? '';
      actual = { selected, reason };
      correct = selected !== ''
        && Number(selected) === Number(item.answer)
        && normalizeAnswer(reason) === normalizeAnswer(item.reasonAnswer);
    } else if (inputType === 'circle-or-tick') {
      actual = itemNode.querySelector('input:checked')?.value ?? '';
      correct = safeText(actual) === safeText(item.answer);
    } else if (inputType === 'multiple') {
      actual = [...itemNode.querySelectorAll('input:checked')].map((input) => Number(input.value)).sort((a, b) => a - b);
      const expected = [...(item.answer || [])].map(Number).sort((a, b) => a - b);
      correct = JSON.stringify(actual) === JSON.stringify(expected);
    } else if (inputType === 'single') {
      actual = itemNode.querySelector('input:checked')?.value ?? '';
      correct = Number(actual) === Number(item.answer);
    } else if (inputType === 'select') {
      actual = itemNode.querySelector('select')?.value ?? '';
      correct = actual !== '' && Number(actual) === Number(item.answer);
    } else if (inputType === 'gaps') {
      actual = [...itemNode.querySelectorAll('[data-gap-index]')].map((input) => input.value);
      const expected = Array.isArray(item.answers) ? item.answers : [];
      correct = expected.length > 0 && expected.every((answer, index) => {
        const accepted = Array.isArray(answer) ? answer : [answer];
        return accepted.some((variant) => normalizeAnswer(variant) === normalizeAnswer(actual[index]));
      });
    } else if (inputType === 'checkbox') {
      actual = itemNode.querySelector('input[type="checkbox"]')?.checked || false;
      correct = Boolean(actual);
    } else if (inputType === 'image-spelling') {
      actual = [...itemNode.querySelectorAll('[data-spelling-letter]')].map((input) => input.value);
      let blankIndex = 0;
      const reconstructed = [...safeText(item.pattern)].map((char) => {
        if (char !== '_') return char;
        const value = safeText(actual[blankIndex]);
        blankIndex += 1;
        return value;
      }).join('');
      correct = normalizeAnswer(reconstructed) === normalizeAnswer(item.answer);
    } else {
      actual = itemNode.querySelector('input, textarea')?.value || '';
      correct = textAnswerMatches(item, actual);
    }

    return { actual, correct };
  }

  function checkExerciseBlock(block, node, options = {}) {
    if (block.layout === 'crossword-grid') return checkCrosswordGridBlock(block, node);
    if (block.layout === 'continuous-gaps') return checkContinuousGapsBlock(block, node);
    if (block.layout === 'ed-pronunciation') return checkEdPronunciationBlock(block, node);
    if (block.layout === 'present-past-table') return checkPresentPastTableBlock(block, node);
    const actual = {};
    let correctCount = 0;
    let total = 0;

    (Array.isArray(block.items) ? block.items : []).forEach((item, index) => {
      if (item.example || item.displayOnly) return;
      const itemId = safeText(item.id, `${index + 1}`);
      const itemNode = node.querySelector(`[data-exercise-item="${CSS.escape(itemId)}"]`);
      if (!itemNode) return;
      const result = checkExerciseItem(item, itemNode);
      actual[itemId] = result.actual;
      const feedback = itemNode.querySelector('.feedback');

      if (item.scored === false) {
        if (!options.silent) {
          itemNode.classList.remove('is-correct', 'is-wrong');
          itemNode.classList.add('is-saved');
          if (feedback) {
            feedback.className = 'feedback show neutral';
            feedback.textContent = 'Your answer has been saved for the teacher.';
          }
        }
        return;
      }

      total += 1;
      if (result.correct) correctCount += 1;
      if (!options.silent) {
        itemNode.classList.toggle('is-correct', result.correct);
        itemNode.classList.toggle('is-wrong', !result.correct);
        itemNode.classList.remove('is-saved');
        if (feedback) {
          feedback.className = `feedback show ${result.correct ? 'good' : 'bad'}`;
          const hideAnswerOnError = options.hideAnswersOnError === true || block.hideAnswersOnError === true || item.hideAnswersOnError === true;
          feedback.textContent = result.correct
            ? 'Correct!'
            : hideAnswerOnError
              ? 'Incorrect. Check your answer and try again.'
              : safeText(item.explanation, 'Check the answer and try again.');
        }
      }
    });

    return { actual, correctCount, total };
  }

  function checkLessonTask(block, node, options = {}) {
    if (block.type === 'exercise') return checkExerciseBlock(block, node, options);
    let actual;
    let correct = false;
    if (block.type === 'single') {
      actual = node.querySelector('input:checked')?.value;
      correct = Number(actual) === Number(block.answer);
    } else if (block.type === 'multiple') {
      actual = [...node.querySelectorAll('input:checked')].map((input) => Number(input.value)).sort((a,b) => a-b);
      const expected = [...(block.answer || [])].map(Number).sort((a,b) => a-b);
      correct = JSON.stringify(actual) === JSON.stringify(expected);
    } else if (block.type === 'select') {
      actual = node.querySelector('select')?.value;
      correct = Number(actual) === Number(block.answer);
    } else if (block.type === 'match') {
      actual = [...node.querySelectorAll('[data-match-index]')].map((select) => Number(select.value));
      correct = actual.length > 0 && actual.every((value, index) => value === index);
    } else {
      actual = node.querySelector('input, textarea')?.value || '';
      if (Array.isArray(block.answer)) correct = block.answer.some((answer) => normalizeAnswer(answer) === normalizeAnswer(actual));
      else correct = normalizeAnswer(block.answer) !== '' && normalizeAnswer(block.answer) === normalizeAnswer(actual);
    }
    return { correctCount: correct ? 1 : 0, total: 1, actual };
  }

  function restoreExerciseAnswers(block, node, saved) {
    if (!saved || typeof saved !== 'object') return;
    if (block.layout === 'crossword-grid') { restoreCrosswordGridAnswers(block, node, saved); return; }
    if (block.layout === 'continuous-gaps') { restoreContinuousGapsAnswers(block, node, saved); return; }
    if (block.layout === 'ed-pronunciation') { restoreEdPronunciationAnswers(block, node, saved); return; }
    if (block.layout === 'present-past-table') { restorePresentPastTableAnswers(block, node, saved); return; }
    (Array.isArray(block.items) ? block.items : []).forEach((item, index) => {
      if (item.example || item.displayOnly) return;
      const itemId = safeText(item.id, `${index + 1}`);
      const value = saved[itemId];
      if (value === undefined) return;
      const itemNode = node.querySelector(`[data-exercise-item="${CSS.escape(itemId)}"]`);
      if (!itemNode) return;
      const inputType = item.input || 'text';
      if (inputType === 'example-gap') {
        const input = itemNode.querySelector('[data-example-gap]');
        if (input) input.value = safeText(value);
      } else if (inputType === 'r-circle') {
        const selected = new Set(Array.isArray(value) ? value.map(Number) : []);
        itemNode.querySelectorAll('[data-r-index]').forEach((input) => { input.checked = selected.has(Number(input.value)); });
      } else if (inputType === 'pronunciation-sentence') {
        const input = itemNode.querySelector('[data-pronunciation-input]');
        if (input) input.value = safeText(value?.text);
        updatePronunciationPreview(itemNode, Array.isArray(value?.r) ? value.r : []);
      } else if (inputType === 'crossword-word') {
        const letters = crosswordLetters(value);
        itemNode.querySelectorAll('[data-crossword-letter]').forEach((input, letterIndex) => { input.value = safeText(letters[letterIndex]).toUpperCase(); });
      } else if (inputType === 'odd-one-out') {
        const selected = safeText(value?.selected);
        const input = itemNode.querySelector(`input[type="radio"][value="${CSS.escape(selected)}"]`);
        if (input) input.checked = true;
        const reason = itemNode.querySelector('[data-odd-reason]');
        if (reason) reason.value = safeText(value?.reason);
      } else if (inputType === 'circle-or-tick') {
        const input = itemNode.querySelector(`input[value="${CSS.escape(safeText(value))}"]`);
        if (input) input.checked = true;
      } else if (inputType === 'multiple') {
        const selected = new Set(Array.isArray(value) ? value.map(Number) : []);
        itemNode.querySelectorAll('input[type="checkbox"]').forEach((input) => { input.checked = selected.has(Number(input.value)); });
      } else if (inputType === 'single') {
        const input = itemNode.querySelector(`input[value="${CSS.escape(safeText(value))}"]`);
        if (input) input.checked = true;
      } else if (inputType === 'select') {
        const select = itemNode.querySelector('select');
        if (select) select.value = safeText(value);
      } else if (inputType === 'gaps') {
        const values = Array.isArray(value) ? value : [];
        itemNode.querySelectorAll('[data-gap-index]').forEach((input, gapIndex) => { input.value = safeText(values[gapIndex]); });
      } else if (inputType === 'image-spelling') {
        const values = Array.isArray(value) ? value : [];
        itemNode.querySelectorAll('[data-spelling-letter]').forEach((input, letterIndex) => { input.value = safeText(values[letterIndex]); });
      } else {
        const input = itemNode.querySelector('input, textarea');
        if (input) input.value = safeText(value);
      }
    });
  }

  function restoreLessonAnswers(root, blocks, savedAnswers) {
    if (!savedAnswers || typeof savedAnswers !== 'object') return;
    blocks.forEach((block, index) => {
      const taskId = safeText(block.id, `task-${index}`);
      const value = savedAnswers[taskId];
      if (value === undefined) return;
      const node = root.querySelector(`[data-task="${CSS.escape(taskId)}"]`);
      if (!node) return;
      if (block.type === 'exercise') {
        restoreExerciseAnswers(block, node, value);
      } else if (block.type === 'single') {
        const input = node.querySelector(`input[value="${CSS.escape(safeText(value))}"]`);
        if (input) input.checked = true;
      } else if (block.type === 'multiple') {
        const selected = new Set(Array.isArray(value) ? value.map(Number) : []);
        node.querySelectorAll('input[type="checkbox"]').forEach((input) => { input.checked = selected.has(Number(input.value)); });
      } else if (block.type === 'select') {
        const select = node.querySelector('select');
        if (select) select.value = safeText(value);
      } else if (block.type === 'match') {
        const values = Array.isArray(value) ? value : [];
        node.querySelectorAll('[data-match-index]').forEach((select, matchIndex) => { select.value = safeText(values[matchIndex]); });
      } else {
        const input = node.querySelector('input, textarea');
        if (input) input.value = safeText(value);
      }
    });
  }

  async function renderLesson() {
    const id = queryParam('id');
    const lessonRecord = HOMEWORK_DATA.find((item) => item.id === id && item.status !== 'draft');
    const root = byId('lesson-root');
    if (!lessonRecord || lessonRecord.status === 'locked') {
      root.innerHTML = emptyState('📝', 'The assignment has not been published yet', 'The teacher will add the material after the lesson.');
      return;
    }

    byId('lesson-hero-title').textContent = safeText(lessonRecord.title, 'Assignment');
    byId('lesson-hero-subtitle').textContent = `Homework #${Number(lessonRecord.number || 0)} · ${safeText(lessonRecord.subtitle, 'Interactive practice')}`;
    root.innerHTML = '<div class="card empty-state compact-empty"><div class="empty-state-icon">⏳</div><h3>Loading the assignment…</h3></div>';

    let lesson;
    try {
      lesson = await resolveLessonContent(lessonRecord);
    } catch (error) {
      console.error('Lesson content loading error:', error);
      root.innerHTML = emptyState('⚠️', 'Could not load the assignment', 'Check that the lesson JSON file exists in data/lessons and has the correct structure.');
      return;
    }

    const blocks = Array.isArray(lesson?.blocks) ? lesson.blocks : [];
    if (!blocks.length) {
      root.innerHTML = emptyState('📝', 'The assignment has not been published yet', 'The content will appear after the teacher prepares it.');
      return;
    }

    const progress = window.ProgressService.loadHomeworkProgress();
    const savedResult = progress.results[lesson.id];
    const pointsLabel = Number(lesson.totalPoints || 0) > 0 ? `${escapeHtml(lesson.totalPoints)} checked answers` : 'No automatic score';
    const hasManualResponses = blocks.some((block) => block.type === 'exercise' && (block.items || []).some((item) => item.scored === false));
    const lessonSections = blocks
      .map((block, blockIndex) => block.type === 'section' ? { block, blockIndex } : null)
      .filter(Boolean);
    const roadmap = lessonSections.length
      ? `<nav class="card lesson-roadmap" aria-label="Homework plan"><div class="lesson-roadmap-heading"><span class="eyebrow">Assignment plan</span><p>Complete the sections in order — your answers are saved automatically.</p></div><ol>${lessonSections.map(({ block, blockIndex }, sectionIndex) => `<li><a href="#lesson-section-${blockIndex}"><span>${sectionIndex + 1}</span><strong>${escapeHtml(block.title || `Part ${sectionIndex + 1}`)}</strong></a></li>`).join('')}</ol></nav>`
      : '';
    let sectionNumber = 0;
    const renderedBlocks = blocks.map((block, blockIndex) => {
      if (block.type === 'section') sectionNumber += 1;
      return renderLessonBlock(block.type === 'section' ? { ...block, __sectionNumber: sectionNumber } : block, blockIndex);
    }).join('');
    const linkedMaterials = lessonMaterialLinks(lesson, 'lesson');
    root.innerHTML = `<div class="card lesson-intro"><div><span class="eyebrow">Homework #${Number(lesson.number || 0)}</span><p>${escapeHtml(lesson.subtitle || '')}</p></div><span class="lesson-points">${pointsLabel}</span></div>
      ${linkedMaterials}
      ${roadmap}
      <div id="lesson-blocks">${renderedBlocks}</div>
      <div class="card section lesson-actions"><div id="lesson-result" aria-live="polite"></div><div class="button-row"><button class="btn btn-primary" id="check-lesson" type="button">Check answers</button><button class="btn btn-secondary" id="submit-lesson" type="button" ${savedResult && Number(savedResult.total || 0) > 0 ? '' : 'disabled'}>Submit to teacher</button></div><p class="muted save-note">Your answers are saved automatically on this device and synced with Supabase. Use Check answers when you are ready.</p></div>`;

    restoreLessonAnswers(root, blocks, savedResult?.answers);
    wireLessonInteractiveInputs(root);

    root.querySelectorAll('[data-reorder-source]').forEach((source) => {
      source.addEventListener('click', (event) => {
        const chip = event.target.closest('[data-word]');
        if (!chip) return;
        chip.classList.toggle('selected');
        const parent = source.closest('[data-task]');
        const input = parent.querySelector('input');
        const selected = [...source.querySelectorAll('.selected')].map((item) => item.dataset.word);
        input.value = selected.join(' ');
      });
    });

    const evaluateLesson = (options = {}) => {
      const checkableTypes = ['text','textarea','single','multiple','select','match','reorder','translate','audio','exercise'];
      const checkable = blocks
        .map((block, blockIndex) => ({ block, blockIndex }))
        .filter(({ block }) => checkableTypes.includes(block.type) && !(block.type === 'audio' && block.response === false));
      let correct = 0;
      let total = 0;
      const answers = {};

      checkable.forEach(({ block, blockIndex }) => {
        const taskId = safeText(block.id, `task-${blockIndex}`);
        const node = root.querySelector(`[data-task="${CSS.escape(taskId)}"]`);
        if (!node) return;
        const result = checkLessonTask(block, node, options);
        answers[taskId] = result.actual;
        correct += Number(result.correctCount || 0);
        total += Number(result.total || 0);

        if (!options.silent && block.type !== 'exercise') {
          const feedback = node.querySelector('.feedback');
          const isCorrect = Number(result.correctCount || 0) === Number(result.total || 0);
          if (feedback) {
            feedback.className = `feedback show ${isCorrect ? 'good' : 'bad'}`;
            feedback.textContent = isCorrect ? 'Correct!' : safeText(block.explanation, 'Check the answer and try again.');
          }
        }
      });

      return { correct, total, percent: safePercent(correct, total), answers };
    };

    let draftSaveTimer = 0;
    const saveDraftAnswers = () => {
      const snapshot = evaluateLesson({ silent: true });
      const latestProgress = window.ProgressService.loadHomeworkProgress();
      const previous = latestProgress.results[lesson.id] || {};
      const previousAnswers = previous.answers && typeof previous.answers === 'object' ? previous.answers : {};
      const answersChanged = JSON.stringify(previousAnswers) !== JSON.stringify(snapshot.answers);

      latestProgress.results[lesson.id] = {
        correct: answersChanged ? 0 : Number(previous.correct || 0),
        total: answersChanged ? 0 : Number(previous.total || 0),
        percent: answersChanged ? 0 : Number(previous.percent || 0),
        answers: snapshot.answers,
        checkedAt: answersChanged ? null : (previous.checkedAt || null),
        draftUpdatedAt: new Date().toISOString()
      };
      window.ProgressService.saveHomeworkProgress(latestProgress);

      if (answersChanged) {
        byId('submit-lesson').disabled = true;
        byId('lesson-result').innerHTML = '<p class="muted">Draft saved automatically. Check answers when you are ready.</p>';
      }
    };

    const scheduleDraftSave = () => {
      window.clearTimeout(draftSaveTimer);
      draftSaveTimer = window.setTimeout(saveDraftAnswers, 250);
    };

    root.addEventListener('input', scheduleDraftSave);
    root.addEventListener('change', scheduleDraftSave);

    // Restore not only the values, but also the green/red review state after reload.
    if (savedResult && Number(savedResult.total) > 0) {
      evaluateLesson();
      byId('lesson-result').innerHTML = `<h3>Saved score: ${Number(savedResult.correct || 0)} of ${Number(savedResult.total || 0)}</h3><p class="muted">${Number(savedResult.percent || 0)}% correct</p>`;
    }

    byId('check-lesson').addEventListener('click', () => {
      const result = evaluateLesson();
      const manualNote = hasManualResponses ? ' · the extended answer is saved separately and is not included in the score' : '';
      byId('lesson-result').innerHTML = `<h3>Score: ${result.correct} of ${result.total}</h3><p class="muted">${result.percent}% correct${manualNote}</p>`;
      const updatedProgress = window.ProgressService.loadHomeworkProgress();
      updatedProgress.results[lesson.id] = {
        correct: result.correct,
        total: result.total,
        percent: result.percent,
        answers: result.answers,
        checkedAt: new Date().toISOString()
      };
      window.ProgressService.saveHomeworkProgress(updatedProgress);
      byId('submit-lesson').disabled = false;
    });

    byId('submit-lesson').addEventListener('click', async () => {
      const button = byId('submit-lesson');
      const updatedProgress = window.ProgressService.loadHomeworkProgress();
      const result = updatedProgress.results[lesson.id];
      if (!result || Number(result.total || 0) <= 0) {
        showToast('Check the answers before submitting the homework.');
        return;
      }

      const submittedAt = new Date().toISOString();
      updatedProgress.submissions[lesson.id] = {
        savedAt: submittedAt,
        status: CloudService.isConfigured() ? 'pending-cloud' : 'local'
      };
      // Submission, not a perfect score, marks the homework as completed.
      if (!updatedProgress.completedIds.includes(lesson.id)) updatedProgress.completedIds.push(lesson.id);
      window.ProgressService.saveHomeworkProgress(updatedProgress);

      button.disabled = true;
      const originalText = button.textContent;
      button.textContent = 'Sending…';

      try {
        if (CloudService.isConfigured()) {
          // Wait until the submitted row is really written before the report function reads it.
          await window.ProgressService.syncToCloud('homework');
          const report = await HomeworkReportService.send(lesson.id);
          const latest = window.ProgressService.loadHomeworkProgress();
          latest.submissions[lesson.id] = {
            savedAt: submittedAt,
            status: report?.skipped ? 'cloud' : 'report-sent'
          };
          window.ProgressService.saveHomeworkProgress(latest);
          showToast(report?.skipped ? 'Homework saved in Supabase.' : 'Homework submitted. The teacher received the Telegram report.');
        } else {
          showToast('Homework saved on this device. Supabase is not configured.');
        }
      } catch (error) {
        console.error('Homework submission/report error:', error);
        const latest = window.ProgressService.loadHomeworkProgress();
        latest.submissions[lesson.id] = { savedAt: submittedAt, status: 'report-failed' };
        window.ProgressService.saveHomeworkProgress(latest);
        showToast(`Homework saved, but the Telegram report was not sent: ${safeText(error?.message, 'unknown error')}`);
      } finally {
        button.disabled = false;
        button.textContent = originalText;
      }
    });
  }

  
  function grammarTable(table) {
    if (!table || !Array.isArray(table.headers) || !Array.isArray(table.rows)) return '';
    return `<div class="table-wrap"><table><thead><tr>${table.headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>${table.rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }

  function renderGrammarExercise(block, index) {
    const id = safeText(block.id, `grammar-exercise-${index + 1}`);
    const title = escapeHtml(block.title || `Упражнение ${index + 1}`);
    const difficulty = safeText(block.difficulty, 'Практика');
    const wordBank = Array.isArray(block.wordBank) && block.wordBank.length
      ? `<div class="word-bank" aria-label="Word bank"><strong class="word-bank-label">Слова</strong>${block.wordBank.map((word) => `<span>${escapeHtml(word)}</span>`).join('')}</div>`
      : '';
    return `<article class="card lesson-block exercise-card grammar-exercise-card" data-task="${escapeHtml(id)}" data-type="exercise" data-grammar-exercise="${index}">
      <div class="exercise-heading grammar-exercise-heading">
        <div class="grammar-step-row"><span class="grammar-step-badge">Шаг ${index + 1}</span><span class="grammar-difficulty">${escapeHtml(difficulty)}</span></div>
        <h3>${title}</h3>
        ${block.instructions ? `<p class="muted exercise-instructions">${escapeHtml(block.instructions)}</p>` : ''}
        ${wordBank}
      </div>
      <div class="exercise-items">${(Array.isArray(block.items) ? block.items : []).map((item, itemIndex) => renderExerciseItem(item, id, itemIndex)).join('')}</div>
    </article>`;
  }

  function setGrammarPracticeLocked(root, locked) {
    root.classList.toggle('grammar-practice-locked', locked);
    root.querySelectorAll('[data-grammar-exercise] input, [data-grammar-exercise] textarea, [data-grammar-exercise] select').forEach((control) => {
      control.disabled = locked;
    });
  }

  function renderGrammarPractice(topic, root) {
    const exercises = Array.isArray(topic.exercises) ? topic.exercises : [];
    if (!exercises.length) {
      root.innerHTML = emptyState('🧩', 'Практика пока не добавлена', 'Упражнения появятся вместе с материалом преподавателя.');
      return;
    }

    const renderPractice = () => {
      const progress = window.ProgressService.loadGrammarProgress();
      const savedTopic = progress.topics[topic.id] || {};
      root.innerHTML = `${exercises.map((block, index) => renderGrammarExercise(block, index)).join('')}
        <div class="card grammar-practice-actions">
          <div id="grammar-result"><h3>Выполняй по шагам</h3><p class="muted">Начни с более простых заданий и постепенно переходи к сложным.</p></div>
          <div class="button-row"><button class="btn btn-primary" type="button" id="check-grammar">Проверить</button><button class="btn btn-secondary" type="button" id="retry-grammar">Начать заново</button></div>
        </div>`;

      exercises.forEach((block, index) => {
        const blockId = safeText(block.id, `grammar-exercise-${index + 1}`);
        const node = root.querySelector(`[data-grammar-exercise="${index}"]`);
        if (node) restoreExerciseAnswers(block, node, savedTopic.answers?.[blockId]);
      });

      const checkButton = byId('check-grammar');
      const retryButton = byId('retry-grammar');
      const lockPassedTopic = Boolean(savedTopic.passed && topic.lockOnPass === true);
      if (lockPassedTopic) {
        setGrammarPracticeLocked(root, true);
        checkButton.disabled = true;
        retryButton.disabled = true;
        retryButton.hidden = true;
        byId('grammar-result').innerHTML = '<h3>Тема пройдена</h3><p class="grammar-success-note">Все ответы правильные. Тема отмечена как изученная, поля ответов заблокированы.</p>';
        return;
      }

      checkButton.addEventListener('click', () => {
        let correct = 0;
        let total = 0;
        const answers = {};
        exercises.forEach((block, index) => {
          const node = root.querySelector(`[data-grammar-exercise="${index}"]`);
          if (!node) return;
          const blockId = safeText(block.id, `grammar-exercise-${index + 1}`);
          const result = checkExerciseBlock(block, node, { hideAnswersOnError: topic.revealAnswersOnError === false });
          answers[blockId] = result.actual;
          correct += Number(result.correctCount || 0);
          total += Number(result.total || 0);
        });
        const percent = safePercent(correct, total);
        byId('grammar-result').innerHTML = `<h3>Результат: ${correct} из ${total}</h3><p class="muted">${percent}% правильных ответов</p>${percent === 100 ? '<p class="grammar-success-note">Отлично! Все ответы правильные. Тема отмечена как изученная.</p>' : '<p class="grammar-success-note">Есть ошибки. Исправь их и проверь упражнения ещё раз.</p>'}`;
        const latestProgress = window.ProgressService.loadGrammarProgress();
        const previous = latestProgress.topics[topic.id] || {};
        latestProgress.topics[topic.id] = {
          passed: Boolean(previous.passed || percent === 100),
          attempts: Number(previous.attempts || 0) + 1,
          bestScore: Math.max(Number(previous.bestScore || 0), percent),
          answers,
          updatedAt: new Date().toISOString()
        };
        window.ProgressService.saveGrammarProgress(latestProgress);

        if (percent === 100 && topic.lockOnPass === true) {
          setGrammarPracticeLocked(root, true);
          checkButton.disabled = true;
          retryButton.disabled = true;
          retryButton.hidden = true;
        }
      });

      retryButton.addEventListener('click', renderPractice);
    };

    renderPractice();
  }

  function renderGrammarTopic() {
    const id = queryParam('id');
    const topic = GRAMMAR_DATA.find((item) => item.id === id && item.status !== 'draft');
    const root = byId('grammar-topic-root');
    if (!topic || topic.status === 'locked') {
      root.innerHTML = emptyState('📐', 'Эта тема грамматики пока не опубликована', 'Материал появится после публикации преподавателем.');
      return;
    }

    byId('grammar-hero-title').textContent = safeText(topic.title, 'Грамматика');
    byId('grammar-hero-subtitle').textContent = `${safeText(topic.level, student.level)} уровень · объяснение и практика`;

    const glanceCards = Array.isArray(topic.glanceCards) ? topic.glanceCards : [];
    const anchorLinks = Array.isArray(topic.anchorLinks) ? topic.anchorLinks : [];
    const miniRules = Array.isArray(topic.miniRules) ? topic.miniRules : [];
    const tables = Array.isArray(topic.tables) ? topic.tables : (topic.table ? [topic.table] : []);
    const exampleGroups = Array.isArray(topic.exampleGroups) ? topic.exampleGroups : [];
    const examples = Array.isArray(topic.examples) ? topic.examples : [];
    const mistakes = Array.isArray(topic.commonMistakes) ? topic.commonMistakes : [];

    root.innerHTML = `
      <article class="card grammar-intro-card">
        <span class="eyebrow">Грамматика</span>
        <h2>${escapeHtml(topic.title)}</h2>
        <p class="muted grammar-lead">${escapeHtml(topic.explanation || '')}</p>
        ${topic.formula ? `<div class="grammar-formula-box"><strong>Краткая формула</strong><p>${escapeHtml(topic.formula)}</p></div>` : ''}
        ${anchorLinks.length ? `<div class="grammar-anchor-links">${anchorLinks.map((link) => `<a class="grammar-anchor-link" href="#${escapeHtml(link.id)}">${escapeHtml(link.title)}</a>`).join('')}</div>` : ''}
      </article>

      ${glanceCards.length ? `<section class="section" id="grammar-at-a-glance" aria-labelledby="grammar-at-a-glance-title"><div class="section-heading"><div><span class="eyebrow">Кратко</span><h2 id="grammar-at-a-glance-title">Как быстро выбрать правильную форму</h2></div></div><div class="grammar-glance-grid">${glanceCards.map((card) => `<article class="card grammar-glance-card"><div class="grammar-glance-head"><span class="grammar-glance-icon">${escapeHtml(card.icon || '✦')}</span><div><h3>${escapeHtml(card.label || '')}</h3><p class="muted">${escapeHtml(card.hint || '')}</p></div></div><div class="grammar-pattern">${escapeHtml(card.pattern || '')}</div><p class="grammar-example-sentence">${escapeHtml(card.example || '')}</p></article>`).join('')}</div></section>` : ''}

      ${miniRules.length ? `<section class="section" id="grammar-rule-map" aria-labelledby="grammar-rule-map-title"><div class="section-heading"><div><span class="eyebrow">Правила</span><h2 id="grammar-rule-map-title">Объяснение по шагам</h2></div></div><div class="grammar-mini-grid">${miniRules.map((rule) => `<article class="card grammar-mini-card"><h3>${escapeHtml(rule.title || '')}</h3><p>${escapeHtml(rule.text || '')}</p>${rule.example ? `<div class="grammar-mini-example">${escapeHtml(rule.example)}</div>` : ''}</article>`).join('')}</div></section>` : ''}

      ${tables.length ? `<section class="section" id="grammar-tables" aria-labelledby="grammar-tables-title"><div class="section-heading"><div><span class="eyebrow">Таблицы</span><h2 id="grammar-tables-title">Сравнение форм</h2></div></div><div class="list">${tables.map((table) => `<article class="card lesson-block"><h3>${escapeHtml(table.title || 'Таблица')}</h3>${grammarTable(table)}</article>`).join('')}</div></section>` : ''}

      ${exampleGroups.length || examples.length ? `<section class="section" id="grammar-examples" aria-labelledby="grammar-examples-title"><div class="section-heading"><div><span class="eyebrow">Примеры</span><h2 id="grammar-examples-title">Примеры в контексте</h2></div></div><div class="list">${exampleGroups.map((group) => `<article class="card lesson-block grammar-example-group"><h3>${escapeHtml(group.title || 'Примеры')}</h3><div class="list">${(group.items || []).map((item) => `<p class="grammar-example-item">• ${escapeHtml(item)}</p>`).join('')}</div></article>`).join('')}${examples.length ? `<article class="card lesson-block grammar-example-group"><h3>Ещё примеры</h3><div class="list">${examples.map((example) => `<p class="grammar-example-item">• ${escapeHtml(example)}</p>`).join('')}</div></article>` : ''}</div></section>` : ''}

      ${mistakes.length ? `<section class="section" id="grammar-mistakes" aria-labelledby="grammar-mistakes-title"><div class="section-heading"><div><span class="eyebrow">Важно</span><h2 id="grammar-mistakes-title">Частые ошибки</h2></div></div><article class="card info-card lesson-block"><div class="list">${mistakes.map((mistake) => `<p>• ${escapeHtml(mistake)}</p>`).join('')}</div></article></section>` : ''}

      <section class="section" id="grammar-practice-section" aria-labelledby="grammar-practice-title"><div class="section-heading"><div><span class="eyebrow">Практика</span><h2 id="grammar-practice-title">${Array.isArray(topic.exercises) ? topic.exercises.length : 0} упражнения: от простого к сложному</h2></div></div><div id="grammar-quiz"></div></section>
    `;

    renderGrammarPractice(topic, byId('grammar-quiz'));
  }


  function getTopicProgress(progress, topicId) {
    if (!progress.topics[topicId]) progress.topics[topicId] = { tests: [] };
    if (!Array.isArray(progress.topics[topicId].tests)) progress.topics[topicId].tests = [];
    return progress.topics[topicId];
  }

  function setWordStatus(progress, word, topicId, status) {
    const now = new Date().toISOString();
    const previous = progress.words[word.__wordKey] || {};
    progress.words[word.__wordKey] = {
      status,
      topicId: previous.topicId || topicId,
      learnedAt: status === 'known' ? (previous.learnedAt || now) : null,
      updatedAt: now
    };
  }

  function renderVocabulary() {
    const id = queryParam('id');
    const topic = VOCABULARY_CATALOG.allTopics.find((item) => item.id === id);
    const root = byId('vocabulary-root');
    if (!topic || !Array.isArray(topic.words) || !topic.words.length) {
      root.innerHTML = emptyState('💥', 'No words have been added to this topic yet', 'The teacher will add the word list after the lesson. Words from earlier topics are not repeated here.');
      return;
    }
    byId('vocab-hero-title').textContent = safeText(topic.title, 'Vocabulary');
    byId('vocab-hero-subtitle').textContent = `${safeText(topic.label, 'Vocabulary topic')} · ${topic.words.length} unique words`;
    const progress = window.ProgressService.loadVocabularyProgress();
    const topicProgress = getTopicProgress(progress, topic.id);
    let mode = 'cards';
    let cardQueue = [];
    let testState = null;

    root.innerHTML = `<div class="mode-tabs" id="vocab-modes" aria-label="Practice mode">
      <button class="mode-btn active" type="button" data-mode="cards">New words</button>
      <button class="mode-btn" type="button" data-mode="test">Test</button>
      <button class="mode-btn" type="button" data-mode="all">All words</button>
      <button class="mode-btn" type="button" data-mode="difficult">Difficult words</button>
    </div><div id="vocab-mode-root" class="section"></div>`;
    const modeRoot = byId('vocab-mode-root');

    const save = () => window.ProgressService.saveVocabularyProgress(progress);
    const resetCardQueue = () => {
      cardQueue = shuffled(topic.words.filter((word) => {
        const status = progress.words[word.__wordKey]?.status;
        return mode === 'difficult'
          ? status === 'difficult'
          : !['known', 'reviewed', 'difficult'].includes(status);
      }));
    };

    const drawCard = () => {
      if (!cardQueue.length) {
        const isDifficult = mode === 'difficult';
        modeRoot.innerHTML = emptyState(
          isDifficult ? '🌟' : '🎉',
          isDifficult ? 'No difficult words yet' : 'You have reviewed all new words in this topic',
          isDifficult ? 'Mark a word as “Difficult” and it will appear here.' : 'A word is marked as learned only after a correct answer in the test.'
        );
        return;
      }
      const word = cardQueue[0];
      const remaining = cardQueue.length;
      modeRoot.innerHTML = `<div class="flash-counter">Remaining: ${remaining}</div><div class="flashcard-stage"><div class="flashcard" id="flashcard" tabindex="0" role="button" aria-label="Flip the card">
        <div class="flash-face flash-front"><div class="flash-word">${escapeHtml(word.en)}</div>${word.transcription ? `<div class="flash-transcription">${escapeHtml(word.transcription)}</div>` : ''}<p class="muted">Tap to see the translation</p></div>
        <div class="flash-face flash-back"><div class="flash-word">${escapeHtml(word.ru)}</div>${word.exampleEn ? `<p class="flash-example">${escapeHtml(word.exampleEn)}${word.exampleRu ? `<br>${escapeHtml(word.exampleRu)}` : ''}</p>` : ''}</div>
      </div></div><div class="trainer-actions"><button class="btn btn-danger" id="word-difficult" type="button">Difficult</button><button class="btn btn-success" id="word-known" type="button">Reviewed</button></div>`;
      const flashcard = byId('flashcard');
      const flip = () => flashcard.classList.toggle('flipped');
      flashcard.addEventListener('click', flip);
      flashcard.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); flip(); } });
      byId('word-known').addEventListener('click', () => {
        setWordStatus(progress, word, topic.id, 'reviewed');
        cardQueue.shift();
        save();
        drawCard();
      });
      byId('word-difficult').addEventListener('click', () => {
        setWordStatus(progress, word, topic.id, 'difficult');
        cardQueue.shift();
        save();
        drawCard();
      });
    };

    const startTest = () => {
      if (topic.words.length < 4) {
        modeRoot.innerHTML = emptyState('🧩', 'At least 4 words are needed for the test', 'Add more unique words to the topic to create four answer options.');
        return;
      }
      testState = { words: shuffled(topic.words), index: 0, firstTryCorrect: 0, answered: false, firstAnswers: {} };
      drawQuestion();
    };

    const finishTest = () => {
      const result = {
        score: testState.firstTryCorrect,
        total: testState.words.length,
        percent: safePercent(testState.firstTryCorrect, testState.words.length),
        answers: testState.firstAnswers,
        completedAt: new Date().toISOString()
      };
      topicProgress.tests.push(result);
      save();
      modeRoot.innerHTML = `<div class="card empty-state"><div class="empty-state-icon">🏁</div><h3>Test complete</h3><p>First-try score: ${result.score} of ${result.total}</p><div class="button-row" style="justify-content:center"><button class="btn btn-primary" id="restart-vocab-test" type="button">Try again</button></div></div>`;
      byId('restart-vocab-test').addEventListener('click', startTest);
    };

    const drawQuestion = () => {
      if (testState.index >= testState.words.length) { finishTest(); return; }
      const word = testState.words[testState.index];
      const distractors = shuffled(topic.words.filter((item) => item.__wordKey !== word.__wordKey)).slice(0, 3);
      const options = shuffled([word, ...distractors]);
      testState.answered = false;
      modeRoot.innerHTML = `<div class="flash-counter">Question ${testState.index + 1} of ${testState.words.length}</div><article class="card"><span class="eyebrow">Choose the translation</span><h2 class="flash-word">${escapeHtml(word.en)}</h2>${word.transcription ? `<p class="muted">${escapeHtml(word.transcription)}</p>` : ''}<div class="option-list section">${options.map((option) => `<button class="quiz-option" type="button" data-answer-key="${escapeHtml(option.__wordKey)}">${escapeHtml(option.ru)}</button>`).join('')}</div><div id="vocab-test-feedback" class="feedback"></div><div class="button-row"><button class="btn btn-primary" id="next-vocab-question" type="button" disabled>Next word</button></div></article>`;
      modeRoot.querySelectorAll('[data-answer-key]').forEach((button) => {
        button.addEventListener('click', () => {
          if (testState.answered) return;
          testState.answered = true;
          const correct = button.dataset.answerKey === word.__wordKey;
          testState.firstAnswers[word.__wordKey] = { correct, selected: button.dataset.answerKey };
          if (correct) {
            testState.firstTryCorrect += 1;
            setWordStatus(progress, word, topic.id, 'known');
          } else {
            setWordStatus(progress, word, topic.id, 'difficult');
          }
          save();
          modeRoot.querySelectorAll('[data-answer-key]').forEach((optionButton) => {
            optionButton.disabled = true;
            if (optionButton.dataset.answerKey === word.__wordKey) optionButton.classList.add('correct');
          });
          if (!correct) button.classList.add('wrong');
          const feedback = byId('vocab-test-feedback');
          feedback.className = `feedback show ${correct ? 'good' : 'bad'}`;
          feedback.textContent = correct ? 'Correct on the first try!' : `Correct answer: ${word.ru}`;
          byId('next-vocab-question').disabled = false;
        });
      });
      byId('next-vocab-question').addEventListener('click', () => { testState.index += 1; drawQuestion(); });
    };

    const drawAllWords = () => {
      modeRoot.innerHTML = `<div class="words-grid">${topic.words.map((word) => {
        const status = progress.words[word.__wordKey]?.status;
        return `<article class="card word-card ${status === 'known' ? 'known' : ''} ${status === 'difficult' ? 'difficult' : ''}"><strong>${escapeHtml(word.en)}</strong><span>${escapeHtml(word.ru)}</span>${word.transcription ? `<span>${escapeHtml(word.transcription)}</span>` : ''}</article>`;
      }).join('')}</div>`;
    };

    const drawMode = () => {
      if (mode === 'cards' || mode === 'difficult') {
        resetCardQueue();
        drawCard();
      } else if (mode === 'test') startTest();
      else drawAllWords();
    };
    byId('vocab-modes').addEventListener('click', (event) => {
      const button = event.target.closest('[data-mode]');
      if (!button) return;
      mode = button.dataset.mode;
      byId('vocab-modes').querySelectorAll('[data-mode]').forEach((item) => item.classList.toggle('active', item === button));
      drawMode();
    });
    drawMode();
  }

  async function refreshCurrentView() {
    const view = document.body.dataset.view;
    const renderers = {
      home: renderHome,
      homework: renderHomework,
      grammar: renderGrammar,
      'vocabulary-hub': renderVocabularyHub,
      lesson: renderLesson,
      'grammar-topic': renderGrammarTopic,
      vocabulary: renderVocabulary
    };
    try {
      await renderers[view]?.();
    } catch (error) {
      console.error('Page rendering error:', error);
      const main = document.querySelector('main');
      if (main) main.innerHTML = emptyState('⚠️', 'Could not open the page', 'Check the data structure and refresh the page.');
    }
  }

  async function init() {
    fillConfig();
    markNavigation();
    try {
      await loadHomeworkData();
    } catch (error) {
      console.error('Lesson catalogue loading error:', error);
      HOMEWORK_DATA = [];
      window.HOMEWORK_DATA = HOMEWORK_DATA;
    }
    await refreshCurrentView();
    if (!CloudService.isConfigured()) return;
    try {
      await CloudService.init();
      await window.ProgressService.syncFromCloud();
      await refreshCurrentView();
    } catch (error) {
      console.error('Supabase connection error:', error);
      const detail = safeText(error?.message || error?.details || error?.hint);
      showToast(detail ? `Supabase error: ${detail}` : 'Supabase is temporarily unavailable.');
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
