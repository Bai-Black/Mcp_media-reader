#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFile } from "fs/promises";
import { extname } from "path";
import { z } from "zod";

const MIME_MAP = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".wmv": "video/x-ms-wmv",
  ".webm": "video/webm",
};

const SUPPORTED_MODELS = ["mimo-v2.5", "mimo-v2-omni"];
const MAX_RETRIES = 3;

// Runtime config — no defaults, all must be provided by user
let config = {
  api_base: process.env.MIMO_API_BASE || null,
  api_key: process.env.MIMO_API_KEY || null,
  model: process.env.MIMO_MODEL || null,
};

// Session store: name -> { messages, dataUri, mime, meta, createdAt, file }
const sessions = new Map();

let transportRef = null;

// Check if all required config is present; if not, tell the caller what's missing
function ensureConfig() {
  const missing = [];
  if (!config.api_key) missing.push("MIMO_API_KEY (MiMo API key, get one at https://platform.xiaomimimo.com/)");
  if (!config.api_base) missing.push("MIMO_API_BASE (API endpoint, e.g. https://api.xiaomimimo.com/v1)");
  if (!config.model) missing.push("MIMO_MODEL (model name: mimo-v2.5 or mimo-v2-omni)");

  if (missing.length === 0) return null;

  return JSON.stringify({
    action: "configure",
    message: `Missing configuration. Please ask the user for: ${missing.join("; ")}`,
    missing,
    hint: "Use the `configure` tool to set these values after obtaining them from the user.",
    supported_models: SUPPORTED_MODELS,
  });
}

// Send progress notification to the caller (Claude Code)
function notify(msg) {
  if (transportRef) {
    transportRef.send({
      jsonrpc: "2.0",
      method: "notifications/message",
      params: { level: "info", logger: "media-reader", data: msg },
    }).catch(() => {});
  }
}

async function callAPI(messages) {
  const resp = await fetch(`${config.api_base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": config.api_key,
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 4096,
      messages,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`API error ${resp.status}: ${err}`);
  }

  const data = await resp.json();
  const msg = data.choices?.[0]?.message;
  return msg?.content || msg?.reasoning_content || "(no response)";
}

const ANALYSIS_SYSTEM = `You are a media analysis assistant. You receive audio or video files and answer queries about them.
When analyzing media, be thorough and specific. Include timestamps when describing events.
If you cannot fully answer the query from the media provided, explain what you CAN see/hear and what specific information is missing.`;

function makeEvalPrompt(query) {
  return `You were asked to find this information: "${query}"

Review your last response. Does it contain enough specific information to fully answer the query?
Reply in this exact JSON format (no markdown, no code fences):
{"satisfied": true/false, "reason": "brief explanation", "missing": "what's missing if not satisfied", "need_reread": true/false}

- satisfied: true if you have enough info to answer the query
- need_reread: true ONLY if you need to re-examine the media to find the missing info (e.g., need to look at a different timestamp, listen more carefully). false if the missing info requires external knowledge or interpretation rather than re-reading the media.`;
}

async function analyzeWithLoop(mediaContent, query, sessionName, maxRetries = MAX_RETRIES) {
  const session = sessions.get(sessionName);
  const messages = session ? [...session.messages] : [];

  if (messages.length === 0) {
    const userContent = [mediaContent];
    if (query) {
      userContent.push({ type: "text", text: `Query: ${query}\n\nAnalyze the media above to answer this query. Be specific with timestamps and details.` });
    } else {
      userContent.push({ type: "text", text: "Please describe the content of this media in detail, including timestamps, visual elements, actions, and audio." });
    }
    messages.push(
      { role: "system", content: ANALYSIS_SYSTEM },
      { role: "user", content: userContent }
    );
  }

  notify(`[${sessionName}] Starting analysis...`);
  let response = await callAPI(messages);
  messages.push({ role: "assistant", content: response });
  notify(`[${sessionName}] Initial analysis complete.`);

  if (!query) {
    if (session) session.messages = messages;
    return { response, iterations: 1 };
  }

  let iterations = 1;
  for (let i = 0; i < maxRetries; i++) {
    notify(`[${sessionName}] Self-evaluation round ${i + 1}/${maxRetries}...`);
    const evalMessages = [
      ...messages,
      { role: "user", content: makeEvalPrompt(query) },
    ];
    const evalText = await callAPI(evalMessages);
    iterations++;

    let evaluation;
    try {
      const jsonMatch = evalText.match(/\{[\s\S]*\}/);
      evaluation = jsonMatch ? JSON.parse(jsonMatch[0]) : { satisfied: true };
    } catch {
      evaluation = { satisfied: true };
    }

    if (evaluation.satisfied) {
      notify(`[${sessionName}] Query satisfied after ${i + 1} evaluation(s).`);
      break;
    }

    notify(`[${sessionName}] Not satisfied: ${evaluation.missing} (need_reread: ${evaluation.need_reread})`);

    if (evaluation.need_reread && session?.dataUri) {
      const followUpContent = [
        mediaContent,
        { type: "text", text: `Previous response was insufficient. Missing info: ${evaluation.missing}\n\nPlease re-examine the media carefully, focusing on: ${evaluation.missing}\nOriginal query: ${query}` },
      ];
      messages.push({ role: "user", content: followUpContent });
    } else {
      messages.push({
        role: "user",
        content: `Your response was insufficient. Missing: ${evaluation.missing}\n\nPlease provide more detailed analysis focusing on: ${evaluation.missing}\nOriginal query: ${query}`,
      });
    }

    notify(`[${sessionName}] Sending refined query (API call ${iterations + 1})...`);
    response = await callAPI(messages);
    messages.push({ role: "assistant", content: response });
    iterations++;
  }

  if (session) session.messages = messages;
  notify(`[${sessionName}] Done. Total API calls: ${iterations}`);
  return { response, iterations };
}

// Generate a unique session name
function generateSessionName() {
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `session-${ts}-${Math.random().toString(36).slice(2, 6)}`;
}

const server = new McpServer({
  name: "media-reader",
  version: "1.1.0",
});

server.tool(
  "configure",
  "Configure MiMo API connection. Call this after obtaining settings from the user. All parameters are optional — only set the ones you need to change.",
  {
    api_key: z.string().optional().describe("MiMo API key (get one at https://platform.xiaomimimo.com/)"),
    api_base: z.string().optional().describe("MiMo API endpoint (e.g. https://api.xiaomimimo.com/v1)"),
    model: z.string().optional().describe("Model name: mimo-v2.5 or mimo-v2-omni"),
  },
  async ({ api_key, api_base, model }) => {
    const changes = [];
    if (api_key) { config.api_key = api_key; changes.push("api_key"); }
    if (api_base) { config.api_base = api_base; changes.push("api_base"); }
    if (model) {
      if (!SUPPORTED_MODELS.includes(model)) {
        return { content: [{ type: "text", text: `Unsupported model: ${model}. Supported models: ${SUPPORTED_MODELS.join(", ")}` }] };
      }
      config.model = model; changes.push("model");
    }
    if (changes.length === 0) {
      return { content: [{ type: "text", text: `Current config: api_base=${config.api_base || "not set"}, model=${config.model || "not set"}, api_key=${config.api_key ? "***set***" : "not set"}` }] };
    }
    return { content: [{ type: "text", text: `Updated: ${changes.join(", ")}. Config: api_base=${config.api_base || "not set"}, model=${config.model || "not set"}, api_key=${config.api_key ? "***set***" : "not set"}` }] };
  }
);

server.tool(
  "read_audio",
  "Read and analyze an audio file (mp3, wav, flac, m4a, ogg). Supports follow-up queries with autonomous refinement.",
  {
    file_path: z.string().describe("Absolute path to the audio file"),
    query: z.string().optional().describe("What specific information to extract from the audio. If omitted, returns full description."),
    session_name: z.string().optional().describe("Name for this analysis session. Auto-generated if omitted. Use with ask_about_media to continue later."),
    max_retries: z.number().optional().default(MAX_RETRIES).describe("Max self-evaluation rounds (default 3)"),
  },
  async ({ file_path, query, session_name, max_retries = MAX_RETRIES }) => {
    const configError = ensureConfig();
    if (configError) return { content: [{ type: "text", text: configError }] };

    const ext = extname(file_path).toLowerCase();
    const mime = MIME_MAP[ext];
    if (!mime || !mime.startsWith("audio/")) {
      return { content: [{ type: "text", text: `Unsupported audio format: ${ext}` }] };
    }

    const buf = await readFile(file_path);
    const base64 = buf.toString("base64");
    const dataUri = `data:${mime};base64,${base64}`;

    const name = session_name || generateSessionName();
    sessions.set(name, {
      messages: [],
      dataUri,
      mime,
      meta: { type: "audio" },
      file: file_path,
      createdAt: new Date().toISOString(),
    });

    const mediaContent = { type: "input_audio", input_audio: { data: dataUri } };
    const { response, iterations } = await analyzeWithLoop(mediaContent, query, name, max_retries);

    const header = `Session: ${name}\n${iterations > 1 ? `Analyzed in ${iterations} API calls\n` : ""}\n`;
    return { content: [{ type: "text", text: header + response }] };
  }
);

server.tool(
  "read_video",
  "Read and analyze a video file (mp4, mov, avi, wmv). Supports follow-up queries with autonomous refinement.",
  {
    file_path: z.string().describe("Absolute path to the video file"),
    query: z.string().optional().describe("What specific information to extract from the video. If omitted, returns full description."),
    session_name: z.string().optional().describe("Name for this analysis session. Auto-generated if omitted. Use with ask_about_media to continue later."),
    fps: z.number().optional().default(2).describe("Frames per second, range [0.1, 10], default 2"),
    media_resolution: z.enum(["default", "max"]).optional().default("default"),
    max_retries: z.number().optional().default(MAX_RETRIES).describe("Max self-evaluation rounds (default 3)"),
  },
  async ({ file_path, query, session_name, fps = 2, media_resolution = "default", max_retries = MAX_RETRIES }) => {
    const configError = ensureConfig();
    if (configError) return { content: [{ type: "text", text: configError }] };

    const ext = extname(file_path).toLowerCase();
    const mime = MIME_MAP[ext];
    if (!mime || !mime.startsWith("video/")) {
      return { content: [{ type: "text", text: `Unsupported video format: ${ext}` }] };
    }

    const buf = await readFile(file_path);
    const base64 = buf.toString("base64");
    const dataUri = `data:${mime};base64,${base64}`;

    const name = session_name || generateSessionName();
    sessions.set(name, {
      messages: [],
      dataUri,
      mime,
      meta: { type: "video", fps, media_resolution },
      file: file_path,
      createdAt: new Date().toISOString(),
    });

    const mediaContent = {
      type: "video_url",
      video_url: { url: dataUri },
      fps,
      media_resolution,
    };
    const { response, iterations } = await analyzeWithLoop(mediaContent, query, name, max_retries);

    const header = `Session: ${name}\n${iterations > 1 ? `Analyzed in ${iterations} API calls\n` : ""}\n`;
    return { content: [{ type: "text", text: header + response }] };
  }
);

server.tool(
  "ask_about_media",
  "Ask a follow-up question in an existing media analysis session. Uses conversation context - no re-upload needed.",
  {
    session_name: z.string().describe("Name of the session to continue (from read_audio/read_video output or list_sessions)"),
    question: z.string().describe("Follow-up question about the media"),
    max_retries: z.number().optional().default(MAX_RETRIES).describe("Max self-evaluation rounds"),
  },
  async ({ session_name, question, max_retries = MAX_RETRIES }) => {
    const configError = ensureConfig();
    if (configError) return { content: [{ type: "text", text: configError }] };

    const session = sessions.get(session_name);

    if (!session || session.messages.length === 0) {
      return { content: [{ type: "text", text: `No session named "${session_name}". Use list_sessions to see available sessions, or read_audio/read_video to create one.` }] };
    }

    notify(`[${session_name}] Follow-up question: ${question}`);
    session.messages.push({ role: "user", content: question });

    const response = await callAPI(session.messages);
    session.messages.push({ role: "assistant", content: response });

    let iterations = 1;
    for (let i = 0; i < max_retries; i++) {
      notify(`[${session_name}] Self-evaluation round ${i + 1}/${max_retries}...`);
      const evalMessages = [
        ...session.messages,
        { role: "user", content: makeEvalPrompt(question) },
      ];
      const evalText = await callAPI(evalMessages);
      iterations++;

      let evaluation;
      try {
        const jsonMatch = evalText.match(/\{[\s\S]*\}/);
        evaluation = jsonMatch ? JSON.parse(jsonMatch[0]) : { satisfied: true };
      } catch {
        evaluation = { satisfied: true };
      }

      if (evaluation.satisfied) {
        notify(`[${session_name}] Query satisfied.`);
        break;
      }

      notify(`[${session_name}] Not satisfied: ${evaluation.missing}`);

      if (evaluation.need_reread && session.dataUri) {
        const mediaContent = session.meta.type === "audio"
          ? { type: "input_audio", input_audio: { data: session.dataUri } }
          : {
              type: "video_url",
              video_url: { url: session.dataUri },
              fps: session.meta.fps || 2,
              media_resolution: session.meta.media_resolution || "default",
            };
        session.messages.push({
          role: "user",
          content: [
            mediaContent,
            { type: "text", text: `Please re-examine the media. Missing: ${evaluation.missing}\nOriginal question: ${question}` },
          ],
        });
      } else {
        session.messages.push({
          role: "user",
          content: `Missing: ${evaluation.missing}\nPlease provide more detail for: ${question}`,
        });
      }

      notify(`[${session_name}] Refined query (API call ${iterations + 1})...`);
      const retryResponse = await callAPI(session.messages);
      session.messages.push({ role: "assistant", content: retryResponse });
      iterations++;
    }

    const finalMsg = session.messages[session.messages.length - 1].content;
    notify(`[${session_name}] Done. Total API calls: ${iterations}`);
    const header = iterations > 1 ? `[${iterations} API calls]\n\n` : "";
    return { content: [{ type: "text", text: header + finalMsg }] };
  }
);

server.tool(
  "list_sessions",
  "List all active media analysis sessions with their names, metadata, and conversation history. Use session names with ask_about_media.",
  {},
  async () => {
    const list = [];
    for (const [name, session] of sessions) {
      list.push({
        name,
        file: session.file,
        type: session.meta.type,
        turns: Math.floor(session.messages.length / 2),
        createdAt: session.createdAt,
      });
    }
    if (list.length === 0) {
      return { content: [{ type: "text", text: "No active sessions." }] };
    }
    const text = list.map(s =>
      `Name: ${s.name}\n  File: ${s.file}\n  Type: ${s.type}\n  Turns: ${s.turns}\n  Created: ${s.createdAt}`
    ).join("\n\n");
    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "delete_session",
  "Delete a media analysis session to free memory.",
  {
    session_name: z.string().describe("Name of the session to delete"),
  },
  async ({ session_name }) => {
    if (sessions.delete(session_name)) {
      return { content: [{ type: "text", text: `Session "${session_name}" deleted.` }] };
    }
    return { content: [{ type: "text", text: `No session named "${session_name}".` }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  transportRef = transport;
  await server.connect(transport);
}

main().catch(console.error);
