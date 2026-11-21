import "dotenv/config";
import express from "express";
import type { Request, Response } from "express";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import multer from "multer";
import { PrismaClient } from "@prisma/client";
import { fal } from "@fal-ai/client";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";

const execFileAsync = promisify(execFile);
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

function getFalKey(): string | null {
  const key = (process.env.FAL_KEY || process.env.FAL_API_KEY)?.trim();
  if (!key || key === "MY_FAL_API_KEY") return null;
  return key;
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

function getModalDemucsConfig(): { url: string; token: string } | null {
  const url = process.env.MODAL_DEMUCS_URL?.trim().replace(/\\/+$/, "");
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
    if (contentType.includes("application/zip")) {
      const zipBytes = Buffer.from(await resultResponse.arrayBuffer());
      if (zipBytes.length < 1024) throw new Error("Modal Demucs returned an empty stem archive.");
      const archivePath = path.join(projectDir, `demucs-stems-${Date.now()}.zip`);
      fs.writeFileSync(archivePath, zipBytes);
      try {
        await execFileAsync("python", ["-c",
          "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); z.extractall(sys.argv[2])",
          archivePath, projectDir,
        ]);
      } finally {
        if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
      }
      const vocalsPath = path.join(projectDir, "vocals.wav");
      if (fs.existsSync(vocalsPath)) fs.unlinkSync(vocalsPath);
      const candidates: string[] = [];
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name.toLowerCase() === "vocals.wav") candidates.push(full);
        }
      };
      walk(projectDir);
      const source = candidates.find((candidate) => candidate !== vocalsPath);
      if (!source) throw new Error("Demucs finished but did not return vocals.wav.");
      fs.copyFileSync(source, vocalsPath);
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

async function uploadLocalFileToFal(absPath: string, mimeType: string): Promise<string> {
  if (!fs.existsSync(absPath)) {
    throw new Error(`Missing local asset for Fal upload: ${path.basename(absPath)}`);
  }
  const buffer = fs.readFileSync(absPath);
  const fileObj = new File([buffer], path.basename(absPath), { type: mimeType });
  return await fal.storage.upload(fileObj);
}

async function downloadRemoteFile(url: string, targetAbsPath: string): Promise<void> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Failed to download remote media (${resp.status})`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(targetAbsPath, buf);
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

// ---------- Health & Capabilities ----------// ---------- Health & Capabilities ----------
app.get("/api/capabilities", async (_req: Request, res: Response) => {
  let hasFfmpeg = false;
  try {
    await execFileAsync("ffmpeg", ["-version"]);
    hasFfmpeg = true;
  } catch {
    hasFfmpeg = false;
  }
  res.json({
    falConfigured: Boolean(getFalKey()),
    modalVideoConfigured: Boolean(getModalLtxConfig()),
    modalFluxConfigured: Boolean(getModalFluxConfig()),
    modalDemucsConfigured: Boolean(getModalDemucsConfig()),
    geminiConfigured: Boolean(getGeminiKey()),
    openaiConfigured: Boolean(getOpenAiKey()),
    ffmpegAvailable: hasFfmpeg,
  });
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

app.post("/api/projects", async (req: Request, res: Response) => {
  try {
    const title = String(req.body?.title || "Untitled Music Video").trim();
    const concept = String(req.body?.concept || "").trim();
    const aspectRatio = ["16:9", "9:16", "1:1"].includes(req.body?.aspectRatio) ? req.body.aspectRatio : "16:9";
    const videoType = normalizeVideoType(req.body?.videoType);
    const rawLyrics = String(req.body?.rawLyrics || "");
    const characterId = req.body?.characterId ? String(req.body.characterId) : null;

    const project = await prisma.project.create({
      data: {
        title,
        concept,
        aspectRatio,
        videoType,
        rawLyrics,
        characterId,
        status: "draft",
      },
      include: {
        character: true,
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
    if (req.body?.status !== undefined) data.status = String(req.body.status);

    const project = await prisma.project.update({
      where: { id },
      data,
      include: {
        character: true,
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
        scenes: { orderBy: { orderIndex: "asc" } },
      },
    });

    const falKey = getFalKey();
    if (!falKey) {
      res.status(400).json({
        error: `Song saved to public/projects/${id}/song.mp3, but FAL_KEY is not configured. Add FAL_KEY in Secrets to run Whisper transcription.`,
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

    fal.config({ credentials: falKey });

    // Whisper remains on fal.ai; vocal separation runs on the Modal Demucs service.
    const songBuffer = fs.readFileSync(targetSongPath);
    const audioFile = new File([songBuffer], "song.mp3", { type: "audio/mpeg" });
    const falAudioUrl = await fal.storage.upload(audioFile);

    const [whisperResult, vocalStemPath] = await Promise.all([
      fal.subscribe("fal-ai/whisper", {
        input: {
          audio_url: falAudioUrl,
          task: "transcribe",
          chunk_level: "segment",
        },
      }),
      separateVocalsWithModalDemucs(targetSongPath, projectDir),
    ]);

    const whisperData = (whisperResult.data || {}) as {
      text?: string;
      chunks?: Array<{ text?: string; timestamp?: [number, number | null] }>;
    };

    const rawChunks = Array.isArray(whisperData.chunks) ? whisperData.chunks : [];
    const segments = rawChunks
      .map((chunk, idx) => {
        const text = String(chunk.text || "").trim();
        const start = Number(chunk.timestamp?.[0] ?? 0);
        const rawEnd = chunk.timestamp?.[1];
        const end = rawEnd !== null && rawEnd !== undefined ? Number(rawEnd) : Number((start + 4).toFixed(2));
        return {
          orderIndex: idx,
          startSec: Number(start.toFixed(2)),
          endSec: Number(Math.max(start + 0.5, end).toFixed(2)),
          text,
        };
      })
      .filter((seg) => seg.text.length > 0);

    if (segments.length === 0 && whisperData.text) {
      segments.push({
        orderIndex: 0,
        startSec: 0,
        endSec: 8,
        text: String(whisperData.text).trim(),
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
      include: { character: true },
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
- shotType (one of: "Wide Establishing", "Medium Close-Up", "Tracking Side Shot", "Low-Angle Hero", "Extreme Close-Up", "Silhouette Backlit")
- imagePrompt (rich cinematic image prompt featuring the artist and scene mood, 1-2 sentences)
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
            shotType: String(item.shotType || SHOT_ROTATION[idx % SHOT_ROTATION.length]),
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
          shotType,
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
const DIRECTOR_FRAMINGS = ["Wide", "Close-Up", "Low Angle", "Tracking"];

const MUSIC_VIDEO_TYPE_DIRECTIONS: Record<MusicVideoType, string> = {
  narrative:
    "Style: Narrative + Performance. Blend cinematic story B-roll scenes (around 60%) with emotional lip-synced vocal performance shots on choruses and key hooks (around 40%).",
  performance:
    "Style: Pure Performance / Lip-Sync Focus. Keep the artist front-and-center singing directly to camera (`shotType: 'lipsync'` for ~75-85% of shots) across moody studio, spotlight, or concert setups, using `broll` only for brief instrumental breathers.",
  visualizer:
    "Style: Cinematic B-Roll / Visualizer. Focus heavily on atmospheric visual storytelling, mood, and environmental metaphors (`shotType: 'broll'` for ~85-90% of shots, saving `lipsync` only for 1-2 peak chorus moments).",
  hype:
    "Style: High-Energy Rap / Dance Cut. Emphasize bold low-angle hero framing, rapid kinetic energy, club/street neon lighting, confident lip-sync hooks (`lipsync` on chorus/hook), and punchy kinetic B-roll.",
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
      include: { character: true },
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
    const nextCharacterId =
      req.body?.characterId !== undefined
        ? req.body.characterId
          ? String(req.body.characterId)
          : null
        : existingProject.characterId;

    const project = await prisma.project.update({
      where: { id },
      data: {
        title: nextTitle,
        concept,
        rawLyrics,
        aspectRatio: nextAspectRatio,
        videoType: nextVideoType,
        characterId: nextCharacterId,
      },
      include: { character: true },
    });

    let whisperSegments: Array<{ startSec: number; endSec: number; text: string }> = [];
    try {
      const parsed = JSON.parse(project.lyricsJson || "[]");
      if (Array.isArray(parsed)) {
        whisperSegments = parsed.filter((item) => item && typeof item.text === "string");
      }
    } catch {
      whisperSegments = [];
    }

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
              ],
              properties: {
                startSec: { type: "number" },
                endSec: { type: "number" },
                lyricSegment: { type: "string" },
                shotType: { type: "string", enum: ["lipsync", "broll"] },
                framing: { type: "string", enum: ["Wide", "Close-Up", "Low Angle", "Tracking"] },
                imagePrompt: { type: "string" },
                motionPrompt: { type: "string" },
              },
            },
          },
        },
      },
    } as const;

    const charProfile = project.character
      ? { name: project.character.name, visualPrompt: project.character.visualPrompt }
      : { name: "Lead Vocalist", visualPrompt: "Expressive performing singer in stylish evening wardrobe" };

    const styleGuidance = MUSIC_VIDEO_TYPE_DIRECTIONS[nextVideoType];

    const chunkResults = await Promise.all(
      windows.map(async (win) => {
        const winDur = Number((win.end - win.start).toFixed(1));
        const targetShots = Math.max(1, Math.round(winDur / 4.5));
        const localSegments = whisperSegments.filter(
          (seg) => Number(seg.endSec) >= win.start - 1 && Number(seg.startSec) <= win.end + 1
        );

        const systemPrompt = `You are an elite Music Video Director directing Act ${win.index + 1} of ${windows.length} (${win.start}s to ${win.end}s of a ${songDurationSec}s song, ${scopeMode === "section" ? "selected song section" : "full song"}).
${styleGuidance}
Create exactly ${targetShots} consecutive Scene rows covering ${win.start}s to ${win.end}s with ZERO time gaps.
Rules:
1. Every scene MUST have duration between 4.0 and 5.5 seconds, consecutive with zero gaps: scene[0].startSec = ${win.start}, scene[i].startSec = scene[i-1].endSec, final scene endSec = ${win.end}.
2. Follow the Music Video Style above when choosing shotType: "lipsync" vs "broll".
3. Alternate camera framing every shot in rotation: Wide, Close-Up, Low Angle, Tracking.
4. Output TWO strictly separated prompts per scene (concise, vivid, 1-2 sentences each):
   - imagePrompt: Describe subject (matching Character visualPrompt), outfit, lighting, environment, and 35mm cinema film look matching the chosen style. NO camera movement words (never write pan, zoom, dolly, tracking, tilt, crane, orbit, handheld, push-in, pull-back).
   - motionPrompt: Pure camera movement and subject motion only (include the framing style).`;

        const userPayload = {
          title: project.title,
          aspectRatio: project.aspectRatio,
          musicVideoType: nextVideoType,
          scopeMode,
          windowStartSec: win.start,
          windowEndSec: win.end,
          targetShotCount: targetShots,
          visualConcept: concept || "Moody nocturnal cinematic music video",
          character: charProfile,
          fullRawLyrics: rawLyrics || "Instrumental performance",
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
      const rawDur = Number(item.endSec) - Number(item.startSec);
      const clampedDur = Number(Math.min(5.5, Math.max(4.0, Number.isFinite(rawDur) ? rawDur : 4.5)).toFixed(2));
      const startSec = Number(cursor.toFixed(2));
      const endSec = Number((cursor + clampedDur).toFixed(2));
      cursor = endSec;

      const framing = DIRECTOR_FRAMINGS[i % DIRECTOR_FRAMINGS.length];
      const shotType = item.shotType === "lipsync" ? "lipsync" : "broll";
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
          lyricSegment: String(item.lyricSegment || "").trim(),
          shotType,
          imagePrompt: String(item.imagePrompt || "").trim(),
          motionPrompt: motionWithFraming,
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

// ---------- Generate All Keyframes (fal-ai/flux-pro/kontext) ----------
app.post("/api/projects/:id/generate-keyframes", async (req: Request, res: Response) => {
  const id = String(req.params.id);

  try {
    const project = await prisma.project.findUnique({
      where: { id },
      include: {
        character: true,
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

    // Keep the existing bulk-keyframe workflow; FLUX runs through Modal instead of fal.ai.
    const batchSize = 3;
    for (let i = 0; i < project.scenes.length; i += batchSize) {
      const batch = project.scenes.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (scene) => {
          const imagePath = await generateSceneKeyframeWithFlux({
            projectId: project.id,
            orderIndex: scene.orderIndex,
            aspectRatio: project.aspectRatio,
            imagePrompt: scene.imagePrompt,
            lyricSegment: scene.lyricSegment,
            characterName: project.character?.name,
            characterVisualPrompt: project.character?.visualPrompt,
            characterRefPath: project.character?.refImagePath,
          });
          await prisma.scene.update({
            where: { id: scene.id },
            data: { imagePath, status: "ready" },
          });
        })
      );
    }

    const updated = await prisma.project.update({
      where: { id },
      data: { status: "keyframes_ready" },
      include: {
        character: true,
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
      include: { project: { include: { character: true } } },
    });
    if (!scene) {
      res.status(404).json({ error: "Scene not found." });
      return;
    }

    const imagePath = await generateSceneKeyframeWithFlux({
      projectId: scene.projectId,
      orderIndex: scene.orderIndex,
      aspectRatio: scene.project.aspectRatio,
      imagePrompt: scene.imagePrompt,
      lyricSegment: scene.lyricSegment,
      characterName: scene.project.character?.name,
      characterVisualPrompt: scene.project.character?.visualPrompt,
      characterRefPath: scene.project.character?.refImagePath,
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

async function runRenderPipeline(
  projectId: string,
  falKey: string | null,
  job: RenderJob,
  qualityMode: RenderQualityMode = "turbo"
): Promise<void> {
  try {
    if (falKey) fal.config({ credentials: falKey });

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: {
        character: true,
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

    const orderedClipPaths: Array<string | null> = new Array(readyScenes.length).fill(null);
    const CONCURRENCY = Math.min(5, readyScenes.length);
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
          if (!falKey) {
            throw new Error("FAL_KEY is required only for lip-sync shots. Add it to the app's environment settings or change this shot to B-roll.");
          }
          if (!lipsyncAudioSourceAbs) {
            throw new Error(
              `Shot ${shotNum} is marked 'lipsync', but vocals.wav / song.mp3 was not found.`
            );
          }

          job.scenes[s.id] = {
            orderIndex: s.orderIndex,
            shotType: s.shotType,
            state: "rendering",
            label: "Slicing vocals.wav & running sync-lipsync...",
          };

          const vocalSliceAbs = path.join(projectDir, `vocal_${s.orderIndex}.wav`);
          await execFileAsync("ffmpeg", [
            "-y",
            "-ss",
            String(Math.max(0, s.startSec)),
            "-t",
            String(duration),
            "-i",
            lipsyncAudioSourceAbs,
            "-ar",
            "44100",
            "-ac",
            "1",
            "-c:a",
            "pcm_s16le",
            vocalSliceAbs,
          ]);

          // Fast base portrait video clip from scene.imagePath for fal-ai/sync-lipsync
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

          const [videoUrl, audioUrl] = await Promise.all([
            uploadLocalFileToFal(baseLipsyncVideoAbs, "video/mp4"),
            uploadLocalFileToFal(vocalSliceAbs, "audio/wav"),
          ]);

          const lipsyncRes = await fal.subscribe("fal-ai/sync-lipsync", {
            input: {
              video_url: videoUrl,
              audio_url: audioUrl,
            },
          });

          const outVideoUrl = (lipsyncRes.data as { video?: { url?: string } })?.video?.url;
          if (!outVideoUrl) {
            throw new Error(`fal-ai/sync-lipsync returned no video URL for Shot ${shotNum}.`);
          }
          await downloadRemoteFile(outVideoUrl, rawClipAbs);
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

    const workers = Array.from({ length: CONCURRENCY }, async () => {
      while (true) {
        const idx = nextQueueIdx;
        nextQueueIdx += 1;
        if (idx >= readyScenes.length) break;
        await renderSingleScene(idx);
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

    const falKey = getFalKey();

    const project = await prisma.project.findUnique({
      where: { id },
      include: {
        character: true,
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
    if (!falKey && readyScenes.some((scene) => scene.shotType === "lipsync")) {
      res.status(400).json({
        error: "FAL_KEY is required for lip-sync shots. B-roll-only renders use Modal LTX and do not require Fal.",
      });
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
    void runRenderPipeline(id, falKey, job, qualityMode);

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
