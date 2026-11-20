export interface Character {
  id: string;
  name: string;
  visualPrompt: string;
  refImagePath: string;
  createdAt: string;
  updatedAt: string;
  _count?: {
    projects: number;
  };
}

export interface Scene {
  id: string;
  projectId: string;
  orderIndex: number;
  startSec: number;
  endSec: number;
  lyricSegment: string;
  shotType: string;
  imagePrompt: string;
  motionPrompt: string;
  imagePath: string | null;
  videoPath: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export type MusicVideoType =
  | "narrative"
  | "performance"
  | "visualizer"
  | "hype"
  | "retro";

export type SongScopeMode = "full" | "section";

export interface Project {
  id: string;
  title: string;
  concept: string;
  aspectRatio: "16:9" | "9:16" | "1:1" | string;
  videoType?: MusicVideoType | string;
  rawLyrics: string;
  lyricsJson: string;
  audioPath: string | null;
  vocalStemPath: string | null;
  characterId: string | null;
  character: Character | null;
  finalVideoPath: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  scenes: Scene[];
}

export interface Capabilities {
  falConfigured: boolean;
  geminiConfigured: boolean;
  openaiConfigured: boolean;
  ffmpegAvailable: boolean;
}

export interface RenderJobSceneStatus {
  orderIndex: number;
  shotType: string;
  state: "queued" | "rendering" | "done" | "error";
  label: string;
}

export interface RenderJob {
  projectId: string;
  status: "running" | "completed" | "failed";
  totalScenes: number;
  completedScenes: number;
  currentSceneIndex: number | null;
  currentStep: string;
  scenes: Record<string, RenderJobSceneStatus>;
  error: string | null;
  startedAt: number;
}


