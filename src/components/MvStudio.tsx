import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Clapperboard,
  Clock,
  Download,
  FileAudio,
  Film,
  Image as ImageIcon,
  Loader2,
  Mic,
  Music,
  Plus,
  RefreshCw,
  Save,
  Scissors,
  Sparkles,
  Trash2,
  Upload,
  UserRound,
  Video,
  Wand2,
} from "lucide-react";
import type {
  Character,
  MusicVideoType,
  Project,
  RenderJob,
  RenderQualityMode,
  Scene,
  SongScopeMode,
} from "../types/studio";

interface MvStudioProps {
  projects: Project[];
  characters: Character[];
  loading: boolean;
  audioModelsConfigured: boolean;
  geminiConfigured: boolean;
  openaiConfigured: boolean;
  activeProjectId: string | null;
  newProjectOpen: boolean;
  preselectedCharacterId: string | null;
  onSelectProject: (id: string) => void;
  onToggleNewProject: (open: boolean) => void;
  onProjectCreated: (project: Project) => void;
  onProjectUpdated: (project: Project) => void;
  onProjectDeleted: (id: string) => void;
}

type CastDraftEntry = { artistId: string; role: string; appearanceNotes: string };

const CAST_ROLES = ["Lead Vocalist", "Featured Artist", "Backup Vocalist", "Co-Star / Love Interest"];

function readCastIds(value?: string): string[] {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.map(String).slice(0, 4) : [];
  } catch { return []; }
}

interface TimestampSegment {
  orderIndex: number;
  startSec: number;
  endSec: number;
  text: string;
}

const SHOT_TYPES = [
  "lipsync",
  "broll",
  "Wide Establishing",
  "Medium Close-Up",
  "Tracking Side Shot",
  "Low-Angle Hero",
  "Extreme Close-Up",
  "Silhouette Backlit",
];

const MUSIC_VIDEO_TYPES: ReadonlyArray<{
  id: MusicVideoType;
  label: string;
  shortLabel: string;
  mixNote: string;
  desc: string;
}> = [
  {
    id: "narrative",
    label: "Narrative + Performance",
    shortLabel: "Narrative",
    mixNote: "~60% B-roll · 40% Lip-sync",
    desc: "Cinematic story scenes blended with vocal hooks.",
  },
  {
    id: "performance",
    label: "Pure Performance",
    shortLabel: "Performance",
    mixNote: "~80% Lip-sync · Spotlight",
    desc: "Artist front-and-center singing to camera.",
  },
  {
    id: "visualizer",
    label: "Cinematic Visualizer",
    shortLabel: "Visualizer",
    mixNote: "~85% Moody B-roll · Story",
    desc: "Atmospheric visual metaphors & minimal lip-sync.",
  },
  {
    id: "hype",
    label: "High-Energy Rap / Dance",
    shortLabel: "High-Energy",
    mixNote: "Low-angle hero · Kinetic",
    desc: "Punchy hooks, dynamic movement, club & street neon.",
  },
  {
    id: "retro",
    label: "Retro 90s VHS / Film",
    shortLabel: "Retro 90s",
    mixNote: "35mm halation · Analog",
    desc: "Nostalgic warm grain, late-night handheld intimacy.",
  },
];

function normalizeMusicVideoType(value?: string | null): MusicVideoType {
  if (
    value === "narrative" ||
    value === "performance" ||
    value === "visualizer" ||
    value === "hype" ||
    value === "retro"
  ) {
    return value;
  }
  return "narrative";
}

function formatTimecode(seconds: number): string {
  const safe = Math.max(0, seconds);
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, "0")}:${secs.toFixed(1).padStart(4, "0")}`;
}

function parseLyricsJson(raw: string | undefined): TimestampSegment[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item.text === "string" && item.text.trim().length > 0)
      .map((item, idx) => ({
        orderIndex: typeof item.orderIndex === "number" ? item.orderIndex : idx,
        startSec: Number(item.startSec ?? 0),
        endSec: Number(item.endSec ?? 0),
        text: String(item.text).trim(),
      }));
  } catch {
    return [];
  }
}

export const MvStudio: React.FC<MvStudioProps> = ({
  projects,
  characters,
  loading,
  audioModelsConfigured,
  openaiConfigured,
  activeProjectId,
  newProjectOpen,
  preselectedCharacterId,
  onSelectProject,
  onToggleNewProject,
  onProjectCreated,
  onProjectUpdated,
  onProjectDeleted,
}) => {
  const activeProject = projects.find((p) => p.id === activeProjectId) || projects[0] || null;

  // New project form state
  const [newTitle, setNewTitle] = useState("");
  const [newConcept, setNewConcept] = useState("");
  const [newAspectRatio, setNewAspectRatio] = useState<"16:9" | "9:16">("16:9");
  const [newVideoType, setNewVideoType] = useState<MusicVideoType>("narrative");
  const [newCharacterId, setNewCharacterId] = useState<string>(preselectedCharacterId || "");
  const [newRawLyrics, setNewRawLyrics] = useState("");
  const [newAudioFile, setNewAudioFile] = useState<File | null>(null);
  const [creatingProject, setCreatingProject] = useState(false);
  const [processingStage, setProcessingStage] = useState<string | null>(null);
  const newAudioInputRef = useRef<HTMLInputElement | null>(null);

  // Active project draft fields
  const [title, setTitle] = useState("");
  const [concept, setConcept] = useState("");
  const [aspectRatio, setAspectRatio] = useState<string>("16:9");
  const [videoType, setVideoType] = useState<MusicVideoType>("narrative");
  const [characterId, setCharacterId] = useState<string>("");
  const [castDraft, setCastDraft] = useState<CastDraftEntry[]>([]);
  const [castPickerId, setCastPickerId] = useState("");
  const [rawLyrics, setRawLyrics] = useState("");
  const [secPerScene, setSecPerScene] = useState(4);

  // Song coverage (Full Song vs Choose Section)
  const [scopeMode, setScopeMode] = useState<SongScopeMode>("full");
  const [sectionStartSec, setSectionStartSec] = useState<number>(0);
  const [sectionEndSec, setSectionEndSec] = useState<number>(30);
  const [songDurationSec, setSongDurationSec] = useState<number | null>(null);

  // Playback timecode for iPad tap-to-timestamp
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playheadSec, setPlayheadSec] = useState(0);

  // Busy states
  const [savingMeta, setSavingMeta] = useState(false);
  const [splitting, setSplitting] = useState(false);
  const [generatingStoryboard, setGeneratingStoryboard] = useState(false);
  const [generatingKeyframes, setGeneratingKeyframes] = useState(false);
  const [renderingVideo, setRenderingVideo] = useState(false);
  const [renderQualityMode, setRenderQualityMode] = useState<RenderQualityMode>("turbo");
  const [renderJob, setRenderJob] = useState<RenderJob | null>(null);
  const [analyzingAudio, setAnalyzingAudio] = useState(false);
  const [sceneBusy, setSceneBusy] = useState<Record<string, string>>({});
  const [sceneDrafts, setSceneDrafts] = useState<Record<string, Partial<Scene>>>({});
  const [error, setError] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [confirmDeleteProj, setConfirmDeleteProj] = useState(false);

  const analyzeAudioInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (preselectedCharacterId) {
      setNewCharacterId(preselectedCharacterId);
    }
  }, [preselectedCharacterId]);

  useEffect(() => {
    if (!activeProject) return;
    setTitle(activeProject.title);
    setConcept(activeProject.concept || "");
    setAspectRatio(activeProject.aspectRatio || "16:9");
    setVideoType(normalizeMusicVideoType(activeProject.videoType));
    setCharacterId(activeProject.characterId || "");
    const savedCast = (activeProject.castMembers || []).map((entry) => ({
      artistId: entry.artistId, role: entry.role || "Lead Vocalist", appearanceNotes: entry.appearanceNotes || "",
    }));
    setCastDraft(savedCast.length ? savedCast : activeProject.characterId ? [{
      artistId: activeProject.characterId, role: "Lead Vocalist", appearanceNotes: "",
    }] : []);
    setRawLyrics(activeProject.rawLyrics || "");
    setConfirmDeleteProj(false);

    const drafts: Record<string, Partial<Scene>> = {};
    for (const s of activeProject.scenes) {
      drafts[s.id] = {
        startSec: s.startSec,
        endSec: s.endSec,
        lyricSegment: s.lyricSegment,
        shotType: s.shotType,
        imagePrompt: s.imagePrompt,
        motionPrompt: s.motionPrompt,
      };
    }
    setSceneDrafts(drafts);
  }, [activeProject]);

  // Reset audio metadata / section defaults when switching to a different project
  useEffect(() => {
    setSongDurationSec(null);
    setPlayheadSec(0);
    if (!activeProject) {
      setScopeMode("full");
      setSectionStartSec(0);
      setSectionEndSec(30);
      return;
    }
    const scenes = activeProject.scenes || [];
    if (scenes.length > 0 && Number(scenes[0].startSec) >= 2) {
      setScopeMode("section");
      setSectionStartSec(Number(scenes[0].startSec));
      setSectionEndSec(Number(scenes[scenes.length - 1].endSec));
    } else {
      setScopeMode("full");
      setSectionStartSec(0);
      setSectionEndSec(30);
    }
  }, [activeProject?.id]);

  // Ping Modal services as soon as a project opens so their web endpoints are awake before generation.
  useEffect(() => {
    if (!activeProject?.id) return;
    void fetch("/api/warmup", { method: "POST" }).catch(() => {
      // Warmup is opportunistic; never block project loading or the user's workflow.
    });
  }, [activeProject?.id]);

  // Sync active render job when switching projects
  useEffect(() => {
    if (!activeProject?.id) {
      setRenderJob(null);
      setRenderingVideo(false);
      return;
    }

    let cancelled = false;
    fetch(`/api/projects/${activeProject.id}/render-status`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        const job: RenderJob | null = data.job || null;
        setRenderJob(job);
        if (job?.qualityMode) setRenderQualityMode(job.qualityMode);
        setRenderingVideo(job?.status === "running");
      })
      .catch(() => {
        // ignore transient fetch errors
      });

    return () => {
      cancelled = true;
    };
  }, [activeProject?.id]);

  // Poll live per-scene render status while render job is running
  useEffect(() => {
    const projectId = activeProject?.id;
    if (!projectId || !renderingVideo) return;

    let active = true;
    const poll = async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/render-status`);
        if (!res.ok || !active) return;
        const data = await res.json();
        const job: RenderJob | null = data.job || null;
        if (!active) return;
        setRenderJob(job);

        if (job?.status === "completed") {
          setRenderingVideo(false);
          if (data.project) onProjectUpdated(data.project);
          setStatusNotice(
            "Final music video rendered! Play below or tap Download MP4 to save to your iPad Photos."
          );
        } else if (job?.status === "failed") {
          setRenderingVideo(false);
          if (data.project) onProjectUpdated(data.project);
          setError(job.error || "Music video render failed.");
        }
      } catch {
        // Keep polling on transient network glitch
      }
    };

    const timer = window.setInterval(poll, 1500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [activeProject?.id, renderingVideo, onProjectUpdated]);

  const timestampSegments = useMemo(
    () => parseLyricsJson(activeProject?.lyricsJson),
    [activeProject?.lyricsJson]
  );

  const effectiveDurationSec = useMemo(() => {
    if (songDurationSec && songDurationSec > 0) return Number(songDurationSec.toFixed(1));
    if (timestampSegments.length > 0) {
      return Number(Math.max(...timestampSegments.map((s) => s.endSec)).toFixed(1));
    }
    if (activeProject?.scenes?.length) {
      return Number(Math.max(...activeProject.scenes.map((s) => s.endSec)).toFixed(1));
    }
    return null;
  }, [songDurationSec, timestampSegments, activeProject?.scenes]);

  const clampedSectionEndSec = useMemo(() => {
    const minEnd = Number((sectionStartSec + 4).toFixed(1));
    const maxEnd = effectiveDurationSec ? Math.max(minEnd, effectiveDurationSec) : Math.max(minEnd, sectionEndSec);
    return Number(Math.min(maxEnd, Math.max(minEnd, sectionEndSec)).toFixed(1));
  }, [sectionStartSec, sectionEndSec, effectiveDurationSec]);

  const applySectionWindow = (start: number, duration: number) => {
    const safeStart = Math.max(0, Number(start.toFixed(1)));
    const rawEnd = Number((safeStart + duration).toFixed(1));
    const clampedEnd = effectiveDurationSec ? Math.min(effectiveDurationSec, rawEnd) : rawEnd;
    setScopeMode("section");
    setSectionStartSec(safeStart);
    setSectionEndSec(Number(Math.max(safeStart + 4, clampedEnd).toFixed(1)));
  };

  const handleSeekAudio = (sec: number) => {
    if (!audioRef.current) return;
    audioRef.current.currentTime = sec;
    setPlayheadSec(sec);
    audioRef.current.play().catch(() => {
      // Ignore autoplay restriction if user only wanted to scrub
    });
  };

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setStatusNotice(null);
    setCreatingProject(true);
    setProcessingStage("Creating project in SQLite...");

    try {
      const inferredTitle =
        newTitle.trim() ||
        (newAudioFile ? newAudioFile.name.replace(/\.[^.]+$/, "") : "") ||
        "Untitled Music Video";

      const createRes = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: inferredTitle,
          concept: newConcept.trim(),
          aspectRatio: newAspectRatio,
          videoType: newVideoType,
          rawLyrics: newRawLyrics,
          characterId: newCharacterId || null,
          castMembers: newCharacterId ? [{ artistId: newCharacterId, role: "Lead Vocalist", appearanceNotes: "" }] : [],
        }),
      });
      const createData = await createRes.json();
      if (!createRes.ok) throw new Error(createData.error || "Failed to create project.");

      let createdProject: Project = createData.project;
      onProjectCreated(createdProject);

      if (newAudioFile) {
        setProcessingStage(
          "Saving song.mp3 and running Modal Whisper + Modal Demucs in parallel..."
        );
        setAnalyzingAudio(true);

        const formData = new FormData();
        formData.append("file", newAudioFile);

        const analyzeRes = await fetch(`/api/projects/${createdProject.id}/analyze-audio`, {
          method: "POST",
          body: formData,
        });
        const analyzeData = await analyzeRes.json();

        if (analyzeData.project) {
          createdProject = analyzeData.project;
          onProjectUpdated(createdProject);
        }

        if (!analyzeRes.ok) {
          throw new Error(analyzeData.error || "Audio analysis failed.");
        }

        setStatusNotice(
          `Saved song.mp3, extracted ${analyzeData.segments?.length ?? 0} timestamped lyric segments via Whisper, and isolated vocals.wav via Demucs.`
        );
      } else {
        setStatusNotice("Project created. Upload an .mp3 or .wav song to run Whisper + Demucs analysis.");
      }

      setNewTitle("");
      setNewConcept("");
      setNewRawLyrics("");
      setNewAudioFile(null);
      onToggleNewProject(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create project.");
    } finally {
      setCreatingProject(false);
      setAnalyzingAudio(false);
      setProcessingStage(null);
    }
  };

  const handleAnalyzeAudioForActive = async (file: File | null) => {
    if (!activeProject || !file) return;
    setError(null);
    setStatusNotice(null);
    setAnalyzingAudio(true);
    setProcessingStage(
      "Saving song.mp3, then running Hugging Face Whisper and Demucs on Modal..."
    );

    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch(`/api/projects/${activeProject.id}/analyze-audio`, {
        method: "POST",
        body: formData,
      });
      const data = await res.json();

      if (data.project) {
        onProjectUpdated(data.project);
      }

      if (!res.ok) {
        throw new Error(data.error || "Audio upload & analysis failed.");
      }

      setStatusNotice(
        `Extracted ${data.segments?.length ?? 0} timestamped segments and saved isolated vocals.wav.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Audio upload & analysis failed.");
    } finally {
      setAnalyzingAudio(false);
      setProcessingStage(null);
      if (analyzeAudioInputRef.current) {
        analyzeAudioInputRef.current.value = "";
      }
    }
  };

  const handleSaveProjectMeta = async () => {
    if (!activeProject) return;
    setError(null);
    setStatusNotice(null);
    setSavingMeta(true);
    try {
      const res = await fetch(`/api/projects/${activeProject.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          concept,
          aspectRatio,
          videoType,
          rawLyrics,
          characterId: castDraft[0]?.artistId || characterId || null,
          castMembers: castDraft.map((entry, index) => ({ ...entry, sortOrder: index + 1 })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save project.");
      onProjectUpdated(data.project);
      setStatusNotice("Project details saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save project.");
    } finally {
      setSavingMeta(false);
    }
  };

  const handleGenerateStoryboard = async () => {
    if (!activeProject) return;
    if (scopeMode === "section" && clampedSectionEndSec <= sectionStartSec) {
      setError("Section End must be greater than Section Start.");
      return;
    }

    setError(null);
    setStatusNotice(null);
    setGeneratingStoryboard(true);
    const activeTypeLabel =
      MUSIC_VIDEO_TYPES.find((t) => t.id === videoType)?.label || "Narrative + Performance";
    setProcessingStage(
      scopeMode === "section"
        ? `GPT-4o AI Director (${activeTypeLabel}) is directing ${formatTimecode(sectionStartSec)}–${formatTimecode(clampedSectionEndSec)} in consecutive 4.0–5.5s shots...`
        : `GPT-4o AI Director (${activeTypeLabel}) is breaking your full song into consecutive 4.0–5.5s shots...`
    );

    try {
      const res = await fetch(`/api/projects/${activeProject.id}/generate-storyboard`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          concept,
          aspectRatio,
          videoType,
          rawLyrics,
          characterId: castDraft[0]?.artistId || characterId || null,
          castMembers: castDraft.map((entry, index) => ({ ...entry, sortOrder: index + 1 })),
          scopeMode,
          sectionStartSec,
          sectionEndSec: clampedSectionEndSec,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to generate storyboard.");
      onProjectUpdated(data.project);
      setStatusNotice(
        scopeMode === "section"
          ? `GPT-4o (${activeTypeLabel}) created ${data.project.scenes.length} shots for ${formatTimecode(sectionStartSec)} – ${formatTimecode(clampedSectionEndSec)}.`
          : `GPT-4o (${activeTypeLabel}) created ${data.project.scenes.length} continuous shots across the full track.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate storyboard.");
    } finally {
      setGeneratingStoryboard(false);
      setProcessingStage(null);
    }
  };

  const handleGenerateAllKeyframes = async () => {
    if (!activeProject) return;
    setError(null);
    setStatusNotice(null);
    setGeneratingKeyframes(true);
    setProcessingStage(
      `Generating ${activeProject.scenes.length} consistent keyframes with 8 staggered FLUX requests and saving to public/projects/${activeProject.id}/...`
    );

    try {
      const res = await fetch(`/api/projects/${activeProject.id}/generate-keyframes`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to generate all keyframes.");
      onProjectUpdated(data.project);
      setStatusNotice(
        `Generated all ${data.project.scenes.length} keyframes with consistent artist identity.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate all keyframes.");
    } finally {
      setGeneratingKeyframes(false);
      setProcessingStage(null);
    }
  };

  const handleSplitLyrics = async (options: { useAiDirector?: boolean; useWhisperTimestamps?: boolean }) => {
    if (!activeProject) return;
    setError(null);
    setStatusNotice(null);
    setSplitting(true);
    try {
      const res = await fetch(`/api/projects/${activeProject.id}/split-lyrics`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rawLyrics,
          secPerScene,
          useAiDirector: Boolean(options.useAiDirector),
          useWhisperTimestamps: Boolean(options.useWhisperTimestamps),
          scopeMode,
          sectionStartSec,
          sectionEndSec: clampedSectionEndSec,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to generate scenes.");
      onProjectUpdated(data.project);
      setStatusNotice(
        scopeMode === "section"
          ? `Created ${data.project.scenes.length} storyboard scenes for ${formatTimecode(sectionStartSec)} – ${formatTimecode(clampedSectionEndSec)}.`
          : `Created ${data.project.scenes.length} storyboard scenes.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate scenes.");
    } finally {
      setSplitting(false);
    }
  };

  const handleAddScene = async () => {
    if (!activeProject) return;
    setError(null);
    try {
      const res = await fetch(`/api/projects/${activeProject.id}/scenes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to add scene.");
      onProjectUpdated({
        ...activeProject,
        scenes: [...activeProject.scenes, data.scene],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add scene.");
    }
  };

  const updateDraft = (sceneId: string, patch: Partial<Scene>) => {
    setSceneDrafts((prev) => ({
      ...prev,
      [sceneId]: { ...prev[sceneId], ...patch },
    }));
  };

  const handleSaveScene = async (sceneId: string) => {
    if (!activeProject) return;
    const draft = sceneDrafts[sceneId];
    if (!draft) return;
    setSceneBusy((prev) => ({ ...prev, [sceneId]: "saving" }));
    setError(null);
    try {
      const res = await fetch(`/api/scenes/${sceneId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save scene.");
      onProjectUpdated({
        ...activeProject,
        scenes: activeProject.scenes.map((s) => (s.id === sceneId ? data.scene : s)),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save scene.");
    } finally {
      setSceneBusy((prev) => {
        const copy = { ...prev };
        delete copy[sceneId];
        return copy;
      });
    }
  };

  const handleDeleteScene = async (sceneId: string) => {
    if (!activeProject) return;
    setSceneBusy((prev) => ({ ...prev, [sceneId]: "deleting" }));
    try {
      const res = await fetch(`/api/scenes/${sceneId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete scene.");
      const remaining = activeProject.scenes
        .filter((s) => s.id !== sceneId)
        .map((s, idx) => ({ ...s, orderIndex: idx }));
      onProjectUpdated({ ...activeProject, scenes: remaining });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete scene.");
    } finally {
      setSceneBusy((prev) => {
        const copy = { ...prev };
        delete copy[sceneId];
        return copy;
      });
    }
  };

  const handleGenerateSceneFrame = async (sceneId: string) => {
    if (!activeProject) return;
    setError(null);
    const draft = sceneDrafts[sceneId];
    if (draft) {
      await fetch(`/api/scenes/${sceneId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
    }
    setSceneBusy((prev) => ({ ...prev, [sceneId]: "generating" }));
    try {
      const res = await fetch(`/api/scenes/${sceneId}/generate-image`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Frame generation failed.");
      onProjectUpdated({
        ...activeProject,
        scenes: activeProject.scenes.map((s) => (s.id === sceneId ? data.scene : s)),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Frame generation failed.");
    } finally {
      setSceneBusy((prev) => {
        const copy = { ...prev };
        delete copy[sceneId];
        return copy;
      });
    }
  };

  const handleUploadSceneFrame = async (sceneId: string, file: File | null) => {
    if (!activeProject || !file) return;
    setError(null);
    setSceneBusy((prev) => ({ ...prev, [sceneId]: "uploading" }));
    try {
      const formData = new FormData();
      formData.append("photo", file);
      const res = await fetch(`/api/scenes/${sceneId}/upload-image`, {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Scene image upload failed.");
      onProjectUpdated({
        ...activeProject,
        scenes: activeProject.scenes.map((s) => (s.id === sceneId ? data.scene : s)),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Scene image upload failed.");
    } finally {
      setSceneBusy((prev) => {
        const copy = { ...prev };
        delete copy[sceneId];
        return copy;
      });
    }
  };

  const handleRenderVideo = async () => {
    if (!activeProject) return;
    setError(null);
    setStatusNotice(null);
    setRenderingVideo(true);
    try {
      const res = await fetch(`/api/projects/${activeProject.id}/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ qualityMode: renderQualityMode }),
      });
      const data = await res.json();
      if (!res.ok) {
        setRenderingVideo(false);
        throw new Error(data.error || "Failed to start music video render.");
      }
      if (data.job) {
        setRenderJob(data.job);
      }
    } catch (err) {
      setRenderingVideo(false);
      setError(err instanceof Error ? err.message : "Failed to start music video render.");
    }
  };

  const handleDeleteProject = async () => {
    if (!activeProject) return;
    try {
      const res = await fetch(`/api/projects/${activeProject.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete project.");
      onProjectDeleted(activeProject.id);
      setConfirmDeleteProj(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete project.");
    }
  };

  return (
    <div className="space-y-8">
      {/* Header & Project Switcher */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between border-b border-zinc-800/80 pb-6">
        <div className="space-y-1.5">
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-zinc-50 text-balance">
            MV Studio
          </h1>
          <p className="text-sm sm:text-base text-zinc-400 max-w-2xl">
            Cast an artist, analyze your Suno song, run GPT-4o AI Director, generate consistent Flux Pro Kontext keyframes, and assemble MP4s.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {projects.length > 0 && (
            <select
              aria-label="Select music video project"
              value={activeProject?.id || ""}
              onChange={(e) => onSelectProject(e.target.value)}
              className="min-h-[44px] px-4 py-2 rounded-xl bg-[#111114] border border-zinc-800 text-sm font-medium text-zinc-100 focus:outline-none focus:border-amber-500 max-w-[260px]"
            >
              {projects.map((proj) => (
                <option key={proj.id} value={proj.id}>
                  {proj.title} ({proj.aspectRatio})
                </option>
              ))}
            </select>
          )}

          <button
            type="button"
            onClick={() => onToggleNewProject(!newProjectOpen)}
            className="min-h-[44px] px-4 py-2.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-700/80 text-sm font-semibold text-zinc-100 transition-colors whitespace-nowrap flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            <span>{newProjectOpen ? "Cancel" : "New Project"}</span>
          </button>
        </div>
      </div>

      {/* Prominent Processing Spinner Banner */}
      {(analyzingAudio || generatingStoryboard || generatingKeyframes || processingStage) && (
        <div
          role="status"
          aria-live="polite"
          className="rounded-2xl bg-amber-950/35 border border-amber-700/60 px-5 py-4 flex items-center gap-4"
        >
          <Loader2 className="w-6 h-6 text-amber-400 animate-spin shrink-0" />
          <div className="space-y-0.5">
            <p className="text-sm font-semibold text-amber-100">
              Studio Pipeline Active
            </p>
            <p className="text-xs sm:text-sm text-amber-200/85">
              {processingStage || "Processing request..."}
            </p>
          </div>
        </div>
      )}

      {error && (
        <div role="alert" className="rounded-xl bg-red-950/50 border border-red-800/70 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {statusNotice && (
        <div className="rounded-xl bg-emerald-950/40 border border-emerald-800/60 px-4 py-3 text-sm text-emerald-200">
          {statusNotice}
        </div>
      )}

      {/* Create New Project + Audio Upload & Analysis Flow */}
      {newProjectOpen && (
        <form
          onSubmit={handleCreateProject}
          className="rounded-2xl bg-[#111114] border border-zinc-800/90 p-5 sm:p-7 space-y-6"
        >
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 pb-4 border-b border-zinc-800/70">
            <div>
              <h2 className="text-lg font-semibold text-zinc-100">New Music Video Project</h2>
              <p className="text-sm text-zinc-400">
                Choose your artist, format, concept, Suno lyrics, and upload your track to extract timestamps and vocals.
              </p>
            </div>
            {!audioModelsConfigured && (
              <span className="text-xs text-amber-300/90">
                Connect the Modal Whisper and Demucs services in Render to analyze audio
              </span>
            )}
          </div>

          <div className="space-y-2.5">
            <span className="block text-sm font-medium text-zinc-200">
              1. Cast Artist from Locker
            </span>
            {characters.length === 0 ? (
              <div className="rounded-xl bg-zinc-950 border border-zinc-800 px-4 py-3 text-sm text-zinc-400">
                No saved artists yet. You can still create this project now and assign an artist later.
              </div>
            ) : (
              <div className="flex gap-3 overflow-x-auto pb-2">
                <button
                  type="button"
                  onClick={() => setNewCharacterId("")}
                  className={`min-h-[72px] px-4 py-2.5 rounded-xl border text-left shrink-0 flex items-center gap-3 transition-colors ${
                    newCharacterId === ""
                      ? "bg-amber-500/15 border-amber-500 text-amber-100"
                      : "bg-zinc-950 border-zinc-800 text-zinc-300 hover:border-zinc-700"
                  }`}
                >
                  <div className="w-10 h-12 rounded-lg bg-zinc-900 flex items-center justify-center shrink-0">
                    <UserRound className="w-5 h-5 text-zinc-400" />
                  </div>
                  <span className="text-sm font-medium whitespace-nowrap">No Artist</span>
                </button>

                {characters.map((c) => {
                  const selected = newCharacterId === c.id;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setNewCharacterId(c.id)}
                      className={`min-h-[72px] px-3.5 py-2 rounded-xl border text-left shrink-0 flex items-center gap-3 transition-colors ${
                        selected
                          ? "bg-amber-500/15 border-amber-500 text-amber-100"
                          : "bg-zinc-950 border-zinc-800 text-zinc-200 hover:border-zinc-700"
                      }`}
                    >
                      <img
                        src={c.refImagePath}
                        alt={c.name}
                        referrerPolicy="no-referrer"
                        className="w-10 h-12 rounded-lg object-cover bg-zinc-900 shrink-0"
                      />
                      <div className="min-w-0 max-w-[140px]">
                        <p className="text-sm font-semibold truncate">{c.name}</p>
                        <p className="text-xs text-zinc-400 truncate">{c.visualPrompt}</p>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-12 gap-5">
            <div className="md:col-span-7 space-y-2">
              <label htmlFor="new-proj-title" className="block text-sm font-medium text-zinc-200">
                2. Project Title
              </label>
              <input
                id="new-proj-title"
                type="text"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="e.g. Midnight Signal"
                className="w-full min-h-[48px] px-4 py-3 rounded-xl bg-zinc-950 border border-zinc-800 text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-amber-500"
              />
            </div>

            <div className="md:col-span-5 space-y-2">
              <span className="block text-sm font-medium text-zinc-200">3. Aspect Ratio</span>
              <div className="grid grid-cols-2 gap-2.5">
                {(
                  [
                    { value: "16:9", label: "16:9 Widescreen" },
                    { value: "9:16", label: "9:16 Vertical" },
                  ] as const
                ).map((ratio) => (
                  <button
                    key={ratio.value}
                    type="button"
                    onClick={() => setNewAspectRatio(ratio.value)}
                    className={`min-h-[48px] px-3 rounded-xl border text-sm font-medium transition-colors whitespace-nowrap ${
                      newAspectRatio === ratio.value
                        ? "bg-amber-500 text-zinc-950 border-amber-500 font-semibold"
                        : "bg-zinc-950 text-zinc-300 border-zinc-800 hover:border-zinc-700"
                    }`}
                  >
                    {ratio.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <span className="block text-sm font-medium text-zinc-200">
              4. Music Video Type
            </span>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2.5">
              {MUSIC_VIDEO_TYPES.map((mvType) => {
                const selected = newVideoType === mvType.id;
                return (
                  <button
                    key={mvType.id}
                    type="button"
                    onClick={() => setNewVideoType(mvType.id)}
                    className={`min-h-[76px] p-3 rounded-xl border text-left transition-colors flex flex-col justify-between gap-1 ${
                      selected
                        ? "bg-amber-500/15 border-amber-500 text-amber-100"
                        : "bg-zinc-950 border-zinc-800 text-zinc-300 hover:border-zinc-700"
                    }`}
                  >
                    <div>
                      <p className="text-sm font-semibold leading-tight">{mvType.shortLabel}</p>
                      <p className="text-[11px] font-mono text-amber-400/90 mt-0.5">{mvType.mixNote}</p>
                    </div>
                    <p className="text-xs text-zinc-400 leading-snug">{mvType.desc}</p>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <div className="space-y-2">
              <label htmlFor="new-proj-concept" className="block text-sm font-medium text-zinc-200">
                4. Visual Concept
              </label>
              <textarea
                id="new-proj-concept"
                rows={4}
                value={newConcept}
                onChange={(e) => setNewConcept(e.target.value)}
                placeholder="Describe lighting, setting, wardrobe mood, and story arc..."
                className="w-full px-4 py-3 rounded-xl bg-zinc-950 border border-zinc-800 text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-amber-500"
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="new-proj-lyrics" className="block text-sm font-medium text-zinc-200">
                5. Paste Suno Lyrics
              </label>
              <textarea
                id="new-proj-lyrics"
                rows={4}
                value={newRawLyrics}
                onChange={(e) => setNewRawLyrics(e.target.value)}
                placeholder={"[Verse 1]\nNeon rain on the studio glass\nHold the note till the sirens pass..."}
                className="w-full px-4 py-3 rounded-xl bg-zinc-950 border border-zinc-800 text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-amber-500"
              />
            </div>
          </div>

          <div className="space-y-2">
            <span className="block text-sm font-medium text-zinc-200">
              6. Upload Song (.mp3 or .wav from iPad)
            </span>
            <input
              ref={newAudioInputRef}
              type="file"
              accept=".mp3,.wav,audio/mpeg,audio/wav,audio/*"
              className="hidden"
              onChange={(e) => setNewAudioFile(e.target.files?.[0] || null)}
            />
            <button
              type="button"
              onClick={() => newAudioInputRef.current?.click()}
              className="w-full min-h-[104px] rounded-2xl border border-dashed border-zinc-700 hover:border-amber-500/70 bg-zinc-950/90 px-5 py-4 flex flex-col sm:flex-row items-center justify-center gap-3 text-center sm:text-left transition-colors"
            >
              <div className="w-11 h-11 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center text-amber-400 shrink-0">
                <FileAudio className="w-5 h-5" />
              </div>
              <div>
                {newAudioFile ? (
                  <>
                    <p className="text-sm font-semibold text-zinc-100">{newAudioFile.name}</p>
                    <p className="text-xs text-zinc-400 font-mono mt-0.5">
                      {(newAudioFile.size / (1024 * 1024)).toFixed(2)} MB · Ready for Whisper + Demucs analysis
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-sm font-medium text-zinc-200">
                      Tap to choose .mp3 or .wav file from iPad Files
                    </p>
                    <p className="text-xs text-zinc-500 mt-0.5">
                      Saves to public/projects/[id]/song.mp3 and runs Whisper + Demucs in parallel
                    </p>
                  </>
                )}
              </div>
            </button>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-end gap-3 pt-2">
            <button
              type="submit"
              disabled={creatingProject || analyzingAudio}
              className="min-h-[52px] px-6 py-3 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-60 text-zinc-950 font-semibold text-base transition-colors flex items-center justify-center gap-2.5"
            >
              {creatingProject || analyzingAudio ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span>{newAudioFile ? "Uploading & Analyzing Audio..." : "Creating Project..."}</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-5 h-5" />
                  <span>{newAudioFile ? "Create Project & Analyze Audio" : "Create Project"}</span>
                </>
              )}
            </button>
          </div>
        </form>
      )}

      {/* Main Active Project Workspace */}
      {loading ? (
        <div className="rounded-2xl bg-[#111114] border border-zinc-800/80 h-64 animate-pulse" />
      ) : !activeProject ? (
        <div className="rounded-2xl bg-[#111114] border border-zinc-800/80 p-10 sm:p-14 text-center flex flex-col items-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-400">
            <Film className="w-7 h-7" />
          </div>
          <div className="space-y-1.5 max-w-md">
            <h2 className="text-lg font-semibold text-zinc-100">No music video projects yet</h2>
            <p className="text-sm text-zinc-400">
              Create your first project to upload a song, run GPT-4o AI Director, and generate character-consistent keyframes.
            </p>
          </div>
          {!newProjectOpen && (
            <button
              type="button"
              onClick={() => onToggleNewProject(true)}
              className="min-h-[48px] px-6 py-3 rounded-xl bg-amber-500 hover:bg-amber-400 text-zinc-950 font-semibold text-sm transition-colors"
            >
              Create First Project
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-8">
          {/* Production Workflow Navigator (Strict 01 -> 05 Order) */}
          <nav
            aria-label="Music video production steps"
            className="rounded-2xl bg-[#111114] border border-zinc-800/90 p-2.5 grid grid-cols-2 sm:grid-cols-5 gap-2"
          >
            {[
              {
                id: "step-audio",
                num: "01",
                label: "Audio & Cast",
                done: Boolean(activeProject.audioPath),
              },
              {
                id: "step-storyboard",
                num: "02",
                label: "Storyboard",
                done: activeProject.scenes.length > 0,
              },
              {
                id: "step-keyframes",
                num: "03",
                label: "Keyframes",
                done:
                  activeProject.scenes.length > 0 &&
                  activeProject.scenes.every((s) => Boolean(s.imagePath)),
              },
              {
                id: "step-render",
                num: "04",
                label: "Render Video",
                done: Boolean(activeProject.finalVideoPath),
              },
              {
                id: "step-export",
                num: "05",
                label: "Final MP4",
                done: Boolean(activeProject.finalVideoPath),
              },
            ].map((step) => (
              <button
                key={step.id}
                type="button"
                onClick={() => {
                  const target = document.getElementById(step.id);
                  target?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
                className="min-h-[44px] px-3 py-2 rounded-xl bg-zinc-950 hover:bg-zinc-900 border border-zinc-800/90 text-left flex items-center justify-between gap-2 transition-colors"
              >
                <div className="min-w-0">
                  <span className="block font-mono text-[11px] text-amber-400 tabular-nums">
                    STEP {step.num}
                  </span>
                  <span className="block text-xs font-medium text-zinc-100 truncate">
                    {step.label}
                  </span>
                </div>
                {step.done && <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />}
              </button>
            ))}
          </nav>

          {/* STEP 01: Project Details + Audio Upload & Vocal Separation */}
          <div id="step-audio" className="grid grid-cols-1 xl:grid-cols-12 gap-6 scroll-mt-6">
            {/* Project Details */}
            <section className="xl:col-span-6 rounded-2xl bg-[#111114] border border-zinc-800/90 p-5 sm:p-6 space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-zinc-800/70">
                <div>
                  <h2 className="text-lg font-semibold text-zinc-100">{activeProject.title}</h2>
                  <p className="text-xs text-zinc-400 mt-0.5 tabular-nums">
                    <span className="font-mono">{activeProject.aspectRatio}</span>
                    <span aria-hidden="true"> · </span>
                    <span>
                      {MUSIC_VIDEO_TYPES.find((t) => t.id === normalizeMusicVideoType(activeProject.videoType))
                        ?.shortLabel || "Narrative"}
                    </span>
                    <span aria-hidden="true"> · </span>
                    <span>{activeProject.scenes.length} {activeProject.scenes.length === 1 ? "scene" : "scenes"}</span>
                    <span aria-hidden="true"> · </span>
                    <span className="capitalize">{activeProject.status}</span>
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={savingMeta}
                    onClick={handleSaveProjectMeta}
                    className="min-h-[44px] px-4 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-700/80 text-sm font-medium text-zinc-100 transition-colors flex items-center gap-2"
                  >
                    {savingMeta ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                    <span>Save Details</span>
                  </button>

                  {confirmDeleteProj ? (
                    <button
                      type="button"
                      onClick={handleDeleteProject}
                      className="min-h-[44px] px-3.5 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-sm font-semibold transition-colors"
                    >
                      Confirm Delete
                    </button>
                  ) : (
                    <button
                      type="button"
                      aria-label="Delete project"
                      onClick={() => setConfirmDeleteProj(true)}
                      className="min-h-[44px] min-w-[44px] rounded-xl bg-zinc-950 hover:bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-red-400 transition-colors flex items-center justify-center"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-zinc-400">Title</label>
                  <input
                    type="text"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-sm text-zinc-100 focus:outline-none focus:border-amber-500"
                  />
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-zinc-300">Cast Lineup (Up to 4 Artists)</label>
                      <p className="text-[11px] text-zinc-500 mt-1">Choose Artist Locker portraits, assign roles, and lock each video's look.</p>
                    </div>
                    <span className="text-xs font-mono text-amber-400">{castDraft.length}/4</span>
                  </div>
                  <select
                    value={castPickerId}
                    disabled={castDraft.length >= 4}
                    onChange={(e) => {
                      const id = e.target.value;
                      setCastPickerId("");
                      if (id && !castDraft.some((entry) => entry.artistId === id) && castDraft.length < 4) {
                        setCastDraft((prev) => [...prev, { artistId: id, role: prev.length ? "Featured Artist" : "Lead Vocalist", appearanceNotes: "" }]);
                      }
                    }}
                    className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-sm text-zinc-100 focus:outline-none focus:border-amber-500"
                  >
                    <option value="">+ Add artist from Artist Locker</option>
                    {characters.filter((artist) => !castDraft.some((entry) => entry.artistId === artist.id)).map((artist) => (
                      <option key={artist.id} value={artist.id}>{artist.name}</option>
                    ))}
                  </select>
                  {castDraft.length > 0 && (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      {castDraft.map((entry, index) => {
                        const artist = characters.find((item) => item.id === entry.artistId);
                        if (!artist) return null;
                        const standardRole = CAST_ROLES.includes(entry.role);
                        return (
                          <div key={entry.artistId} className="min-w-0 rounded-xl border border-zinc-800 bg-zinc-950/70 p-2.5 space-y-2">
                            <div className="aspect-[3/4] rounded-lg overflow-hidden bg-zinc-900">
                              <img src={artist.refImagePath} alt={artist.name} className="w-full h-full object-cover" />
                            </div>
                            <p className="text-xs font-semibold text-zinc-100 truncate">{artist.name}</p>
                            <select
                              value={standardRole ? entry.role : "Custom role"}
                              onChange={(e) => setCastDraft((prev) => prev.map((item) => item.artistId === entry.artistId ? { ...item, role: e.target.value === "Custom role" ? "" : e.target.value } : item))}
                              className="w-full min-h-[38px] rounded-lg bg-zinc-900 border border-zinc-700 px-2 text-[11px] text-zinc-100"
                            >
                              {CAST_ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
                              <option value="Custom role">Custom role…</option>
                            </select>
                            {!standardRole && (
                              <input value={entry.role} onChange={(e) => setCastDraft((prev) => prev.map((item) => item.artistId === entry.artistId ? { ...item, role: e.target.value } : item))} placeholder="Enter custom role" className="w-full min-h-[36px] rounded-lg bg-zinc-900 border border-zinc-700 px-2 text-[11px] text-zinc-100" />
                            )}
                            <textarea
                              value={entry.appearanceNotes}
                              onChange={(e) => setCastDraft((prev) => prev.map((item) => item.artistId === entry.artistId ? { ...item, appearanceNotes: e.target.value } : item))}
                              rows={2}
                              placeholder="Outfit / look lock for this video"
                              className="w-full rounded-lg bg-zinc-900 border border-zinc-700 p-2 text-[11px] text-zinc-100 resize-y"
                            />
                            <button type="button" onClick={() => setCastDraft((prev) => prev.filter((item) => item.artistId !== entry.artistId))} className="w-full min-h-[34px] rounded-lg border border-zinc-700 text-[11px] text-zinc-400 hover:text-red-300">Remove</button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-12 gap-4 items-end">
                <div className="sm:col-span-5 space-y-1.5">
                  <label className="block text-xs font-medium text-zinc-400">Visual Concept</label>
                  <input
                    type="text"
                    value={concept}
                    onChange={(e) => setConcept(e.target.value)}
                    placeholder="Visual tone, location, color palette..."
                    className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-sm text-zinc-100 focus:outline-none focus:border-amber-500"
                  />
                </div>

                <div className="sm:col-span-4 space-y-1.5">
                  <label className="block text-xs font-medium text-zinc-400">Music Video Type</label>
                  <select
                    value={videoType}
                    onChange={(e) => setVideoType(normalizeMusicVideoType(e.target.value))}
                    className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-sm text-zinc-100 focus:outline-none focus:border-amber-500"
                  >
                    {MUSIC_VIDEO_TYPES.map((mvType) => (
                      <option key={mvType.id} value={mvType.id}>
                        {mvType.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="sm:col-span-3 space-y-1.5">
                  <span className="block text-xs font-medium text-zinc-400">Frame Ratio</span>
                  <div className="grid grid-cols-2 gap-2">
                    {(["16:9", "9:16"] as const).map((ratio) => (
                      <button
                        key={ratio}
                        type="button"
                        onClick={() => setAspectRatio(ratio)}
                        className={`min-h-[44px] rounded-xl border text-xs font-mono font-medium transition-colors ${
                          aspectRatio === ratio
                            ? "bg-amber-500 text-zinc-950 border-amber-500 font-semibold"
                            : "bg-zinc-950 text-zinc-300 border-zinc-800 hover:border-zinc-700"
                        }`}
                      >
                        {ratio}
                      </button>
                    ))}
                  </div>
                </div>
              </div>


            </section>

            {/* Audio Upload & Whisper + Demucs Analysis Deck */}
            <section className="xl:col-span-6 rounded-2xl bg-[#111114] border border-zinc-800/90 p-5 sm:p-6 flex flex-col justify-between gap-5">
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-semibold text-zinc-100 flex items-center gap-2">
                    <Music className="w-5 h-5 text-amber-400" />
                    <span>Audio &amp; Vocal Separation</span>
                  </h2>
                  <span className="font-mono text-xs text-zinc-400 tabular-nums">
                    Playhead {formatTimecode(playheadSec)}
                  </span>
                </div>

                <input
                  ref={analyzeAudioInputRef}
                  type="file"
                  accept=".mp3,.wav,audio/mpeg,audio/wav,audio/*"
                  className="hidden"
                  onChange={(e) => handleAnalyzeAudioForActive(e.target.files?.[0] || null)}
                />

                <button
                  type="button"
                  disabled={analyzingAudio}
                  onClick={() => analyzeAudioInputRef.current?.click()}
                  className="w-full min-h-[48px] px-4 py-2.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 disabled:opacity-60 border border-zinc-700/80 text-sm font-semibold text-zinc-100 transition-colors flex items-center justify-center gap-2"
                >
                  {analyzingAudio ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin text-amber-400" />
                      <span>Running Whisper &amp; Demucs...</span>
                    </>
                  ) : (
                    <>
                      <Upload className="w-4 h-4 text-amber-400" />
                      <span>
                        {activeProject.audioPath
                          ? "Upload New Song (.mp3 / .wav) & Re-Analyze"
                          : "Upload Song (.mp3 / .wav) & Analyze"}
                      </span>
                    </>
                  )}
                </button>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="rounded-xl bg-zinc-950 border border-zinc-800/90 p-3.5 space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-zinc-200 flex items-center gap-1.5">
                        <FileAudio className="w-3.5 h-3.5 text-amber-400" />
                        <span>Master Song</span>
                      </span>
                      <span className="font-mono text-zinc-500">song.mp3</span>
                    </div>
                    {activeProject.audioPath ? (
                      <audio
                        ref={audioRef}
                        controls
                        src={activeProject.audioPath}
                        onLoadedMetadata={(e) => {
                          const dur = e.currentTarget.duration;
                          if (Number.isFinite(dur) && dur > 0) {
                            setSongDurationSec(Number(dur.toFixed(1)));
                          }
                        }}
                        onTimeUpdate={(e) => setPlayheadSec(Number(e.currentTarget.currentTime.toFixed(1)))}
                        className="w-full h-10"
                      />
                    ) : (
                      <p className="text-xs text-zinc-500 py-2">No master song uploaded yet.</p>
                    )}
                  </div>

                  <div className="rounded-xl bg-zinc-950 border border-zinc-800/90 p-3.5 space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-zinc-200 flex items-center gap-1.5">
                        <Mic className="w-3.5 h-3.5 text-amber-400" />
                        <span>Demucs Isolated Vocals</span>
                      </span>
                      <span className="font-mono text-zinc-500">vocals.wav</span>
                    </div>
                    {activeProject.vocalStemPath ? (
                      <audio controls src={activeProject.vocalStemPath} className="w-full h-10" />
                    ) : (
                      <p className="text-xs text-zinc-500 py-2">
                        Generated automatically via Demucs on Modal.
                      </p>
                    )}
                  </div>
                </div>
              </div>

              <div className="pt-3 border-t border-zinc-800/70 flex items-center justify-between text-xs text-zinc-400">
                <span>
                  {activeProject.audioPath && activeProject.vocalStemPath
                    ? "Step 01 complete · Audio & isolated vocals ready for Step 02"
                    : "Upload .mp3 or .wav above to run Whisper & Demucs"}
                </span>
                <span className="font-mono text-amber-400">STEP 01</span>
              </div>
            </section>
          </div>

          {/* STEP 02: Timestamped Lyrics & AI Director Storyboard */}
          <div id="step-storyboard" className="space-y-6 scroll-mt-6">
            {timestampSegments.length > 0 && (
              <section className="rounded-2xl bg-[#111114] border border-zinc-800/90 p-5 sm:p-6 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pb-3 border-b border-zinc-800/70">
                  <div>
                    <h2 className="text-lg font-semibold text-zinc-100">
                      Timestamped Lyrics ({timestampSegments.length} segments)
                    </h2>
                    <p className="text-xs sm:text-sm text-zinc-400">
                      Extracted via Hugging Face Whisper on Modal. Tap any line to jump the audio playhead.
                    </p>
                  </div>

                  <button
                    type="button"
                    disabled={splitting}
                    onClick={() => handleSplitLyrics({ useWhisperTimestamps: true })}
                    className="min-h-[44px] px-4 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 disabled:opacity-60 border border-zinc-700/80 text-zinc-100 text-sm font-medium transition-colors flex items-center justify-center gap-2 whitespace-nowrap self-start sm:self-auto"
                  >
                    {splitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Scissors className="w-4 h-4 text-amber-400" />}
                    <span>Split from Whisper Timestamps</span>
                  </button>
                </div>

                <div className="max-h-64 overflow-y-auto divide-y divide-zinc-800/70 pr-1">
                  {timestampSegments.map((seg, idx) => (
                    <div
                      key={`${seg.orderIndex}-${idx}`}
                      className="w-full min-h-[48px] px-3 py-2 hover:bg-zinc-900/80 transition-colors flex items-center justify-between gap-3 rounded-lg"
                    >
                      <button
                        type="button"
                        onClick={() => handleSeekAudio(seg.startSec)}
                        className="flex-1 min-w-0 text-left flex items-baseline gap-4 py-0.5"
                      >
                        <span className="font-mono text-xs text-amber-400 tabular-nums shrink-0">
                          {formatTimecode(seg.startSec)} – {formatTimecode(seg.endSec)}
                        </span>
                        <span className="text-sm text-zinc-100 leading-snug">{seg.text}</span>
                      </button>

                      {scopeMode === "section" && (
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={() => {
                              const nextStart = Number(seg.startSec.toFixed(1));
                              setSectionStartSec(nextStart);
                              if (sectionEndSec <= nextStart + 2) {
                                const fallbackEnd = Number((nextStart + 30).toFixed(1));
                                setSectionEndSec(
                                  effectiveDurationSec ? Math.min(effectiveDurationSec, fallbackEnd) : fallbackEnd
                                );
                              }
                            }}
                            className={`min-h-[36px] px-2.5 rounded-lg border text-xs font-mono transition-colors ${
                              Math.abs(sectionStartSec - seg.startSec) < 0.2
                                ? "bg-amber-500 text-zinc-950 border-amber-500 font-semibold"
                                : "bg-zinc-950 text-zinc-300 border-zinc-800 hover:border-amber-500"
                            }`}
                          >
                            Start
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              const nextEnd = Number(seg.endSec.toFixed(1));
                              setSectionEndSec(nextEnd);
                              if (nextEnd <= sectionStartSec) {
                                setSectionStartSec(Math.max(0, Number((nextEnd - 15).toFixed(1))));
                              }
                            }}
                            className={`min-h-[36px] px-2.5 rounded-lg border text-xs font-mono transition-colors ${
                              Math.abs(clampedSectionEndSec - seg.endSec) < 0.2
                                ? "bg-amber-500 text-zinc-950 border-amber-500 font-semibold"
                                : "bg-zinc-950 text-zinc-300 border-zinc-800 hover:border-amber-500"
                            }`}
                          >
                            End
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* AI Director & Suno Lyrics Panel */}
            <section className="rounded-2xl bg-[#111114] border border-zinc-800/90 p-5 sm:p-6 space-y-5">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div>
                  <span className="font-mono text-xs text-amber-400">STEP 02</span>
                  <h2 className="text-lg font-semibold text-zinc-100 flex items-center gap-2 mt-0.5">
                    <Clapperboard className="w-5 h-5 text-amber-400" />
                    <span>AI Director &amp; Lyrics</span>
                  </h2>
                  <p className="text-sm text-zinc-400">
                    Choose your music video style and whether to direct the full song or a custom timestamp section.
                  </p>
                </div>

                {!openaiConfigured && (
                  <span className="text-xs text-amber-300/90 shrink-0">
                    Add <span className="font-mono">OPENAI_API_KEY</span> in Secrets for GPT-4o
                  </span>
                )}
              </div>

              {/* Music Video Type Selector */}
              <div className="space-y-2">
                <span className="block text-xs font-medium text-zinc-300">
                  1. Music Video Type
                </span>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2.5">
                  {MUSIC_VIDEO_TYPES.map((mvType) => {
                    const active = videoType === mvType.id;
                    return (
                      <button
                        key={mvType.id}
                        type="button"
                        onClick={() => setVideoType(mvType.id)}
                        className={`min-h-[74px] p-3 rounded-xl border text-left transition-colors flex flex-col justify-between gap-1 ${
                          active
                            ? "bg-amber-500/15 border-amber-500 text-amber-100"
                            : "bg-zinc-950 border-zinc-800 text-zinc-300 hover:border-zinc-700"
                        }`}
                      >
                        <div>
                          <p className="text-sm font-semibold leading-tight">{mvType.shortLabel}</p>
                          <p className="text-[11px] font-mono text-amber-400/90 mt-0.5">{mvType.mixNote}</p>
                        </div>
                        <p className="text-xs text-zinc-400 leading-snug">{mvType.desc}</p>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Song Coverage: Full Song vs Choose Section */}
              <div className="rounded-xl bg-zinc-950 border border-zinc-800/90 p-4 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div>
                    <span className="block text-xs font-medium text-zinc-200">
                      2. Song Coverage
                    </span>
                    <p className="text-xs text-zinc-400 mt-0.5 tabular-nums">
                      {effectiveDurationSec
                        ? `Track length ${formatTimecode(effectiveDurationSec)}`
                        : "Upload audio in Step 01 to auto-detect full track length"}
                    </p>
                  </div>

                  <div className="grid grid-cols-2 gap-2 sm:w-72">
                    {(
                      [
                        { id: "full", label: "Full Song" },
                        { id: "section", label: "Choose Section" },
                      ] as const
                    ).map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setScopeMode(opt.id)}
                        className={`min-h-[44px] px-3 rounded-xl border text-sm font-medium transition-colors ${
                          scopeMode === opt.id
                            ? "bg-amber-500 text-zinc-950 border-amber-500 font-semibold"
                            : "bg-zinc-900 text-zinc-300 border-zinc-800 hover:border-zinc-700"
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {scopeMode === "section" && (
                  <div className="space-y-3 pt-3 border-t border-zinc-800/80">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <label className="block text-xs font-medium text-zinc-400">
                          Section Start (seconds)
                        </label>
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            step="0.5"
                            min={0}
                            max={effectiveDurationSec ? Math.max(0, effectiveDurationSec - 4) : undefined}
                            value={sectionStartSec}
                            onChange={(e) => {
                              const val = Math.max(0, Number(e.target.value) || 0);
                              setSectionStartSec(val);
                              if (sectionEndSec <= val + 4) {
                                setSectionEndSec(Number((val + 15).toFixed(1)));
                              }
                            }}
                            className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-zinc-900 border border-zinc-800 text-sm font-mono text-zinc-100 tabular-nums focus:outline-none focus:border-amber-500"
                          />
                          <button
                            type="button"
                            onClick={() => {
                              const nextStart = Number(playheadSec.toFixed(1));
                              setSectionStartSec(nextStart);
                              if (sectionEndSec <= nextStart + 4) {
                                setSectionEndSec(Number((nextStart + 30).toFixed(1)));
                              }
                            }}
                            className="min-h-[44px] px-3 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-700/80 text-xs font-medium text-zinc-200 whitespace-nowrap"
                          >
                            Use Playhead
                          </button>
                        </div>
                      </div>

                      <div className="space-y-1.5">
                        <label className="block text-xs font-medium text-zinc-400">
                          Section End (seconds)
                        </label>
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            step="0.5"
                            min={sectionStartSec + 4}
                            max={effectiveDurationSec ?? undefined}
                            value={clampedSectionEndSec}
                            onChange={(e) => {
                              const val = Math.max(sectionStartSec + 4, Number(e.target.value) || sectionStartSec + 4);
                              setSectionEndSec(val);
                            }}
                            className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-zinc-900 border border-zinc-800 text-sm font-mono text-zinc-100 tabular-nums focus:outline-none focus:border-amber-500"
                          />
                          <button
                            type="button"
                            onClick={() => {
                              const nextEnd = Math.max(sectionStartSec + 4, Number(playheadSec.toFixed(1)));
                              setSectionEndSec(nextEnd);
                            }}
                            className="min-h-[44px] px-3 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-700/80 text-xs font-medium text-zinc-200 whitespace-nowrap"
                          >
                            Use Playhead
                          </button>
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs text-zinc-400 mr-1">Quick ranges:</span>
                      <button
                        type="button"
                        onClick={() => applySectionWindow(0, 30)}
                        className="min-h-[38px] px-3 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-xs text-zinc-200"
                      >
                        0s–30s Intro
                      </button>
                      <button
                        type="button"
                        onClick={() => applySectionWindow(playheadSec, 15)}
                        className="min-h-[38px] px-3 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-xs text-zinc-200"
                      >
                        15s from Playhead
                      </button>
                      <button
                        type="button"
                        onClick={() => applySectionWindow(playheadSec, 30)}
                        className="min-h-[38px] px-3 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-xs text-zinc-200"
                      >
                        30s from Playhead
                      </button>
                      <button
                        type="button"
                        onClick={() => applySectionWindow(playheadSec, 45)}
                        className="min-h-[38px] px-3 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-xs text-zinc-200"
                      >
                        45s from Playhead
                      </button>
                    </div>

                    <p className="text-xs text-amber-300/90 font-mono tabular-nums">
                      Section {formatTimecode(sectionStartSec)} – {formatTimecode(clampedSectionEndSec)}
                      <span aria-hidden="true"> · </span>
                      {(clampedSectionEndSec - sectionStartSec).toFixed(1)}s
                      <span aria-hidden="true"> · </span>
                      ~{Math.max(1, Math.round((clampedSectionEndSec - sectionStartSec) / 4.5))} shots
                      <span aria-hidden="true"> · </span>
                      Audio syncs at {formatTimecode(sectionStartSec)}
                    </p>
                  </div>
                )}
              </div>

              <textarea
                rows={5}
                value={rawLyrics}
                onChange={(e) => setRawLyrics(e.target.value)}
                placeholder={"Neon rain on the studio glass\nHold the note till the sirens pass\nShadows dancing across the floor\nOne last chorus before the door"}
                className="w-full px-4 py-3 rounded-xl bg-zinc-950 border border-zinc-800 text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-amber-500 text-base leading-relaxed"
              />

              {error && (
                <div role="alert" className="rounded-xl bg-red-950/50 border border-red-800/70 px-4 py-3 text-sm text-red-200">
                  {error}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  disabled={generatingStoryboard || generatingKeyframes}
                  onClick={handleGenerateStoryboard}
                  className="min-h-[50px] px-6 py-3 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-60 text-zinc-950 text-sm sm:text-base font-semibold transition-colors flex items-center gap-2"
                >
                  {generatingStoryboard ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      <span>Generating Storyboard...</span>
                    </>
                  ) : (
                    <>
                      <Wand2 className="w-5 h-5" />
                      <span>
                        {scopeMode === "section"
                          ? "Generate Section Storyboard"
                          : "Generate Full Storyboard"}
                      </span>
                    </>
                  )}
                </button>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setSecPerScene((v) => Math.max(2, v - 1))}
                  aria-label="Decrease manual shot length"
                  className="min-h-[44px] min-w-[44px] rounded-xl bg-zinc-950 border border-zinc-800 text-zinc-200 font-mono text-base"
                >
                  -
                </button>
                <span className="font-mono text-xs text-zinc-300 w-8 text-center tabular-nums">
                  {secPerScene}s
                </span>
                <button
                  type="button"
                  onClick={() => setSecPerScene((v) => Math.min(12, v + 1))}
                  aria-label="Increase manual shot length"
                  className="min-h-[44px] min-w-[44px] rounded-xl bg-zinc-950 border border-zinc-800 text-zinc-200 font-mono text-base"
                >
                  +
                </button>
                <button
                  type="button"
                  disabled={splitting}
                  onClick={() => handleSplitLyrics({})}
                  className="min-h-[44px] px-4 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-700/80 text-xs sm:text-sm font-medium text-zinc-200 transition-colors flex items-center gap-2"
                >
                  {splitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Scissors className="w-4 h-4" />}
                  <span>Manual Split</span>
                </button>
              </div>

              <button
                type="button"
                onClick={handleAddScene}
                className="min-h-[44px] px-4 py-2 rounded-xl bg-zinc-950 hover:bg-zinc-900 border border-zinc-800 text-sm font-medium text-zinc-300 transition-colors flex items-center gap-2 sm:ml-auto"
              >
                <Plus className="w-4 h-4" />
                <span>Add Scene</span>
              </button>
            </div>
          </section>
          </div>

          {/* STEP 03: Storyboard Grid + Generate All Keyframes */}
          <section id="step-keyframes" className="space-y-5 scroll-mt-6">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-zinc-800/80 pb-4">
              <div>
                <span className="font-mono text-xs text-amber-400">STEP 03</span>
                <h2 className="text-xl font-semibold text-zinc-100 mt-0.5">
                  Storyboard Grid &amp; Keyframes ({activeProject.scenes.length} shots)
                </h2>
                <p className="text-xs sm:text-sm text-zinc-400">
                  Generates character-locked frames via FLUX Kontext on Modal, saved to <span className="font-mono text-zinc-300">public/projects/{activeProject.id}/</span>
                </p>
              </div>

              {activeProject.scenes.length > 0 && (
                <button
                  type="button"
                  disabled={generatingKeyframes || generatingStoryboard || renderingVideo}
                  onClick={handleGenerateAllKeyframes}
                  className="min-h-[50px] px-6 py-3 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-60 text-zinc-950 text-sm sm:text-base font-semibold transition-colors flex items-center justify-center gap-2.5 whitespace-nowrap shrink-0"
                >
                  {generatingKeyframes ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      <span>Generating All Keyframes...</span>
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-5 h-5" />
                      <span>Generate All Keyframes</span>
                    </>
                  )}
                </button>
              )}
            </div>

            {activeProject.scenes.length === 0 ? (
              <div className="rounded-2xl bg-[#111114] border border-zinc-800/80 p-10 text-center text-sm text-zinc-400">
                No scenes yet. Tap <span className="text-amber-400 font-medium">Generate Storyboard</span> above to have GPT-4o direct your entire song into continuous 4.0–5.5s shots.
              </div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                {activeProject.scenes.map((scene) => {
                  const draft = sceneDrafts[scene.id] || scene;
                  const busy = sceneBusy[scene.id];
                  const activeShotType = String(draft.shotType ?? scene.shotType ?? "broll");
                  const isLipsync = activeShotType.toLowerCase() === "lipsync";
                  const cacheBust = new Date(scene.updatedAt).getTime();
                  const liveStatus = renderJob?.scenes?.[scene.id];

                  return (
                    <article
                      key={scene.id}
                      className={`rounded-2xl bg-[#111114] border p-5 space-y-4 flex flex-col justify-between ${
                        liveStatus?.state === "rendering"
                          ? "border-amber-500/70"
                          : liveStatus?.state === "done"
                          ? "border-emerald-700/60"
                          : "border-zinc-800/90"
                      }`}
                    >
                      <div className="space-y-4">
                        {/* Card Header: Timestamp + lipsync/broll badge + Save/Delete */}
                        <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-zinc-800/70">
                          <div className="flex items-center gap-2.5 flex-wrap">
                            <span className="text-sm font-semibold text-zinc-100 tabular-nums">
                              Shot {String(scene.orderIndex + 1).padStart(2, "0")}
                            </span>

                            <button
                              type="button"
                              onClick={() => activeProject.audioPath && handleSeekAudio(Number(draft.startSec ?? scene.startSec))}
                              className="font-mono text-xs text-amber-400 hover:underline tabular-nums"
                              title="Jump audio playhead to shot start"
                            >
                              {formatTimecode(Number(draft.startSec ?? scene.startSec))} – {formatTimecode(Number(draft.endSec ?? scene.endSec))}
                            </button>

                            <span
                              className={`px-2 py-0.5 rounded-md text-xs font-mono font-semibold border ${
                                isLipsync
                                  ? "bg-amber-500/15 text-amber-300 border-amber-500/40"
                                  : "bg-zinc-900 text-zinc-300 border-zinc-700"
                              }`}
                            >
                              {activeShotType}
                            </span>
                            {(() => {
                              const assignedIds = readCastIds(String(draft.castArtistIds ?? scene.castArtistIds ?? JSON.stringify(castDraft[0] ? [castDraft[0].artistId] : [])));
                              const assignedNames = assignedIds.map((id) => characters.find((artist) => artist.id === id)?.name).filter(Boolean);
                              return assignedNames.length ? (
                                <span className="px-2 py-0.5 rounded-md bg-amber-500/10 border border-amber-500/30 text-[10px] font-medium text-amber-300 max-w-[180px] truncate" title={assignedNames.join(", ")}>
                                  Cast: {assignedNames.join(" + ")}
                                </span>
                              ) : <span className="text-[10px] text-zinc-500">No cast assigned</span>;
                            })()}
                          </div>

                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => handleSaveScene(scene.id)}
                              disabled={Boolean(busy)}
                              className="min-h-[40px] px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-700/80 text-xs font-medium text-zinc-200 flex items-center gap-1.5"
                            >
                              {busy === "saving" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                              <span>Save</span>
                            </button>
                            <button
                              type="button"
                              aria-label={`Delete shot ${scene.orderIndex + 1}`}
                              onClick={() => handleDeleteScene(scene.id)}
                              disabled={Boolean(busy)}
                              className="min-h-[40px] min-w-[40px] rounded-lg bg-zinc-950 hover:bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-red-400 flex items-center justify-center"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </div>

                        {/* Live Render Status Strip */}
                        {(liveStatus || scene.videoPath) && (
                          <div
                            className={`rounded-lg px-3 py-2 text-xs flex items-center justify-between gap-2 border ${
                              liveStatus?.state === "rendering"
                                ? "bg-amber-950/35 border-amber-600/50 text-amber-200"
                                : liveStatus?.state === "error"
                                ? "bg-red-950/40 border-red-700/60 text-red-200"
                                : liveStatus?.state === "done" || scene.videoPath
                                ? "bg-emerald-950/30 border-emerald-700/50 text-emerald-200"
                                : "bg-zinc-950 border-zinc-800 text-zinc-400"
                            }`}
                          >
                            <span className="truncate font-medium">
                              {liveStatus ? liveStatus.label : "Rendered clip ready"}
                            </span>
                            {liveStatus?.state === "rendering" ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                            ) : liveStatus?.state === "error" ? (
                              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                            ) : liveStatus?.state === "done" || (!liveStatus && scene.videoPath) ? (
                              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                            ) : (
                              <Clock className="w-3.5 h-3.5 shrink-0" />
                            )}
                          </div>
                        )}

                        <div className="space-y-1.5">
                          <label className="text-[11px] font-medium text-zinc-400">Cast assigned to this shot · choose up to 4</label>
                          <select
                            value=""
                            onChange={(e) => {
                              const id = e.target.value;
                              if (!id) return;
                              const currentIds = readCastIds(String(draft.castArtistIds ?? scene.castArtistIds ?? JSON.stringify(castDraft[0] ? [castDraft[0].artistId] : [])));
                              const nextIds = currentIds.includes(id) ? currentIds.filter((item) => item !== id) : [...currentIds, id].slice(0, 4);
                              updateDraft(scene.id, { castArtistIds: JSON.stringify(nextIds) });
                            }}
                            className="w-full min-h-[44px] rounded-xl bg-zinc-950 border border-zinc-800 px-3 py-2 text-xs text-zinc-100"
                          >
                            <option value="">Add / remove artist from this shot…</option>
                            {castDraft.map((entry) => {
                              const artist = characters.find((item) => item.id === entry.artistId);
                              return artist ? <option key={entry.artistId} value={entry.artistId}>{artist.name} · {entry.role}</option> : null;
                            })}
                          </select>
                        </div>

                        {/* Lyric Line */}
                        <div className="rounded-xl bg-zinc-950/80 border border-zinc-800/80 px-3.5 py-2.5">
                          <p className="text-sm font-medium text-zinc-100 leading-snug">
                            {draft.lyricSegment || scene.lyricSegment || "Instrumental beat / visual interlude"}
                          </p>
                        </div>

                        {/* Image Preview */}
                        <div
                          className={`rounded-xl bg-zinc-950 border border-zinc-800 overflow-hidden relative flex items-center justify-center ${
                            activeProject.aspectRatio === "9:16" ? "aspect-[9/16] max-h-[360px] mx-auto" : "aspect-video w-full"
                          }`}
                        >
                          {scene.imagePath ? (
                            <img
                              src={`${scene.imagePath}?v=${cacheBust}`}
                              alt={`Shot ${scene.orderIndex + 1} keyframe`}
                              referrerPolicy="no-referrer"
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <div className="flex flex-col items-center gap-2 text-zinc-500 p-4 text-center">
                              <ImageIcon className="w-8 h-8" />
                              <span className="text-xs">Pending keyframe</span>
                            </div>
                          )}
                        </div>

                        {/* Regenerate Frame + Upload Frame */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                          <button
                            type="button"
                            disabled={Boolean(busy) || generatingKeyframes}
                            onClick={() => handleGenerateSceneFrame(scene.id)}
                            className="min-h-[44px] px-3.5 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-60 text-zinc-950 text-xs sm:text-sm font-semibold transition-colors flex items-center justify-center gap-2"
                          >
                            {busy === "generating" ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <RefreshCw className="w-4 h-4" />
                            )}
                            <span>{busy === "generating" ? "Regenerating..." : "Regenerate Frame"}</span>
                          </button>

                          <label className="min-h-[44px] px-3.5 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-700/80 text-zinc-100 text-xs sm:text-sm font-medium transition-colors flex items-center justify-center gap-2 cursor-pointer">
                            {busy === "uploading" ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <Upload className="w-4 h-4" />
                            )}
                            <span>Upload Frame</span>
                            <input
                              type="file"
                              accept="image/*"
                              className="hidden"
                              onChange={(e) => handleUploadSceneFrame(scene.id, e.target.files?.[0] || null)}
                            />
                          </label>
                        </div>

                        {/* Timing + Shot Type Controls */}
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                          <div className="space-y-1">
                            <div className="flex items-center justify-between">
                              <label className="text-xs text-zinc-400">Start (s)</label>
                              {activeProject.audioPath && (
                                <button
                                  type="button"
                                  onClick={() => updateDraft(scene.id, { startSec: playheadSec })}
                                  className="text-[11px] font-mono text-amber-400 hover:underline flex items-center gap-1"
                                >
                                  <Clock className="w-3 h-3" />
                                  <span>Playhead</span>
                                </button>
                              )}
                            </div>
                            <input
                              type="number"
                              step="0.1"
                              min="0"
                              value={draft.startSec ?? scene.startSec}
                              onChange={(e) => updateDraft(scene.id, { startSec: Number(e.target.value) })}
                              className="w-full min-h-[44px] px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 font-mono text-sm text-zinc-100 focus:outline-none focus:border-amber-500"
                            />
                          </div>

                          <div className="space-y-1">
                            <div className="flex items-center justify-between">
                              <label className="text-xs text-zinc-400">End (s)</label>
                              {activeProject.audioPath && (
                                <button
                                  type="button"
                                  onClick={() => updateDraft(scene.id, { endSec: playheadSec })}
                                  className="text-[11px] font-mono text-amber-400 hover:underline flex items-center gap-1"
                                >
                                  <Clock className="w-3 h-3" />
                                  <span>Playhead</span>
                                </button>
                              )}
                            </div>
                            <input
                              type="number"
                              step="0.1"
                              min="0.5"
                              value={draft.endSec ?? scene.endSec}
                              onChange={(e) => updateDraft(scene.id, { endSec: Number(e.target.value) })}
                              className="w-full min-h-[44px] px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 font-mono text-sm text-zinc-100 focus:outline-none focus:border-amber-500"
                            />
                          </div>

                          <div className="space-y-1">
                            <label className="block text-xs text-zinc-400">Shot Type</label>
                            <select
                              value={activeShotType}
                              onChange={(e) => updateDraft(scene.id, { shotType: e.target.value })}
                              className="w-full min-h-[44px] px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-sm text-zinc-100 focus:outline-none focus:border-amber-500"
                            >
                              {SHOT_TYPES.map((st) => (
                                <option key={st} value={st}>
                                  {st}
                                </option>
                              ))}
                            </select>
                          </div>
                        </div>

                        {/* Editable Image Prompt & Motion Prompt */}
                        <div className="space-y-1">
                          <label className="block text-xs text-zinc-400">
                            Image Prompt (Subject, Outfit, Lighting, 35mm Look — No Camera Movement)
                          </label>
                          <textarea
                            rows={3}
                            value={draft.imagePrompt ?? scene.imagePrompt}
                            onChange={(e) => updateDraft(scene.id, { imagePrompt: e.target.value })}
                            className="w-full px-3.5 py-2.5 rounded-xl bg-zinc-950 border border-zinc-800 text-sm text-zinc-200 focus:outline-none focus:border-amber-500 leading-relaxed"
                          />
                        </div>

                        <div className="space-y-1">
                          <label className="block text-xs text-zinc-400">
                            Motion Prompt (Pure Camera &amp; Subject Motion)
                          </label>
                          <textarea
                            rows={2}
                            value={draft.motionPrompt ?? scene.motionPrompt}
                            onChange={(e) => updateDraft(scene.id, { motionPrompt: e.target.value })}
                            className="w-full px-3.5 py-2.5 rounded-xl bg-zinc-950 border border-zinc-800 text-sm text-zinc-300 focus:outline-none focus:border-amber-500 leading-relaxed"
                          />
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>

          {/* STEP 04: Render Final Music Video */}
          <section
            id="step-render"
            className="rounded-2xl bg-[#111114] border border-zinc-800/90 p-5 sm:p-6 space-y-5 scroll-mt-6"
          >
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pb-4 border-b border-zinc-800/70">
              <div>
                <span className="font-mono text-xs text-amber-400">STEP 04</span>
                <h2 className="text-lg sm:text-xl font-semibold text-zinc-100 flex items-center gap-2 mt-0.5">
                  <Video className="w-5 h-5 text-amber-400" />
                  <span>Render Final Music Video</span>
                </h2>
                <p className="text-xs sm:text-sm text-zinc-400 mt-0.5 tabular-nums">
                  {activeProject.scenes.filter((s) => Boolean(s.imagePath)).length} / {activeProject.scenes.length} keyframes ready
                  <span aria-hidden="true"> · </span>
                  {activeProject.scenes.filter((s) => s.shotType === "lipsync").length} lipsync (sync-lipsync)
                  <span aria-hidden="true"> · </span>
                  {activeProject.scenes.filter((s) => s.shotType !== "lipsync").length} b-roll
                  {activeProject.scenes.length > 0 && (
                    <>
                      <span aria-hidden="true"> · </span>
                      <span className="font-mono text-amber-300/90">
                        {formatTimecode(activeProject.scenes[0].startSec)} –{" "}
                        {formatTimecode(activeProject.scenes[activeProject.scenes.length - 1].endSec)}
                      </span>
                    </>
                  )}
                </p>
              </div>
              <span className="text-xs text-zinc-400 font-mono shrink-0">8 parallel workers · 250ms stagger</span>
            </div>

            <div className="space-y-2">
              <span className="block text-xs font-medium text-zinc-300">
                Choose B-Roll Video Engine
              </span>
              <div className="grid grid-cols-1 gap-2.5">
                {(
                  [
                    {
                      id: "turbo",
                      title: "LTX-2.5 on Modal",
                      meta: "Image-to-video · serverless GPU",
                    },
                  ] as const
                ).map((preset) => {
                  const active = renderQualityMode === preset.id;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      disabled={renderingVideo}
                      onClick={() => setRenderQualityMode(preset.id)}
                      className={`min-h-[52px] px-4 py-2.5 rounded-xl border text-left transition-colors ${
                        active
                          ? "bg-amber-500/15 border-amber-500 text-amber-100"
                          : "bg-zinc-950 border-zinc-800 text-zinc-300 hover:border-zinc-700"
                      }`}
                    >
                      <p className="text-sm font-semibold">{preset.title}</p>
                      <p className="text-xs font-mono text-zinc-400 mt-0.5">
                        {preset.meta}
                      </p>
                    </button>
                  );
                })}
              </div>
            </div>

            <button
              type="button"
              disabled={renderingVideo || generatingStoryboard || generatingKeyframes}
              onClick={handleRenderVideo}
              className="w-full min-h-[54px] px-6 py-3.5 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-60 text-zinc-950 font-semibold text-base transition-colors flex items-center justify-center gap-2.5"
            >
              {renderingVideo ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span>
                    Rendering Final Music Video ({renderJob?.completedScenes ?? 0}/{renderJob?.totalScenes ?? activeProject.scenes.length})...
                  </span>
                </>
              ) : (
                <>
                  <Video className="w-5 h-5" />
                  <span>Render Final Music Video</span>
                </>
              )}
            </button>

            {/* Live Per-Scene Render Progress Panel */}
            {renderJob && (renderJob.status === "running" || renderingVideo) && (
              <div
                role="status"
                aria-live="polite"
                className="rounded-xl bg-zinc-950 border border-amber-500/50 p-4 sm:p-5 space-y-4"
              >
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                  <div className="flex items-center gap-3">
                    <Loader2 className="w-5 h-5 text-amber-400 animate-spin shrink-0" />
                    <div>
                      <p className="text-sm font-semibold text-zinc-100">
                        Live Render Progress
                      </p>
                      <p className="text-xs sm:text-sm text-amber-200/90">
                        {renderJob.currentStep}
                      </p>
                    </div>
                  </div>
                  <span className="font-mono text-sm text-amber-400 tabular-nums shrink-0">
                    {renderJob.completedScenes} / {renderJob.totalScenes} scenes
                  </span>
                </div>

                <div className="w-full h-2.5 rounded-md bg-zinc-900 border border-zinc-800 overflow-hidden">
                  <div
                    className="h-full bg-amber-500 transition-all duration-300"
                    style={{
                      width: `${
                        renderJob.totalScenes > 0
                          ? Math.max(
                              4,
                              Math.round((renderJob.completedScenes / renderJob.totalScenes) * 100)
                            )
                          : 4
                      }%`,
                    }}
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5 max-h-56 overflow-y-auto pr-1">
                  {Object.entries(renderJob.scenes)
                    .sort((a, b) => a[1].orderIndex - b[1].orderIndex)
                    .map(([sceneId, st]) => (
                      <div
                        key={sceneId}
                        className={`rounded-xl border px-3 py-2.5 flex items-center justify-between gap-2 text-xs ${
                          st.state === "rendering"
                            ? "bg-amber-950/30 border-amber-500/60 text-amber-100"
                            : st.state === "done"
                            ? "bg-emerald-950/25 border-emerald-700/50 text-emerald-200"
                            : st.state === "error"
                            ? "bg-red-950/35 border-red-700/60 text-red-200"
                            : "bg-zinc-900/70 border-zinc-800 text-zinc-400"
                        }`}
                      >
                        <div className="min-w-0">
                          <p className="font-semibold tabular-nums">
                            Shot {String(st.orderIndex + 1).padStart(2, "0")} · {st.shotType}
                          </p>
                          <p className="truncate opacity-85">{st.label}</p>
                        </div>
                        {st.state === "rendering" ? (
                          <Loader2 className="w-4 h-4 animate-spin text-amber-400 shrink-0" />
                        ) : st.state === "done" ? (
                          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                        ) : st.state === "error" ? (
                          <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
                        ) : (
                          <Clock className="w-4 h-4 text-zinc-600 shrink-0" />
                        )}
                      </div>
                    ))}
                </div>
              </div>
            )}
          </section>

          {/* STEP 05: Final Music Video Player & Download */}
          <section id="step-export" className="scroll-mt-6">
            {activeProject.finalVideoPath ? (
              <div className="rounded-2xl bg-[#111114] border border-zinc-800/90 p-5 sm:p-6 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <span className="font-mono text-xs text-amber-400">STEP 05</span>
                    <h2 className="text-lg sm:text-xl font-semibold text-zinc-100 mt-0.5">
                      Final Music Video
                    </h2>
                    <p className="text-xs text-zinc-400 mt-0.5 font-mono tabular-nums">
                      {activeProject.aspectRatio === "9:16" ? "1080×1920" : "1920×1080"} · 24fps · H.264 AAC MP4
                    </p>
                  </div>
                  <a
                    href={activeProject.finalVideoPath}
                    download={`${activeProject.title.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "music-video"}.mp4`}
                    className="min-h-[48px] px-5 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-zinc-950 text-sm sm:text-base font-semibold transition-colors flex items-center gap-2"
                  >
                    <Download className="w-4 h-4" />
                    <span>Download MP4</span>
                  </a>
                </div>

                <div className="rounded-xl overflow-hidden bg-black border border-zinc-800 flex justify-center">
                  <video
                    controls
                    playsInline
                    preload="metadata"
                    src={`${activeProject.finalVideoPath}?v=${new Date(activeProject.updatedAt).getTime()}`}
                    className="w-full max-h-[540px] object-contain"
                  />
                </div>
              </div>
            ) : (
              <div className="rounded-2xl bg-[#111114]/60 border border-dashed border-zinc-800 p-6 text-center text-xs sm:text-sm text-zinc-500">
                <span className="font-mono text-zinc-400">STEP 05</span> · Your final rendered MP4 player and iPad Photos download button will appear here once Step 04 finishes.
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
};
