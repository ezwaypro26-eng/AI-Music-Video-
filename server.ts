import "dotenv/config";
import express from "express";
import type { Request, Response } from "express";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import multer from "multer";
import { PrismaClient } from "@prisma/client";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";

const execFileAsync = promisify(execFile);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const prisma = new PrismaClient();
const app = express();
const PORT = Number(process.env.PORT) || 3000;

const ROOT_DIR = process.cwd();
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const CHARACTERS_DIR = path.join(PUBLIC_DIR, "characters");
const SCENES_DIR = path.join(PUBLIC_DIR, "scenes");
const AUDIO_DIR = path.join(PUBLIC_DIR, "uploads", "audio");
const PROJECTS_DIR = path.join(PUBLIC_DIR, "projects");
const RENDERS_DIR = path.join(PUBLIC_DIR, "renders");
const TEMP_DIR = path.join(ROOT_DIR, ".tmp-renders");

for (const dir of [CHARACTERS_DIR, SCENES_DIR, AUDIO_DIR, PROJECTS_DIR, RENDERS_DIR, TEMP_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

// Private single-owner access gate. Protects the app shell, static assets, and every API route.
const nocturnePassword = process.env.NOCTURNE_ACCESS_PASSWORD?.trim();
app.use((req: Request, res: Response, next) => {
  if (!nocturnePassword) {
    res.status(503).type("text").send("Nocturne is locked until NOCTURNE_ACCESS_PASSWORD is configured.");
    return;
  }
  const header = req.headers.authorization || "";
  const encoded = header.startsWith("Basic ") ? header.slice(6) : "";
  let supplied = "";
  try {
    supplied = Buffer.from(encoded, "base64").toString("utf8").split(":").slice(1).join(":");
  } catch {
    supplied = "";
  }
  const expected = Buffer.from(nocturnePassword);
  const actual = Buffer.from(supplied);
  const valid = actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  if (!valid) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Nocturne Studio", charset="UTF-8"');
    res.status(401).type("text").send("Sign in to your private Nocturne Studio.");
    return;
  }
  next();
});

// Serve generated & uploaded assets immediately from public/
app.use(express.static(PUBLIC_DIR));

const imageStorage = (destDir: string, prefix: string) =>
  multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, destDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || "").toLowerCase() || ".jpg";
      const safeExt = [".jpg", ".jpeg", ".png", ".webp"].includes(ext) ? ext : ".jpg";
      const id = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      cb(null, `${id}${safeExt}`);
    },
  });

const audioStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, AUDIO_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase() || ".mp3";
    const safeExt = [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"].includes(ext) ? ext : ".mp3";
    const id = `track-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    cb(null, `${id}${safeExt}`);
  },
});

const uploadCharacterPhoto = multer({
  storage: imageStorage(CHARACTERS_DIR, "char"),
  limits: { fileSize: 20 * 1024 * 1024 },
});

const uploadScenePhoto = multer({
  storage: imageStorage(SCENES_DIR, "scene"),
  limits: { fileSize: 20 * 1024 * 1024 },
});

const uploadAudioTrack = multer({
  storage: audioStorage,
  limits: { fileSize: 100 * 1024 * 1024 },
});

function getModalLipsyncConfig(): { url: string; token: string } | null {
  const url = process.env.MODAL_LIPSYNC_URL?.trim().replace(/\/+$/, "");
  const token = process.env.MODAL_LIPSYNC_API_TOKEN?.trim();
  return url && token ? { url, token } : null;
}

async function runMuseTalkWithModal(videoPath: string, audioPath: string, outputPath: string, shot: number): Promise<void> {
  const cfg = getModalLipsyncConfig();
  if (!cfg) throw new Error("Modal MuseTalk is not connected. Configure MODAL_LIPSYNC_URL and MODAL_LIPSYNC_API_TOKEN in Render.");
  const submitted = await fetch(`${cfg.url}/submit`, {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      video_base64: fs.readFileSync(videoPath).toString("base64"),
      audio_base64: fs.readFileSync(audioPath).toString("base64"),
    }),
  });
  if (!submitted.ok) throw new Error(`MuseTalk submit failed for Shot ${shot}: ${(await submitted.text()).slice(0, 500)}`);
  const { call_id } = await submitted.json() as { call_id?: string };
  if (!call_id) throw new Error("MuseTalk did not return a job ID.");
  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    const response = await fetch(`${cfg.url}/result/${encodeURIComponent(call_id)}`, {
      headers: { authorization: `Bearer ${cfg.token}` },
    });
    if (!response.ok) throw new Error(`MuseTalk failed for Shot ${shot}: ${(await response.text()).slice(0, 700)}`);
    if ((response.headers.get("content-type") || "").includes("video/mp4")) {
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length < 1024) throw new Error("MuseTalk returned an empty video.");
      fs.writeFileSync(outputPath, bytes);
      return;
    }
    const status = await response.json() as { status?: string; detail?: string };
    if (status.status === "failed") throw new Error(status.detail || "MuseTalk lip-sync failed.");
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  throw new Error(`MuseTalk timed out for Shot ${shot}.`);
}

function getModalLtxConfig(): { url: string; token: string } | null {
  const url = process.env.MODAL_LTX_URL?.trim().replace(/\/+$/, "");
  const token = process.env.MODAL_LTX_API_TOKEN?.trim();
  if (!url || !token) return null;
  return { url, token };
}

async function generateVideoWithModalLtx(
  imageAbsPath: string,
  prompt: string,
  aspectRatio: string,
  targetAbsPath: string
): Promise<void> {
  const config = getModalLtxConfig();
  if (!config) {
    throw new Error("Modal LTX is not connected yet. Add MODAL_LTX_URL and MODAL_LTX_API_TOKEN to the app's environment settings.");
  }
  if (!fs.existsSync(imageAbsPath)) {
    throw new Error("The storyboard image for this LTX scene could not be found.");
  }

  const imageBase64 = fs.readFileSync(imageAbsPath).toString("base64");
  const submitResponse = await fetch(`${config.url}/submit`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      image_base64: imageBase64,
      prompt,
      aspect_ratio: aspectRatio,
    }),
  });
  if (!submitResponse.ok) {
    const detail = await submitResponse.text();
    throw new Error(`Modal LTX could not accept the scene (${submitResponse.status}): ${detail.slice(0, 500)}`);
  }

  const submitted = (await submitResponse.json()) as { call_id?: string };
  if (!submitted.call_id) {
    throw new Error("Modal LTX did not return a generation job ID.");
  }

  const deadline = Date.now() + 45 * 60 * 1000;
  while (Date.now() < deadline) {
    const resultResponse = await fetch(
      `${config.url}/result/${encodeURIComponent(submitted.call_id)}`,
      { headers: { authorization: `Bearer ${config.token}` } }
    );
    if (!resultResponse.ok) {
      const detail = await resultResponse.text();
      throw new Error(`Modal LTX scene failed (${resultResponse.status}): ${detail.slice(0, 500)}`);
    }

    const contentType = resultResponse.headers.get("content-type") || "";
    if (contentType.includes("video/mp4")) {
      const video = Buffer.from(await resultResponse.arrayBuffer());
      if (video.length < 1024) {
        throw new Error("Modal LTX returned an empty or incomplete video.");
      }
      fs.writeFileSync(targetAbsPath, video);
      return;
    }

    const status = (await resultResponse.json()) as { status?: string; detail?: string };
    if (status.status === "failed") {
      throw new Error(status.detail || "Modal LTX generation failed.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  throw new Error("Modal LTX took too long to finish this scene. Check the Modal app logs before retrying.");
}

function getGeminiKey(): string | null {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key || key === "MY_GEMINI_API_KEY") return null;
  return key;
}

function getOpenAiKey(): string | null {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key || key === "MY_OPENAI_API_KEY") return null;
  return key;
}

function deletePublicAsset(publicRelPath: string | null | undefined) {
  if (!publicRelPath || !publicRelPath.startsWith("/")) return;
  const fullPath = path.join(PUBLIC_DIR, publicRelPath.replace(/^\/+/, ""));
  if (fullPath.startsWith(PUBLIC_DIR) && fs.existsSync(fullPath)) {
    try {
      fs.unlinkSync(fullPath);
    } catch {
      // Ignore cleanup errors
    }
  }
}

async function downloadImageToPublic(imageUrl: string, destDir: string, prefix: string): Promise<string> {
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`Failed to download generated image (${response.status})`);
  }
  const contentType = response.headers.get("content-type") || "image/jpeg";
  const ext = contentType.includes("png") ? ".png" : contentType.includes("webp") ? ".webp" : ".jpg";
  const filename = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
  const fullPath = path.join(destDir, filename);
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(fullPath, buffer);
  const relFromPublic = path.relative(PUBLIC_DIR, fullPath).split(path.sep).join("/");
  return `/${relFromPublic}`;
}

function getModalWhisperConfig(): { url: string; token: string } | null {
  const url = process.env.MODAL_WHISPER_URL?.trim().replace(/\/+$/, "");
  const token = process.env.MODAL_WHISPER_API_TOKEN?.trim();
  if (!url || !token) return null;
  return { url, token };
}

async function transcribeWithModalWhisper(audioAbsPath: string): Promise<{
  text?: string;
  chunks?: Array<{ text?: string; timestamp?: [number, number | null] }>;
  words?: Array<{ text?: string; start?: number; end?: number }>;
}> {
  const config = getModalWhisperConfig();
  if (!config) throw new Error("Modal Whisper is not connected. Add MODAL_WHISPER_URL and MODAL_WHISPER_API_TOKEN to the app environment settings.");
  if (!fs.existsSync(audioAbsPath)) throw new Error("The uploaded song could not be found for transcription.");

  const audioBase64 = fs.readFileSync(audioAbsPath).toString("base64");
  const submitResponse = await fetch(`${config.url}/submit`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
    body: JSON.stringify({ audio_base64: audioBase64, filename: path.basename(audioAbsPath) }),
  });
  if (!submitResponse.ok) {
    const detail = await submitResponse.text();
    throw new Error(`Hugging Face Whisper could not accept the song (${submitResponse.status}): ${detail.slice(0, 500)}`);
  }
  const submitted = (await submitResponse.json()) as { call_id?: string };
  if (!submitted.call_id) throw new Error("Hugging Face Whisper did not return a transcription job ID.");

  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    const resultResponse = await fetch(`${config.url}/result/${encodeURIComponent(submitted.call_id)}`, {
      headers: { authorization: `Bearer ${config.token}` },
    });
    if (!resultResponse.ok) {
      const detail = await resultResponse.text();
      throw new Error(`Hugging Face Whisper failed (${resultResponse.status}): ${detail.slice(0, 500)}`);
    }
    const result = (await resultResponse.json()) as {
      status?: string;
      detail?: string;
      text?: string;
      chunks?: Array<{ text?: string; timestamp?: [number, number | null] }>;
      words?: Array<{ text?: string; start?: number; end?: number }>;
    };
    if (result.status === "failed") throw new Error(result.detail || "Hugging Face Whisper transcription failed.");
    if (result.status === "completed") return {
      text: result.text || "",
      chunks: result.chunks || [],
      words: result.words || [],
    };
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error("Whisper took too long to transcribe this song. Check the Modal app logs before retrying.");
}

function getModalDemucsConfig(): { url: string; token: string } | null {
  const url = process.env.MODAL_DEMUCS_URL?.trim().replace(/\/+$/, "");
  const token = process.env.MODAL_DEMUCS_API_TOKEN?.trim();
  if (!url || !token) return null;
  return { url, token };
}

async function separateVocalsWithModalDemucs(audioAbsPath: string, projectDir: string): Promise<string> {
  const config = getModalDemucsConfig();
  if (!config) {
    throw new Error("Modal Demucs is not connected yet. Add MODAL_DEMUCS_URL and MODAL_DEMUCS_API_TOKEN to the app environment settings after deploying the Modal Demucs service.");
  }
  if (!fs.existsSync(audioAbsPath)) throw new Error("The uploaded song could not be found for vocal separation.");

  const audioBase64 = fs.readFileSync(audioAbsPath).toString("base64");
  const submitResponse = await fetch(`${config.url}/submit`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ audio_base64: audioBase64, filename: path.basename(audioAbsPath) }),
  });
  if (!submitResponse.ok) {
    const detail = await submitResponse.text();
    throw new Error(`Modal Demucs could not accept the song (${submitResponse.status}): ${detail.slice(0, 500)}`);
  }
  const submitted = (await submitResponse.json()) as { call_id?: string };
  if (!submitted.call_id) throw new Error("Modal Demucs did not return a separation job ID.");

  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    const resultResponse = await fetch(
      `${config.url}/result/${encodeURIComponent(submitted.call_id)}`,
      { headers: { authorization: `Bearer ${config.token}` } }
    );
    if (!resultResponse.ok) {
      const detail = await resultResponse.text();
      throw new Error(`Modal Demucs separation failed (${resultResponse.status}): ${detail.slice(0, 500)}`);
    }
    const contentType = resultResponse.headers.get("content-type") || "";
    if (contentType.includes("audio/wav") || contentType.includes("audio/x-wav")) {
      const vocalsBuffer = Buffer.from(await resultResponse.arrayBuffer());
      if (vocalsBuffer.length < 1024) throw new Error("Modal Demucs returned an empty vocal stem.");
      const vocalsPath = path.join(projectDir, "vocals.wav");
      fs.writeFileSync(vocalsPath, vocalsBuffer);
      return `/projects/${path.basename(projectDir)}/vocals.wav`;
    }
    const status = (await resultResponse.json()) as { status?: string; detail?: string };
    if (status.status === "failed") throw new Error(status.detail || "Demucs separation failed.");
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error("Demucs took too long to separate this song. Check the Modal app logs before retrying.");
}

function getModalFluxConfig(): { url: string; token: string } | null {
  const url = process.env.MODAL_FLUX_URL?.trim().replace(/\/+$/, "");
  const token = process.env.MODAL_FLUX_API_TOKEN?.trim();
  if (!url || !token) return null;
  return { url, token };
}

function getDimensionsForAspectRatio(aspectRatio: string): { width: number; height: number } {
  if (aspectRatio === "9:16") return { width: 768, height: 1360 };
  if (aspectRatio === "3:4") return { width: 1024, height: 1360 };
  if (aspectRatio === "1:1") return { width: 1024, height: 1024 };
  return { width: 1360, height: 768 };
}

async function generateImageWithModalFlux(params: {
  model: "flux-dev" | "flux-kontext";
  prompt: string;
  aspectRatio: string;
  referenceImagePath?: string | null;
  targetAbsPath: string;
}): Promise<void> {
  const config = getModalFluxConfig();
  if (!config) {
    throw new Error("Hugging Face FLUX is not connected yet. Add MODAL_FLUX_URL and MODAL_FLUX_API_TOKEN to the app environment settings after deploying the Modal FLUX service.");
  }

  const { width, height } = getDimensionsForAspectRatio(params.aspectRatio);
  let referenceImageBase64: string | undefined;
  if (params.referenceImagePath) {
    const fullPath = path.join(PUBLIC_DIR, params.referenceImagePath.replace(/^\/+/, ""));
    if (!fs.existsSync(fullPath)) throw new Error("The artist reference portrait could not be found.");
    referenceImageBase64 = fs.readFileSync(fullPath).toString("base64");
  }

  const response = await fetch(`${config.url}/generate`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: params.model,
      prompt: params.prompt,
      width,
      height,
      reference_image_base64: referenceImageBase64,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Modal FLUX image generation failed (${response.status}): ${detail.slice(0, 600)}`);
  }

  const imageBytes = Buffer.from(await response.arrayBuffer());
  if (imageBytes.length < 1024) throw new Error("Modal FLUX returned an empty or incomplete image.");
  fs.mkdirSync(path.dirname(params.targetAbsPath), { recursive: true });
  fs.writeFileSync(params.targetAbsPath, imageBytes);
}

async function saveScenePngFromModalFlux(params: {
  projectId: string;
  orderIndex: number;
  prompt: string;
  aspectRatio: string;
  referenceImagePath?: string | null;
  model: "flux-dev" | "flux-kontext";
}): Promise<string> {
  const projectDir = path.join(PROJECTS_DIR, params.projectId);
  fs.mkdirSync(projectDir, { recursive: true });
  const targetPngPath = path.join(projectDir, `scene_${params.orderIndex}.png`);
  await generateImageWithModalFlux({
    model: params.model,
    prompt: params.prompt,
    aspectRatio: params.aspectRatio,
    referenceImagePath: params.referenceImagePath,
    targetAbsPath: targetPngPath,
  });
  return `/projects/${params.projectId}/scene_${params.orderIndex}.png`;
}

async function generateSceneKeyframeWithFlux(params: {
  projectId: string;
  orderIndex: number;
  aspectRatio: string;
  imagePrompt: string;
  lyricSegment: string;
  characterName?: string | null;
  characterVisualPrompt?: string | null;
  characterRefPath?: string | null;
}): Promise<string> {
  const baseDesc = params.imagePrompt.trim() || params.lyricSegment.trim() || "Atmospheric music video scene";

  if (params.characterRefPath) {
    const identityLine = params.characterName
      ? `Preserve ${params.characterName}'s identity, face, hair, and outfit from the supplied reference image (${params.characterVisualPrompt || "singer portrait"}).`
      : "Preserve the singer's exact identity, face, hair, and outfit from the supplied reference image.";
    return saveScenePngFromModalFlux({
      projectId: params.projectId,
      orderIndex: params.orderIndex,
      aspectRatio: params.aspectRatio,
      prompt: `${identityLine} ${baseDesc} 35mm cinematic music video still.`,
      referenceImagePath: params.characterRefPath,
      model: "flux-kontext",
    });
  }

  const fallbackPrompt = `${params.characterVisualPrompt ? `${params.characterVisualPrompt}. ` : ""}${baseDesc}, 35mm cinematic music video still.`;
  return saveScenePngFromModalFlux({
    projectId: params.projectId,
    orderIndex: params.orderIndex,
    aspectRatio: params.aspectRatio,
    prompt: fallbackPrompt,
    model: "flux-dev",
  });
}

async function getAudioDurationSec(publicRelPath: string | null | undefined): Promise<number | null> {
  if (!publicRelPath) return null;
  const fullPath = path.join(PUBLIC_DIR, publicRelPath.replace(/^\/+/, ""));
  if (!fs.existsSync(fullPath)) return null;
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      fullPath,
    ]);
    const val = parseFloat(stdout.trim());
    return Number.isFinite(val) && val > 0 ? val : null;
  } catch {
    return null;
  }
}

// ---------- Health & Capabilities ----------
async function pingModalWarmup(name: string, url: string | undefined, token: string | undefined): Promise<void> {
  const baseUrl = url?.trim().replace(/\/+$/, "");
  if (!baseUrl || !token?.trim()) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${baseUrl}/warmup`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.trim()}`,
        "content-type": "application/json",
      },
      body: "{}",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 250)}`);
    const result = await response.json() as { call_id?: string; status?: string };
    console.info(`Modal ${name} GPU warmup accepted:`, result.status || result.call_id || "accepted");
  } catch (error) {
    console.warn(`Modal ${name} warmup request did not complete:`, error instanceof Error ? error.message : error);
  } finally {
    clearTimeout(timeout);
  }
}

async function warmModalServices(): Promise<void> {
  await Promise.allSettled([
    pingModalWarmup("FLUX", process.env.MODAL_FLUX_URL, process.env.MODAL_FLUX_API_TOKEN),
    pingModalWarmup("LTX-2.5", process.env.MODAL_LTX_URL, process.env.MODAL_LTX_API_TOKEN),
    pingModalWarmup("MuseTalk", process.env.MODAL_LIPSYNC_URL, process.env.MODAL_LIPSYNC_API_TOKEN),
  ]);
}

app.post("/api/warmup", (_req: Request, res: Response) => {
  res.status(202).json({ accepted: true, message: "Modal service warmup pings started." });
  void warmModalServices();
});

app.get("/api/capabilities", async (_req: Request, res: Response) => {
  let hasFfmpeg = false;
  try {
    await execFileAsync("ffmpeg", ["-version"]);
    hasFfmpeg = true;
  } catch {
    hasFfmpeg = false;
  }
  res.json({
    modalLipsyncConfigured: Boolean(getModalLipsyncConfig()),
    modalVideoConfigured: Boolean(getModalLtxConfig()),
    modalFluxConfigured: Boolean(getModalFluxConfig()),
    modalDemucsConfigured: Boolean(getModalDemucsConfig()),
    modalWhisperConfigured: Boolean(getModalWhisperConfig()),
    geminiConfigured: Boolean(getGeminiKey()),
    openaiConfigured: Boolean(getOpenAiKey()),
    ffmpegAvailable: hasFfmpeg,
  });
});


const EZWAY_SUPABASE_URL = "https://cdvfxkefhcqmifnddvza.supabase.co";
const EZWAY_AUDIO_BUCKET = "ezway-media";

function getEzwayServiceKey(): string | null {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  return key || null;
}

// Read-only bridge: Nocturne reads the existing EZway catalog; it never inserts or updates EZway rows.
app.get("/api/ezway/tracks", async (_req: Request, res: Response) => {
  const key = getEzwayServiceKey();
  if (!key) {
    res.status(503).json({ error: "EZway library connection is not configured. Add SUPABASE_SERVICE_ROLE_KEY in Render." });
    return;
  }
  try {
    const url = new URL("/rest/v1/tracks", EZWAY_SUPABASE_URL);
    url.searchParams.set("select", "id,name,artist,duration,bpm,key_signature,lyrics,status,file_key");
    url.searchParams.set("status", "eq.ready");
    url.searchParams.set("order", "created_at.desc");
    url.searchParams.set("limit", "250");
    const response = await fetch(url, {
      headers: key.startsWith("sb_") ? { apikey: key } : { apikey: key, authorization: `Bearer ${key}` },
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`EZway catalog request failed (${response.status}): ${detail.slice(0, 300)}`);
    }
    const rows = await response.json() as Array<{
      id: string; name: string; artist: string | null; duration: number | null;
      bpm: number | null; key_signature: string | null; lyrics: string | null;
      status: string; file_key: string | null;
    }>;
    res.setHeader("Cache-Control", "private, no-store");
    res.json({
      tracks: rows.map(({ file_key, ...track }) => ({
        ...track,
        hasAudio: Boolean(file_key),
        hasLyrics: Boolean(track.lyrics?.trim()),
      })),
    });
  } catch (err) {
    console.error("GET /api/ezway/tracks failed:", err);
    res.status(502).json({ error: err instanceof Error ? err.message : "Could not load EZway tracks." });
  }
});

app.post("/api/ezway/tracks/:id/audio-url", async (req: Request, res: Response) => {
  const key = getEzwayServiceKey();
  if (!key) {
    res.status(503).json({ error: "EZway library connection is not configured." });
    return;
  }
  try {
    const trackId = String(req.params.id || "");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(trackId)) {
      res.status(400).json({ error: "Invalid EZway track ID." });
      return;
    }
    const lookupUrl = new URL("/rest/v1/tracks", EZWAY_SUPABASE_URL);
    lookupUrl.searchParams.set("select", "id,file_key");
    lookupUrl.searchParams.set("id", `eq.${trackId}`);
    lookupUrl.searchParams.set("limit", "1");
    const lookup = await fetch(lookupUrl, { headers: key.startsWith("sb_") ? { apikey: key } : { apikey: key, authorization: `Bearer ${key}` } });
    if (!lookup.ok) throw new Error(`Could not look up the selected EZway track (${lookup.status}).`);
    const found = await lookup.json() as Array<{ id: string; file_key: string | null }>;
    const objectKey = found[0]?.file_key;
    if (!objectKey || found[0]?.id !== trackId) {
      res.status(404).json({ error: "This EZway track has no stored audio file." });
      return;
    }
    const encodedKey = objectKey.split("/").map(encodeURIComponent).join("/");
    const signUrl = `${EZWAY_SUPABASE_URL}/storage/v1/object/sign/${EZWAY_AUDIO_BUCKET}/${encodedKey}`;
    const signed = await fetch(signUrl, {
      method: "POST",
      headers: key.startsWith("sb_") ? { apikey: key, "content-type": "application/json" } : { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ expiresIn: 600 }),
    });
    if (!signed.ok) {
      const detail = await signed.text();
      throw new Error(`Could not create a private audio link (${signed.status}): ${detail.slice(0, 300)}`);
    }
    const result = await signed.json() as { signedURL?: string; signedUrl?: string };
    const pathPart = result.signedURL || result.signedUrl;
    if (!pathPart) throw new Error("Supabase did not return a signed audio URL.");
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ audioUrl: new URL(pathPart, EZWAY_SUPABASE_URL).toString() });
  } catch (err) {
    console.error("POST /api/ezway/tracks/:id/audio-url failed:", err);
    res.status(502).json({ error: err instanceof Error ? err.message : "Could not prepare EZway audio." });
  }
});

// ---------- Artist Locker: Characters ----------
app.get("/api/characters", async (_req: Request, res: Response) => {
  try {
    const characters = await prisma.character.findMany({
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { projects: true } } },
    });
    res.json({ characters });
  } catch (err) {
    console.error("GET /api/characters failed:", err);
    res.status(500).json({ error: "Failed to load saved artists." });
  }
});

app.post("/api/characters/upload", uploadCharacterPhoto.single("photo"), async (req: Request, res: Response) => {
  try {
    const file = req.file;
    const name = String(req.body?.name || "").trim();
    const visualPrompt = String(req.body?.visualPrompt || "").trim();

    if (!file) {
      res.status(400).json({ error: "Please select or drop a reference portrait photo." });
      return;
    }
    if (!name) {
      deletePublicAsset(`/characters/${file.filename}`);
      res.status(400).json({ error: "Artist name is required." });
      return;
    }

    const refImagePath = `/characters/${file.filename}`;
    const character = await prisma.character.create({
      data: {
        name,
        visualPrompt: visualPrompt || `Reference portrait of ${name}`,
        refImagePath,
      },
      include: { _count: { select: { projects: true } } },
    });

    res.status(201).json({ character });
  } catch (err) {
    console.error("POST /api/characters/upload failed:", err);
    res.status(500).json({ error: "Failed to save uploaded portrait." });
  }
});

app.post("/api/characters/generate", async (req: Request, res: Response) => {
  try {
    const name = String(req.body?.name || "").trim();
    const visualPrompt = String(req.body?.visualPrompt || "").trim();

    if (!name || !visualPrompt) {
      res.status(400).json({ error: "Both artist name and visual description are required." });
      return;
    }

    const studioPrompt = `${visualPrompt}, editorial singer portrait photography, dramatic studio lighting, crisp facial detail, 85mm prime lens, shallow depth of field`;
    const filename = `char-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
    const targetAbsPath = path.join(CHARACTERS_DIR, filename);
    await generateImageWithModalFlux({
      model: "flux-dev",
      prompt: studioPrompt,
      aspectRatio: "3:4",
      targetAbsPath,
    });
    const refImagePath = `/characters/${filename}`;

    const character = await prisma.character.create({
      data: {
        name,
        visualPrompt,
        refImagePath,
      },
      include: { _count: { select: { projects: true } } },
    });

    res.status(201).json({ character });
  } catch (err) {
    console.error("POST /api/characters/generate failed:", err);
    const message = err instanceof Error ? err.message : "Failed to generate artist portrait.";
    res.status(500).json({ error: message });
  }
});

app.patch("/api/characters/:id", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const name = req.body?.name !== undefined ? String(req.body.name).trim() : undefined;
    const visualPrompt = req.body?.visualPrompt !== undefined ? String(req.body.visualPrompt).trim() : undefined;

    const character = await prisma.character.update({
      where: { id },
      data: {
        ...(name ? { name } : {}),
        ...(visualPrompt !== undefined ? { visualPrompt } : {}),
      },
      include: { _count: { select: { projects: true } } },
    });

    res.json({ character });
  } catch (err) {
    console.error("PATCH /api/characters/:id failed:", err);
    res.status(500).json({ error: "Failed to update artist." });
  }
});

app.delete("/api/characters/:id", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const existing = await prisma.character.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ error: "Artist not found." });
      return;
    }
    await prisma.character.delete({ where: { id } });
    deletePublicAsset(existing.refImagePath);
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/characters/:id failed:", err);
    res.status(500).json({ error: "Failed to delete artist." });
  }
});

// ---------- MV Studio: Projects ----------
app.get("/api/projects", async (_req: Request, res: Response) => {
  try {
    const projects = await prisma.project.findMany({
      orderBy: { updatedAt: "desc" },
      include: {
        character: true,
        ...projectCastInclude,
        scenes: { orderBy: { orderIndex: "asc" } },
      },
    });
    res.json({ projects });
  } catch (err) {
    console.error("GET /api/projects failed:", err);
    res.status(500).json({ error: "Failed to load projects." });
  }
});

const VALID_VIDEO_TYPES = ["narrative", "performance", "visualizer", "hype", "retro"] as const;
type MusicVideoType = (typeof VALID_VIDEO_TYPES)[number];

function normalizeVideoType(val: unknown): MusicVideoType {
  const s = String(val || "").toLowerCase();
  return (VALID_VIDEO_TYPES as readonly string[]).includes(s) ? (s as MusicVideoType) : "narrative";
}

function normalizeCastInput(raw: unknown, legacyCharacterId?: unknown): Array<{ artistId: string; role: string; appearanceNotes: string | null; sortOrder: number }> {
  const source = Array.isArray(raw) ? raw : legacyCharacterId ? [{ artistId: legacyCharacterId, role: "Lead Vocalist" }] : [];
  if (source.length > 4) throw new Error("A project can include up to 4 artists.");
  const seen = new Set<string>();
  return source.map((entry: any, index: number) => {
    const artistId = String(entry?.artistId || entry?.characterId || "").trim();
    if (!artistId || seen.has(artistId)) throw new Error("Each cast member must be a unique Artist Locker entry.");
    seen.add(artistId);
    return {
      artistId,
      role: String(entry?.role || (index === 0 ? "Lead Vocalist" : "Featured Artist")).trim().slice(0, 80),
      appearanceNotes: String(entry?.appearanceNotes || "").trim() || null,
      sortOrder: index + 1,
    };
  });
}
const projectCastInclude = {
  castMembers: { include: { artist: true }, orderBy: { sortOrder: "asc" as const } },
};

app.post("/api/projects", async (req: Request, res: Response) => {
  try {
    const title = String(req.body?.title || "Untitled Music Video").trim();
    const concept = String(req.body?.concept || "").trim();
    const aspectRatio = ["16:9", "9:16", "1:1"].includes(req.body?.aspectRatio) ? req.body.aspectRatio : "16:9";
    const videoType = normalizeVideoType(req.body?.videoType);
    const rawLyrics = String(req.body?.rawLyrics || "");
    const castMembers = normalizeCastInput(req.body?.castMembers, req.body?.characterId);
    const characterId = castMembers[0]?.artistId || (req.body?.characterId ? String(req.body.characterId) : null);

    const project = await prisma.project.create({
      data: {
        title,
        concept,
        aspectRatio,
        videoType,
        rawLyrics,
        characterId,
        castMembers: { create: castMembers },
        status: "draft",
      },
      include: {
        character: true,
        ...projectCastInclude,
        scenes: { orderBy: { orderIndex: "asc" } },
      },
    });

    res.status(201).json({ project });
  } catch (err) {
    console.error("POST /api/projects failed:", err);
    res.status(500).json({ error: "Failed to create project." });
  }
});

app.patch("/api/projects/:id", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const data: Record<string, unknown> = {};
    if (req.body?.title !== undefined) data.title = String(req.body.title).trim() || "Untitled Music Video";
    if (req.body?.concept !== undefined) data.concept = String(req.body.concept);
    if (req.body?.aspectRatio !== undefined && ["16:9", "9:16", "1:1"].includes(req.body.aspectRatio)) {
      data.aspectRatio = req.body.aspectRatio;
    }
    if (req.body?.videoType !== undefined) {
      data.videoType = normalizeVideoType(req.body.videoType);
    }
    if (req.body?.rawLyrics !== undefined) data.rawLyrics = String(req.body.rawLyrics);
    if (req.body?.lyricsJson !== undefined) data.lyricsJson = String(req.body.lyricsJson);
    if (req.body?.characterId !== undefined) data.characterId = req.body.characterId ? String(req.body.characterId) : null;
    if (req.body?.castMembers !== undefined) {
      const castMembers = normalizeCastInput(req.body.castMembers, req.body?.characterId);
      data.characterId = castMembers[0]?.artistId || null;
      data.castMembers = { deleteMany: {}, create: castMembers };
    }
    if (req.body?.status !== undefined) data.status = String(req.body.status);

    const project = await prisma.project.update({
      where: { id },
      data,
      include: {
        character: true,
        ...projectCastInclude,
        scenes: { orderBy: { orderIndex: "asc" } },
      },
    });

    res.json({ project });
  } catch (err) {
    console.error("PATCH /api/projects/:id failed:", err);
    res.status(500).json({ error: "Failed to update project." });
  }
});

app.delete("/api/projects/:id", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const existing = await prisma.project.findUnique({
      where: { id },
      include: { scenes: true },
    });
    if (!existing) {
      res.status(404).json({ error: "Project not found." });
      return;
    }
    await prisma.project.delete({ where: { id } });
    deletePublicAsset(existing.audioPath);
    deletePublicAsset(existing.vocalStemPath);
    deletePublicAsset(existing.finalVideoPath);
    for (const s of existing.scenes) {
      deletePublicAsset(s.imagePath);
      deletePublicAsset(s.videoPath);
    }
    fs.rmSync(path.join(PROJECTS_DIR, id), { recursive: true, force: true });
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/projects/:id failed:", err);
    res.status(500).json({ error: "Failed to delete project." });
  }
});

app.post("/api/projects/:id/analyze-audio", uploadAudioTrack.single("file"), async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const file = req.file;

  try {
    if (!file) {
      res.status(400).json({ error: "Please select an .mp3 or .wav audio file." });
      return;
    }

    const existing = await prisma.project.findUnique({ where: { id } });
    if (!existing) {
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
      res.status(404).json({ error: "Project not found." });
      return;
    }

    const projectDir = path.join(PROJECTS_DIR, id);
    fs.mkdirSync(projectDir, { recursive: true });

    const targetSongPath = path.join(projectDir, "song.mp3");
    const ext = path.extname(file.originalname || file.filename).toLowerCase();

    if (ext === ".mp3") {
      fs.renameSync(file.path, targetSongPath);
    } else {
      // Convert .wav (or other audio) cleanly to public/projects/[projectId]/song.mp3
      await execFileAsync("ffmpeg", [
        "-y",
        "-i",
        file.path,
        "-vn",
        "-codec:a",
        "libmp3lame",
        "-b:a",
        "192k",
        targetSongPath,
      ]);
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
    }

    const audioPath = `/projects/${id}/song.mp3`;

    // Persist song.mp3 immediately even before remote AI analysis
    const savedWithAudio = await prisma.project.update({
      where: { id },
      data: {
        audioPath,
        status: "audio_uploaded",
      },
      include: {
        character: true,
        ...projectCastInclude,
        scenes: { orderBy: { orderIndex: "asc" } },
      },
    });

    if (!getModalWhisperConfig()) {
      res.status(400).json({
        error: `Song saved to public/projects/${id}/song.mp3, but Hugging Face Whisper is not connected. Add MODAL_WHISPER_URL and MODAL_WHISPER_API_TOKEN to the app environment settings.`,
        project: savedWithAudio,
      });
      return;
    }
    if (!getModalDemucsConfig()) {
      res.status(400).json({
        error: `Song saved to public/projects/${id}/song.mp3, but Modal Demucs is not connected. Add MODAL_DEMUCS_URL and MODAL_DEMUCS_API_TOKEN to the app environment settings.`,
        project: savedWithAudio,
      });
      return;
    }

    // Whisper large-v3 runs from Hugging Face on Modal; Demucs remains a separate Modal service.
    const [whisperData, vocalStemPath] = await Promise.all([
      transcribeWithModalWhisper(targetSongPath),
      separateVocalsWithModalDemucs(targetSongPath, projectDir),
    ]);

    const rawChunks = Array.isArray(whisperData.chunks) ? whisperData.chunks : [];
    const rawWords = Array.isArray(whisperData.words) ? whisperData.words : [];
    const normalizedWords = rawWords
      .map((word) => ({
        text: String(word.text || "").trim(),
        startSec: Number(word.start ?? 0),
        endSec: Number(word.end ?? word.start ?? 0),
      }))
      .filter((word) => word.text.length > 0 && Number.isFinite(word.startSec) && Number.isFinite(word.endSec))
      .map((word) => ({
        ...word,
        startSec: Number(Math.max(0, word.startSec).toFixed(3)),
        endSec: Number(Math.max(word.startSec + 0.01, word.endSec).toFixed(3)),
      }))
      .sort((a, b) => a.startSec - b.startSec);

    const segments = rawChunks
      .map((chunk, idx) => {
        const text = String(chunk.text || "").trim();
        const start = Number(chunk.timestamp?.[0] ?? 0);
        const rawEnd = chunk.timestamp?.[1];
        const end = rawEnd !== null && rawEnd !== undefined ? Number(rawEnd) : Number((start + 4).toFixed(2));
        const words = normalizedWords.filter(
          (word) => word.endSec >= start && word.startSec <= end
        );
        return {
          orderIndex: idx,
          startSec: Number(start.toFixed(2)),
          endSec: Number(Math.max(start + 0.1, end).toFixed(2)),
          text,
          words,
        };
      })
      .filter((seg) => seg.text.length > 0);

    if (segments.length === 0 && whisperData.text) {
      segments.push({
        orderIndex: 0,
        startSec: 0,
        endSec: 8,
        text: String(whisperData.text).trim(),
        words: normalizedWords,
      });
    }

    // Modal Demucs has already saved the isolated 44.1 kHz vocal stem in the project folder.
    const isolatedVocalStemPath = vocalStemPath || existing.vocalStemPath;

    const updatedProject = await prisma.project.update({
      where: { id },
      data: {
        audioPath,
        vocalStemPath: isolatedVocalStemPath,
        lyricsJson: JSON.stringify(segments),
        status: "analyzed",
      },
      include: {
        character: true,
        ...projectCastInclude,
        scenes: { orderBy: { orderIndex: "asc" } },
      },
    });

    res.json({ project: updatedProject, segments });
  } catch (err) {
    if (file?.path && fs.existsSync(file.path)) {
      try {
        fs.unlinkSync(file.path);
      } catch {
        // ignore cleanup
      }
    }
    console.error("POST /api/projects/:id/analyze-audio failed:", err);
    const message = err instanceof Error ? err.message : "Audio analysis failed.";
    res.status(500).json({ error: message });
  }
});

app.post("/api/projects/:id/audio", uploadAudioTrack.single("file"), async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const file = req.file;
    const kind = req.body?.kind === "vocalStem" ? "vocalStem" : "audio";

    if (!file) {
      res.status(400).json({ error: "Please choose an audio file." });
      return;
    }

    const existing = await prisma.project.findUnique({ where: { id } });
    if (!existing) {
      deletePublicAsset(`/uploads/audio/${file.filename}`);
      res.status(404).json({ error: "Project not found." });
      return;
    }

    const relPath = `/uploads/audio/${file.filename}`;
    if (kind === "vocalStem") {
      deletePublicAsset(existing.vocalStemPath);
    } else {
      deletePublicAsset(existing.audioPath);
    }

    const project = await prisma.project.update({
      where: { id },
      data: kind === "vocalStem" ? { vocalStemPath: relPath } : { audioPath: relPath },
      include: {
        character: true,
        ...projectCastInclude,
        scenes: { orderBy: { orderIndex: "asc" } },
      },
    });

    res.json({ project });
  } catch (err) {
    console.error("POST /api/projects/:id/audio failed:", err);
    res.status(500).json({ error: "Failed to upload audio track." });
  }
});

// Split lyrics into timed scenes (uses Gemini director breakdown if requested & configured, else clean deterministic split)
const SHOT_ROTATION = [
  "Wide Establishing",
  "Medium Close-Up",
  "Tracking Side Shot",
  "Low-Angle Hero",
  "Extreme Close-Up",
  "Silhouette Backlit",
];

const MOTION_ROTATION = [
  "Slow dolly push-in, subtle atmospheric haze",
  "Gentle handheld sway, shallow focus rack",
  "Smooth lateral tracking glide across stage lights",
  "Slow crane tilt up with rim light flare",
  "Intimate breathing push-in on vocal delivery",
  "Steady wide hold with slow camera drift",
];

app.post("/api/projects/:id/split-lyrics", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const project = await prisma.project.findUnique({
      where: { id },
      include: { character: true, ...projectCastInclude },
    });
    if (!project) {
      res.status(404).json({ error: "Project not found." });
      return;
    }

    const rawLyrics = String(req.body?.rawLyrics ?? project.rawLyrics ?? "").trim();
    const secPerScene = Math.max(2, Math.min(16, Number(req.body?.secPerScene) || 4));
    const useAiDirector = Boolean(req.body?.useAiDirector);
    const useWhisperTimestamps = Boolean(req.body?.useWhisperTimestamps);
    const scopeMode = req.body?.scopeMode === "section" ? "section" : "full";
    const sectionStartSec = Math.max(0, Number(req.body?.sectionStartSec) || 0);
    const sectionEndSec = Number(req.body?.sectionEndSec) || 0;

    let whisperSegments: Array<{ orderIndex: number; startSec: number; endSec: number; text: string }> = [];
    try {
      const parsedJson = JSON.parse(project.lyricsJson || "[]");
      if (Array.isArray(parsedJson)) {
        whisperSegments = parsedJson.filter((item) => item && typeof item.text === "string" && item.text.trim().length > 0);
      }
    } catch {
      whisperSegments = [];
    }

    const filteredWhisperSegments =
      scopeMode === "section" && sectionEndSec > sectionStartSec
        ? whisperSegments.filter(
            (seg) => Number(seg.endSec) > sectionStartSec && Number(seg.startSec) < sectionEndSec
          )
        : whisperSegments;

    const lines =
      useWhisperTimestamps && filteredWhisperSegments.length > 0
        ? filteredWhisperSegments.map((s) => s.text.trim())
        : rawLyrics
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l.length > 0);

    if (lines.length === 0) {
      res.status(400).json({ error: "Enter at least one lyric line or run Whisper audio analysis first." });
      return;
    }

    const artistPrefix = project.character
      ? `${project.character.name} (${project.character.visualPrompt})`
      : "Performing vocalist";
    const conceptSuffix = project.concept ? `, ${project.concept}` : ", moody cinematic music video lighting";

    let draftedScenes: Array<{
      lyricSegment: string;
      shotType: string;
      imagePrompt: string;
      motionPrompt: string;
      durationSec: number;
    }> = [];

    const geminiKey = getGeminiKey();
    if (useAiDirector && geminiKey) {
      try {
        const ai = new GoogleGenAI({ apiKey: geminiKey });
        const prompt = `You are a music video director. Break these lyrics into ${Math.min(lines.length, 16)} visual scenes.
Artist: ${artistPrefix}
Concept: ${project.concept || "Moody nocturnal music video"}
Lyrics lines:
${lines.slice(0, 16).map((l, i) => `${i + 1}. ${l}`).join("\n")}

Return a JSON array where each element has:
- lyricSegment (string)
- shotType: return exactly "lipsync" ONLY for a close-up, medium-close-up, or extreme-close-up where one artist's face fills most of the frame and the mouth is clearly visible; return exactly "broll" for every other composition.
- imagePrompt (rich cinematic image prompt featuring the artist and scene mood, 1-2 sentences; explicitly state the framing)
LIP-SYNC GATING IS STRICT and applies in every video mode, including Performance: wide shots, establishing shots, full-body shots, group shots, backup-singer group shots, silhouettes, tracking side shots, and over-the-shoulder shots MUST be "broll". Only an intimate single-face close-up with the mouth clearly visible may be "lipsync". Never choose lipsync merely because the artist is performing or singing.
- motionPrompt (camera movement note, under 12 words)
- durationSec (number between 3 and 6)`;

        const aiResp = await ai.models.generateContent({
          model: "gemini-2.5-flash",
          contents: prompt,
          config: { responseMimeType: "application/json" },
        });

        const parsed = JSON.parse(aiResp.text || "[]");
        if (Array.isArray(parsed) && parsed.length > 0) {
          draftedScenes = parsed.map((item, idx) => ({
            lyricSegment: String(item.lyricSegment || lines[idx] || ""),
            shotType: (() => {
              const framing = String(item.shotType || "").toLowerCase();
              const imagePrompt = String(item.imagePrompt || "").toLowerCase();
              const excluded = /(wide|full[- ]?body|group|over[- ]the[- ]shoulder|establishing|tracking side|silhouette)/i.test(`${framing} ${imagePrompt}`);
              const closeUp = /(medium[- ]close[- ]up|extreme[- ]close[- ]up|close[- ]up|closeup)/i.test(framing) ||
                (framing === "lipsync" && /(face.{0,30}(fills|filling)|mouth.{0,30}(visible|frame)|close[- ]?up)/i.test(imagePrompt));
              return closeUp && !excluded ? "lipsync" : "broll";
            })(),
            imagePrompt: String(item.imagePrompt || `${artistPrefix}, ${lines[idx] || ""}${conceptSuffix}`),
            motionPrompt: String(item.motionPrompt || MOTION_ROTATION[idx % MOTION_ROTATION.length]),
            durationSec: Math.max(2, Math.min(12, Number(item.durationSec) || secPerScene)),
          }));
        }
      } catch (aiErr) {
        console.warn("Gemini storyboard fallback to deterministic split:", aiErr);
      }
    }

    if (draftedScenes.length === 0) {
      draftedScenes = lines.map((line, idx) => {
        const shotType = SHOT_ROTATION[idx % SHOT_ROTATION.length];
        return {
          lyricSegment: line,
          shotType: /(medium[- ]close[- ]up|extreme[- ]close[- ]up)/i.test(shotType) ? "lipsync" : "broll",
          imagePrompt: `${shotType} shot of ${artistPrefix} performing "${line}"${conceptSuffix}, 35mm anamorphic cinema still`,
          motionPrompt: MOTION_ROTATION[idx % MOTION_ROTATION.length],
          durationSec: secPerScene,
        };
      });
    }

    // Replace existing scenes cleanly
    const existingScenes = await prisma.scene.findMany({ where: { projectId: id } });
    for (const s of existingScenes) {
      deletePublicAsset(s.imagePath);
      deletePublicAsset(s.videoPath);
    }
    await prisma.scene.deleteMany({ where: { projectId: id } });

    let cursor = scopeMode === "section" ? sectionStartSec : 0;
    const lyricsTimeline: Array<{ orderIndex: number; startSec: number; endSec: number; text: string }> = [];

    for (let i = 0; i < draftedScenes.length; i++) {
      const item = draftedScenes[i];
      const matchedWhisper = useWhisperTimestamps ? filteredWhisperSegments[i] : undefined;
      const startSec = matchedWhisper ? Number(matchedWhisper.startSec) : Number(cursor.toFixed(1));
      const endSec = matchedWhisper
        ? Number(matchedWhisper.endSec)
        : Number((cursor + item.durationSec).toFixed(1));
      cursor = endSec;

      lyricsTimeline.push({
        orderIndex: i,
        startSec,
        endSec,
        text: item.lyricSegment,
      });

      await prisma.scene.create({
        data: {
          projectId: id,
          orderIndex: i,
          startSec,
          endSec,
          lyricSegment: item.lyricSegment,
          shotType: item.shotType,
          imagePrompt: item.imagePrompt,
          motionPrompt: item.motionPrompt,
          status: "pending",
        },
      });
    }

    const updated = await prisma.project.update({
      where: { id },
      data: {
        rawLyrics: rawLyrics || project.rawLyrics,
        lyricsJson: useWhisperTimestamps && whisperSegments.length > 0 ? project.lyricsJson : JSON.stringify(lyricsTimeline),
        status: "storyboarded",
      },
      include: {
        character: true,
        ...projectCastInclude,
        scenes: { orderBy: { orderIndex: "asc" } },
      },
    });

    res.json({ project: updated });
  } catch (err) {
    console.error("POST /api/projects/:id/split-lyrics failed:", err);
    res.status(500).json({ error: "Failed to build scenes from lyrics." });
  }
});

// ---------- AI Director Storyboard (OpenAI gpt-4o Structured JSON) ----------
const DIRECTOR_FRAMINGS = ["Wide", "Close-Up", "Medium Close-Up", "Low Angle", "Tracking"];

const MUSIC_VIDEO_TYPE_DIRECTIONS: Record<MusicVideoType, string> = {
  narrative:
    "Style: Narrative + Performance. Blend cinematic story B-roll scenes (around 60%) with emotional lip-synced vocal performance shots on choruses and key hooks (around 40%).",
  performance:
    "Style: Performance-forward. Keep the artist front-and-center in studio, spotlight, or concert setups, but obey the strict framing-based lip-sync gate: only face-filling close-ups may be lipsync; wide, full-body, group, and over-the-shoulder performance coverage is always broll.",
  visualizer:
    "Style: Cinematic B-Roll / Visualizer. Focus heavily on atmospheric visual storytelling, mood, and environmental metaphors (`shotType: 'broll'` for ~85-90% of shots, saving `lipsync` only for 1-2 peak chorus moments).",
  hype:
    "Style: High-Energy Rap / Dance Cut. Emphasize bold low-angle hero framing, rapid kinetic energy, hard-source stage strobes, sodium-amber practicals, direct-flash highlights, confident lip-sync hooks (`lipsync` on chorus/hook), and punchy kinetic B-roll.",
  retro:
    "Style: Retro 90s VHS / Analog Film. Warm halation, nostalgic 35mm film grain, candid late-night locations, intimate camcorder/stage textures, balancing soulful lip-sync and vintage B-roll.",
};

app.post("/api/projects/:id/generate-storyboard", async (req: Request, res: Response) => {
  const id = String(req.params.id);

  try {
    const openAiKey = getOpenAiKey();
    if (!openAiKey) {
      res.status(400).json({
        error: "OPENAI_API_KEY is not configured. Add OPENAI_API_KEY in Secrets to run GPT-4o AI Director.",
      });
      return;
    }

    const existingProject = await prisma.project.findUnique({
      where: { id },
      include: { character: true, ...projectCastInclude },
    });
    if (!existingProject) {
      res.status(404).json({ error: "Project not found." });
      return;
    }

    const rawLyrics = String(req.body?.rawLyrics ?? existingProject.rawLyrics ?? "").trim();
    const concept = String(req.body?.concept ?? existingProject.concept ?? "").trim();
    const nextTitle = req.body?.title !== undefined ? String(req.body.title).trim() || existingProject.title : existingProject.title;
    const nextAspectRatio =
      req.body?.aspectRatio !== undefined && ["16:9", "9:16", "1:1"].includes(req.body.aspectRatio)
        ? String(req.body.aspectRatio)
        : existingProject.aspectRatio;
    const nextVideoType =
      req.body?.videoType !== undefined
        ? normalizeVideoType(req.body.videoType)
        : normalizeVideoType(existingProject.videoType);
    const nextCastMembers = req.body?.castMembers !== undefined
      ? normalizeCastInput(req.body.castMembers, req.body?.characterId)
      : (existingProject.castMembers || []).map((entry: any) => ({
          artistId: entry.artistId, role: entry.role, appearanceNotes: entry.appearanceNotes, sortOrder: entry.sortOrder,
        }));
    const nextCharacterId = nextCastMembers[0]?.artistId || (
      req.body?.characterId !== undefined
        ? (req.body.characterId ? String(req.body.characterId) : null)
        : existingProject.characterId
    );

    const project = await prisma.project.update({
      where: { id },
      data: {
        title: nextTitle,
        concept,
        rawLyrics,
        aspectRatio: nextAspectRatio,
        videoType: nextVideoType,
        characterId: nextCharacterId,
        castMembers: { deleteMany: {}, create: nextCastMembers },
      },
      include: { character: true, ...projectCastInclude },
    });

    let whisperSegments: Array<{
      startSec: number;
      endSec: number;
      text: string;
      words?: Array<{ text: string; startSec: number; endSec: number }>;
    }> = [];
    try {
      const parsed = JSON.parse(project.lyricsJson || "[]");
      if (Array.isArray(parsed)) {
        whisperSegments = parsed.filter((item) => item && typeof item.text === "string");
      }
    } catch {
      whisperSegments = [];
    }

    const timestampedWords = whisperSegments.flatMap((segment) => {
      if (Array.isArray(segment.words) && segment.words.length > 0) {
        return segment.words.map((word) => ({
          text: String(word.text || "").trim(),
          startSec: Number(word.startSec),
          endSec: Number(word.endSec),
        }));
      }
      // Backward compatibility for projects transcribed before word timestamps
      // were stored: retain the old phrase's timing rather than losing lyrics.
      return [{
        text: String(segment.text || "").trim(),
        startSec: Number(segment.startSec),
        endSec: Number(segment.endSec),
      }];
    }).filter((word) =>
      word.text.length > 0 &&
      Number.isFinite(word.startSec) &&
      Number.isFinite(word.endSec) &&
      word.endSec >= word.startSec
    ).sort((a, b) => a.startSec - b.startSec);

    const audioDuration = await getAudioDurationSec(project.audioPath);
    const whisperEnd =
      whisperSegments.length > 0 ? Math.max(...whisperSegments.map((s) => Number(s.endSec) || 0)) : 0;
    const songDurationSec = Number(Math.max(12, audioDuration || whisperEnd || 36).toFixed(1));

    const scopeMode = req.body?.scopeMode === "section" ? "section" : "full";
    const rangeStart =
      scopeMode === "section"
        ? Number(Math.max(0, Math.min(songDurationSec - 4, Number(req.body?.sectionStartSec) || 0)).toFixed(1))
        : 0;
    const requestedEnd = Number(req.body?.sectionEndSec);
    const rangeEnd =
      scopeMode === "section"
        ? Number(
            Math.min(
              songDurationSec,
              Math.max(rangeStart + 4, Number.isFinite(requestedEnd) && requestedEnd > 0 ? requestedEnd : rangeStart + 30)
            ).toFixed(1)
          )
        : songDurationSec;

    const targetSpanSec = Number((rangeEnd - rangeStart).toFixed(1));
    const openai = new OpenAI({ apiKey: openAiKey });

    // Split selected range (or full song) into ~45s windows run in parallel
    const WINDOW_SEC = 45;
    const windows: Array<{ index: number; start: number; end: number }> = [];
    if (targetSpanSec <= 55) {
      windows.push({ index: 0, start: rangeStart, end: rangeEnd });
    } else {
      let wStart = rangeStart;
      let idx = 0;
      while (wStart < rangeEnd - 1) {
        const remaining = rangeEnd - wStart;
        const wEnd = remaining <= 55 ? rangeEnd : Number((wStart + WINDOW_SEC).toFixed(1));
        windows.push({ index: idx, start: wStart, end: wEnd });
        wStart = wEnd;
        idx += 1;
      }
    }

    const storyboardSchema = {
      name: "music_video_storyboard",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["scenes"],
        properties: {
          scenes: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: [
                "startSec",
                "endSec",
                "lyricSegment",
                "shotType",
                "framing",
                "imagePrompt",
                "motionPrompt",
                "castArtistIds",
              ],
              properties: {
                startSec: { type: "number" },
                endSec: { type: "number" },
                lyricSegment: { type: "string" },
                shotType: { type: "string", enum: ["lipsync", "broll"] },
                framing: { type: "string", enum: ["Wide", "Close-Up", "Medium Close-Up", "Low Angle", "Tracking"] },
                imagePrompt: { type: "string" },
                motionPrompt: { type: "string" },
                castArtistIds: { type: "array", items: { type: "string" }, maxItems: 4 },
              },
            },
          },
        },
      },
    } as const;

    const castProfiles = (project.castMembers || []).length
      ? project.castMembers.map((entry: any) => ({
          artistId: entry.artistId, name: entry.artist.name, role: entry.role,
          physicalDescription: entry.artist.visualPrompt,
          outfitLock: entry.appearanceNotes || "Preserve the artist's reference portrait styling.",
          referenceImageUrl: entry.artist.refImagePath, sortOrder: entry.sortOrder,
        }))
      : project.character
        ? [{ artistId: project.character.id, name: project.character.name, role: "Lead Vocalist",
             physicalDescription: project.character.visualPrompt, outfitLock: "Preserve reference portrait styling.",
             referenceImageUrl: project.character.refImagePath, sortOrder: 1 }]
        : [];
    const charProfile = castProfiles[0]
      ? { ...castProfiles[0], visualPrompt: castProfiles[0].physicalDescription }
      : { name: "Lead Vocalist", visualPrompt: "Expressive performing singer in stylish evening wardrobe" };

    const styleGuidance = MUSIC_VIDEO_TYPE_DIRECTIONS[nextVideoType];

    const shotWindowsByWindow = windows.map((win) => {
      const winDur = win.end - win.start;
      const targetShots = Math.max(1, Math.round(winDur / 4.5));
      return Array.from({ length: targetShots }, (_, shotIndex) => {
        const startSec = Number((win.start + (winDur * shotIndex) / targetShots).toFixed(3));
        const endSec = Number((win.start + (winDur * (shotIndex + 1)) / targetShots).toFixed(3));
        const lyricSegment = timestampedWords
          .filter((word) => {
            // Assign a word to exactly one shot even when its timestamp crosses
            // a shot boundary.
            const midpoint = (word.startSec + word.endSec) / 2;
            return midpoint >= startSec && midpoint < endSec;
          })
          .map((word) => word.text)
          .join(" ")
          .trim();
        return {
          startSec,
          endSec,
          lyricSegment: lyricSegment || "Instrumental performance",
        };
      });
    });
    const allShotWindows = shotWindowsByWindow.flat();

    const chunkResults = await Promise.all(
      windows.map(async (win) => {
        const shotWindows = shotWindowsByWindow[win.index] || [];
        const targetShots = shotWindows.length;
        const localSegments = whisperSegments.filter(
          (seg) => Number(seg.endSec) > win.start && Number(seg.startSec) < win.end
        );

        const systemPrompt = `You are an award-winning, bold music-video cinematographer and lyric-first visual storyteller directing Act ${win.index + 1} of ${windows.length} (${win.start}s-${win.end}s of a ${songDurationSec}s song).
${styleGuidance}

DIRECTOR'S BRIEF
Create exactly ${targetShots} shots. The supplied shotWindows are authoritative: use each shot's exact startSec, endSec, and lyricSegment. They are consecutive, cover the complete act, and have no gaps.
For EVERY shot, translate the exact words sung in that timestamp window into a literal, filmable visual idea. Identify the lyrics' concrete nouns, verbs, objects, places, relationships, stakes, and emotional temperature; show those specific things happening on screen. Do not merely restate the mood. Do not recycle the same generic performance scene. If a shot window contains words, its lyricSegment must contain those exact words in their original order. Use "Instrumental performance" only when the supplied shot window has no words.

VISUAL CONCEPT
Use the user's Visual Concept when it is non-empty. If it is blank, invent a distinctive concept from the song title, artist description, music-video style, and the actual lyrics. Do NOT default to a nocturnal city, alley, street, club, or generic cinematic mood. Make each scene's location and visual metaphor earn its place from the lyric.

HARD BANS
Never use or paraphrase these tired AI-video clichés: "dimly lit urban alley", "wet cobblestones", "neon lights", "contemplative expression", "standing in the dim light", "static position", or "gently swaying". Also avoid generic rain-soaked streets, anonymous smoke-filled rooms, random city skylines, empty staring, and vague "cinematic atmosphere" in place of a lyric-specific event.

SHOT VARIETY — REQUIRED
Aggressively vary consecutive shots. Rotate the supplied framing values Wide, Close-Up, Low Angle, and Tracking, and make their visual scale unmistakable:
- Wide: monumental wide architectural silhouette, landscape-scale composition, or tiny figure against a consequential environment.
- Close-Up: extreme macro insert of a lyric-specific object/detail OR tight facial close-up capturing a precise raw emotion.
- Low Angle: Dutch-angle low hero shot with a forceful physical gesture or consequential action.
- Tracking: kinetic lateral/low tracking composition with foreground parallax and a clear moving subject.
Never repeat the same shot scale, composition, setting, lighting setup, or central action in adjacent shots.

STRICT LIP-SYNC ELIGIBILITY — OVERRIDES EVERY STYLE DIRECTION ABOVE, INCLUDING PERFORMANCE MODE:
Set shotType to "lipsync" ONLY when framing is "Close-Up" or "Medium Close-Up", one artist's face fills most of the frame, and the mouth is clearly visible for accurate lip animation. All Wide, full-body, group, backup-singer group, silhouette, Tracking, and over-the-shoulder shots MUST be shotType "broll". A performance scene is NOT automatically a lipsync scene. When uncertain, choose "broll". Never assign lipsync to a shot where the face is small, obscured, profile-distant, or shared with multiple people.

MOTIVATED LIGHT AND CAMERA
Choose lighting that dramatizes the actual lyric: headlights cutting through dust or smoke, sodium-vapor amber against cold steel blue, harsh direct flash, welding sparks, dashboard glow, hard noon sun, projector flicker, sunrise edge light, or another motivated source. Do not use neon.
For B-roll motionPrompt, write specific kinetic camera choreography: crash zooms, whip pans, low-angle tracking pushes, fast orbit reveals, handheld impact shake, snap reframes, or aggressive rack-focus moves, tied to the action in the lyric. For lipsync shots, keep the artist's face and upper body cleanly framed and readable; use controlled dolly or restrained push with stable facial framing, never chaotic shake across the mouth.
Each imagePrompt describes a single coherent still frame: artist/subject identity, lyric-specific action and objects, wardrobe, motivated lighting, environment, composition, and tactile film detail. Do not put camera-motion instructions in imagePrompt. Each motionPrompt describes movement only.

MULTI-ARTIST CAST LOCK — ABSOLUTE:
Use only the supplied cast profiles. For every shot, return castArtistIds containing the exact artistId values for every cast member visibly appearing in that shot. Assign Lead Vocalist to main verses and choruses; Featured Artist to their feature/rap verse; Backup Vocalists to group/wide stage shots or backing-vocal moments; Co-Star / Love Interest only where lyrics and story call for them. A shot may include multiple IDs. Never invent, merge, swap, or duplicate identities. Every imagePrompt MUST name each appearing artist exactly, state their assigned role, physical description, and exact outfit lock. Preserve each artist's distinct face, hair, body, and wardrobe in every shot. If no artist should appear, return an empty castArtistIds array and describe a non-performer visual.

Return the exact JSON schema requested. Do not add keys, markdown, commentary, or prose.`;

        const userPayload = {
          songTitle: project.title,
          artistDescription: charProfile.visualPrompt,
          artist: charProfile,
          castMembers: castProfiles,
          musicVideoStyle: nextVideoType,
          musicVideoStyleGuidance: styleGuidance,
          aspectRatio: project.aspectRatio,
          scopeMode,
          windowStartSec: win.start,
          windowEndSec: win.end,
          targetShotCount: targetShots,
          visualConcept: concept || null,
          fullRawLyrics: rawLyrics || null,
          shotWindows,
          windowWhisperSegments: localSegments,
        };

        const completion = await openai.chat.completions.create({
          model: "gpt-4o",
          temperature: 0.7,
          max_tokens: 4096,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: JSON.stringify(userPayload) },
          ],
          response_format: {
            type: "json_schema",
            json_schema: storyboardSchema,
          },
        });

        const content = completion.choices[0]?.message?.content;
        if (!content) {
          throw new Error(`GPT-4o returned empty content for segment ${win.start}s-${win.end}s.`);
        }
        const parsed = JSON.parse(content) as {
          scenes?: Array<{
            startSec: number;
            endSec: number;
            lyricSegment: string;
            shotType: "lipsync" | "broll";
            framing: string;
            imagePrompt: string;
            motionPrompt: string;
            castArtistIds: string[];
          }>;
        };
        return Array.isArray(parsed.scenes) ? parsed.scenes : [];
      })
    );

    const rawScenes = chunkResults.flat();
    if (rawScenes.length === 0) {
      throw new Error("GPT-4o did not return any storyboard scenes.");
    }

    // Normalize timeline to guarantee consecutive 4.0-5.5s shots starting at rangeStart with zero gaps
    const existingScenes = await prisma.scene.findMany({ where: { projectId: id } });
    for (const s of existingScenes) {
      deletePublicAsset(s.imagePath);
      deletePublicAsset(s.videoPath);
    }
    await prisma.scene.deleteMany({ where: { projectId: id } });

    let cursor = rangeStart;
    for (let i = 0; i < rawScenes.length; i++) {
      const item = rawScenes[i];
      const plannedWindow = allShotWindows[i];
      const rawDur = Number(item.endSec) - Number(item.startSec);
      const fallbackDuration = Number(Math.min(5.5, Math.max(4.0, Number.isFinite(rawDur) ? rawDur : 4.5)).toFixed(2));
      const startSec = Number((plannedWindow?.startSec ?? cursor).toFixed(2));
      const endSec = Number((plannedWindow?.endSec ?? (startSec + fallbackDuration)).toFixed(2));
      cursor = endSec;

      const framing = String(item.framing || DIRECTOR_FRAMINGS[i % DIRECTOR_FRAMINGS.length]);
      const framingText = framing.toLowerCase();
      const imagePromptText = String(item.imagePrompt || "").toLowerCase();
      const excludedComposition = /(wide|full[- ]?body|group|over[- ]the[- ]shoulder|tracking|silhouette|establishing)/i.test(`${framingText} ${imagePromptText}`);
      const closeFaceComposition = /(close[- ]?up|medium close)/i.test(framingText) &&
        /(face|facial).{0,60}(fills|filling|dominates|occupies)|(fills|filling|dominates|occupies).{0,60}(frame|screen)|mouth.{0,35}(clearly visible|visible in frame)/i.test(imagePromptText);
      const shotType = item.shotType === "lipsync" && closeFaceComposition && !excludedComposition ? "lipsync" : "broll";
      const assignedCastIds = Array.isArray(item.castArtistIds)
        ? item.castArtistIds.filter((artistId) => castProfiles.some((cast: any) => cast.artistId === artistId)).slice(0, 4)
        : (castProfiles[0] ? [castProfiles[0].artistId] : []);
      const enforcedCastLock = assignedCastIds.map((artistId) => {
        const cast: any = castProfiles.find((entry: any) => entry.artistId === artistId);
        return cast ? cast.name + " (" + cast.role + "); physical description: " + cast.physicalDescription +
          "; exact outfit lock: " + cast.outfitLock : "";
      }).filter(Boolean).join(" | ");
      const enforcedImagePrompt = String(item.imagePrompt || "").trim() +
        (enforcedCastLock ? " CAST IDENTITY AND WARDROBE LOCK — " + enforcedCastLock +
          ". Keep each named artist's face, hair, body, and outfit distinct and unchanged; never swap identities or wardrobe." : "");
      const motionText = String(item.motionPrompt || "").trim();
      const motionWithFraming = motionText.toLowerCase().includes(framing.toLowerCase())
        ? motionText
        : `${framing} framing — ${motionText}`;

      await prisma.scene.create({
        data: {
          projectId: id,
          orderIndex: i,
          startSec,
          endSec,
          // Use word timestamps for the actual shot window, not GPT's paraphrase
          // or an entire multi-minute Whisper segment.
          lyricSegment: plannedWindow?.lyricSegment || "Instrumental performance",
          shotType,
          imagePrompt: enforcedImagePrompt,
          motionPrompt: motionWithFraming,
          castArtistIds: JSON.stringify(assignedCastIds),
          status: "pending",
        },
      });
    }

    const updated = await prisma.project.update({
      where: { id },
      data: {
        status: "storyboarded",
      },
      include: {
        character: true,
        ...projectCastInclude,
        scenes: { orderBy: { orderIndex: "asc" } },
      },
    });

    res.json({ project: updated });
  } catch (err) {
    console.error("POST /api/projects/:id/generate-storyboard failed:", err);
    const message = err instanceof Error ? err.message : "Failed to generate AI Director storyboard.";
    res.status(500).json({ error: message });
  }
});

async function generateSceneWithProjectCast(params: {
  projectId: string;
  orderIndex: number;
  aspectRatio: string;
  imagePrompt: string;
  lyricSegment: string;
  castMembers: Array<{
    artistId: string; role: string; appearanceNotes: string | null;
    artist: { id: string; name: string; visualPrompt: string; refImagePath: string };
  }>;
  castArtistIds: string;
  legacyArtist?: { id: string; name: string; visualPrompt: string; refImagePath: string } | null;
}): Promise<string> {
  const members = params.castMembers.length ? params.castMembers : params.legacyArtist ? [{
    artistId: params.legacyArtist.id, role: "Lead Vocalist", appearanceNotes: null, artist: params.legacyArtist,
  }] : [];
  let ids: string[] = [];
  try { ids = JSON.parse(params.castArtistIds || "[]"); } catch { ids = []; }
  if (!ids.length && members.length) ids = [members[0].artistId];
  const appearing = ids.map((id) => members.find((entry) => entry.artistId === id)).filter(Boolean) as typeof members;
  const primary = appearing[0] || members[0];
  const lockedVisuals = appearing.map((entry) =>
    entry.artist.name + " — " + entry.role + ". Physical identity: " + entry.artist.visualPrompt +
    ". Outfit lock: " + (entry.appearanceNotes || "preserve styling from this artist's reference portrait") +
    ". Keep this person visually distinct; never transfer their face, hair, or clothing to another cast member."
  ).join(" GROUP CAST LOCK: ");
  return generateSceneKeyframeWithFlux({
    projectId: params.projectId,
    orderIndex: params.orderIndex,
    aspectRatio: params.aspectRatio,
    imagePrompt: (lockedVisuals ? "GROUP CAST LOCK: " + lockedVisuals + ". " : "") + params.imagePrompt,
    lyricSegment: params.lyricSegment,
    characterName: primary?.artist.name || null,
    characterVisualPrompt: primary?.artist.visualPrompt || null,
    characterRefPath: primary?.artist.refImagePath || null,
  });
}

// ---------- Generate All Keyframes (Modal FLUX) ----------
app.post("/api/projects/:id/generate-keyframes", async (req: Request, res: Response) => {
  const id = String(req.params.id);

  try {
    const project = await prisma.project.findUnique({
      where: { id },
      include: {
        character: true,
        ...projectCastInclude,
        scenes: { orderBy: { orderIndex: "asc" } },
      },
    });
    if (!project) {
      res.status(404).json({ error: "Project not found." });
      return;
    }
    if (project.scenes.length === 0) {
      res.status(400).json({ error: "Generate or add storyboard scenes first." });
      return;
    }

    // Up to eight FLUX requests in flight, with 250ms staggered dispatch.
    let nextKeyframeIndex = 0;
    const keyframeWorkers = Array.from(
      { length: Math.min(8, project.scenes.length) },
      async (_, workerIndex) => {
        if (workerIndex > 0) await sleep(workerIndex * 250);
        while (true) {
          const index = nextKeyframeIndex++;
          if (index >= project.scenes.length) break;
          const scene = project.scenes[index];
          const imagePath = await generateSceneWithProjectCast({
            projectId: project.id,
            orderIndex: scene.orderIndex,
            aspectRatio: project.aspectRatio,
            imagePrompt: scene.imagePrompt,
            lyricSegment: scene.lyricSegment,
            castMembers: project.castMembers || [],
            castArtistIds: scene.castArtistIds || "[]",
            legacyArtist: project.character,
          });
          await prisma.scene.update({
            where: { id: scene.id },
            data: { imagePath, status: "ready" },
          });
          await sleep(250);
        }
      }
    );
    await Promise.all(keyframeWorkers);

    const updated = await prisma.project.update({
      where: { id },
      data: { status: "keyframes_ready" },
      include: {
        character: true,
        ...projectCastInclude,
        scenes: { orderBy: { orderIndex: "asc" } },
      },
    });
    res.json({ project: updated });
  } catch (err) {
    console.error("POST /api/projects/:id/generate-keyframes failed:", err);
    const message = err instanceof Error ? err.message : "Failed to generate all keyframes.";
    res.status(500).json({ error: message });
  }
});

// ---------- MV Studio: Scenes ----------
app.post("/api/projects/:id/scenes", async (req: Request, res: Response) => {
  try {
    const projectId = String(req.params.id);
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: { character: true, scenes: { orderBy: { orderIndex: "asc" } } },
    });
    if (!project) {
      res.status(404).json({ error: "Project not found." });
      return;
    }

    const lastScene = project.scenes[project.scenes.length - 1];
    const nextIndex = lastScene ? lastScene.orderIndex + 1 : 0;
    const startSec = lastScene ? lastScene.endSec : 0;
    const endSec = Number((startSec + 4).toFixed(1));
    const artistPrefix = project.character ? `${project.character.name} (${project.character.visualPrompt})` : "Performing artist";

    const scene = await prisma.scene.create({
      data: {
        projectId,
        orderIndex: nextIndex,
        startSec,
        endSec,
        lyricSegment: String(req.body?.lyricSegment || ""),
        shotType: String(req.body?.shotType || SHOT_ROTATION[nextIndex % SHOT_ROTATION.length]),
        imagePrompt: String(req.body?.imagePrompt || `${artistPrefix}, ${project.concept || "cinematic stage atmosphere"}`),
        motionPrompt: String(req.body?.motionPrompt || MOTION_ROTATION[nextIndex % MOTION_ROTATION.length]),
        status: "pending",
      },
    });

    res.status(201).json({ scene });
  } catch (err) {
    console.error("POST /api/projects/:id/scenes failed:", err);
    res.status(500).json({ error: "Failed to add scene." });
  }
});

app.patch("/api/scenes/:id", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const data: Record<string, unknown> = {};
    if (req.body?.orderIndex !== undefined) data.orderIndex = Number(req.body.orderIndex);
    if (req.body?.startSec !== undefined) data.startSec = Number(req.body.startSec);
    if (req.body?.endSec !== undefined) data.endSec = Number(req.body.endSec);
    if (req.body?.lyricSegment !== undefined) data.lyricSegment = String(req.body.lyricSegment);
    if (req.body?.shotType !== undefined) data.shotType = String(req.body.shotType);
    if (req.body?.imagePrompt !== undefined) data.imagePrompt = String(req.body.imagePrompt);
    if (req.body?.motionPrompt !== undefined) data.motionPrompt = String(req.body.motionPrompt);
    if (req.body?.castArtistIds !== undefined) {
      const ids = Array.isArray(req.body.castArtistIds) ? req.body.castArtistIds : [];
      if (ids.length > 4) throw new Error("A shot can include up to 4 cast members.");
      data.castArtistIds = JSON.stringify([...new Set(ids.map((v: unknown) => String(v)))]);
    }
    if (req.body?.status !== undefined) data.status = String(req.body.status);

    const scene = await prisma.scene.update({ where: { id }, data });
    res.json({ scene });
  } catch (err) {
    console.error("PATCH /api/scenes/:id failed:", err);
    res.status(500).json({ error: "Failed to update scene." });
  }
});

app.delete("/api/scenes/:id", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const existing = await prisma.scene.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ error: "Scene not found." });
      return;
    }
    await prisma.scene.delete({ where: { id } });
    deletePublicAsset(existing.imagePath);
    deletePublicAsset(existing.videoPath);

    const remaining = await prisma.scene.findMany({
      where: { projectId: existing.projectId },
      orderBy: { orderIndex: "asc" },
    });
    for (let i = 0; i < remaining.length; i++) {
      if (remaining[i].orderIndex !== i) {
        await prisma.scene.update({
          where: { id: remaining[i].id },
          data: { orderIndex: i },
        });
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/scenes/:id failed:", err);
    res.status(500).json({ error: "Failed to delete scene." });
  }
});

app.post("/api/scenes/:id/upload-image", uploadScenePhoto.single("photo"), async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "Please select a scene image." });
      return;
    }
    const existing = await prisma.scene.findUnique({ where: { id } });
    if (!existing) {
      deletePublicAsset(`/scenes/${file.filename}`);
      res.status(404).json({ error: "Scene not found." });
      return;
    }
    deletePublicAsset(existing.imagePath);
    const scene = await prisma.scene.update({
      where: { id },
      data: {
        imagePath: `/scenes/${file.filename}`,
        status: "ready",
      },
    });
    res.json({ scene });
  } catch (err) {
    console.error("POST /api/scenes/:id/upload-image failed:", err);
    res.status(500).json({ error: "Failed to upload scene frame." });
  }
});

app.post("/api/scenes/:id/generate-image", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const scene = await prisma.scene.findUnique({
      where: { id },
      include: { project: { include: { character: true, ...projectCastInclude } } },
    });
    if (!scene) {
      res.status(404).json({ error: "Scene not found." });
      return;
    }

    const imagePath = await generateSceneWithProjectCast({
      projectId: scene.projectId,
      orderIndex: scene.orderIndex,
      aspectRatio: scene.project.aspectRatio,
      imagePrompt: scene.imagePrompt,
      lyricSegment: scene.lyricSegment,
      castMembers: scene.project.castMembers || [],
      castArtistIds: scene.castArtistIds || "[]",
      legacyArtist: scene.project.character,
    });

    const updated = await prisma.scene.update({
      where: { id },
      data: { imagePath, status: "ready" },
    });
    res.json({ scene: updated });
  } catch (err) {
    console.error("POST /api/scenes/:id/generate-image failed:", err);
    const message = err instanceof Error ? err.message : "Failed to generate scene frame.";
    res.status(500).json({ error: message });
  }
});

// ---------- MV Studio: Render Final Music Video Pipeline ----------
interface RenderJobSceneStatus {
  orderIndex: number;
  shotType: string;
  state: "queued" | "rendering" | "done" | "error";
  label: string;
}

type RenderQualityMode = "budget" | "turbo" | "master";

interface RenderJob {
  projectId: string;
  status: "running" | "completed" | "failed";
  qualityMode?: RenderQualityMode;
  totalScenes: number;
  completedScenes: number;
  currentSceneIndex: number | null;
  currentStep: string;
  scenes: Record<string, RenderJobSceneStatus>;
  error: string | null;
  startedAt: number;
}

const renderJobs = new Map<string, RenderJob>();

async function preSliceLipSyncAudio(
  scenes: Array<{ orderIndex: number; startSec: number; endSec: number }>,
  sourceAudioAbs: string,
  projectDir: string
): Promise<Map<number, string>> {
  const slices = new Map<number, string>();
  if (scenes.length === 0) return slices;
  const filters: string[] = [];
  const args: string[] = ["-y", "-i", sourceAudioAbs, "-filter_complex"];
  scenes.forEach((scene, index) => {
    const start = Math.max(0, Number(scene.startSec) || 0);
    const duration = Math.max(1, Number((scene.endSec - scene.startSec).toFixed(2)) || 4.5);
    filters.push(`[0:a]atrim=start=${start}:duration=${duration},asetpts=PTS-STARTPTS,aresample=44100,aformat=sample_fmts=s16:channel_layouts=mono[vocal${index}]`);
    slices.set(scene.orderIndex, path.join(projectDir, `vocal_${scene.orderIndex}.wav`));
  });
  args.push(filters.join(";"));
  scenes.forEach((scene, index) => {
    args.push("-map", `[vocal${index}]`, "-c:a", "pcm_s16le", slices.get(scene.orderIndex)!);
  });
  await execFileAsync("ffmpeg", args, { maxBuffer: 16 * 1024 * 1024 });
  return slices;
}

async function runRenderPipeline(
  projectId: string,
  job: RenderJob,
  qualityMode: RenderQualityMode = "turbo"
): Promise<void> {
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: {
        character: true,
        ...projectCastInclude,
        scenes: { orderBy: { orderIndex: "asc" } },
      },
    });
    if (!project) {
      throw new Error("Project not found.");
    }

    const readyScenes = project.scenes.filter((s) => Boolean(s.imagePath));
    if (readyScenes.length === 0) {
      throw new Error("At least one scene needs an image frame before rendering.");
    }

    const { width, height } = getDimensionsForAspectRatio(project.aspectRatio);
    const fps = 24;
    const projectDir = path.join(PROJECTS_DIR, project.id);
    fs.mkdirSync(projectDir, { recursive: true });

    const defaultVocalsAbs = path.join(projectDir, "vocals.wav");
    const vocalStemAbs = project.vocalStemPath
      ? path.join(PUBLIC_DIR, project.vocalStemPath.replace(/^\/+/, ""))
      : null;
    const songAbs = fs.existsSync(path.join(projectDir, "song.mp3"))
      ? path.join(projectDir, "song.mp3")
      : project.audioPath
      ? path.join(PUBLIC_DIR, project.audioPath.replace(/^\/+/, ""))
      : null;

    const lipsyncAudioSourceAbs = fs.existsSync(defaultVocalsAbs)
      ? defaultVocalsAbs
      : vocalStemAbs && fs.existsSync(vocalStemAbs)
      ? vocalStemAbs
      : songAbs && fs.existsSync(songAbs)
      ? songAbs
      : null;

    const lipSyncScenes = readyScenes.filter((scene) => scene.shotType === "lipsync");
    const vocalSlices = new Map<number, string>();
    if (lipSyncScenes.length > 0) {
      if (!lipsyncAudioSourceAbs) {
        throw new Error("Lip-sync shots need vocals.wav or the uploaded song audio, but no source audio was found.");
      }
      job.currentStep = `Pre-slicing ${lipSyncScenes.length} vocal segments in one FFmpeg pass...`;
      const preparedSlices = await preSliceLipSyncAudio(lipSyncScenes, lipsyncAudioSourceAbs, projectDir);
      for (const [orderIndex, slicePath] of preparedSlices) vocalSlices.set(orderIndex, slicePath);
    }

    const orderedClipPaths: Array<string | null> = new Array(readyScenes.length).fill(null);
    const CONCURRENCY = Math.min(8, readyScenes.length);
    let nextQueueIdx = 0;
    const activeShotNumbers = new Set<number>();

    const updateParallelStep = () => {
      const activeList = Array.from(activeShotNumbers)
        .sort((a, b) => a - b)
        .map((n) => `#${n}`)
        .join(", ");
      job.currentStep = activeList
        ? `Rendering shots ${activeList} in parallel (${job.completedScenes}/${readyScenes.length} complete)`
        : `Processed ${job.completedScenes}/${readyScenes.length} scenes`;
    };

    const renderSingleScene = async (i: number): Promise<void> => {
      const s = readyScenes[i];
      const shotNum = s.orderIndex + 1;
      const srcImgAbs = path.join(PUBLIC_DIR, String(s.imagePath).replace(/^\/+/, ""));
      if (!fs.existsSync(srcImgAbs)) {
        job.scenes[s.id] = {
          orderIndex: s.orderIndex,
          shotType: s.shotType,
          state: "error",
          label: "Missing keyframe image on disk",
        };
        return;
      }

      const duration = Math.max(1, Number((s.endSec - s.startSec).toFixed(2)) || 4.5);
      const rawClipAbs = path.join(projectDir, `raw_clip_${s.orderIndex}.mp4`);
      const finalClipAbs = path.join(projectDir, `clip_${s.orderIndex}.mp4`);

      activeShotNumbers.add(shotNum);
      job.currentSceneIndex = s.orderIndex;
      updateParallelStep();

      try {
        if (s.shotType === "lipsync") {
          if (!getModalLipsyncConfig()) throw new Error("Modal MuseTalk is not connected. Configure MODAL_LIPSYNC_URL and MODAL_LIPSYNC_API_TOKEN in Render.");
          if (!lipsyncAudioSourceAbs) {
            throw new Error(
              `Shot ${shotNum} is marked 'lipsync', but vocals.wav / song.mp3 was not found.`
            );
          }

          job.scenes[s.id] = {
            orderIndex: s.orderIndex,
            shotType: s.shotType,
            state: "rendering",
            label: "Slicing vocals.wav & running MuseTalk lip-sync...",
          };

          const vocalSliceAbs = vocalSlices.get(s.orderIndex);
          if (!vocalSliceAbs || !fs.existsSync(vocalSliceAbs)) {
            throw new Error(`Pre-sliced vocal audio for Shot ${shotNum} is missing.`);
          }

          // Preserve the existing still-image-to-video input before lip-sync.
          const baseLipsyncVideoAbs = path.join(projectDir, `base_lipsync_${s.orderIndex}.mp4`);
          const vfBase = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},format=yuv420p`;

          await execFileAsync("ffmpeg", [
            "-y",
            "-framerate",
            String(fps),
            "-loop",
            "1",
            "-i",
            srcImgAbs,
            "-vf",
            vfBase,
            "-t",
            String(duration),
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            baseLipsyncVideoAbs,
          ]);

          await runMuseTalkWithModal(baseLipsyncVideoAbs, vocalSliceAbs, rawClipAbs, shotNum);
          if (fs.existsSync(baseLipsyncVideoAbs)) fs.unlinkSync(baseLipsyncVideoAbs);
        } else {
          const motionPrompt =
            s.motionPrompt || "Smooth cinematic camera movement, atmospheric 35mm music video motion";
          const ratioArg: "9:16" | "1:1" | "16:9" =
            project.aspectRatio === "9:16"
              ? "9:16"
              : project.aspectRatio === "1:1"
              ? "1:1"
              : "16:9";

          const modeLabel = "Animating via LTX-2.5 on Modal...";

          job.scenes[s.id] = {
            orderIndex: s.orderIndex,
            shotType: s.shotType,
            state: "rendering",
            label: modeLabel,
          };

          await generateVideoWithModalLtx(srcImgAbs, motionPrompt, ratioArg, rawClipAbs);
        }

        // Trim/scale downloaded clip to exact (endSec - startSec) at 24fps (1920x1080 or 1080x1920)
        job.scenes[s.id] = {
          orderIndex: s.orderIndex,
          shotType: s.shotType,
          state: "rendering",
          label: `Scaling & trimming to ${duration}s @ 24fps...`,
        };

        await execFileAsync("ffmpeg", [
          "-y",
          "-i",
          rawClipAbs,
          "-vf",
          `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=${fps},format=yuv420p`,
          "-t",
          String(duration),
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-pix_fmt",
          "yuv420p",
          "-an",
          finalClipAbs,
        ]);

        if (fs.existsSync(rawClipAbs)) fs.unlinkSync(rawClipAbs);

        orderedClipPaths[i] = finalClipAbs;
        await prisma.scene.update({
          where: { id: s.id },
          data: {
            videoPath: `/projects/${project.id}/clip_${s.orderIndex}.mp4`,
            status: "rendered",
          },
        });

        job.completedScenes += 1;
        job.scenes[s.id] = {
          orderIndex: s.orderIndex,
          shotType: s.shotType,
          state: "done",
          label: `Clip ready (${duration}s)`,
        };
      } catch (sceneErr) {
        const msg = sceneErr instanceof Error ? sceneErr.message : "Scene render failed";
        job.scenes[s.id] = {
          orderIndex: s.orderIndex,
          shotType: s.shotType,
          state: "error",
          label: msg,
        };
        throw sceneErr;
      } finally {
        activeShotNumbers.delete(shotNum);
        updateParallelStep();
      }
    };

    const workers = Array.from({ length: CONCURRENCY }, async (_, workerIndex) => {
      if (workerIndex > 0) await sleep(workerIndex * 250);
      while (true) {
        const idx = nextQueueIdx;
        nextQueueIdx += 1;
        if (idx >= readyScenes.length) break;
        await renderSingleScene(idx);
        await sleep(250);
      }
    });

    await Promise.all(workers);

    const finalClipPaths = orderedClipPaths.filter((p): p is string => Boolean(p));
    if (finalClipPaths.length === 0) {
      throw new Error("No valid scene clips were produced.");
    }

    job.currentSceneIndex = null;
    job.currentStep = "Concatenating all clips & muxing song.mp3 into final.mp4...";

    const concatFileAbs = path.join(projectDir, "concat.txt");
    fs.writeFileSync(
      concatFileAbs,
      finalClipPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n")
    );

    const finalOutAbs = path.join(projectDir, "final.mp4");
    const hasSong = Boolean(songAbs && fs.existsSync(songAbs));
    const timelineStartSec = Math.max(0, Number(readyScenes[0]?.startSec) || 0);

    if (hasSong && songAbs) {
      await execFileAsync("ffmpeg", [
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        concatFileAbs,
        ...(timelineStartSec > 0 ? ["-ss", String(timelineStartSec)] : []),
        "-i",
        songAbs,
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-shortest",
        "-movflags",
        "+faststart",
        finalOutAbs,
      ]);
    } else {
      await execFileAsync("ffmpeg", [
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        concatFileAbs,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        finalOutAbs,
      ]);
    }

    await prisma.project.update({
      where: { id: project.id },
      data: {
        finalVideoPath: `/projects/${project.id}/final.mp4`,
        status: "rendered",
      },
    });

    job.status = "completed";
    job.currentStep = "Final music video rendered!";
  } catch (err) {
    console.error("Render pipeline failed:", err);
    job.status = "failed";
    job.error = err instanceof Error ? err.message : "Music video render failed.";
    job.currentStep = "Render failed";
  }
}

app.post("/api/projects/:id/render", async (req: Request, res: Response) => {
  const id = String(req.params.id);

  try {
    const existingJob = renderJobs.get(id);
    if (existingJob && existingJob.status === "running") {
      res.status(202).json({ job: existingJob });
      return;
    }

    const project = await prisma.project.findUnique({
      where: { id },
      include: {
        character: true,
        ...projectCastInclude,
        scenes: { orderBy: { orderIndex: "asc" } },
      },
    });
    if (!project) {
      res.status(404).json({ error: "Project not found." });
      return;
    }

    const readyScenes = project.scenes.filter((s) => Boolean(s.imagePath));
    if (readyScenes.length === 0) {
      res.status(400).json({
        error: "At least one scene needs a generated or uploaded keyframe image before rendering.",
      });
      return;
    }
    if (!getModalLipsyncConfig() && readyScenes.some((scene) => scene.shotType === "lipsync")) {
      res.status(400).json({ error: "Modal MuseTalk is not connected. Add MODAL_LIPSYNC_URL and MODAL_LIPSYNC_API_TOKEN in Render." });
      return;
    }

    const sceneMap: Record<string, RenderJobSceneStatus> = {};
    for (const s of readyScenes) {
      sceneMap[s.id] = {
        orderIndex: s.orderIndex,
        shotType: s.shotType,
        state: "queued",
        label: "Queued",
      };
    }

    const requestedMode = req.body?.qualityMode;
    const qualityMode: RenderQualityMode =
      requestedMode === "budget" || requestedMode === "master" || requestedMode === "turbo"
        ? requestedMode
        : "turbo";

    const job: RenderJob = {
      projectId: id,
      status: "running",
      qualityMode,
      totalScenes: readyScenes.length,
      completedScenes: 0,
      currentSceneIndex: readyScenes[0].orderIndex,
      currentStep: `Starting LTX-2.5 render for ${readyScenes.length} scenes...`,
      scenes: sceneMap,
      error: null,
      startedAt: Date.now(),
    };

    renderJobs.set(id, job);

    // Fire background render without blocking HTTP response
    void runRenderPipeline(id, job, qualityMode);

    res.status(202).json({ job });
  } catch (err) {
    console.error("POST /api/projects/:id/render failed:", err);
    const message = err instanceof Error ? err.message : "Failed to start render pipeline.";
    res.status(500).json({ error: message });
  }
});

app.get("/api/projects/:id/render-status", async (req: Request, res: Response) => {
  const id = String(req.params.id);
  try {
    const project = await prisma.project.findUnique({
      where: { id },
      include: {
        character: true,
        ...projectCastInclude,
        scenes: { orderBy: { orderIndex: "asc" } },
      },
    });
    if (!project) {
      res.status(404).json({ error: "Project not found." });
      return;
    }
    const job = renderJobs.get(id) || null;
    res.json({ job, project });
  } catch (err) {
    console.error("GET /api/projects/:id/render-status failed:", err);
    res.status(500).json({ error: "Failed to check render status." });
  }
});

// ---------- Auto-Initialize Local SQLite Tables ----------
async function ensureSqliteSchema() {
  await prisma.$executeRawUnsafe(`PRAGMA foreign_keys = ON;`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "Character" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "name" TEXT NOT NULL,
      "visualPrompt" TEXT NOT NULL,
      "refImagePath" TEXT NOT NULL,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL
    );
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "Project" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "title" TEXT NOT NULL,
      "concept" TEXT NOT NULL DEFAULT '',
      "aspectRatio" TEXT NOT NULL DEFAULT '16:9',
      "videoType" TEXT NOT NULL DEFAULT 'narrative',
      "rawLyrics" TEXT NOT NULL DEFAULT '',
      "lyricsJson" TEXT NOT NULL DEFAULT '[]',
      "audioPath" TEXT,
      "vocalStemPath" TEXT,
      "characterId" TEXT,
      "finalVideoPath" TEXT,
      "status" TEXT NOT NULL DEFAULT 'draft',
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL,
      CONSTRAINT "Project_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character" ("id") ON DELETE SET NULL ON UPDATE CASCADE
    );
  `);
  const projectCols = (await prisma.$queryRawUnsafe(`PRAGMA table_info("Project");`)) as Array<{ name: string }>;
  if (!projectCols.some((c) => c.name === "videoType")) {
    await prisma.$executeRawUnsafe(`ALTER TABLE "Project" ADD COLUMN "videoType" TEXT NOT NULL DEFAULT 'narrative';`);
  }
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "Scene" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "projectId" TEXT NOT NULL,
      "orderIndex" INTEGER NOT NULL,
      "startSec" REAL NOT NULL DEFAULT 0,
      "endSec" REAL NOT NULL DEFAULT 4,
      "lyricSegment" TEXT NOT NULL DEFAULT '',
      "shotType" TEXT NOT NULL DEFAULT 'Medium Close-Up',
      "imagePrompt" TEXT NOT NULL DEFAULT '',
      "motionPrompt" TEXT NOT NULL DEFAULT '',
      "imagePath" TEXT,
      "videoPath" TEXT,
      "status" TEXT NOT NULL DEFAULT 'pending',
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL,
      CONSTRAINT "Scene_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    );
  `);
}

// ---------- Vite Dev Middleware or Static Prod Serving ----------
async function startServer() {
  await ensureSqliteSchema();

  const httpServer = http.createServer(app);

  if (process.env.NODE_ENV === "production") {
    const distDir = path.join(ROOT_DIR, "dist");
    app.use(express.static(distDir));
    app.get("/{*path}", (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, "index.html"));
    });
  } else {
    const disableHmr = process.env.DISABLE_HMR === "true";
    if (disableHmr) {
      app.get("/@vite/client", (_req: Request, res: Response) => {
        res.type("application/javascript").send(
          `export const createHotContext = () => ({ accept() {}, dispose() {}, prune() {}, invalidate() {}, on() {}, off() {}, send() {} });
export const updateStyle = (id, content) => {
  let el = document.querySelector(\`style[data-vite-dev-id="\${id}"]\`);
  if (!el) { el = document.createElement("style"); el.setAttribute("data-vite-dev-id", id); document.head.appendChild(el); }
  el.textContent = content;
};
export const removeStyle = (id) => {
  const el = document.querySelector(\`style[data-vite-dev-id="\${id}"]\`);
  if (el) el.remove();
};
export const injectQuery = (url) => url;`
        );
      });
    }

    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: disableHmr ? false : { server: httpServer },
      },
      appType: "spa",
    });
    app.use(vite.middlewares);
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Nocturne MV Studio running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Fatal server startup error:", err);
  process.exit(1);
});
