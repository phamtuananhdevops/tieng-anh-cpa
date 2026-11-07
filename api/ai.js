// api/ai.js — Đầu mối AI chung cho Tiếng Anh CPA 2026 (Vercel Serverless Function)

// Chỉ nhận POST. Hai loại yêu cầu:

//   { "ping": true }  → kiểm tra trạng thái: { ok, connected, provider }

//   { "text": "...", "system": "...", "context": "...", "messages": [...] }
//                     → trả { ok, provider, text }

// Khóa đọc từ Environment Variables phía server:

//   ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY / MUSE_API_KEY

//   OpenAI_KEY được chấp nhận làm khóa OpenAI dự phòng (OPENAI_API_KEY ưu tiên).

//   AI_KEY được chấp nhận làm khóa Gemini dự phòng.

//   AI_MODEL (tùy chọn) ghi đè model; khi không đặt AI_MODEL, nhánh Gemini tự
//   thử lần lượt: gemini-3.1-pro-preview → gemini-3.8-flash;
//   mặc định Muse (Meta Model API): muse-spark-1.3.

// Tự động chuyển tiếp (fallback) sang provider/model tiếp theo khi gặp lỗi
// hết quota, rate limit, model không khả dụng hoặc lỗi quá tải dịch vụ
// (mã 429/503, "high demand", "overloaded", "try again later", ...).

const DEFAULT_SYSTEM = [

  "Bạn là gia sư ôn thi CPA Việt Nam 2026, môn Ngoại ngữ (Tiếng Anh, Chuyên đề 7).",

  "Trả lời dựa trên nội dung trang học (khung chương trình: 63 chức năng ngôn ngữ, 15 chủ điểm ngữ pháp, dạng thức đề trình độ C, từ vựng chuyên ngành kế toán–kiểm toán–thuế–tài chính) được gửi kèm trong ngữ cảnh.",

  "Giải thích từng bước bằng tiếng Việt, kèm ví dụ tiếng Anh: xác định dạng bài (điền từ / đọc hiểu / biến đổi dạng từ / dựng câu / viết lại câu / dịch Anh–Việt và Việt–Anh), nêu quy tắc ngữ pháp áp dụng, rồi cho đáp án và giải thích vì sao đúng.",

  "Kỳ thi: Chủ nhật 6/12/2026, 14:00–16:00, thi viết 120 phút, chỉ 2 kỹ năng Đọc–Viết (không nghe, không nói). Môn điều kiện, không tính vào tổng điểm 6 môn chuyên môn (theo quy định/thông báo — nguồn thứ cấp). LƯU Ý THANG ĐIỂM MÂU THUẪN TRONG KHUNG: Phần IV ghi 100 điểm, bảng dạng thức Phần VI cộng lại 80 điểm (Reading 40 + Writing 40), đáp án mẫu đề tính 100 điểm với trọng số khác — khi nói về điểm, trình bày cả hai con số kèm ghi chú mâu thuẫn chưa rõ, không tự chốt một số.",

  "LƯU Ý PHÂN BIỆT: đây là tiếng Anh trình độ C cho kỳ thi CPA — phần dịch đậm chuyên ngành kiểm toán/kế toán (báo cáo tài chính, kiểm soát nội bộ, chuẩn mực kiểm toán), còn bài đọc phần lớn là chủ đề đời sống chung. Khi chữa đề cũ, dùng đúng đề và đáp án của đề đó; không có đáp án chính thức cho đề thật các năm — đáp án tham khảo phải ghi rõ là tham khảo, không khẳng định là đáp án chính thức.",

  "Không bịa số liệu, đáp án hay lịch thi chưa xác minh.",

  "Nếu câu hỏi vượt ngoài nội dung trang, nói rõ giới hạn của mình thay vì bịa thêm.",

    "Hướng dẫn tư duy: đừng chỉ đưa đáp án — hãy dẫn dắt học viên theo chuỗi Công thức/Quy định → Bản chất kinh tế → Phân tích nguyên nhân → Mối quan hệ nhân quả → Giải pháp → Bài tập; hỏi lại xem nhân tố nào đang đổi, tách nguyên nhân rồi mới chốt lời giải kèm rủi ro."
].join("\n");


function listProviders() {
  const chain = [];

  if (process.env.ANTHROPIC_API_KEY) chain.push({ name: "anthropic", key: process.env.ANTHROPIC_API_KEY });

  const o = process.env.OPENAI_API_KEY || process.env.OpenAI_KEY;
  if (o) chain.push({ name: "openai", key: o });

  const g = process.env.GEMINI_API_KEY || process.env.AI_KEY;
  if (g) chain.push({ name: "gemini", key: g });

  if (process.env.MUSE_API_KEY) chain.push({ name: "muse", key: process.env.MUSE_API_KEY });

  return chain;
}


function providerError(r, data, fallbackMsg) {
  const err = new Error((data && data.error && data.error.message) || fallbackMsg);
  err.status = r.status;
  return err;
}

// Lỗi được phép chuyển sang provider tiếp theo: hết quota / bị giới hạn tần
// suất, lỗi quá tải dịch vụ (mã 429/503 hoặc các cụm "high demand",
// "overloaded", "try again later", ...), hoặc model không khả dụng
// (kể cả model đã bị khai tử / "no longer available").
// Các lỗi khác giữ nguyên cách xử lý cũ.
function isFallbackError(err) {
  if (!err) return false;

  if (err.status === 429 || err.status === 503) return true;

  const msg = String(err.message || "").toLowerCase();

  if (msg.indexOf("quota") !== -1) return true;

  if (msg.indexOf("rate limit") !== -1 || msg.indexOf("rate_limit") !== -1 ||
      msg.indexOf("too many requests") !== -1) return true;

  if (msg.indexOf("high demand") !== -1 || msg.indexOf("overloaded") !== -1 ||
      msg.indexOf("overload") !== -1 || msg.indexOf("capacity") !== -1 ||
      msg.indexOf("currently experiencing") !== -1 || msg.indexOf("spikes in demand") !== -1 ||
      msg.indexOf("try again later") !== -1 || msg.indexOf("service unavailable") !== -1) return true;

  if (msg.indexOf("model") !== -1 &&
      (msg.indexOf("not found") !== -1 || msg.indexOf("not_found") !== -1 ||
       msg.indexOf("unavailable") !== -1 || msg.indexOf("not available") !== -1 ||
       msg.indexOf("no longer available") !== -1 || msg.indexOf("unsupported") !== -1 ||
       msg.indexOf("does not exist") !== -1)) return true;

  return false;
}


async function callAnthropic(key, model, system, messages) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: model || "claude-sonnet-4-5",
      max_tokens: 1500,
      system: system,
      messages: messages
    })
  });

  const data = await r.json();

  if (!r.ok) throw providerError(r, data, "Anthropic error");

  return (data.content || []).filter(function (b) { return b.type === "text"; })
    .map(function (b) { return b.text; }).join("\n");
}


async function callOpenAI(key, model, system, messages) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + key },
    body: JSON.stringify({
      model: model || "gpt-4o",
      messages: [{ role: "system", content: system }].concat(messages),
      max_tokens: 1500
    })
  });

  const data = await r.json();

  if (!r.ok) throw providerError(r, data, "OpenAI error");

  return data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content : "";
}


// Fallback nhiều model cho nhánh Gemini: thử lần lượt từng model theo thứ tự
// ưu tiên. Khi gặp lỗi hết quota / rate limit (429, quota exceeded,
// too many requests), lỗi quá tải dịch vụ (mã 429/503 hoặc các cụm
// "high demand", "overloaded", "try again later", ...) hoặc model không
// khả dụng (kể cả model đã bị khai tử / "no longer available") thì tự
// chuyển sang model tiếp theo trong danh sách.
// Các lỗi khác giữ nguyên cách xử lý hiện có.
const GEMINI_MODEL_FALLBACKS = ["gemini-3.1-pro-preview", "gemini-3.8-flash"];

function isGeminiModelRetryError(err) {
  if (!err) return false;

  if (err.status === 429 || err.status === 503) return true;

  const msg = String(err.message || "").toLowerCase();

  if (msg.indexOf("quota") !== -1) return true;

  if (msg.indexOf("rate limit") !== -1 || msg.indexOf("rate_limit") !== -1 ||
      msg.indexOf("too many requests") !== -1 || msg.indexOf("resource exhausted") !== -1) return true;

  if (msg.indexOf("high demand") !== -1 || msg.indexOf("overloaded") !== -1 ||
      msg.indexOf("overload") !== -1 || msg.indexOf("capacity") !== -1 ||
      msg.indexOf("currently experiencing") !== -1 || msg.indexOf("spikes in demand") !== -1 ||
      msg.indexOf("try again later") !== -1 || msg.indexOf("service unavailable") !== -1) return true;

  if (msg.indexOf("model") !== -1 &&
      (msg.indexOf("not found") !== -1 || msg.indexOf("not_found") !== -1 ||
       msg.indexOf("unavailable") !== -1 || msg.indexOf("not available") !== -1 ||
       msg.indexOf("no longer available") !== -1 || msg.indexOf("unsupported") !== -1 ||
       msg.indexOf("does not exist") !== -1)) return true;

  return false;
}


async function callGeminiOnce(key, model, system, messages) {
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" +
    (model || "gemini-3.1-pro-preview") + ":generateContent?key=" + encodeURIComponent(key);

  const contents = messages.map(function (m) {
    return { role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] };
  });

  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: contents,
      generationConfig: { maxOutputTokens: 1500 }
    })
  });

  const data = await r.json();

  if (!r.ok) throw providerError(r, data, "Gemini error");

  const parts = data.candidates && data.candidates[0] && data.candidates[0].content
    ? (data.candidates[0].content.parts || []) : [];

  return parts.map(function (p) { return p.text || ""; }).join("\n");
}


// Nhánh Gemini: khi không có AI_MODEL override, thử lần lượt các model trong
// GEMINI_MODEL_FALLBACKS; model nào hết quota / không khả dụng / quá tải thì
// chuyển tiếp.
async function callGemini(key, model, system, messages) {
  const models = model ? [model] : GEMINI_MODEL_FALLBACKS;
  let lastErr = null;

  for (let i = 0; i < models.length; i++) {
    try {
      return await callGeminiOnce(key, models[i], system, messages);
    } catch (err) {
      lastErr = err;

      if (!isGeminiModelRetryError(err)) throw err;
    }
  }

  throw lastErr;
}


async function callMuse(key, model, system, messages) {
  const r = await fetch("https://api.meta.ai/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + key },
    body: JSON.stringify({
      model: model || "muse-spark-1.3",
      messages: [{ role: "system", content: system }].concat(messages),
      max_tokens: 1500
    })
  });

  const data = await r.json();

  if (!r.ok) throw providerError(r, data, "Muse error");

  return data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content : "";
}


async function callProvider(provider, model, system, messages) {
  if (provider.name === "anthropic") return callAnthropic(provider.key, model, system, messages);

  if (provider.name === "openai") return callOpenAI(provider.key, model, system, messages);

  if (provider.name === "muse") return callMuse(provider.key, model, system, messages);

  return callGemini(provider.key, model, system, messages);
}


module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed — chỉ nhận POST." });
    return;
  }

  let body = req.body || {};

  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }

  const chain = listProviders();

  if (body.ping) {
    res.status(200).json({ ok: true, connected: chain.length > 0, provider: chain.length ? chain[0].name : null });
    return;
  }

  if (!chain.length) {
    res.status(503).json({ ok: false, error: "AI chưa được nối: server chưa có API key (ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY / AI_KEY / MUSE_API_KEY)." });
    return;
  }

  let messages = Array.isArray(body.messages)
    ? body.messages.filter(function (m) { return m && m.content; }) : [];

  const q = body.text || body.message || body.question || body.prompt;
    if (!messages.length && q) messages = [{ role: "user", content: String(q) }];

  if (!messages.length) {
    res.status(400).json({ ok: false, error: "Thiếu nội dung: gửi 'text' hoặc 'messages'." });
    return;
  }

  messages = messages.slice(-12).map(function (m) {
    return { role: m.role === "assistant" ? "assistant" : "user", content: String(m.content) };
  });

  const system = (body.system ? String(body.system) : DEFAULT_SYSTEM) +
    (body.context ? "\n\nNGỮ CẢNH — NỘI DUNG TRANG HỌC:\n" + String(body.context) : "");

  const model = process.env.AI_MODEL || null;

  // Thử các provider đã cấu hình theo thứ tự; khi một provider trả lỗi
  // quota/rate-limit, lỗi quá tải dịch vụ, hoặc model không khả dụng thì tự
  // chuyển sang provider tiếp theo. Riêng nhánh Gemini tự thử lần lượt các model
  // (gemini-3.1-pro-preview → gemini-3.8-flash) trước khi
  // nhường cho provider tiếp theo. Nếu MUSE_API_KEY chưa được cấu hình, nhánh
  // Muse đã bị bỏ qua ở listProviders() nên sẽ trả về lỗi gốc của provider trước đó.

  let text = "";
  let used = null;
  let lastErr = null;

  for (let i = 0; i < chain.length; i++) {
    try {
      text = await callProvider(chain[i], model, system, messages);
      used = chain[i].name;
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;

      if (i < chain.length - 1 && isFallbackError(err)) continue;

      break;
    }
  }

  if (lastErr) {
    res.status(502).json({ ok: false, error: "Lỗi gọi nhà cung cấp AI: " + (lastErr && lastErr.message ? lastErr.message : "unknown") });
    return;
  }

  res.status(200).json({ ok: true, provider: used, text: text });
};

// Build 2026-11-06: site Tiếng Anh CPA 2026 (CD7) — force fresh Vercel rebuild.
