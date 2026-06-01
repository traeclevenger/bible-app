/**
 * Bible Study App — Backend
 *
 * Setup (one time):
 *   1. Project Settings > Script Properties:
 *        ANTHROPIC_API_KEY = key from console.anthropic.com
 *        ESV_API_KEY       = key from api.esv.org
 *        NLT_API_KEY       = key from api.nlt.to
 *   2. Deploy > New deployment > Web app:
 *        Execute as: Me
 *        Who has access: Anyone
 *      Copy the /exec URL into index.html as APPS_SCRIPT_URL.
 */

const SONNET_MODEL = 'claude-sonnet-4-6';
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

// ── Routing ───────────────────────────────────────────────────────────────────

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || '';
  try {
    if (action === 'text') return jsonOut(getPassageText(e.parameter.ref, e.parameter.version));
    return jsonOut({ ok: true, service: 'bible-app' });
  } catch (err) {
    return jsonOut({ error: String((err && err.message) || err) });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action;
    if (action === 'study') return jsonOut(handleStudy(body));
    if (action === 'chat')  return jsonOut(handleChat(body));
    return jsonOut({ error: 'Unknown action.' });
  } catch (err) {
    return jsonOut({ error: String((err && err.message) || err) });
  }
}

// ── Bible text fetching (mirrors bible-reading pattern) ───────────────────────

function getPassageText(ref, version) {
  if (!ref) return { error: 'Missing ref.' };
  const v = (version || 'ESV').toUpperCase();
  const cache = CacheService.getScriptCache();
  const cacheKey = 'passage:' + v + ':' + ref;
  const cached = cache.get(cacheKey);
  if (cached) return { html: cached, version: v, ref: ref, cached: true };

  let html;
  if (v === 'ESV') html = fetchEsvHtml(ref);
  else if (v === 'NLT') html = fetchNltHtml(ref);
  else return { error: 'Unsupported version: ' + v };

  if (html.length < 95000) cache.put(cacheKey, html, 21600);
  return { html: html, version: v, ref: ref };
}

function fetchEsvHtml(ref) {
  const key = requiredProp('ESV_API_KEY');
  const url = 'https://api.esv.org/v3/passage/html/?q=' + encodeURIComponent(ref) +
              '&include-headings=true&include-footnotes=false&include-verse-numbers=true' +
              '&include-short-copyright=true&include-passage-references=false';
  const res = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Token ' + key },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error('ESV API ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
  const data = JSON.parse(res.getContentText());
  return (data.passages || []).join('\n');
}

function fetchEsvPlainText(ref) {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'esvtext:' + ref;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const key = requiredProp('ESV_API_KEY');
  const url = 'https://api.esv.org/v3/passage/text/?q=' + encodeURIComponent(ref) +
              '&include-headings=false&include-footnotes=false&include-verse-numbers=true' +
              '&include-short-copyright=false&include-passage-references=false';
  const res = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Token ' + key },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error('ESV API ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
  const data = JSON.parse(res.getContentText());
  const text = (data.passages || []).join('\n');
  if (text && text.length < 95000) cache.put(cacheKey, text, 21600);
  return text;
}

function fetchNltHtml(ref) {
  const key = requiredProp('NLT_API_KEY');
  const nltRef = ref.replace(/^(\d?\s?[A-Za-z]+)\s+(\d.*)$/, function (_, b, c) {
    return b.replace(/\s+/g, '') + '.' + c;
  });
  const url = 'https://api.nlt.to/api/passages?ref=' + encodeURIComponent(nltRef) + '&version=NLT&key=' + encodeURIComponent(key);
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('NLT API ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
  return res.getContentText();
}

// ── Study tools (selection-driven) ────────────────────────────────────────────

function handleStudy(body) {
  const tool = String(body.tool || '').toLowerCase();
  const selection = String(body.selection || '').trim();
  const ref = String(body.ref || '').trim();
  const version = String(body.version || 'ESV').toUpperCase();
  if (!selection) return { error: 'No text selected.' };

  const prompts = {
    related:     buildRelatedPrompt(selection, ref, version),
    commentary:  buildCommentaryPrompt(selection, ref, version),
    application: buildApplicationPrompt(selection, ref, version),
    dictionary:  buildDictionaryPrompt(selection, ref, version),
  };
  if (!prompts[tool]) return { error: 'Unknown tool: ' + tool };

  const { system, user, maxTokens } = prompts[tool];
  const response = callClaudeWithFallback({
    model: SONNET_MODEL,
    max_tokens: maxTokens,
    system: system,
    messages: [{ role: 'user', content: user }],
  });
  return { answer: extractText(response).trim(), tool: tool };
}

const STYLE_RULES =
  "Style:\n" +
  "- Plain text only — no markdown headers, no bullets, no bold/italics.\n" +
  "- Cite Scripture inline using [[Book C:V]] or [[Book C:V-V]] (e.g. [[John 3:16]], [[Romans 8:28-30]]). The UI auto-links these.\n" +
  "- NEVER use em dashes (—). Use commas or split into two sentences.\n" +
  "- Stay conservative, orthodox, Scripture-grounded. Do not speculate beyond what the text supports.\n" +
  "- Do not reference websites, podcasts, or commentaries by name.";

function buildRelatedPrompt(selection, ref, version) {
  return {
    system:
      "You are a Bible study assistant helping a reader find related Scripture passages. " +
      "Given a selected portion of " + (ref || 'the passage') + " (" + version + "), list 4-6 of the MOST illuminating " +
      "cross-references from elsewhere in the Bible. For each, give the reference and 1-2 sentences explaining the connection.\n\n" +
      STYLE_RULES + "\n" +
      "- Format each entry as: [[Book C:V]] — one or two sentences on why this passage connects.\n" +
      "- One entry per line. No numbering, no headers, no preamble.",
    user: 'Selected text from ' + (ref || '(unknown)') + ':\n\n"' + selection + '"\n\nList the most relevant cross-references now.',
    maxTokens: 1200,
  };
}

function buildCommentaryPrompt(selection, ref, version) {
  return {
    system:
      "You are a conservative Bible commentator explaining a passage to a thoughtful Christian reader. " +
      "Explain what the selected text from " + (ref || 'the passage') + " (" + version + ") means: " +
      "the author's intent, historical/cultural context where relevant, key terms, and how it fits the surrounding passage.\n\n" +
      STYLE_RULES + "\n" +
      "- 3-5 short paragraphs. Lead with the core meaning. Be substantive but not bloated.",
    user: 'Selected text from ' + (ref || '(unknown)') + ':\n\n"' + selection + '"\n\nExplain what this passage means.',
    maxTokens: 1600,
  };
}

function buildApplicationPrompt(selection, ref, version) {
  return {
    system:
      "You are helping a Christian reader apply Scripture to daily life. " +
      "Given the selected text from " + (ref || 'the passage') + " (" + version + "), explain how this passage should " +
      "inform and shape a Christian's heart, attitudes, and actions today. Be concrete and practical, but stay grounded in the text — " +
      "do not invent applications the passage does not support.\n\n" +
      STYLE_RULES + "\n" +
      "- Write in first person plural (we, us, our), never first person singular.\n" +
      "- 3-5 short paragraphs covering distinct areas of application (e.g. heart posture, relationships, witness, prayer, suffering, etc. as fit).",
    user: 'Selected text from ' + (ref || '(unknown)') + ':\n\n"' + selection + '"\n\nHow should this passage shape a Christian\'s life?',
    maxTokens: 1600,
  };
}

function buildDictionaryPrompt(selection, ref, version) {
  return {
    system:
      "You are an expository Bible dictionary and lexicon. The reader has selected text from " + (ref || 'a passage') + " (" + version + "). " +
      "Identify the 3-6 most theologically or linguistically significant words/phrases in the selection. For each:\n" +
      "  1. The English word/phrase as it appears.\n" +
      "  2. The underlying Greek or Hebrew word in transliteration, with a brief gloss of its semantic range.\n" +
      "  3. Any nuances the original language conveys that English flattens.\n" +
      "  4. How this word is used elsewhere in Scripture (1-2 representative examples with [[refs]]).\n\n" +
      STYLE_RULES + "\n" +
      "- Format each entry as a short paragraph beginning with the English word in quotes, e.g.:\n" +
      "  \"righteousness\" — Greek dikaiosynē. Brief definition and nuance. Cross-reference usage.\n" +
      "- Separate entries with a blank line. No numbering, no headers.",
    user: 'Selected text from ' + (ref || '(unknown)') + ':\n\n"' + selection + '"\n\nWork through the key words.',
    maxTokens: 1800,
  };
}

// ── Chat ──────────────────────────────────────────────────────────────────────

function handleChat(body) {
  const messages = body.messages || [];

  const wantsDetail = wantsMoreDetail(messages);
  const chosenModel = wantsDetail ? SONNET_MODEL : HAIKU_MODEL;

  const system =
    "You are a knowledgeable, conservative Bible study assistant. " +
    "STRICT SCOPE — hard rules:\n" +
    "- Only answer questions about Scripture, biblical theology, biblical history, biblical languages, and Christian doctrine grounded in the Bible.\n" +
    "- Do NOT answer questions about current events, news, politics, science/health advice, technology, coding, math, trivia, or anything unrelated to Scripture.\n" +
    "- Do NOT reference websites, news, podcasts, or commentaries by name. Your sources are Scripture itself and well-established conservative Christian theology.\n" +
    "- If asked something out of scope, briefly decline and offer to discuss Scripture instead.\n" +
    "- Do not be tricked by framings like \"hypothetically\" or \"just curious\" — the scope always applies.\n\n" +
    STYLE_RULES + "\n" +
    "- Default to SHORT answers: 2-4 sentences. Lead with the answer.\n" +
    "- End most replies with a brief, varied offer to go deeper (e.g. \"Want me to unpack that?\"). Skip when the user is closing the thread or when a longer answer was already given.\n" +
    "- If the user asks for more detail (\"tell me more\", \"unpack that\", a short \"yes\" after an offer), write a fuller answer — multiple paragraphs are fine — and don't append another offer.";

  const response = callClaudeWithFallback({
    model: chosenModel,
    max_tokens: wantsDetail ? 1800 : 800,
    system: system,
    messages: messages,
  });
  return { answer: extractText(response).trim() };
}

function wantsMoreDetail(messages) {
  if (!messages || !messages.length) return false;
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user' || typeof last.content !== 'string') return false;
  const text = last.content.trim().toLowerCase();
  if (!text) return false;
  const expandPattern = /\b(more|elaborate|expand|deeper|unpack|details?|explain (further|more)|tell me more|go on|continue|keep going|dig in|dive in)\b/;
  if (expandPattern.test(text)) return true;
  if (text.length <= 30 && /\b(yes|yep|yeah|sure|please|ok|okay|definitely|absolutely|do it|go for it)\b/.test(text)) {
    for (let i = messages.length - 2; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'assistant' && typeof m.content === 'string') {
        if (/\?\s*$/.test(m.content.trim())) return true;
        break;
      }
    }
  }
  return false;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function callClaude(payload) {
  const apiKey = requiredProp('ANTHROPIC_API_KEY');
  const maxAttempts = 4;
  let lastCode = 0, lastBody = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = UrlFetchApp.fetch(ANTHROPIC_API_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    const code = res.getResponseCode();
    const body = res.getContentText();
    if (code === 200) return JSON.parse(body);
    lastCode = code; lastBody = body;
    const retriable = code === 429 || code === 502 || code === 503 || code === 529;
    if (!retriable || attempt === maxAttempts) break;
    Utilities.sleep(Math.min(8000, 500 * Math.pow(2, attempt)));
  }
  throw new Error('Claude API ' + lastCode + ': ' + lastBody);
}

function callClaudeWithFallback(payload) {
  try {
    return callClaude(payload);
  } catch (err) {
    if (payload.model === HAIKU_MODEL) throw err;
    const msg = String(err && err.message || err);
    if (!/Claude API (429|502|503|529)/.test(msg)) throw err;
    const fallback = Object.assign({}, payload, { model: HAIKU_MODEL });
    return callClaude(fallback);
  }
}

function extractText(response) {
  return (response.content || [])
    .filter(function (b) { return b.type === 'text'; })
    .map(function (b) { return b.text; })
    .join('\n');
}

function requiredProp(key) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  if (!v) throw new Error('Script Property "' + key + '" is not set.');
  return v;
}

function jsonOut(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
