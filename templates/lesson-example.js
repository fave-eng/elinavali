/**
 * TECHNICAL EXAMPLE. This file is not loaded by the student site.
 * Copy the object into the lesson data and replace the demo fields
 * with the teacher’s materials.
 */
window.LESSON_TECHNICAL_EXAMPLE = {
  id: "lesson-example",
  number: 1,
  title: "Lesson title",
  subtitle: "Short description",
  status: "draft",
  page: "lesson.html?id=lesson-example",
  vocabularyId: "vocab-lesson-example",
  publishedAt: "2026-01-01",
  totalPoints: 10,
  blocks: [
    { type: "info", title: "Information", text: "Teacher’s text." },
    { type: "tip", title: "Tip", text: "Short tip." },
    { type: "text", id: "task-text", prompt: "Enter your answer", answer: "" },
    { type: "textarea", id: "task-long", prompt: "Write a detailed answer", answer: "" },
    { type: "single", id: "task-single", prompt: "Choose one option", options: ["Option A", "Option B"], answer: 0 },
    { type: "multiple", id: "task-multiple", prompt: "Choose several options", options: ["Option A", "Option B"], answer: [0] },
    { type: "select", id: "task-select", prompt: "Choose an option", options: ["Option A", "Option B"], answer: 0 },
    { type: "match", id: "task-match", prompt: "Match the pairs", pairs: [{ left: "A", right: "1" }] },
    { type: "reorder", id: "task-reorder", prompt: "Put the words in order", words: ["word", "order"], answer: "word order" },
    { type: "translate", id: "task-translate", prompt: "Translate the sentence", source: "Text to translate", answer: "" },
    { type: "audio", id: "task-audio", prompt: "Listen to the recording", audio: "audio/example.mp3", answer: "" },
    { type: "reading", id: "task-reading", title: "Reading", text: "Reading text.", questions: [] }
  ]
};
